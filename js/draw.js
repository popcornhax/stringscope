// Vector drawing of the engine's output (line segments and glyphs): live to a 2D
// canvas, or exported as SVG with one Inkscape layer per pen color for plotters.

const REVEAL_COLOR = '#ff3b6b';

function styleColor(palette, style) {
  return palette.colors[style.color % palette.colors.length];
}

function tracePath(ctx, buf) {
  const d = buf.data;
  let px = NaN;
  let py = NaN;
  for (let k = 0; k < buf.length; k += 4) {
    // Contour segments from neighbouring cells often share an endpoint: continue the subpath.
    if (d[k] !== px || d[k + 1] !== py) ctx.moveTo(d[k], d[k + 1]);
    ctx.lineTo(d[k + 2], d[k + 3]);
    px = d[k + 2];
    py = d[k + 3];
  }
}

function glyphFont(layer, cellW) {
  const g = layer.glyph;
  const px = Math.max(6, g.spacing * cellW * g.size);
  return { px, font: `${g.weight} ${px.toFixed(1)}px ${g.font}` };
}

// Calls fn(ch, x, y, alpha, color, rot) for every visible glyph, in CSS pixels.
function forEachGlyph(layer, p, fn) {
  const g = layer.glyph;
  for (let i = 0; i < layer.glyphCount; i++) {
    const info = g.charAt(layer.gk[i], layer.gr[i], p.time || 0, g.rows);
    if (info.alpha < 0.02) continue;
    const color = p.palette.colors[info.color % p.palette.colors.length];
    fn(info.ch, layer.gx[i] * p.cellW, layer.gy[i] * p.cellH, info.alpha, color, info.rot);
  }
}

/**
 * @param {CanvasRenderingContext2D} ctx
 * @param {object} p { engine, palette, cssW, cssH, dpr, cellW, cellH, lineWidth, glow, guides, time,
 *   overlayOnly (lines and background are drawn by the GPU renderer underneath) }
 */
export function drawStereogram(ctx, p) {
  const { engine, palette, dpr, cellW, cellH } = p;
  const W = ctx.canvas.width;
  const H = ctx.canvas.height;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
  if (p.overlayOnly) {
    ctx.clearRect(0, 0, W, H);
  } else {
    ctx.fillStyle = palette.bg;
    ctx.fillRect(0, 0, W, H);
  }

  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.globalCompositeOperation = palette.additive ? 'lighter' : 'source-over';
  const unit = 1 / cellW; // one CSS pixel in grid units
  const glow = palette.additive ? p.glow : 0; // halos only read as glow on dark, additive palettes

  for (const layer of engine.layers) {
    if (layer.glyph) {
      drawGlyphs(ctx, p, layer, glow);
      continue;
    }
    if (p.overlayOnly) continue;
    // Work in grid coordinates; cells are (almost) square, so line widths stay uniform.
    ctx.setTransform(dpr * cellW, 0, 0, dpr * cellH, 0, 0);
    layer.styles.forEach((style, k) => {
      const buf = layer.buffers[k];
      if (!buf.length) return;
      ctx.beginPath();
      tracePath(ctx, buf);
      ctx.strokeStyle = styleColor(palette, style);
      const w = p.lineWidth * style.width * unit;
      if (glow > 0) {
        ctx.globalAlpha = 0.16 * glow * style.alpha;
        ctx.lineWidth = w * 4.5;
        ctx.stroke();
      }
      ctx.globalAlpha = style.alpha;
      ctx.lineWidth = w;
      ctx.stroke();
    });
  }

  ctx.setTransform(dpr * cellW, 0, 0, dpr * cellH, 0, 0);
  if (engine.reveal.length) {
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 0.75;
    ctx.strokeStyle = REVEAL_COLOR;
    ctx.lineWidth = 1.4 * unit;
    ctx.beginPath();
    tracePath(ctx, engine.reveal);
    ctx.stroke();
  }
  if (p.guides) drawGuides(ctx, p, unit);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
}

function drawGlyphs(ctx, p, layer, glow) {
  const { dpr } = p;
  const { font } = glyphFont(layer, p.cellW);
  ctx.font = font;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.shadowBlur = 0;
  forEachGlyph(layer, p, (ch, x, y, alpha, color, rot) => {
    const c = Math.cos(rot) * dpr;
    const s = Math.sin(rot) * dpr;
    ctx.setTransform(c, s, -s, c, x * dpr, y * dpr);
    ctx.fillStyle = color;
    if (glow > 0 && alpha > 0.5) {
      ctx.globalAlpha = 0.25 * glow * alpha;
      ctx.fillText(ch, 0, 0);
      ctx.strokeStyle = color;
      ctx.lineWidth = 2.5;
      ctx.strokeText(ch, 0, 0);
    }
    ctx.globalAlpha = alpha;
    ctx.fillText(ch, 0, 0);
  });
}

