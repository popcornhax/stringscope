// Marching squares over a scalar grid, extracting every integer level set as
// line segments. Segments go into per-style buffers so each style can be
// stroked in one path.

export class SegmentBuffer {
  constructor() {
    this.data = new Float32Array(4096);
    this.length = 0;
  }
  clear() {
    this.length = 0;
  }
  push(x1, y1, x2, y2) {
    if (this.length + 4 > this.data.length) {
      const next = new Float32Array(this.data.length * 2);
      next.set(this.data);
      this.data = next;
    }
    const d = this.data;
    const n = this.length;
    d[n] = x1;
    d[n + 1] = y1;
    d[n + 2] = x2;
    d[n + 3] = y2;
    this.length = n + 4;
  }
  get segments() {
    return this.length / 4;
  }
}

/**
 * Line ends that stop at a skipped cell (a depth cliff or contour pile-up):
 * the places where a string is broken. Stored flat as
 * [x, y, dirX, dirY, level, bucket] with the direction pointing out of the line.
 */
export class EndList {
  constructor() {
    this.data = new Float64Array(6 * 1024);
    this.count = 0;
  }
  clear() {
    this.count = 0;
  }
  push(x, y, dx, dy, level, bucket) {
    if ((this.count + 1) * 6 > this.data.length) {
      const next = new Float64Array(this.data.length * 2);
      next.set(this.data);
      this.data = next;
    }
    const len = Math.hypot(dx, dy) || 1;
    const o = this.count * 6;
    const d = this.data;
    d[o] = x;
    d[o + 1] = y;
    d[o + 2] = dx / len;
    d[o + 3] = dy / len;
    d[o + 4] = level;
    d[o + 5] = bucket;
    this.count++;
  }
}

const MAX_LEVELS_PER_CELL = 6;

// Edge codes: top, right, bottom, left.
const T = 0;
const R = 1;
const B = 2;
const L = 3;

let cellSkip = new Uint8Array(0);

// Records the line ends of one segment that stop at a skipped neighbour cell.
function markEnds(ends, n, bucket, e1, x1, y1, e2, x2, y2, nT, nR, nB, nL) {
  const b1 = e1 === T ? nT : e1 === R ? nR : e1 === B ? nB : nL;
  const b2 = e2 === T ? nT : e2 === R ? nR : e2 === B ? nB : nL;
  if (b1) ends.push(x1, y1, x1 - x2, y1 - y2, n, bucket);
  if (b2) ends.push(x2, y2, x2 - x1, y2 - y1, n, bucket);
}

/**
 * @param {Float32Array} F field values, gw*gh
 * @param {Uint8Array|null} skip (gw-1)*(gh-1) cells to ignore
 * @param {(n:number)=>number} styleOf level index -> buffer index
 * @param {SegmentBuffer[]} buffers
 * @param {EndList} [ends] receives line ends that stop at a skipped cell
 */
