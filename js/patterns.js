// Generative line patterns.
//
// Every pattern is a set of scalar fields F(u, v) whose integer level sets are
// drawn as lines. u is the stereogram phase (period 1 = one eye-separation) and
// v is the vertical coordinate measured in the same units. Each field must be
// periodic in u (F(u + 1, v) = F(u, v) + an integer multiple of the style count)
// so that the drawing repeats exactly once per separation, which is what makes
// the hidden 3D surface fuse.

import { mulberry32 } from './rng.js';

const TAU = Math.PI * 2;

// Random sinusoid terms a·sin(2π·ku·u + kv·v + p). ku is an integer to keep periodicity.
function terms(rng, specs) {
  return specs.map(([amp, ku, kvMax]) => ({
    a: amp * (0.45 + 0.55 * rng()),
    ku,
    kv: (rng() * 2 - 1) * kvMax,
    p: rng() * TAU,
  }));
}

// Scale the u-dependent terms so dF/du stays positive (lines never fold back).
function limitSlopeU(list, budget) {
  const slope = list.reduce((s, t) => s + TAU * Math.abs(t.ku) * t.a, 0);
  if (slope > budget) for (const t of list) if (t.ku) t.a *= budget / slope;
  return list;
}

// Scale terms so dF/dv stays below a budget (horizontal families never fold).
function limitSlopeV(list, budget) {
  const slope = list.reduce((s, t) => s + Math.abs(t.kv) * t.a, 0);
  if (slope > budget) for (const t of list) t.a *= budget / slope;
  return list;
}

function sumSines(list, u, v) {
  let s = 0;
  for (let i = 0; i < list.length; i++) {
    const t = list[i];
    s += t.a * Math.sin(TAU * t.ku * u + t.kv * v + t.p);
  }
  return s;
}

// Per-line styling: palette slot, width multiplier and opacity.
function lineStyles(rng, count, colorOffset = 0, widthRange = [0.6, 1.7]) {
  const out = [];
  for (let k = 0; k < count; k++) {
    out.push({
      color: k + colorOffset,
      width: widthRange[0] + (widthRange[1] - widthRange[0]) * rng(),
      alpha: 0.7 + 0.3 * rng(),
    });
  }
  // Make sure each period has one bold "anchor" line: a strong feature helps the eyes lock on.
  out[Math.floor(rng() * count)].width = widthRange[1] * 1.25;
  return out;
}

const mod = (n, m) => ((n % m) + m) % m;

// Integer hash for per-glyph choices that must repeat identically every period.
function hash3(a, b, c) {
  let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 0x632be5ab, 0xc2b2ae35) ^ Math.imul(c ^ 0x27d4eb2f, 0x165667b1);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  return (h ^ (h >>> 15)) >>> 0;
}

const KATAKANA = 'ｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜﾝ0123456789Z:・."=*+<>|';
const TYPE_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789&%$#@?!*+=/';

// Glyph layers place characters instead of lines. Engine finds the screen x where
// N·u crosses each integer on every text row; the character chosen for (n mod N, row)
// is the same in every period, so the text itself carries the depth.
function glyphLayer(rng, density, mode) {
  const N = Math.max(4, Math.round(7 * density));
  const salt = Math.floor(rng() * 1e9);
  const rain = mode === 'rain';
  const charset = rain ? KATAKANA : TYPE_CHARS;
  const cols = Array.from({ length: N }, () => ({
    speed: 5 + rng() * 10,
    off: rng() * 200,
    trail: 8 + rng() * 18,
    flicker: 1.5 + rng() * 5,
  }));
  const pick = (k, r, c) => charset[hash3(k + salt, r, c) % charset.length];
  const glyph = {
    N,
    rowScale: rain ? 1.05 : 1.3,
    size: rain ? 0.95 : 0.92,
    font: rain
      ? '"Hiragino Kaku Gothic ProN", "Yu Gothic", "MS Gothic", ui-monospace, monospace'
      : '"Courier New", Courier, ui-monospace, monospace',
    weight: rain ? '600' : '700',
    animated: rain,
    charAt(k, r, t, rows) {
      if (rain) {
        const c = cols[k];
        const head = (t * c.speed + c.off) % (rows + c.trail);
        const d = head - r;
        const ch = pick(k, r, Math.floor(t * c.flicker + r * 0.37));
        if (d < 0 || d > c.trail) return { ch, alpha: 0.08, color: 2, rot: 0 };
        if (d < 1) return { ch, alpha: 1, color: 0, rot: 0 };
        return { ch, alpha: Math.pow(1 - d / c.trail, 1.2), color: 1, rot: 0 };
      }
      const h = hash3(k + salt, r, 7);
      return {
        ch: pick(k, r, 0),
        alpha: 0.5 + 0.5 * ((h & 0xffff) / 0xffff),
        color: (h >>> 16) % 3,
        rot: (((h >>> 8) & 0xff) / 255 - 0.5) * 0.16,
      };
    },
  };
  return { glyph, styles: [], styleOf: () => 0 };
}


