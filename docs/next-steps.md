# Next steps — the pre-AR audit, what is left

Written 2026-09-11, after an audit run against the question *"what should we tidy before
starting AR?"*. Five items were fixed the same day and are in `0a8e7c2`; everything below is
what was found and deliberately **not** done, so that the next person does not have to
rediscover it.

Every number here was measured unless it says otherwise. Where a claim is an inference from
reading, it says so — those are the ones to re-check before acting.

---

## 1. There is no seam between simulation and presentation

`animate()` in `src/main.ts` is 330 lines. Roughly 200 of them are simulation that does not
care how the frame is shown — the clock, weather, lighting, eight actors, two cities. The
rest is presentation: camera controls, shadow focus, twelve post-process uniforms, the HUD,
the composer render.

A second presentation mode has to either copy those 200 lines, which then drift, or thread
`if (arMode)` through a function that already carries four interacting locks (`isPaused`,
`isCheckpointLocked`, `isTourActive`, `eclipseCheckpointLocked`).

The pattern to finish already exists: `ExperienceDirector` is explicitly documented as
knowing nothing about Three.js, and `FrameContext` is the allocation-free per-frame carrier.
What is missing is one object that owns the twenty subsystems and takes a `FrameContext`.

**Effort: 1–2 days. This is the item that decides whether AR costs three days or three
weeks.** Do it before the first AR commit, not after.

**First half done in `5642362`.** `animate()` is now three phases — `animate` (bookkeeping and
camera damping), `stepWorld` and `presentWorld` — with a `WorldFrame` carrier between the last
two. The seam is **eight values**, and they were found rather than chosen: exactly the locals
declared before the camera update that are still referenced after it. `WorldFrame` holds no
Three.js object.

It is three phases and not two because the order is load-bearing: damping runs before the world
steps, since the hybrid LOD measures pixels per metre against the camera damping just moved; and
camera automation runs after, since it follows vehicles the world has just moved.

Verified as a no-op by the full local smoke, non-CI arm included: `callsPeak` 1371, `callsMedian`
1328, `geometries` 422 — the same three numbers as the run before the split — plus
`nightBusStopFps` 60.0 and zero browser errors.

**What is left is the owning object.** Twelve module-level `let`s are still mutated from inside
the phases (`eclipseState`, `eclipseReaction`, `previousDayProgress`, `themeBlend`,
`optionalActorAccumulator`, `ambientEvent`, `ambientTicks`, `hudAccumulator`,
`shadowFocusAccumulator`, `loadingHidden`, `loadingCompletedAt`, `rafId`), and the phases still
reach module scope for every subsystem handle. Until those move, a second presenter can call
`stepWorld` but cannot own a second world. That is where item 5 belongs.

## 2. `bootstrap` assumes one window, one canvas and one sky

Three things are structurally coupled, not merely reading globals:

- `document.body.appendChild(renderer.domElement)` with no container and no defined stacking
  order — the CSS2D layer just picks `zIndex: '9'`. Camera passthrough needs the canvas
  composited over a `<video>` in a known order.
- `new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' })` —
  **no `alpha: true`**, so there is no transparent clear to see a camera feed through.
- `scene.fog` plus the 2000-unit sky dome that `DayNightCycle` owns unconditionally. Both
  have to be absent in passthrough, and nothing today can turn them off.

The `window.innerWidth` / `devicePixelRatio` reads are shallow by comparison and are all
inside `syncSize()` — threading a size in is mechanical. **Effort: 2–4 hours for the
parameterisation and an `alpha` + mount-target option; the sky and fog ownership is a
separate, smaller decision.**

**Done for everything but the visible sky.** `bootstrap` now takes `container`, `alpha`, `fog`
and `viewport`, all defaulting to exactly today's behaviour, and `windowViewport` is the default
size source rather than an assumption baked into five call sites. `alpha` also zeroes the clear
alpha, which three does not do on its own. `syncSize` reads the viewport once per resize instead
of five times — harmless for a window, wrong for a video frame, where five reads are five
answers.

**The visible sky is left, and here is why it is its own decision.** `DayNightCycle` builds
*two* `Sky` instances: `this.sky` at 2000 units, added to the main scene and carrying the
patched eclipse shader, and `this.envSky`, added to a private `envScene` for reflections and
ambient. Passthrough wants the first one gone and the second one kept — the world should still
take its light and its reflections from a sky, it just must not paint a dome over the camera
feed. The cheap move is to skip `scene.add(this.sky)` while keeping the object, so every uniform
write and the eclipse patch keep working and the dome simply is not drawn. It needs a home for
the flag: the constructor takes positional arguments after `hooks`, and `DayNightHooks` is about
light handles, not about what gets drawn.

