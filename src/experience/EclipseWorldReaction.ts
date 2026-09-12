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
  /**
   * How much unfiltered photosphere is still showing — the only thing the glasses answer to.
   *
   * The window was (0.08, 0.72), which took the filters off at totality 0.08 and put them
   * back at 0.80. Read against the timeline that is progress 0.391 and 0.609: the glasses
   * came off 2.5 s BEFORE second contact, at the exact frame the diamond ring peaks, and
   * returned 2.5 s AFTER third contact, leaving thirty-two figures bare-eyed in front of a
   * returning sun. At the bead peaks `eyeProtection` fell to 0.070, under the 0.03 visibility
   * gate's neighbourhood, so the props were effectively gone at the two frames where every
   * eclipse observer's one rule says they are mandatory: the cue to remove the filter is the
   * disappearance of the LAST Baily's bead, and the diamond ring itself is viewed through it
   * (AAS eclipse-basics/eclipse-phenomena; NASA science.nasa.gov/eclipses/safety).
   *
   * (0.86, 0.14) closes the window on the contacts instead. `totality` only reaches 1 at
   * coverage 1.0 — second contact exactly — so the removal completes there and takes about
   * 0.9 s of the 90 s schedule, which is how fast people actually whip glasses off.
   */
  const partialLight = 1 - smootherStep((safeTotality - 0.86) / 0.14);

  return {
    attention,
    movementScale: 1 - freeze * 0.96,
    eyeProtection: attention * partialLight,
    projection: smootherStep((safeCoverage - 0.64) / 0.22) * partialLight,
    dogAlert: smootherStep((safeCoverage - 0.68) / 0.24),
  };
}
