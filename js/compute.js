// Main-thread side of the engine. Prefers a module Web Worker; falls back to
// computing on the main thread where module workers aren't available.
// Either way it returns a Frame: the read-only shape the renderers draw from.

import { StereoEngine } from './engine.js';
import { buildPattern } from './patterns.js';

/** What the renderers read: layers (styles + buffers or glyphs), reveal, sBg, gw, gh. */
export class Frame {
  constructor(gw = 2, gh = 2) {
    this.gw = gw;
    this.gh = gh;
    this.sBg = 1;
    this.layers = [];
    this.reveal = { data: new Float32Array(0), length: 0 };
    this.bridges = 0;
    this.brokenEnds = 0;
  }
  segmentCount() {
    let n = 0;
    for (const l of this.layers) if (l.buffers) for (const b of l.buffers) n += b.length / 4;
    return n;
  }
  glyphCount() {
    return this.layers.reduce((s, l) => s + (l.glyphCount || 0), 0);
  }
}

export class ComputeClient {
  constructor() {
    this.patternKey = '';
    this.patternLayers = [];
    this.pool = []; // spare depth buffers (they shuttle to the worker and back)
    this.nextId = 1;
    this.pending = new Map();
    try {
      this.worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
      this.worker.onmessage = (e) => this.onResult(e.data);
      this.worker.onerror = (e) => {
        console.warn('Engine worker failed, computing on the main thread', e.message);
        this.useLocal();
      };
    } catch (err) {
      console.warn('Module workers unavailable, computing on the main thread', err);
      this.useLocal();
    }
  }

  get mode() {
    return this.worker ? 'worker' : 'main thread';
  }

  useLocal() {
    this.worker?.terminate();
    this.worker = null;
    this.local = new StereoEngine();
    for (const { reject } of this.pending.values()) reject(new Error('worker stopped'));
    this.pending.clear();
  }

  /** Local copy of the pattern: styles and glyph functions for drawing (same seed = same design). */
  pattern(id, seed, density) {
    const key = `${id}|${seed}|${density}`;
    if (key !== this.patternKey) {
      this.patternKey = key;
      this.patternLayers = buildPattern(id, seed, density);
    }
    return this.patternLayers;
  }

  isAnimated() {
    return this.patternLayers.some((l) => l.glyph?.animated);
  }

  /** A depth buffer for the caller to fill and then pass to run(). */
  takeBuffer(gw, gh) {
    const n = gw * gh;
    while (this.pool.length) {
      const b = this.pool.pop();
      if (b.length === n) return b;
    }
    return new Float32Array(n);
  }

  /** @returns {Promise<Frame>} */
  run(depth, gw, gh, pattern, opts) {
    const local = this.pattern(pattern.id, pattern.seed, pattern.density);
    if (!this.worker) {
      const frame = this.runLocal(depth, gw, gh, pattern, opts, local);
      this.pool.push(depth);
      return Promise.resolve(frame);
    }
    const id = this.nextId++;
    // The buffer is transferred; the worker hands it back with the result.
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, gw, gh, local });
      this.worker.postMessage({ id, gw, gh, depth, pattern, opts }, [depth.buffer]);
    });
  }

  onResult(msg) {
    const job = this.pending.get(msg.id);
    if (!job) return;
    this.pending.delete(msg.id);
    if (msg.depth?.length) this.pool.push(msg.depth);
    if (msg.error) {
      job.reject(new Error(msg.error));
      return;
    }
    const frame = new Frame(job.gw, job.gh);
    frame.sBg = msg.sBg;
    frame.bridges = msg.bridges;
    frame.brokenEnds = msg.brokenEnds;
    frame.reveal = { data: msg.reveal, length: msg.reveal.length };
    frame.layers = job.local.map((def, i) => {
      const r = msg.layers[i];
      if (def.glyph) {
        def.glyph.rows = r.rows;
        def.glyph.spacing = r.spacing;
        return { styles: def.styles, glyph: def.glyph, gx: r.gx, gy: r.gy, gk: r.gk, gr: r.gr, glyphCount: r.glyphCount };
      }
      return { styles: def.styles, buffers: r.buffers.map((data) => ({ data, length: data.length })) };
    });
    job.resolve(frame);
  }

  runLocal(depth, gw, gh, pattern, opts, local) {
    const e = this.local;
    e.resize(gw, gh);
    e.depth.set(depth);
    e.setPattern(pattern.id, pattern.seed, pattern.density);
    e.compute(opts);
    const frame = new Frame(gw, gh);
    frame.sBg = e.sBg;
    frame.bridges = e.bridges;
    frame.brokenEnds = e.brokenEnds;
    frame.reveal = e.reveal;
    frame.layers = e.layers.map((l, i) => ({ ...l, styles: local[i].styles }));
    return frame;
  }
}
