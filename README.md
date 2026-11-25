# StringScope

Generative **line-art autostereograms** (Magic Eye style) from live 3D models, in the browser.

**Try it:** [popcornhax.github.io/stringscope](https://popcornhax.github.io/stringscope/)

The 3D shape is hidden in a drawing made only of vector strokes: scribbles, strings, contours, rings and weaves. There is no random-dot noise and no bitmap texture. Models can be rotated, moved and animated in real time. The line design is deterministic: from frame to frame, only the strokes near the object bend. The rest of the design stays put.

It's plain HTML, CSS and JavaScript modules with no build step and no dependencies to install. three.js is vendored in `vendor/three`, so it runs offline.

## Run it locally

You need [Node.js](https://nodejs.org/) 20 or newer, only for the tiny static server and the tests.

```bash
git clone https://github.com/popcornhax/stringscope.git
cd stringscope
npm start            # or: node server.js 5178
# open http://localhost:5178
```

On macOS you can also double-click `start.command`.

You need a local server because browsers block ES modules on `file://` URLs. Any static server works (for example `python3 -m http.server`); `server.js` is a dependency-free one.

## Features

- **Models:** torus knot, teapot, heart, ringed planet, double helix, sphere, torus, icosahedron, rounded cube, and editable 3D text. Three are animated: *Orbiting Moons*, *Ripple Pond* and *Asteroid Flythrough*.
- **Import:** STL (binary or ASCII), OBJ and PLY, using the button or drag and drop. Models are centered and scaled automatically. There are samples in `samples/`.
- **Depth from images:** drop any PNG/JPG and it becomes a relief. You pick where the depth comes from:
  - **Brightness:** the image *is* the depth map, white = near. Use this for classic Magic Eye depth maps, Blender/ZBrush depth renders, logos and text.
  - **AI depth:** estimates real 3D depth from an ordinary photo with [Depth Anything V2 (small)](https://huggingface.co/onnx-community/depth-anything-v2-small), running in the browser through transformers.js. It uses WebGPU when available, otherwise WASM. The first use downloads the library and roughly 25–50 MB of model weights from the internet, which the browser then caches. Everything else in the app works offline.
  - **Embedded (iPhone HEIC):** Portrait-mode photos carry the camera's own depth map. When the app finds one it uses it automatically. It's decoded with [libheif](https://github.com/strukturag/libheif) compiled to WebAssembly ([libheif-js](https://www.npmjs.com/package/libheif-js), about 1.9 MB, fetched on first HEIC import and then cached). That also makes HEIC open in Chrome and Firefox, which can't decode it natively.
  - **Cutout:** Apple's portrait matte, which turns the subject into a flat cut-out.
  - **Shaping controls:** Invert, Relief depth, Contrast (a gamma curve) and Soften.

  iPhone depth survives AirDrop and Image Capture, and Photos' "Export Unmodified Original". Exporting as JPEG or the "Most Compatible" camera setting strips it.

  The image is only used as input; the output is still all vector strokes.
- **Motion:** drag to rotate, Shift/right-drag to move, wheel or pinch to push in and pull out, double-click to reset. Animations: Spin, Tumble, Rock, Float, Orbit.
- **Line patterns:** Scribble (ballpoint), Strings, Weave, Topographic, Rings, Lattice, Ripples, Guilloché (banknote engraving), Morse (dashed strings). Each one is seedable (🎲 / `R`).
- **Glyph patterns:** the 3D image is carried by characters instead of lines.
  - **Matrix Rain:** falling katakana. The rain is consistent across every repeat, so the hidden shape stays fused while it falls.
  - **Typewriter:** inky, slightly crooked type.
- **Pattern flow:** slides the whole design sideways continuously while the hidden object stays locked in place. This works because shifting the phase leaves the stereo math intact.
- **Reveal hint** (`X`): draws red depth contours of the hidden object, as a spoiler to help first-time viewers.
- **Pulse to sound:** the model throbs with microphone input.
- **Gallery** (`G` / ✦): an auto-tour that cycles through models, patterns and palettes every 14 seconds, like a screensaver.
- **Palettes:** Ballpoint, Aurora, Vaporwave, Ember, Deep Ocean, Gilded, Blueprint, Ink on Paper, Risograph, Spectrum, Matrix, Neon Noir, Mint Paper, Sumi Ink.
- **Stereo controls:** wall-eyed or cross-eyed, eye separation, depth strength, lift from background, surface smoothing, reconnect strings, line detail, echo damping.
- **Reconnect strings:** where the depth jumps at an object's edge, the phase field jumps too, and strings would break. Reconnect blends the phase into a short ramp over a few pixels around those cliffs, so contours stay continuous and bend around the edge. Any small gaps left over are bridged with curves along each string's direction. Set it to 0 for strictly exact stereo at the edges.
- **Views:** stereogram, depth map, shaded 3D, plus a 3D picture-in-picture inset (`P`).
- **SVG export** (`S`): saves the current frame as resolution-independent vector art. Each pen color is its own Inkscape layer, so it's ready for pen plotters such as the AxiDraw, or for print.
- Settings persist in localStorage.

Keys: `Space` play/pause · `R` new design · `D` cycle view · `P` inset · `S` SVG · `X` reveal hint · `G` gallery · `H` hide UI · `F` fullscreen · `0` reset pose · arrows rotate · `+`/`-` push/pull · `?` help.

## How it works

1. **Depth.** `js/scene.js` renders the model with a shader that packs normalized depth into two 8-bit channels. It renders into an offscreen target at 2× supersampling, reads the result back and box-downsamples it into a float grid (~470×300). This grid is internal data, never shown.
2. **Phase field.** `js/stereo.js` takes the place of the classic "copy the pixel color across" step. For every scanline it solves a continuous phase `u(x)` so that for each point `c` with separation `s = S(depth(c))`:

   `u(c + s/2) − u(c − s/2) = 1`

   It starts at the screen center and works outward in both directions, so distortions spread out symmetrically.
3. **Line patterns.** `js/patterns.js` defines scalar fields `F(u, v)` that repeat once per unit of `u`. Because the phase links the left-eye and right-eye points, any texture that repeats in `u` is automatically a valid stereogram. `js/engine.js` precomputes each field into a lookup table over one repeat.
4. **Contours.** `js/contours.js` runs marching squares to extract every integer level set of each field as line segments. Cells at depth cliffs are left out, so the silhouette doesn't get drawn as an outline.
5. **Drawing.**
   - `js/gldraw.js` draws the lines on the GPU as instanced quads with antialiased round ends. Each style's coverage is merged in an offscreen texture, so overlapping pieces don't double up, then blended over the frame.
   - `js/draw.js` draws glyphs and overlays on a 2D canvas on top, serializes the SVG, and is the full fallback renderer (add `?canvas` to the URL).

### Performance architecture

- **Async depth readback:** depth is read back from the GPU asynchronously, so the page never waits on the GPU.
- **Worker compute:** the line math runs in a Web Worker (`js/worker.js`, `js/compute.js`), so the UI stays responsive at 60 fps even when a frame takes longer.
- **Pipelining:** frames are pipelined. The next frame's depth readback overlaps the worker computing the current one.
- **Why the GPU renderer exists:** Safari rasterizes huge Canvas 2D paths on the CPU, which made it 5–8× slower than Chrome.

The pattern depends only on the seed and on `(u, y)`, so the design never reshuffles. Rows that don't contain the object don't change at all (there's a test for this).

## Tests

```bash
npm test
```

The tests use Node's built-in test runner on the DOM-free engine. They check:
- the stereo constraint error (median < 0.005 of a repeat, p99 < 0.03), in both wall-eyed and cross-eyed modes
- exact periodicity on the background
- that every pattern repeats correctly in `u`
- frame-to-frame stability
- a performance budget (best of 15 runs under 60 ms for a 480×300 frame)

## Build and deploy

```bash
npm run build        # copies the site's files into _site/
npm run preview      # builds, then serves _site/ at http://localhost:5178
```

There's no bundler: `tools/build-site.js` copies only the files the app loads (`index.html`, `css/`, `js/`, `icons/`, `vendor/`, `samples/`, the manifest and service worker) into `_site/`. Every path in the app is relative, so the output works from any base path, including a GitHub Pages project URL such as `/stringscope/`.

`.github/workflows/pages.yml` deploys `_site/` to GitHub Pages on every push to `main` (or when run by hand). To host your own fork, set **Settings → Pages → Source** to **GitHub Actions**.

## Phones and tablets

- **Touch:** drag to rotate, two fingers to move, pinch to push in or pull out, double-tap to reset. ◐ hides the controls; tap anywhere to bring them back.
- **Layouts:**
  - **Phone, portrait:** the controls are a bottom sheet.
  - **Phone, landscape:** a side panel.
  - **Tablet:** the desktop layout, with larger touch targets. Notches and the home indicator are respected.
- **Phone defaults:** the first run on a phone uses a smaller eye separation, which is comfortable at reading distance, and a lighter line grid.
- **Install as an app:** on iPhone, use Share → **Add to Home Screen**. On Android, use Install app. It then opens fullscreen and works offline, except for the AI depth and HEIC decoders, which are fetched online on first use. iPhone Safari can't make a web page fullscreen, so this is the way to get rid of the browser bars.
- **Testing on your phone from your computer:** run `npm run start:lan` and open the printed `http://192.168.x.x:5178` address on the phone, on the same Wi-Fi. Over plain http on the LAN, the browser blocks the microphone pulse and offline install. Everything else works.

## Tips for viewing

Go fullscreen at arm's length. Look *through* the screen until the two guide dots at the top become three. If fusion feels strained, use a smaller eye separation on a laptop and a larger one on a big monitor. Start with *Still* motion, then turn animation on once the shape has locked.

## Layout

```
index.html, css/style.css   UI
js/main.js                  app state, UI binding, interaction, render loop
js/scene.js                 three.js depth pass + previews
js/models.js                built-in models, STL/OBJ/PLY import, image reliefs, normalization
js/depthai.js               on-demand Depth Anything V2 depth estimation for photos
js/heic.js                  HEIC decoding incl. embedded depth + portrait matte (libheif WASM)
js/stereo.js                phase field, cliff mask, depth smoothing
js/patterns.js              generative line fields
js/engine.js                depth → phase → contours pipeline
js/contours.js              multi-level marching squares
js/draw.js                  canvas overlay, fallback renderer, SVG output
js/gldraw.js                GPU (WebGL2) line renderer
js/compute.js, js/worker.js engine in a Web Worker, frame hand-off
js/bridges.js               bridges any remaining string gaps
js/palettes.js, js/rng.js   colors, seeded PRNG
tools/make-samples.js       regenerates samples/gear.stl, samples/star.obj
tools/build-site.js         assembles the static site in _site/ for GitHub Pages
vendor/three/               three.js r170 (MIT) + used addons
```

## Contributing

Issues and pull requests are welcome. Please run `npm test` before opening a pull request, and keep the app free of build steps and runtime dependencies.

## License

[MIT](LICENSE) © 2026 Dan Browder, Art Hax LLC.

three.js in `vendor/three/` is © three.js authors, under its own [MIT license](vendor/three/LICENSE). The optional AI depth (transformers.js, Depth Anything V2) and HEIC (libheif-js) decoders are loaded from a CDN on first use and are under their own licenses.
