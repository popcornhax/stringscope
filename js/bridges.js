// Reconnects strings broken at depth cliffs. Every broken end knows which
// contour (level) it belongs to and which way it was heading, so ends of the
// same string facing each other across a small gap are joined with a smooth
// cubic curve that leaves and arrives along each end's direction.

const LEVEL_OFFSET = 1 << 19;

/**
 * @param {import('./contours.js').EndList} ends
 * @param {import('./contours.js').SegmentBuffer[]} buffers per-style buffers the bridges are added to
 * @param {number} maxGap largest gap to close, in grid cells
 * @returns {number} number of bridges drawn
 */
export function bridgeEnds(ends, buffers, maxGap) {
  if (maxGap <= 0 || ends.count < 2) return 0;
  const d = ends.data;
  const groups = new Map();
  for (let i = 0; i < ends.count; i++) {
    const key = d[i * 6 + 5] * 2 * LEVEL_OFFSET + d[i * 6 + 4] + LEVEL_OFFSET;
    const g = groups.get(key);
    if (g) g.push(i);
    else groups.set(key, [i]);
  }

  // Candidate pairs: same string, within reach, both ends pointing roughly at each other.
  const pairs = [];
  for (const g of groups.values()) {
    for (let p = 0; p < g.length; p++) {
      const a = g[p] * 6;
      for (let q = p + 1; q < g.length; q++) {
        const b = g[q] * 6;
        const dx = d[b] - d[a];
        const dy = d[b + 1] - d[a + 1];
        const dist = Math.hypot(dx, dy);
        if (dist > maxGap || dist < 1e-6) continue;
        const alignA = (d[a + 2] * dx + d[a + 3] * dy) / dist;
        const alignB = -(d[b + 2] * dx + d[b + 3] * dy) / dist;
        if (alignA < 0.1 || alignB < 0.1) continue;
        pairs.push(dist * (3 - alignA - alignB), g[p], g[q]);
      }
    }
  }
  const order = [];
  for (let k = 0; k < pairs.length; k += 3) order.push(k);
  order.sort((x, y) => pairs[x] - pairs[y]);

  const used = new Uint8Array(ends.count);
  let made = 0;
  for (const k of order) {
    const ia = pairs[k + 1];
    const ib = pairs[k + 2];
    if (used[ia] || used[ib]) continue;
    used[ia] = used[ib] = 1;
    drawBridge(d, ia * 6, ib * 6, buffers[d[ia * 6 + 5]]);
    made++;
  }
  return made;
}

function drawBridge(d, a, b, buf) {
  const x0 = d[a];
  const y0 = d[a + 1];
  const x3 = d[b];
  const y3 = d[b + 1];
  const dist = Math.hypot(x3 - x0, y3 - y0);
  const reach = dist * 0.4;
  const x1 = x0 + d[a + 2] * reach;
  const y1 = y0 + d[a + 3] * reach;
  const x2 = x3 + d[b + 2] * reach;
  const y2 = y3 + d[b + 3] * reach;
  const steps = Math.max(3, Math.ceil(dist / 1.5));
  let px = x0;
  let py = y0;
  for (let s = 1; s <= steps; s++) {
    const t = s / steps;
    const u = 1 - t;
    const x = u * u * u * x0 + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x3;
    const y = u * u * u * y0 + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y3;
    buf.push(px, py, x, y);
    px = x;
    py = y;
  }
}
