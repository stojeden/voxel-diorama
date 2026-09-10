import * as THREE from 'three';
import { Pass } from 'postprocessing';

/**
 * Temporal accumulation: the only thing that steadies geometry thinner than a pixel.
 *
 * Everything cheaper was measured on the owner's own configuration -- a 1584x722 buffer
 * stretched to a 2880x1314 display, the medium profile, the default 96 m shot, which is
 * seven pixels per metre -- and none of it moved the number. Resolution is not even
 * monotonic: on a shaded facade, 1.6 took the residual down 13% and 2.0 put it 15% UP,
 * because at 2.0 the buffer equals the display and the upscale blur that had been hiding
 * the aliasing is gone. Ambient occlusion contributes exactly nothing at that distance,
 * shadows off makes it 1.8% worse, and painting out the baked window shadows wins 0.7%.
 * What is left flickering is the geometry's own edges -- window apertures, slab edges, a
 * building corner -- and no post-process and no resolution fixes those, because the sample
 * is taken once per pixel per frame and the answer changes every frame.
 *
 * So the sample is spread over time instead. The projection is nudged by a fraction of a
 * pixel each frame along a Halton sequence, and the result is blended into the previous
 * frame reprojected into this one. A thin line that lands on a different side of the pixel
 * centre each frame stops flickering and becomes the average it should have been.
 *
 * What this costs in kind, stated plainly: history is the past, and anything that MOVED
 * between the two frames is in the wrong place. Camera motion is undone exactly, from depth
 * and the previous camera matrix. Objects moving through the world -- the train, the bus,
 * the people, swaying foliage, smoke, the lake -- are not, because there is no velocity
 * buffer here. Their smear is limited by clipping the history to the distribution of
 * colours in the current pixel's own neighbourhood, which is the standard remedy and a good
 * one, but it is a remedy and not a cure.
 *
 * It sits after ambient occlusion and before bloom on purpose. Occlusion here is eight taps
 * on a screen-anchored noise spiral with no denoiser of its own, so it flickers too, and
 * accumulation is exactly what denoises it.
 *
 * ── Why the first version of this did nothing, and what it cost to find out ──
 *
 * The pass ran, took its milliseconds, and changed the picture by nothing. The reason was
 * not in the algorithm at all: the hand-off to the rest of the chain used the library's
 * `CopyPass`, which renders into a target of its own rather than the `outputBuffer` it is
 * handed, so the composer swapped to a buffer this pass had never written and THE ENTIRE
 * RESOLVE WAS DISCARDED EVERY FRAME. It was found by forcing the resolve to output flat
 * red and watching the frame's mean colour not move by a tenth of a level.
 *
 * That one fault invalidated every measurement taken of this pass before it was found --
 * bilinear against Catmull-Rom, three clip widths, the blend factor, and even 100% history
 * against 100% current frame, which came out identical to three decimal places and should
 * have been the tell. They all agreed with each other because they were all measuring the
 * same discarded picture. The reading that finally located it was the only one that asked
 * whether the output arrives, rather than how good it is.
 *
 * With the output landing, a second fault surfaced, this one real: the variance clip took
 * the SMALLEST ratio across the three YCoCg channels, and the two chroma channels of a
 * grey wall have a standard deviation of essentially zero. So the box had no width there,
 * the history was snapped onto the neighbourhood mean on every frame, and the output was a
 * 3x3 blur of the current frame -- a pure function of the jitter phase, spread 3.34 between
 * frames of one cycle. `CLIP_FLOOR` is what fixes that; the spread is now 0.18.
 *
 * A third thing was wrong and was not causing the failure, but is fixed here too: the
 * reprojection used the JITTERED matrices, so the lookup carried the difference of two
 * nudges -- a sub-pixel error changing every frame, which is the thing accumulation exists
 * to remove. The jitter now reaches the rasteriser and nothing else, and with the camera
 * still the reprojection is the identity to the bit and the history is accepted on 100% of
 * pixels.
 *
 * ── What it does, measured on the owner's configuration ──
 *
 * On the shaded facade whose flicker was reported, against the same shot without the pass:
 *
 *   stability (detrended residual under sub-pixel camera creep)   -43.5%
 *   worst single pixel                                            -51%
 *   sharpness, static geometry                                     -2.8%
 *   sharpness, the smoke plume -- the fastest thing in frame       -4.2% at amplitude 1.0
 *   frame time, median of 120                            12.78 -> 13.10 ms
 *
 * The two sharpness figures matching is the important one: the variance clip is holding, so
 * what moves through the world is softened no more than what stands still. The cost is real
 * but small, and it is a blur cost -- against a 3x supersampled reference the resolved image
 * sits 28% further away than the plain render, at zero offset, which is what a jitter that
 * averages over a pixel's width does.
 *
 * The resampling kernel was then measured rather than assumed, and the trade is legible:
 *
 *   bilinear      -48.9% stability, -8.1% sharpness
 *   half and half -49.5%,           -6.3%
 *   Catmull-Rom   -45.6%,           -4.4%      <- kept
 *
 * Catmull-Rom keeps twice the sharpness for three points of stability, which is why it is
 * the standard remedy. An anti-ringing clamp on top of it bought -47.5% for -5.1% and nine
 * more taps, and was not kept.
 */