function drawGuides(ctx, p, unit) {
  const { engine, palette } = p;
  const cx = (engine.gw - 1) / 2;
  const half = engine.sBg / 2;
  const y = 22 * unit;
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 0.9;
  ctx.fillStyle = palette.colors[0];
  for (const x of [cx - half, cx + half]) {
    ctx.beginPath();
    ctx.arc(x, y, 5 * unit, 0, Math.PI * 2);
    ctx.fill();
  }
}

const escapeXML = (s) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * Serialize the current frame as a standalone SVG document. Strokes are grouped
 * into one Inkscape layer per color, so pen plotters can swap pens per layer.
 */
export function exportSVG(p) {
  const { engine, palette, cssW, cssH, cellW, cellH } = p;
  const f = (x) => Math.round(x * 100) / 100;
  const pens = new Map(); // color -> path elements
  const glowPaths = [];
  const addPen = (color, el) => {
    if (!pens.has(color)) pens.set(color, []);
    pens.get(color).push(el);
  };

  for (const layer of engine.layers) {
    if (layer.glyph) {
      const { px } = glyphFont(layer, cellW);
      const g = layer.glyph;
      forEachGlyph(layer, p, (ch, x, y, alpha, color, rot) => {
        const transform = rot ? ` transform="rotate(${f((rot * 180) / Math.PI)} ${f(x)} ${f(y)})"` : '';
        addPen(
          color,
          `<text x="${f(x)}" y="${f(y)}" font-size="${f(px)}" font-weight="${g.weight}" fill="${color}" fill-opacity="${f(alpha)}"${transform}>${escapeXML(ch)}</text>`
        );
      });
      continue;
    }
    layer.styles.forEach((style, k) => {
      const buf = layer.buffers[k];
      if (!buf.length) return;
      const d = buf.data;
      let path = '';
      let px = NaN;
      let py = NaN;
      for (let i = 0; i < buf.length; i += 4) {
        if (d[i] !== px || d[i + 1] !== py) path += `M${f(d[i] * cellW)} ${f(d[i + 1] * cellH)}`;
        path += `L${f(d[i + 2] * cellW)} ${f(d[i + 3] * cellH)}`;
        px = d[i + 2];
        py = d[i + 3];
      }
      const color = styleColor(palette, style);
      const w = p.lineWidth * style.width;
      if (palette.additive && p.glow > 0) {
        glowPaths.push(`<path d="${path}" stroke="${color}" stroke-width="${f(w * 4.5)}" stroke-opacity="${f(0.16 * p.glow * style.alpha)}"/>`);
      }
      addPen(color, `<path d="${path}" stroke="${color}" stroke-width="${f(w)}" stroke-opacity="${f(style.alpha)}"/>`);
    });
  }

  const glyphFamily = engine.layers.find((l) => l.glyph)?.glyph.font.replace(/"/g, "'");
  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" width="${cssW}" height="${cssH}" viewBox="0 0 ${cssW} ${cssH}">`,
    `<rect width="100%" height="100%" fill="${palette.bg}"/>`,
    `<g fill="none" stroke-linecap="round" stroke-linejoin="round" text-anchor="middle" dominant-baseline="middle"${
      glyphFamily ? ` font-family="${glyphFamily}"` : ''
    }${palette.additive ? ' style="mix-blend-mode:screen"' : ''}>`,
  ];
  if (glowPaths.length) parts.push(`<g inkscape:groupmode="layer" inkscape:label="glow (screen only)">`, ...glowPaths, '</g>');
  let pen = 1;
  for (const [color, els] of pens) {
    parts.push(`<g inkscape:groupmode="layer" inkscape:label="pen ${pen++} ${color}">`, ...els, '</g>');
  }
  parts.push('</g>');
  if (p.guides) {
    const cx = ((engine.gw - 1) / 2) * cellW;
    const half = (engine.sBg / 2) * cellW;
    parts.push(
      `<g inkscape:groupmode="layer" inkscape:label="guide dots">`,
      `<circle cx="${f(cx - half)}" cy="22" r="5" fill="${palette.colors[0]}"/>`,
      `<circle cx="${f(cx + half)}" cy="22" r="5" fill="${palette.colors[0]}"/>`,
      '</g>'
    );
  }
  parts.push('</svg>');
  return parts.join('\n');
}