## 3. ~~The entry chunk has 766 bytes free~~ — 2 100 free after the 2026-09-12 split

244 734 of 245 500, after that ceiling was raised deliberately on 2026-09-11. AR needs a
device-orientation permission flow, a quaternion-to-camera mapping, `getUserMedia` plumbing
and a mode switch — several kB at least. It cannot live in `main.ts`.

**The consequence is a decision, not a number: the AR path has to be a lazy chunk from its
first line.** That seam is cheap to create up front and expensive to retrofit around a
half-written feature.

**Updated 2026-09-12.** The ceiling went to 249 500 to fit the seasonal sun (920 B) and the
atmospheric light model (2 530 B), then came straight back to 245 500: splitting
`SunlightSpectrum` and `RainbowOptics` into an eagerly-loaded `atmosphere-physics` chunk took
the entry from 249 065 to **243 400**, which is 2 100 bytes of room rather than the 435 the
raise had left. The lesson is the cheaper one the file already argued for elsewhere — reach for
the split before the purchase.

## 4. ~~The `three` ceiling~~ — checked, and it is not a ceiling

**Corrected 2026-09-11, the same day it was written.** The claim above was one release out of
date when I made it. Verified against the npm registry and the GitHub API:

- `postprocessing@6.39.5` shipped **2026-09-09** with `three: ">= 0.168.0 < 0.187.0"`.
- `three@0.186.0` shipped **2026-09-08** — the peer range was widened one day later.
- The same one-day lag holds across four consecutive minors (6.39.0 `<0.184`, 6.39.1
  `<0.185`, 6.39.2 `<0.186`, 6.39.5 `<0.187`). The repository is `pmndrs/postprocessing`,
  active, and its recent commits are backports from a v7 line.

So this is a normal lag, not a wall, and nothing needs deciding. Two notes that do matter:

- **`postprocessing@6.39.5` is free to take now** — `^6.39.2` already covers it, so it is a
  lockfile refresh, not a manifest change. It brings an `EffectComposer` multisampling
  fallback, which this project touches at runtime through `composer.multisampling`.
- **Do not bump `three` yet, and the reason is not the peer range:** `@types/three` has no
  0.186 release. Since `build` now runs `tsc --noEmit`, bumping today would typecheck a
  0.186 runtime against 0.185 definitions. Take both together when the types appear.

`v7` is not an escape hatch: its last beta was 2026-02-19 and its peer range is
`>= 0.179.0 < 0.184.0`, which would drag `three` *backwards*.

**And the AR premise itself is settled:** iOS Safari still does not implement WebXR in 2026,
on iPhone or visionOS, with no published timeline. So the route is camera passthrough plus
`DeviceOrientationEvent` — and `three@0.185.1` covers all of it. `getUserMedia`, a transparent
canvas over a `<video>`, and quaternion-to-camera are either browser APIs or arithmetic.
**The version is not going to be the constraint; the iOS permission prompts are.**

## 5. Two cities, five hand-synchronised setter pairs, no shared interface

`setThemeBlend`, `setSnowCover`, `setWetness`, `setCyberRise` and `setQuality` are each called
separately for the voxel city and the hybrid one, in two different places in `main.ts`.
Nothing checks that a new city-wide parameter reaches both; only a browser test would notice.

The duplication of the two cities is **not** debt — `spikeFlag.ts` explains that the voxel
world is the reference the hybrid was measured against, and the acceptance harness still runs
it. What is undefended is the absence of a named interface over the five shared setters. AR
will almost certainly add a sixth city-wide parameter (a scale, a clipping distance, a
"hide the far half" toggle). **Effort: 3–4 hours, and it removes eight lines from the frame
loop that item 1 is going to refactor anyway.**

## 6. CI still cannot see ~98 browser-smoke assertions — **partly done**

`scripts/browserSmoke.mjs` has `if (IS_CI) { … } else { … }` where the `else` does not close
for 800 lines. Two legs have been lifted out of it and now run in CI: the tall-window
draw-call guard (2026-09-11) and the phone-layout leg — viewport overflow, five overlap
checks and the 24 px touch-target minimum. Both were provable because they open their own
page and reference nothing from either arm; both were confirmed by mutation under `CI=true`.

