// GPU line renderer. Canvas 2D strokes of ~200k segments are fast in Chrome
// (GPU raster) but stall Safari (CPU raster), so lines are drawn here as
// instanced quads with an antialiased capsule distance in the fragment shader.
//
// Each style is one color/width/opacity. To match a single canvas stroke (where
// overlapping pieces of one path never double up), a style's coverage is first
// accumulated with MAX blending into one channel of an offscreen texture; four
// styles share a texture, then a composite pass blends them over the frame in order.

const LINE_VS = `#version 300 es
layout(location = 0) in vec4 seg; // x1 y1 x2 y2 in grid units
uniform vec2 uScale;  // device px per grid unit
uniform vec2 uView;   // framebuffer size in px
uniform float uHalf;  // half line width in px
out vec2 vP;
flat out vec2 vA;
flat out vec2 vB;
void main() {
  vec2 a = seg.xy * uScale;
  vec2 b = seg.zw * uScale;
  vec2 d = b - a;
  float len = length(d);
  vec2 dir = len > 1e-4 ? d / len : vec2(1.0, 0.0);
  vec2 nrm = vec2(-dir.y, dir.x);
  float ext = uHalf + 1.0;
  float along = (gl_VertexID == 1 || gl_VertexID == 3) ? 1.0 : 0.0;
  float side = gl_VertexID >= 2 ? 1.0 : -1.0;
  vec2 p = mix(a - dir * ext, b + dir * ext, along) + nrm * ext * side;
  vP = p;
  vA = a;
  vB = b;
  vec2 clip = p / uView * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
}`;

const LINE_FS = `#version 300 es
precision highp float;
in vec2 vP;
flat in vec2 vA;
flat in vec2 vB;
uniform float uHalf;
uniform float uFade;
uniform vec4 uMask;
out vec4 outColor;
void main() {
  vec2 pa = vP - vA;
  vec2 ba = vB - vA;
  float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-6), 0.0, 1.0);
  float d = length(pa - ba * h);
  float cov = clamp(uHalf + 0.5 - d, 0.0, 1.0) * uFade;
  if (cov <= 0.0) discard;
  outColor = uMask * cov;
}`;

const COMP_VS = `#version 300 es
void main() {
  vec2 p = vec2(gl_VertexID == 1 ? 3.0 : -1.0, gl_VertexID == 2 ? 3.0 : -1.0);
  gl_Position = vec4(p, 0.0, 1.0);
}`;

const COMP_FS = `#version 300 es
precision highp float;
uniform sampler2D uCov;
uniform vec3 uColor[4];
uniform float uAlpha[4];
uniform int uCount;
uniform bool uAdditive;
out vec4 outColor;
void main() {
  vec4 cov = texelFetch(uCov, ivec2(gl_FragCoord.xy), 0);
  vec3 c = vec3(0.0);
  float a = 0.0;
  for (int k = 0; k < 4; k++) {
    if (k >= uCount) break;
    float s = cov[k] * uAlpha[k];
    if (uAdditive) {
      c += uColor[k] * s;
    } else {
      c = uColor[k] * s + c * (1.0 - s);
      a = s + a * (1.0 - s);
    }
  }
  outColor = uAdditive ? vec4(c, 1.0) : vec4(c, a);
}`;

const MASKS = [
  [1, 0, 0, 0],
  [0, 1, 0, 0],
  [0, 0, 1, 0],
  [0, 0, 0, 1],
];

function hexToRgb(hex) {
  const v = parseInt(hex.slice(1), 16);
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
}

