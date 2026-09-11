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

## 4. `three@0.185.1` is the last version `postprocessing@6.39.2` accepts

The peer range closes at `< 0.186.0`. WebXR improvements land in `three` minors, so the first
time AR wants a newer `three` the choice is between it and a six-pass post-processing chain.

Because `three` is `0.x`, npm's caret pins the minor, so nothing breaks by accident — the
breakage is opt-in, and AR will opt in. **Fifteen minutes of reading the `postprocessing`
release notes now turns a mid-feature crisis into a scheduling decision.** *Not verified: I
did not query the registry for whether a newer `postprocessing` widens the range.*

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

## 6. CI runs 131 of this repo's 241 browser-smoke assertions

`scripts/browserSmoke.mjs` has `if (IS_CI) { … } else { … }` where the `else` does not close
for 818 lines. 125 assertions run before the branch and 6 inside the CI arm; **110 never run
in CI at all** — mobile layout, checkpoint determinism, eclipse totality, the postman, the
cow, the bus stops, the tour.

The tall-window draw-call guard was in that branch and was moved out on 2026-09-11. The rest
were left, because moving 110 assertions wholesale would change CI's runtime and flake
surface in one step. The right shape is probably to move the deterministic structural
assertions out and keep only the genuinely GPU-dependent pixel comparisons conditional.
**Effort: 1–2 hours, and it should be done before AR, because the three things CI cannot
currently see — mobile layout, draw calls at an unusual aspect ratio, scene determinism — are
the three things AR is most likely to break.**

## 7. The deployed artifact is never the validated artifact

`.github/workflows/deploy.yml` runs its own `npm ci` and `npm run build` and publishes that
`dist/`. It does not consume the bundle that `prepareBuild.mjs` signed and `browserSmoke.mjs`
verified. So the whole provenance apparatus — 309 lines whose header lists three previously
caught holes — stops at the CI boundary, and the shipped bundle gets no budget check.

**Effort: ~30 minutes.** Upload `dist/` as an artifact from the browser-smoke job and have
the deploy job download it instead of rebuilding.

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

---

## Suggested order

1. Item 1 (the simulation seam) — everything else is cheaper afterwards.
2. Item 5 (`CityRepresentation`) — do it inside item 1's refactor.
3. Item 6 (the CI branch) and item 7 (the deploy artifact) — before AR can be trusted to ship.
4. Item 2 (`bootstrap` parameterisation), item 3 (the lazy AR chunk seam).
5. Item 4 (the `three` ceiling) — fifteen minutes, any time, but before the first bump.
6. Item 8, then item 9's list.
