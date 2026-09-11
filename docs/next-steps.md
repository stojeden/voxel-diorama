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

## 3. The entry chunk has 766 bytes free

244 734 of 245 500, after that ceiling was raised deliberately on 2026-09-11. AR needs a
device-orientation permission flow, a quaternion-to-camera mapping, `getUserMedia` plumbing
and a mode switch — several kB at least. It cannot live in `main.ts`.

**The consequence is a decision, not a number: the AR path has to be a lazy chunk from its
first line.** That seam is cheap to create up front and expensive to retrofit around a
half-written feature.

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
- **`primaryCalls` and `primaryTriangles` cost a dedicated composer pass on every production
  frame and no gate asserts either.** Either assert them or drop the pass. `primaryCalls` is
  exactly the number that would say whether stereo rendering doubled the scene cost or the
  post cost.

## 10. The smoke step costs 41 minutes of CI, and 21 of them are one settle loop

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

---

## Suggested order

1. Item 10 (the 21-minute settle loop) — the shortest of these, and every run afterwards is
   faster, including the runs that will measure everything below it.
2. Item 1 (the simulation seam) — everything else is cheaper afterwards.
3. Item 5 (`CityRepresentation`) — do it inside item 1's refactor.
4. Item 6's remaining 98 — measure their CI cost first; the 28-second figure was a GPU reading.
5. Item 2 (`bootstrap` parameterisation), item 3 (the lazy AR chunk seam).
6. Item 8, then item 9's list.

Item 4 needs nothing but a lockfile refresh, and item 7 is done.