**What is left is roughly 98 assertions that share one page whose state each step depends on**
— eclipse totality and corona, checkpoint determinism, the postman, the cow, the bus stops,
the tour. They cannot be lifted the same way. The honest options are to run the whole `else`
in CI, or to restructure the sequence.

**The 28-second figure is retracted (2026-09-11): it was read on a machine with a graphics
card.** The local measurement was real — CI arm 24 s, non-CI arm 52 s — but CI runs SwiftShader,
where a rendered frame costs seconds. The first run that exercised both lifted legs measured the
gap: the phone leg cost **1 min 14 s** on CI against a few seconds locally, and the tall-window
gate cost **21 min 14 s**. See item 10.

So the CI cost of the remaining 98 is **unknown**, not twenty-eight seconds. They share the
desktop page, which runs `low` at 1.30 MP and is cheaper per frame than the tall gate, but how
much cheaper has not been measured. Measure it before deciding. The flake-surface concern stands
either way, because those 98 include pixel comparisons against a software rasteriser.

## 7. ~~The deployed artifact is never the validated artifact~~ — **done 2026-09-11**

The measured `dist/` now travels from the browser-smoke job to the deploy job as an artifact,
with the provenance manifest beside it, and `scripts/verifyArtifact.mjs` checks every file's
size and sha256 on arrival — and refuses anything in `dist/` the manifest does not list,
because an extra file is how you would smuggle something in. The checker comes from the
repository rather than the artifact: one that travelled with the thing it checks would check
nothing. Verified both ways locally.

## 8. Budget constants are duplicated across the two harnesses, and one has already drifted

`GEOMETRY_BUDGET`, the entry-chunk ceiling, the 50 000 B main/bootstrap budget, the 1 400
draw-call budget and a 14-line `softAssert` block all exist twice, in `browserSmoke.mjs` and
`spikeSmoke.mjs`. `spikeSmoke` carries a comment instructing a human to keep them in step.

One has already drifted: the tall-window geometry check hard-codes `600` instead of using
`GEOMETRY_BUDGET.hybrid`. **AR will move these numbers — that is the point of the feature —
so this is worth 45 minutes before it does.** The correct pattern is already in the repo:
`browserSmoke.mjs` reads `POSTMAN_UNIFORM_COLOR` out of the source at runtime, with a comment
explaining that a literal once failed a deliberate colour change instead of a regression.

## 9. Smaller, named here so they are not lost

- **The 112 m / 102 m near-far gate and the 32 + 18 m ambient-occlusion cutoff are bare
  literals** in a file where everything else carries a measured justification. A handheld AR
  camera lives at 1–3 m and would cross the near-far boundary on every step. Name them and
  record what they were tuned against. *The 50 m figure is an inference from the option names;
  confirm against the library before writing it down.*
- **The quality auto-tune thresholds (18 / 21 / 15.2 / 16.2 ms) and the device heuristic
  (cores ≤ 4, memory ≤ 4, cores ≥ 8) are unnamed.** `navigator.deviceMemory` does not exist in
  Safari, so on the iPhone the heuristic reduces to `hardwareConcurrency >= 8` — **and nobody
  has measured what that returns on the target device.** It decides whether AR starts on `low`
  (no shadows, no bloom, no AO) or `high`.
- **`?taa` is documented as off-by-default in two places and has been on by default since
  2026-09-11** — `src/bootstrap.ts` and `vite.config.js`. Ten minutes, and worth doing before
  AR, because someone debugging ghosting will read those comments and believe them.
- **`HybridSpike.getMetrics()` returns a `cyber` field its own interface does not declare**,
  surviving because the boundary type is `unknown`. Nothing reads it. Declare it or delete it.
- **The `.claude/worktrees/` worktree is a stale full copy of the repo.** Excluded from vitest
  on 2026-09-11, but it still confuses every editor search. Deleting it is thirty seconds.
- **`primaryCalls` and `primaryTriangles` are unasserted, but they are not expensive —
  ~~a dedicated composer pass on every production frame~~ was wrong, corrected 2026-09-12.**
  The capture is a `LambdaPass` from the `postprocessing` library, which renders nothing: its
  body copies two integers out of `renderer.info.render` between passes, and the file's own
  comment at `bootstrap.ts:253` already said "a LambdaPass cannot render". There is no frame
  cost to reclaim here, so the only open question is the real one: nothing asserts either
  number, and `primaryCalls` is exactly what would say whether stereo rendering doubled the
  scene cost or the post cost.

