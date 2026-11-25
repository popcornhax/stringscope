import * as THREE from 'three';
import { DepthScene, CAMERA_DISTANCE } from './scene.js';
import { BUILTIN_MODELS, normalize, loadModelFile, isImageFile, readImage, reliefMesh } from './models.js';
import { ComputeClient, Frame } from './compute.js';
import { PATTERNS } from './patterns.js';
import { PALETTES } from './palettes.js';
import { drawStereogram, exportSVG } from './draw.js';
import { GLLineRenderer } from './gldraw.js';
import { randomSeed } from './rng.js';

const STORAGE_KEY = 'stringscope.settings.v1';

const DEFAULTS = {
  model: 'torusKnot',
  text: 'MAGIC',
  scale: 1,
  motion: 'rock',
  speed: 0.6,
  playing: true,
  crossEyed: false,
  eye: 130,
  strength: 0.3,
  lift: 0.1,
  smoothing: 3,
  cell: 3,
  damping: 0,
  pattern: 'scribble',
  palette: 'ballpoint',
  seed: 20260,
  density: 1,
  lineWidth: 0.9,
  glow: 0.6,
  guides: true,
  view: 'stereo',
  inset: false,
  flow: 0,
  reveal: false,
  micGain: 1,
  reconnect: 14,
  imageMode: 'brightness',
  imageInvert: false,
  imageRelief: 0.75,
  imageContrast: 1,
  imageBlur: 1,
};

const FORMAT = {
  scale: (v) => `${Math.round(v * 100)}%`,
  speed: (v) => `${v.toFixed(2)}×`,
  eye: (v) => `${v}px`,
  strength: (v) => `${Math.round(v * 100)}%`,
  lift: (v) => v.toFixed(2),
  smoothing: (v) => (v ? `${v}` : 'off'),
  cell: (v) => (v <= 2 ? 'ultra' : v <= 2.5 ? 'high' : v <= 3.5 ? 'normal' : v <= 4.5 ? 'fast' : 'draft'),
  damping: (v) => (v ? v.toFixed(2) : 'off'),
  reconnect: (v) => (v ? `${v}px` : 'off'),
  density: (v) => `${v.toFixed(2)}×`,
  lineWidth: (v) => `${v.toFixed(2)}px`,
  glow: (v) => (v ? v.toFixed(2) : 'off'),
  flow: (v) => (v ? `${v > 0 ? '→' : '←'} ${Math.abs(v).toFixed(2)}` : 'still'),
  micGain: (v) => `${v.toFixed(2)}×`,
  imageRelief: (v) => v.toFixed(2),
  imageContrast: (v) => v.toFixed(2),
  imageBlur: (v) => (v ? `${v}` : 'off'),
};

// ---------------------------------------------------------------- state

const CHOICES = {
  view: ['stereo', 'depth', 'shaded'],
  motion: ['none', 'spin', 'tumble', 'rock', 'float', 'orbit'],
  imageMode: ['embedded', 'matte', 'brightness', 'ai'],
};

// Accept a saved value only if it has the default's type and lies within the control's range.
function sanitize(saved) {
  const s = { ...DEFAULTS };
  for (const [key, def] of Object.entries(DEFAULTS)) {
    const v = saved?.[key];
    if (typeof v !== typeof def) continue;
    if (typeof v === 'number') {
      if (!Number.isFinite(v)) continue;
      const el = document.querySelector(`[data-bind="${key}"]`);
      const min = el?.min !== '' && el?.min !== undefined ? Number(el.min) : -Infinity;
      const max = el?.max !== '' && el?.max !== undefined ? Number(el.max) : Infinity;
      s[key] = Math.min(max, Math.max(min, v));
    } else {
      s[key] = v;
    }
  }
  for (const [key, list] of Object.entries(CHOICES)) if (!list.includes(s[key])) s[key] = DEFAULTS[key];
  if (!BUILTIN_MODELS[s.model]) s.model = DEFAULTS.model;
  if (!PATTERNS[s.pattern]) s.pattern = DEFAULTS.pattern;
  if (!PALETTES[s.palette]) s.palette = DEFAULTS.palette;
  return s;
}

const isTouch = window.matchMedia('(hover: none), (pointer: coarse)').matches;

// First-run defaults for phones and tablets: closer viewing distance wants a
// smaller eye separation, and a slightly coarser grid keeps the frame rate up.
function deviceDefaults() {
  const short = Math.min(window.innerWidth, window.innerHeight);
  if (!isTouch) return {};
  if (short < 500) return { eye: Math.round(Math.min(110, Math.max(64, window.innerWidth / 5))), cell: 3.5 };
  return { eye: 110, cell: 3 };
}