/**
 * The nudge sequence.
 *
 * Halton is the standard choice because consecutive samples are far apart while the whole
 * set stays evenly spread -- a random offset clumps, and a regular grid repeats a pattern
 * the eye can find. Eight samples: enough to average a pixel's worth of coverage, short
 * enough that a moving camera never carries very old colour.
 */
export const JITTER_SAMPLES = 8;

function halton(index: number, base: number): number {
  let result = 0;
  let fraction = 1;
  let i = index;
  while (i > 0) {
    fraction /= base;
    result += fraction * (i % base);
    i = Math.floor(i / base);
  }
  return result;
}

/**
 * How wide the nudge is, as a fraction of a pixel, and it is deliberately NOT the textbook
 * value.
 *
 * The usual amplitude is a full pixel -- offsets spanning -0.5 to +0.5 -- because that
 * covers exactly one pixel's worth of coverage. But the jitter is also the pass's own
 * source of noise: each frame carries a tenth of a differently-offset image, and the wider
 * the offset the more of that survives into the output. Swept on the shaded facade that was
 * reported, against the same shot without the pass:
 *
 *   amplitude   1.25     1.00     0.75     0.50
 *   flicker    -44.7%   -46.0%   -43.5%   -43.5%
 *   sharpness   -4.2%    -3.9%    -2.8%    -2.9%
 *
 * Three quarters of a pixel keeps essentially the whole flicker win and gives back more
 * than a quarter of the blur, and the curve is flat from there down to a half, so this is
 * the wide end of a plateau rather than a knife edge. Widening the blend factor instead --
 * 0.15 or 0.20 -- buys sharpness far more expensively: 0.20 gave back only 1.7 points of
 * blur for 13 points of flicker.
 */
const JITTER_AMPLITUDE = 0.75;

/** The offsets, in pixels, centred on zero. Computed once: the sequence never changes. */
const JITTER: ReadonlyArray<readonly [number, number]> = Array.from(
  { length: JITTER_SAMPLES },
  (_, index) =>
    [
      (halton(index + 1, 2) - 0.5) * JITTER_AMPLITUDE,
      (halton(index + 1, 3) - 0.5) * JITTER_AMPLITUDE,
    ] as const
);

/**
 * How much of each frame is new.
 *
 * A tenth. Lower is steadier and smears more; higher is the opposite. With eight jitter
 * samples a tenth reaches the average in about the time the sequence takes to repeat, and
 * the variance clip below is what keeps the other nine tenths honest.
 */
const BLEND = 0.1;

/**
 * How wide the box the history is allowed to live in, in standard deviations of the
 * current pixel's neighbourhood.
 *
 * 1.25 is the usual choice and the trade is legible in both directions: tighter rejects
 * good history and the accumulation stops converging; looser lets a moving object drag its
 * old colour across the frame, because this box is the only thing standing in for the
 * velocity buffer this pass does not have.
 */
const CLIP_GAMMA = 1.25;

/**
 * The narrowest the box may ever be, as a fraction of the neighbourhood's own luminance.
 *
 * Without it a flat grey surface has a box of zero width in the two chroma channels and
 * the history is discarded on every frame; see the shader for the measurement that showed
 * it. Two percent is loose enough that accumulation converges on flat surfaces and tight
 * enough that a moving object still gets clipped rather than smeared.
 */
const CLIP_FLOOR = 0.02;

