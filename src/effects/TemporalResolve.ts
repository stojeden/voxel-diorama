import * as THREE from 'three';
import { CopyPass, Pass } from 'postprocessing';

/**
 * Temporal accumulation: the only thing that steadies geometry thinner than a pixel.
 *
 * Everything cheaper was measured on the owner's own configuration -- a 1584x722 buffer
 * stretched to a 2880x1314 display, the medium profile, the default 96 m shot, which is
 * eight pixels per metre -- and none of it moved the number. Resolution was flat across the
 * whole range (2.75 of residual at 1.15, 3.04 at 2.0, 2.78 at 2.6); ambient occlusion and
 * bloom changed nothing; MSAA bought 3% for 1.9 ms; the SMAA preset 0.7%. The hottest tile
 * of the residual map is one diagonal line of one or two pixels against the sky -- a mast,
 * a wire, a lamp post. No post-process and no resolution fixes that, because the problem is
 * that the sample is taken once per pixel per frame and the answer changes every frame.
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
 * buffer here. Their smear is limited by clamping the history to the range of colours in
 * the current pixel's own neighbourhood, which is the standard remedy and a good one, but
 * it is a remedy and not a cure. That is why this is behind `?taa=1` and off by default
 * until it has been looked at next to the thing it replaces.
 *
 * It sits after ambient occlusion and before bloom on purpose. Occlusion here is eight taps
 * on a screen-anchored noise spiral with no denoiser of its own, so it flickers too, and
 * accumulation is exactly what denoises it.
 *
 * AS WRITTEN THIS DOES NOT YET EARN ITS PLACE, and that is measured rather than suspected.
 * On the owner's configuration, camera held still and the history allowed ninety frames to
 * converge, the share of intermediate pixels along the mast the residual map pointed at --
 * the signature of an anti-aliased edge -- went from 2.337% to 2.367%. That is nothing. The
 * pass runs (309 frames, one reset, about +3 ms), so it is not skipped; it simply resolves
 * to almost exactly the current frame.
 *
 * As far as the diagnosis got: the history is resampled with bilinear filtering every
 * frame, so it blurs a little more each time, and the neighbourhood clamp then pulls the
 * blurred history back towards the current pixel -- blur in, clamp out, nothing
 * accumulates. The known remedies are sampling the history with a Catmull-Rom kernel
 * instead of bilinear, and replacing the min/max clamp with variance clipping. Both are
 * real work and neither is done here.
 *
 * One instrument was also retired proving this: the motion-compensated residual, which
 * served every other measurement this week, cannot judge an accumulated image. It compares
 * frame N against frame N-1 shifted by a known vector, and an accumulated frame carries a
 * mixture of the last ten frames at ten different shifts, so the compensation is wrong for
 * most of what it looks at. It scored this pass WORSE while the picture was no less steady.
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

/** The offsets, in pixels, centred on zero. Computed once: the sequence never changes. */
const JITTER: ReadonlyArray<readonly [number, number]> = Array.from(
  { length: JITTER_SAMPLES },
  (_, index) => [halton(index + 1, 2) - 0.5, halton(index + 1, 3) - 0.5] as const
);

/**
 * How much of each frame is new.
 *
 * A tenth. Lower is steadier and smears more; higher is the opposite. With eight jitter
 * samples a tenth reaches the average in about the time the sequence takes to repeat, and
 * the neighbourhood clamp below is what keeps the other nine tenths honest.
 */