function loadSettings() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    return sanitize(saved ? JSON.parse(saved) : deviceDefaults());
  } catch {
    return sanitize(deviceDefaults());
  }
}

const state = loadSettings();
let saveTimer = 0;
function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      const { model, ...rest } = state; // imported models can't be restored after reload
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...rest, model: BUILTIN_MODELS[model] ? model : DEFAULTS.model }));
    } catch {
      /* storage unavailable: settings just won't persist */
    }
  }, 250);
}

// ---------------------------------------------------------------- setup

const $ = (sel) => document.querySelector(sel);
const linesCanvas = $('#lines');
const ctx = linesCanvas.getContext('2d');
const depthScene = new DepthScene($('#gl'));
const compute = new ComputeClient();
let frameData = new Frame(); // the latest computed frame; what the renderers draw

// GPU line drawing everywhere WebGL2 works (Safari rasterizes huge canvas paths on the CPU).
// Add ?canvas to the URL to force the Canvas 2D fallback.
let glLines = null;
if (!new URLSearchParams(location.search).has('canvas')) {
  try {
    glLines = new GLLineRenderer($('#gllines'));
  } catch (err) {
    console.warn('GPU line renderer unavailable, using Canvas 2D', err);
  }
}

const view = { cssW: 0, cssH: 0, dpr: 1, gw: 0, gh: 0, cellW: 1, cellH: 1 };
let dirty = true;
let importedName = null;

function resize() {
  const cssW = Math.max(200, window.innerWidth);
  const cssH = Math.max(150, window.innerHeight);
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  linesCanvas.width = Math.round(cssW * dpr);
  linesCanvas.height = Math.round(cssH * dpr);
  glLines?.resize(linesCanvas.width, linesCanvas.height);
  const gw = Math.round(cssW / state.cell) + 1;
  const gh = Math.round(cssH / state.cell) + 1;
  Object.assign(view, { cssW, cssH, dpr, gw, gh, cellW: cssW / (gw - 1), cellH: cssH / (gh - 1) });
  dirty = true;
}
window.addEventListener('resize', resize);

// ---------------------------------------------------------------- pose & motion

const userQuat = new THREE.Quaternion();
const userPos = new THREE.Vector3();
const animQuat = new THREE.Quaternion();
const animPos = new THREE.Vector3();
const tmpQ = new THREE.Quaternion();
const AXIS_X = new THREE.Vector3(1, 0, 0);
const AXIS_Y = new THREE.Vector3(0, 1, 0);
const TUMBLE = new THREE.Vector3(0.45, 1, 0.3).normalize();
let motionTime = 0;
let modelTime = 0;
let patternTime = 0; // drives animated glyph patterns
let flowOffset = 0; // accumulated sideways drift of the design, in periods

function resetPose() {
  userQuat.identity();
  userPos.set(0, 0, 0);
  motionTime = 0;
  dirty = true;
}

function motionPose(t) {
  animQuat.identity();
  animPos.set(0, 0, 0);
  switch (state.motion) {
    case 'spin':
      animQuat.setFromAxisAngle(AXIS_Y, t);
      break;
    case 'tumble':
      animQuat.setFromAxisAngle(TUMBLE, t);
      break;
    case 'rock':
      animQuat.setFromAxisAngle(AXIS_Y, 0.65 * Math.sin(t));
      tmpQ.setFromAxisAngle(AXIS_X, 0.3 * Math.sin(t * 0.73));
      animQuat.multiply(tmpQ);
      break;
    case 'float':
      animPos.set(0.1 * Math.sin(t * 0.6), 0.16 * Math.sin(t * 1.3), 0.45 * Math.sin(t * 0.8));
      animQuat.setFromAxisAngle(AXIS_Y, 0.5 * Math.sin(t * 0.5));
      break;
    case 'orbit':
      animPos.set(0.75 * Math.cos(t), 0.1 * Math.sin(t * 2), 0.6 * Math.sin(t));
      animQuat.setFromAxisAngle(AXIS_Y, -t);
      break;
  }
}

function applyPose() {
  motionPose(motionTime);
  const p = depthScene.pivot;
  // User rotation is applied in screen space on top of the animated pose.
  p.quaternion.copy(userQuat).multiply(animQuat);
  p.position.copy(userPos).add(animPos);
  p.scale.setScalar(state.scale * mic.pulse);
}

const isAnimatedModel = () => Boolean(depthScene.model?.userData.update);
const isMoving = () =>
  mic.active ||
  (state.playing &&
    ((state.speed > 0 && (state.motion !== 'none' || isAnimatedModel())) || state.flow !== 0 || compute.isAnimated()));

