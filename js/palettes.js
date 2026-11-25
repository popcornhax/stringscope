// Color schemes. `additive` palettes glow on dark backgrounds; the paper ones use normal blending.

export const PALETTES = {
  ballpoint: {
    label: 'Ballpoint',
    bg: '#fbfbf8',
    additive: false,
    colors: ['#1b2080', '#262c96', '#141866', '#2f37a8', '#1d2270'],
  },
  aurora: {
    label: 'Aurora',
    bg: '#05060f',
    additive: true,
    colors: ['#7cf7d4', '#4cc9f0', '#a78bfa', '#f472b6', '#facc15', '#34d399', '#60a5fa', '#fb7185'],
  },
  vapor: {
    label: 'Vaporwave',
    bg: '#10001c',
    additive: true,
    colors: ['#ff71ce', '#01cdfe', '#05ffa1', '#b967ff', '#fffb96', '#ff9de2'],
  },
  ember: {
    label: 'Ember',
    bg: '#0b0503',
    additive: true,
    colors: ['#ff7a18', '#ffb347', '#ff4e50', '#f9d423', '#fc913a', '#ff6f91'],
  },
  ocean: {
    label: 'Deep Ocean',
    bg: '#021526',
    additive: true,
    colors: ['#03e9f4', '#0ea5e9', '#22d3ee', '#a5f3fc', '#38bdf8', '#818cf8'],
  },
  gold: {
    label: 'Gilded',
    bg: '#0a0908',
    additive: true,
    colors: ['#f5d28a', '#d4a64a', '#fff1c1', '#b8860b', '#e9c46a'],
  },
  blueprint: {
    label: 'Blueprint',
    bg: '#0b2a4a',
    additive: false,
    colors: ['#e0f2fe', '#bae6fd', '#7dd3fc', '#ffffff', '#93c5fd'],
  },
  ink: {
    label: 'Ink on Paper',
    bg: '#f3ede2',
    additive: false,
    colors: ['#1f2937', '#9a3412', '#0f766e', '#1e3a8a', '#4b5563', '#7c2d12'],
  },
  riso: {
    label: 'Risograph',
    bg: '#fbf6ee',
    additive: false,
    colors: ['#ff48b0', '#0078bf', '#ffe800', '#00a95c', '#f15060'],
  },
  spectrum: {
    label: 'Spectrum',
    bg: '#07070b',
    additive: true,
    colors: ['#ff4d4d', '#ff9f43', '#feca57', '#7bed9f', '#2ed573', '#1dd1a1', '#48dbfb', '#54a0ff', '#5f27cd', '#c56cf0'],
  },
  matrix: {
    label: 'Matrix',
    bg: '#000a03',
    additive: true,
    colors: ['#e6ffee', '#22ff77', '#0b8f3a', '#18c95a', '#5dff9d'],
  },
  noir: {
    label: 'Neon Noir',
    bg: '#000000',
    additive: true,
    colors: ['#ff2a6d', '#05d9e8', '#ff2a6d', '#d1f7ff', '#05d9e8'],
  },
  mint: {
    label: 'Mint Paper',
    bg: '#e8f4ec',
    additive: false,
    colors: ['#0b3d2e', '#14684c', '#1f8a64', '#0b3d2e', '#c2410c'],
  },
  sumi: {
    label: 'Sumi Ink',
    bg: '#f2ece0',
    additive: false,
    colors: ['#111111', '#2b2b2b', '#1a1a1a', '#b91c1c'],
  },
};
