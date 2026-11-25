// Built-in models and file import (STL / OBJ / PLY). Every model is normalized
// to fit a unit sphere at the origin so the depth range stays predictable.

import * as THREE from 'three';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { PLYLoader } from 'three/addons/loaders/PLYLoader.js';
import { FontLoader } from 'three/addons/loaders/FontLoader.js';
import { TextGeometry } from 'three/addons/geometries/TextGeometry.js';
import { TeapotGeometry } from 'three/addons/geometries/TeapotGeometry.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { smoothDepth } from './stereo.js';
import { decodeHeic, isHeicFile } from './heic.js';

const material = () => new THREE.MeshNormalMaterial({ side: THREE.DoubleSide });

function mesh(geometry) {
  return new THREE.Mesh(geometry, material());
}

function heartGeometry() {
  const s = new THREE.Shape();
  s.moveTo(0, -1.0);
  s.bezierCurveTo(-0.15, -0.8, -1.2, -0.25, -1.2, 0.35);
  s.bezierCurveTo(-1.2, 0.95, -0.45, 1.15, 0, 0.55);
  s.bezierCurveTo(0.45, 1.15, 1.2, 0.95, 1.2, 0.35);
  s.bezierCurveTo(1.2, -0.25, 0.15, -0.8, 0, -1.0);
  const g = new THREE.ExtrudeGeometry(s, {
    depth: 0.35,
    bevelEnabled: true,
    bevelThickness: 0.3,
    bevelSize: 0.22,
    bevelSegments: 10,
    curveSegments: 48,
  });
  g.center();
  return g;
}

function helixGroup() {
  const group = new THREE.Group();
  const pts = (phase) => {
    const out = [];
    for (let i = 0; i <= 200; i++) {
      const t = i / 200;
      const a = t * Math.PI * 5 + phase;
      out.push(new THREE.Vector3(Math.cos(a) * 0.55, t * 2.6 - 1.3, Math.sin(a) * 0.55));
    }
    return new THREE.CatmullRomCurve3(out);
  };
  const c1 = pts(0);
  const c2 = pts(Math.PI);
  group.add(mesh(new THREE.TubeGeometry(c1, 300, 0.12, 16)));
  group.add(mesh(new THREE.TubeGeometry(c2, 300, 0.12, 16)));
  for (let i = 1; i < 20; i++) {
    const t = i / 20;
    const a = c1.getPointAt(t);
    const b = c2.getPointAt(t);
    const rung = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, a.distanceTo(b), 10), material());
    rung.position.copy(a).add(b).multiplyScalar(0.5);
    rung.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
    group.add(rung);
  }
  return group;
}

function orbitTrio() {
  const group = new THREE.Group();
  const core = mesh(new THREE.SphereGeometry(0.45, 48, 32));
  group.add(core);
  const moons = [0, 1, 2].map((k) => {
    const m = mesh(new THREE.SphereGeometry(0.22, 32, 24));
    group.add(m);
    return { m, phase: (k * Math.PI * 2) / 3, tilt: 0.35 * (k - 1) };
  });
  // Keep a bounding marker so normalization accounts for the orbit radius.
  group.userData.radius = 1.25;
  group.userData.update = (t) => {
    for (const { m, phase, tilt } of moons) {
      const a = t * 1.4 + phase;
      m.position.set(Math.cos(a) * 1.0, Math.sin(a) * tilt, Math.sin(a) * 1.0);
    }
  };
  group.userData.update(0);
  return group;
}

function rippleSurface() {
  const geo = new THREE.PlaneGeometry(2.4, 1.6, 120, 80);
  const base = geo.attributes.position.array.slice();
  const m = mesh(geo);
  const group = new THREE.Group();
  group.add(m);
  group.userData.radius = 1.45;
  group.userData.update = (t) => {
    const pos = geo.attributes.position.array;
    for (let i = 0; i < pos.length; i += 3) {
      const x = base[i];
      const y = base[i + 1];
      const r = Math.hypot(x, y);
      pos[i + 2] = 0.28 * Math.cos(r * 6 - t * 2.4) * Math.exp(-r * 0.6) + 0.08 * Math.sin(x * 3 + t);
    }
    geo.attributes.position.needsUpdate = true;
  };
  group.userData.update(0);
  return group;
}

function saturn() {
  const group = new THREE.Group();
  group.add(mesh(new THREE.SphereGeometry(0.6, 64, 48)));
  const ring = mesh(new THREE.TorusGeometry(1.0, 0.12, 16, 128));
  ring.scale.set(1, 1, 0.25);
  ring.rotation.x = Math.PI / 2.4;
  group.add(ring);
  return group;
}