// ---------------------------------------------------------------- models

let modelRequest = 0;
async function setBuiltinModel(key) {
  const def = BUILTIN_MODELS[key];
  if (!def) return;
  const req = ++modelRequest;
  try {
    const obj = await def.make({ text: state.text });
    if (req !== modelRequest) return;
    depthScene.setModel(normalize(obj));
    importedName = null;
    dirty = true;
  } catch (err) {
    console.error(err);
    toast(`Could not build model: ${err.message}`, true);
  }
}

// ---------------------------------------------------------------- image depth

let image = null; // { name, bitmap, brightness, ai, aiPromise } for the current image import
const IMAGE_KEYS = new Set(['imageMode', 'imageInvert', 'imageRelief', 'imageContrast', 'imageBlur']);

function setAIStatus(text) {
  $('#aiStatus').textContent = text;
}

async function importImage(file) {
  toast(/\.hei[cf]$/i.test(file.name) ? `Decoding ${file.name} (HEIC)…` : `Loading ${file.name}…`);
  const req = ++modelRequest;
  try {
    const { bitmap, brightness, embedded, matte } = await readImage(file);
    if (req !== modelRequest) return;
    image?.bitmap.close?.();
    image = { name: file.name, bitmap, brightness, embedded, matte, ai: null, aiPromise: null };
    // Prefer the camera's own depth when the photo has it; otherwise leave the user's choice.
    if (embedded) state.imageMode = 'embedded';
    else if (state.imageMode === 'embedded' || state.imageMode === 'matte') state.imageMode = 'brightness';
    importedName = file.name;
    state.model = '__import';
    setAIStatus('');
    rebuildImage();
    resetPose();
    syncUI();
    toast(embedded ? `Loaded ${file.name} with its embedded iPhone depth map` : `Loaded ${file.name} as a depth image`);
  } catch (err) {
    console.error(err);
    toast(`Could not read image ${file.name}${/\.hei[cf]$/i.test(file.name) ? ' (HEIC decoder needs internet the first time)' : ''}`, true);
  }
}

// Runs Depth Anything on the current image once; later rebuilds reuse the result.
function ensureAIDepth(img) {
  img.aiPromise ??= (async () => {
    setAIStatus('Loading depth model…');
    const { estimateDepth } = await import('./depthai.js');
    const depth = await estimateDepth(img.bitmap, (frac, total) => {
      const msg = `Downloading depth model… ${Math.round(frac * 100)}% of ${(total / 1e6).toFixed(0)} MB (first time only)`;
      setAIStatus(msg);
    });
    img.ai = depth;
    return depth;
  })().catch((err) => {
    img.aiPromise = null;
    throw err;
  });
  return img.aiPromise;
}

function rebuildImage() {
  const img = image;
  if (!img || state.model !== '__import') return;
  const opts = { invert: state.imageInvert, contrast: state.imageContrast, blur: state.imageBlur, relief: state.imageRelief };
  if (state.imageMode === 'ai' && !img.ai) {
    setAIStatus('Estimating depth…');
    ensureAIDepth(img)
      .then(() => {
        if (image !== img) return;
        setAIStatus('AI depth estimated with Depth Anything V2');
        rebuildImage();
      })
      .catch((err) => {
        console.error(err);
        if (image !== img) return;
        setAIStatus('AI depth failed (offline?). Using brightness instead.');
        toast('AI depth unavailable — check your connection', true);
      });
  } else if (state.imageMode === 'ai') {
    setAIStatus('AI depth estimated with Depth Anything V2');
  } else if (state.imageMode === 'embedded' && img.embedded) {
    setAIStatus(`Depth recorded by the camera (${img.embedded.w}×${img.embedded.h})`);
  } else if (state.imageMode === 'matte' && img.matte) {
    setAIStatus('Portrait matte: the subject as a flat cut-out');
  } else {
    setAIStatus('');
  }
  // Until the AI result arrives (or if a source is missing), show the brightness relief.
  const depth =
    (state.imageMode === 'ai' && img.ai) ||
    (state.imageMode === 'embedded' && img.embedded) ||
    (state.imageMode === 'matte' && img.matte) ||
    img.brightness;
  depthScene.setModel(normalize(reliefMesh(depth, opts)));
  dirty = true;
}

