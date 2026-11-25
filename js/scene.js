// Three.js scene used only to measure depth (and for the optional shaded preview).
// The depth pass renders into an offscreen target that is read back into a small
// float grid; the visible output is drawn as vector lines elsewhere.

import * as THREE from 'three';

const depthVertex = /* glsl */ `
  varying float vDist;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vDist = -mv.z;
    gl_Position = projectionMatrix * mv;
  }
`;

// Encodes normalized depth (1 = near plane of the depth volume) into two 8-bit channels.
const depthFragment = /* glsl */ `
  uniform float uNear;
  uniform float uFar;
  uniform float uVisualize;
  varying float vDist;
  void main() {
    float d = clamp((uFar - vDist) / (uFar - uNear), 0.0, 1.0);
    if (uVisualize > 0.5) {
      gl_FragColor = vec4(vec3(d), 1.0);
    } else {
      float scaled = d * 255.0;
      gl_FragColor = vec4(floor(scaled) / 255.0, fract(scaled), 0.0, 1.0);
    }
  }
`;

export const CAMERA_DISTANCE = 6;

export class DepthScene {
  constructor(canvas) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(30, 1, 0.1, 100);
    this.camera.position.set(0, 0, CAMERA_DISTANCE);
    this.pivot = new THREE.Group();
    this.scene.add(this.pivot);
    this.model = null;

    this.target = new THREE.WebGLRenderTarget(4, 4, {
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      depthBuffer: true,
    });
    this.depthMaterial = new THREE.ShaderMaterial({
      vertexShader: depthVertex,
      fragmentShader: depthFragment,
      uniforms: { uNear: { value: 4 }, uFar: { value: 7 }, uVisualize: { value: 0 } },
      side: THREE.DoubleSide,
    });
    this.pixels = new Uint8Array(0);
    this.black = new THREE.Color(0x000000);
    this.previewBg = new THREE.Color(0x0c0f1a);
  }

  setModel(object) {
    if (this.model) {
      this.pivot.remove(this.model);
      this.model.traverse((o) => {
        if (o.isMesh) {
          o.geometry.dispose();
          o.material.dispose?.();
        }
      });
    }
    this.model = object;
    this.pivot.add(object);
  }

  update(time) {
    this.model?.userData.update?.(time);
  }

  /** Depth volume: the object (unit sphere at origin) sits inside [near, far]. */
  setDepthRange(front, back) {
    this.depthMaterial.uniforms.uNear.value = CAMERA_DISTANCE - front;
    this.depthMaterial.uniforms.uFar.value = CAMERA_DISTANCE + back;
  }

  /**
   * Render depth at (gw*ss) x (gh*ss) and box-downsample into `out` (gw*gh, row 0 = top).
   * Resolves once the GPU readback completes; callers must not overlap calls.
   */
  async readDepth(gw, gh, ss, aspect, out) {
    const w = gw * ss;
    const h = gh * ss;
    if (this.target.width !== w || this.target.height !== h) this.target.setSize(w, h);
    if (this.pixels.length !== w * h * 4) this.pixels = new Uint8Array(w * h * 4);
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();

    const r = this.renderer;
    this.depthMaterial.uniforms.uVisualize.value = 0;
    this.scene.overrideMaterial = this.depthMaterial;
    this.scene.background = null;
    r.setRenderTarget(this.target);
    r.setClearColor(this.black, 0);
    r.clear();
    r.render(this.scene, this.camera);
    r.setRenderTarget(null);
    this.scene.overrideMaterial = null;
    // Asynchronous readback: the CPU doesn't stall waiting for the GPU to finish.
    await r.readRenderTargetPixelsAsync(this.target, 0, 0, w, h, this.pixels);

    const px = this.pixels;
    const inv = 1 / (ss * ss * 255);
    for (let j = 0; j < gh; j++) {
      for (let i = 0; i < gw; i++) {
        let acc = 0;
        for (let sy = 0; sy < ss; sy++) {
          // WebGL rows start at the bottom.
          const row = h - 1 - (j * ss + sy);
          let p = (row * w + i * ss) * 4;
          for (let sx = 0; sx < ss; sx++, p += 4) {
            if (px[p + 3]) acc += px[p] + px[p + 1] / 255;
          }
        }
        out[j * gw + i] = acc * inv;
      }
    }
  }

  /** Draw the scene to the visible WebGL canvas ('shaded' or 'depth'). */
  renderPreview(mode, cssW, cssH) {
    const r = this.renderer;
    const size = r.getSize(new THREE.Vector2());
    if (size.x !== cssW || size.y !== cssH) r.setSize(cssW, cssH, false);
    this.camera.aspect = cssW / cssH;
    this.camera.updateProjectionMatrix();
    if (mode === 'depth') {
      this.depthMaterial.uniforms.uVisualize.value = 1;
      this.scene.overrideMaterial = this.depthMaterial;
      r.setClearColor(this.black, 1);
    } else {
      this.scene.overrideMaterial = null;
      r.setClearColor(this.previewBg, 1);
    }
    r.render(this.scene, this.camera);
    this.scene.overrideMaterial = null;
  }
}