## 10. ~~The smoke step costs 41 minutes of CI, and 21 of them are one settle loop~~ — **done 2026-09-11**

Measured on run 34602359888 (`c834d99`), the first run in which every leg was live:

| leg | window | renders | cost |
| --- | --- | --- | --- |
| desktop | 1440x900, dSF 1 (1.30 MP) | `auto` resolves to **low** | 18 min 46 s |
| phone | 375x812, dSF 3 | medium | 1 min 14 s |
| tall-window gate | 1440x657, dSF **2** (2880x1314, 3.78 MP) | `quality=high` pinned | **21 min 14 s** |

The browser job went from 20 min 07 s to 41 min 57 s. I expected the phone leg to be the
expensive one; it is not. The tall gate is, and it was lifted out of the dead `else` in the same
batch without its CI cost being measured either.

The gate burns 180 settle frames plus 40 samples of two frames — 260 frames at about 4.9 s each.
**The settle loop is the waste.** Those 180 frames exist to clear the LOD's 0.25 s wall-clock
cooldown and its hysteresis: three seconds on a 60 fps machine, fifteen minutes here, for the
same quarter second. A settle that waits on wall time, or on the count going quiet, with a small
frame floor beneath it, would return most of those minutes and change nothing that is asserted.

**Do not cut the cost by lowering `deviceScaleFactor`.** The LOD is driven by
`lodPixelsPerMetre`, so the scale factor is load-bearing for exactly the draw-call count this
gate exists to catch; halving it would make the gate measure a window nobody sits in. The sample
count deserves the same care: `callsPeak` is a peak because the train, the bus and the gulls
wander in and out of a frustum this wide.

**Fixed in `a32f817`.** Both loops now wait on the simulation clock, which `getState()` reports
as `elapsedSimulation`. Neither budget moved and neither leg was removed.

Verified two ways, because the arithmetic alone would not have been evidence:

- **Locally**, the gate reads the same window: `callsPeak` 1371, `callsMedian` 1328,
  `geometries` 422, against 1373 before the change. The settle spent 176 frames where the old
  code spent a fixed 180 — the same 3 s, because this machine renders it at 58.6 Hz.
- **Under a 20x CPU throttle**, where a frame costs 323 ms and the 0.1 s clamp bites, the two
  loop bodies were run back to back on one page: **70 frames and 16.2 s** against **260 frames
  and 60.2 s**. That is 30 settle frames plus 40 sample frames, exactly what the clamp predicts.

**Measured on run 34622681298 (`00a5d28`), which is no longer a projection:**

| leg | before | after |
| --- | --- | --- |
| desktop | 18 min 46 s | 18 min 56 s — untouched, as intended |
| phone | 1 min 14 s | 1 min 14 s — untouched |
| tall-window gate | 21 min 14 s | **7 min 27 s** |
| browser job | 41 min 57 s | **28 min 21 s** |

The gate reported `settleFrames` 30 and `sampleFrames` 40 — exactly the 70 frames the 0.1 s
clamp predicts and the throttled probe measured. `simSeconds` came out at 7 against 4.88
locally, so on CI the gate now sweeps *more* simulated time than on a developer's machine, not
less. `callsPeak` read 1379 against the 1400 budget.

**The desktop leg's 18 min 46 s is not explained and not addressed here.** It has no fixed
settle of this kind — `settleFrames(page)` waits two frames and carries a comment that already
knew this trap — and its camera loops count input steps rather than time. Decomposing it needs
its own measurement.


## 11. ~~The reflection probe renders black~~ — **root-caused and fixed 2026-09-12**

**It was never the probe's build moment and never the season.** Three.js's Preetham solar disc is
`vSunE * 19000 * Fex`, which clears the half-float ceiling of 65504 once the sun is about 17
degrees up — and every PMREM target is `HalfFloatType`. Four over-range texels at the disc became
**10 109 NaN of 786 432** after PMREM's convolution, and every material lit by that probe rendered
black: a 4.9 kB frame where a healthy one is 89–114 kB.

An unrelated bug had been feeding the warm-up an accidental declination that held the sun below 17
degrees. Fixing that correct bug removed the accidental shield, so it presented as "the seasonal
sun broke rendering". October noon at 30 degrees was equally black.