function flythrough() {
  // Shapes stream toward the viewer and wrap around: depth motion that stays fused.
  const group = new THREE.Group();
  const geos = [
    new THREE.IcosahedronGeometry(0.22, 0),
    new THREE.BoxGeometry(0.3, 0.3, 0.3),
    new THREE.TorusGeometry(0.17, 0.07, 12, 32),
    new THREE.OctahedronGeometry(0.24, 0),
  ];
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const rocks = [];
  for (let i = 0; i < 26; i++) {
    const m = new THREE.Mesh(geos[i % geos.length], material());
    const r = { m, x: (rnd() * 2 - 1) * 2.1, y: (rnd() * 2 - 1) * 1.25, z0: rnd() * 3.4, spin: new THREE.Vector3(rnd(), rnd(), rnd()), s: 0.7 + rnd() * 0.8 };
    m.scale.setScalar(r.s);
    group.add(m);
    rocks.push(r);
  }
  group.userData.radius = 1;
  group.userData.update = (t) => {
    for (const r of rocks) {
      const z = ((r.z0 + t * 0.9) % 3.2) - 2.0; // from behind the background to the front of the depth volume
      r.m.position.set(r.x, r.y, z);
      r.m.scale.setScalar(r.s * Math.min(1, (1.2 - z) / 0.5)); // shrink away instead of popping out
      r.m.rotation.set(r.spin.x * t * 2, r.spin.y * t * 2, r.spin.z * t);
    }
  };
  group.userData.update(0);
  return group;
}

let fontPromise = null;
function loadFont() {
  fontPromise ??= new FontLoader().loadAsync('vendor/three/fonts/helvetiker_bold.typeface.json').catch((err) => {
    fontPromise = null; // allow a retry after a transient failure
    throw err;
  });
  return fontPromise;
}

async function textModel(text) {
  const font = await loadFont();
  const g = new TextGeometry(text || ' ', {
    font,
    size: 1,
    depth: 0.35,
    curveSegments: 10,
    bevelEnabled: true,
    bevelThickness: 0.08,
    bevelSize: 0.04,
    bevelSegments: 4,
  });
  g.center();
  return mesh(g);
}

export const BUILTIN_MODELS = {
  torusKnot: { label: 'Torus Knot', make: () => mesh(new THREE.TorusKnotGeometry(0.75, 0.26, 256, 40)) },
  teapot: { label: 'Teapot', make: () => mesh(new TeapotGeometry(1, 12)) },
  heart: { label: 'Heart', make: () => mesh(heartGeometry()) },
  saturn: { label: 'Ringed Planet', make: saturn },
  orbit: { label: 'Orbiting Moons (animated)', make: orbitTrio },
  ripple: { label: 'Ripple Pond (animated)', make: rippleSurface },
  helix: { label: 'Double Helix', make: helixGroup },
  sphere: { label: 'Sphere', make: () => mesh(new THREE.SphereGeometry(1, 96, 64)) },
  torus: { label: 'Torus', make: () => mesh(new THREE.TorusGeometry(0.75, 0.32, 64, 128)) },
  ico: { label: 'Icosahedron', make: () => mesh(new THREE.IcosahedronGeometry(1, 0)) },
  cube: { label: 'Rounded Cube', make: () => mesh(new RoundedBoxGeometry(1.3, 1.3, 1.3, 8, 0.22)) },
  text: { label: '3D Text', make: (opts) => textModel(opts.text) },
  flythrough: { label: 'Asteroid Flythrough (animated)', make: flythrough },
};

/** Center an object and scale it to fit inside a unit sphere. */
export function normalize(object) {
  const wrapper = new THREE.Group();
  wrapper.add(object);
  object.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(object);
  if (box.isEmpty()) return wrapper;
  const center = box.getCenter(new THREE.Vector3());
  let radius = object.userData.radius;
  if (!radius) {
    // Tight radius: farthest vertex from the box center.
    radius = 0;
    const v = new THREE.Vector3();
    object.traverse((o) => {
      const pos = o.isMesh && o.geometry.attributes.position;
      if (!pos) return;
      for (let i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld);
        radius = Math.max(radius, v.distanceTo(center));
      }
    });
  }
  const s = 1 / (radius || 1);
  object.position.sub(center).multiplyScalar(s);
  object.scale.multiplyScalar(s);
  wrapper.userData.update = object.userData.update;
  return wrapper;
}

function prepareGeometry(geometry) {
  if (!geometry.attributes.normal) geometry.computeVertexNormals();
  return mesh(geometry);
}

export const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'avif', 'heic', 'heif'];

export function isImageFile(file) {
  const ext = file.name.split('.').pop().toLowerCase();
  return IMAGE_EXTENSIONS.includes(ext) || Boolean(file.type?.startsWith('image/'));
}

/**
 * Decode an image and take its brightness as depth (white = near). Transparent
 * pixels count as background. HEIC files also yield the depth map and portrait
 * matte an iPhone embeds in Portrait-mode photos, when present.
 * @returns {Promise<{bitmap: ImageBitmap, brightness: {w,h,data}, embedded: {w,h,data}|null, matte: {w,h,data}|null}>}
 */
