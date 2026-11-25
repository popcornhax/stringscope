// Monocular depth estimation (Depth Anything V2, small) for turning ordinary photos
// into depth. transformers.js and the model weights are fetched on first use only
// and cached by the browser afterwards; the rest of the app stays fully offline.

const TRANSFORMERS_URL = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.2/dist/transformers.min.js';
const MODEL_ID = 'onnx-community/depth-anything-v2-small';
const MAX_INPUT_SIDE = 640;

let estimatorPromise = null;

async function createEstimator(onProgress) {
  const { pipeline } = await import(TRANSFORMERS_URL);
  const files = new Map();
  const progress_callback = (e) => {
    if (e.status !== 'progress' || !e.total) return;
    files.set(e.file, [e.loaded, e.total]);
    let loaded = 0;
    let total = 0;
    for (const [l, t] of files.values()) {
      loaded += l;
      total += t;
    }
    onProgress?.(loaded / total, total);
  };
  if (navigator.gpu) {
    try {
      return await pipeline('depth-estimation', MODEL_ID, { device: 'webgpu', dtype: 'fp16', progress_callback });
    } catch (err) {
      console.warn('WebGPU depth estimation unavailable, falling back to WASM', err);
    }
  }
  return pipeline('depth-estimation', MODEL_ID, { device: 'wasm', dtype: 'q8', progress_callback });
}

function getEstimator(onProgress) {
  estimatorPromise ??= createEstimator(onProgress).catch((err) => {
    estimatorPromise = null; // allow a retry, e.g. after going back online
    throw err;
  });
  return estimatorPromise;
}

/**
 * Estimate relative depth for an image.
 * @param {ImageBitmap} bitmap
 * @param {(fraction:number,totalBytes:number)=>void} [onProgress] model download progress
 * @returns {Promise<{w:number,h:number,data:Float32Array}>} depth in [0,1], 1 = near
 */
export async function estimateDepth(bitmap, onProgress) {
  const estimator = await getEstimator(onProgress);
  const k = Math.min(1, MAX_INPUT_SIDE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * k));
  canvas.height = Math.max(1, Math.round(bitmap.height * k));
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const { RawImage } = await import(TRANSFORMERS_URL);
  const { depth } = await estimator(RawImage.fromCanvas(canvas));
  const data = new Float32Array(depth.width * depth.height);
  const step = depth.channels || 1;
  for (let i = 0; i < data.length; i++) data[i] = depth.data[i * step] / 255;
  return { w: depth.width, h: depth.height, data };
}
