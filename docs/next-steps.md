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

## 12. The sky dome is switched off for most of twilight, and the best physics here never touches it

Measured 2026-09-12 by porting the shader to CPU and probing the live build.

Three.js's `Sky` computes all in-scattering from `sunIntensity(dot(sunDir, up))`, whose
`cutoffAngle` is 92.308 degrees of zenith angle. The dome's contribution is **exactly zero from
2.308 degrees below the horizon onward**, and it has already lost 87% by −2:

| sun elevation | `vSunE` | fraction of its value at sunset |
| --- | --- | --- |
| 0 | 26.49 | 100% |
| −1 | 15.10 | 57% |
| −2 | 3.57 | 13% |
| **−2.308** | **0.0000** | **0%** |

That is **61% of civil twilight** with the largest surface on screen reduced to a flat dark wash,
while `SunlightSpectrum`'s ozone model drives the fog, ambient and hemisphere lights through a full
colour ramp. Sky and light visibly disagree, twice a day.

Preetham also paints the **anti-solar** horizon red — measured R/B 3.96 at 3 degrees of elevation,
1.14 by 15 — the inverse of reality, where a blue-grey Earth's shadow sits low with the pink Belt
of Venus above it. Hosek & Wilkie name this as Preetham's headline defect. `OVERVIEW_SHOT` and
`golden-hour` both look toward −X/−Z with sunrise at +X, so **the wrongest part of the dome is dead
centre of the two most-used shots at dawn.**

The seam is `installEclipseSkyShader()`, which already patches this shader and guards with a
version check. Do not mirror to `envSky`: the probe is built once at preload.

**This changes what dawn looks like, so it is the owner's call before it starts.**

## 13. The lighting ramps read a 4.4-degree sun as night

Measured on the live build: at 4.4 degrees `directSunFactorAt` gives 0.037 and `nightFactorAt`
0.49, so the city shows with every window lit where a real sun that high gives a clearly daylit,
strongly warm scene. `FULL_NIGHT_ELEVATION_DEG = -10` and `DIRECT_SUN_FADE_ELEVATION_DEG = 14` are
art direction, not a physics gap.

It matters now because the opening moment was restored to its authored dawn at 2.87 degrees, so
**the product opens inside this range** — and any improvement to the sky will be judged against a
scene these ramps are holding dark.

---

## Suggested order

1. ~~Item 10 (the 21-minute settle loop)~~ — done.
2. Item 1 (the simulation seam) — everything else is cheaper afterwards.
3. Item 5 (`CityRepresentation`) — do it inside item 1's refactor.
4. Item 6's remaining 98 — measure their CI cost first; the 28-second figure was a GPU reading.
5. Item 2 (`bootstrap` parameterisation), item 3 (the lazy AR chunk seam).
6. Item 8, then item 9's list.

Item 4 needs nothing but a lockfile refresh, and item 7 is done.
