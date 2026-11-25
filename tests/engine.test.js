import test from 'node:test';
import assert from 'node:assert/strict';
import { StereoEngine } from '../js/engine.js';
import { makeSeparation } from '../js/stereo.js';
import { PATTERNS } from '../js/patterns.js';

const GW = 480;
const GH = 300;

function sphereDepth(engine, cx, cy, r) {
  const { gw, gh, depth } = engine;
  for (let j = 0; j < gh; j++) {
    for (let i = 0; i < gw; i++) {
      const dx = (i - cx) / r;
      const dy = (j - cy) / r;
      const q = 1 - dx * dx - dy * dy;
      depth[j * gw + i] = q > 0 ? 0.35 + 0.5 * Math.sqrt(q) : 0;
    }
  }
}

function lerpRow(arr, base, x) {
  const i = Math.floor(x);
  const f = x - i;
  return arr[base + i] * (1 - f) + arr[base + i + 1] * f;
}

function constraintErrors(engine, opts) {
  const sep = makeSeparation(opts.eye, opts.strength, opts.crossEyed);
  const { gw, gh, depth, phase, mask } = engine;
  const errs = [];
  for (let j = 0; j < gh; j += 3) {
    const b = j * gw;
    for (let c = 0; c < gw; c++) {
      const s = sep(depth[b + c]);
      const l = c - s / 2;
      const r = c + s / 2;
      if (l < 0 || r > gw - 2) continue;
      // Ignore samples touching a phase discontinuity (handled by the jump mask).
      const li = Math.floor(l);
      const ri = Math.floor(r);
      if (mask[j * (gw - 1) + li] || mask[j * (gw - 1) + ri]) continue;
      errs.push(Math.abs(lerpRow(phase, b, r) - lerpRow(phase, b, l) - 1));
    }
  }
  errs.sort((a, b) => a - b);
  return { p50: errs[errs.length >> 1], p99: errs[Math.floor(errs.length * 0.99)], n: errs.length };
}

for (const crossEyed of [false, true]) {
  test(`phase field satisfies stereo constraint (crossEyed=${crossEyed})`, () => {
    const e = new StereoEngine();
    e.resize(GW, GH);
    e.setPattern('strings', 7, 1);
    sphereDepth(e, 200, 150, 90);
    const opts = { eye: 45, strength: 0.33, crossEyed, smoothing: 2, damping: 0, aspect: 1 };
    e.compute(opts);
    const { p50, p99, n } = constraintErrors(e, opts);
    assert.ok(n > 10000);
    // Error is in phase units (1 = one full repeat); 0.02 is under a pixel at typical sizes.
    assert.ok(p50 < 0.005, `median error ${p50}`);
    assert.ok(p99 < 0.03, `p99 error ${p99}`);
  });
}

test('background-only frame is exactly periodic', () => {
  const e = new StereoEngine();
  e.resize(GW, GH);
  e.setPattern('topo', 3, 1);
  e.depth.fill(0);
  e.compute({ eye: 40, strength: 0.3, crossEyed: false, smoothing: 0, aspect: 1 });
  for (let x = 0; x < GW - 41; x += 7) {
    assert.ok(Math.abs(e.phase[x + 40] - e.phase[x] - 1) < 1e-5);
  }
});

test('every pattern produces lines and is periodic in u', () => {
  for (const id of Object.keys(PATTERNS)) {
    const e = new StereoEngine();
    e.resize(GW, GH);
    e.setPattern(id, 42, 1);
    sphereDepth(e, 240, 150, 100);
    e.compute({ eye: 45, strength: 0.3, crossEyed: false, smoothing: 2, aspect: 1 });
    if (e.layers.every((l) => l.glyph)) {
      assert.ok(e.glyphCount() > 300, `${id} placed ${e.glyphCount()} glyphs`);
      continue;
    }
    assert.ok(e.segmentCount() > 2000, `${id} produced ${e.segmentCount()} segments`);
    for (const layer of e.layers) {
      for (const [u, v] of [[0.13, 0.4], [0.77, 2.9], [0.5, -1.3]]) {
        const a = layer.field(u, v);
        const b = layer.field(u + 1, v);
        const d = b - a;
        // Shift by a whole period must move levels by a multiple of the style count.
        assert.ok(Math.abs(d - Math.round(d)) < 1e-6, `${id}: non-integer period shift ${d}`);
        assert.equal(((Math.round(d) % layer.styles.length) + layer.styles.length) % layer.styles.length, 0);
      }
    }
  }
});

test('pattern is stable: a small object move only changes nearby phase', () => {
  const e = new StereoEngine();
  e.resize(GW, GH);
  e.setPattern('strings', 1, 1);
  const opts = { eye: 45, strength: 0.3, crossEyed: false, smoothing: 2, aspect: 1 };
  sphereDepth(e, 240, 150, 60);
  e.compute(opts);
  const before = e.phase.slice();
  sphereDepth(e, 241, 150, 60);
  e.compute(opts);
  let maxRowTop = 0;
  for (let i = 0; i < GW; i++) maxRowTop = Math.max(maxRowTop, Math.abs(e.phase[10 * GW + i] - before[10 * GW + i]));
  assert.equal(maxRowTop, 0, 'rows without the object must not change at all');
});

