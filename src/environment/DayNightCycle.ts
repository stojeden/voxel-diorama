import * as THREE from 'three';
import type { QualityProfile } from '../performance/QualityManager';
import type { WallClock01, Clock01, Radians } from '../units';
import { fallbackRandom, type RandomSource } from '../core/Random';
import { EclipseVisual, type EclipseRenderState } from './EclipseVisual';
import { Sky } from 'three/addons/objects/Sky.js';
import {
  residentialWindowActivityAt,
  residentialWindowAverageAt,
  type ScheduledWindowMaterial,
} from './CityRhythm';
import {
  antisolarDirectionAt,
  clamp01,
  directSunFactorAt,
  goldenFactorAt,
  nightFactorAt,
  skyColorAt,
  sunColorAt,
  sunDirectionAt,
  sunElevationAt,
} from './sky';
import { beamTransmittanceColor, twilightSkyColorCached } from './SunlightSpectrum';
// Geometry only, and a pure function: the umbra's traverse has to be normalised against the
// separation at which the moon's disc first contains the sun's, and reading that back off the
// timeline's own coverage law is what keeps this file out of `EclipseTimeline.ts`.
// The class comes in as a type only -- it is erased at build and costs no bytes -- so that the
// doc links naming it below resolve instead of dangling, which is how a link to a constant
// named ECLIPSE_SKY_LEVEL, a symbol that never existed anywhere in this repository, survived in
// this file for as long as it did.
import { eclipseCoverageAtSeparation, type EclipseTimeline } from '../experience/EclipseTimeline';

/**
 * Full day/night lighting rig:
 *  - physically-inspired atmosphere (three.js Sky — Rayleigh/Mie scattering,
 *    which is what makes the sunrise & golden hour actually glow),
 *  - sun + moon directional lights, ambient & hemisphere fill,
 *  - moon with real phases (shader-lit crescent),
 *  - star field, occasional shooting stars, optional aurora,
 *  - throttled PMREM environment map so glass/windows pick up real
 *    sky reflections as the light changes.
 */

export interface DayLightState {
  night: number;
  golden: number;
  sunElevation: Radians;
  /** 0..1 direct solar transmission after cloud/theme/eclipse attenuation. */
  directSun: number;
  /** 0..1 — current solar-eclipse strength (0 = no eclipse). */
  eclipse: number;
}

export interface DayNightHooks {
  streetLights: THREE.PointLight[];
  streetGlowMesh: THREE.InstancedMesh;
  streetGlowMaterial: THREE.ShaderMaterial;
  busStopLights: THREE.PointLight[];
  busStopGlowMaterials: THREE.MeshStandardMaterial[];
  stationLights: THREE.PointLight[];
  stationGlowMaterials: THREE.MeshStandardMaterial[];
  stationGlowMesh: THREE.InstancedMesh;
  stationGlowMaterial: THREE.ShaderMaterial;
  windowLights: THREE.PointLight[];
  /** Residential window groups controlled by the simulated city clock. */
  windowGlowMaterials: ScheduledWindowMaterial[];
}

const STAR_COUNT = 700;
const SHOOTING_STAR_POOL = 3;
const ENVIRONMENT_INTENSITY = 0.42;
const ENVIRONMENT_TRANSITION_SECONDS = 1.8;
const ENVIRONMENT_BLEND_CACHE_KEY = 'pmrem-crossfade-v1';

const ENVIRONMENT_BLEND_UNIFORMS = /* glsl */ `
  #if defined( USE_ENVMAP ) && defined( ENVMAP_TYPE_CUBE_UV )
    uniform sampler2D environmentMapNext;
    uniform float environmentMapBlend;
  #endif
`;

function blendedEnvironmentShaderChunk(): string {
  const irradianceSample =
    'vec4 envMapColor = textureCubeUV( envMap, envMapRotation * worldNormal, 1.0 );';
  const radianceSample =
    'vec4 envMapColor = textureCubeUV( envMap, envMapRotation * reflectVec, roughness );';
  let chunk = THREE.ShaderChunk.envmap_physical_pars_fragment;

  if (!chunk.includes(irradianceSample) || !chunk.includes(radianceSample)) {
    throw new Error('Three.js environment shader changed; PMREM crossfade needs updating');
  }

  chunk = chunk.replace(
    irradianceSample,
    /* glsl */ `
      vec4 envMapColor = textureCubeUV( envMap, envMapRotation * worldNormal, 1.0 );
      if ( environmentMapBlend > 0.0001 ) {
        vec4 nextEnvironmentColor = textureCubeUV(
          environmentMapNext,
          envMapRotation * worldNormal,
          1.0
        );
        envMapColor = mix( envMapColor, nextEnvironmentColor, environmentMapBlend );
      }
    `
  );
  return chunk.replace(
    radianceSample,
    /* glsl */ `
      vec4 envMapColor = textureCubeUV( envMap, envMapRotation * reflectVec, roughness );
      if ( environmentMapBlend > 0.0001 ) {
        vec4 nextEnvironmentColor = textureCubeUV(
          environmentMapNext,
          envMapRotation * reflectVec,
          roughness
        );
        envMapColor = mix( envMapColor, nextEnvironmentColor, environmentMapBlend );
      }
    `
  );
}

const BLENDED_ENVIRONMENT_SHADER_CHUNK = blendedEnvironmentShaderChunk();

/** Where the Preetham sky writes its result; all three sky patches hang off this line. */
const SKY_OUTPUT_MARKER = 'gl_FragColor = vec4( texColor, 1.0 );';
/** The last uniform of the stock fragment shader; the patches declare theirs after it. */
const SKY_UNIFORM_MARKER = 'uniform float time;';

/**
 * The largest radiance the probe's sky is allowed to emit.
 *
 * A half-float render target -- which is what every PMREM target is -- holds 65504 and no
 * more. Preetham's solar disc is `vSunE * 19000 * Fex`, and after the shader's final
 * `* 0.04` that clears 65504 as soon as the sun is about twenty degrees up: measured
 * 44 926 at an elevation of 16.7 degrees and over the ceiling at 26.6.
 *
 * What happens next is not the same on every rasteriser, which is why this hid for so long.
 * Storing an over-range float as a half gives +Inf on an Apple M1 (measured: 4 texels
 * flagged over-range, zero NaN, scene renders) and NaN on SwiftShader (the same 4 texels,
 * all NaN). PMREM then convolves those 4 NaN texels into 10 126 of the atlas's 786 432, the
 * environment map poisons every physical material's IBL term, and the frame comes back
 * black -- 94.4 per cent of it under luminance 8, with 621k triangles still drawn.
 *
 * 60000 is under the ceiling, exactly representable as a half (the spacing up there is 32),
 * and above every radiance the sky has been measured to produce short of the disc itself.
 * Nothing is given up: the disc still reaches the probe, it simply stops overflowing. The
 * blur that follows is a weighted average, so no later stage can climb back over the limit.
 */
const ENVIRONMENT_RADIANCE_CEILING = 60000;
/** What the clamp above leaves behind, so a later patch can refuse to land after it. */
const CEILING_CLAMP = 'min( texColor';

/**
 * Hold the probe sky's output inside what a half-float target can store.
 *
 * Exported for the test that pins the marker: if a Three.js upgrade renames that line the
 * patch would silently stop applying, and the failure it prevents is a black frame on one
 * class of GPU only -- exactly the kind that reaches CI and not a desk.
 */
export function withRadianceCeiling(fragmentShader: string): string {
  if (!fragmentShader.includes(SKY_OUTPUT_MARKER)) {
    throw new Error('Three.js Sky shader changed; environment radiance ceiling needs updating');
  }
  return fragmentShader.replace(
    SKY_OUTPUT_MARKER,
    `texColor = ${CEILING_CLAMP}, vec3( ${ENVIRONMENT_RADIANCE_CEILING}.0 ) );
    ${SKY_OUTPUT_MARKER}`
  );
}

/**
 * Where Preetham's sky stops existing: 2.30769 degrees below the horizon.
 *
 * Three.js computes every in-scattering term from `vSunE = sunIntensity( dot( sunDir, up ) )`,
 * and `sunIntensity` is `EE * max( 0, 1 - exp( -( cutoffAngle - zenithAngle ) / steepness ) )`
 * with `cutoffAngle = 1.6110731556870734`. That is pi/2 plus this many radians, so `vSunE`
 * -- and with it `Lin`, the whole of the dome's colour -- is exactly zero from here down.
 * Read off the shipped shader and evaluated: 81.51 at +5 degrees, 26.49 at 0, 15.10 at -1,
 * 3.57 at -2, 0.0000 at -2.308. Sixty-one per cent of civil twilight, unlit.
 */
const PREETHAM_CUTOFF_RAD = 1.6110731556870734 - Math.PI / 2;
const PREETHAM_STEEPNESS = 1.5;

/** `vSunE / EE`: Three.js's own `sunIntensity`, as a fraction of its value at the horizon. */
function preethamSunFraction(elevationRad: Radians): number {
  return Math.max(0, 1 - Math.exp(-(elevationRad + PREETHAM_CUTOFF_RAD) / PREETHAM_STEEPNESS));
}
const PREETHAM_HORIZON_FRACTION = preethamSunFraction(0 as Radians);

/**
 * How much of the dome the twilight model is responsible for: exactly what Preetham lost.
 *
 * Not a ramp anyone chose. It is `1 - vSunE( elevation ) / vSunE( 0 )`, so the two terms sum
 * to one sun's worth of horizon at every elevation between them: 0 at the horizon, 0.430 at
 * -1 degree where `vSunE` still has 57 per cent, 0.865 at -2, and 1 at -2.30769 where
 * `vSunE` reaches zero. Above the horizon it is clamped to zero, so daylight is untouched --
 * bit for bit, since the whole term is multiplied by this.
 */
export function preethamHandoff(elevationRad: Radians): number {
  return clamp01(1 - preethamSunFraction(elevationRad) / PREETHAM_HORIZON_FRACTION);
}

/**
 * How fast twilight dies as a line of sight has to climb to escape Earth's shadow.
 *
 * Earth's shadow is a cone, so a ray leaving the observer at elevation `alpha` into the
 * antisolar azimuth does not clear it until it is `z*` up, and `z*` is fixed by
 * `shadowHeightKm` -- the shadow's height overhead, which that function already returns and
 * a test already pins at 3.9 km for a sun 2 degrees down and 35 km at 6. Small angles give
 * `z* = alpha h / ( alpha - beta )`, so the climb above the shadow is `z* - h = h beta / gap`
 * with `gap` the elevation above the shadow's edge. Toward the sun the shadow's edge is
 * *below* the horizon, `gap` is `alpha + beta`, and `z* - h` comes out negative: nothing to
 * climb, which is the bright twilight arch.
 *
 * How much that climb costs was measured, by extending `twilightSkyColor`'s integral from
 * the observer's zenith to a slanted antisolar line of sight -- same air profile, same
 * tangent-slant tables, same ozone -- and reading the radiance off against elevation:
 *
 * ```
 *   sun -3, radiance relative to its own maximum, and the climb z* - h it needed:
 *     alpha:   5      6      8      10     12     15     20     30
 *     share:   0.006  0.033  0.164  0.353  0.537  0.748  0.931  1.000
 *     z*-h km: 13.1   8.7    5.2    3.7    2.9    2.2    1.5    0.97
 * ```
 *
 * That is `exp( -( z* - h ) / Z )` with Z about 2.2 km here, and fitting the same way at
 * other depressions gives Z = 0.28, 1.13, 2.16 and 3.30 km for a sun 1, 2, 3 and 4 degrees
 * down -- against shadow heights of 0.97, 3.88, 8.74 and 15.56 km. Z tracks the shadow
 * height at about a quarter of it (3.5, 3.4, 4.0, 4.7 times), so the kilometres cancel:
 *
 *   `( z* - h ) / Z = 4 beta / gap`
 *
 * ...and the shadow height leaves the frame arithmetic entirely, having decided its shape.
 * A first draft used a fixed 27 km emission scale instead and it was far too soft: it left
 * 55 per cent of the light in at 6 degrees where this model and the integral both say 2-3.
 */
const TWILIGHT_SHADOW_CLIMB = 4;

/**
 * How fast the Belt of Venus gives its red back to the ozone blue, in radians of elevation.
 *
 * Lee, *Measuring and modeling twilight's Belt of Venus*, Applied Optics 54(4):B194 (2015):
 * a reddish band over the antisolar horizon through clear civil twilight, the bluish-grey
 * dark segment immediately under it, and -- the part a single band colour cannot have --
 * colour and luminance extrema at different elevations. Here the colour extremum sits on the
 * shadow's edge, where the light has grazed the limb, and the luminance extremum is tens of
 * degrees higher, where there is more sunlit air in view.
 *
 * The number is fitted, not chosen. Extending `twilightSkyColor`'s integral from the
 * observer's zenith to a slanted antisolar line of sight -- same absorbers, same tables --
 * and reading the red fraction out of the resulting R/B gives an e-folding of
 *
 * ```
 *   sun:       -2      -3      -4
 *   fit (rad): 0.1435  0.1595  0.2305     (means over view elevations 8, 10, 12, 15, 20 deg)
 * ```
 *
 * 0.20 sits at the top of that range, and deliberately so: that integral is single
 * scattering with no stratospheric aerosol, and `SunlightSpectrum` names the missing layer
 * itself -- "the aerosol layer that makes the purple light". Adding a 20 km aerosol layer to
 * the same integral widens the fit to 0.188 / 0.219 / 0.344 at the same three depressions.
 * So 0.20 is the single-scattering fit carrying the layer that single scattering leaves out,
 * and it is the one number here that a measurement did not hand over on its own.
 */
