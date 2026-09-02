import * as THREE from 'three';
import { COLORS } from '../WorldLayout';

/**
 * Hybrid palette. Every entry may derive from an original COLORS value so that
 * theme overrides (keyed by COLORS, exactly like `Themes.ts`) propagate to the
 * derived tints by the same relative HSL shift. Snow and wetness are per-entry
 * flags, mirroring the voxel city's `SNOW_TINTS` and `WET_COLOR_KEYS`.
 */
export interface PaletteEntry {
  readonly key: string;
  readonly base: number;
  /** Original COLORS value this entry is derived from (theme overrides propagate). */
  readonly origin?: number;
  readonly roughness: number;
  readonly metalness: number;
  readonly wet: boolean;
  readonly snow: number | null;
  /** Constant emissive strength (aviation lights, lamp heads). */
  readonly emissive?: number;
}

export const PALETTE_SIZE = 32;

const M = (key: string, base: number, o: Partial<PaletteEntry> = {}): PaletteEntry => ({
  key,
  base,
  roughness: 0.9,
  metalness: 0,
  wet: false,
  snow: null,
  ...o,
});

const SNOW_ROOF = 0xe9eef4;

export const PALETTE: readonly PaletteEntry[] = [
  M('plasterWarm', 0xc9a366, { origin: COLORS.concrete, roughness: 0.92 }),
  M('plasterRose', 0xb98577, { origin: COLORS.concrete, roughness: 0.92 }),
  M('plasterOlive', 0x9aa07c, { origin: COLORS.concrete, roughness: 0.92 }),
  M('plasterSand', 0xd1b990, { origin: COLORS.concrete, roughness: 0.92 }),
  M('plasterGrey', 0xa89f93, { origin: COLORS.concrete, roughness: 0.92 }),
  M('prefabLight', 0xb9b1a3, { origin: COLORS.concrete, roughness: 0.94 }),
  M('prefabCool', 0xaeb0ae, { origin: COLORS.concrete, roughness: 0.94 }),
  M('towerGrey', 0xadb0b3, { origin: COLORS.concrete, roughness: 0.94 }),
  M('plinth', 0x6f6d66, { origin: COLORS.concreteDark, roughness: 0.95 }),
  M('trim', 0xc9c3b5, { origin: COLORS.concreteLight, roughness: 0.85, snow: SNOW_ROOF }),
  M('frame', 0xdcd6c8, { roughness: 0.8 }),
  M('roofFlat', 0x44474c, { origin: COLORS.roof, roughness: 0.96, snow: SNOW_ROOF }),
  M('roofTile', 0x8d4b39, { roughness: 0.9, snow: SNOW_ROOF }),
  M('roofSheet', 0x3a444c, { roughness: 0.6, metalness: 0.3, snow: SNOW_ROOF }),
  // Matched to the product's unlit window (WorldGenerator materialParamsFor,
  // COLORS.window: roughness 0.08, metalness 0.65). The lit end of the range is
  // interpolated in the shader, which is where the cohort activity lives.
  M('glass', 0x3a5266, { origin: COLORS.window, roughness: 0.08, metalness: 0.65 }),
  M('glassWarm', 0x4a3f37, { roughness: 0.1, metalness: 0.5 }),
  M('curtain', 0x7a7466, { roughness: 0.9 }),
  M('accentGold', 0xc98a3a, { origin: COLORS.accent, roughness: 0.75 }),
  M('accentRose', 0xb8746a, { origin: COLORS.accentPink, roughness: 0.75 }),
  M('accentBlue', 0x4c7f99, { origin: COLORS.accentBlue, roughness: 0.75 }),
  M('steel', 0x55606a, { origin: COLORS.steel, roughness: 0.42, metalness: 0.65 }),
  M('wood', 0x6b4a30, { origin: COLORS.sleeper, roughness: 0.8 }),
  M('pavement', 0x9c988c, { origin: COLORS.sidewalk, roughness: 1, wet: true, snow: 0xcdd2d7 }),
  M('kerb', 0xb3afa2, { origin: COLORS.sidewalk, roughness: 1, wet: true, snow: 0xd4d8dc }),
  M('marking', 0xd8d1a8, { origin: COLORS.roadMarking, roughness: 1, wet: true }),
  M('asphalt', 0x34363b, { origin: COLORS.road, roughness: 1, wet: true, snow: 0x4a4c52 }),
  M('interior', 0x3b332c, { roughness: 0.95 }),
  M('goodsA', 0xd9a441, { roughness: 0.8 }),
  M('goodsB', 0x5a8f4a, { roughness: 0.8 }),
  M('concrete', 0x8e8d86, { origin: COLORS.concrete, roughness: 0.95, snow: SNOW_ROOF }),
  M('aviationRed', 0xff2a1e, { roughness: 0.5, emissive: 1.6 }),
  M('lamp', 0xfff1cc, { roughness: 0.6, emissive: 0.6 }),
];

