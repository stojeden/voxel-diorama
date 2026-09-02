import { describe, expect, test } from 'vitest';
import * as THREE from 'three';
import { COLORS } from '../WorldLayout';
import { P, PALETTE, PALETTE_SIZE, resolveEmissive, resolvePalette, resolveParams } from './palette';

describe('hybrid palette', () => {
  test('fits the uniform array and has unique keys', () => {
    expect(PALETTE.length).toBeLessThanOrEqual(PALETTE_SIZE);
    expect(new Set(PALETTE.map((entry) => entry.key)).size).toBe(PALETTE.length);
    for (const key of ['plasterWarm', 'glass', 'pavement', 'kerb', 'marking', 'asphalt', 'aviationRed']) {
      expect(P[key]).toBeGreaterThanOrEqual(0);
    }
  });

  test('theme overrides of the origin colour move derived entries by the same relative shift', () => {
    const base = resolvePalette({});
    const retro = resolvePalette({ [COLORS.concrete]: 0x9a9286 });
    const i = P.plasterWarm;
    const origin = new THREE.Color(COLORS.concrete).getHSL({ h: 0, s: 0, l: 0 });
    const override = new THREE.Color(0x9a9286).getHSL({ h: 0, s: 0, l: 0 });
    const baseC = new THREE.Color(base[i * 3], base[i * 3 + 1], base[i * 3 + 2]).getHSL({ h: 0, s: 0, l: 0 });
    const retroC = new THREE.Color(retro[i * 3], retro[i * 3 + 1], retro[i * 3 + 2]).getHSL({ h: 0, s: 0, l: 0 });
    expect(retroC.l - baseC.l).toBeCloseTo(override.l - origin.l, 2);
    const g = P.glass;
    expect(retro[g * 3]).toBeCloseTo(base[g * 3], 6);
  });

  test('wet and snow flags follow the material semantics of the voxel city', () => {
    const params = resolveParams();
    expect(params[P.asphalt * 4 + 2]).toBe(1);
    expect(params[P.pavement * 4 + 2]).toBe(1);
    expect(params[P.plasterWarm * 4 + 2]).toBe(0);
    expect(params[P.roofFlat * 4 + 3]).toBe(1);
    expect(params[P.glass * 4 + 3]).toBe(0);
    const emissive = resolveEmissive();
    expect(emissive[P.aviationRed]).toBeGreaterThan(1);
    expect(emissive[P.plasterWarm]).toBe(0);
  });
});
