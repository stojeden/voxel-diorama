import * as THREE from 'three';
import type { QualityLevel } from '../performance/QualityManager';
import { EclipseGroundEffects } from './EclipseGroundEffects';
// Which way the moon travels across the sun is a fact about the sky, not a taste: see
// `celestialEastAt`, and `MOON_CENTER_CHUNK` below for how it reaches the billboard.
import { celestialEastAt } from './sky';

/** World up, and the same vector `Object3D.lookAt` uses by default. */
const WORLD_UP = new THREE.Vector3(0, 1, 0);

export interface EclipseRenderState {
  active: boolean;
  coverage: number;
  separation: number;
  irradiance: number;
  corona: number;
  beads: number;
  stars: number;
  totality: number;
}

const VERTEX_SHADER = /* glsl */ `
  varying vec2 vUv;

  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

/**
 * Scene-linear radiance of the sky immediately beside the sun at the eclipse hour.
 *
 * Every magnitude the solar billboard draws is a ratio to this one number, because the
 * defect being fixed is a *comparison*, not a level. At 95.9 per cent coverage the drawn
 * disc measured luma 227.7 against a 250.5 sky and the billboard made **zero** pixels of
 * the centre row brighter: a dark blob on white, with no crescent in it. A disc authored at
 * an absolute radiance cannot say whether it beats the sky it sits on. A ratio can.
 *
 * 25 is inverted from a measurement rather than invented: the centre-row scan read the sky
 * beside the disc at luma 254.4/255 at this hour. sRGB-decoding that gives display-linear
 * 0.9947; inverting the ACES RRT+ODT fit gives a tone-mapper input of 19.5; dividing by the
 * pipeline's exposure/0.6 -- about 0.767 at this hour -- gives 25.4. Run forwards on the
 * *shipped* disc radiance of 1.22 the same chain predicts code 203 against the 190.6-227.7
 * the probe actually read, which is the only cross-check available without a renderer.
 *
 * So this is the line to edit when someone reads the scene buffer directly. Nothing else
 * below carries an absolute: re-measuring this retunes the whole billboard at once.
 */
const ECLIPSE_HOUR_SKY_RADIANCE = 25;

/**
 * The scene-linear radiance at which the presented picture runs out of headroom.
 *
 * The composer tone-maps with three's ACES fit (`RRTAndODTFit`, which first multiplies by
 * `toneMappingExposure / 0.6`). Both ACES matrices have unit row sums, so for a neutral
 * colour the whole chain collapses to the scalar fit, and the fit reaches 1.0 -- code 255,
 * nothing above it distinguishable from anything else above it -- at an input of 25.668.
 * The same measurement that fixes {@link ECLIPSE_HOUR_SKY_RADIANCE} fixes the exposure:
 * sky radiance 25 read luma 254.4, i.e. display-linear 0.99466, i.e. a fit input of 19.428,
 * so `toneMappingExposure / 0.6` is 0.7771 at this hour. 25.668 / 0.7771 = 33.03.
 *
 * This is the number the shipped ladder was missing. `PHOTOSPHERE_LIMB_OVER_SKY = 8` put
 * the disc's DIMMEST point at 200 and its centre at 666.7 -- both six to twenty times over
 * saturation -- so the 3.33:1 limb law this file is built around produced a disc of one
 * single code. Every magnitude below is now placed against 33.03 as well as against the
 * sky, because a ratio to the sky says whether a thing is visible and a ratio to this says
 * whether it has any internal structure left once the tone curve has had it.
 */
const ACES_SATURATION_RADIANCE = 33.03;

/**
 * Where the *dimmest* part of the photosphere sits relative to saturation -- one stop under.
 *
 * Pinned at the extreme limb (mu = 0, where the limb law bottoms out at 0.30) because a deep
 * crescent is made entirely of limb, and pinned under saturation rather than over the sky
 * because the darkness rework changed what "the sky" means. The dome is now
 * `texColor * irradiance + eclipseSky * eclipseDarkness` (DayNightCycle.ts:396), so the sky
 * beside the sun falls with coverage instead of standing at 25: 10.52 at coverage 0.50,
 * 4.65 at 0.75, 1.85 at 0.90, 0.74 at totality. It is only at the ACES clip point when there
 * is no eclipse yet to see.
 *
 * At 0.5 the disc runs 16.52 (limb) to 55.05 (centre): the limb lands on the curve's slope,
 * the centre saturates, and the outer 6.5 per cent of the radius -- which is where a
 * coverage-0.90 crescent lives -- keeps presented variation instead of being one flat code.
 * The crescent's mean radiance still beats the sky beside it by 4.05x at coverage 0.50,
 * 8.12x at 0.75 and 17.1x at 0.90, which is the contrast the baseline measured as broken.
 *
 * The true ratio is about 1e5 -- the photosphere is 1.6e9 cd/m^2 at every coverage, because
 * the moon removes area and never surface brightness. One exposure cannot hold that, which
 * is why eclipse photographers publish exposure ladders instead; this is the partial-phase
 * rung of one, and {@link INNER_CORONA_OVER_UMBRAL_SKY} is the totality rung.
 */
const PHOTOSPHERE_LIMB_UNDER_SATURATION = 0.5;

/**
 * Visible-light limb darkening: I(mu)/I(centre) = 0.3 + 0.93 mu - 0.23 mu^2 at 550 nm,
 * with mu = cos(theta) = sqrt(1 - (r/R)^2). Limb is 0.30 of centre, disc mean 0.805.
 *
 * The shader already had mu -- and then spent it on `0.9 + limb * 0.32`, a 1.36:1
 * centre-to-limb range against the real 3.33:1. That is a bigger error here than it would
 * be on a plain sun: a crescent is nothing but limb, so the ad-hoc factor drew the one part
 * of the disc this whole feature is about at 90 per cent of centre brightness instead of
 * 30, and flat across its width instead of falling toward its outer edge.
 *
 * Hestroffer & Magnan 1998, A&A 333, 338, Table 1 (550 nm quadratic).
 */
const LIMB_DARKENING = { a0: 0.3, a1: 0.93, a2: -0.23 } as const;

export function solarLimbIntensity(mu: number): number {
  const m = Math.min(1, Math.max(0, mu));
  return LIMB_DARKENING.a0 + LIMB_DARKENING.a1 * m + LIMB_DARKENING.a2 * m * m;
}

const LIMB_MINIMUM = solarLimbIntensity(0);
const LIMB_PEAK = solarLimbIntensity(1);

/** Radiance at disc centre. The limb law then takes it down to `* LIMB_MINIMUM`. */
const PHOTOSPHERE_RADIANCE =
  (ACES_SATURATION_RADIANCE * PHOTOSPHERE_LIMB_UNDER_SATURATION) / LIMB_MINIMUM;

/**
 * Scene-linear radiance of the sky the *corona* sits on: the sky beside the sun at totality.
 *
 * Two terms, both from the darkness rework rather than from here. The dome keeps
 * `texColor * irradiance` and `EclipseTimeline`'s irradiance floors at 0.025, so the
 * Preetham sky beside the sun falls from 25 to 0.625. On top of that the patch *adds*
 * `eclipseSky * eclipseDarkness`: at the staged sun -- elevation 8.83 deg, so
 * `direction.y = 0.1535` and `eclipseHorizon = (1 - 0.1535)^12 = 0.1363` -- the zenith,
 * umbral-glow and ring terms of DayNightCycle.ts:389-395 sum to a red-leading 0.114, times
 * an `eclipseDarkness` of 0.975. 0.625 + 0.111 = 0.736.
 *
 * It is a copy of somebody else's constants and it is only ever used to *place* the corona,
 * never to draw the sky, so a drift of a few per cent moves the corona by a few per cent and
 * nothing else. It is written down because the alternative -- anchoring the corona to the
 * photosphere, as the shipped ladder did -- means any retune of the disc silently retunes
 * the one thing that has to stay visible for the whole 15 seconds of totality.
 */
const UMBRAL_SKY_RADIANCE = 0.736;

/**
 * How far the inner corona is drawn over the sky it sits on -- three stops, the same margin
 * the crescent gets over the deep-partial sky.
 *
 * This replaces `INNER_CORONA_RADIANCE = photosphere * LIMB_MINIMUM / 32`, which chained the
 * corona to the photosphere through the Q ladder and was only survivable while the
 * photosphere was 20x too bright. Cutting the disc to its saturation anchor would have
 * dragged the corona to 0.31 -- 0.42x the sky it is drawn on, i.e. invisible, i.e. the
 * owner's fourth sentence deleted by arithmetic done three constants away.
 *
 * The two ends are anchored separately because they are separately exposed in life too: a
 * bead is Q=12 and the inner corona Q=7 in NASA RP-1318 because no single exposure holds
 * them. Inside totality the Q ladder still fixes everything relative to this number.
 */
const INNER_CORONA_OVER_UMBRAL_SKY = 8;

/**
 * NASA RP-1318's eclipse exposure guide, as the ladder it is: brightness goes as 2^Q, so
 * one Q step is one stop. Beads Q=12, chromosphere Q=11, prominences Q=9, inner corona
 * (0.1 R_sun above the limb) Q=7.
 *
 * The shipped shader had these in the right order and far too flat -- beads at 12 against a
 * corona peaking near 3.2, a 3.8:1 where the table says 32:1 -- which is why the diamond
 * ring reads as a slightly brighter smudge instead of the blown-out star everybody who has
 * stood in an umbra describes.
 *
 * https://umbra.nascom.nasa.gov/eclipse/941103/tables/table.15
 */
const Q_INNER_CORONA = 7;
const stopsAboveInnerCorona = (q: number): number => 2 ** (q - Q_INNER_CORONA);

const BEADS_OVER_INNER_CORONA = stopsAboveInnerCorona(12);
const CHROMOSPHERE_OVER_INNER_CORONA = stopsAboveInnerCorona(11);
const PROMINENCE_OVER_INNER_CORONA = stopsAboveInnerCorona(9);

/**
 * The diamond ring has no Q of its own in the table: it is the last bead plus the aureole
 * around it, so it is drawn a quarter-stop over a bead. That lands it at 40x the inner
 * corona, inside the 30-60x the study asks for.
 */
const DIAMOND_OVER_BEADS = 1.25;
const DIAMOND_OVER_INNER_CORONA = BEADS_OVER_INNER_CORONA * DIAMOND_OVER_BEADS;

/**
 * The inner corona, from the sky it sits on rather than from the disc it surrounds.
 *
 * 5.888 against an umbral sky of 0.736: the composite under additive blending is 6.624, so
 * the corona's rim presents at code 240 against a 174 sky. It lands at 0.107 of disc centre
 * where the physical figure is 1e-6, a compression of about 1e5 -- which is the gain a
 * dark-adapting eye applies between partial phase and totality, and the same admission the
 * Q ladder itself makes: a corona and a photosphere have never been photographed in one
 * exposure either.
 */
const INNER_CORONA_RADIANCE = UMBRAL_SKY_RADIANCE * INNER_CORONA_OVER_UMBRAL_SKY;

/**
 * Corona brightness as a power law in r = distance from disc *centre* in solar radii,
 * anchored where the Q table's inner corona is quoted (0.1 R_sun above the limb, r = 1.1).
 *
 * `exp(-radial * 17.0)` is 4-8x too flat near the limb: in this shader's uv units it gives
 * 0.257 at r = 1.5 where the ladder gives 0.059, which is exactly why the shipped corona
 * reads as a uniform halo rather than a bright rim with long faint streamers. The K term
 * (Thomson scattering off free electrons) carries r = 1-2, the F term (sunlight off
 * interplanetary dust) takes over beyond 2 and is what makes the streamers reach.
 *
 * Cross-check against the ladder: this profile falls 48.0x from r = 1.1 to r = 2.0 where
 * Q7 -> Q1 says 64x, and is 1.9x bright at r = 1.5. A single exponent cannot also hold the
 * r^-15.9 slope inside r = 1.2; being slightly bright in the rim is the cheap side to err
 * on for a 1.6-degree drawn sun.
 *
 * **Both terms are evaluated at r, and the SUM is then normalised at the anchor.** The
 * shipped form divided r by 1.1 first and fed that to both powers, which scales K by 1.1^7
 * and F by 1.1^2.5 -- different factors, so F came out low by 1.1^4.5 = 1.536, i.e. 35 per
 * cent. That moved the K/F crossover from 2.44 to 2.69 R_sun, outside the drawn range, and
 * made the comment above -- that the F term takes over beyond 2 -- false everywhere the
 * corona is actually drawn. The fix is arithmetic, not taste: `CORONA_F_FRACTION` is quoted
 * by the dossier against r, so it has to be evaluated against r.
 */
const CORONA_ANCHOR_RADII = 1.1;
const CORONA_K_EXPONENT = -7;
const CORONA_F_EXPONENT = -2.5;
const CORONA_F_FRACTION = 0.018;

const coronaRawProfile = (r: number): number =>
  r ** CORONA_K_EXPONENT + CORONA_F_FRACTION * r ** CORONA_F_EXPONENT;

/** Makes the profile exactly 1 at the anchor, so INNER_CORONA_RADIANCE is the radiance there. */
const CORONA_ANCHOR_NORMALISE = 1 / coronaRawProfile(CORONA_ANCHOR_RADII);

/** The profile at the reference azimuth, i.e. the one whose {@link CORONA_RAY_REACH} is 1. */
export function coronaRadialProfile(solarRadii: number): number {
  return coronaRawProfile(Math.max(1, solarRadii)) * CORONA_ANCHOR_NORMALISE;
}

/** Where K stops carrying the corona and F takes over: r^-7 = 0.018 r^-2.5 at 0.018^(-1/4.5). */
export const CORONA_K_F_CROSSOVER_RADII =
  CORONA_F_FRACTION ** (1 / (CORONA_K_EXPONENT - CORONA_F_EXPONENT));

/**
 * Where the drawn corona ends, as a ratio of SUN_RADIUS rather than a uv distance.
 *
 * Naked-eye corona reaches about 2 R_sun from centre. The shipped `smoothstep(0.5, 0.68)`
 * is 3.1-4.25 R_sun of the drawn disc, which is most of the cartoon-halo complaint against
 * the 3x sun -- and it is recoverable here without touching SUN_RADIUS, which is the one
 * thing that must not move.
 */
const CORONA_OUTER_START_RADII = 1.9;
const CORONA_OUTER_END_RADII = 2.6;

/**
 * Per-azimuth reach: how far THIS ray goes, as a multiplier on the two radii above and on
 * the F term's radial scale. 0.8 to 1.4, so the drawn corona ends between 2.08 and 3.64
 * R_sun depending on which way you look, instead of on a circle.
 *
 * Restores what the HDR rework quietly dropped. The shipped shader had a `rayLength` /
 * `streamers = exp(-radial / rayLength * 3.7)` pair -- a per-azimuth radial SCALE -- and the
 * rework replaced it with `rayGain`, a pure amplitude multiplier on one common profile, so
 * every ray ended at the same radius and the corona's outline went back to being a circle.
 * A corona's silhouette is the feature: solar-minimum streamers reach 2-3 R_sun over the
 * equator while the polar plumes stop just past the limb, and the owner's fourth sentence --
 * the effect must be visible across the whole sky -- is about reach, not about brightness.
 *
 * It scales the F term's radius, not K's, because F is the dust component that carries the
 * corona past 2.44 R_sun (see {@link CORONA_K_F_CROSSOVER_RADII}); stretching K instead
 * would brighten the rim, which is not what a streamer is. The anchor at r = 1.1 is exact
 * only at reach 1.0 and runs 3.5 per cent hot at reach 1.4, which is under the rounding of
 * every constant it multiplies.
 */
const CORONA_RAY_REACH_MIN = 0.8;
const CORONA_RAY_REACH_MAX = 1.4;
/** Biases reach toward the minimum, so long streamers are the few and not the many. */
const CORONA_RAY_REACH_SHAPE = 1.4;

/** Solar-minimum coronae are flattened; this keeps the drawn one off a perfect circle. */
const CORONA_EQUATORIAL_STRETCH = 1.22;

/**
 * The floor under the moon's interior, and the reason it exists.
 *
 * `earthshine * uTotality * 1.3` with `uTotality` exactly 0 below coverage 0.985 and the
 * layer's alpha at 1 writes those pixels as literal 0.0, by design, for the whole of both
 * partial phases -- and exactly-black pixels are a standing invariant at 0.0000 per cent in
 * this project, measured in every baseline frame. The final pass has dithering on, so a
 * value sitting on the code-0/code-1 boundary rounds to black about half the time, which is
 * how the old twilight clip announced itself too.
 *
 * 0.012 scene-linear is 2.1x the radiance that first rounds UP to code 1. That threshold is
 * derived, not guessed: sRGB's linear segment puts the code-0/code-1 boundary at
 * (0.5/255)/12.92 = 1.5176e-4 display-linear; inverting the ACES fit gives a tone-map input
 * of 4.3836e-3; dividing by this hour's `toneMappingExposure / 0.6` of 0.7771 gives
 * 5.641e-3 scene-linear. The 2.1x margin covers the exposure moving under it -- the eclipse
 * cut alone takes it to 0.82x, and it would have to fall to 0.365 before the floor stopped
 * clearing the boundary.
 *
 * Physically it is the airlight in the column in front of the moon: the moon is outside the
 * atmosphere, so the same scattered sunlight that makes the sky beside it bright is also in
 * front of it. Drawn at 0.012 against a 10.5 sky at coverage 0.50 the disc still reads code
 * 3 against code 251 -- the bite the owner wants, minus the literal black.
 */
const MOON_MINIMUM_RADIANCE = 0.012;

const BEAD_RADIANCE = INNER_CORONA_RADIANCE * BEADS_OVER_INNER_CORONA;
const DIAMOND_RADIANCE = INNER_CORONA_RADIANCE * DIAMOND_OVER_INNER_CORONA;
const CHROMOSPHERE_RADIANCE = INNER_CORONA_RADIANCE * CHROMOSPHERE_OVER_INNER_CORONA;
const PROMINENCE_RADIANCE = INNER_CORONA_RADIANCE * PROMINENCE_OVER_INNER_CORONA;

/** The lens-flare cross on the diamond ring, as a fraction of its core. Shipped value. */
const DIAMOND_SPIKE_WEIGHT = 0.42;
/** Three prominence loops can overlap, and `prominenceLoop` is bounded by 1 each. */
const PROMINENCE_LOOP_COUNT = 3;

/**
 * The largest per-channel radiance `SOLAR_FRAGMENT_SHADER` can emit, summing every term at
 * its own peak with every tint normalised to a maximum component of 1.
 *
 * Pinned because a half-float render target holds 65504 and no more, and because going over
 * it is invisible on a dev GPU: Metal stores +Inf, SwiftShader stores NaN, and the frame
 * comes back black in CI only.
 *
 * The sum is now what the shader can *add* to the framebuffer rather than what it can put
 * in it, because the layer blends additively -- so what has to clear the ceiling is this
 * plus the brightest sky underneath it, and 25 against a 76x margin is noise.
 */
/**
 * The whole ladder, in one place, for the test and for whoever retunes it against a
 * measured exposure. Two anchors -- the sky at the eclipse hour and the sky at totality --
 * and every other entry a stated ratio to one of those or to the tone curve's saturation.
 */
export const SOLAR_RADIANCE = {
  sky: ECLIPSE_HOUR_SKY_RADIANCE,
  umbralSky: UMBRAL_SKY_RADIANCE,
  saturation: ACES_SATURATION_RADIANCE,
  photosphere: PHOTOSPHERE_RADIANCE,
  limb: PHOTOSPHERE_RADIANCE * LIMB_MINIMUM,
  innerCorona: INNER_CORONA_RADIANCE,
  beads: BEAD_RADIANCE,
  diamond: DIAMOND_RADIANCE,
  chromosphere: CHROMOSPHERE_RADIANCE,
  prominence: PROMINENCE_RADIANCE,
  moonFloor: MOON_MINIMUM_RADIANCE,
} as const;

export const MAX_SOLAR_RADIANCE =
  PHOTOSPHERE_RADIANCE * LIMB_PEAK +
  INNER_CORONA_RADIANCE * coronaRadialProfile(1) +
  CHROMOSPHERE_RADIANCE +
  PROMINENCE_RADIANCE * PROMINENCE_LOOP_COUNT +
  BEAD_RADIANCE +
  DIAMOND_RADIANCE * (1 + 2 * DIAMOND_SPIKE_WEIGHT);

/**
 * `32` is an int in GLSL and `32.0` is not; every interpolated constant goes through here.
 *
 * Exported so the test builds its expected shader substrings from {@link SOLAR_RADIANCE}
 * through this same helper. Six assertions used to pin derived values as literal strings
 * ('limbI * 666.6667;'), every one a function of a constant whose own doc comment tells the
 * next person to re-edit it -- so the first honest retune of the ladder broke six tests that
 * were measuring nothing except their own arithmetic.
 */
export const glslFloat = (value: number): string => {
  const rounded = Number(value.toFixed(4));
  return Number.isInteger(rounded) ? `${rounded}.0` : `${rounded}`;
};

/**
 * THE COMPOSITE, WRITTEN DOWN, BECAUSE THE LAST ONE WAS SQUARING ITS OWN OUTPUT.
 *
 * This layer is drawn with `blendSrc = blendDst = OneFactor`, so the framebuffer gets
 *
 *     result = emitted + sky
 *
 * and `gl_FragColor.a` reaches the blend equation through `blendSrcAlpha = ZeroFactor`,
 * i.e. not at all. Every term below is therefore a radiance ADDED to whatever the sky pass
 * already put there, which is what an emissive astronomical object physically is: a corona
 * is light arriving from beyond the atmosphere on top of the airlight in front of it, not a
 * surface that replaces the sky.
 *
 * What it replaces was `transparent: true` with `NormalBlending`, i.e.
 * `alpha * color + (1 - alpha) * sky`, with `alpha = clamp(corona)` and
 * `color = coronaColor * corona * 6.25` -- so the emitted light went as **corona squared**,
 * and the composite `6.25 c^2 + 25 (1 - c)` was monotonically DECREASING in c: 25 at c = 0,
 * 14.1 at 0.5, 6.25 at 1. The corona was drawn as a hole in the sky up to 4x darker than
 * the sky, and the more faithfully the Q ladder was followed the darker the hole got. The
 * radial profile inherited the same square: 52.8x of authored falloff from r = 1.1 to 2.0
 * was emitting 2793x, and beyond 2.6 R_sun it emitted exactly nothing.
 *
 * The moon keeps `NormalBlending`, because the moon is the one thing here that genuinely
 * occludes -- and it is the ONLY thing that occludes, which this comment used to get wrong.
 *
 * It said the moon "does not need to occlude the sun, because `visibleSun = sunMask *
 * (1 - moonMask)` already cuts the photosphere out of its disc", and that is not how an
 * alpha-blended layer works: its alpha attenuates everything already in the buffer, the
 * cut-down photosphere included. With both in place the composite was
 *
 *     m * moon + (1 - m) * sky + (1 - m)^2 * photosphere
 *
 * -- the sky occluded once, which is right, and the photosphere occluded twice, which is
 * not. It only shows where `m` is strictly between 0 and 1, i.e. on the single antialiased
 * pixel at the bite's inner edge, and it is worst at m = 0.5, where a quarter of the
 * photosphere goes missing. Isolated on the real pipeline with a fixed sky, the edge pixel
 * at coverage 0.50 read 15.23 scene-linear where one occlusion gives 28.79; at coverage 0.90
 * it is 4.00 against 8.06.
 *
 * HOW VISIBLE THAT IS, measured rather than assumed, because the arithmetic makes it sound
 * larger than it is: in the shipped picture the difference sits AT the capture noise. Two
 * runs of the same build over the same ladder differ by a mean |dLuma| of 0.386 with 61
 * pixels over four levels at coverage 0.93; the same comparison across this change gives
 * 0.407 and 100, and both maxima land on the moon's own limb, where the temporal pass jitters
 * anyway. So this is a correctness fix and a simplification -- one occluder instead of two,
 * and a comment that no longer describes a model the blend state cannot implement -- and it
 * is not a visible change. Claiming otherwise would be the second kind of mistake this file
 * is full of notes about.
 *
 * So the photosphere is emitted uncut and the moon's alpha does all of the occluding, once.
 * That is safe for the selective bloom, which is the reason the cut looked necessary: the
 * bloom masks the INPUT BUFFER by a depth pass of its selection, and this material writes no
 * depth, so the disc is discarded from the bloom either way. See the `depthWrite` note on
 * the constructor for the three measurements that would have to come first to change that.
 */
/**
 * Angular radius of the drawn sun, as a fraction of the billboard's half-width.
 *
 * The real sun is 0.265 degrees in radius and this billboard subtends about 5.07 degrees, so
 * 0.052 would be life size. It has never been life size: 0.16 was about three times that, a
 * deliberate legibility choice, and both judges of the design round killed a proposal to shrink
 * it because at 1.19 degrees the crescent falls under two pixels at coverage 0.90 and goes
 * sub-pixel at 0.95.
 *
 * It is 0.24 now -- 2.43 degrees, about 4.6 times life -- for a measured reason. With the
 * layers isolated one at a time on the built product, the drawn photosphere contributes
 * NOTHING during the partial phases: "sun only" is indistinguishable from "sky only" at
 * coverage 0.72 and 0.96, because the sky beside a sun 8.8 degrees up is Preetham's forward
 * lobe, clipped at 254 of 255, and an additive layer cannot beat white. Every readable pixel of
 * a partial eclipse comes from the MOON, which replaces the sky rather than adding to it. So
 * the one lever on the owner's "you must be able to see the sun being covered" is how many
 * pixels across that dark bite is, and at 0.16 it was ten.
 *
 * The moon keeps the real 1.01875 ratio to the sun, which is what makes totality total.
 */
export const SUN_DISC_RADIUS = 0.24;
export const MOON_DISC_RADIUS = SUN_DISC_RADIUS * 1.01875;

/**
 * The largest |separation| at which the whole moon still fits on the billboard.
 *
 * The moon's far edge sits at `|separation| * (SUN + MOON) + MOON` in billboard half-widths
 * and the quad runs out at 1, so past this the disc is cut by a straight edge -- and a
 * straight-edged moon is worse than no moon. Exported so the test can hold
 * {@link MOON_APPROACH_SEPARATION} under it without either file restating the arithmetic.
 */
export const MOON_BILLBOARD_LIMIT =
  (1 - MOON_DISC_RADIUS) / (SUN_DISC_RADIUS + MOON_DISC_RADIUS);

/**
 * THE CHORD THE MOON CROSSES ON -- derived from the sky, not authored, and it points the other
 * way from what shipped.
 *
 * `uMoonPath` is the unit direction of CELESTIAL EAST at the sun, projected onto the
 * billboard's own two axes. The moon laps the sun eastward, so that IS the direction it
 * travels across the sun's face, and its sign decides which limb the bite starts on.
 *
 * Two errors this replaces, both in one expression. It was
 * `vec2(moonOffset, moonOffset * 0.025)`:
 *
 *  - **Backwards.** Billboard +X is the camera's right vector -- the plane does
 *    `lookAt(camera.position)`, whose basis is `x = up x z` with `z` pointing back at the
 *    camera, which works out to exactly `sunDirection x worldUp`. With separation running -1
 *    to +1 the moon therefore crossed from screen left to screen right and bit the sun's LEFT
 *    limb first. Celestial east at the staged hour has a screen-right component of -0.805, so
 *    it crosses the other way and the first bite belongs on the RIGHT limb. The textbook case
 *    agrees and is in the test: at a northern-hemisphere noon the moon moves left, which is
 *    the eclipse everyone has seen a photograph of.
 *  - **Nearly flat.** 0.025 is 1.43 degrees off horizontal. Celestial east at a sun 8.8
 *    degrees up on a bearing of 297 is 144 degrees round from screen right -- up and to the
 *    left, about 36 degrees off horizontal. A low sun's eclipse is emphatically diagonal, and
 *    the old comment's claim that "the only thing an author gets to choose is the angle" was
 *    the wrong way round: the sky chooses the angle, and the author chooses nothing.
 *
 * It is computed per frame from `sunDirection` rather than baked, so it follows the theme: the
 * autumn declination puts the staged sun on a bearing of 246 instead of 297 and the path tilts
 * with it (145.5 degrees instead of 143.6). Nothing here reads the camera -- the billboard's
 * basis depends only on the sun's direction and world up, which is why the answer is the same
 * from anywhere the viewer stands.
 */
export const MOON_CENTER_CHUNK = /* glsl */ `
    float moonOffset = uSeparation * (SUN_RADIUS + MOON_RADIUS);
    vec2 moonCenter = moonOffset * uMoonPath;
