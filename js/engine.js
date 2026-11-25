// Depth grid -> phase field -> contour line segments. No DOM access, so it runs in Node tests.

import { computePhase, phaseJumpMask, smoothDepth, makeSeparation } from './stereo.js';
import { buildPattern } from './patterns.js';
import { SegmentBuffer, EndList, extractContours } from './contours.js';
import { bridgeEnds } from './bridges.js';

const TABLE_RES = 512;
const REVEAL_LEVELS = 14;

export class StereoEngine {
  constructor() {
    this.gw = 0;
    this.gh = 0;
    this.layers = [];
    this.patternKey = '';
    this.sBg = 1;
    this.tableKey = '';
    this.reveal = new SegmentBuffer();
    this.ends = new EndList();
    this.bridges = 0;
    this.brokenEnds = 0;
  }

  resize(gw, gh) {
    if (gw === this.gw && gh === this.gh) return;
    this.gw = gw;
    this.gh = gh;
    const n = gw * gh;
    this.depth = new Float32Array(n);
    this.tmp = new Float32Array(n);
    this.phase = new Float32Array(n);
    this.field = new Float32Array(n);
    this.gateField = new Float32Array(n);
    this.mask = new Uint8Array((gw - 1) * (gh - 1));
    this.layerMask = new Uint8Array((gw - 1) * (gh - 1));
    this.tableKey = '';
  }

  setPattern(id, seed, density) {
    const key = `${id}|${seed}|${density}`;
    if (key === this.patternKey) return;
    this.patternKey = key;
    this.layers = buildPattern(id, seed, density).map((layer) => ({
      ...layer,
      buffers: layer.styles.map(() => new SegmentBuffer()),
      // Level shift per full period: F(u + 1, v) = F(u, v) + shift.
      shift: layer.field ? Math.round(layer.field(1, 0.37) - layer.field(0, 0.37)) : 0,
      glyphCount: 0,
    }));
    this.tableKey = '';
  }

  // Tabulate each field over one period of u for every grid row. Per frame the
  // fields are then a lerp lookup, which keeps dense patterns cheap.
  buildTables(vScale) {
    const key = `${this.patternKey}|${this.gh}|${vScale}`;
    if (key === this.tableKey) return;
    this.tableKey = key;
    for (const layer of this.layers) {
      if (layer.field) layer.table = this.tabulate(layer.field, vScale);
      if (layer.gate) layer.gateTable = this.tabulate(layer.gate, vScale);
    }
  }

  tabulate(fn, vScale) {
    const U = TABLE_RES;
    const t = new Float32Array(this.gh * (U + 1));
    for (let j = 0; j < this.gh; j++) {
      const v = j * vScale;
      const b = j * (U + 1);
      for (let k = 0; k <= U; k++) t[b + k] = fn(k / U, v);
    }
    return t;
  }

  // Evaluate a tabulated field at every grid point for phase + flow.
  lookup(table, shift, flow, out) {
    const { gw, gh, phase } = this;
    const U = TABLE_RES;
    for (let j = 0; j < gh; j++) {
      const b = j * gw;
      const tb = j * (U + 1);
      for (let i = 0; i < gw; i++) {
        const u = phase[b + i] + flow;
        const fl = Math.floor(u);
        const x = (u - fl) * U;
        const k = Math.min(x | 0, U - 1);
        const f = x - k;
        out[b + i] = table[tb + k] * (1 - f) + table[tb + k + 1] * f + shift * fl;
      }
    }
  }

  /**
   * @param {object} opts { eye (cells), strength, crossEyed, smoothing (cells), damping,
   *   aspect (cellH/cellW), flow (phase offset; slides the design sideways), reveal (bool),
   *   reconnect (radius in cells over which strings are healed across depth cliffs; 0 = off) }
   * Reads this.depth (filled by the caller) and fills each layer's buffers / glyphs.
   */
  compute(opts) {
    const { gw, gh, depth, phase, field, mask } = this;
    smoothDepth(depth, gw, gh, opts.smoothing | 0, this.tmp);
    const { sBg } = computePhase(depth, gw, gh, opts, phase);
    this.sBg = sBg;
    const sep = makeSeparation(opts.eye, opts.strength, opts.crossEyed);
    const s0 = sep(0);
    const s1 = sep(1);
    phaseJumpMask(phase, gw, gh, Math.min(s0, s1), Math.max(s0, s1), mask);
    if (opts.reconnect > 0) this.healCliffs(Math.round(opts.reconnect), Math.max(s0, s1));

    const aspect = opts.aspect || 1;
    const flow = opts.flow || 0;
    this.buildTables(aspect / sBg);
    this.bridges = 0;
    this.brokenEnds = 0;
    for (const layer of this.layers) {
      if (layer.glyph) {
        this.placeGlyphs(layer, flow, aspect);
        continue;
      }
      this.lookup(layer.table, layer.shift, flow, field);
      let m = mask;
      if (layer.gateTable) {
        // Dashed lines: cut every cell whose corner lies where the gate is negative.
        this.lookup(layer.gateTable, 0, flow, this.gateField);
        m = this.layerMask;
        const g = this.gateField;
        for (let j = 0; j < gh - 1; j++) {
          for (let i = 0; i < gw - 1; i++) {
            const c = j * (gw - 1) + i;
            m[c] = mask[c] || g[j * gw + i] < 0 ? 1 : 0;
          }
        }
      }
      for (const buf of layer.buffers) buf.clear();
      this.ends.clear();
      extractContours(field, gw, gh, m, layer.styleOf, layer.buffers, this.ends);
      this.brokenEnds += this.ends.count;
      // Leftover breaks (contour pile-ups) get bridged; dashes are meant to be broken.
      if (opts.reconnect > 0 && !layer.gateTable) this.bridges += bridgeEnds(this.ends, layer.buffers, opts.reconnect);
    }

    this.reveal.clear();
    if (opts.reveal) {
      // Depth isolines of the hidden object: a deliberate spoiler to help first-time viewers.
      for (let i = 0; i < gw * gh; i++) field[i] = depth[i] * REVEAL_LEVELS;
      extractContours(field, gw, gh, null, () => 0, [this.reveal], null);
    }
  }