const RESOLVE_SHADER = {
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = vec4(position.xy, 1.0, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D inputBuffer;
    uniform sampler2D historyBuffer;
    uniform highp sampler2D depthBuffer;
    uniform mat4 uInverseViewProjection;
    uniform mat4 uPreviousViewProjection;
    uniform vec2 uTexelSize;
    uniform vec2 uResolution;
    uniform float uReset;
    uniform float uBlend;
    uniform float uClipGamma;
    uniform float uClipFloor;
    varying vec2 vUv;

    // Luminance first, then two chroma axes. Reversible, cheap, and no matrix.
    vec3 toYCoCg(vec3 c) {
      return vec3(
         0.25 * c.r + 0.5 * c.g + 0.25 * c.b,
         0.5  * c.r            - 0.5  * c.b,
        -0.25 * c.r + 0.5 * c.g - 0.25 * c.b
      );
    }

    vec3 toRGB(vec3 c) {
      float t = c.x - c.z;
      return vec3(t + c.y, c.x + c.z, t - c.y);
    }

    /**
     * Catmull-Rom in five taps.
     *
     * The nine-tap form is separable and exact; this is the standard reduction that drops
     * the four corners, whose weights are the product of two small numbers, and folds the
     * inner two taps of each axis into one bilinear fetch. Weights are renormalised because
     * the dropped corners take a little of the total with them, and without that the image
     * darkens a fraction on every frame -- which is the same compounding mistake in a
     * different disguise.
     */
    vec3 sampleHistory(vec2 uv) {
      vec2 texSize = uResolution;
      vec2 samplePos = uv * texSize;
      vec2 texPos1 = floor(samplePos - 0.5) + 0.5;
      vec2 f = samplePos - texPos1;

      vec2 w0 = f * (-0.5 + f * (1.0 - 0.5 * f));
      vec2 w1 = 1.0 + f * f * (-2.5 + 1.5 * f);
      vec2 w2 = f * (0.5 + f * (2.0 - 1.5 * f));
      vec2 w3 = f * f * (-0.5 + 0.5 * f);

      vec2 w12 = max(w1 + w2, vec2(1e-5));
      vec2 offset12 = w2 / w12;

      vec2 tp0 = (texPos1 - 1.0) / texSize;
      vec2 tp3 = (texPos1 + 2.0) / texSize;
      vec2 tp12 = (texPos1 + offset12) / texSize;

      vec3 acc = vec3(0.0);
      float wsum = 0.0;
      float w;

      w = w12.x * w0.y;  acc += texture2D(historyBuffer, vec2(tp12.x, tp0.y)).rgb * w;  wsum += w;
      w = w0.x  * w12.y; acc += texture2D(historyBuffer, vec2(tp0.x,  tp12.y)).rgb * w; wsum += w;
      w = w12.x * w12.y; acc += texture2D(historyBuffer, vec2(tp12.x, tp12.y)).rgb * w; wsum += w;
      w = w3.x  * w12.y; acc += texture2D(historyBuffer, vec2(tp3.x,  tp12.y)).rgb * w; wsum += w;
      w = w12.x * w3.y;  acc += texture2D(historyBuffer, vec2(tp12.x, tp3.y)).rgb * w;  wsum += w;

      // Negative lobes can push a channel below zero on a hard edge; a half-float history
      // keeps the negative and it grows.
      return max(acc / max(wsum, 1e-4), vec3(0.0));
    }

    void main() {
      vec4 current = texture2D(inputBuffer, vUv);

      if (uReset > 0.5) {
        gl_FragColor = current;
        return;
      }

      // Where this pixel was last frame: unproject it with this frame's camera, then
      // project it with the previous one. Both matrices are free of the jitter, so the
      // lookup does not wobble with the nudge. Exact for anything that did not move itself.
      float depth = texture2D(depthBuffer, vUv).x;
      vec4 ndc = vec4(vUv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
      vec4 world = uInverseViewProjection * ndc;
      world /= world.w;
      vec4 previous = uPreviousViewProjection * world;
      vec2 previousUv = (previous.xy / previous.w) * 0.5 + 0.5;

      // Off the edge of last frame there is no history to use, so take the new sample whole.
      // On the owner's default shot this rejects nothing at all: with the camera still, the
      // reprojection is the identity to the bit, and the history is accepted on every pixel.
      if (previousUv.x < 0.0 || previousUv.x > 1.0 || previousUv.y < 0.0 || previousUv.y > 1.0) {
        gl_FragColor = current;
        return;
      }

      // The distribution of this pixel's own neighbourhood, in YCoCg. Two moments are
      // enough: the mean and the spread the history is allowed to sit inside.
      vec3 m1 = vec3(0.0);
      vec3 m2 = vec3(0.0);
      for (int x = -1; x <= 1; x++) {
        for (int y = -1; y <= 1; y++) {
          vec3 s = toYCoCg(texture2D(inputBuffer, vUv + vec2(float(x), float(y)) * uTexelSize).rgb);
          m1 += s;
          m2 += s * s;
        }
      }
      vec3 mu = m1 / 9.0;
      vec3 sigma = sqrt(max(vec3(0.0), m2 / 9.0 - mu * mu));
      // The floor is not a fudge, it is the difference between this working and not.
      //
      // In YCoCg the two chroma channels of a grey wall have a standard deviation of
      // essentially zero, so the box built from sigma alone has NO WIDTH there. The clip
      // below takes the smallest ratio across the three channels, so one zero-width
      // channel drags the whole history onto the neighbourhood mean -- every frame, on
      // every desaturated surface, which is most of this city. That is exactly what was
      // measured before this line existed: the output became a 3x3 blur of the current
      // frame, a pure function of the jitter phase, its eight-frame average 11.1 from a
      // supersampled reference where the plain frame was 7.8. Nothing accumulated, and it
      // made no difference whether the history was sampled bilinearly or with Catmull-Rom,
      // because the sample was being thrown away either way.
      vec3 extent = max(uClipGamma * sigma, vec3(uClipFloor * max(mu.x, 0.02)));

      // Clip, not clamp: walk the history towards the mean until it enters the box. A
      // per-channel clamp lands on a corner and shifts the hue; this keeps the direction.
      vec3 history = toYCoCg(sampleHistory(previousUv));
      vec3 delta = history - mu;
      vec3 unit = abs(extent) / max(abs(delta), vec3(1e-5));
      float scale = min(unit.x, min(unit.y, unit.z));
      if (scale < 1.0) history = mu + delta * scale;

      gl_FragColor = vec4(mix(toRGB(history), current.rgb, uBlend), current.a);
    }
  `,
};

export class TemporalResolvePass extends Pass {
  /** The scene camera. Not `camera`: the base class owns that name for its own quad. */
  private readonly view: THREE.PerspectiveCamera;
  private readonly history: [THREE.WebGLRenderTarget, THREE.WebGLRenderTarget];
  /**
   * The hand-off to the rest of the chain, owned here rather than borrowed.
   *
   * This used to be the library's `CopyPass`, and that is why nothing in this pass worked:
   * it renders into a target of its own rather than the `outputBuffer` it is handed, so the
   * composer swapped to a buffer this pass had never written and the whole resolve was
   * discarded every frame. Measured by forcing the resolve to output flat red: the frame's
   * mean colour did not move by a tenth of a level. Everything else measured about this
   * pass before that was found -- bilinear against Catmull-Rom, every clip width, the blend
   * factor, even 100% history against 100% current frame -- was measuring nothing, and all
   * of those readings agreed with each other because all of them were the same discarded
   * picture.
   */
  private readonly handoffScene = new THREE.Scene();
  private readonly handoffCamera = new THREE.Camera();
  private readonly handoffMaterial: THREE.ShaderMaterial;
  private readonly resolveMaterial: THREE.ShaderMaterial;
  /** Jitter-free view-projection of this frame and the one before it. */
  private readonly viewProjection = new THREE.Matrix4();
  private readonly previousViewProjection = new THREE.Matrix4();
  private readonly inverseViewProjection = new THREE.Matrix4();
  private readonly viewInverse = new THREE.Matrix4();
  private frame = 0;
  private index = 0;
  private needsReset = true;

  constructor(camera: THREE.PerspectiveCamera) {
    super('TemporalResolvePass');
    this.view = camera;
    this.needsDepthTexture = true;

    const target = () =>
      new THREE.WebGLRenderTarget(1, 1, {
        type: THREE.HalfFloatType,
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        depthBuffer: false,
        stencilBuffer: false,
      });
    this.history = [target(), target()];

    this.handoffMaterial = new THREE.ShaderMaterial({
      name: 'TemporalHandoffMaterial',
      uniforms: { inputBuffer: { value: null } },
      vertexShader: RESOLVE_SHADER.vertexShader,
      fragmentShader: /* glsl */ `
        uniform sampler2D inputBuffer;
        varying vec2 vUv;
        void main() { gl_FragColor = texture2D(inputBuffer, vUv); }
      `,
      depthWrite: false,
      depthTest: false,
    });
    // The same full-screen triangle the base class uses for its own quad, built here so the
    // hand-off never depends on which material the base class happens to be holding.
    const triangle = new THREE.BufferGeometry();
    triangle.setAttribute(
      'position',
      new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3)
    );
    triangle.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 0, 2, 0, 0, 2]), 2));
    const quad = new THREE.Mesh(triangle, this.handoffMaterial);
    quad.frustumCulled = false;
    this.handoffScene.add(quad);

    this.resolveMaterial = new THREE.ShaderMaterial({
      name: 'TemporalResolveMaterial',
      uniforms: {
        inputBuffer: { value: null },
        historyBuffer: { value: null },
        depthBuffer: { value: null },
        uInverseViewProjection: { value: this.inverseViewProjection },
        uPreviousViewProjection: { value: this.previousViewProjection },
        uTexelSize: { value: new THREE.Vector2() },
        uResolution: { value: new THREE.Vector2() },
        uReset: { value: 1 },
        uBlend: { value: BLEND },
        uClipGamma: { value: CLIP_GAMMA },
        uClipFloor: { value: CLIP_FLOOR },
      },
      vertexShader: RESOLVE_SHADER.vertexShader,
      fragmentShader: RESOLVE_SHADER.fragmentShader,
      depthWrite: false,
      depthTest: false,
    });
    this.fullscreenMaterial = this.resolveMaterial;
  }

  /**
   * Take the clean matrices, then nudge the projection, both before the scene is drawn.
   *
   * Called from a pass placed ahead of the scene render, because by the time this pass
   * itself runs the frame has already been rasterised. The order matters: the reprojection
   * matrices are read while the projection is still clean, and only then does the nudge go
   * on, so the jitter reaches the rasteriser and nothing else.
   */
  beginFrame(width: number, height: number): void {
    this.view.clearViewOffset();
    this.view.updateProjectionMatrix();
    this.view.updateMatrixWorld();
    // `matrixWorldInverse` is refreshed by the renderer at render time, so reading it here
    // -- ahead of the scene render -- would be one frame stale. Inverted here instead.
    this.viewInverse.copy(this.view.matrixWorld).invert();
    this.viewProjection.multiplyMatrices(this.view.projectionMatrix, this.viewInverse);
    this.inverseViewProjection.copy(this.viewProjection).invert();

    const [x, y] = JITTER[this.frame % JITTER_SAMPLES];
    this.frame++;
    // setViewOffset shifts the frustum by a fraction of a pixel without touching the field
    // of view, which is what keeps the nudge invisible in everything except the sampling.
    this.view.setViewOffset(width, height, x, y, width, height);
  }

  /** Put the camera back, so nothing else in the frame sees a nudged projection. */
  endFrame(): void {
    this.view.clearViewOffset();
  }

  /**
   * Throw the history away.
   *
   * Anything that changes the picture discontinuously has to call this, or the old frame is
   * blended into a scene it does not belong to: a quality change, a theme morph, a loaded
   * checkpoint, a resize.
   */
  reset(): void {
    this.needsReset = true;
  }

  override setSize(width: number, height: number): void {
    for (const target of this.history) target.setSize(width, height);
    this.resolveMaterial.uniforms.uTexelSize.value.set(1 / width, 1 / height);
    this.resolveMaterial.uniforms.uResolution.value.set(width, height);
    this.reset();
  }

  override setDepthTexture(
    depthTexture: THREE.Texture,
    depthPacking = THREE.BasicDepthPacking
  ): void {
    this.resolveMaterial.uniforms.depthBuffer.value = depthTexture;
    void depthPacking;
  }

  override render(
    renderer: THREE.WebGLRenderer,
    inputBuffer: THREE.WebGLRenderTarget,
    outputBuffer: THREE.WebGLRenderTarget
  ): void {
    const read = this.history[this.index];
    const write = this.history[1 - this.index];
    const uniforms = this.resolveMaterial.uniforms;
    uniforms.inputBuffer.value = inputBuffer.texture;
    uniforms.historyBuffer.value = read.texture;
    uniforms.uReset.value = this.needsReset ? 1 : 0;

    // Resolve into the free history slot, then hand a copy of it on. The resolved frame is
    // both this frame's output and next frame's history, so it has to live somewhere that
    // the composer will not swap out from under it.
    renderer.setRenderTarget(write);
    renderer.render(this.scene, this.camera);
    this.handoffMaterial.uniforms.inputBuffer.value = write.texture;
    renderer.setRenderTarget(this.renderToScreen ? null : outputBuffer);
    renderer.render(this.handoffScene, this.handoffCamera);

    this.previousViewProjection.copy(this.viewProjection);
    this.index = 1 - this.index;
    this.needsReset = false;
  }

  override dispose(): void {
    for (const target of this.history) target.dispose();
    this.resolveMaterial.dispose();
    this.handoffMaterial.dispose();
    for (const child of this.handoffScene.children) {
      if ((child as THREE.Mesh).isMesh) (child as THREE.Mesh).geometry.dispose();
    }
    super.dispose();
  }
}
