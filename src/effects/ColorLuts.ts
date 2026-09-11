import * as THREE from 'three';
import { BlendFunction, LUT3DEffect, LookupTexture } from 'postprocessing';

export type ThemeLutId = 'classic' | 'retro' | 'autumn' | 'toy' | 'cyber';

type RgbTransform = (r: number, g: number, b: number) => [number, number, number];

function clamp(value: number): number {
  return THREE.MathUtils.clamp(value, 0, 1);
}

function saturation(r: number, g: number, b: number, amount: number): [number, number, number] {
  const luma = r * 0.299 + g * 0.587 + b * 0.114;
  return [
    luma + (r - luma) * amount,
    luma + (g - luma) * amount,
    luma + (b - luma) * amount,
  ];
}

function makeLut(transform: RgbTransform, size = 16): LookupTexture {
  const lut = LookupTexture.createNeutral(size);
  const data = lut.image.data as Float32Array;
  for (let i = 0; i < data.length; i += 4) {
    const [r, g, b] = transform(data[i], data[i + 1], data[i + 2]);
    data[i] = clamp(r);
    data[i + 1] = clamp(g);
    data[i + 2] = clamp(b);
  }
  lut.needsUpdate = true;
  return lut;
}

export class ColorLutPipeline {
  readonly themeEffect: LUT3DEffect;

  private readonly themeLuts: Record<ThemeLutId, LookupTexture> = {
    classic: makeLut((r, g, b) => [r, g, b]),
    retro: makeLut((r, g, b) => [r * 1.03 + g * 0.025, g * 0.95 + r * 0.018, b * 0.82]),
    autumn: makeLut((r, g, b) => [r * 1.06 + 0.01, g * 0.97, b * 0.84]),
    toy: makeLut((r, g, b) => saturation(r, g, b, 1.14)),
    cyber: makeLut((r, g, b) => [r * 0.9 + b * 0.04, g * 1.02, b * 1.09 + 0.01]),
  };

  constructor() {
    const options = {
      blendFunction: BlendFunction.NORMAL,
      tetrahedralInterpolation: false,
    };
    this.themeEffect = new LUT3DEffect(this.themeLuts.classic, options);
    this.setTheme('classic');
  }

  setTheme(id: string): void {
    this.setThemeBlend(id, id, 1);
  }

  /**
   * A theme's grade, or a point between two, crossfaded through zero.
   *
   * One `LUT3DEffect` holds one table, so two grades cannot be mixed inside it -- but its
   * blend opacity can, and dipping through zero puts the swap at the moment the table is not
   * contributing anything. Below the halfway point the old grade fades out; above it the new
   * one fades in. `classic` has no table of its own (opacity zero), so a change to or from it
   * is a plain one-way fade with no dip at all, which is the common case.
   *
   * This existed as a cut, and the cut was part of what read as the picture jumping on a
   * theme change: see `resolvePaletteBlend` in `world/hybrid/palette.ts` for the measurement.
   */
  setThemeBlend(fromId: string, toId: string, t: number): void {
    const safe = (id: string): ThemeLutId =>
      id in this.themeLuts ? (id as ThemeLutId) : 'classic';
    const from = safe(fromId);
    const to = safe(toId);
    const mix = Math.min(Math.max(t, 0), 1);
    const strength = (id: ThemeLutId) => (id === 'classic' ? 0 : 0.32);

    if (from === to) {
      this.themeEffect.lut = this.themeLuts[to];
      this.themeEffect.blendMode.opacity.value = strength(to);
      return;
    }
    if (from === 'classic' || to === 'classic') {
      const active = from === 'classic' ? to : from;
      this.themeEffect.lut = this.themeLuts[active];
      const target = from === 'classic' ? mix : 1 - mix;
      this.themeEffect.blendMode.opacity.value = strength(active) * target;
      return;
    }
    if (mix < 0.5) {
      this.themeEffect.lut = this.themeLuts[from];
      this.themeEffect.blendMode.opacity.value = strength(from) * (1 - mix * 2);
    } else {
      this.themeEffect.lut = this.themeLuts[to];
      this.themeEffect.blendMode.opacity.value = strength(to) * (mix * 2 - 1);
    }
  }

  dispose(): void {
    // EffectComposer owns and disposes the effects. This class owns only the
    // generated lookup textures shared by those effects.
    for (const lut of Object.values(this.themeLuts)) lut.dispose();
  }
}