export class GLLineRenderer {
  constructor(canvas) {
    const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: false });
    if (!gl) throw new Error('WebGL2 unavailable');
    this.gl = gl;
    this.canvas = canvas;
    this.line = this.program(LINE_VS, LINE_FS, ['uScale', 'uView', 'uHalf', 'uFade', 'uMask']);
    this.comp = this.program(COMP_VS, COMP_FS, ['uCov', 'uColor', 'uAlpha', 'uCount', 'uAdditive']);
    this.vbo = gl.createBuffer();
    this.vao = gl.createVertexArray();
    this.emptyVao = gl.createVertexArray();
    this.upload = new Float32Array(1 << 16);
    this.tex = gl.createTexture();
    this.fbo = gl.createFramebuffer();
    this.w = 0;
    this.h = 0;
  }

  program(vs, fs, uniforms) {
    const gl = this.gl;
    const compile = (type, src) => {
      const sh = gl.createShader(type);
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh));
      return sh;
    };
    const prog = gl.createProgram();
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, vs));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
    const loc = {};
    for (const u of uniforms) loc[u] = gl.getUniformLocation(prog, u);
    return { prog, loc };
  }

  resize(w, h) {
    if (w === this.w && h === this.h) return;
    const gl = this.gl;
    this.w = w;
    this.h = h;
    this.canvas.width = w;
    this.canvas.height = h;
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.tex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  /** Same params as drawStereogram; draws background and all line layers. */
  draw(p) {
    const gl = this.gl;
    const { engine, palette, dpr, cellW, cellH } = p;
    const glow = palette.additive ? p.glow : 0;

    // Draw list in canvas order: per style, its glow first, then the line itself.
    const items = [];
    const chunks = [];
    let total = 0;
    for (const layer of engine.layers) {
      if (layer.glyph) continue;
      layer.styles.forEach((style, k) => {
        const buf = layer.buffers[k];
        if (!buf.length) return;
        const color = hexToRgb(palette.colors[style.color % palette.colors.length]);
        const width = p.lineWidth * style.width * dpr;
        const offset = total;
        total += buf.length;
        chunks.push(buf, offset);
        if (glow > 0) items.push({ buf, offset, color, width: width * 4.5, alpha: 0.16 * glow * style.alpha });
        items.push({ buf, offset, color, width, alpha: style.alpha });
      });
    }
    if (this.upload.length < total) this.upload = new Float32Array(Math.ceil(total * 1.5));
    for (let c = 0; c < chunks.length; c += 2) this.upload.set(chunks[c].data.subarray(0, chunks[c].length), chunks[c + 1]);

    const bg = hexToRgb(palette.bg);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.w, this.h);
    gl.disable(gl.BLEND);
    gl.clearColor(bg[0], bg[1], bg[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (!items.length) return;

    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, this.upload.subarray(0, total), gl.STREAM_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribDivisor(0, 1);
    gl.enable(gl.BLEND);

    for (let start = 0; start < items.length; start += 4) {
      const batch = items.slice(start, start + 4);

      // 1) Coverage of up to four styles, one per channel, unioned with MAX.
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.useProgram(this.line.prog);
      gl.uniform2f(this.line.loc.uScale, dpr * cellW, dpr * cellH);
      gl.uniform2f(this.line.loc.uView, this.w, this.h);
      gl.blendEquation(gl.MAX);
      gl.blendFunc(gl.ONE, gl.ONE);
      batch.forEach((it, c) => {
        gl.uniform1f(this.line.loc.uHalf, Math.max(1, it.width) / 2);
        gl.uniform1f(this.line.loc.uFade, Math.min(1, it.width));
        gl.uniform4fv(this.line.loc.uMask, MASKS[c]);
        gl.vertexAttribPointer(0, 4, gl.FLOAT, false, 16, it.offset * 4);
        gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, it.buf.length / 4);
      });

      // 2) Blend those styles over the frame.
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.bindVertexArray(this.emptyVao);
      gl.useProgram(this.comp.prog);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.tex);
      gl.uniform1i(this.comp.loc.uCov, 0);
      const colors = new Float32Array(12);
      const alphas = new Float32Array(4);
      batch.forEach((it, c) => {
        colors.set(it.color, c * 3);
        alphas[c] = it.alpha;
      });
      gl.uniform3fv(this.comp.loc.uColor, colors);
      gl.uniform1fv(this.comp.loc.uAlpha, alphas);
      gl.uniform1i(this.comp.loc.uCount, batch.length);
      gl.uniform1i(this.comp.loc.uAdditive, palette.additive ? 1 : 0);
      gl.blendEquation(gl.FUNC_ADD);
      if (palette.additive) gl.blendFunc(gl.ONE, gl.ONE);
      else gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.bindVertexArray(this.vao);
    }
    gl.disable(gl.BLEND);
    gl.bindVertexArray(null);
  }
}