async function importFile(file) {
  if (!file) return;
  if (isImageFile(file)) return importImage(file);
  toast(`Loading ${file.name}…`);
  const req = ++modelRequest;
  try {
    const obj = await loadModelFile(file);
    if (req !== modelRequest) return;
    depthScene.setModel(normalize(obj));
    importedName = file.name;
    image = null;
    state.model = '__import';
    syncModelSelect();
    resetPose();
    toast(`Loaded ${file.name}`);
  } catch (err) {
    console.error(err);
    toast(err.message || `Could not read ${file.name}`, true);
  }
}

function syncModelSelect() {
  const sel = $('#modelSelect');
  let opt = sel.querySelector('option[value="__import"]');
  if (importedName) {
    if (!opt) {
      opt = document.createElement('option');
      opt.value = '__import';
      sel.prepend(opt);
    }
    opt.textContent = `Imported: ${importedName}`;
  } else if (opt) {
    opt.remove();
  }
  sel.value = state.model;
  $('#textRow').style.display = state.model === 'text' ? '' : 'none';
  $('#imageControls').hidden = !(image && state.model === '__import');
  $('#modeEmbedded').hidden = !image?.embedded;
  $('#modeMatte').hidden = !image?.matte;
}

// ---------------------------------------------------------------- sound pulse

const mic = { active: false, pulse: 1, level: 0, stream: null, ctx: null, analyser: null, buf: null };

async function setMic(on) {
  if (on === mic.active) return;
  if (!on) {
    mic.stream?.getTracks().forEach((t) => t.stop());
    mic.ctx?.close();
    Object.assign(mic, { active: false, pulse: 1, level: 0, stream: null, ctx: null, analyser: null });
    $('#micToggle').checked = false;
    dirty = true;
    return;
  }
  try {
    // Create and resume the context before awaiting, while the tap still counts as a user gesture (iOS).
    mic.ctx = new AudioContext();
    mic.ctx.resume();
    mic.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    mic.analyser = mic.ctx.createAnalyser();
    mic.analyser.fftSize = 1024;
    mic.buf = new Float32Array(mic.analyser.fftSize);
    mic.ctx.createMediaStreamSource(mic.stream).connect(mic.analyser);
    mic.active = true;
    toast('Listening — the model now pulses with sound');
  } catch (err) {
    console.error(err);
    mic.ctx?.close();
    mic.ctx = null;
    $('#micToggle').checked = false;
    toast(window.isSecureContext ? 'Microphone unavailable or permission denied' : 'Microphone needs https (or localhost)', true);
  }
}

function updateMic(dt) {
  if (!mic.active) return;
  mic.analyser.getFloatTimeDomainData(mic.buf);
  let sum = 0;
  for (let i = 0; i < mic.buf.length; i++) sum += mic.buf[i] * mic.buf[i];
  const rms = Math.sqrt(sum / mic.buf.length);
  // Fast attack, slow release, like a VU meter.
  const k = rms > mic.level ? 0.6 : Math.min(1, dt * 4);
  mic.level += (rms - mic.level) * k;
  mic.pulse = 1 + Math.min(0.8, mic.level * 4 * state.micGain);
}

// ---------------------------------------------------------------- gallery tour

const GALLERY_SECONDS = 14;
const gallery = { active: false, timer: 0 };
// Pairings that look good together; anything else is picked at random.
const GALLERY_COMBOS = [
  ['scribble', 'ballpoint'],
  ['rain', 'matrix'],
  ['typewriter', 'sumi'],
  ['guilloche', 'gold'],
  ['strings', 'aurora'],
  ['morse', 'noir'],
  ['topo', 'ink'],
  ['rings', 'vapor'],
  ['lattice', 'blueprint'],
  ['weave', 'riso'],
  ['ripples', 'ocean'],
  ['guilloche', 'spectrum'],
  ['scribble', 'mint'],
];
const GALLERY_MOTION = ['rock', 'spin', 'tumble', 'float', 'orbit'];
const pickOne = (list) => list[Math.floor(Math.random() * list.length)];

function galleryStep() {
  const models = Object.keys(BUILTIN_MODELS).filter((m) => m !== state.model);
  const [pattern, palette] = pickOne(GALLERY_COMBOS);
  Object.assign(state, { pattern, palette, seed: randomSeed(), motion: pickOne(GALLERY_MOTION), model: pickOne(models) });
  state.flow = Math.random() < 0.3 ? (Math.random() < 0.5 ? -0.08 : 0.08) : 0;
  setBuiltinModel(state.model);
  resetPose();
  syncUI();
  toast(`✦ ${BUILTIN_MODELS[state.model].label} · ${PATTERNS[pattern].label} · ${PALETTES[palette].label}`);
}