const TWILIGHT_BELT_FALLOFF_RAD = 0.2;

/**
 * The radiance the hand-off has to be worth, so the dome does not step at -2.308 degrees.
 *
 * `twilightSkyColorCached` returns brightness relative to the same column at sunset, so one
 * number turns it into the shader's own units: what Preetham puts at the zenith with the sun
 * exactly on the horizon, divided by the luminance of the hue this replaces it with.
 * Measured on the live dome with tone mapping off, at the diorama's own sunset uniforms
 * (turbidity 4.64, rayleigh 3.55, mie 0.0160, weather clear): with the sun at -0.0011
 * degrees the zenith comes back at linear (0.0080, 0.0179, 0.0339), luminance 0.01699. The
 * hue it hands over to is (0.2312, 0.5417, 1.0000), luminance 0.5083, and the zenith keeps
 * 0.992 of the term, so the scale is 0.01699 / ( 0.992 * 0.5083 ).
 */
const TWILIGHT_SUNSET_RADIANCE = 0.0337;

/**
 * Carry the twilight model onto the dome, in the two places Preetham gets it wrong.
 *
 * **Where it goes.** Three patches now hang off `SKY_OUTPUT_MARKER` and their order is not
 * arbitrary. This one runs FIRST, before `withRadianceCeiling`, because it is the only one of
 * the three that *adds* radiance: the ceiling has to stay downstream of it or item 11's
 * half-float overflow comes back through a new door. The eclipse patch, which only ever mixes
 * toward a darker colour, stays where it is between the clamp and the write.
 *
 * **What it draws.** Two things Preetham cannot:
 *
 *  - the zenith twilight, from `twilightSkyColorCached` -- the Chappuis-band model that
 *    already drives the fog and the fills. Hue only; the brightness comes from the hand-off.
 *  - Earth's shadow and the Belt of Venus over the antisolar horizon. `gap` is the view
 *    elevation above the shadow's edge, which is at the solar depression on the antisolar
 *    side and below the horizon on the sunlit side -- one `dot` with the sun's azimuth does
 *    both. `exp( -K / gap )` is the sunlit air a line of sight can see, zero inside the
 *    shadow and rising through the dark segment's edge; `exp( -gap / 0.2 )` is how much of
 *    that light came the reddened way, over the limb.
 *
 * **It has to go at the output write and not one line earlier.** Three.js's own cloud block
 * sits between the composition and the write, and nothing here drives its uniforms -- read
 * off the live material, `cloudCoverage` and `cloudDensity` are still the stock 0.4. Its
 * `cloudColor *= vSunE * 0.00002` is zero through all of this, so anything added before it
 * would be multiplied toward black across 40 per cent of the sky above the horizon in a
 * noise pattern. (That block also runs a five-octave fbm twice -- 40 `sin` per sky fragment
 * -- for a cloud layer the diorama never asked for. Not this change's to remove.)
 *
 * Preetham paints the antisolar horizon red and pales upward -- measured R/B 3.96 at 3
 * degrees of elevation against 1.14 at 15. This is that gradient the right way up.
 */
export function withTwilightDome(fragmentShader: string): string {
  if (
    !fragmentShader.includes(SKY_OUTPUT_MARKER) ||
    !fragmentShader.includes(SKY_UNIFORM_MARKER) ||
    // Refuse to go second. Both orders compile and render; only this one keeps the clamp
    // downstream of the addition, and the other one's failure is a black frame on somebody
    // else's GPU. Cheaper to make it impossible than to notice it.
    fragmentShader.includes(CEILING_CLAMP)
  ) {
    throw new Error('twilight dome: Sky shader changed, or the ceiling came first');
  }
  const limb = beamTransmittanceColor(0 as Radians);
  const peak = Math.max(...limb);
  return fragmentShader
    .replace(SKY_UNIFORM_MARKER, `${SKY_UNIFORM_MARKER}\nuniform vec3 twilight,twilightHue;`)
    .replace(
      SKY_OUTPUT_MARKER,
      `if ( twilight.x > 0.0 ) {
float anti = -dot( direction.xz, vSunDirection.xz ) / ( length( direction.xz ) + 1e-4 );
float gap = max( direction.y - twilight.y * anti, 1e-4 );
texColor += twilight.x * exp( -max( twilight.z * anti / gap, 0.0 ) ) * mix( twilightHue,
vec3( ${limb.map((c) => (c / peak).toFixed(4)).join()} ), exp( -gap / ${TWILIGHT_BELT_FALLOFF_RAD} ) );
}
${SKY_OUTPUT_MARKER}`
    );
}

/**
 * The dome's eclipse patch: an **attenuation plus a skyglow**, where it used to be a crossfade.
 *
 * `mix( texColor, eclipseSky, blend )` cannot darken a sky. Whatever `blend` is, `1 - blend` of
 * a full-brightness daytime dome survives it, and at the eclipse's own hour that remainder was
 * the brightest thing in the frame by a wide margin. Measured on the built bundle at the
 * `totality` checkpoint, with the fills already corrected: the crossfade left 14.2 per cent of
 * the uneclipsed Preetham dome, and taking that one term to zero moved the *whole frame* from
 * 0.4393 of the uneclipsed hour to 0.0998. A seventh of the sky was carrying four fifths of
 * the light, which is why the eighth of the frame lying across the horizon was the least
 * darkened part of the picture at 0.7049 while the top eighth was already at 0.1981.
 *
 * It is also why every constant in the old form was a knife edge: 0.88 to 1.0 on `blend` is a
 * 4.4x move on the whole frame. The replacement scales the dome by the light the eclipse
 * actually leaves it and *adds* the glow the umbra sits under, which is what those two
 * quantities physically are:
 *
 *     texColor * eclipseSkyFlux + eclipseSky * eclipseDarkness
 *
 * The dome takes **`irradiance`, not {@link eclipseDiffuseFraction}**: the umbral skyglow the
 * fills floor on is, for the dome, the `eclipseSky` term standing right beside it, and giving
 * it to both would count the same light twice.
 *
 * **Why `eclipseSkyFlux` is its own uniform and not `1.0 - eclipseDarkness`.** The two are the
 * same quantity, and the double negation was the reason a reviewer reading only the shader
 * could not see that the dome was already being scaled by the surviving solar flux -- which is
 * the thing the physics asks for and the thing a reader has to be able to check. It is also
 * not bit-identical: the CPU sends `1 - irradiance` as a float32 and the shader undoes it, so
 * an irradiance of 0.025 comes back as 0.025000005960464478. Six per cent of a code level at
 * the eclipse hour, and zero reason to pay it when the flux itself is one uniform away.
 *
 * `eclipseSkyFlux` is exactly 1 and `eclipseDarkness` exactly 0 with no eclipse running, so an
 * uneclipsed dome is `texColor * 1.0 + eclipseSky * 0.0` -- an exact identity in IEEE 754, not
 * an approximate one, which is what lets an uneclipsed day be unchanged rather than nearly
 * unchanged.
 *
 * **The ring has a bearing now.** See {@link umbraWallDistanceKm}: one scalar per azimuth, the
 * horizontal distance to the umbra's wall, sets the ring's colour, its brightness and its
 * height together, and the traverse across the umbra swings the asymmetry through 180 degrees
 * between second and third contact. The term it replaces was
 * `vec3( 0.55, 0.15, 0.055 ) * pow( 1.0 - abs( direction.y ), 12.0 )`, the same 360-degree
 * sunset in every direction at every instant of totality.
 *
 * That `pow` is also gone for a second reason, which is cheap hardening rather than a defect
 * anyone reproduced: `pow` with a negative base is undefined in GLSL, and a `normalize()`
 * rounding `abs( direction.y )` to just over 1 would have handed it one. The replacement is an
 * `exp` of a non-positive argument, which is in `[0, 1]` for every finite input including
 * `|y| > 1`, so there is no value of `direction` that can put a NaN on the dome -- and a NaN
 * there multiplies through `eclipseDarkness` even when that is 0.
 *
 * Exported for the same reason as {@link withTwilightDome}: the patch is a pure string
 * transform, so the test suite can hold it against the real shader Three.js ships and fail
 * here rather than in a browser.
 */
export function withEclipseSky(fragmentShader: string): string {
  if (
    !fragmentShader.includes(SKY_OUTPUT_MARKER) ||
    // Refuse to go first. This patch *sums* -- `+ eclipseSky * eclipseDarkness` -- so it is
    // the second term downstream of the ceiling that adds radiance, after the twilight dome.
    // It is safe because the sum is a convex combination of an already-clamped `texColor` and
    // a constant far below the ceiling, and that argument only holds while the clamp really is
    // upstream. Both orders compile and render; the wrong one's failure is a black frame on
    // somebody else's rasteriser, so it is cheaper to make it impossible than to notice it.
    !fragmentShader.includes(CEILING_CLAMP)
  ) {
    throw new Error('Three.js Sky shader changed; eclipse atmosphere patch needs updating');
  }
  return fragmentShader
    .replace(
      'uniform float time;',
      `uniform float time;
        uniform float eclipseDarkness;
        uniform float eclipseTotality;
        uniform float eclipseSkyFlux;
        uniform vec2 eclipseUmbra;`
    )
    .replace(
      SKY_OUTPUT_MARKER,
      // Written tight, like the twilight patch above it: shader source is a string literal and
      // ships to the browser byte for byte, so the reasoning lives in the docblock instead.
      // `eclipseUmbra` is ( semi-major axis, observer offset along it ), km, along the sun's
      // bearing. `umbraWall` is the positive root of |here + wall * step| = 1 on the footprint
      // scaled to a unit circle; its outer max is insurance, so the ring cannot exceed its gain.
      //
      // `uV` falls back to the sun's own bearing rather than dividing by a softened length.
      // Straight up and straight down have an exactly-zero horizontal component, and
      // `xz / ( 0 + 1e-4 )` is vec2( 0 ), not a unit bearing: the solve then divides 0 by
      // `max( uQ, 1e-9 )` and returns a wall distance of 0 -- the observer standing ON the
      // umbra wall, the one state UMBRA_TRAVERSE_LIMIT exists to forbid, where `exp( -0 * x )`
      // is 1 and the ring reaches its full gain. The true limit as the ray goes vertical is an
      // infinitely distant wall, so the code returned the opposite of it and a ray that
      // cancelled to exact zero put rgb( 208, 208, 209 ) at the pole of an rgb( 0, 6, 24 ) sky.
      // With a real bearing the wall is 69 km or more and the height term, tan( elevation ) / 8,
      // takes the ring to zero at the pole on its own.
      `vec2 uS = normalize( vSunDirection.xz + vec2( 1e-5 ) );
float uLen = length( direction.xz );
vec2 uV = uLen > 1e-4 ? direction.xz / uLen : uS;
vec2 uStep = vec2( dot( uV, uS ) / eclipseUmbra.x,
dot( uV, vec2( -uS.y, uS.x ) ) / ${UMBRA_SEMI_WIDTH_KM}.0 );
float uHere = eclipseUmbra.y / eclipseUmbra.x, uQ = dot( uStep, uStep ), uD = uStep.x * uHere;
float uWall = max( ( sqrt( max( uD * uD + uQ * ( 1.0 - uHere * uHere ), 0.0 ) ) - uD )
/ max( uQ, 1e-9 ), 0.0 ), uUp = abs( direction.y );
vec3 eclipseZenith = vec3( ${ECLIPSE_UMBRAL_ZENITH.join()} );
vec3 eclipseRing = exp( -uWall * ( vec3( ${ECLIPSE_RING_EXTINCTION_PER_KM.join()} )
+ uUp / ( ${ECLIPSE_RING_SCALE_HEIGHT_KM}.0 * sqrt( max( 1.0 - uUp * uUp, 1e-4 ) ) ) ) )
* ${ECLIPSE_RING_GAIN};
vec3 eclipseSky = eclipseZenith + eclipseRing * eclipseTotality;
texColor = texColor * eclipseSkyFlux + eclipseSky * eclipseDarkness;
${SKY_OUTPUT_MARKER}`
    );
}

/**
 * How much world one shadow-map texel covers, in metres.
 *
 * Worth having as a function because every number that matters downstream is derived
 * from it -- the bias that hides what the map cannot draw, and the grid the focus is
 * snapped to -- and because the value is not the one the constructor suggests: the
 * quality profile overrides the map size, and the frustum radius follows the camera.
 */
export function shadowTexelSize(radius: number, mapSize: number): number {
  return (radius * 2) / Math.max(1, mapSize);
}

/**
 * How far the normal bias has to push a shadow lookup off its surface.
 *
 * In texels, not metres, because that is what the artefact is measured in: a feature
 * thinner than a texel cannot be drawn at any map size, so the number that removes it
 * has to grow with the texel. 1.5 was photographed, not guessed -- see the call site.
 */
