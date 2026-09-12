import { describe, expect, test } from 'vitest';
import { eclipseWorldReactionAt } from './EclipseWorldReaction';
import { EclipseTimeline } from './EclipseTimeline';
import { PROP_VISIBILITY_GATE } from '../effects/EclipseCrowdProps';

describe('eclipse world reactions', () => {
  test('keeps ordinary city life unchanged outside an eclipse', () => {
    expect(eclipseWorldReactionAt(0, 0)).toEqual({
      attention: 0,
      movementScale: 1,
      eyeProtection: 0,
      projection: 0,
      dogAlert: 0,
    });
  });

  test('slows people and alerts the dog before totality', () => {
    const reaction = eclipseWorldReactionAt(0.9, 0);
    expect(reaction.attention).toBeGreaterThan(0.98);
    expect(reaction.movementScale).toBeLessThan(0.8);
    expect(reaction.eyeProtection).toBeGreaterThan(0.98);
    expect(reaction.projection).toBeGreaterThan(0.9);
    expect(reaction.dogAlert).toBeGreaterThan(0.9);
  });

  test('nearly stops pedestrians and removes filters during totality', () => {
    const reaction = eclipseWorldReactionAt(1, 1);
    expect(reaction.movementScale).toBeCloseTo(0.04, 6);
    expect(reaction.eyeProtection).toBe(0);
    expect(reaction.projection).toBe(0);
    expect(reaction.dogAlert).toBe(1);
  });

  /**
   * The one rule every eclipse observer follows, checked against the schedule that drives it.
   *
   * The filter comes off when the LAST Baily's bead goes and goes back on the instant any
   * photosphere returns; the diamond ring itself is viewed THROUGH it. The shipped window
   * (0.08, 0.72) did the reverse: at both bead peaks -- progress 0.39 and 0.61, the middle
   * of each ring phase and the two most photogenic frames in the ninety seconds --
   * `eyeProtection` was 0.070, barely over the 0.03 gate `EclipseCrowdProps` draws on, so
   * the glasses were gone at the two frames where they are mandatory and the crowd stood
   * bare-eyed through 2.5 s of returning sun on the way out.
   */
  test('keeps filters on through both diamond rings and removes them only inside totality', () => {
    const timeline = new EclipseTimeline();
    const at = (progress: number) => {
      const state = timeline.seek(progress);
      return eclipseWorldReactionAt(state.coverage, state.totality);
    };

    // The two peaks are found by sweeping the schedule, not asserted at a remembered
    // progress: if the ring phases ever move, the test follows them instead of quietly
    // measuring the wrong two frames. Both land on 0.390 and 0.610, the middle of each
    // ring phase, where `beads` reaches 1.
    const beadPeaks: number[] = [];
    for (const [start, end] of [[0.36, 0.42], [0.58, 0.64]]) {
      let peak = start;
      let best = -1;
      for (let step = 0; step <= 600; step++) {
        const progress = start + ((end - start) * step) / 600;
        const beads = timeline.seek(progress).beads;
        if (beads > best) {
          best = beads;
          peak = progress;
        }
      }
      expect(best, 'szczyt paciorkow Baily ego').toBeCloseTo(1, 6);
      beadPeaks.push(peak);
    }
    expect(beadPeaks[0]).toBeCloseTo(0.39, 6);
    expect(beadPeaks[1]).toBeCloseTo(0.61, 6);

    // The claim the (0.86, 0.14) window makes: at a bead peak the filter is not merely over
    // the gate `EclipseCrowdProps` draws on, it is fully opaque. The old (0.08, 0.72) window
    // gave 0.070 here -- over the gate by four hundredths, so the props were drawn at seven
    // percent at the two frames the one eclipse-safety rule calls mandatory.
    for (const peak of beadPeaks) {
      const eyeProtection = at(peak).eyeProtection;
      expect(eyeProtection, `okulary na szczycie paciorkow (${peak.toFixed(3)})`)
        .toBeGreaterThan(PROP_VISIBILITY_GATE);
      expect(eyeProtection, `pelne okulary na pierscieniu (${peak.toFixed(3)})`).toBe(1);
    }

    for (const progress of [0.45, 0.5, 0.55]) {
      expect(at(progress).eyeProtection, `okulary w srodku totalnosci (${progress})`).toBe(0);
      expect(at(progress).projection, `kartka w srodku totalnosci (${progress})`).toBe(0);
    }
  });

  test('sanitizes invalid samples', () => {
    expect(eclipseWorldReactionAt(Number.NaN, Number.POSITIVE_INFINITY)).toEqual({
      attention: 0,
      movementScale: 1,
      eyeProtection: 0,
      projection: 0,
      dogAlert: 0,
    });
  });
});