/** Palette key → uniform index. */
export const P: Record<string, number> = Object.fromEntries(PALETTE.map((entry, index) => [entry.key, index]));

const hsl = { h: 0, s: 0, l: 0 };
const tmp = new THREE.Color();
const wrap01 = (value: number) => ((value % 1) + 1) % 1;

/**
 * Linear RGB triplets for `uPalette`. `overrides` are keyed by original COLORS
 * values, like `DioramaTheme.palette`; a derived entry follows its origin by the
 * same relative HSL shift, so "Retro PRL" fades the plaster the way it fades concrete.
 */
export function resolvePalette(
  overrides: Record<number, number>,
  out: Float32Array = new Float32Array(PALETTE_SIZE * 3)
): Float32Array {
  for (let i = 0; i < PALETTE.length; i++) {
    const entry = PALETTE[i];
    tmp.setHex(entry.base);
    const override = entry.origin !== undefined ? overrides[entry.origin] : undefined;
    if (override !== undefined && entry.origin !== undefined && override !== entry.origin) {
      const baseHsl = { ...tmp.getHSL(hsl) };
      const originHsl = { ...new THREE.Color(entry.origin).getHSL(hsl) };
      const overHsl = { ...new THREE.Color(override).getHSL(hsl) };
      tmp.setHSL(
        wrap01(overHsl.h + (baseHsl.h - originHsl.h)),
        THREE.MathUtils.clamp(overHsl.s + (baseHsl.s - originHsl.s), 0, 1),
        THREE.MathUtils.clamp(overHsl.l + (baseHsl.l - originHsl.l), 0, 1)
      );
    }
    out[i * 3] = tmp.r;
    out[i * 3 + 1] = tmp.g;
    out[i * 3 + 2] = tmp.b;
  }
  return out;
}

export function resolveSnowTints(out: Float32Array = new Float32Array(PALETTE_SIZE * 3)): Float32Array {
  for (let i = 0; i < PALETTE.length; i++) {
    tmp.setHex(PALETTE[i].snow ?? PALETTE[i].base);
    out[i * 3] = tmp.r;
    out[i * 3 + 1] = tmp.g;
    out[i * 3 + 2] = tmp.b;
  }
  return out;
}

/** vec4 per entry: roughness, metalness, wet-reactive, has-snow-tint. */
export function resolveParams(out: Float32Array = new Float32Array(PALETTE_SIZE * 4)): Float32Array {
  for (let i = 0; i < PALETTE.length; i++) {
    const entry = PALETTE[i];
    out[i * 4] = entry.roughness;
    out[i * 4 + 1] = entry.metalness;
    out[i * 4 + 2] = entry.wet ? 1 : 0;
    out[i * 4 + 3] = entry.snow !== null ? 1 : 0;
  }
  return out;
}

export function resolveEmissive(out: Float32Array = new Float32Array(PALETTE_SIZE)): Float32Array {
  for (let i = 0; i < PALETTE.length; i++) out[i] = PALETTE[i].emissive ?? 0;
  return out;
}