export function shadowNormalBias(texel: number): number {
  return texel * 1.5;
}

/** What a cloud deck does to daylight, as three multipliers on the clear-sky rig. */
export interface CloudDaylight {
  /** Multiplies the direct beam. 1 under a clear sky, 0 under full overcast. */
  beam: number;
  /** Multiplies the *daylight half* of both fill lights. 1 clear, 5/3 full overcast. */
  fill: number;
  /** `sunLight.shadow.radius`, in shadow-map texels. 1 clear, 3 full overcast. */
  penumbra: number;
}

/**
 * Cloud cover moves three things, and before this it moved one.
 *
 * Measured on a running page (`document.hidden === false`, `elapsedSimulation` advancing),
 * classic theme, noon, sun at 61.21 degrees, clear (cover 0.12) against rain (cover 0.92):
 * `sunLight.intensity` 2.036 -> 0.945, `ambientLight.intensity` 0.660 -> 0.660,
 * `hemisphereLight.intensity` 0.720 -> 0.720, `castShadow` true -> true. The old beam term
 * was a flat `1 - cloudCover * 0.62`; neither fill light had a cloud term at all, and the
 * shadow gate was fed `sunStrength * eclipseIrradiance`, which does not mention cloud. So
 * an overcast noon was a darker copy of a sunny noon wearing the same hard shadows, which
 * is the one thing an overcast noon is not.
 *
 * The numbers below are one published relation plus two standard endpoints. None is taste.
 *
 * **The relation.** Kasten & Czeplak (1980), *Solar Energy* 24, 177-189, fit global
 * horizontal irradiance to cloud amount N in oktas as `G / G_clear = 1 - 0.75 (N/8)^3.4`.
 * At full overcast that is 0.25 of clear.
 *
 * **The endpoints.** Clear noon daylight is about 100 000 lux, of which the diffuse sky is
 * the standard clear-sky diffuse fraction of about 0.15 -- 85 000 lux of beam over 15 000
 * of sky. Full overcast is 10 000 to 25 000 lux and has **no solar disc in it at all**:
 * the CIE Standard Overcast Sky is a pure luminance distribution,
 * `L(theta) = L_zenith (1 + 2 cos theta) / 3`, with no sun term. Kasten & Czeplak's own
 * 0.25 puts overcast at 25 000 lux, the top of that band, so the two sources meet at the
 * endpoint and 25 000 is the figure used here.
 *
 * Interpolating both components on Kasten & Czeplak's own `u = (N/8)^3.4`, in klux:
 *
 *     G(u) = 100 - 75u          their relation
 *     D(u) =  15 + 10u          15 klux of clear sky -> 25 klux of overcast sky
 *     B(u) = G - D = 85 (1 - u)
 *
 * which is `beam = 1 - u` and `fill = 1 + (10/15) u = 1 + (2/3) u`. The beam reaches zero
 * because overcast is *defined* by the disc being gone, and the fill rises by two thirds
 * because a deck turns the beam into sky rather than swallowing it. That second number is
 * the whole point: the sky takes over as the source, so the scene loses its shadow without
 * simply going dark.
 *
 * **`u` is taken over this product's dial, not over oktas.** `WEATHER` in Weather.ts reads
 * clear 0.12, fog 0.55, cloudy 0.78, snow 0.85, rain 0.92 -- so 0.92 is the heaviest deck
 * this product can ask for, and it means a nimbostratus rain deck, not 7.4 oktas of
 * scattered cumulus. Read literally as oktas, 0.92 would give `u = 0.75`, leave 25 per
 * cent of the beam standing and keep the hard shadow -- the right answer for broken cloud
 * and the wrong one for rain. Mapping 0.12 to no cloud and 0.92 to full overcast is what
 * makes the dial mean what the product uses it for. It is deliberately *not* clamped at
 * the low end only: cover below 0.12 never occurs, and `clamp01` keeps both ends safe.
 *
 * **`penumbra` is an angle in disguise.** A shadow edge blurs over `d * theta` metres at
 * distance `d` under an occluder, where `theta` is the source's angular diameter. The sun
 * is 0.53 degrees, so a 10 m block casts a 0.0925 m penumbra. Measured live on the High
 * profile, the shadow frustum settles at 69.41 m of radius on a 1024 map -- 0.13557 m per
 * texel -- so the sun's own penumbra is 0.68 of one texel and is *below the grid*. That is
 * why clear sky keeps `radius = 1`: the rig is already as sharp as the sun is, and no
 * smaller number buys anything. Growing the radius is therefore the only direction that
 * means something, and in three r185 (`shadowmap_pars_fragment.glsl.js`) PCFShadowMap
 * spends it on five Vogel-disk samples, outermost at `sqrt(0.9) = 0.949` of the radius,
 * rotated per pixel by interleaved gradient noise. Five rotated samples over a wider disk
 * buy blur at the price of dither, not of banding, which is why this stops at 3 rather
 * than at the 5-to-10 degrees a real thick deck subtends: past there the deck is opaque
 * enough that `beam` takes the shadow off the gate entirely. Measured, at noon that
 * happens at cover 0.908, so the widest penumbra ever actually drawn is 2.9 texels.
 */
export function cloudDaylightAt(cloudCover: number): CloudDaylight {
  // Weather.ts: WEATHER.clear.cloud = 0.12 is the dial's floor, WEATHER.rain.cloud = 0.92
  // its ceiling. Kasten & Czeplak's exponent is applied to that span, not to raw cover.
  const u = clamp01((cloudCover - 0.12) / 0.8) ** 3.4;
  // 2/3, not 0.667: it is 10/15 klux exactly, and only the exact value puts the
  // reconstructed global back on `1 - 0.75u` to the last digit -- which the test checks.
  return { beam: 1 - u, fill: 1 + (u * 2) / 3, penumbra: 1 + u * 2 };
}

/**
 * The shadow focus, rounded to whole texels in the light's own basis.
 *
 * Pure and exported so the property can be tested without a renderer: a focus that
 * drifts continuously must come back quantised, or the shadow grid slides through the
 * world and every stepped edge swims. The component along the light is left alone, so
 * the frustum still covers what the camera is looking at.
 *
 * `right`, `up` and `out` are scratch vectors owned by the caller: this runs every frame.
 */
export function snapShadowFocus(
  focus: THREE.Vector3,
  sunDir: THREE.Vector3,
  texel: number,
  right: THREE.Vector3,
  up: THREE.Vector3,
  out: THREE.Vector3
): THREE.Vector3 {
  // With the sun overhead the usual world-up reference degenerates, so fall back to
  // another axis rather than normalising a zero.
  right.set(0, 1, 0).cross(sunDir);
  if (right.lengthSq() < 1e-6) right.set(1, 0, 0).cross(sunDir);
  right.normalize();
  up.copy(sunDir).cross(right).normalize();
  const grid = Math.max(1e-6, texel);
  const alongRight = Math.round(focus.dot(right) / grid) * grid;
  const alongUp = Math.round(focus.dot(up) / grid) * grid;
  const alongLight = focus.dot(sunDir);
  return out
    .copy(right)
    .multiplyScalar(alongRight)
    .addScaledVector(up, alongUp)
    .addScaledVector(sunDir, alongLight);
}

/**
 * How much of the hour's own diffuse light an eclipse leaves: sky fill, hemisphere, reflections.
 *
 * **During a partial phase the diffuse sky falls with the beam, and that is not an
 * approximation.** The moon's penumbra is thousands of kilometres across, so every parcel of
 * air the camera can see scattering -- the whole sky dome, out to the horizon and up through
 * the scattering height -- is lit by the *same* partially covered sun. Beam and skylight are
 * the same quantity attenuated by the same factor, and that factor is the `irradiance`
 * {@link EclipseTimeline} already computes from the overlap area. The sun light has always
 * used it; the fills used a separate, much shallower ramp, and that is the whole defect.
 *
 * **Deep coverage is where they separate, and that is what the floor is.** The umbra is only
 * 100-270 km wide, so an observer near the middle of it stands in a small dark spot under a sky
 * that is still lit everywhere beyond it. That surviving light is the 360-degree horizon glow,
 * and it is the real reason totality is not black -- not the corona, which carries roughly a
 * full moon's 0.25 lx, 3.5e-5 of this hour's own 7 094 lx and far below anything this rig can
 * represent.
 *
 * **It is a `max`, and it has to be, because a sum is not monotonic.** The first version of
 * this function was `irradiance + UMBRAL_SKYGLOW * totality`, which reads well and is wrong:
 * `irradiance` bottoms out at {@link EclipseTimeline}'s own 0.025 floor, so it has only 0.004
 * left to give across second contact while the skyglow term adds a whole 0.105 -- the diffuse
 * light *rises* 0.0291 to 0.130 as the moon finishes covering the sun. That is the same defect,
 * in the same direction, as the non-monotonic ambient fill this change was written to remove;
 * it simply hid one phase later. A floor cannot do it: `max` of a decreasing function and a
 * constant is decreasing, for every coverage, by construction.
 *
 * The floor binds only in the last 18 per cent of coverage -- `irradiance` is above 0.130 until
 * coverage 0.820 -- so every partial phase before that is the beam's own attenuation,
 * untouched. What the plateau costs is that the fills stop falling there; what keeps the
 * approach to totality dramatic anyway is that nothing else plateaus with them. The sun keeps
 * falling to 0.025, and the dome keeps falling on `irradiance` right through second contact,
 * because it takes {@link withEclipseSky}'s own term and not this one.
 *
 * **The floor is 0.130 and the number is chosen, not found -- say so.** Published horizontal
 * illuminance at totality is 1 to 100 lx, against 7 094 lx at this eclipse's own +8.82 degrees
 * and 88 796 at a June noon (log-interpolated from the table in `./ViewerAdaptation`, which is
 * where those anchors live). So the *physical* fraction is 1.4e-4 to 1.4e-2, and the whole band
 * reads back off the same table as a sun between -7.21 and -1.74 degrees: real totality is
 * twilight, and darker than any frame this product can ship.
 *
 * 0.130 stops well short of that. With the bracket terms around it the fills land at 7.7 to
 * 13.0 per cent of the uneclipsed hour -- 549 to 922 lx, which the table reads back as a sun
 * between +0.87 and +2.28 degrees. **Totality here is sunrise, not twilight: 5.5x the light of
 * the brightest real totality and 549x the dimmest.** The honest name for that gap is
 * legibility, not physics, and the number that sets it is this one, in one place, rather than
 * the six tuning constants spread across four systems that it replaces.
 *
 * `irradiance` is exactly 1 whenever no eclipse is running and the floor is far below it, so
 * this returns exactly 1.0 and every uneclipsed hour multiplies by it bit for bit.
 */
export function eclipseDiffuseFraction(irradiance: number): number {
  return irradiance > UMBRAL_SKYGLOW ? irradiance : UMBRAL_SKYGLOW;
}

/**
 * The fraction of an unobstructed sky's light that reaches the middle of the umbra.
 *
 * Not a legibility floor bolted under a curve: it is the light scattered in from the atmosphere
 * outside a 100-270 km shadow, which is a real term with a real value. See
 * {@link eclipseDiffuseFraction} for why it is 0.130 rather than the 1.4e-4 the lux figures ask
 * for, and for what 0.130 costs in honesty.
 *
 * It is deliberately **not** applied to the sky dome, which carries its own, explicit skyglow in
 * {@link ECLIPSE_UMBRAL_ZENITH} and {@link ECLIPSE_RING_GAIN}; giving the dome both would count
 * the same light twice.
 */
const UMBRAL_SKYGLOW = 0.13;

/**
 * The isotropic umbral sky: what the dome is at totality everywhere the ring is not.
 *
 * **One term, where the shipped dome had two.** Until this change the patch added *both* an
 * authored partial-phase tint, `vec3( 0.004, 0.009, 0.035 )`, and a totality-only
 * `ECLIPSE_UMBRAL_SKY = vec3( 0.035, 0.055, 0.172 )` on top of it. Those are the same light --
 * the multiply-scattered blue-violet that reaches the middle of the umbra from outside it --
 * counted twice, and the double count is exactly the defect a verifier measured on the built
 * pair: the top eighth of the frame went from 0.2928 of the uneclipsed hour to 0.3730, mean
 * luma 69.14 to 88.08, and a star-peak count over that region fell 42 to 36. **The zenith got
 * brighter at totality, which is backwards.**
 *
 * The arithmetic, in the dome's own linear units and at `eclipseDarkness` 0.975: the parent's
 * authored zenith was 0.858 * ( 0.004, 0.009, 0.035 ) = ( 0.0034, 0.0077, 0.0300 ) and this
 * build's was 0.975 * ( 0.039, 0.064, 0.207 ) = ( 0.0380, 0.0624, 0.2018 ) -- 6.7 times the
 * blue. The surviving Preetham dome beside it went the right way over the same change (2.5 per
 * cent of a five times brighter dome is 0.88 of the 14.2 per cent the crossfade used to leave),
 * so the regression is entirely this pair of terms and not the dome scale.
 *
 * **Why the level survives.** Rec709 luminance 0.009814, against the ring's 0.2282 at
 * mid-totality broadside: 23.3x, or 4.54 stops horizon to zenith. The measured figure is 195x
 * (7.6 stops: ~78 cd/m2 of ring against a 0.40 cd/m2 zenith, Applied Optics 10, 1211 (1971) and
 * 14, 2831 (1975)), and the shipped pair spanned 2.13. 4.54 is not 7.6 and the reason is the
 * output, not the taste: the ACES fit this repo tone-maps through, `RRTAndODTFit`, subtracts
 * before it scales, so at the eclipse hour's own exposure of 0.5029 a scene-linear channel
 * under 3.88e-3 presents at display code 0. This constant's blue clears that by 9.0x and its
 * green by 2.3x; a zenith 195 times under the ring would be ( 0.0002, 0.0005, 0.0018 ) and
 * would put the whole sky on code 0, which the standing "no exactly-black pixels" invariant
 * forbids and which would look worse than the error it fixed.
 *
 * This is added at every eclipse phase rather than gated on `eclipseTotality`, so a partial
 * eclipse still reads as a dimmed day rather than a blue one: at coverage 0.5 it arrives at
 * `eclipseDarkness` 0.34 over a dome still carrying 66 per cent of its light.
 */
