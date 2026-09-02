# Hybrid spike — Osiedle Centralne (design)

Status: approved for a reversible spike on 2026-09-02. Not a frozen art direction and not
an implementation plan for the whole city. The spike ends with renders, measurements and one
recommendation: implement, simplify, or reject.

## Why

The owner accepted the diagnosis of the current voxel city (flat facades, repetitive
greenery, flat ground, box roofs) and, after a three-direction concept comparison, chose the
"soft-voxel / architectural model" hybrid. The accepted hero corner showed what the fragment
should look like: real building families with metre-based heights, glass windows, living
ground floors, curbs, a bus at the stop, a legible resident. This spike checks whether that
look survives the real renderer, the real post-processing pipeline and the real budgets.

## Scope

- One fragment: Osiedle Centralne. Blocks with `BLOCK_CONFIGS` indices `3, 4, 5, 24, 25`, the
  pavement cells inside `x ∈ [-30, 12], z ∈ [0, 40]`, a forecourt in front of block 25, one
  crosswalk east of the shelter, and the two dominants (heat-plant chimney, RTV tower).
- Behind a developer flag: `?world=hybrid-direct` or `?world=hybrid-greedy`. Default
  (`voxel`) renders exactly today's city. Nothing changes without the flag.
- All spike code lives in `src/world/hybrid/` and loads as its own chunk (`hybrid-spike`)
  through a dynamic import, so the entry chunk budget (240 000 B) is not touched beyond a few
  hundred bytes of glue. No bundle limit is raised before the results are in.
- Two geometry strategies consume the same semantic input (`SurfacePrimitive[]`):
  direct surface generation and greedy meshing of a voxelised copy. The losing strategy is
  deleted after the decision; the product never keeps two renderers.
- Kept from the product inside the fragment: trees, lamps, benches, the kiosk, the bus
  shelter with its lights and posters, the bus passengers, cyber towers, window point lights.

## Gates (owner's acceptance criteria)

1. **Three frames** rendered by the real pipeline: the current overview, a street-eye frame at
   1.7 m, and golden hour (plus a night street frame as a bonus). The bus must not stand on the
   zebra, the resident must be legible, shop windows get procedural content, exposure must not
   blow out the far plane.
2. **Apples-to-apples measurement** in the Diorama pipeline: primary-pass and multipass
   triangles, draw calls, programs, generation time, memory, p95 CPU/GPU on High and Low.
   Existing thresholds apply: ≥ 58 FPS, p95 ≤ 20.5 ms, ≤ 1400 draw calls, ≤ 500 geometries,
   ≤ 80 textures, TTI ≤ 1.8 s.
3. **Screen-space LOD** with hysteresis and additive layers, no visible popping in the tour.
   Window cohorts, themes, snow, wetness and the deterministic seed keep identical semantics at
   every LOD level.
4. **Heights stay in metres.** ×1.8 only for explicitly flagged point towers. Roofs, balconies
   and ground floors pass collision, route and anchor checks.

Added to the spike:

- **Ground contact and clearance.** Both bicycle wheels touch the pavement without cutting it;
  the leaning bicycle has a believable tilt and support points; the rack encloses a wheel;
  residents stand exactly on the pavement; benches, bins, shelters and lamps neither float nor
  sink; the bus stops at the stop and never on the crosswalk. The check runs as unit tests on
  the semantic model and as a runtime raycast check that also runs after LOD changes.
- **Dominant duet: chimney + RTV tower.** The tower is a slender brutalist concrete shaft with
  a technical platform, antennas and red aviation lights, original and procedural, with a Low
  variant. It must read from the default camera and the tour, not occlude the lake, the
  railway or the chimney, work by day, in fog, at golden hour and at night, and stay a landmark
  rather than a monster. Two sites are proposed, one recommended. Future hooks for
  transmissions and signal events exist as data only; nothing is implemented for them now.

## Architecture

```
main.ts ──parseWorldMode──▶ createWorld(scene, wind, { excludeBlocks, excludeGroundCell })
   │                          (voxel city minus the fragment when the flag is on)
   └─ import('./world/hybrid/HybridSpike') ──▶ attachHybridSpike({ scene, strategy, ... })
                                                   │
        CityModel (semantic, deterministic) ───────┤
        architecture.ts / streetscape.ts / dominants.ts ─▶ SurfacePrimitive[] per cluster
                                                   │
        DirectSurfaceStrategy | GreedyVoxelStrategy ─▶ BufferGeometry per (cluster, layer, glass)
                                                   │
        HybridMaterial (one shader, palette uniforms, cohorts, snow, wet, AO, styles)
        ScreenSpaceLod (px/m thresholds, hysteresis, cooldown, Low caps at L1)
        GroundContact (probes + clearance; unit tests + runtime raycast)
```