**The store, not the arithmetic, is what hid it:** the same four texels are `+Inf` on ANGLE Metal
and `NaN` on SwiftShader, and CI has no GPU. `withRadianceCeiling()` clamps both skies — the
probe's and the visible one, which had the same overflow and drew the sun as a **black dot** with
the frame's mean luminance unchanged at 228, which is why it outlived the entire investigation.

Five wrong explanations preceded the right one. What settled it was reading the texels back.
`npm run test:software-render` now answers it in three minutes, and was validated in both
directions before being trusted.

## 12. ~~The sky dome is switched off for most of twilight~~ — **half fixed 2026-09-12**

The dome now carries `SunlightSpectrum`'s twilight below the horizon, and the two defects the
audit named are gone from it. **The presented frame at civil twilight is still black, and the
reason is not the dome.** Both halves are below, with the numbers.

### What the dome was

Three.js computes all in-scattering from `vSunE = sunIntensity( dot( sunDir, up ) )`, whose
`cutoffAngle = 1.6110731556870734` is **2.30769 degrees** of depression. Evaluated off the
shipped shader: 81.51 at +5 degrees, 26.49 at 0, 15.10 at −1, 3.57 at −2, and **0.0000 at
−2.30769** — 61% of civil twilight with no dome at all. Preetham also reddens the *antisolar*
horizon, the inverse of the real blue-grey shadow with the Belt of Venus above it, which
Hosek & Wilkie name as its headline defect.

Measured again here on the live GPU, sun at +0.499 degrees, tone mapping off, the diorama's
own uniforms (turbidity 4.60, rayleigh 3.52, mie 0.0156), reading the dome alone at an exact
direction — an instrument independent of the CPU port the audit used, and agreeing with it:

| view elevation | antisolar R/B, CPU port | antisolar R/B, live dome |
| --- | --- | --- |
| 3 | 3.96 | **3.74** |
| 15 | 1.14 | **0.94** |

### What replaced it

`withTwilightDome()` is a third patch on `SKY_OUTPUT_MARKER`, applied **before**
`withRadianceCeiling` because it is the only one of the three that *adds* radiance; the
eclipse patch only ever mixes darker, so it stays between the clamp and the write. The patch
now throws if it is handed an already-clamped shader, so the wrong order cannot ship.

- **The hand-off is Preetham's exact complement**, `1 − vSunE(e)/vSunE(0)`: 0 at the horizon,
  0.430 at −1, 0.865 at −2, 1 at −2.30769. Above the horizon it is exactly 0, so a daylit
  frame is bit-identical.
- **Colour comes from the module that knows why.** The zenith hue is
  `twilightSkyColorCached(e).color` — (0.231, 0.541, 1.000) through the whole of civil
  twilight — and the belt's is `beamTransmittanceColor(0)` normalised, (1.0000, 0.1881,
  0.0000): the one twilight path that grazes *under* the ozone rather than through its
  Chappuis band, which is why the belt is pink where the zenith is blue.
- **Earth's shadow is geometry, not a band.** A line of sight must climb `z* − h = h·beta/gap`
  above the shadow before it is lit, where `h` is `shadowHeightKm` and `gap` the elevation
  over the shadow's edge — which sits at the solar depression on the antisolar side and
  *below* the horizon toward the sun, so the same expression gives the dark segment and the
  bright twilight arch. Extending `twilightSkyColor`'s integral to a slanted antisolar line of
  sight measures the cost of that climb as `exp(−(z*−h)/Z)` with Z = 0.28, 1.13, 2.16 and 3.30
  km for a sun 1, 2, 3 and 4 degrees down — about a quarter of the shadow height each time, so
  the kilometres cancel and the shader carries `4·beta/gap`.
- **The belt fades over 0.20 rad.** Fitted to that same integral: 0.1435, 0.1595 and 0.2305 at
  2, 3 and 4 degrees down. 0.20 is the top of that range, because the integral is single
  scattering with no stratospheric aerosol — the layer `SunlightSpectrum` names as missing.
  Adding a 20 km aerosol layer to it moves the fit to 0.188 / 0.219 / 0.344. This is the one
  number a measurement did not hand over on its own.
- **Brightness is continuous across the hand-off**, not chosen: Preetham's zenith with the sun
  on the horizon measures linear (0.0080, 0.0179, 0.0339), luminance 0.01699, and the hue that
  replaces it has luminance 0.5083.