const ECLIPSE_UMBRAL_ZENITH = [0.004, 0.009, 0.035];

/**
 * Rayleigh extinction at 650, 550 and 440 nm, per kilometre of horizontal sea-level air.
 *
 * The ring's colour *is* this exponential. The light in it is sunlit air outside the umbra seen
 * through however many kilometres of shadowed air stand between: singly scattered sunlight
 * "depleted by scattering in its passage from outside the shadow region" (Shaw et al., *Sky
 * color near the horizon during a total solar eclipse*, Applied Optics 14, 2831 (1975)).
 *
 * One number, 0.0122 km^-1 at 550 nm -- the standard vertical Rayleigh optical depth of 0.0973
 * spread over an 8 km equivalent column -- scaled by lambda^-4 to the other two: 0.0122 *
 * (550/650)^4 = 0.00626 and 0.0122 * (550/440)^4 = 0.0297. So the hue is not authored at all.
 * At the umbra's own half-width of 159 km it comes out ( 0.370, 0.144, 0.0089 ), the deep
 * orange-red of the measured ring; at 300 km it is ( 0.153, 0.026, 0.0001 ) and by 1000 km
 * there is nothing left to see. That single fact is what makes the ring directional.
 */
const ECLIPSE_RING_EXTINCTION_PER_KM = [0.00626, 0.0122, 0.0297];

/**
 * Rayleigh scale height, in kilometres: how fast the ring dies as the sightline climbs.
 *
 * A sightline leaving the observer at elevation theta exits the umbra tube at altitude
 * `L * tan( theta )`, and the sunlit air it meets there has density proportional to
 * `exp( -L tan( theta ) / H )`. At the 159 km wall that is half brightness at **2.0 degrees**
 * and 5 per cent by 8.5 degrees, which is the measured "red color observed in the lowest 8
 * degrees of the sky" of Applied Optics 14, 2831 (1975).
 *
 * The term it replaces, `pow( 1 - abs( direction.y ), 12 )`, was at half value at **3.22**
 * degrees, not the 11.9 an earlier draft of this comment claimed: 11.9 belongs to the
 * exponent-3 term that the change before this one had already removed, and citing it here made
 * the new law look like a six-fold correction when it is not one. Measured against what is
 * actually there, this law is TALLER at the contacts (half at 4.57 degrees off the 69 km wall)
 * and shorter only at mid-totality. What it buys is not height but shape: being a function of
 * elevation alone, the old term was the same in every direction, while here the height, the
 * brightness and the hue all come off the same `L`, so the near wall gives a taller, paler band
 * and the far wall a thinner, redder one.
 */
const ECLIPSE_RING_SCALE_HEIGHT_KM = 8;

/**
 * Half the umbra's true width on the ground, in kilometres, across the sun's bearing.
 *
 * NASA GSFC's path table for 2026-08-12 gives 318 km of path width at 52 deg 22' N, which is
 * this diorama's own latitude (`sky.ts` LATITUDE 52.23). The footprint is not a circle: the
 * umbra is a tube of *constant* cross-section -- the shadow cone's half-angle is the solar
 * semi-diameter, 0.265 degrees, so it narrows by 93 m over the whole 20 km of scattering
 * atmosphere, under 0.1 per cent -- tilted at the sun's own elevation, so it cuts the ground in
 * an ellipse with this as its semi-minor axis and `this / sin( elevation )` along the sun's
 * bearing. At the staged eclipse's 8.82 degrees that is 6.5:1, and the elongation is the reason
 * the sunward and antisolar horizons go black while the broadside horizons carry the ring.
 */
export const UMBRA_SEMI_WIDTH_KM = 159;

/**
 * The smallest `sin( elevation )` the footprint is allowed, so the semi-major axis stays finite.
 *
 * 0.02 is 1.15 degrees, which caps the ellipse at 7 950 km -- a quarter of the way round the
 * Earth, and far past the distance at which {@link ECLIPSE_RING_EXTINCTION_PER_KM} has taken
 * every channel to zero anyway. So the clamp never changes a pixel; it exists because a sun on
 * the horizon would otherwise divide by zero and hand the shader an infinity.
 */
const UMBRA_MIN_SIN_ELEVATION = 0.02;

/**
 * How close to the umbra's wall the traverse is allowed to carry the observer, as a fraction.
 *
 * At the wall itself `L` is zero: the ring reaches its full gain *and* its height law stops
 * falling off, so the band stops being a band and paints the whole dome. That is the failure a
 * reviewer measured on an earlier attempt at this model -- "a clipped rgb(242,231,194) ring at
 * C2/C3", a ring about 16 times too bright that clips to white.
 *
 * 0.9 keeps the nearest wall **69.3 km** away at second and third contact -- broadside, where
 * the footprint is narrowest, `b * sqrt( 1 - 0.81 )`. An earlier draft of this comment said
 * 103.6 km, which is the distance along the MAJOR axis: the wrong wall, and wrong in the
 * unsafe direction, with the test that pins it computing 69.3 two files away. The band is still
 * a band there -- half brightness 4.57 degrees up rather than 2.0 at mid-totality -- and the brightest
 * bearing of the whole traverse presents at rgb(184, 157, 96), which does not clip on any
 * channel. It is a clamp with a picture behind it, not a fudge factor: the observer really is at
 * the shadow's edge at C2, and the sky there really is about to be sunlit.
 */
export const UMBRA_TRAVERSE_LIMIT = 0.9;

/**
 * What the ring's exponential is worth on the dome, at the one bearing that did not change.
 *
 * Derived, not chosen. The uniform ring this replaces was `vec3( 0.55, 0.15, 0.055 )`, Rec709
 * luminance 0.22818, and that level is what the twice-verified whole-frame darkness measurement
 * was taken against. `exp( -beta * 159 )` -- the ring at mid-totality, broadside, where the wall
 * stands at the umbra's own half-width -- has luminance 0.18201, so 0.22818 / 0.18201 = 1.2536
 * is the gain that leaves that one bearing exactly where it was and moves every other one.
 *
 * Every other bearing moves *down*, which is the point: at mid-totality the sunward and
 * antisolar horizons are 1037 km from the wall and go to the zenith's own colour, where before
 * they carried the full 360-degree sunset. The frame loses light by having a shape rather than
 * by having a smaller number in it.
 */
const ECLIPSE_RING_GAIN = 1.2536;

/**
 * Where totality's traverse ends, as a separation: the largest one still fully covering the sun.
 *
 * `EclipseTimeline`'s own `separation` sweeps from -this at second contact through 0 at
 * mid-totality to +this at third contact, and that sweep **is** the observer's position across
 * the umbra -- the one quantity on `EclipseRenderState` that still moves once coverage has
 * pinned at 1. Normalising it needs the endpoint, and the endpoint is a private constant of
 * `EclipseTimeline`.
 *
 * Rather than export it from a file outside this brief, or copy the number and let the two
 * drift, this reads it back out of the timeline's own exported geometry: coverage is 1 exactly
 * while the moon's disc contains the sun's, so the endpoint is the largest separation at which
 * {@link eclipseCoverageAtSeparation} still returns 1. Sixty bisections put it at
 * 0.009287925774, against the 0.009287925697 the timeline's `( MOON_RADIUS - SUN_RADIUS ) /
 * ( SUN_RADIUS + MOON_RADIUS )` gives -- eight significant figures, and it cannot go stale if
 * the moon's radius is ever retuned.
 */
const TOTALITY_SEPARATION = (() => {
  let inside = 0;
  let outside = 1;
  for (let step = 0; step < 60; step++) {
    const middle = (inside + outside) / 2;
    if (eclipseCoverageAtSeparation(middle) >= 1) inside = middle;
    else outside = middle;
  }
  return inside;
})();

/**
 * Where the observer stands across the umbra, from -1 at second contact to +1 at third.
 *
 * Positive is toward the sun's own horizontal bearing, and that sign is a choice rather than a
 * derivation: `separation` is the moon's offset across the sun's disc, and nothing ties its sign
 * to a compass. It is set this way to reproduce the one thing observers report -- "dark to the
 * west and blue to the east" at C2, reversing by C3, for a western sun -- which puts the
 * observer at the antisolar end of the footprint when totality begins and at the sunward end
 * when it ends.
 */
export function umbraTraverse(separation: number): number {
  const normalized = separation / TOTALITY_SEPARATION;
  return normalized < -1 ? -1 : normalized > 1 ? 1 : normalized;
}

/**
 * The semi-major axis of the umbra's ground footprint, in kilometres.
 *
 * {@link UMBRA_SEMI_WIDTH_KM} across the sun's bearing and this along it. The whole azimuthal
 * asymmetry of the ring is this one ratio.
 */
export function umbraSemiMajorKm(sunElevationRad: Radians): number {
  return UMBRA_SEMI_WIDTH_KM / Math.max(Math.sin(sunElevationRad), UMBRA_MIN_SIN_ELEVATION);
}

/**
 * How far the umbra's wall is, horizontally, along one bearing: the whole model in one scalar.
 *
 * The umbra is a tube of constant cross-section, so nothing about the sky at totality varies
 * with bearing except this. It sets the ring's colour through {@link
 * ECLIPSE_RING_EXTINCTION_PER_KM}, its brightness through the same exponential, and its height
 * through {@link ECLIPSE_RING_SCALE_HEIGHT_KM} -- three things that used to be authored apart
 * and are one thing here.
 *
 * `alongSun` and `acrossSun` are the components of a **unit horizontal** view bearing in the
 * sun's own frame. The solve is the positive root of `| here + L * step | = 1` on the footprint
 * scaled to a unit circle, and it is duplicated in GLSL inside {@link withEclipseSky} because a
 * fragment shader cannot call this; the test suite holds the two against each other.
 *
 * Exported for that test, and because the numbers it produces are the ones worth arguing about:
 * at the staged eclipse's 8.82 degree sun the wall is 159 km broadside and 1037 km along the
 * sun's bearing at mid-totality, and 69 km broadside against 104 km antisolar at second contact.
 */
export function umbraWallDistanceKm(
  semiMajorKm: number,
  offsetKm: number,
  alongSun: number,
  acrossSun: number
): number {
  // The bearing is normalised here for the same reason the shader falls back to the sun's own:
  // a zero-length bearing sends `quadratic` to zero, `wall` to 0/1e-9 = 0, and a wall distance
  // of zero is the observer standing ON the umbra wall -- where `exp( -0 * x )` is 1 and the
  // ring reaches full gain. In the shader's coordinates the sun's bearing IS ( 1, 0 ), so this
  // stays a mirror of it rather than a second opinion.
  const bearing = Math.hypot(alongSun, acrossSun);
  const unitAlong = bearing > 1e-4 ? alongSun / bearing : 1;
  const unitAcross = bearing > 1e-4 ? acrossSun / bearing : 0;
  const stepAlong = unitAlong / semiMajorKm;
  const stepAcross = unitAcross / UMBRA_SEMI_WIDTH_KM;
  const here = offsetKm / semiMajorKm;
  const quadratic = stepAlong * stepAlong + stepAcross * stepAcross;
  const cross = stepAlong * here;
  const wall =
    (Math.sqrt(Math.max(cross * cross + quadratic * (1 - here * here), 0)) - cross) /
    Math.max(quadratic, 1e-9);
  return wall > 0 ? wall : 0;
}

/**
 * The ring's radiance along one bearing, in the dome's own linear units.
 *
 * `viewY` is the vertical component of the unit view ray, so `|viewY|` -- the diorama is a
 * floating plate and a good half of the frame is sky *below* the horizon, where the band has to
 * fall off exactly as it does above it. The first draft of the term this replaces used
 * `1 - clamp( direction.y, 0, 1 )`, which is 1 for every downward direction and stood the ring
 * at full strength across the whole lower dome.
 */
export function eclipseRingRadiance(wallKm: number, viewY: number): number[] {
  const up = Math.abs(viewY);
  const climb = up / (ECLIPSE_RING_SCALE_HEIGHT_KM * Math.sqrt(Math.max(1 - up * up, 1e-4)));
  return ECLIPSE_RING_EXTINCTION_PER_KM.map(
    (beta) => Math.exp(-wallKm * (beta + climb)) * ECLIPSE_RING_GAIN
  );
}

