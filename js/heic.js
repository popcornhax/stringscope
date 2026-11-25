// HEIC/HEIF decoding via libheif (WebAssembly), including the depth map and
// portrait matte that iPhones embed in Portrait-mode photos. Browsers can't
// decode HEIC (Chrome/Firefox) or expose its auxiliary images (any browser), so
// libheif is fetched on first use only and cached by the browser afterwards.

export const LIBHEIF_URL = 'https://cdn.jsdelivr.net/npm/libheif-js@1.23.5/libheif-wasm/libheif-bundle.mjs';

// libheif enum values (libheif/heif.h)
const COLORSPACE_RGB = 1;
const COLORSPACE_MONOCHROME = 2;
const CHROMA_MONOCHROME = 0;
const CHROMA_INTERLEAVED_RGBA = 11;
const CHANNEL_Y = 0;
const CHANNEL_INTERLEAVED = 10;
const DEPTH_UNIFORM_Z = 2; // heif_depth_representation_type: larger = farther
const PORTRAIT_MATTE = 'urn:com:apple:photo:2018:aux:portraiteffectsmatte';

let modulePromise = null;

function loadLibheif(url) {
  modulePromise ??= import(url)
    .then((m) => m.default())
    .catch((err) => {
      modulePromise = null; // allow a retry, e.g. after going back online
      throw err;
    });
  return modulePromise;
}

export function isHeicFile(file) {
  return /\.(heic|heif)$/i.test(file.name) || /image\/hei[cf]/i.test(file.type || '');
}

/**
 * Decode a HEIC file.
 * @param {ArrayBuffer|Uint8Array} input file bytes
 * @param {string} [url] libheif ES module URL (overridable for tests)
 * @returns {Promise<{
 *   photo: {w:number, h:number, rgba:Uint8ClampedArray},
 *   depth: {w:number, h:number, data:Float32Array} | null,  // 1 = near
 *   matte: {w:number, h:number, data:Float32Array} | null,  // 1 = subject
 * }>}
 */
export async function decodeHeic(input, url = LIBHEIF_URL) {
  const M = await loadLibheif(url);
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const err = M._malloc(16);
  const out = M._malloc(16);
  const fileBuf = M._malloc(bytes.length);
  const ctx = M._heif_context_alloc();
  const handles = [];

  // Functions returning a struct heif_error write it through a hidden first pointer.
  const cstr = (p) => {
    let s = '';
    for (let b; (b = M.HEAPU8[p++]); ) s += String.fromCharCode(b);
    return s;
  };
  const check = (what) => {
    const code = M.HEAP32[err >> 2];
    if (code) throw new Error(`HEIC ${what} failed: ${cstr(M.HEAP32[(err >> 2) + 2])}`);
  };
  const handleOut = () => {
    const h = M.HEAP32[out >> 2];
    handles.push(h);
    return h;
  };

  // Decode one image handle into a plane copy. Rotation/mirroring properties are applied by libheif.
  const decode = (handle, colorspace, chroma, channel, bytesPerPixel) => {
    M._heif_decode_image(err, handle, out, colorspace, chroma, 0);
    check('decode');
    const img = M.HEAP32[out >> 2];
    try {
      const w = M._heif_image_get_width(img, channel);
      const h = M._heif_image_get_height(img, channel);
      const bpp = M._heif_image_get_bits_per_pixel_range(img, channel);
      const plane = M._heif_image_get_plane_readonly(img, channel, out);
      const stride = M.HEAP32[out >> 2];
      const rowBytes = w * bytesPerPixel * (bpp > 8 ? 2 : 1);
      const copy = new Uint8Array(rowBytes * h);
      for (let y = 0; y < h; y++) copy.set(M.HEAPU8.subarray(plane + y * stride, plane + y * stride + rowBytes), y * rowBytes);
      return { w, h, bpp, bytes: copy };
    } finally {
      M._heif_image_release(img);
    }
  };

  const toUnit = ({ w, h, bpp, bytes }) => {
    const data = new Float32Array(w * h);
    if (bpp > 8) {
      const max = (1 << bpp) - 1;
      const view = new DataView(bytes.buffer);
      for (let i = 0; i < data.length; i++) data[i] = view.getUint16(i * 2, true) / max;
    } else {
      for (let i = 0; i < data.length; i++) data[i] = bytes[i] / 255;
    }
    return { w, h, data };
  };

  try {
    M.HEAPU8.set(bytes, fileBuf);
    M._heif_context_read_from_memory(err, ctx, fileBuf, bytes.length, 0);
    check('read');
    M._heif_context_get_primary_image_handle(err, ctx, out);
    check('primary image');
    const primary = handleOut();

    const rgba = decode(primary, COLORSPACE_RGB, CHROMA_INTERLEAVED_RGBA, CHANNEL_INTERLEAVED, 4);
    const photo = { w: rgba.w, h: rgba.h, rgba: new Uint8ClampedArray(rgba.bytes.buffer) };

    let depth = null;
    if (M._heif_image_handle_has_depth_image(primary)) {
      M._heif_image_handle_get_list_of_depth_image_IDs(primary, out, 1);
      const depthId = M.HEAP32[out >> 2];
      M._heif_image_handle_get_depth_image_handle(err, primary, depthId, out);
      check('depth image');
      const dh = handleOut();
      depth = toUnit(decode(dh, COLORSPACE_MONOCHROME, CHROMA_MONOCHROME, CHANNEL_Y, 1));
      // iPhones store disparity (larger = nearer). Plain Z depth is the other way round.
      if (M._heif_image_handle_get_depth_image_representation_info(primary, depthId, out)) {
        const info = M.HEAP32[out >> 2];
        if (M.HEAP32[(info + 40) >> 2] === DEPTH_UNIFORM_Z) for (let i = 0; i < depth.data.length; i++) depth.data[i] = 1 - depth.data[i];
        M._heif_depth_representation_info_free(info);
      }
    }

    let matte = null;
    const count = M._heif_image_handle_get_number_of_auxiliary_images(primary, 0);
    if (count > 0) {
      const ids = M._malloc(4 * count);
      try {
        M._heif_image_handle_get_list_of_auxiliary_image_IDs(primary, 0, ids, count);
        for (let i = 0; i < count && !matte; i++) {
          M._heif_image_handle_get_auxiliary_image_handle(err, primary, M.HEAP32[(ids >> 2) + i], out);
          if (M.HEAP32[err >> 2]) continue;
          const ah = handleOut();
          M._heif_image_handle_get_auxiliary_type(err, ah, out);
          if (M.HEAP32[err >> 2]) continue;
          const type = cstr(M.HEAP32[out >> 2]);
          M._heif_image_handle_release_auxiliary_type(ah, out);
          if (type === PORTRAIT_MATTE) matte = toUnit(decode(ah, COLORSPACE_MONOCHROME, CHROMA_MONOCHROME, CHANNEL_Y, 1));
        }
      } finally {
        M._free(ids);
      }
    }
    return { photo, depth, matte };
  } finally {
    for (const h of handles) M._heif_image_handle_release(h);
    M._heif_context_free(ctx);
    M._free(fileBuf);
    M._free(err);
    M._free(out);
  }
}