function setGallery(on) {
  gallery.active = on;
  gallery.timer = 0;
  $('#galleryBtn').classList.toggle('active', on);
  if (on) {
    if (!state.playing) set('playing', true);
    galleryStep();
  } else {
    toast('Gallery tour stopped');
  }
}

// ---------------------------------------------------------------- UI binding

function fillSelect(sel, entries) {
  for (const [value, { label }] of Object.entries(entries)) {
    const o = document.createElement('option');
    o.value = value;
    o.textContent = label;
    sel.append(o);
  }
}
fillSelect($('#modelSelect'), BUILTIN_MODELS);
fillSelect($('#patternSelect'), PATTERNS);
fillSelect($('#paletteSelect'), PALETTES);

const bound = [...document.querySelectorAll('[data-bind]')];

function readControl(el) {
  if (el.type === 'checkbox') return el.checked;
  if (el.type === 'range' || el.type === 'number') return Number(el.value);
  return el.value;
}

function updateRangeFill(el) {
  if (el.type !== 'range') return;
  const pct = ((el.value - el.min) / (el.max - el.min)) * 100;
  el.style.setProperty('--fill', `${pct}%`);
}

function syncUI() {
  for (const el of bound) {
    const v = state[el.dataset.bind];
    if (el.type === 'checkbox') el.checked = Boolean(v);
    else if (document.activeElement !== el) el.value = v;
    updateRangeFill(el);
  }
  for (const out of document.querySelectorAll('[data-out]')) {
    const k = out.dataset.out;
    out.textContent = FORMAT[k] ? FORMAT[k](state[k]) : state[k];
  }
  for (const btn of document.querySelectorAll('[data-set]')) {
    const [k, raw] = btn.dataset.set.split(':');
    btn.classList.toggle('on', String(state[k]) === raw);
  }
  $('#playBtn').textContent = state.playing ? '❚❚' : '▶';
  $('#insetBtn').classList.toggle('active', state.inset);
  document.body.classList.toggle('view-depth', state.view === 'depth');
  document.body.classList.toggle('view-shaded', state.view === 'shaded');
  document.body.classList.toggle('inset', state.inset);
  syncModelSelect();
}

let textTimer = 0;
function onChange(key) {
  if (key === 'cell') resize();
  if (key === 'model') {
    if (state.model !== '__import') setBuiltinModel(state.model);
  }
  if (key === 'text') {
    clearTimeout(textTimer);
    textTimer = setTimeout(() => state.model === 'text' && setBuiltinModel('text'), 250);
  }
  if (key === 'seed') state.seed = Math.max(0, Math.floor(state.seed || 0));
  if (IMAGE_KEYS.has(key)) rebuildImage();
  dirty = true;
  syncUI();
  persist();
}

function set(key, value) {
  state[key] = value;
  onChange(key);
}

for (const el of bound) {
  const handler = () => {
    state[el.dataset.bind] = readControl(el);
    onChange(el.dataset.bind);
  };
  // Selects and checkboxes report on 'change'; sliders and text fields on 'input'.
  el.addEventListener(el.tagName === 'SELECT' || el.type === 'checkbox' ? 'change' : 'input', handler);
}

for (const btn of document.querySelectorAll('[data-set]')) {
  btn.addEventListener('click', () => {
    const [k, raw] = btn.dataset.set.split(':');
    set(k, raw === 'true' ? true : raw === 'false' ? false : raw);
  });
}

const cycleView = () => set('view', { stereo: 'depth', depth: 'shaded', shaded: 'stereo' }[state.view]);
const reseed = () => set('seed', randomSeed());
const toggleClean = () => document.body.classList.toggle('clean');
const togglePanel = () => document.body.classList.toggle('panel-closed');

const isStandalone = () => window.matchMedia('(display-mode: fullscreen), (display-mode: standalone)').matches || navigator.standalone === true;

function toggleFullscreen() {
  const el = document.documentElement;
  const request = el.requestFullscreen || el.webkitRequestFullscreen;
  if (document.fullscreenElement || document.webkitFullscreenElement) {
    (document.exitFullscreen || document.webkitExitFullscreen).call(document);
  } else if (request) {
    Promise.resolve(request.call(el)).catch(() => toast('Fullscreen not available', true));
  } else {
    // iPhone Safari: pages can't go fullscreen, but a home-screen app opens without browser bars.
    toast('On iPhone: tap Share → Add to Home Screen for fullscreen');
    document.body.classList.add('clean');
  }
}
if (isStandalone()) $('#fullBtn').hidden = true;