### The dome, before and after

Linear radiance, dome alone, term forced off in the same tick as the control.

Sun **−3.00**, antisolar azimuth:

| view elevation | R/B before | R/B after | luminance before | after |
| --- | --- | --- | --- | --- |
| 1 | 0.135 | 0.135 | 2.78e−4 | 2.78e−4 |
| 3 | 0.588 | **0.588** | 3.37e−4 | 3.37e−4 |
| 6 | 1.360 | 1.578 | 4.37e−4 | 5.70e−4 |
| 10 | 1.819 | 1.668 | 7.13e−4 | 1.47e−3 |
| 12 | 2.190 | **1.413** | 8.40e−4 | 2.00e−3 |
| 20 | 2.044 | 0.856 | 1.33e−3 | 3.75e−3 |
| 30 | 1.766 | 0.589 | 1.62e−3 | 4.77e−3 |
| zenith | 1.378 | 0.452 | 3.06e−3 | 7.93e−3 |
| solar side, 3 | 0.596 | 1.522 | 3.38e−4 | 4.58e−3 |

The acceptance pair is met: **0.588 at 3 degrees and 1.413 at 12**, against a baseline note of
3.96 and 1.14. Below 3 degrees the term contributes exactly nothing — that is Earth's shadow,
and it is supposed to be dark. The solar horizon gained a factor of 13.5 and went warm: the
twilight arch, which Preetham had switched off entirely.

Sun **−3.96**, zenith: 3.06e−3 → 5.17e−3 and R/B 1.378 → 0.655. Sun **−2.91** (autumn,
t01 0.27064): 3.08e−3 → 7.45e−3 and R/B 1.225 → 0.493.

### Daylight is untouched

Whole presented frame, both captures inside one tick with nothing between the renders:

| sun | with the term | with it forced off | delta |
| --- | --- | --- | --- |
| +19.95 | 93.9902 | 93.9882 | **+0.002%** |
| +61.21 | 106.9665 | 107.0577 | **−0.085%** |

Both are inside the composer's own frame-to-frame noise; `twilight.x` is exactly 0 in all
four captures. The budget bought 1 144 B of a 1 209 B allowance, leaving 65.

### What is NOT fixed, and it is the part the owner will see

**The presented frame at civil twilight is still black, and the dome is no longer why.** At sun
−3.79, aimed at the antisolar sky, the top 30% of the frame reads mean luminance **0.0296 with
the term and 0.0302 without** — a difference below the instrument's own noise, on a band that
is entirely dome (forcing the term to flat red at strength 4 takes the same band to 49.3).

Sweeping the term's radiance against that band measures the gap:

| `twilight.x` | band mean luminance |
| --- | --- |
| 0.0055 (physical, sun −3.8) | 0.030 |
| 0.03 | 0.033 |
| 0.1 | 0.056 |
| 0.3 | 6.72 |
| 1 | 75.9 |

The dome would need roughly **fifty times** the physically correct twilight radiance before
ACES plus the cinematic grade put one luminance level on the sky, at the exposure
`sceneExposure` gives night (0.362 measured at that moment, against 0.394 at noon). That is
item 13's territory, one floor down: the exposure ramp barely opens up at twilight, so a
correct sky is graded to black. **Making the dome brighter to compensate would be the wrong
fix** — it would put a step at −2.308 where the whole design is continuity — so this is left
for the owner alongside item 13.

Sweeping the sun across the hand-off, camera aimed at the solar horizon, mean luminance of the
upper 55% of the presented frame, both captures in one tick:

| sun | `twilight.x` | exposure | sky band, term on | term off |
| --- | --- | --- | --- | --- |
| +2.00 | 0 | 0.427 | 136.72 | 136.70 |
| +0.99 | 0 | 0.419 | 97.87 | 97.86 |
| 0.00 | 1.4e−5 | 0.409 | 50.22 | 50.23 |
| −0.50 | 6.4e−3 | 0.406 | 30.82 | 30.68 |
| −0.99 | 1.2e−2 | 0.396 | 14.75 | 14.58 |
| −1.51 | 1.5e−2 | 0.390 | 3.85 | 3.74 |
| −1.99 | 1.6e−2 | 0.386 | 0.140 | 0.111 |
| −2.30 | 1.7e−2 | 0.381 | 0.011 | 0.012 |
| −3.00 | 1.0e−2 | 0.374 | 0.014 | 0.014 |
| −6.00 | 3.8e−4 | 0.351 | 0.017 | 0.018 |

