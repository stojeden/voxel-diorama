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
  readonly goldenEffect: LUT3DEffect;
  readonly nightEffect: LUT3DEffect;
  readonly themeEffect: LUT3DEffect;

  private readonly goldenLut = makeLut((r, g, b) => [r * 1.055 + 0.012, g * 1.005, b * 0.9]);
  private readonly nightLut = makeLut((r, g, b) => {
    const [sr, sg, sb] = saturation(r, g, b, 0.88);
    return [sr * 0.86, sg * 0.94, sb * 1.075 + 0.008];
  });
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
    this.goldenEffect = new LUT3DEffect(this.goldenLut, options);
    this.nightEffect = new LUT3DEffect(this.nightLut, options);
    this.themeEffect = new LUT3DEffect(this.themeLuts.classic, options);
    this.setEnvironment(0, 0);
    this.setTheme('classic');
  }

  setEnvironment(golden: number, night: number): void {
    this.goldenEffect.blendMode.opacity.value = THREE.MathUtils.clamp(golden * 0.46, 0, 0.46);
    this.nightEffect.blendMode.opacity.value = THREE.MathUtils.clamp(night * 0.42, 0, 0.42);
  }

  setTheme(id: string): void {
    const safeId: ThemeLutId = id in this.themeLuts ? (id as ThemeLutId) : 'classic';
    this.themeEffect.lut = this.themeLuts[safeId];
    this.themeEffect.blendMode.opacity.value = safeId === 'classic' ? 0 : 0.32;
  }

  dispose(): void {
    // EffectComposer owns and disposes the effects. This class owns only the
    // generated lookup textures shared by those effects.
    this.goldenLut.dispose();
    this.nightLut.dispose();
    for (const lut of Object.values(this.themeLuts)) lut.dispose();
  }
}