async function saveSVG() {
  if (state.view !== 'stereo') set('view', 'stereo');
  await computeStereogram();
  const svg = exportSVG(drawParams());
  const blob = new Blob([svg], { type: 'image/svg+xml' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `stringscope-${state.pattern}-${state.seed}.svg`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  toast('SVG exported');
}

function showHelp(show) {
  $('#help').hidden = !show;
}

$('#playBtn').addEventListener('click', () => set('playing', !state.playing));
$('#resetPose').addEventListener('click', resetPose);
$('#insetBtn').addEventListener('click', () => set('inset', !state.inset));
$('#svgBtn').addEventListener('click', saveSVG);
$('#fullBtn').addEventListener('click', toggleFullscreen);
$('#cleanBtn').addEventListener('click', toggleClean);
$('#showUI').addEventListener('click', () => document.body.classList.remove('clean'));
$('#helpBtn').addEventListener('click', () => showHelp(true));
$('#helpClose').addEventListener('click', () => showHelp(false));
$('#help').addEventListener('click', (e) => e.target === e.currentTarget && showHelp(false));
$('#reseed').addEventListener('click', reseed);
$('#micToggle').addEventListener('change', (e) => setMic(e.target.checked));
$('#galleryBtn').addEventListener('click', () => setGallery(!gallery.active));
$('#panelToggle').addEventListener('click', togglePanel);
$('#importBtn').addEventListener('click', () => $('#fileInput').click());
$('#fileInput').addEventListener('change', (e) => {
  importFile(e.target.files[0]);
  e.target.value = '';
});
$('#resetAll').addEventListener('click', () => {
  const model = state.model;
  Object.assign(state, DEFAULTS);
  if (model === '__import') state.model = model;
  else setBuiltinModel(state.model);
  resize();
  resetPose();
  syncUI();
  persist();
});

if (window.innerWidth < 720 || window.innerHeight < 500 || (isTouch && window.innerWidth < 1100)) document.body.classList.add('panel-closed');

// ---------------------------------------------------------------- toasts

let toastTimer = 0;
function toast(msg, error = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.toggle('error', error);
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), error ? 4000 : 1800);
}

// ---------------------------------------------------------------- pointer / keyboard

const stage = $('#stage');
const pointers = new Map();
let pinchDist = 0;

stage.addEventListener('contextmenu', (e) => e.preventDefault());
let pinchCenter = null;
let gesture = null; // tracks a possible tap: { x, y, t, moved, multi }
let lastTap = { t: 0, x: 0, y: 0 };

const worldPerPx = () => (2 * CAMERA_DISTANCE * Math.tan((15 * Math.PI) / 180)) / view.cssH;
function panBy(dx, dy) {
  userPos.x += dx * worldPerPx();
  userPos.y -= dy * worldPerPx();
  dirty = true;
}
function twoFingerState() {
  const [a, b] = [...pointers.values()];
  return { dist: Math.hypot(a.x - b.x, a.y - b.y), cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 };
}

stage.addEventListener('pointerdown', (e) => {
  stage.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, pan: e.shiftKey || e.button === 2 || e.button === 1 });
  stage.classList.add('dragging');
  if (pointers.size === 1) gesture = { x: e.clientX, y: e.clientY, t: performance.now(), moved: false, multi: false };
  if (pointers.size === 2) {
    const s = twoFingerState();
    pinchDist = s.dist;
    pinchCenter = { x: s.cx, y: s.cy };
    if (gesture) gesture.multi = true;
  }
});
stage.addEventListener('pointermove', (e) => {
  const p = pointers.get(e.pointerId);
  if (!p) return;
  const dx = e.clientX - p.x;
  const dy = e.clientY - p.y;
  p.x = e.clientX;
  p.y = e.clientY;
  if (gesture && Math.hypot(e.clientX - gesture.x, e.clientY - gesture.y) > 8) gesture.moved = true;
  if (pointers.size >= 2) {
    // Two fingers: pinch pushes in / pulls out, dragging the midpoint moves the model.
    const s = twoFingerState();
    pushPull((s.dist - pinchDist) * 0.006);
    if (pinchCenter) panBy(s.cx - pinchCenter.x, s.cy - pinchCenter.y);
    pinchDist = s.dist;
    pinchCenter = { x: s.cx, y: s.cy };
    return;
  }
  if (p.pan || e.shiftKey) panBy(dx, dy);
  else rotateBy(dx * 0.008, dy * 0.008);
});
const endPointer = (e) => {
  pointers.delete(e.pointerId);
  if (pointers.size < 2) pinchCenter = null;
  if (!pointers.size) {
    stage.classList.remove('dragging');
    if (e.type === 'pointerup' && e.pointerType !== 'mouse') handleTap(e);
    gesture = null;
  }
};