**A factor of 4500 in 2.3 degrees, and the term's own strength is at its maximum exactly where
the picture reaches zero.** Exposure moves 7% across that whole span. Nothing about the dome can
answer this; it is the grade, and it is the reason the owner's four screenshots look the way
they do.

**The solar-side twilight arch is warm but not bright enough relative to the zenith.** In this
model the arch and the zenith are both fully lit — there is no shadow to climb over toward the
sun — so the arch comes out at 0.75 of the zenith's luminance rather than the several times
brighter a real one is, and it reads bright only because it is saturated orange. The physical
term is there in the geometry: toward the sun the ray is lit *below* the shadow height, which is
`exp( +4 beta / gap )`, and it is clamped off at 1 because it runs away as `gap` reaches the
horizon — `exp(2095)` at the clamp floor, which is an overflow, not a sky. A bounded form of it
is the obvious next improvement and wants its own measurement.

**Preetham's antisolar inversion above the horizon is also untouched**, by construction: the
hand-off is zero there, so at +0.5 degrees the dome still measures R/B 3.74 at 3 degrees of
elevation against 0.94 at 15, before and after. `OVERVIEW_SHOT` and the `golden-hour`
checkpoint sit in exactly that range. Fixing it means a term that is live in daylight, which is
a different decision and a different budget.

### Found on the way, not fixed

**Nothing in the diorama drives Three.js's cloud uniforms.** Read off the live material,
`cloudCoverage` and `cloudDensity` are still the stock 0.4 and `cloudScale` 0.0002, so the Sky
shader's own cloud block is live on every sky fragment above the horizon: a five-octave fbm
twice over, 40 `sin` per fragment, for a layer no art direction asked for. Below −2.308 degrees
its `cloudColor *= vSunE * 0.00002` is zero, so what it actually does at twilight is multiply
up to 40% of the sky toward black in a noise pattern. The twilight term is added after it, at
the output write, for exactly that reason. Turning the block off is a free win on sky-heavy
frames and a visible change to the daylit sky, so it is a separate decision.

### One trap for whoever measures this next

**`dayNight.sunLight.position` is not the sun direction.** `update` writes
`sunDir * 140 + snappedFocus`, so normalising it mixes in the shadow focus: at one probed
moment it read +2.551 degrees where the sun was at +0.499. Read
`sky.material.uniforms.sunPosition` instead — that is the unit vector the vertex shader takes
`vSunE` from. Two more traps cost a run each: `captureFrame` twice around an `await
image.decode()` lets a frame tick through, which made a daylight comparison come back 29% apart
with the term provably zero in both; and the probe camera must be narrow, since a 20-degree
field of view centred on 3 degrees of elevation averages straight across the shadow's edge.

## 13. The lighting ramps read a 4.4-degree sun as night

Measured on the live build: at 4.4 degrees `directSunFactorAt` gives 0.037 and `nightFactorAt`
0.49, so the city shows with every window lit where a real sun that high gives a clearly daylit,
strongly warm scene. `FULL_NIGHT_ELEVATION_DEG = -10` and `DIRECT_SUN_FADE_ELEVATION_DEG = 14` are
art direction, not a physics gap.

It matters now because the opening moment was restored to its authored dawn at 2.87 degrees, so
**the product opens inside this range** — and any improvement to the sky will be judged against a
scene these ramps are holding dark.

That last sentence stopped being a prediction on 2026-09-12: item 12 put a physically correct
twilight on the dome and the presented sky did not move, because `sceneExposure` gives 0.362 at
a sun 3.8 degrees down against 0.394 at noon. **Whatever is done here should be measured on the
sky band, not only on the city** — item 12 carries the transfer curve that says the dome would
need fifty times its real radiance to reach one luminance level through the current grade.

---

## Suggested order

1. ~~Item 10 (the 21-minute settle loop)~~ — done.
2. Item 1 (the simulation seam) — everything else is cheaper afterwards.
3. Item 5 (`CityRepresentation`) — do it inside item 1's refactor.
4. Item 6's remaining 98 — measure their CI cost first; the 28-second figure was a GPU reading.
5. Item 2 (`bootstrap` parameterisation), item 3 (the lazy AR chunk seam).
6. Item 8, then item 9's list.

Item 4 needs nothing but a lockfile refresh, and item 7 is done.
