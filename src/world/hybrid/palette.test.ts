import { describe, expect, test } from 'vitest';
import * as THREE from 'three';
import { COLORS } from '../WorldLayout';
import {
  P,
  PALETTE,
  PALETTE_SIZE,
  resolveEmissive,
  resolvePalette,
  resolvePaletteBlend,
  resolveParams,
} from './palette';

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

describe('theme transitions', () => {
  test('a palette can be resolved part way between two themes', () => {
    /**
     * A theme change used to repaint the whole city in one frame. `applyTheme` wrote the new
     * palette straight into the uniform, so the only animated part of a Cyberpunk morph was
     * the towers rising and the actors swapping at the midpoint -- the colours were a cut.
     *
     * Measured on the owner's shot with the camera pinned: the city's own motion moves the
     * frame by 0.93 of a luminance level between frames, and the frame the theme lands on
     * moved it by 40.5. Forty-three times the background, at a morph factor of 0.015, when
     * the towers had risen by one and a half percent.
     *
     * Blending happens in the linear RGB the uniform already holds, which is the right space
     * for it: the array is fed to the shader untouched.
     */
    const from = {};
    const to = { [COLORS.concrete]: 0x2a3340, [COLORS.window]: 0x00e5ff };
    const start = resolvePalette(from);
    const end = resolvePalette(to);

    const at0 = resolvePaletteBlend(from, to, 0);
    const at1 = resolvePaletteBlend(from, to, 1);
    for (let i = 0; i < start.length; i++) {
      expect(at0[i], `skladowa ${i} przy t=0`).toBeCloseTo(start[i], 6);
      expect(at1[i], `skladowa ${i} przy t=1`).toBeCloseTo(end[i], 6);
    }

    // A theme that actually moves something, so the midpoint is a real test and not 0 == 0.
    const i = P.prefabLight * 3;
    expect(Math.abs(end[i] - start[i]), 'wybrany wpis nie zmienia sie miedzy motywami').toBeGreaterThan(0.01);

    const at05 = resolvePaletteBlend(from, to, 0.5);
    for (let k = 0; k < 3; k++) {
      expect(at05[i + k], `polowa drogi, skladowa ${k}`).toBeCloseTo((start[i + k] + end[i + k]) / 2, 6);
    }

    // Clamped, because the ramp that drives this can overshoot by a frame's worth.
    expect(Array.from(resolvePaletteBlend(from, to, -0.4))).toEqual(Array.from(at0));
    expect(Array.from(resolvePaletteBlend(from, to, 1.4))).toEqual(Array.from(at1));

    // Writes into a caller-owned array, like `resolvePalette`, so the frame loop allocates nothing.
    const out = new Float32Array(PALETTE_SIZE * 3);
    expect(resolvePaletteBlend(from, to, 0.25, out)).toBe(out);
  });
});
