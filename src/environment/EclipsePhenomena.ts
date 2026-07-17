import type { QualityLevel } from '../performance/QualityManager';

export interface EclipsePhenomenaInput {
  active: boolean;
  coverage: number;
  totality: number;
}

export interface EclipsePhenomenaSignals {
  prominences: number;
  prominenceDetail: number;
  groundCrescents: number;
  crescentInstances: number;
  crescentPatternDensity: number;
  shadowBands: number;
}

const QUALITY_BUDGETS: Record<
  QualityLevel,
  Pick<
    EclipsePhenomenaSignals,
    'prominenceDetail' | 'crescentInstances' | 'crescentPatternDensity'
  >
> = {
  low: {
    prominenceDetail: 0.35,
    crescentInstances: 16,
    crescentPatternDensity: 4,
  },
  medium: {
    prominenceDetail: 0.68,
    crescentInstances: 30,
    crescentPatternDensity: 6,
  },
  high: {
    prominenceDetail: 1,
    crescentInstances: 46,
    crescentPatternDensity: 8,
  },
};

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

function smoothstep(edge0: number, edge1: number, value: number): number {
  const t = clamp01((value - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

/**
 * Derives the small-scale eclipse phenomena from physical coverage. The
 * windows deliberately overlap softly so seeking and quality changes cannot
 * produce a visible pop.
 */
export function eclipsePhenomenaAt(
  input: EclipsePhenomenaInput,
  quality: QualityLevel
): EclipsePhenomenaSignals {
  const budget = QUALITY_BUDGETS[quality];
  if (!input.active) {
    return {
      ...budget,
      prominences: 0,
      groundCrescents: 0,
      shadowBands: 0,
    };
  }

  const coverage = clamp01(input.coverage);
  const totality = clamp01(input.totality);
  const nearContact = smoothstep(0.94, 0.996, coverage);
  const photosphereHidden = smoothstep(0.975, 0.999, coverage);

  // Pinhole images are clearest during deep partial phases, then disappear as
  // the remaining photosphere collapses into the diamond ring.
  const groundCrescents =
    smoothstep(0.18, 0.58, coverage) *
    (1 - smoothstep(0.955, 0.997, coverage)) *
    (1 - totality);

  // Atmospheric shadow bands are rare and brief. Keep them tightly around
  // contact and avoid competing with the diamond ring or full totality.
  const contactWindow =
    smoothstep(0.965, 0.991, coverage) *
    (1 - smoothstep(0.9985, 1, coverage)) *
    (1 - totality);

  return {
    ...budget,
    prominences: nearContact * (0.28 + photosphereHidden * 0.72),
    groundCrescents: clamp01(groundCrescents),
    shadowBands: quality === 'high' ? clamp01(contactWindow) : 0,
  };
}
