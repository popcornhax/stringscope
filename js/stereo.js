// Stereogram phase field.
//
// A classic autostereogram links pairs of screen points (left, right) that
// straddle a "center" c: both eyes look through them at the same 3D point, so
// they must share the same texture. Instead of copying pixel colors we solve
// for a continuous phase u(x) per scanline such that
//
//     u(c + s/2) - u(c - s/2) = 1,   s = separation(depth(c))
//
// Any texture that is periodic in u (period 1) then forms a valid stereogram.
// Because u is continuous, the texture can be drawn as smooth vector lines
// (contours of fields defined over (u, y)) rather than as pixels.

/** Separation (in grid cells) for a normalized depth z in [0, 1], 1 = nearest. */
export function makeSeparation(eye, strength, crossEyed) {
  if (crossEyed) {
    // Cross-eyed viewing perceives inverted disparity: near points need a wider separation.
    return (z) => Math.max(2, eye * (1 - strength * (1 - z)));
  }
  return (z) => Math.max(2, eye * (1 - strength * z));
}

function sampleRow(row, base, gw, x) {
  if (x <= 0) return row[base];
  if (x >= gw - 1) return row[base + gw - 1];
  const i = x | 0;
  const f = x - i;
  return row[base + i] * (1 - f) + row[base + i + 1] * f;
}

/**
 * Compute the phase field.
 * @param {Float32Array} depth gw*gh normalized depth (0 = background plane)
 * @param {object} opts { eye, strength, crossEyed, damping }
 * @param {Float32Array} out gw*gh phase output
 * @returns {{ sBg: number, x0: number }}
 */
export function computePhase(depth, gw, gh, opts, out) {
  const sep = makeSeparation(opts.eye, opts.strength, opts.crossEyed);
  const damping = opts.damping || 0;
  const sBg = sep(0);
  // Anchor the pattern at the middle of the screen and propagate outwards, so
  // distortions ("echoes") spread symmetrically instead of piling up on the right.
  const x0 = Math.max(0, Math.min(gw - 1, Math.floor(gw / 2 - sBg / 2)));

  for (let y = 0; y < gh; y++) {
    const base = y * gw;

    // Rightward pass: u(x) = u(x - s) + 1, where s depends on depth at the center x - s/2.
    for (let x = x0; x < gw; x++) {
      let s = sep(depth[base + x]);
      for (let k = 0; k < 3; k++) s = sep(sampleRow(depth, base, gw, x - s / 2));
      const l = x - s;
      const canon = (x - x0) / sBg;
      if (l >= x0) {
        let v = sampleRow(out, base, gw, l) + 1;
        if (damping > 0 && sampleRow(depth, base, gw, x - s / 2) < 0.002) v += damping * (canon - v);
        out[base + x] = v;
      } else {
        out[base + x] = canon;
      }
    }

    // Leftward pass: u(x) = u(x + s) - 1, center at x + s/2.
    for (let x = x0 - 1; x >= 0; x--) {
      let s = sep(depth[base + x]);
      for (let k = 0; k < 3; k++) s = sep(sampleRow(depth, base, gw, x + s / 2));
      const r = x + s;
      const canon = (x - x0) / sBg;
      if (r <= gw - 1) {
        let v = sampleRow(out, base, gw, r) - 1;
        if (damping > 0 && sampleRow(depth, base, gw, x + s / 2) < 0.002) v += damping * (canon - v);
        out[base + x] = v;
      } else {
        out[base + x] = canon;
      }
    }
  }
  return { sBg, x0 };
}

/**
 * Mark cells whose phase jumps horizontally (depth discontinuities). Contours are
 * suppressed there so silhouettes don't show up as drawn outlines.
 */
const VERTICAL_CLIFF = 0.1;

export function phaseJumpMask(u, gw, gh, sMin, sMax, mask) {
  // Only true cliffs are cut; smoothed edges are left to compress the lines,
  // which hides the silhouette far better than a gap does.
  const hi = Math.max(6 / sMin, 0.3);
  const lo = -Math.max(1.5 / sMax, 0.06);
  for (let y = 0; y < gh - 1; y++) {
    const r0 = y * gw;
    const r1 = r0 + gw;
    const m = y * (gw - 1);
    for (let x = 0; x < gw - 1; x++) {
      const d0 = u[r0 + x + 1] - u[r0 + x];
      const d1 = u[r1 + x + 1] - u[r1 + x];
      // Vertical cliffs (top/bottom silhouettes) would otherwise stack contours into straight rules.
      const dv = Math.max(Math.abs(u[r1 + x] - u[r0 + x]), Math.abs(u[r1 + x + 1] - u[r0 + x + 1]));
      mask[m + x] = d0 > hi || d0 < lo || d1 > hi || d1 < lo || dv > VERTICAL_CLIFF ? 1 : 0;
    }
  }
}

/** Separable box blur applied twice (approximately Gaussian), in place. */
export function smoothDepth(depth, gw, gh, radius, tmp) {
  if (radius <= 0) return;
  for (let pass = 0; pass < 2; pass++) {
    blurRows(depth, tmp, gw, gh, radius);
    blurCols(tmp, depth, gw, gh, radius);
  }
}

function blurRows(src, dst, gw, gh, r) {
  for (let y = 0; y < gh; y++) {
    const b = y * gw;
    let acc = 0;
    for (let k = -r; k <= r; k++) acc += src[b + Math.min(gw - 1, Math.max(0, k))];
    for (let x = 0; x < gw; x++) {
      dst[b + x] = acc / (2 * r + 1);
      acc += src[b + Math.min(gw - 1, x + r + 1)] - src[b + Math.max(0, x - r)];
    }
  }
}

function blurCols(src, dst, gw, gh, r) {
  for (let x = 0; x < gw; x++) {
    let acc = 0;
    for (let k = -r; k <= r; k++) acc += src[Math.min(gh - 1, Math.max(0, k)) * gw + x];
    for (let y = 0; y < gh; y++) {
      dst[y * gw + x] = acc / (2 * r + 1);
      acc += src[Math.min(gh - 1, y + r + 1) * gw + x] - src[Math.max(0, y - r) * gw + x];
    }
  }
}