`;

const SOLAR_FRAGMENT_SHADER = /* glsl */ `
  varying vec2 vUv;
  uniform float uTime;
  uniform float uSeparation;
  uniform float uCorona;
  uniform float uBeads;
  uniform float uTotality;
  uniform float uDetail;
  uniform float uProminences;
  uniform float uProminenceDetail;
  uniform float uTransmittance;
  uniform vec2 uMoonPath;

  const float SUN_RADIUS = ${glslFloat(SUN_DISC_RADIUS)};
  const float MOON_RADIUS = ${glslFloat(MOON_DISC_RADIUS)};

  float hash(float n) {
    return fract(sin(n) * 43758.5453123);
  }

  float prominenceLoop(vec2 p, float angle, float width, float height, float phase) {
    vec2 normal = vec2(cos(angle), sin(angle));
    vec2 tangent = vec2(-normal.y, normal.x);
    float radial = dot(p, normal) - SUN_RADIUS;
    float lateral = dot(p, tangent);
    float breathing = 1.0 + 0.035 * sin(uTime * 0.16 + phase);
    vec2 loopSpace = vec2(
      lateral / width,
      (radial - height * 0.34) / (height * breathing)
    );
    float ridge = exp(-pow((length(loopSpace) - 0.54) * 21.0, 2.0));
    float outsideLimb = smoothstep(-0.003, 0.006, radial);
    float localFade = 1.0 - smoothstep(width * 0.72, width, abs(lateral));
    return ridge * outsideLimb * localFade;
  }

  void main() {
    vec2 p = (vUv - 0.5) * 2.0;
${MOON_CENTER_CHUNK}
    float sunDistance = length(p);
    float moonDistance = length(p - moonCenter);
    // The same one-pixel rule the moon's limb uses. The crescent is bounded by BOTH arcs, and
    // past coverage 0.95 it is under two pixels thick; two different ramps there is how a
    // crescent becomes a dashed line.
    float sunEdge = max(fwidth(sunDistance) * 0.5, 1e-5);
    float sunMask = 1.0 - smoothstep(SUN_RADIUS - sunEdge, SUN_RADIUS + sunEdge, sunDistance);
    // Uncut, and the moon's mask is not computed here at all any more. The moon layer's alpha
    // attenuates whatever is in this buffer, so cutting here as well applied the moon's
    // coverage to the photosphere twice. See the blend note above the disc radii.
    float visibleSun = sunMask;

    float mu = sqrt(clamp(1.0 - pow(sunDistance / SUN_RADIUS, 2.0), 0.0, 1.0));
    float limbI = ${glslFloat(LIMB_DARKENING.a0)}
      + mu * (${glslFloat(LIMB_DARKENING.a1)} + mu * (${glslFloat(LIMB_DARKENING.a2)}));
    // Limb darkening is stronger in blue, so the crescent is genuinely redder than the disc.
    vec3 sunColor = mix(vec3(1.0, 0.42, 0.08), vec3(1.0, 0.9, 0.46), mu);
    vec3 color = sunColor * visibleSun * limbI * ${glslFloat(PHOTOSPHERE_RADIANCE)};

    float angle = atan(p.y, p.x);
    vec2 q = vec2(p.x, p.y * ${glslFloat(CORONA_EQUATORIAL_STRETCH)});
    float coronaRadii = length(q) / SUN_RADIUS;
    // True solar radii, clamped at the limb, feeding BOTH powers. Dividing by the anchor
    // first scaled K by 1.1^7 and F by 1.1^2.5, which left F 35 per cent light and pushed
    // the K/F crossover out to 2.69 R_sun, past everything this shader draws.
    float r = max(coronaRadii, 1.0);
    float coarseRays = 0.5 + 0.5 * sin(angle * 11.0 + sin(angle * 3.0) * 2.4);
    float fineRays = 0.5 + 0.5 * sin(angle * 37.0 - uTime * 0.11);
    float rayGain = 0.35 + 0.65 * pow(coarseRays, 1.7) * mix(0.75, 1.0, fineRays * uDetail);
    // Each azimuth gets its own reach as well as its own amplitude: without this every ray
    // ends on the same circle and the corona has no silhouette.
    float rayReach = mix(${glslFloat(CORONA_RAY_REACH_MIN)}, ${glslFloat(CORONA_RAY_REACH_MAX)},
      pow(coarseRays, ${glslFloat(CORONA_RAY_REACH_SHAPE)}));
    float kCorona = pow(r, ${glslFloat(CORONA_K_EXPONENT)}) * rayGain;
    float fCorona = ${glslFloat(CORONA_F_FRACTION)}
      * pow(r / rayReach, ${glslFloat(CORONA_F_EXPONENT)})
      * mix(0.6, 1.0, coarseRays);
    float limbGate = smoothstep(SUN_RADIUS - 0.01, SUN_RADIUS + 0.012, sunDistance);
    float outerFade = 1.0 - smoothstep(
      ${glslFloat(CORONA_OUTER_START_RADII)} * rayReach,
      ${glslFloat(CORONA_OUTER_END_RADII)} * rayReach, coronaRadii);
    float corona = (kCorona + fCorona) * ${glslFloat(CORONA_ANCHOR_NORMALISE)}
      * limbGate * outerFade * uCorona;
    // Near-neutral: the K corona is a touch bluer than the photosphere and the F corona a
    // touch warmer. Brightness carries the structure, not hue.
    vec3 coronaColor = mix(vec3(0.92, 0.95, 1.0), vec3(1.0, 0.97, 0.92), coarseRays);
    color += coronaColor * corona * ${glslFloat(INNER_CORONA_RADIANCE)};

    float chromosphere =
      exp(-pow((sunDistance - SUN_RADIUS) * 260.0, 2.0)) * uTotality;
    color += vec3(1.0, 0.08, 0.023) * chromosphere * ${glslFloat(CHROMOSPHERE_RADIANCE)};

    float prominence = prominenceLoop(p, 2.48, 0.052, 0.050, 0.3);
    prominence += prominenceLoop(p, -0.43, 0.044, 0.038, 2.1) *
      smoothstep(0.28, 0.58, uProminenceDetail);
    prominence += prominenceLoop(p, 0.92, 0.034, 0.030, 4.4) *
      smoothstep(0.7, 0.96, uProminenceDetail);
    prominence *= uProminences;
    vec3 prominenceColor = mix(
      vec3(0.674, 0.035, 0.008),
      vec3(1.0, 0.149, 0.021),
      clamp(prominence, 0.0, 1.0)
    );
    color += prominenceColor * prominence * ${glslFloat(PROMINENCE_RADIANCE)};

    float edgeContact = exp(-pow((moonDistance - MOON_RADIUS) * 260.0, 2.0));
    float solarEdge = exp(-pow((sunDistance - SUN_RADIUS) * 210.0, 2.0));
    float beadCells = step(0.69, hash(floor((angle + 3.14159265) * 15.0)));
    float beads = edgeContact * solarEdge * beadCells * uBeads;
    // No per-pixel bead shade here any more. It was mix(0.62, 1.0, smoothstep(0.0, 0.35,
    // mu)) and it landed on exactly the wrong pixel: a bead is gated by solarEdge, which
    // peaks at sunDistance == SUN_RADIUS, where mu == 0 -- so at the bead's brightest point
    // the "gradient" was identically its 0.62 floor, and the shipped bead peaked at 124
    // while this file, the constants block and the test all said 200. The gradient it was
    // reaching for is real but wants the MOON-limb coordinate, not the sun's mu; inventing
    // that here would be a second guess on top of the first, so the bead is its Q=12 value
    // and the constant now tells the truth.
    color += vec3(1.0, 0.73, 0.34) * beads * ${glslFloat(BEAD_RADIANCE)};

    float contactSide = uSeparation >= 0.0 ? -1.0 : 1.0;
    // On the chord, not on the x axis: the last bead is on the limb the moon has yet to
    // cover, and that limb is opposite the moon along the direction it is travelling.
    vec2 diamondCenter = contactSide * SUN_RADIUS * uMoonPath;
    vec2 diamondDelta = p - diamondCenter;
    float diamondCore = exp(-dot(diamondDelta, diamondDelta) * 190.0);
    float diamondHorizontal = exp(-abs(diamondDelta.y) * 82.0 - abs(diamondDelta.x) * 11.0);
    float diamondVertical = exp(-abs(diamondDelta.x) * 82.0 - abs(diamondDelta.y) * 11.0);
    float diamond = (diamondCore
      + (diamondHorizontal + diamondVertical) * ${glslFloat(DIAMOND_SPIKE_WEIGHT)}) * uBeads;
    color += vec3(1.0, 0.78, 0.4) * diamond * ${glslFloat(DIAMOND_RADIANCE)};

    // Cloud attenuates the beam and that is the whole of it now. The old form also faded
    // alpha to 0.16, which under NormalBlending was how the cloudy sky got to show through
    // the disc; additive blending never took the sky away, so keeping that factor would
    // have dimmed the sun twice for one cloud.
    color *= uTransmittance;
    // Below this nothing the encoder can represent changes, even against the darkest sky
    // this scene reaches: it is a fifth of the radiance that first rounds up to code 1.
    if (max(color.r, max(color.g, color.b)) < ${glslFloat(MOON_MINIMUM_RADIANCE / 10)}) discard;
    gl_FragColor = vec4(color, 1.0);
  }