  // Strings break where the phase jumps (depth cliffs). Near those cells, blend the
  // phase toward a blurred copy so each jump becomes a short ramp: contours of a
  // continuous field can't break, so strings bend around the edge instead. Stereo is
  // only relaxed inside that band, which one eye can't see at a silhouette anyway.
  // Also heals where the phase stalls or runs backwards (behind near-to-far edges),
  // which otherwise makes strings hook back on themselves.
  healCliffs(radius, sMax) {
    const { gw, gh, phase, mask, tmp } = this;
    const n = gw * gh;
    if (!this.healBlur || this.healBlur.length !== n) {
      this.healBlur = new Float32Array(n);
      this.healWeight = new Float32Array(n);
    }
    const blur = this.healBlur;
    const w = this.healWeight;
    const cw = gw - 1;
    let any = false;
    w.fill(0);
    const stall = 0.35 / sMax;
    for (let j = 0; j < gh - 1; j++) {
      for (let i = 0; i < cw; i++) {
        const p0 = j * gw + i;
        if (!mask[j * cw + i] && phase[p0 + 1] - phase[p0] > stall) continue;
        any = true;
        const p = j * gw + i;
        w[p] = w[p + 1] = w[p + gw] = w[p + gw + 1] = 1;
      }
    }
    if (!any) return;
    blur.set(phase);
    smoothDepth(blur, gw, gh, radius, tmp);
    smoothDepth(w, gw, gh, Math.max(1, radius >> 1), tmp);
    for (let i = 0; i < n; i++) {
      const k = Math.min(1, w[i] * 3);
      if (k > 0) phase[i] += k * (blur[i] - phase[i]);
    }
    mask.fill(0);
  }

  // Text rows: on each row, a glyph sits wherever N·u crosses an integer.
  placeGlyphs(layer, flow, aspect) {
    const { gw, gh, phase, mask } = this;
    const g = layer.glyph;
    const N = g.N;
    const spacing = this.sBg / N; // grid columns between glyphs on the background
    const rowStep = (spacing * g.rowScale) / aspect;
    const rows = Math.max(1, Math.floor((gh - 1) / rowStep));
    g.rows = rows;
    g.spacing = spacing;
    const cap = rows * gw;
    if (!layer.gx || layer.gx.length < cap) {
      layer.gx = new Float32Array(cap);
      layer.gy = new Float32Array(cap);
      layer.gk = new Int16Array(cap);
      layer.gr = new Int16Array(cap);
    }
    let n = 0;
    for (let r = 0; r < rows; r++) {
      const y = (r + 0.5) * rowStep;
      const j = Math.min(gh - 1, Math.round(y));
      const mj = Math.min(gh - 2, j) * (gw - 1);
      const b = j * gw;
      for (let i = 0; i < gw - 1; i++) {
        const a = N * (phase[b + i] + flow);
        const c = N * (phase[b + i + 1] + flow);
        if (!(c > a) || mask[mj + i]) continue;
        const lo = Math.floor(a) + 1;
        const hi = Math.floor(c);
        if (hi - lo > 1) continue; // a cliff, not a glyph slot
        for (let level = lo; level <= hi && n < cap; level++) {
          layer.gx[n] = i + (level - a) / (c - a);
          layer.gy[n] = y;
          layer.gk[n] = ((level % N) + N) % N;
          layer.gr[n] = r;
          n++;
        }
      }
    }
    layer.glyphCount = n;
  }

  segmentCount() {
    let n = 0;
    for (const l of this.layers) for (const b of l.buffers) n += b.segments;
    return n;
  }

  glyphCount() {
    return this.layers.reduce((s, l) => s + l.glyphCount, 0);
  }

  isAnimated() {
    return this.layers.some((l) => l.glyph?.animated);
  }
}