// Touch taps: a tap brings hidden controls back; a double-tap resets the pose.
function handleTap(e) {
  if (!gesture || gesture.moved || gesture.multi || performance.now() - gesture.t > 350) return;
  const now = performance.now();
  if (now - lastTap.t < 320 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 40) {
    resetPose();
    lastTap.t = 0;
    return;
  }
  lastTap = { t: now, x: e.clientX, y: e.clientY };
  if (document.body.classList.contains('clean')) document.body.classList.remove('clean');
}

// Safari fires its own pinch-zoom gestures; keep them from zooming the page.
for (const type of ['gesturestart', 'gesturechange']) stage.addEventListener(type, (e) => e.preventDefault());
stage.addEventListener('pointerup', endPointer);
stage.addEventListener('pointercancel', endPointer);
stage.addEventListener('dblclick', resetPose);
stage.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault();
    pushPull(-e.deltaY * 0.0015);
  },
  { passive: false }
);

function rotateBy(ax, ay) {
  tmpQ.setFromAxisAngle(AXIS_Y, ax);
  userQuat.premultiply(tmpQ);
  tmpQ.setFromAxisAngle(AXIS_X, ay);
  userQuat.premultiply(tmpQ);
  dirty = true;
}

function pushPull(dz) {
  userPos.z = Math.min(1.6, Math.max(-3, userPos.z + dz));
  dirty = true;
}

