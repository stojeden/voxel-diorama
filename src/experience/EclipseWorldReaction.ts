export interface EclipseWorldReactionState {
  attention: number;
  movementScale: number;
  eyeProtection: number;
  projection: number;
  dogAlert: number;
}

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

function smootherStep(value: number): number {
  const t = clamp01(value);
  return t * t * t * (t * (t * 6 - 15) + 10);
}

/** Maps physical disc coverage to low-cost, reversible reactions of city life. */
export function eclipseWorldReactionAt(
  coverage: number,
  totality: number
): EclipseWorldReactionState {
  const safeCoverage = clamp01(Number.isFinite(coverage) ? coverage : 0);
  const safeTotality = clamp01(Number.isFinite(totality) ? totality : 0);
  const attention = smootherStep((safeCoverage - 0.55) / 0.32);
  const freeze = smootherStep((safeCoverage - 0.82) / 0.16);
  const partialLight = 1 - smootherStep((safeTotality - 0.08) / 0.72);

  return {
    attention,
    movementScale: 1 - freeze * 0.96,
    eyeProtection: attention * partialLight,
    projection: smootherStep((safeCoverage - 0.64) / 0.22) * partialLight,
    dogAlert: smootherStep((safeCoverage - 0.68) / 0.24),
  };
}