function stringsLayer(rng, density, colorOffset = 0) {
  const M = Math.max(3, Math.round(7 * density));
  const wobble = limitSlopeU(
    terms(rng, [
      [M * 0.06, 1, 2.2],
      [M * 0.035, 2, 3.5],
      [M * 0.03, 3, 1.5],
    ]),
    0.6 * M
  );
  // u-independent sway moves every string together, giving long flowing curves.
  const sway = terms(rng, [
    [M * 0.32, 0, 1.4],
    [M * 0.07, 0, 4.0],
  ]);
  return {
    field: (u, v) => M * u + sumSines(wobble, u, v) + sumSines(sway, u, v),
    styleOf: (n) => mod(n, M),
    styles: lineStyles(rng, M, colorOffset),
  };
}

function horizontalLayer(rng, density, perPeriod, amp, colorOffset = 0) {
  const N = Math.max(2, Math.round(perPeriod * density));
  const waves = limitSlopeV(
    terms(rng, [
      [N * amp, 1, 0.8],
      [N * amp * 0.6, 2, 1.6],
      [N * amp * 0.3, 3, 2.5],
    ]),
    0.65 * N
  );
  const K = 4;
  return {
    field: (u, v) => N * v + sumSines(waves, u, v),
    styleOf: (n) => mod(n, K),
    styles: lineStyles(rng, K, colorOffset, [0.5, 1.3]),
  };
}

function hexDistance(a, b) {
  const h = Math.sqrt(3) / 2;
  let dx = a - Math.round(a);
  let dy = b - 2 * h * Math.round(b / (2 * h));
  const d1 = dx * dx + dy * dy;
  const a2 = a - 0.5;
  const b2 = b - h;
  dx = a2 - Math.round(a2);
  dy = b2 - 2 * h * Math.round(b2 / (2 * h));
  const d2 = dx * dx + dy * dy;
  return Math.sqrt(Math.min(d1, d2));
}

// Dense tangled pen strokes: several independent families of noise contours
// overlap so lines cross like ballpoint scribbles. A shared low-frequency
// "darkness" field scales every family, so ink density forms soft patches.
function scribbleLayers(rng, density) {
  // Blob-sized patches (roughly a third of a repeat across) rather than long stripes.
  const shade = terms(rng, [
    [1.0, 1, 8],
    [0.8, 2, 11],
    [0.6, 0, 9],
    [0.5, 3, 15],
  ]);
  const shadeNorm = shade.reduce((s, t) => s + t.a, 0);
  const step = 0.32 / density;
  const layers = [];
  for (let l = 0; l < 4; l++) {
    const list = [];
    for (let k = 0; k < 7; k++) {
      const ku = 1 + Math.floor(rng() * 6);
      list.push({ a: (0.4 + rng()) / (1 + 0.25 * ku), ku, kv: (rng() * 2 - 1) * 28, p: rng() * TAU });
    }
    const norm = list.reduce((s, t) => s + t.a, 0);
    const wu = { ku: 2 + Math.floor(rng() * 3), kv: (rng() * 2 - 1) * 22, p: rng() * TAU };
    const wv = { ku: 1 + Math.floor(rng() * 3), kv: (rng() * 2 - 1) * 22, p: rng() * TAU };
    layers.push({
      field: (u, v) => {
        const uw = u + 0.03 * Math.sin(TAU * wu.ku * u + wu.kv * v + wu.p);
        const vw = v + 0.04 * Math.sin(TAU * wv.ku * u + wv.kv * v + wv.p);
        const d = 0.5 + (0.5 * sumSines(shade, u, v)) / shadeNorm;
        return ((sumSines(list, uw, vw) / norm) * (0.12 + 2.2 * d * d * d)) / step;
      },
      styleOf: (n) => mod(n, 3),
      styles: lineStyles(rng, 3, l, [0.55, 1.1]),
    });
  }
  return layers;
}