export function extractContours(F, gw, gh, skip, styleOf, buffers, ends) {
  const cw = gw - 1;
  const cells = cw * (gh - 1);
  if (cellSkip.length < cells) cellSkip = new Uint8Array(cells);

  // Pass 1: decide which cells are skipped, so pass 2 can tell when a line runs into one.
  for (let j = 0; j < gh - 1; j++) {
    const r0 = j * gw;
    const r1 = r0 + gw;
    const cj = j * cw;
    for (let i = 0; i < cw; i++) {
      if (skip && skip[cj + i]) {
        cellSkip[cj + i] = 1;
        continue;
      }
      const a = F[r0 + i];
      const b = F[r0 + i + 1];
      const c = F[r1 + i + 1];
      const d = F[r1 + i];
      let mn = a < b ? a : b;
      let mx = a < b ? b : a;
      if (c < mn) mn = c;
      if (c > mx) mx = c;
      if (d < mn) mn = d;
      if (d > mx) mx = d;
      // NaN fails every comparison below, so it also lands in the skipped branch.
      cellSkip[cj + i] = Math.floor(mx) - Math.ceil(mn) < MAX_LEVELS_PER_CELL ? 0 : 1;
    }
  }

  for (let j = 0; j < gh - 1; j++) {
    const r0 = j * gw;
    const r1 = r0 + gw;
    const cj = j * cw;
    for (let i = 0; i < cw; i++) {
      const ci = cj + i;
      if (cellSkip[ci]) continue;
      const a = F[r0 + i];
      const b = F[r0 + i + 1];
      const c = F[r1 + i + 1];
      const d = F[r1 + i];
      let mn = a < b ? a : b;
      let mx = a < b ? b : a;
      if (c < mn) mn = c;
      if (c > mx) mx = c;
      if (d < mn) mn = d;
      if (d > mx) mx = d;
      const lo = Math.ceil(mn);
      const hi = Math.floor(mx);
      if (hi < lo) continue;
      // Skipped neighbours across each edge: lines ending there are broken strings.
      let nT = 0;
      let nR = 0;
      let nB = 0;
      let nL = 0;
      if (ends) {
        nT = j > 0 ? cellSkip[ci - cw] : 0;
        nB = j < gh - 2 ? cellSkip[ci + cw] : 0;
        nL = i > 0 ? cellSkip[ci - 1] : 0;
        nR = i < cw - 1 ? cellSkip[ci + 1] : 0;
      }
      const broken = nT | nR | nB | nL;

      for (let n = lo; n <= hi; n++) {
        const idx = (a >= n ? 8 : 0) | (b >= n ? 4 : 0) | (c >= n ? 2 : 0) | (d >= n ? 1 : 0);
        if (idx === 0 || idx === 15) continue;
        const bucket = styleOf(n);
        const buf = buffers[bucket];
        // Edge crossing points (grid coordinates).
        const tx = i + (n - a) / (b - a); // top, y = j
        const ry = j + (n - b) / (c - b); // right, x = i+1
        const bx = i + (n - d) / (c - d); // bottom, y = j+1
        const ly = j + (n - a) / (d - a); // left, x = i
        switch (idx) {
          case 1:
          case 14:
            buf.push(i, ly, bx, j + 1);
            if (broken) markEnds(ends, n, bucket, L, i, ly, B, bx, j + 1, nT, nR, nB, nL);
            break;
          case 2:
          case 13:
            buf.push(bx, j + 1, i + 1, ry);
            if (broken) markEnds(ends, n, bucket, B, bx, j + 1, R, i + 1, ry, nT, nR, nB, nL);
            break;
          case 3:
          case 12:
            buf.push(i, ly, i + 1, ry);
            if (broken) markEnds(ends, n, bucket, L, i, ly, R, i + 1, ry, nT, nR, nB, nL);
            break;
          case 4:
          case 11:
            buf.push(tx, j, i + 1, ry);
            if (broken) markEnds(ends, n, bucket, T, tx, j, R, i + 1, ry, nT, nR, nB, nL);
            break;
          case 6:
          case 9:
            buf.push(tx, j, bx, j + 1);
            if (broken) markEnds(ends, n, bucket, T, tx, j, B, bx, j + 1, nT, nR, nB, nL);
            break;
          case 7:
          case 8:
            buf.push(i, ly, tx, j);
            if (broken) markEnds(ends, n, bucket, L, i, ly, T, tx, j, nT, nR, nB, nL);
            break;
          default: {
            // Saddle (5, 10): separate the two corners on the minority side of the center.
            const centerAbove = (a + b + c + d) / 4 >= n;
            if ((idx === 5) === centerAbove) {
              buf.push(i, ly, tx, j);
              buf.push(bx, j + 1, i + 1, ry);
              if (broken) {
                markEnds(ends, n, bucket, L, i, ly, T, tx, j, nT, nR, nB, nL);
                markEnds(ends, n, bucket, B, bx, j + 1, R, i + 1, ry, nT, nR, nB, nL);
              }
            } else {
              buf.push(tx, j, i + 1, ry);
              buf.push(i, ly, bx, j + 1);
              if (broken) {
                markEnds(ends, n, bucket, T, tx, j, R, i + 1, ry, nT, nR, nB, nL);
                markEnds(ends, n, bucket, L, i, ly, B, bx, j + 1, nT, nR, nB, nL);
              }
            }
          }
        }
      }
    }
  }
}
