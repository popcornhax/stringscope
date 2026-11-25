// Runs the stereogram engine off the main thread, so the page stays responsive
// however long a frame takes. Receives a depth grid, returns line segments and
// glyph positions as transferable typed arrays.

import { StereoEngine } from './engine.js';

const engine = new StereoEngine();

self.onmessage = ({ data }) => {
  const { id, gw, gh, depth, pattern, opts } = data;
  try {
    engine.resize(gw, gh);
    engine.depth.set(depth);
    engine.setPattern(pattern.id, pattern.seed, pattern.density);
    engine.compute(opts);

    const transfer = [depth.buffer];
    const layers = engine.layers.map((l) => {
      if (l.glyph) {
        const n = l.glyphCount;
        const out = {
          rows: l.glyph.rows,
          spacing: l.glyph.spacing,
          gx: l.gx.slice(0, n),
          gy: l.gy.slice(0, n),
          gk: l.gk.slice(0, n),
          gr: l.gr.slice(0, n),
          glyphCount: n,
        };
        transfer.push(out.gx.buffer, out.gy.buffer, out.gk.buffer, out.gr.buffer);
        return out;
      }
      return {
        buffers: l.buffers.map((b) => {
          const arr = b.data.slice(0, b.length);
          transfer.push(arr.buffer);
          return arr;
        }),
      };
    });
    const reveal = engine.reveal.data.slice(0, engine.reveal.length);
    transfer.push(reveal.buffer);
    self.postMessage({ id, depth, layers, reveal, sBg: engine.sBg, bridges: engine.bridges, brokenEnds: engine.brokenEnds }, transfer);
  } catch (err) {
    self.postMessage({ id, depth, error: String(err?.stack || err) }, [depth.buffer]);
  }
};
