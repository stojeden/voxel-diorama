import { COLORS } from '../world/WorldLayout';
import type { TrainLivery } from '../world/Train';

/**
 * Diorama-wide visual themes. A theme is pure data: palette overrides
 * (keyed by the ORIGINAL palette colour value), foliage colours, lighting
 * and post-processing tweaks. Applied live, like train liveries — and they
 * compose with snow cover and road wetness.
 */

export interface DioramaTheme {
  id: string;
  label: string;
  /** Replacement colours keyed by original COLORS value. */
  palette: Record<number, number>;
  /** Tree crown colours (per-instance foliage). */
  foliage?: { tree: number; treeLight: number };
  /** Auto-applied train livery. */
  livery?: TrainLivery;
  /** Full cyberpunk morph: megatowers rise, actors swap, sci-fi vehicles. */
  cyber?: boolean;
  /** Minimum night factor — neon noir lives in eternal dusk. */
  nightFloor: number;
  exposureMul: number;
  bloomMul: number;
  /** 0..1 sepia grade in the post shader. */
  sepia: number;
  /** Saturation multiplier in the post shader. */
  saturation: number;
  /** Extra sky haze. */
  turbidityAdd: number;
}

const BASE: Omit<DioramaTheme, 'id' | 'label' | 'palette'> = {
  nightFloor: 0,
  exposureMul: 1,
  bloomMul: 1,
  sepia: 0,
  saturation: 1,
  turbidityAdd: 0,
};

export const THEMES: DioramaTheme[] = [
  {
    ...BASE,
    id: 'classic',
    label: 'Klasyczny',
    palette: {},
  },
  {
    ...BASE,
    id: 'retro',
    label: 'Retro PRL',
    palette: {
      [COLORS.concrete]: 0x9a9286,
      [COLORS.concreteDark]: 0x7a7268,
      [COLORS.concreteLight]: 0xaaa294,
      [COLORS.accent]: 0xb09060,
      [COLORS.accentPink]: 0xb89890,
      [COLORS.accentBlue]: 0x8f9e9a,
      [COLORS.grass]: 0x577a3a,
      [COLORS.grassDark]: 0x46622e,
      [COLORS.kiosk]: 0x5e6e5a,
    },
    livery: 'retro',
    sepia: 0.42,
    saturation: 0.88,
    exposureMul: 0.96,
    turbidityAdd: 1.2,
  },
  {
    ...BASE,
    id: 'cyberpunk',
    label: 'Cyberpunk',
    palette: {
      [COLORS.accent]: 0x00e5ff,
      [COLORS.accentPink]: 0xff3fa4,
      [COLORS.accentBlue]: 0x7b5cff,
      [COLORS.road]: 0x1d1d24,
      [COLORS.concrete]: 0x565b66,
      [COLORS.concreteDark]: 0x3a3e46,
      [COLORS.kiosk]: 0x2a6f8a,
      [COLORS.windowLit]: 0xffc46b,
      [COLORS.grass]: 0x2c4a30,
      [COLORS.grassDark]: 0x223a26,
    },
    livery: 'cyber',
    cyber: true,
    nightFloor: 0.62,
    exposureMul: 0.64,
    bloomMul: 1.45,
    saturation: 1.16,
    turbidityAdd: 5,
  },
  {
    ...BASE,
    id: 'autumn',
    label: 'Złota jesień',
    palette: {
      [COLORS.grass]: 0x8a7a33,
      [COLORS.grassDark]: 0x6e6128,
      [COLORS.reeds]: 0x9a8a3a,
    },
    foliage: { tree: 0xc26a1f, treeLight: 0xe09a3a },
    sepia: 0.1,
    saturation: 1.06,
    turbidityAdd: 1.6,
  },
  {
    ...BASE,
    id: 'toy',
    label: 'Zabawkowy',
    palette: {
      [COLORS.grass]: 0x7cc96b,
      [COLORS.grassDark]: 0x66b557,
      [COLORS.road]: 0x4a4f59,
      [COLORS.concrete]: 0xb9c0c7,
      [COLORS.concreteDark]: 0x9aa2ab,
      [COLORS.accent]: 0xf3b73c,
      [COLORS.accentPink]: 0xf78fb3,
      [COLORS.accentBlue]: 0x6fc7e8,
      [COLORS.sidewalk]: 0x9d9d8c,
    },
    foliage: { tree: 0x46a833, treeLight: 0x63c94c },
    saturation: 1.12,
    exposureMul: 1.07,
  },
];

export function themeById(id: string): DioramaTheme {
  return THEMES.find((t) => t.id === id) ?? THEMES[0];
}