### Semantic input

`CityModel` is pure data built from `WorldLayout` with the layout seed only. For each fragment
block it decides the family (slab, point tower, tenement, walk-up), keeps `heightMetres =
block.h`, derives floors from the family's floor height, and marks `pointTower` only for the
explicit set `{5}`. It also lists pavement cells, curb edges, forecourt cells, the crosswalk,
props with contact probes, and the two dominants with their sites.

`SurfacePrimitive[]` (boxes, planes, convex prisms, cylinders) is the only thing a strategy
sees. Every primitive carries `layer` (0 massing, 1 openings and street furniture, 2 frames
and fine trim), `palette` index, `cohort` (−1 or 0..4), `style` (0 plain, 1 prefab seams,
2 pavement grid, 3 asphalt patches, 4 glass) and a baked `ao` factor.

### One material, identical semantics at every LOD

All layers of all clusters share one `HybridMaterial` (plus one transparent instance for shop
glass). The palette is a uniform array; themes replace palette entries by their origin colour
exactly like today's `lookEntries`; snow lerps to per-entry snow tints on up-facing surfaces;
wetness darkens and smooths wet-reactive entries; window cohorts read
`residentialWindowActivityAt(t01, cohort)`, the same function `DayNightCycle` uses. Because the
LOD layers only toggle visibility of geometry that shares this material and these attributes,
Gate 3's semantic identity holds by construction.

### Screen-space LOD

`pixelsPerMetre = viewportHeightPx / (2·tan(fov/2)) / distance`. Per cluster: L1 enters at
9 px/m and leaves at 7; L2 enters at 36 and leaves at 30; a 250 ms cooldown prevents flicker;
Low never enters L2. Layers are additive, so a switch never changes the silhouette.

### Ground contact and clearance

Every spike prop declares contact probes (world points that must lie on the ground surface
within 12 mm) and, where relevant, a clearance rectangle. `groundHeightAt(x, z)` comes from the
model: pavement and forecourt top at `GROUND_SURFACE_Y + 0.12`, everything else at
`GROUND_SURFACE_Y`. The bus envelope at dwell (lead at the stop's `atT`, 8 m behind it) must
not intersect the crosswalk rectangle. The product's bus passengers at Osiedle Centralne are
lifted onto the raised pavement through `bus.setStopGroundOffset('Osiedle Centralne', 0.12)`,
and the runtime check verifies their feet against the raised surface.

### Dominants

- Chimney at `(-58, -40)`, 46 m, with boiler house; two red aviation lights.
- RTV tower, recommended site A `(16, -66)` south of Dworzec Południowy; alternative site B
  `(-70, 22)` west of Stacja Zachodnia. 62 m total: 44 m concrete shaft with four vertical
  fins, technical platform at 34 m with railing, equipment boxes and two dishes, small upper
  platform at 41 m, lattice mast to 62 m, seven red aviation lights. Low variant: octagonal
  shaft, one bare platform, single-tube mast, three lights. Site validation: off roads, ≥ 4 m
  from blocks, ≥ 8 m from rails, ≥ 3 m from trees, inside the diorama, outside the lake; from
  the default camera the tower's bearing differs from the chimney's by ≥ 20° and from the
  lake's by ≥ 25°.

## Frames (checkpoints inside the spike chunk)

| id | camera | time | weather | bus |
|---|---|---|---|---|
| `spike-overview` | `OVERVIEW_SHOT` | 0.50 | clear | at Osiedle Centralne |
| `spike-street` | `(6.5, 1.2, 21.0) → (-9, 1.9, 30)` (eye 1.7 m above the pavement) | 0.50 | clear | at Osiedle Centralne |
| `spike-golden` | `OVERVIEW_SHOT` | 0.28 | clear | at Osiedle Centralne |
| `spike-night-street` | street camera | 0.90 | clear | at Osiedle Centralne |

## Measurement

`scripts/performanceBenchmark.mjs` gains `BENCH_WORLD=voxel|hybrid-direct|hybrid-greedy`
(passed as the `world` query parameter) and the spike scenarios above. Metrics add primary-pass
triangles and calls (captured by a `LambdaPass` right after the `RenderPass`), multipass
triangles, programs, hybrid generation time and geometry bytes, and JS heap when available.
Runs: High and Low, for `voxel` (baseline), `hybrid-direct`, `hybrid-greedy`.

## Out of scope

Trees, lamps, kiosk and shelter geometry in the new language; the rest of the city; wind on
hybrid foliage; transmissions, blinking lights or signal events; any bundle-budget change;
removing the losing strategy (that follows the decision).