export const PATTERNS = {
  scribble: {
    label: 'Scribble (ballpoint)',
    build: scribbleLayers,
  },

  strings: {
    label: 'Strings',
    build(rng, density) {
      return [stringsLayer(rng, density)];
    },
  },

  weave: {
    label: 'Weave',
    build(rng, density) {
      return [stringsLayer(rng, density * 0.75), horizontalLayer(rng, density, 2.5, 0.18, 3)];
    },
  },

  topo: {
    label: 'Topographic',
    build(rng, density) {
      const list = terms(rng, [
        [1.0, 1, 1.6],
        [0.8, 1, 2.4],
        [0.6, 2, 1.8],
        [0.45, 2, 3.0],
        [0.3, 3, 2.2],
        [0.5, 0, 2.0],
      ]);
      const norm = list.reduce((s, t) => s + t.a, 0);
      const warp = { a: 0.12, kv: 1.2 + rng(), p: rng() * TAU };
      const step = 0.1 / density;
      const K = 6;
      return [
        {
          field: (u, v) => {
            const uw = u + warp.a * Math.sin(TAU * u + warp.kv * v + warp.p);
            return sumSines(list, uw, v) / norm / step;
          },
          styleOf: (n) => mod(n, K),
          styles: lineStyles(rng, K, 0, [0.5, 1.5]),
        },
      ];
    },
  },

  rings: {
    label: 'Rings',
    build(rng, density) {
      const K = Math.max(1, Math.round(2 * density));
      const step = 0.085;
      const warp = terms(rng, [
        [0.05, 1, 1.5],
        [0.03, 0, 2.5],
      ]);
      const S = 5;
      return [
        {
          field: (u, v) => hexDistance(K * u + sumSines(warp, u, v), K * v * 1.0) / step,
          styleOf: (n) => mod(n, S),
          styles: lineStyles(rng, S, 0, [0.5, 1.4]),
        },
      ];
    },
  },

  lattice: {
    label: 'Lattice',
    build(rng, density) {
      const M = Math.max(2, Math.round(4 * density));
      const N = M * (0.6 + 0.5 * rng());
      const w1 = limitSlopeU(terms(rng, [[M * 0.05, 1, 1.5], [M * 0.25, 0, 0.8]]), 0.5 * M);
      const w2 = limitSlopeU(terms(rng, [[M * 0.05, 1, 1.5], [M * 0.25, 0, 0.8]]), 0.5 * M);
      return [
        {
          field: (u, v) => M * u + N * v + sumSines(w1, u, v),
          styleOf: (n) => mod(n, M),
          styles: lineStyles(rng, M, 0, [0.5, 1.4]),
        },
        {
          field: (u, v) => M * u - N * v + sumSines(w2, u, v),
          styleOf: (n) => mod(n, M),
          styles: lineStyles(rng, M, 2, [0.5, 1.4]),
        },
      ];
    },
  },

  ripples: {
    label: 'Ripples',
    build(rng, density) {
      return [horizontalLayer(rng, density, 5, 0.32, 0)];
    },
  },
  guilloche: {
    label: 'Guilloché (banknote)',
    build(rng, density) {
      // Three phase-shifted families of tall sine waves braid into rosette bands,
      // like the engraving on banknotes and certificates.
      const N = Math.max(3, Math.round(5 * density));
      const ku = 1 + Math.floor(rng() * 2);
      const A = N * (0.28 + 0.1 * rng());
      const mod1 = { kv: 0.6 + rng() * 0.8, p: rng() * TAU };
      const mod2 = { kv: 1.5 + rng() * 2, p: rng() * TAU };
      return [0, 1, 2].map((l) => {
        const ph = (l * TAU) / 3;
        return {
          field: (u, v) =>
            N * v +
            A * (0.75 + 0.25 * Math.sin(mod1.kv * v + mod1.p)) * Math.sin(TAU * ku * u + ph + 0.8 * Math.sin(mod2.kv * v + mod2.p)),
          styleOf: (n) => mod(n, 2),
          styles: lineStyles(rng, 2, l * 2, [0.6, 1.2]),
        };
      });
    },
  },

  morse: {
    label: 'Morse (dashed strings)',
    build(rng, density) {
      const layer = stringsLayer(rng, density * 1.1);
      const D = 1.6 + rng() * 1.2; // dashes per period of height
      const phase = terms(rng, [
        [3.5, 1, 0],
        [2.5, 2, 0],
        [1.5, 3, 1],
      ]);
      const p2 = rng() * TAU;
      // Keep a line where the gate is positive: mixed dots and dashes along each string.
      layer.gate = (u, v) => Math.sin(TAU * D * v + sumSines(phase, u, v)) + 0.45 * Math.sin(TAU * D * 2.7 * v + p2) + 0.15;
      return [layer];
    },
  },

  rain: {
    label: 'Matrix Rain (glyphs)',
    build(rng, density) {
      return [glyphLayer(rng, density, 'rain')];
    },
  },

  typewriter: {
    label: 'Typewriter (glyphs)',
    build(rng, density) {
      return [glyphLayer(rng, density, 'type')];
    },
  },
};

/** Build the layers for a pattern id with a seed. */
export function buildPattern(id, seed, density) {
  const def = PATTERNS[id] || PATTERNS.strings;
  return def.build(mulberry32(seed), density);
}