const BLEND = 0.1;

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
    uniform float uReset;
    uniform float uBlend;
    varying vec2 vUv;

    void main() {
      vec4 current = texture2D(inputBuffer, vUv);

      if (uReset > 0.5) {
        gl_FragColor = current;
        return;
      }

      // Where this pixel was last frame: unproject it with this frame's camera, then
      // project it with the previous one. Exact for anything that did not move itself.
      float depth = texture2D(depthBuffer, vUv).x;
      vec4 ndc = vec4(vUv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
      vec4 world = uInverseViewProjection * ndc;
      world /= world.w;
      vec4 previous = uPreviousViewProjection * world;
      vec2 previousUv = (previous.xy / previous.w) * 0.5 + 0.5;

      // Off the edge of last frame there is no history to use, so take the new sample whole.
      if (previousUv.x < 0.0 || previousUv.x > 1.0 || previousUv.y < 0.0 || previousUv.y > 1.0) {
        gl_FragColor = current;
        return;
      }

      // The clamp that keeps a moving object from dragging its old colour along: whatever
      // the history says, it may not leave the range of colours this pixel's neighbours
      // actually have right now.
      vec3 lo = current.rgb;
      vec3 hi = current.rgb;
      for (int x = -1; x <= 1; x++) {
        for (int y = -1; y <= 1; y++) {
          vec3 neighbour = texture2D(inputBuffer, vUv + vec2(float(x), float(y)) * uTexelSize).rgb;
          lo = min(lo, neighbour);
          hi = max(hi, neighbour);
        }
      }
      vec3 history = clamp(texture2D(historyBuffer, previousUv).rgb, lo, hi);

      gl_FragColor = vec4(mix(history, current.rgb, uBlend), current.a);
    }
  `,
};

export class TemporalResolvePass extends Pass {
  /** The scene camera. Not `camera`: the base class owns that name for its own quad. */
  private readonly view: THREE.PerspectiveCamera;
  private readonly history: [THREE.WebGLRenderTarget, THREE.WebGLRenderTarget];
  private readonly copy = new CopyPass();
  private readonly resolveMaterial: THREE.ShaderMaterial;
  private readonly previousViewProjection = new THREE.Matrix4();
  private readonly inverseViewProjection = new THREE.Matrix4();
  private index = 0;
  private frame = 0;
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

    this.resolveMaterial = new THREE.ShaderMaterial({
      name: 'TemporalResolveMaterial',
      uniforms: {
        inputBuffer: { value: null },
        historyBuffer: { value: null },
        depthBuffer: { value: null },
        uInverseViewProjection: { value: this.inverseViewProjection },
        uPreviousViewProjection: { value: this.previousViewProjection },
        uTexelSize: { value: new THREE.Vector2() },
        uReset: { value: 1 },
        uBlend: { value: BLEND },
      },
      vertexShader: RESOLVE_SHADER.vertexShader,
      fragmentShader: RESOLVE_SHADER.fragmentShader,
      depthWrite: false,
      depthTest: false,
    });
    this.fullscreenMaterial = this.resolveMaterial;
  }

  /**
   * Nudge the projection before the scene is drawn, and remember the matrix it was drawn
   * with. Called from a pass placed ahead of the scene render, because by the time this
   * pass itself runs the frame has already been rasterised.
   */
  beginFrame(width: number, height: number): void {
    const [x, y] = JITTER[this.frame % JITTER_SAMPLES];
    this.frame++;
    // setViewOffset shifts the frustum by a fraction of a pixel without touching the field
    // of view, which is what keeps the nudge invisible in everything except the sampling.
    this.view.setViewOffset(width, height, x, y, width, height);
    this.view.updateMatrixWorld();
    this.inverseViewProjection
      .multiplyMatrices(this.view.projectionMatrix, this.view.matrixWorldInverse)
      .invert();
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
    this.copy.setSize(width, height);
    this.resolveMaterial.uniforms.uTexelSize.value.set(1 / width, 1 / height);
    this.reset();
  }

  override setDepthTexture(
    depthTexture: THREE.Texture,
    depthPacking = THREE.BasicDepthPacking
  ): void {
    this.resolveMaterial.uniforms.depthBuffer.value = depthTexture;
    void depthPacking;
  }

  override initialize(
    renderer: THREE.WebGLRenderer,
    alpha: boolean,
    frameBufferType: number
  ): void {
    this.copy.initialize(renderer, alpha, frameBufferType);
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
    this.copy.render(renderer, write, this.renderToScreen ? null : outputBuffer);

    this.previousViewProjection.multiplyMatrices(
      this.view.projectionMatrix,
      this.view.matrixWorldInverse
    );
    this.index = 1 - this.index;
    this.needsReset = false;
  }

  override dispose(): void {
    for (const target of this.history) target.dispose();
    this.copy.dispose();
    this.resolveMaterial.dispose();
    super.dispose();
  }
}
