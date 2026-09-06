import { describe, expect, test } from 'vitest';
import { buildCityModel, type DominantSpec } from '../CityModel';
import { isReplacedByCyber, planBuilding, planCyberCity, planDominant } from './CyberCity';
import { SMOKE_LIFE_SECONDS, SMOKE_PARCELS, smokeWindDirection } from '../ChimneySmoke';

const model = buildCityModel();

/**
 * Three regressions, and only three.
 *
 * They are the three things that were actually wrong or could quietly go wrong again:
 * which clusters the swap covers, whether the dominants keep their own roles, and whether
 * the plume stays a bounded, reproducible wisp. None of them needs a renderer.
 */
describe('what the Cyberpunk representation replaces', () => {
  test('covers every residential plot and both dominants', () => {
    for (let index = 0; index < model.buildings.length; index++) {
      expect(isReplacedByCyber(`building-${index}`)).toBe(true);
    }
    expect(isReplacedByCyber('dominant-chimney')).toBe(true);
    expect(isReplacedByCyber('dominant-rtvTower')).toBe(true);
  });

  test('leaves the layout alone: the streetscape and the grocery are not replaced', () => {
    // The roads, pavements, kerbs, lamps and trees live in `streetscape`. Replacing it
    // would change the plot layout and the street widths, which both styles share.
    expect(isReplacedByCyber('streetscape')).toBe(false);
    expect(isReplacedByCyber('groceries')).toBe(false);
  });

  test('a plot is never exceeded by more than the declared overhang, and never low down', () => {
    // The previous representation was 1.6 m wider than the block on each axis, which is how
    // it came to swallow -- and then fail to swallow -- the ordinary balconies. Overhangs
    // are wanted, so the contract is a bound rather than a ban: one metre a side, and
    // nothing that exceeds the plot may start below twelve metres, where the pavement,
    // the lamps and the traffic are.
    const limit = 1;
    const floor = 12;
    for (const building of model.buildings) {
      for (const placement of planBuilding(building)) {
        const halfX = Math.abs(placement.sx) / 2;
        const halfZ = Math.abs(placement.sz) / 2;
        const overX = Math.max(
          building.cx - building.w / 2 - (placement.x - halfX),
          placement.x + halfX - (building.cx + building.w / 2)
        );
        const overZ = Math.max(
          building.cz - building.d / 2 - (placement.z - halfZ),
          placement.z + halfZ - (building.cz + building.d / 2)
        );
        const over = Math.max(overX, overZ);
        expect(over).toBeLessThanOrEqual(limit + 1e-6);
        if (over > 0.05) {
          expect(placement.y - Math.abs(placement.sy) / 2).toBeGreaterThanOrEqual(floor - 1e-6);
        }
      }
    }
  });

  test('is deterministic for the same layout', () => {
    const first = planCyberCity(model);
    const second = planCyberCity(buildCityModel());
    expect(second.placements).toEqual(first.placements);
    expect(second.outletY).toBe(first.outletY);
  });
});

describe('the dominants keep their roles', () => {
  const chimney = model.dominants.find((d) => d.kind === 'chimney') as DominantSpec;
  const rtv = model.dominants.find((d) => d.kind === 'rtvTower') as DominantSpec;

  test('the model still declares one of each', () => {
    expect(chimney).toBeTruthy();
    expect(rtv).toBeTruthy();
  });

  test('the transmission tower stays slender, and is not a block of flats', () => {
    const { placements } = planDominant(rtv);
    const height = Math.max(...placements.map((p) => p.y + p.sy / 2));
    const width = Math.max(...placements.map((p) => Math.max(Math.abs(p.sx), Math.abs(p.sz))));
    // Infrastructure, not habitation: at least four times as tall as it is wide.
    expect(height / width).toBeGreaterThan(4);
    // A megablock is made of boxes; a mast has rings. Nothing else in the city builds one.
    expect(placements.some((p) => p.shape === 'ring')).toBe(true);
    expect(placements.some((p) => p.shape === 'cylinder')).toBe(true);
    // Sparse warning lights rather than a string of them.
    expect(placements.filter((p) => p.klass === 'hazard').length).toBeLessThanOrEqual(4);
  });

  test('the plant is a plant and the chimney is still a chimney', () => {
    const { placements, outletY } = planDominant(chimney);
    // Halls: wide boxes, which a mast has none of.
    const halls = placements.filter((p) => p.shape === undefined && p.sx >= 10 && p.sz >= 8);
    expect(halls.length).toBeGreaterThanOrEqual(2);
    // A round stack, and it vents above every hall roof.
    const stacks = placements.filter((p) => p.shape === 'cylinder');
    expect(stacks.length).toBeGreaterThan(4);
    const tallestHall = Math.max(...halls.map((p) => p.y + p.sy / 2));
    expect(outletY).toBeGreaterThan(tallestHall);
    // The chimney is not shorter than the one it replaces.
    expect(outletY).toBeGreaterThanOrEqual(chimney.height);
  });

  test('the whole representation costs three geometries, whatever it contains', () => {
    // Instances of shared shapes, because the hybrid world sits at 562 of a 600 geometry
    // budget and a second city must not spend it.
    const { placements } = planCyberCity(model);
    const shapes = new Set(placements.map((p) => p.shape ?? 'box'));
    expect([...shapes].sort()).toEqual(['box', 'cylinder', 'ring']);
  });
});

describe('the plume stays a bounded, reproducible wisp', () => {
  test('Low draws fewer parcels than High, and both are small', () => {
    expect(SMOKE_PARCELS.low).toBeLessThan(SMOKE_PARCELS.high);
    expect(SMOKE_PARCELS.high).toBeLessThanOrEqual(40);
    expect(SMOKE_LIFE_SECONDS).toBeGreaterThan(0);
  });

  test('the wind direction is a unit vector at every moment', () => {
    for (let second = 0; second < 600; second += 3) {
      const { x, z } = smokeWindDirection(second);
      expect(Math.hypot(x, z)).toBeCloseTo(1, 6);
    }
  });

  test('the wind turns smoothly instead of snapping', () => {
    // The brief asked for changes of direction and strength that flow. A jump here is what
    // a viewer reads as the plume being yanked, so the per-second turn is bounded.
    let worst = 0;
    for (let second = 0; second < 1200; second++) {
      const a = smokeWindDirection(second);
      const b = smokeWindDirection(second + 1);
      worst = Math.max(worst, Math.acos(Math.min(1, a.x * b.x + a.z * b.z)));
    }
    expect(worst).toBeLessThan(0.05); // radians per second: under three degrees
  });

  test('the same second of the same clock gives the same plume', () => {
    for (const second of [0, 12.5, 91, 1234.75]) {
      expect(smokeWindDirection(second)).toEqual(smokeWindDirection(second));
    }
  });
});