`;

/**
 * WHY THE SUN GETS A DRAWN OUTLINE, and why nothing else here can be seen.
 *
 * The arithmetic first, because it is what decides this and it is not close. The crescent is an
 * ADDITIVE layer on a sky that sits at the ACES clip, so however bright it is authored it
 * presents at code 255, and its contrast against the sky is 255 minus the sky's code:
 *
 *   coverage    0.05   0.20   0.50   0.75   0.90   0.95
 *   sky code   254.2  253.6  250.7  241.5  207.2  156.0
 *   crescent      +0.8   +1.4   +4.3   +13.5  +47.8  +99.0   <- the whole bright budget
 *   opaque dark  251    250    248    242    204    153      <- an opaque mark at 0.012
 *
 * So below about three quarters of coverage the bright side of a partial eclipse cannot be
 * drawn AT ALL in this exposure -- one code, then one, then four -- while a dark mark outguns
 * it by roughly 180 to 1. No shader change moves that: the ceiling is the sky, and the sky is
 * the owner's and is not being touched. Whatever the partial phases show has to be dark.
 *
 * WHAT DARK MARK. The honest one is the lune -- the intersection of the two discs, which is
 * exactly and only what a photograph of a partial phase contains. Research done for this change
 * put a hard bound on it: in a bright-sky frame at 91.7 per cent obscuration, a paired
 * radial-shell test over 51,857 pixel pairs found the region behind the moon differs from
 * mirrored sky by -0.19 levels of 255 against a scatter of 4.26, i.e. nothing. The moon outside
 * the sun is not dimly visible in photographs; it is absent.
 *
 * But a lune ALONE was tried here and rejected by the owner, who called it an egg. He was
 * right, and the reason is worth stating precisely: a vesica floating in a white field has no
 * circle to be a bite out of, because the sun it is biting is invisible. The shape was correct
 * and orphaned.
 *
 * So the sun is given its own outline: a hairline at its limb, opaque, {@link LIMB_STROKE_PIXELS}
 * pixels wide wherever it is drawn. That is an invented object -- no photograph contains a dark
 * ring around the sun -- and it is the smallest invention that makes the correct shape legible.
 * It replaces a much larger one: a partial-opacity moon disc drawn over the whole sky, which
 * had no referent either AND put the brightest object in the frame in the wrong place, since
 * that disc is the MOON and it sits offset from the sun. Measured on the shipped build at
 * coverage 0.15, the drawn ball was centred 24 px down-right of the sun with its leading third
 * black and the rest at rgb(207,164,72) -- a two-tone sphere split along a line corresponding
 * to nothing the viewer can see. That is the incoherence being fixed.
 */

/**
 * How wide the outline is, in DISPLAY PIXELS at any viewport and field of view -- `fwidth`
 * carries it -- and why it is four and not one.
 *
 * A LINE, NOT A GRADIENT. The first version of this ramped from the line's centre outward,
 * `1.0 - smoothstep(0.0, halfWidth, |d - R|)`, which is a soft band whose alpha reaches 1 only
 * on its centreline. An EIGHT PIXEL band of it drew as a single pale orange hairline, because
 * a partially opaque dark mark on a sky past the ACES clip is not a faint mark, it is no mark:
 * halving a destination of 33 leaves 16.5, still above the clip point of 25.7, still code 253.
 * Only full opacity reads, at code 3. So the line is flat-topped, with a pixel of antialiasing
 * on each side and everything between it at alpha exactly 1.
 *
 * THEN THE TEMPORAL PASS TAKES ITS SHARE. `TemporalResolvePass` jitters the projection along a
 * Halton sequence with an amplitude of 0.75 px and accumulates, so a mark whose solid core is
 * thin never stays fully covered across the jitter set and never reaches alpha 1 in the
 * resolved image. Measured on the built product at coverage 0.208, on a ray through the limb:
 *
 *   2.5 px line, taa on    luma  99 ... 212   (brown, the thing this change exists to remove)
 *   2.5 px line, taa=0     luma   8            (black -- so the shader was right and TAA ate it)
 *   4.0 px line, taa on    luma   8 over 2.25 px
 *
 * Four pixels is what leaves a core the jitter cannot erode. On the 47 px drawn sun that is a
 * proportionate hairline, and at 1:1 it reads as a small ring rather than as a cartoon.
 */
export const LIMB_STROKE_PIXELS = 4.0;

/**
 * The outline is drawn as an ARC that opens out of the bite and later retracts into it, never
 * as a ring that fades up and down.
 *
 * Both alternatives were rejected on measurement rather than taste. Fading a ring's ALPHA puts
 * it at intermediate opacity over a warm sky, which is the brown this whole change exists to
 * remove -- at alpha 0.5 a 1.5 px line presents rgb(215,176,80), a spread of 135 between red
 * and blue. Fading its WIDTH takes it below a pixel, where `fwidth` antialiasing turns a line
 * into a crawling dashed one. Growing an arc costs one `acos`, never leaves full opacity and
 * never goes under a pixel, and it reads as the bite drawing the sun's edge out of itself.
 *
 * It opens by coverage 0.08 -- 5.7 s of the ninety -- and retracts between 0.62 and 0.80,
 * which is set by the crescent's own thickness rather than by preference: the outline lies ON
 * the sun's limb, so it eats the outer 1.5 px of the crescent, and the crescent measures 17.1
 * px thick at coverage 0.50, 10.1 at 0.70, 5.1 at 0.85 and 1.8 at 0.95. Past 0.8 the line
 * would be taking a third of the crescent and then all of it. By then it is not needed: the
 * sky has fallen far enough that the crescent clears it by 13.5 codes at 0.75 and 47.8 at 0.90,
 * and carries the picture on its own.
 */
export const LIMB_STROKE_OPEN_COVERAGE = 0.08;
export const LIMB_STROKE_RETRACT_FROM = 0.62;
export const LIMB_STROKE_RETRACT_TO = 0.8;
/**
 * Half the arc, in radians about the sun's centre, once the outline has closed. Past pi on
 * purpose: at exactly pi the two ends of the arc meet with the soft join between them still
 * open, and the ring keeps a visible gap on the side opposite the bite for ever.
 *
 * It starts at ZERO, so before first contact -- coverage exactly 0 -- there is no outline at
 * all, which is what there should be: nothing has happened yet.
 */
export const LIMB_STROKE_CLOSED_ARC = 3.4;

const MOON_FRAGMENT_SHADER = /* glsl */ `
  varying vec2 vUv;
  uniform float uSeparation;
  uniform float uCoverage;
  uniform float uTotality;
  uniform float uTransmittance;
  uniform vec2 uMoonPath;

  const float SUN_RADIUS = ${glslFloat(SUN_DISC_RADIUS)};
  const float MOON_RADIUS = ${glslFloat(MOON_DISC_RADIUS)};

  void main() {
    vec2 p = (vUv - 0.5) * 2.0;
${MOON_CENTER_CHUNK}
    float d = length(p - moonCenter);
    // The moon's limb, antialiased against the pixel grid rather than against a magic number.
    // It was smoothstep(MOON_RADIUS - 0.003, MOON_RADIUS + 0.003, d): 0.003 billboard units
    // is 0.26 px at the framing these measurements were taken on -- a half-pixel ramp, i.e. a
    // hard edge with stair-steps on it -- and a different number of pixels on every other
    // viewport and field of view, so no constant is right anywhere but here. fwidth(d) is how
    // much d changes between neighbouring pixels, so a ramp of half of it either side is one
    // pixel wide wherever it is drawn. This is the ONLY occluder in the billboard: the solar
    // layer emits the photosphere uncut and this alpha takes it away, once.
    float moonEdge = max(fwidth(d) * 0.5, 1e-5);
    float moonMask = 1.0 - smoothstep(MOON_RADIUS - moonEdge, MOON_RADIUS + moonEdge, d);

    // Over the photosphere the moon is never anything but opaque: there it is not a
    // silhouette, it is the thing taking the light away, and the solar layer emits the disc
    // uncut precisely so that this alpha can do it once.
    float sunDistance = length(p);
    float sunEdge = max(fwidth(sunDistance) * 0.5, 1e-5);
    float sunMask = 1.0 - smoothstep(SUN_RADIUS - sunEdge, SUN_RADIUS + sunEdge, sunDistance);

    // The lune, and nothing else: the moon is drawn only where it lies on the sun. Outside it
    // there is no moon in any photograph at any exposure, and the disc that used to be drawn
    // there was the largest invented object in the frame.
    float lune = moonMask * max(sunMask, uTotality);

    // ...and the sun's own limb, so the lune has a circle to be a bite out of. The arc opens
    // out of the bite and retracts into it; see the constants for why not alpha and not width.
    vec2 moonDir = normalize(moonCenter + uMoonPath * 1e-4);
    float away = acos(clamp(dot(normalize(p + vec2(1e-6)), moonDir), -1.0, 1.0));
    float reach = ${glslFloat(LIMB_STROKE_CLOSED_ARC)}
      * smoothstep(0.0, ${glslFloat(LIMB_STROKE_OPEN_COVERAGE)}, uCoverage)
      * (1.0 - smoothstep(${glslFloat(LIMB_STROKE_RETRACT_FROM)},
                          ${glslFloat(LIMB_STROKE_RETRACT_TO)}, uCoverage));
    float px = max(fwidth(sunDistance), 1e-6);
    float halfWidth = px * ${glslFloat(LIMB_STROKE_PIXELS * 0.5)};
    float onLimb = 1.0 - smoothstep(halfWidth - px * 0.5, halfWidth + px * 0.5,
      abs(sunDistance - SUN_RADIUS));
    float stroke = onLimb * (1.0 - smoothstep(reach - 0.18, reach, away))
      * (1.0 - uTotality);

    float mask = max(lune, stroke);
    if (mask < 0.002) discard;

    float rim = smoothstep(MOON_RADIUS * 0.62, MOON_RADIUS, d);
    vec3 earthshine = mix(vec3(0.003, 0.004, 0.008), vec3(0.015, 0.02, 0.034), rim);
    // Against the photosphere the moon is BLACK; the old flat 0.5x grey painted earthshine
    // over the bite at every coverage, which is half of why there was no bite to see.
    // uTotality is 0 below coverage 0.985, and 1.3 is the 0.5 + 0.8 the old term reached.
    //
    // The floor under it is the standing invariant: uTotality is exactly 0 through both
    // partial phases and the disc is now opaque across its whole area, so without the max()
    // every pixel of a moon that is on screen for the entire ninety seconds would be written
    // as literal 0.0 -- and exactly-black pixels are held at 0.0000 per cent in every
    // baseline frame here. With dithering on in the final pass they round to rgb(0,0,0)
    // about half the time. The max() is last so cloud cannot take the disc back under it.
    // See MOON_MINIMUM_RADIANCE for where 0.012 comes from.
    //
    // The alpha carries no cloud term. It used to be multiplied by mix(0.35, 1.0, uTransmittance), and
    // "clear" weather in this world is cloud cover 0.12, so the moon was 90 per cent opaque
    // on a clear day: ten per cent of a sky that is Preetham's forward lobe near a low sun,
    // clipped at 254, came through the disc and filled the bite to 218. That is the whole of
    // why a partial eclipse had no visible bite. A cloud in front of the moon does not make
    // the moon translucent -- it puts cloud in front of it, which is what uTransmittance on
    // the COLOUR is for. The moon is a rock; it is opaque.
    vec3 interior = earthshine * uTotality * 1.3 * uTransmittance;
    gl_FragColor = vec4(
      max(interior, vec3(${glslFloat(MOON_MINIMUM_RADIANCE)})),
      mask
    );
  }