export function environmentTransitionAt(progress: number): {
  blend: number;
  intensity: number;
} {
  const clamped = clamp01(progress);
  return {
    blend: clamped * clamped * (3 - 2 * clamped),
    intensity: ENVIRONMENT_INTENSITY,
  };
}

/**
 * Where the night sky is dark enough to be starry, and where an eclipse is dark enough.
 *
 * The threshold is written against `nightFactorAt`, which is a smoothstep between
 * `FULL_NIGHT_ELEVATION_DEG` and `FULL_DAY_ELEVATION_DEG` in `sky.ts`, so the honest way to
 * choose it is to say what solar depression it means and then measure that back. The pair
 * here means: **first star at 4.03 degrees of depression, fully starry at 9.90.**
 *
 * Which is the twilight definition, not a taste. The eye picks up the first naked-eye stars
 * during *civil* twilight (0 to -6) and the sky is properly starry by *nautical* twilight
 * (-6 to -12) -- so first light lands partway through civil, and full strength partway
 * through nautical. The upper anchor is deliberately not -12 itself: at 52.23 north a June
 * sun bottoms out at -14.33, and pinning full stars to the end of nautical twilight would
 * leave a Polish June with a hair's width of properly starry sky.
 *
 * The pair it replaces was `(night - 0.45) / 0.5`, which is **+1.33 degrees** -- the first
 * stars came out with the sun still above the horizon, every day of the year. (Before the
 * 2026-09-12 ramp retune the same constants meant +4.93, in broad daylight; the retune
 * moved the number without fixing it.) Measured over a 200 000-step day, star visibility
 * goes from 7.79 h to 6.21 h in June and 13.93 h to 12.74 h in autumn, and both seasons
 * still reach full strength. The shooting-star gate rides on this alpha too -- it needs
 * 0.6, which moves from -3.84 degrees to -6.90, leaving 5.25 h of June and 12.13 h of
 * autumn to fall in.
 *
 * **An eclipse gets its own arm, and this is the correction the review forced.** Raising the
 * twilight threshold deleted 20.02 s of starfield from every 90 s eclipse: `eclipseStars` is
 * `smootherStep(corona)` and the corona is exactly 0 below progress 0.36, so through the
 * partial phases the only term carrying stars was the *night an eclipse synthesises*
 * (0.4943-0.5048), which cleared the old 0.45 threshold at alpha 0.11 and clears 0.76 at
 * nothing. Worst point measured at progress 0.3665, coverage 0.9852: alpha 0.1098 to 0.
 *
 * So the eclipse keeps the old curve on its own quantity instead of riding the twilight one
 * by accident. That is not a workaround: a sky darkened by the moon crossing the sun and a
 * sky darkened by the earth turning away reach the same brightness by different paths, and
 * the threshold for "a star is visible" belongs to the brightness, not to the cause. What
 * changed is that the eclipse path is now written down rather than inherited.
 */
export function starAlphaAt(
  night: number,
  eclipseStars: number,
  eclipseNight: number,
  cloudCover: number
): number {
  return (
    Math.max(
      clamp01((night - 0.76) / 0.22),
      clamp01((eclipseNight - 0.45) / 0.5),
      eclipseStars * 0.88
    ) * (1 - cloudCover)
  );
}

interface ShootingStar {
  line: THREE.Line;
  material: THREE.LineBasicMaterial;
  velocity: THREE.Vector3;
  life: number;
  maxLife: number;
}

function buildMoonMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uPhaseAngle: { value: Math.PI }, // π = full moon
      uOpacity: { value: 0 },
    },
    vertexShader: /* glsl */ `
      varying vec3 vNormal;
      void main() {
        vNormal = normalize(normalMatrix * normal);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec3 vNormal;
      uniform float uPhaseAngle;
      uniform float uOpacity;
      void main() {
        // Phase light direction in VIEW space, so the crescent always faces
        // the camera the right way round.
        vec3 lightDir = normalize(vec3(sin(uPhaseAngle), 0.12, -cos(uPhaseAngle)));
        float lit = smoothstep(-0.08, 0.18, dot(vNormal, lightDir));
        vec3 bright = vec3(0.92, 0.93, 0.88);
        vec3 dark = vec3(0.055, 0.06, 0.085);
        gl_FragColor = vec4(mix(dark, bright, lit), uOpacity);
      }
    `,
    transparent: true,
    depthWrite: false,
    fog: false,
  });
}

function buildAuroraMaterial(phaseOffset: number): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uStrength: { value: 0 },
      uPhase: { value: phaseOffset },
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      uniform float uTime;
      uniform float uPhase;
      void main() {
        vUv = uv;
        vec3 p = position;
        // Bend the curtain into an arc and let it drift like fabric.
        float arc = uv.x - 0.5;
        p.z -= arc * arc * 90.0;
        p.y += sin(uv.x * 6.0 + uTime * 0.35 + uPhase) * 2.6
             + sin(uv.x * 13.0 - uTime * 0.21 + uPhase * 2.0) * 1.3;
        p.z += sin(uv.x * 3.5 - uTime * 0.26 + uPhase) * 4.0;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec2 vUv;
      uniform float uTime;
      uniform float uStrength;
      uniform float uPhase;

      float hash(vec2 p) {
        return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
      }
      float noise(vec2 p) {
        vec2 i = floor(p);
        vec2 f = fract(p);
        f = f * f * (3.0 - 2.0 * f);
        float a = hash(i);
        float b = hash(i + vec2(1.0, 0.0));
        float c = hash(i + vec2(0.0, 1.0));
        float d = hash(i + vec2(1.0, 1.0));
        return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
      }

      void main() {
        // Slowly evolving large-scale structure + finer ray detail.
        float structure = noise(vec2(vUv.x * 5.0 + uPhase, uTime * 0.05));
        float rays = noise(vec2(vUv.x * 32.0 - uTime * 0.06 + uPhase, vUv.y * 2.0));

        float curtain = 0.5 + 0.5 * sin(vUv.x * 36.0 + structure * 11.0 + uTime * 0.45 + uPhase);
        curtain = pow(max(curtain, 0.0), 1.7) * (0.55 + 0.45 * rays);

        // Feather EVERY edge so the quad never reads as a rectangle.
        float vertical = smoothstep(0.02, 0.3, vUv.y) * (1.0 - smoothstep(0.4, 0.96, vUv.y));
        float horizontal = smoothstep(0.0, 0.18, vUv.x) * (1.0 - smoothstep(0.82, 1.0, vUv.x));
        // Ragged lower hem driven by noise.
        float hem = smoothstep(0.0, 0.16 + 0.2 * structure, vUv.y);

        vec3 green = vec3(0.16, 0.9, 0.42);
        vec3 teal = vec3(0.1, 0.7, 0.65);
        vec3 violet = vec3(0.5, 0.25, 0.85);
        vec3 color = mix(mix(green, teal, structure), violet, clamp(vUv.y * 1.5 - 0.15, 0.0, 1.0));

        float alpha = curtain * vertical * horizontal * hem * uStrength * 0.42;
        gl_FragColor = vec4(color, alpha);
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    fog: false,
  });
}

export class DayNightCycle {
  private readonly random: RandomSource;
  private readonly eventRandom: RandomSource;
  private readonly scene: THREE.Scene;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly hooks: DayNightHooks;

  private readonly sky: Sky;
  private readonly envSky: Sky;
  private readonly envScene: THREE.Scene;
  private readonly pmrem: THREE.PMREMGenerator;
  private envTarget: THREE.WebGLRenderTarget | null = null;
  private envPendingTarget: THREE.WebGLRenderTarget | null = null;
  private envTransitionProgress = 1;
  private envTransitionActive = false;
  private readonly envNextMapUniform: THREE.IUniform<THREE.Texture | null> = { value: null };
  private readonly envBlendUniform: THREE.IUniform<number> = { value: 0 };
  private envLastElevation = Number.POSITIVE_INFINITY;
  private envLastCloud = -1;
  private envCooldown = 0;
  private envInterval = 0.7;
  private shadowsEnabled = true;
  private shadowMapSize = 2048;
  private appliedShadowMapSize = 2048;
  private streetLightBudget = Number.POSITIVE_INFINITY;
  private busStopLightBudget = Number.POSITIVE_INFINITY;
  private stationLightBudget = Number.POSITIVE_INFINITY;
  private windowLightBudget = Number.POSITIVE_INFINITY;

  private readonly sunLight: THREE.DirectionalLight;
  private readonly moonLight: THREE.DirectionalLight;
  private readonly ambientLight: THREE.AmbientLight;
  private readonly hemisphereLight: THREE.HemisphereLight;
  private readonly moonMesh: THREE.Mesh;
  private readonly moonMaterial: THREE.ShaderMaterial;
  private readonly starField: THREE.Points;
  private readonly starMaterial: THREE.PointsMaterial;
  private readonly auroraMeshes: THREE.Mesh[] = [];
  private readonly auroraMaterials: THREE.ShaderMaterial[] = [];
  private auroraTarget = 0;
  private auroraStrength = 0;

  private readonly shootingStars: ShootingStar[] = [];
  private elapsed = 0;
  private moonIllumination = 1;

  // ── Solar eclipse ──
  private eclipseState: EclipseRenderState = {
    active: false,
    coverage: 0,
    separation: 1.25,
    irradiance: 1,
    corona: 0,
    beads: 0,
    stars: 0,
    totality: 0,
  };
  private lightingInitialized = false;
  private smoothedNight = 1;
  private smoothedGolden = 0;
  private smoothedSunStrength = 0;
  private readonly eclipseVisual: EclipseVisual;

  private readonly tmpSunDir = new THREE.Vector3();
  private readonly tmpMoonDir = new THREE.Vector3();
  private readonly tmpColor = new THREE.Color();
  private readonly tmpSunColor = new THREE.Color();
  private readonly tmpWhite = new THREE.Color(0xffffff);
  private readonly shadowFocus = new THREE.Vector3();
  /** Reused for snapping the shadow focus to whole texels; nothing here allocates per frame. */
  private readonly shadowRight = new THREE.Vector3();
  private readonly shadowUp = new THREE.Vector3();
  private readonly snappedFocus = new THREE.Vector3();
  private shadowRadius = 95;
  private lightSelectionCooldown = 0;
  /**
   * Diagnostic only. `update()` reassigns `visible` on every street, bus-stop,
   * station and window light each frame, so a one-shot `visible = false` from a
   * benchmark is undone on the next frame. This gate is checked inside those loops
   * so a diagnostic disable survives the whole measurement window.
   */
  private localLightsEnabled = true;

  private wideView = false;
  private cameraMode: 'free' | 'train' | 'bus' = 'free';

  /** Set by main — the eclipse disc is positioned relative to the camera
   * so it stays optically aligned with the (infinitely far) shader sun. */
  camera: THREE.Camera | null = null;

  private readonly disposables: Array<{ dispose: () => void }> = [];