window.addEventListener('keydown', (e) => {
  if (e.target.closest('input, select, textarea, button, summary, a, [contenteditable]')) return;
  if (e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
  const k = e.key;
  const handled = {
    ' ': () => set('playing', !state.playing),
    r: reseed,
    R: reseed,
    d: cycleView,
    D: cycleView,
    p: () => set('inset', !state.inset),
    P: () => set('inset', !state.inset),
    s: saveSVG,
    S: saveSVG,
    h: toggleClean,
    H: toggleClean,
    f: toggleFullscreen,
    F: toggleFullscreen,
    0: resetPose,
    x: () => set('reveal', !state.reveal),
    X: () => set('reveal', !state.reveal),
    g: () => setGallery(!gallery.active),
    G: () => setGallery(!gallery.active),
    '?': () => showHelp(true),
    Escape: () => showHelp(false),
    ArrowLeft: () => rotateBy(-0.08, 0),
    ArrowRight: () => rotateBy(0.08, 0),
    ArrowUp: () => rotateBy(0, -0.08),
    ArrowDown: () => rotateBy(0, 0.08),
    '+': () => pushPull(0.1),
    '=': () => pushPull(0.1),
    '-': () => pushPull(-0.1),
  }[k];
  if (handled) {
    e.preventDefault();
    handled();
  }
});

// Drag & drop import
let dragDepth = 0;
window.addEventListener('dragenter', (e) => {
  e.preventDefault();
  dragDepth++;
  document.body.classList.add('dragover');
});
window.addEventListener('dragleave', () => {
  if (--dragDepth <= 0) {
    dragDepth = 0;
    document.body.classList.remove('dragover');
  }
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove('dragover');
  importFile(e.dataTransfer.files[0]);
});

// ---------------------------------------------------------------- render loop

function drawParams() {
  return {
    engine: frameData,
    palette: PALETTES[state.palette],
    ...view,
    lineWidth: state.lineWidth,
    glow: state.glow,
    guides: state.guides,
    time: patternTime,
  };
}

// Frames run as a pipeline: the GPU depth readback for the next frame overlaps the
// worker computing the current one, and nothing ever blocks the page.
function frameOptions() {
  return {
    eye: state.eye / view.cellW,
    strength: state.strength,
    crossEyed: state.crossEyed,
    smoothing: state.smoothing,
    damping: state.damping,
    aspect: view.cellH / view.cellW,
    flow: flowOffset,
    reveal: state.reveal,
    reconnect: state.reconnect / view.cellW,
  };
}

async function readDepthFrame() {
  applyPose();
  depthScene.update(modelTime);
  // Front of the volume sits a little ahead of the unit sphere; "lift" moves the back plane.
  depthScene.setDepthRange(1.25, state.lift * 1.6);
  const { gw, gh } = view;
  const buf = compute.takeBuffer(gw, gh);
  const t0 = performance.now();
  await depthScene.readDepth(gw, gh, 2, view.cssW / view.cssH, buf);
  timings.read = performance.now() - t0;
  return { buf, gw, gh, pattern: { id: state.pattern, seed: state.seed, density: state.density }, opts: frameOptions() };
}

async function computeFrame(job) {
  const t0 = performance.now();
  const frame = await compute.run(job.buf, job.gw, job.gh, job.pattern, job.opts);
  timings.compute = performance.now() - t0;
  // A resize while this frame was in flight makes it stale; drop it.
  if (job.gw === view.gw && job.gh === view.gh) frameData = frame;
  return frame;
}

const timings = { read: 0, compute: 0, draw: 0 };

function renderStereogram() {
  const t0 = performance.now();
  const params = drawParams();
  if (glLines) {
    glLines.draw(params);
    drawStereogram(ctx, { ...params, overlayOnly: true });
  } else {
    drawStereogram(ctx, params);
  }
  timings.draw = performance.now() - t0;
}

function renderPreviews() {
  if (state.view !== 'stereo') {
    depthScene.renderPreview(state.view, view.cssW, view.cssH);
  } else if (state.inset) {
    const small = window.innerWidth < 720;
    depthScene.renderPreview('shaded', small ? 150 : 240, small ? 96 : 150);
  }
}

let last = performance.now();
let fpsAcc = 0;
let drawnFrames = 0;
let reading = false; // GPU depth readback in flight
let computing = false; // worker busy
let queued = null; // depth read, waiting for the worker

function startRead() {
  reading = true;
  readDepthFrame()
    .then((job) => {
      if (queued) compute.pool.push(queued.buf); // superseded by a newer read
      queued = job;
      dispatch();
    })
    .catch((err) => console.error(err))
    .finally(() => {
      reading = false;
    });
}

function dispatch() {
  if (computing || !queued) return;
  const job = queued;
  queued = null;
  computing = true;
  computeFrame(job)
    .then(() => {
      if (state.view === 'stereo') {
        renderStereogram();
        renderPreviews();
        drawnFrames++;
      }
    })
    .catch((err) => console.error(err))
    .finally(() => {
      computing = false;
      dispatch();
    });
}

/** Waits for in-flight work, then computes one frame synchronously in order (used by SVG export). */
async function computeStereogram() {
  while (reading || computing) await new Promise((r) => setTimeout(r, 10));
  reading = true;
  try {
    await computeFrame(await readDepthFrame());
  } finally {
    reading = false;
  }
}

function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  if (state.playing) {
    motionTime += dt * state.speed;
    modelTime += dt * state.speed;
    patternTime += dt;
    flowOffset = (flowOffset + dt * state.flow) % 1000;
  }
  updateMic(dt);
  if (gallery.active && state.playing && (gallery.timer += dt) > GALLERY_SECONDS) {
    gallery.timer = 0;
    galleryStep();
  }

  if (dirty || isMoving()) {
    if (state.view === 'stereo') {
      // Start the next depth read as soon as the GPU path is free; at most one read waits for the worker.
      if (!reading && !queued) {
        dirty = false;
        startRead();
      }
    } else {
      dirty = false;
      applyPose();
      depthScene.update(modelTime);
      depthScene.setDepthRange(1.25, state.lift * 1.6);
      renderPreviews();
      drawnFrames++;
    }
  }

  fpsAcc += dt;
  if (fpsAcc > 0.5) {
    const work = timings.read + timings.compute + timings.draw;
    $('#stats').textContent =
      `${(drawnFrames / fpsAcc).toFixed(0)} fps · ${work.toFixed(1)} ms · ${glLines ? 'GPU' : 'canvas'} · ${compute.mode}\n` +
      `${frameData.glyphCount() ? `${frameData.glyphCount().toLocaleString()} glyphs` : `${frameData.segmentCount().toLocaleString()} line segments`}` +
      ` · grid ${view.gw}×${view.gh}`;
    fpsAcc = 0;
    drawnFrames = 0;
  }
  requestAnimationFrame(frame);
}

// ---------------------------------------------------------------- boot

resize();
syncUI();
setBuiltinModel(state.model).then(() => {
  requestAnimationFrame(frame);
  try {
    if (!localStorage.getItem('stringscope.helpSeen')) {
      showHelp(true);
      localStorage.setItem('stringscope.helpSeen', '1');
    }
  } catch {
    /* storage unavailable: skip the first-run help */
  }
});

// Offline support once installed to the home screen (needs https or localhost).
if ('serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.register('sw.js').catch((err) => console.warn('Service worker not registered', err));
}

// Debug hook for automated checks.
window.__stringscope = {
  get engine() {
    return frameData;
  },
  compute,
  state,
  depthScene, set, resetPose, importFile, setGallery, galleryStep, userPos, timings };