export async function readImage(file, maxSide = 320) {
  let bitmap;
  let embedded = null;
  let matte = null;
  if (isHeicFile(file)) {
    const heic = await decodeHeic(await file.arrayBuffer());
    bitmap = await createImageBitmap(new ImageData(heic.photo.rgba, heic.photo.w, heic.photo.h));
    embedded = heic.depth;
    matte = heic.matte;
  } else {
    bitmap = await createImageBitmap(file);
  }
  const k = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(2, Math.round(bitmap.width * k));
  const h = Math.max(2, Math.round(bitmap.height * k));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const c2d = canvas.getContext('2d', { willReadFrequently: true });
  c2d.drawImage(bitmap, 0, 0, w, h);
  const px = c2d.getImageData(0, 0, w, h).data;
  const data = new Float32Array(w * h);
  for (let i = 0; i < data.length; i++) {
    const p = i * 4;
    data[i] = ((0.2126 * px[p] + 0.7152 * px[p + 1] + 0.0722 * px[p + 2]) / 255) * (px[p + 3] / 255);
  }
  return { bitmap, brightness: { w, h, data }, embedded, matte };
}

/**
 * Build a relief surface from a depth image.
 * @param {{w:number,h:number,data:Float32Array}} depth values in [0,1], 1 = near
 * @param {{invert:boolean, contrast:number, blur:number, relief:number}} opts
 */
export function reliefMesh(depth, opts) {
  // Resample to a mesh-sized grid.
  const maxCols = 220;
  const k = Math.min(1, maxCols / Math.max(depth.w, depth.h));
  const cols = Math.max(2, Math.round(depth.w * k));
  const rows = Math.max(2, Math.round(depth.h * k));
  let z = new Float32Array(cols * rows);
  for (let j = 0; j < rows; j++) {
    const sy = (j / (rows - 1)) * (depth.h - 1);
    const y0 = Math.floor(sy);
    const y1 = Math.min(depth.h - 1, y0 + 1);
    const fy = sy - y0;
    for (let i = 0; i < cols; i++) {
      const sx = (i / (cols - 1)) * (depth.w - 1);
      const x0 = Math.floor(sx);
      const x1 = Math.min(depth.w - 1, x0 + 1);
      const fx = sx - x0;
      const d = depth.data;
      const top = d[y0 * depth.w + x0] * (1 - fx) + d[y0 * depth.w + x1] * fx;
      const bot = d[y1 * depth.w + x0] * (1 - fx) + d[y1 * depth.w + x1] * fx;
      z[j * cols + i] = top * (1 - fy) + bot * fy;
    }
  }
  if (opts.blur > 0) smoothDepth(z, cols, rows, Math.round(opts.blur), new Float32Array(z.length));

  // Stretch to the full range, then shape it: invert, and contrast as a gamma curve.
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of z) {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  const span = hi - lo || 1;
  const gamma = 1 / Math.max(0.05, opts.contrast);
  for (let i = 0; i < z.length; i++) {
    let v = (z[i] - lo) / span;
    if (opts.invert) v = 1 - v;
    z[i] = Math.pow(v, gamma);
  }

  const aspect = cols / rows;
  const height = aspect > 1.6 ? 4.2 / aspect : 2.6;
  const geo = new THREE.PlaneGeometry(height * aspect, height, cols - 1, rows - 1);
  const pos = geo.attributes.position;
  // PlaneGeometry vertices run row by row from the top-left, like image pixels.
  for (let i = 0; i < pos.count; i++) pos.setZ(i, z[i] * opts.relief);
  geo.computeVertexNormals();
  const m = mesh(geo);
  // Fixed radius so the relief fills the screen instead of being shrunk into the unit sphere.
  m.userData.radius = 1;
  return m;
}

/** Parse a user-provided model file into a renderable Object3D. */
export async function loadModelFile(file) {
  const ext = file.name.split('.').pop().toLowerCase();
  if (ext === 'stl') {
    return prepareGeometry(new STLLoader().parse(await file.arrayBuffer()));
  }
  if (ext === 'ply') {
    return prepareGeometry(new PLYLoader().parse(await file.arrayBuffer()));
  }
  if (ext === 'obj') {
    const group = new OBJLoader().parse(await file.text());
    let meshes = 0;
    group.traverse((o) => {
      if (o.isMesh) {
        meshes++;
        if (!o.geometry.attributes.normal) o.geometry.computeVertexNormals();
        o.material = material();
      } else if (o.isLine || o.isPoints) {
        o.visible = false;
      }
    });
    if (!meshes) throw new Error('OBJ file has no faces');
    return group;
  }
  throw new Error(`Unsupported file type .${ext} (use STL, OBJ or PLY)`);
}