  constructor(
    scene: THREE.Scene,
    renderer: THREE.WebGLRenderer,
    hooks: DayNightHooks,
    random = fallbackRandom('day-night-stars'),
    eventRandom = fallbackRandom('shooting-stars')
  ) {
    this.random = random;
    this.eventRandom = eventRandom;
    this.scene = scene;
    this.renderer = renderer;
    this.hooks = hooks;

    // ── Atmosphere ──
    this.sky = new Sky();
    this.sky.scale.setScalar(2000);
    /**
     * The same ceiling the reflection probe needs, for the same reason and a different buffer.
     *
     * `bootstrap` builds the composer's frame buffer as `HalfFloatType` too, so the solar disc
     * overflows there as well: aimed at the sun on a software rasteriser that buffer holds 294
     * NaN texels and the sun draws as a black DOT. It does not black out the frame the way the
     * probe did -- mean luminance stays at 228 -- which is exactly why it outlived the
     * investigation that found the probe.
     *
     * Applied before `installEclipseSkyShader`, because both patch the same output write and
     * the eclipse patch must see the clamped expression rather than replace it.
     *
     * ...and after `withTwilightDome`, which is the only one of the three that adds radiance
     * rather than mixing toward something darker. The ceiling has to sit downstream of every
     * such term or the half-float overflow of item 11 returns through the new one.
     */
    this.sky.material.fragmentShader = withTwilightDome(this.sky.material.fragmentShader);
    this.sky.material.fragmentShader = withRadianceCeiling(this.sky.material.fragmentShader);
    // Deliberately not mirrored onto `envSky`: the reflection probe is built once at preload,
    // so a twilight term there would be baked into every reflective surface for the whole day.
    this.sky.material.uniforms.twilight = { value: new THREE.Vector3() };
    this.sky.material.uniforms.twilightHue = { value: new THREE.Vector3() };
    this.installEclipseSkyShader();
    scene.add(this.sky);

    this.envScene = new THREE.Scene();
    this.envSky = new Sky();
    this.envSky.scale.setScalar(2000);
    this.envSky.material.fragmentShader = withRadianceCeiling(
      this.envSky.material.fragmentShader
    );
    this.envSky.material.needsUpdate = true;
    this.envScene.add(this.envSky);
    this.pmrem = new THREE.PMREMGenerator(renderer);

    // ── Lights ──
    this.sunLight = new THREE.DirectionalLight(0xfff4e0, 0);
    this.sunLight.castShadow = true;
    this.sunLight.shadow.mapSize.set(2048, 2048);
    this.sunLight.shadow.camera.left = -95;
    this.sunLight.shadow.camera.right = 95;
    this.sunLight.shadow.camera.top = 95;
    this.sunLight.shadow.camera.bottom = -95;
    this.sunLight.shadow.camera.near = 1;
    this.sunLight.shadow.camera.far = 320;
    this.sunLight.shadow.bias = -0.0008;
    // Only the first frame uses this: `update` replaces it every frame with a value tied
    // to the map's texel size, which is what the artefact scales with.
    this.sunLight.shadow.normalBias = 0.05;
    scene.add(this.sunLight);
    scene.add(this.sunLight.target);

    this.moonLight = new THREE.DirectionalLight(0x7d92c9, 0);
    scene.add(this.moonLight);

    this.ambientLight = new THREE.AmbientLight(0x404060, 0.3);
    scene.add(this.ambientLight);

    this.hemisphereLight = new THREE.HemisphereLight(0x87ceeb, 0x32502a, 0.4);
    scene.add(this.hemisphereLight);

    // ── Moon ──
    this.moonMaterial = buildMoonMaterial();
    const moonGeo = new THREE.SphereGeometry(7, 24, 24);
    this.moonMesh = new THREE.Mesh(moonGeo, this.moonMaterial);
    scene.add(this.moonMesh);
    this.disposables.push(moonGeo, this.moonMaterial);

    // ── Stars ──
    const starPositions = new Float32Array(STAR_COUNT * 3);
    for (let i = 0; i < STAR_COUNT; i++) {
      const theta = random() * Math.PI * 2;
      const phi = Math.acos(random() * 0.95); // upper hemisphere
      const r = 620;
      starPositions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
      starPositions[i * 3 + 1] = r * Math.cos(phi) + 4;
      starPositions[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);
    }
    const starGeo = new THREE.BufferGeometry();
    starGeo.setAttribute('position', new THREE.BufferAttribute(starPositions, 3));
    this.starMaterial = new THREE.PointsMaterial({
      color: 0xeef2ff,
      size: 1.7,
      sizeAttenuation: true,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      fog: false,
    });
    this.starField = new THREE.Points(starGeo, this.starMaterial);
    this.starField.visible = false;
    scene.add(this.starField);
    this.disposables.push(starGeo, this.starMaterial);

    // ── Shooting stars ──
    for (let i = 0; i < SHOOTING_STAR_POOL; i++) {
      const geo = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(0, 0, 0),
        new THREE.Vector3(-7, 1.6, 0),
      ]);
      const mat = new THREE.LineBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 0,
        fog: false,
      });
      const line = new THREE.Line(geo, mat);
      line.visible = false;
      scene.add(line);
      this.shootingStars.push({
        line,
        material: mat,
        velocity: new THREE.Vector3(),
        life: 0,
        maxLife: 1,
      });
      this.disposables.push(geo, mat);
    }

    this.eclipseVisual = new EclipseVisual(scene);

    // ── Aurora: two curved curtains with independent phases ──
    for (let i = 0; i < 2; i++) {
      const material = buildAuroraMaterial(i * 3.7);
      this.auroraMaterials.push(material);
      this.disposables.push(material);
      const geo = new THREE.PlaneGeometry(320, 52, 128, 8);
      const mesh = new THREE.Mesh(geo, material);
      mesh.position.set(i === 0 ? -20 : 35, 58 + i * 14, -110 - i * 30);
      mesh.rotation.y = (i === 0 ? 1 : -1) * 0.16;
      mesh.frustumCulled = false;
      mesh.visible = false;
      this.scene.add(mesh);
      this.auroraMeshes.push(mesh);
      this.disposables.push(geo);
    }

    this.installEnvironmentBlending();
  }

  private installEclipseSkyShader(): void {
    const material = this.sky.material;
    material.uniforms.eclipseDarkness = { value: 0 };
    material.uniforms.eclipseTotality = { value: 0 };
    // 1, not 0: with no eclipse running the dome keeps all of its light, and it keeps it
    // through an exact multiplication rather than through a subtraction that nearly undoes one.
    material.uniforms.eclipseSkyFlux = { value: 1 };
    // ( semi-major axis, observer offset along it ) in kilometres. The identity footprint --
    // both axes at the umbra's own half-width, observer dead centre -- so a frame rendered
    // before the first update still has a finite, sane ring rather than a division by zero.
    material.uniforms.eclipseUmbra = { value: new THREE.Vector2(UMBRA_SEMI_WIDTH_KM, 0) };
    material.fragmentShader = withEclipseSky(material.fragmentShader);
    material.needsUpdate = true;
  }

  private installEnvironmentBlending(): void {
    const patched = new Set<THREE.MeshStandardMaterial>();
    this.scene.traverse((object) => {
      if (!(object instanceof THREE.Mesh || object instanceof THREE.InstancedMesh)) return;
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      for (const candidate of materials) {
        if (!(candidate instanceof THREE.MeshStandardMaterial) || patched.has(candidate)) continue;
        patched.add(candidate);

        const previousCompile = candidate.onBeforeCompile.bind(candidate);
        const previousCacheKey = candidate.customProgramCacheKey.bind(candidate);
        candidate.onBeforeCompile = (shader, renderer) => {
          previousCompile(shader, renderer);
          if (!shader.fragmentShader.includes('#include <envmap_physical_pars_fragment>')) return;

          shader.uniforms.environmentMapNext = this.envNextMapUniform;
          shader.uniforms.environmentMapBlend = this.envBlendUniform;
          shader.fragmentShader = shader.fragmentShader
            .replace(
              '#include <envmap_common_pars_fragment>',
              `#include <envmap_common_pars_fragment>\n${ENVIRONMENT_BLEND_UNIFORMS}`
            )
            .replace(
              '#include <envmap_physical_pars_fragment>',
              BLENDED_ENVIRONMENT_SHADER_CHUNK
            );
        };
        candidate.customProgramCacheKey = () =>
          `${previousCacheKey()}|${ENVIRONMENT_BLEND_CACHE_KEY}`;
        candidate.needsUpdate = true;
      }
    });
  }

  setMoonPhase(phase01: number, illuminationFraction: number): void {
    // phase 0 = new moon, 0.5 = full moon (SunCalc convention).
    this.moonMaterial.uniforms.uPhaseAngle.value = phase01 * Math.PI * 2;
    this.moonIllumination = clamp01(illuminationFraction);
  }

  /** 0..1 — typically (clear-sky && deep-night && "aurora night") gate. */
  setAuroraStrength(strength: number): void {
    this.auroraTarget = clamp01(strength);
  }

  /** Compatibility helper for diagnostics that directly set eclipse coverage. */
  /** Diagnostic only: hold every local light off for a whole measurement window. */
  setLocalLightsEnabled(enabled: boolean): void {
    this.localLightsEnabled = enabled;
  }

  setEclipse(strength: number): void {
    const coverage = clamp01(strength);
    this.setEclipseState({
      active: coverage > 0.001,
      coverage,
      separation: 1.25 * (1 - coverage),
      irradiance: 1 - coverage * 0.985,
      corona: Math.pow(coverage, 4),
      beads: Math.pow(coverage, 10),
      stars: Math.pow(coverage, 7),
      totality: THREE.MathUtils.smoothstep(coverage, 0.985, 1),
    });
  }

  setEclipseState(state: EclipseRenderState): void {
    this.eclipseState = {
      active: state.active,
      coverage: clamp01(state.coverage),
      separation: THREE.MathUtils.clamp(state.separation, -1.35, 1.35),
      irradiance: clamp01(state.irradiance),
      corona: clamp01(state.corona),
      beads: clamp01(state.beads),
      stars: clamp01(state.stars),
      totality: clamp01(state.totality),
    };
  }

  getBloomObjects(): THREE.Object3D[] {
    return this.eclipseVisual.getBloomObjects();
  }

  getOcclusionExclusions(): THREE.Object3D[] {
    return this.eclipseVisual.getOcclusionExclusions();
  }

  /** Focuses the directional shadow budget around the currently viewed area. */
  setShadowFocus(target: THREE.Vector3, radius: number): void {
    this.shadowFocus.copy(target);
    const nextRadius = THREE.MathUtils.clamp(radius, 42, 95);
    if (Math.abs(nextRadius - this.shadowRadius) < 1) return;
    this.shadowRadius = nextRadius;
    const shadowCamera = this.sunLight.shadow.camera;
    shadowCamera.left = -nextRadius;
    shadowCamera.right = nextRadius;
    shadowCamera.top = nextRadius;
    shadowCamera.bottom = -nextRadius;
    shadowCamera.updateProjectionMatrix();
  }

  setCameraFocusDistance(distance: number): void {
    if (!Number.isFinite(distance)) return;
    const nextWideView = this.wideView ? distance > 102 : distance > 112;
    if (nextWideView === this.wideView) return;
    this.wideView = nextWideView;
    this.syncShadowMapResolution();
  }

  setCameraMode(mode: 'free' | 'train' | 'bus'): void {
    this.cameraMode = mode;
  }

  private syncShadowMapResolution(force = false): void {
    const targetSize = this.wideView ? Math.min(512, this.shadowMapSize) : this.shadowMapSize;
    if (!force && targetSize === this.appliedShadowMapSize) return;
    this.appliedShadowMapSize = targetSize;
    this.sunLight.shadow.mapSize.set(targetSize, targetSize);
    this.sunLight.shadow.map?.dispose();
    this.sunLight.shadow.map = null;
  }

  setQuality(profile: QualityProfile): void {
    const shadowConfigChanged =
      this.shadowsEnabled !== profile.shadows || this.shadowMapSize !== profile.shadowMapSize;
    this.eclipseVisual.setQuality(profile.level);
    this.envInterval = profile.pmremInterval;
    this.shadowsEnabled = profile.shadows;
    this.shadowMapSize = profile.shadowMapSize;
    this.streetLightBudget = profile.streetLightBudget;
    this.busStopLightBudget = profile.busStopLightBudget;
    this.stationLightBudget = profile.stationLightBudget;
    this.windowLightBudget = profile.windowLightBudget;
    this.syncShadowMapResolution(shadowConfigChanged);
    // Quality may only ever turn the shadow OFF. `update` owns whether it is on, and it uses a
    // gate this one does not have -- `sunStrength * irradiance * cloudLight.beam > 0.05`, which
    // knows about the cloud deck and about an eclipse. Writing `smoothedSunStrength > 0.002`
    // here could put one frame of hard noon shadow under rain, or through totality, between a
    // quality change and the next frame. `shadowsEnabled` is set just above, so the loop
    // reaches the right answer on its own.
    if (!profile.shadows) this.sunLight.castShadow = false;
  }

  update(
    t: Clock01,
    dtReal: number,
    cloudCover: number,
    /** Solar declination: the season, in radians. Sets noon altitude and day length together. */
    declination: Radians,
    /**
     * Required, and deliberately not optional.
     *
     * `declination` was inserted ahead of a `nightFloor = 0`, which left every existing
     * four-argument call compiling unchanged while silently feeding the night floor into the
     * season. Three of them in `RendererWarmup` then seeded the smoothed sun with a
     * declination of zero, which at the rainbow checkpoint's hour is an elevation of 0.43
     * degrees instead of 18.7 -- near-zero direct sunlight instead of most of it, and no
     * rainbow. (The two figures this once quoted, 6e-5 and 0.54, were `directSunFactorAt`
     * before the 2026-09-12 ramp retune replaced its double cosine with an air-mass beam;
     * the shape of the failure is unchanged, the numbers are not, so they are gone rather
     * than left to rot.)
     * A default here is what let the compiler stay quiet; there is not one any more.
     */
    nightFloor: number,
    /**
     * What the **weather** put in the sky, which is not what `cloudCover` carries.
     *
     * `cloudCover` arrives as `skyCloud` -- the weather's cover plus the theme's
     * `turbidityAdd * 0.1` -- because a theme's haze genuinely belongs in the dome's
     * turbidity and mie terms. It does not belong in occlusion: haze is not a cloud deck, and
     * feeding it to `cloudDaylightAt` made a **clear** cyberpunk sky (turbidityAdd 5, so cover
     * 0.62) brighten its sun by 19.9 per cent and blur its shadow, with autumn and retro
     * moved a little too. Measured by a reviewer, on three of the five shipped themes.
     *
     * Deliberately the last parameter rather than sitting beside `cloudCover`: two adjacent
     * numbers that both mean "cloud" is the shape of mistake this file has already paid for
     * twice.
     */
    weatherCloud: number
  ): DayLightState {
    this.elapsed += dtReal;
    const eclipseState = this.eclipseState;
    const eclipse = eclipseState.coverage;
    const eclipseDarkness = 1 - eclipseState.irradiance;
    /** Exactly 1.0 whenever no eclipse is running — see {@link eclipseDiffuseFraction}. */
    const eclipseDiffuse = eclipseDiffuseFraction(eclipseState.irradiance);
    const elevation = sunElevationAt(t, declination);
    // Themes like Neon Noir keep the city in eternal dusk via nightFloor;
    // a solar eclipse pushes the world toward night for half a minute.
    const targetNight = Math.max(
      nightFactorAt(t, declination),
      nightFloor,
      eclipseDarkness * 0.52 + eclipseState.totality * 0.12
    );
    const targetGolden = goldenFactorAt(t, declination);
    const targetSunStrength = directSunFactorAt(t, declination);
    const lightingBlend = this.lightingInitialized ? 1 - Math.exp(-Math.max(0, dtReal) * 3.2) : 1;
    this.smoothedNight += (targetNight - this.smoothedNight) * lightingBlend;
    this.smoothedGolden += (targetGolden - this.smoothedGolden) * lightingBlend;
    this.smoothedSunStrength += (targetSunStrength - this.smoothedSunStrength) * lightingBlend;
    this.lightingInitialized = true;
    const night = this.smoothedNight;
    const golden = this.smoothedGolden;
    const day = 1 - night;
    const sunDir = sunDirectionAt(t, declination, this.tmpSunDir);

    // ── Sky shader ──
    const uniforms = this.sky.material.uniforms;
    /**
     * An eclipse chokes the scattered light — but it does it to the *illumination*, not to
     * the air.
     *
     * These two used to carry `(1 - eclipseDarkness * 0.82)` and `(1 - eclipseDarkness *
     * 0.94)`. A Rayleigh coefficient is a property of the atmosphere's composition and a Mie
     * coefficient of its aerosol load; the moon passing in front of the sun changes neither.
     * Scaling them does not dim a Preetham sky so much as *reshape* it: the shader's radiance
     * is not proportional to either coefficient. That was measured rather than assumed — an
     * intermediate build drove both from the diffuse fraction, which stood rayleigh at 7.5 per
     * cent of its clear value, and the dome was still bright enough that the 14.2 per cent of
     * it surviving the old crossfade carried four fifths of the frame's light. The attenuation
     * belongs on the dome's output, and {@link withEclipseSky} applies it there.
     *
     * Both terms are unchanged at every uneclipsed hour: the factors they lost were exactly 1
     * whenever `eclipseDarkness` was 0.
     */
    const turbidity = 2.0 + cloudCover * 11 + golden * 1.6;
    const rayleigh = 2.4 + golden * 1.4;
    const mie = 0.0035 + golden * 0.014 + cloudCover * 0.008;
    uniforms.turbidity.value = turbidity;
    uniforms.rayleigh.value = rayleigh;
    uniforms.mieCoefficient.value = mie;
    uniforms.mieDirectionalG.value = 0.82;
    uniforms.sunPosition.value.copy(sunDir);
    uniforms.showSunDisc.value = eclipseState.active ? 0 : 1;
    uniforms.eclipseDarkness.value = eclipseDarkness;
    uniforms.eclipseTotality.value = eclipseState.totality;
    // The dome loses its light in proportion to the light it is being lit by, and that is
    // `irradiance` itself -- not `1 - eclipseDarkness`, which is the same number sent through a
    // subtraction the shader then has to undo. See {@link withEclipseSky}.
    uniforms.eclipseSkyFlux.value = eclipseState.irradiance;
    /**
     * ...and where the observer stands inside the umbra, which is what gives the ring a bearing.
     *
     * `elevation` is the real sun rather than the smoothed lighting blend, for the same reason
     * the twilight hand-off below uses it: the footprint's elongation is a fact about where the
     * sun is, not about how fast the rig is catching up with it.
     */
    const semiMajorKm = umbraSemiMajorKm(elevation);
    (uniforms.eclipseUmbra.value as THREE.Vector2).set(
      semiMajorKm,
      semiMajorKm * UMBRA_TRAVERSE_LIMIT * umbraTraverse(eclipseState.separation)
    );
    /**
     * ...and the half of the day Preetham does not have. `elevation` is the real sun, not the
     * smoothed lighting blend, because the hand-off is defined against `vSunE`, which the
     * vertex shader computes from that same sun.
     *
     * `x` is the radiance of the whole term, `y` where Earth's shadow's edge stands (the
     * solar depression, signed by azimuth in the shader), and `z` what a line of sight pays
     * to climb over it. All three are dead above the horizon.
     */
    const twilight = uniforms.twilight.value as THREE.Vector3;
    const handoff = preethamHandoff(elevation) * (1 - cloudCover * 0.7);
    twilight.x = 0;
    if (handoff > 0) {
      const dusk = twilightSkyColorCached(elevation);
      twilight.set(
        handoff * dusk.relativeBrightness * TWILIGHT_SUNSET_RADIANCE,
        -elevation,
        TWILIGHT_SHADOW_CLIMB * -elevation
      );
      (uniforms.twilightHue.value as THREE.Vector3).fromArray(dusk.color);
    }

    // ── Sun light ──
    const sunStrength = this.smoothedSunStrength;
    const cloudLight = cloudDaylightAt(weatherCloud);
    /**
     * The shadow map's grid is pinned to whole texels, so it stops crawling.
     *
     * `setShadowFocus` slides the whole shadow frustum along with whatever the camera is
     * looking at. The map is a fixed number of texels across that frustum, and the numbers
     * are worse than the constructor above suggests: the quality profile overrides the map
     * to 1024 on High, the frustum settles around 69 m of radius in a street view, and a
     * wide view drops the map to 512. That is 0.14 m of world per texel up close and
     * 0.27 m in a wide view. Every shadow edge is quantised to that grid, and while the
     * grid itself moves continuously the quantisation lands somewhere new every frame.
     *
     * Rounding the focus to whole texels in the light's own basis freezes the grid to the
     * world, so an edge that is stepped stays stepped in the same place instead of
     * swimming across the wall as the camera moves.
     */
    const texel = shadowTexelSize(this.shadowRadius, this.appliedShadowMapSize);
    /**
     * The bias that removes what the map cannot draw, sized in texels rather than metres.
     *
     * A window sill is 0.07 m thick and stands 0.26 m off the wall. Its shadow is a third
     * of a texel wide, so the map cannot represent it: what reached the screen was a row
     * of detached diagonal teeth on the wall below every window, which is what was
     * reported. Photographed at a 0.136 m texel, 0.05 m of normal bias left them at full
     * strength, 0.12 m left them faint, and 0.2 m removed them; the big shadows -- the
     * trees, the blocks on the grass -- were unchanged, moving 2.1% of the street view's
     * pixels and lifting its mean luminance by 0.24 of 255.
     *
     * Expressed as 1.5 texels it holds as the frustum tightens and as a wide view drops
     * the map to 512, because the artefact scales with the texel and not with the metre.
     * This removes an unresolvable shadow rather than paying for the resolution to draw
     * it: no budget moves, and nothing else in the picture is given up for it.
     */
    this.sunLight.shadow.normalBias = shadowNormalBias(texel);
    snapShadowFocus(
      this.shadowFocus,
      sunDir,
      texel,
      this.shadowRight,
      this.shadowUp,
      this.snappedFocus
    );
    this.sunLight.position.copy(sunDir).multiplyScalar(140).add(this.snappedFocus);
    this.sunLight.target.position.copy(this.snappedFocus);
    // nightFloor (eternal-dusk themes) and an eclipse both mute the sun; a cloud deck
    // takes the beam apart and hands it to the sky — see {@link cloudDaylightAt}.
    const directSun =
      sunStrength * cloudLight.beam * (1 - nightFloor * 0.8) * eclipseState.irradiance;
    /**
     * 2.0363, not 2.2, so that a clear day renders exactly as it did.
     *
     * The old beam term was `1 - cloudCover * 0.62`, and this product's clear sky is cover
     * 0.12 -- so it quietly took 7.4 per cent off the beam on a cloudless noon as well.
     * Kasten & Czeplak put the loss at one okta at 0.06 per cent, so that 7.4 was never
     * cloud; it was part of the rig's calibration wearing a cloud term's clothes. The beam
     * no longer spends it, so the gain absorbs it: `2.2 * (1 - 0.62 * 0.12) = 2.0363`.
     * Measured on a running page at noon, cover 0.12: `sunLight.intensity` 2.036 before
     * this change and 2.036 after it. The defect was rain, and rain is the only thing that
     * moves.
     */
    this.sunLight.intensity = directSun * 2.0363;
    sunColorAt(t, declination, this.tmpSunColor);
    this.sunLight.color.copy(this.tmpSunColor);
    /**
     * The shadow gate reads the beam, which is the only thing that casts one.
     *
     * `nightFloor` is still left out on purpose -- an eternal-dusk theme dims the world
     * without putting a deck over it, and its shadows stay. `cloudLight.beam` is the term
     * that was missing: without it this expression never mentioned cloud, so rain kept a
     * hard shadow at full strength. Measured at noon, the gate now opens at cover 0.908,
     * so rain (0.92) is shadowless and snow (0.85) still casts, softened.
     */
    const directShadowStrength = sunStrength * eclipseState.irradiance * cloudLight.beam;
    this.sunLight.castShadow = this.shadowsEnabled && directShadowStrength > 0.05;
    this.sunLight.shadow.radius = cloudLight.penumbra;

    // ── Moon (opposite side of the sky) ──
    /**
     * The moon rides the **real** antisolar point, declination mirrored and all.
     *
     * It used to ride `sunDirectionAt(t + 0.5, +declination)`, which turns the hour angle
     * without turning the declination: a half-mirror that put the moon at the sun's own noon
     * altitude at midnight. Measured, that was 61.21 degrees in June and 28.27 in October --
     * the exact inverse of the sky, where a midsummer full moon crawls and an autumn one
     * rides high. {@link antisolarDirectionAt} fixes the sign; the numbers become 14.33 and
     * 47.27, and the azimuth mirrors too (a June moonrise moves from 49.50 degrees
     * east-of-north, the sun's own bearing, to 130.50).
     *
     * **This is a visible change to every June night, and it is meant to be.** Both gates
     * below read `moonDir.y`, so a moon that no longer climbs is dimmer and up for less of
     * the night. Sampled over a full day at 200 000 steps, full moon and clear sky: the mesh
     * is drawn for 8.67 h of a June day instead of 17.89, the moonlight is above 0.01 for
     * 7.33 h instead of 10.31, and its 24-hour mean falls from 0.1746 to 0.1093. October is
     * the other side of the same trade and gains: 14.68 h of mesh against 11.32, 13.56 h of
     * light against 10.28, mean 0.2792 against 0.2014. Peak intensity is untouched in
     * October (0.5600) and clipped by one per cent in June (0.5544 -- `moonDir.y * 4` no
     * longer saturates, because 14.33 degrees is a sine of 0.2475).
     *
     * `uPhaseAngle` is set from SunCalc in {@link setMoonPhase} and is a separate axis: the
     * crescent's shape never depended on this sign and is unchanged.
     */
    const moonDir = antisolarDirectionAt(t, declination, this.tmpMoonDir);
    this.moonMesh.position.copy(moonDir).multiplyScalar(540);
    const moonOpacity = THREE.MathUtils.smoothstep(moonDir.y, -0.08, 0.08);
    this.moonMaterial.uniforms.uOpacity.value = moonOpacity;
    this.moonMesh.visible = moonOpacity > 0.001;
    this.moonLight.position.copy(moonDir).multiplyScalar(120);
    /**
     * `cloudCover` here is the SKY's cloud -- the weather's deck plus the theme's own haze --
     * and that is deliberate, where the daylight beam a few hundred lines up reads the
     * weather's deck alone.
     *
     * The difference is what each number is for. A theme's `turbidityAdd` is not a cloud deck,
     * so it must not gate a *shadow*: that was a real defect, and feeding it to the overcast
     * curve made a clear cyberpunk sky brighten its own sun by 19.9 per cent. But haze does
     * extinguish a moon and does drown stars -- that is what smog over a city physically does
     * -- so here the hazed number is the right one, and the stars below read it for the same
     * reason.
     *
     * What is NOT derived is the exchange rate. `skyCloud` is `weatherCloud + turbidityAdd *
     * 0.1`, and Neon Noir's `turbidityAdd: 5` therefore spends 0.5 of a cloud deck on a
     * cloudless night: the moon loses 40 per cent and half the stars go. That reads well and
     * it is the look the owner approved, but the 0.1 is authored, not measured. Anyone
     * retuning the neon night should change it knowing it is a dial, not a constant.
     */
    this.moonLight.intensity =
      night * (0.06 + this.moonIllumination * 0.5) * (1 - cloudCover * 0.8) * clamp01(moonDir.y * 4);

    this.eclipseVisual.update(this.camera, sunDir, eclipseState, dtReal, cloudCover);

    // ── Fill lights ──
    /**
     * `cloudLight.fill` multiplies the `day * 0.5` term and nothing else, which is the
     * only term that is skylight.
     *
     * The 0.16 and 0.22 floors are not sky: they are what the rig leaves lit when the sky
     * has gone, and an overcast *night* is darker than a clear one, not brighter -- the
     * moon above already pays that with its own `(1 - cloudCover * 0.8)`. Scaling the
     * whole expression would have lifted the night floor by two thirds under rain for no
     * reason. `golden * 0.1` is the low-sun warm-up and belongs to the beam's hour, not to
     * the deck.
     *
     * **The eclipse term around the outside is now the beam's own `irradiance`, and the two
     * additive `totality` terms are gone.** They were `(1 - eclipseDarkness * 0.38) +
     * totality * 0.1` and `(1 - eclipseDarkness * 0.42) + totality * 0.08`, a shallower ramp
     * than the sun's with a legibility bonus added back at the bottom -- which left the
     * ambient fill *non-monotonic*: measured on the built bundle, it read 0.3630 at progress
     * 0.25 and rose to 0.3733 at totality, so the world got brighter as the moon finished
     * covering the sun. {@link eclipseDiffuseFraction} replaces both with one term that falls
     * with the beam and floors on the umbra's own skyglow.
     */
    this.ambientLight.intensity =
      (0.16 + day * 0.5 * cloudLight.fill + golden * 0.1) * eclipseDiffuse;
    skyColorAt(t, declination, this.tmpColor);
    this.ambientLight.color.copy(this.tmpColor).lerp(this.tmpWhite, 0.35);
    this.hemisphereLight.intensity = (0.22 + day * 0.5 * cloudLight.fill) * eclipseDiffuse;
    this.hemisphereLight.color.copy(this.tmpColor);

    // ── Fog colour tracks the horizon (density owned by Weather) ──
    if (this.scene.fog) {
      const fogGrey = 0.35 + cloudCover * 0.35;
      this.scene.fog.color
        .copy(this.tmpColor)
        .lerp(new THREE.Color(0x9aa3ad), cloudCover * fogGrey * day);
      /**
       * The fog keeps its hue lerp and **not** the diffuse fraction, which is a deliberate
       * exception and the one place this change stops short.
       *
       * Fog is in-scattered light along the view ray -- the radiance of the air itself -- so by
       * the argument the rest of this change is built on it should take `eclipseDiffuse` like
       * the fills and the dome. A hue lerp cannot darken, and at totality this leaves the air
       * at 24 per cent of the hour's own colour while the fills sit at 7.7 to 13.0.
       *
       * It was measured both ways at the shipped configuration, and it is the ground that
       * decides: `.multiplyScalar(eclipseDiffuse)` moves the whole frame 0.4094 to 0.4012 --
       * barely -- and the city 0.2844 to 0.2290, which overshoots the darkness this change was
       * asked for by a wide margin and takes the streets with it. It also stopped being the
       * outlier it once was: while the dome was still a crossfade the fog band was the least
       * darkened eighth of the frame at 0.7049, and with the dome attenuated properly the
       * profile across the frame is smooth without it.
       *
       * So it is left alone, and left written down: a real inconsistency, costed, not taken.
       */
      if (eclipseDarkness > 0.001) {
        this.scene.fog.color.lerp(
          new THREE.Color(0x171d36),
          eclipseDarkness * (0.5 + eclipseState.totality * 0.28)
        );
      }
    }

    // ── Stars ──
    const starAlpha = starAlphaAt(
      night,
      eclipseState.stars,
      eclipseDarkness * 0.52 + eclipseState.totality * 0.12,
      cloudCover
    );
    this.starMaterial.opacity = starAlpha * 0.95;
    this.starField.visible = starAlpha > 0.02;
    this.starField.rotation.y = this.elapsed * 0.004;

    // ── Shooting stars ──
    this.updateShootingStars(dtReal, starAlpha);

    // ── Aurora ──
    const auroraVisible = this.auroraTarget * clamp01((night - 0.6) / 0.3) * (1 - cloudCover);
    this.auroraStrength += (auroraVisible - this.auroraStrength) * Math.min(1, dtReal * 0.6);
    for (const material of this.auroraMaterials) {
      material.uniforms.uTime.value = this.elapsed;
      material.uniforms.uStrength.value = this.auroraStrength;
    }
    for (const mesh of this.auroraMeshes) mesh.visible = this.auroraStrength > 0.015;

    // ── Street / window lights ──
    this.lightSelectionCooldown -= dtReal;
    if (this.camera && this.lightSelectionCooldown <= 0) {
      const eye = this.camera.position;
      this.hooks.streetLights.sort(
        (a, b) => a.position.distanceToSquared(eye) - b.position.distanceToSquared(eye)
      );
      this.hooks.busStopLights.sort(
        (a, b) => a.position.distanceToSquared(eye) - b.position.distanceToSquared(eye)
      );
      this.hooks.stationLights.sort(
        (a, b) => a.position.distanceToSquared(eye) - b.position.distanceToSquared(eye)
      );
      this.hooks.windowLights.sort(
        (a, b) => a.position.distanceToSquared(eye) - b.position.distanceToSquared(eye)
      );
      this.lightSelectionCooldown = 0.5;
    }
    // Point/spot lights are evaluated by every physical fragment. In the low
    // bus chase camera, a dozen city lights overlap most of the screen and
    // become substantially more expensive than their draw-call count suggests.
    // Keep the nearest street and shelter pools; emissive fixtures and glow
    // meshes preserve the rest of the city lighting without global shader cost.
    const busChaseView = this.cameraMode === 'bus';
    const streetLightBudget = this.wideView
      ? 0
      : busChaseView ? Math.min(1, this.streetLightBudget) : this.streetLightBudget;
    const busStopLightBudget = this.wideView
      ? 0
      : busChaseView ? Math.min(1, this.busStopLightBudget) : this.busStopLightBudget;
    const stationLightBudget = this.wideView
      ? Math.min(1, this.stationLightBudget)
      : busChaseView ? 0 : this.stationLightBudget;
    const windowLightBudget = this.wideView || busChaseView ? 0 : this.windowLightBudget;
    const physicalLightThreshold = this.wideView ? 0.28 : 0.001;
    for (let i = 0; i < this.hooks.streetLights.length; i++) {
      const light = this.hooks.streetLights[i];
      light.visible = this.localLightsEnabled && night > physicalLightThreshold && i < streetLightBudget;
      // A small urban LED luminaire is several thousand lumens. The point-light
      // approximation needs enough candela to reach pavement and nearby walls.
      light.intensity = light.visible ? night * 135 : 0;
      light.distance = 30;
    }
    const streetGlow = clamp01((night - 0.04) / 0.72);
    this.hooks.streetGlowMesh.visible = streetGlow > 0.01;
    this.hooks.streetGlowMaterial.uniforms.uNight.value = streetGlow;
    for (let i = 0; i < this.hooks.busStopLights.length; i++) {
      const light = this.hooks.busStopLights[i];
      light.visible = this.localLightsEnabled && night > physicalLightThreshold && i < busStopLightBudget;
      light.intensity = light.visible ? night * 48 : 0;
    }
    for (const material of this.hooks.busStopGlowMaterials) {
      material.emissiveIntensity = 0.08 + night * 1.05;
    }
    for (let i = 0; i < this.hooks.stationLights.length; i++) {
      const light = this.hooks.stationLights[i];
      light.visible = this.localLightsEnabled && night > physicalLightThreshold && i < stationLightBudget;
      // Railway platforms stay brighter than bus shelters for visibility and safety.
      light.intensity = light.visible ? night * 145 : 0;
      light.distance = 28;
    }
    for (const material of this.hooks.stationGlowMaterials) {
      material.emissiveIntensity = 0.1 + night * 1.8;
    }
    const stationGlow = clamp01((night - 0.015) / 0.72);
    this.hooks.stationGlowMesh.visible = stationGlow > 0.01;
    this.hooks.stationGlowMaterial.uniforms.uNight.value = stationGlow;
    /**
     * The one crossing in this file, named rather than hidden.
     *
     * `CityRhythm` schedules an HOUR -- its constants are wall-clock minutes -- and this
     * system only ever holds the lighting clock. The two are the same number today, because
     * the real-time warp was removed when the sun became seasonal, so this re-labels rather
     * than converts. It is an explicit cast for the same reason `RealTime.getCycleT` is one:
     * the day a warp comes back, the compiler asks here instead of accepting the relabel.
     */
    const hourOfDay = t as number as WallClock01;
    const residentialActivity = residentialWindowAverageAt(hourOfDay);
    for (let i = 0; i < this.hooks.windowLights.length; i++) {
      const light = this.hooks.windowLights[i];
      light.visible =
        this.localLightsEnabled &&
        night > physicalLightThreshold && residentialActivity > 0.001 && i < windowLightBudget;
      light.intensity = light.visible ? night * residentialActivity * 32 : 0;
      light.distance = 20;
    }
    for (const schedule of this.hooks.windowGlowMaterials) {
      const activity = residentialWindowActivityAt(hourOfDay, schedule.cohort);
      schedule.activity = activity;
      schedule.material.color.copy(schedule.darkColor).lerp(schedule.litColor, activity);
      schedule.material.emissive.copy(schedule.litColor);
      schedule.material.emissiveIntensity = activity * (0.02 + night * 1.23);
    }

    // ── Environment map (reflections in glass) — throttled regeneration ──
    this.updateEnvironmentTransition(dtReal);
    // The reflection probe is skylight like the two fills, so it takes the same term. It used
    // `(1 - eclipseDarkness * 0.72)`, which left 29.8 per cent of a clear hour's reflections
    // in the glass at totality.
    this.scene.environmentIntensity = ENVIRONMENT_INTENSITY * eclipseDiffuse;
    // PMREM generation is synchronous and a two-map crossfade doubles the
    // environment lookup cost on every physical material. Build the neutral
    // reflection probe once during preload; continuous sky/light/weather
    // changes stay in their dedicated shaders and material parameters.
    if (!this.envTarget && !this.envTransitionActive) {
      this.regenerateEnvironment(uniforms);
      this.envLastElevation = elevation;
      this.envLastCloud = cloudCover;
    }

    return { night, golden, sunElevation: elevation, directSun, eclipse };
  }

  private regenerateEnvironment(skyUniforms: Record<string, THREE.IUniform>): void {
    const envUniforms = this.envSky.material.uniforms;
    envUniforms.turbidity.value = skyUniforms.turbidity.value;
    envUniforms.rayleigh.value = skyUniforms.rayleigh.value;
    envUniforms.mieCoefficient.value = skyUniforms.mieCoefficient.value;
    envUniforms.mieDirectionalG.value = skyUniforms.mieDirectionalG.value;
    envUniforms.sunPosition.value.copy(skyUniforms.sunPosition.value);

    const next = this.pmrem.fromScene(this.envScene, 0.03);
    if (!this.envTarget) {
      this.envTarget = next;
      this.scene.environment = next.texture;
      this.scene.environmentIntensity = ENVIRONMENT_INTENSITY;
      this.envNextMapUniform.value = next.texture;
      this.envBlendUniform.value = 0;
      return;
    }

    this.envPendingTarget?.dispose();
    this.envPendingTarget = next;
    this.envNextMapUniform.value = next.texture;
    this.envTransitionProgress = 0;
    this.envTransitionActive = true;
  }

  private updateEnvironmentTransition(dtReal: number): void {
    if (!this.envTransitionActive) return;

    this.envTransitionProgress = clamp01(
      this.envTransitionProgress + Math.max(0, dtReal) / ENVIRONMENT_TRANSITION_SECONDS
    );
    const transition = environmentTransitionAt(this.envTransitionProgress);
    this.scene.environmentIntensity = transition.intensity;
    this.envBlendUniform.value = transition.blend;
    if (this.envTransitionProgress >= 1) {
      const old = this.envTarget;
      this.envTarget = this.envPendingTarget;
      this.envPendingTarget = null;
      if (this.envTarget) {
        this.scene.environment = this.envTarget.texture;
        this.envNextMapUniform.value = this.envTarget.texture;
      }
      this.envBlendUniform.value = 0;
      this.scene.environmentIntensity = ENVIRONMENT_INTENSITY;
      this.envTransitionActive = false;
      old?.dispose();
    }
  }

  private updateShootingStars(dt: number, starAlpha: number): void {
    for (const star of this.shootingStars) {
      if (star.life > 0) {
        star.life -= dt;
        star.line.position.addScaledVector(star.velocity, dt);
        const fade = clamp01(star.life / star.maxLife);
        star.material.opacity = fade * 0.9;
        if (star.life <= 0) star.line.visible = false;
      } else if (dt > 0 && starAlpha > 0.6 && this.eventRandom() < dt * 0.12) {
        star.maxLife = 0.7 + this.eventRandom() * 0.6;
        star.life = star.maxLife;
        star.line.position.set(
          (this.eventRandom() - 0.5) * 360,
          120 + this.eventRandom() * 120,
          (this.eventRandom() - 0.5) * 360
        );
        star.velocity.set(
          -(60 + this.eventRandom() * 80),
          -(18 + this.eventRandom() * 22),
          (this.eventRandom() - 0.5) * 30
        );
        star.line.visible = true;
      }
    }
  }

  dispose(): void {
    this.eclipseVisual.dispose();
    for (const item of this.disposables) item.dispose();
    this.envTarget?.dispose();
    this.envPendingTarget?.dispose();
    this.pmrem.dispose();
    this.scene.environment = null;
    this.scene.remove(this.sky, this.starField, this.moonMesh, this.sunLight, this.moonLight);
    for (const mesh of this.auroraMeshes) this.scene.remove(mesh);
    for (const star of this.shootingStars) this.scene.remove(star.line);
    (this.sky.material as THREE.ShaderMaterial).dispose();
    this.sky.geometry.dispose();
    (this.envSky.material as THREE.ShaderMaterial).dispose();
    this.envSky.geometry.dispose();
  }
}