`;

/**
 * Camera-relative solar billboard. Its angular size remains stable while the
 * user dollies away from the city, but normal depth testing still allows the
 * skyline to occlude a low Sun.
 */
export class EclipseVisual {
  private readonly geometry = new THREE.PlaneGeometry(120, 120);
  private readonly solarMaterial: THREE.ShaderMaterial;
  private readonly moonMaterial: THREE.ShaderMaterial;
  private readonly solarMesh: THREE.Mesh;
  private readonly moonMesh: THREE.Mesh;
  private readonly anchor = new THREE.Group();
  private readonly groundEffects: EclipseGroundEffects;
  private readonly tmpPosition = new THREE.Vector3();
  private readonly tmpEast = new THREE.Vector3();
  private readonly tmpRight = new THREE.Vector3();
  private readonly tmpUp = new THREE.Vector3();
  private elapsed = 0;

  constructor(scene: THREE.Scene) {
    /**
     * `depthWrite` stays false, and raising radiance 546x is not the change that gets to
     * flip it. The selective bloom the disc is handed to discards it (`keep = !isMaxDepth`,
     * and with both this material and the Sky at depthWrite false the depth under the sun is
     * the cleared 1.0), so the obvious move is to write depth. Three things have to be
     * measured before that, in this order: (1) the null test -- paired captures at fixed
     * world state with `bloomPass.enabled` true and false, scoring masked mean|delta| on the
     * disc minus a surrounding ring, to confirm the mask really is what discards it rather
     * than something downstream; (2) the moon layer, which is the SAME geometry at the SAME
     * anchor drawn after this one and survives only on the default LessEqual depth func --
     * a z-fight there lands precisely on the bite; (3) the composer's depth texture, which
     * also feeds the depth-reading atmosphere pass, the NormalPass override and the
     * DepthOfFieldEffect at focusDistance 58, any of which would newly see a surface at 680.
     */
    this.solarMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        // Parked at fourth contact, where the timeline leaves it between eclipses.
        uSeparation: { value: 1 },
        uCorona: { value: 0 },
        uBeads: { value: 0 },
        uTotality: { value: 0 },
        uDetail: { value: 1 },
        uProminences: { value: 0 },
        uProminenceDetail: { value: 1 },
        uTransmittance: { value: 1 },
        uMoonPath: { value: new THREE.Vector2(1, 0) },
      },
      vertexShader: VERTEX_SHADER,
      fragmentShader: SOLAR_FRAGMENT_SHADER,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      // `result = emitted + sky`, spelled out rather than taken from AdditiveBlending,
      // which is `SrcAlpha, One` unless `premultipliedAlpha` is also set and would put the
      // squaring straight back. The alpha channel is left alone -- ZeroFactor on src, One
      // on dst -- because the composer's buffer alpha belongs to the passes downstream and
      // an additive layer has no business accumulating into it. See SOLAR_FRAGMENT_SHADER.
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
      blendEquationAlpha: THREE.AddEquation,
      blendSrcAlpha: THREE.ZeroFactor,
      blendDstAlpha: THREE.OneFactor,
      fog: false,
      toneMapped: false,
    });
    this.moonMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uSeparation: { value: 1 },
        uCoverage: { value: 0 },
        uTotality: { value: 0 },
        uTransmittance: { value: 1 },
        uMoonPath: { value: new THREE.Vector2(1, 0) },
      },
      vertexShader: VERTEX_SHADER,
      fragmentShader: MOON_FRAGMENT_SHADER,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      // The one layer here that genuinely occludes, so the one that keeps NormalBlending:
      // `alpha * moon + (1 - alpha) * sky`. Drawn after the solar layer (renderOrder -19
      // against -20), so at totality it also takes back the inner corona it covers.
      blending: THREE.NormalBlending,
      fog: false,
      toneMapped: false,
    });

    this.solarMesh = new THREE.Mesh(this.geometry, this.solarMaterial);
    this.moonMesh = new THREE.Mesh(this.geometry, this.moonMaterial);
    this.anchor.name = 'eclipse-celestial-anchor';
    this.solarMesh.name = 'eclipse-solar-layer';
    this.moonMesh.name = 'eclipse-moon-layer';
    this.solarMesh.renderOrder = -20;
    this.moonMesh.renderOrder = -19;
    this.anchor.add(this.solarMesh, this.moonMesh);
    this.anchor.visible = false;
    this.anchor.frustumCulled = false;
    this.solarMesh.frustumCulled = false;
    this.moonMesh.frustumCulled = false;
    scene.add(this.anchor);
    this.groundEffects = new EclipseGroundEffects(scene);
  }

  setQuality(level: QualityLevel): void {
    this.solarMaterial.uniforms.uDetail.value = level === 'low' ? 0 : level === 'medium' ? 0.55 : 1;
    this.groundEffects.setQuality(level);
  }

  update(
    camera: THREE.Camera | null,
    sunDirection: THREE.Vector3,
    state: EclipseRenderState,
    dt: number,
    cloudCover: number
  ): void {
    this.elapsed += Math.max(0, dt);
    const phenomena = this.groundEffects.update(camera, state, dt, cloudCover);
    this.anchor.visible = state.active && camera !== null;
    if (!this.anchor.visible || !camera) return;

    this.tmpPosition.copy(sunDirection).multiplyScalar(680).add(camera.position);
    this.anchor.position.copy(this.tmpPosition);
    this.anchor.lookAt(camera.position);
    this.updateMoonPath(sunDirection);

    this.solarMaterial.uniforms.uTime.value = this.elapsed;
    this.solarMaterial.uniforms.uSeparation.value = state.separation;
    this.solarMaterial.uniforms.uCorona.value = state.corona;
    this.solarMaterial.uniforms.uBeads.value = state.beads;
    this.solarMaterial.uniforms.uTotality.value = state.totality;
    this.solarMaterial.uniforms.uProminences.value = phenomena.prominences;
    this.solarMaterial.uniforms.uProminenceDetail.value = phenomena.prominenceDetail;
    this.moonMaterial.uniforms.uSeparation.value = state.separation;
    // uCoverage is back, and doing a different job. It used to feed
    // `smoothstep(0.0, 0.055, uCoverage)`, an alpha ramp complete by five per cent of coverage
    // that therefore said nothing about anything; it now carries the whole reveal.
    this.moonMaterial.uniforms.uCoverage.value = state.coverage;
    this.moonMaterial.uniforms.uTotality.value = state.totality;
    const transmittance = THREE.MathUtils.clamp(1 - cloudCover * 0.82, 0.08, 1);
    this.solarMaterial.uniforms.uTransmittance.value = transmittance;
    this.moonMaterial.uniforms.uTransmittance.value = transmittance;
  }

  /**
   * The billboard's own two axes, and celestial east written in them.
   *
   * `lookAt` builds its basis as `z = eye - target`, `x = up x z`, `y = z x x`. The anchor
   * looks AT the camera from `sunDirection * 680 + camera.position`, so `z` is minus the sun's
   * direction and the basis works out to `x = sunDirection x worldUp`, `y = x x sunDirection`
   * -- the camera's right and up, and a function of the SUN alone. Nothing here reads where
   * the camera stands or which way it points, which is why the moon crosses the same way from
   * every viewpoint.
   *
   * Recomputed per frame because the sun moves: the theme's declination changes its bearing
   * over the 2.2 seconds of a theme morph, and a baked chord would lag it.
   */
  private updateMoonPath(sunDirection: THREE.Vector3): void {
    const right = this.tmpRight.crossVectors(sunDirection, WORLD_UP);
    if (right.lengthSq() < 1e-12) return; // sun at the zenith; unreachable at this latitude
    right.normalize();
    const up = this.tmpUp.crossVectors(right, sunDirection).normalize();
    const east = celestialEastAt(sunDirection, this.tmpEast);
    const x = east.dot(right);
    const y = east.dot(up);
    const length = Math.hypot(x, y);
    // The sun is never within a degree of the pole here, so east always has a component in
    // the billboard plane; the guard is for the degenerate case rather than for this world.
    const path = length < 1e-6 ? [1, 0] : [x / length, y / length];
    (this.solarMaterial.uniforms.uMoonPath.value as THREE.Vector2).set(path[0], path[1]);
    (this.moonMaterial.uniforms.uMoonPath.value as THREE.Vector2).set(path[0], path[1]);
  }

  getBloomObjects(): THREE.Object3D[] {
    return [this.solarMesh];
  }

  getOcclusionExclusions(): THREE.Object3D[] {
    return [
      this.solarMesh,
      this.moonMesh,
      ...this.groundEffects.getOcclusionExclusions(),
    ];
  }

  dispose(): void {
    this.anchor.removeFromParent();
    this.groundEffects.dispose();
    this.geometry.dispose();
    this.solarMaterial.dispose();
    this.moonMaterial.dispose();
  }
}