test('performance: full compute under budget', () => {
  const e = new StereoEngine();
  e.resize(GW, GH);
  e.setPattern('weave', 5, 1);
  sphereDepth(e, 240, 150, 100);
  const opts = { eye: 45, strength: 0.3, crossEyed: false, smoothing: 2, aspect: 1 };
  // Warm up the JIT, then time runs one by one and keep the fastest. Load
  // from other processes only ever adds time, so best-of-N measures the
  // engine's own cost and stays stable on a busy machine, while a real
  // slowdown still raises it.
  for (let k = 0; k < 3; k++) e.compute(opts);
  let ms = Infinity;
  for (let k = 0; k < 15; k++) {
    const t0 = performance.now();
    e.compute(opts);
    ms = Math.min(ms, performance.now() - t0);
  }
  console.log(`compute ${GW}x${GH}: best of 15 ${ms.toFixed(1)} ms, ${e.segmentCount()} segments`);
  assert.ok(ms < 60, `compute took ${ms.toFixed(1)} ms, over the 60 ms budget`);
});

test('glyphs repeat once per separation on the background', () => {
  const e = new StereoEngine();
  e.resize(GW, GH);
  e.setPattern('typewriter', 9, 1);
  e.depth.fill(0);
  const eye = 48;
  e.compute({ eye, strength: 0.3, crossEyed: false, smoothing: 0, aspect: 1 });
  const layer = e.layers[0];
  const N = layer.glyph.N;
  // Same row: the glyph with the same column key N slots later sits exactly one separation to the right.
  for (let i = 0; i + N < layer.glyphCount; i += 13) {
    if (layer.gr[i] !== layer.gr[i + N]) continue;
    assert.equal(layer.gk[i], layer.gk[i + N]);
    assert.ok(Math.abs(layer.gx[i + N] - layer.gx[i] - eye) < 1e-3);
  }
});

test('flow by a whole period leaves the drawing unchanged', () => {
  const e = new StereoEngine();
  e.resize(GW, GH);
  e.setPattern('guilloche', 4, 1);
  sphereDepth(e, 240, 150, 80);
  const base = { eye: 45, strength: 0.3, crossEyed: false, smoothing: 2, aspect: 1 };
  e.compute({ ...base, flow: 0.25 });
  const a = e.segmentCount();
  sphereDepth(e, 240, 150, 80);
  e.compute({ ...base, flow: 1.25 });
  assert.equal(e.segmentCount(), a);
});

test('morse gate removes part of the strings and reveal draws depth contours', () => {
  const e = new StereoEngine();
  e.resize(GW, GH);
  sphereDepth(e, 240, 150, 80);
  e.setPattern('morse', 3, 1);
  e.compute({ eye: 45, strength: 0.3, crossEyed: false, smoothing: 2, aspect: 1, reveal: true });
  const dashed = e.segmentCount();
  assert.ok(e.reveal.segments > 100, 'reveal contours present');
  delete e.layers[0].gateTable;
  sphereDepth(e, 240, 150, 80);
  e.compute({ eye: 45, strength: 0.3, crossEyed: false, smoothing: 2, aspect: 1 });
  const solid = e.segmentCount();
  assert.ok(dashed < solid * 0.8 && dashed > solid * 0.2, `dashed ${dashed} vs solid ${solid}`);
  assert.equal(e.reveal.segments, 0);
});

test('reconnect heals strings broken at depth cliffs', () => {
  const run = (reconnect) => {
    const e = new StereoEngine();
    e.resize(GW, GH);
    e.setPattern('strings', 11, 1);
    // A flat-topped box with hard edges makes clean cliffs.
    for (let j = 0; j < GH; j++) for (let i = 0; i < GW; i++) e.depth[j * GW + i] = i > 180 && i < 300 && j > 90 && j < 210 ? 0.9 : 0;
    e.compute({ eye: 45, strength: 0.35, crossEyed: false, smoothing: 0, aspect: 1, reconnect });
    return e;
  };
  const off = run(0);
  const on = run(8);
  const open = (e) => e.brokenEnds - 2 * e.bridges;
  assert.ok(off.brokenEnds > 100, `expected broken ends without reconnect, got ${off.brokenEnds}`);
  assert.ok(open(on) < off.brokenEnds * 0.1, `still broken: ${open(on)} of ${off.brokenEnds}`);
  // Rows far from the box are untouched.
  for (let i = 0; i < GW; i++) assert.equal(on.phase[20 * GW + i], off.phase[20 * GW + i]);
});

test('bridges never span more than the gap limit', async () => {
  const { EndList, SegmentBuffer } = await import('../js/contours.js');
  const { bridgeEnds } = await import('../js/bridges.js');
  const ends = new EndList();
  // Two facing ends 5 apart (should join) and two 20 apart (should not, limit 8).
  ends.push(0, 0, 1, 0, 3, 0);
  ends.push(5, 0, -1, 0, 3, 0);
  ends.push(0, 10, 1, 0, 4, 0);
  ends.push(20, 10, -1, 0, 4, 0);
  // Same level but facing away: must not join.
  ends.push(0, 20, -1, 0, 5, 0);
  ends.push(4, 20, 1, 0, 5, 0);
  const buf = new SegmentBuffer();
  assert.equal(bridgeEnds(ends, [buf], 8), 1);
  for (let k = 0; k < buf.length; k += 4) assert.ok(buf.data[k + 1] === 0 && buf.data[k + 3] === 0);
});
