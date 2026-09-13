import { describe, expect, test } from 'vitest';
import { createWorldRandom } from '../core/Random';
import {
  STORM_CLOUD_CORE_GAIN,
  STORM_EVENT_SPAN,
  STORM_FILL_AMBIENT,
  STORM_FILL_HEMISPHERE,
  STORM_QUIET_LEAD,
  STORM_RESTRIKE_GAP,
  STORM_SLOT_SECONDS,
  STORM_STROKE_LIFE,
  stormCloudBrightness,
  stormEventFor,
  stormFlashAt,
  stormSeedFrom,
} from './storm';

function seedFor(scope: string) {
  return stormSeedFrom(createWorldRandom(20260722).stream(scope));
}

/** The flash trace as a viewer meets it: sampled on a clock, not on the schedule's own terms. */
function trace(seed: ReturnType<typeof seedFor>, seconds: number, step: number): number[] {
  const samples: number[] = [];
  for (let i = 0; i * step < seconds; i++) samples.push(stormFlashAt(i * step, seed));
  return samples;
}

/** Rising edges from silence: one per flash EVENT, however many times it re-strikes. */
function countFlashes(samples: number[]): number {
  let flashes = 0;
  for (let i = 1; i < samples.length; i++) {
    if (samples[i] > 0 && samples[i - 1] === 0) flashes++;
  }
  return flashes;
}

describe('the storm flashes at a storm rate', () => {
  test('a few a minute, not one a second', () => {
    // The owner asked for a storm, not a strobe. Ten minutes of clock at 10 ms, counted as
    // events rather than as samples above a threshold, so a four-stroke flash counts once.
    for (const scope of ['storm', 'storm-b', 'storm-c']) {
      const perMinute = (countFlashes(trace(seedFor(scope), 600, 0.01)) / 600) * 60;
      expect(perMinute).toBeGreaterThan(3);
      expect(perMinute).toBeLessThan(8);
    }
  });

  test('one flash is a tenth of a second and the whole event under half', () => {
    // A flash that fades over a second reads as a light being turned up, not as lightning.
    expect(STORM_STROKE_LIFE).toBeGreaterThanOrEqual(0.1);
    expect(STORM_STROKE_LIFE).toBeLessThanOrEqual(0.2);
    expect(STORM_EVENT_SPAN).toBeLessThan(0.5);

    const seed = seedFor('storm');
    for (let slot = 0; slot < 40; slot++) {
      const event = stormEventFor(slot, seed);
      const lit = [];
      for (let t = event.start - 0.2; t < event.start + 1.5; t += 0.002) {
        if (stormFlashAt(t, seed) > 0) lit.push(t);
      }
      const span = lit[lit.length - 1] - lit[0];
      expect(span).toBeGreaterThan(STORM_STROKE_LIFE * 0.8);
      expect(span).toBeLessThanOrEqual(STORM_EVENT_SPAN);
    }
  });
});

describe('a flash re-strikes, which is what makes it read as lightning', () => {
  test('every event carries two to four strokes and flickers between them', () => {
    const seed = seedFor('storm');
    const counts = new Set<number>();
    for (let slot = 0; slot < 60; slot++) {
      const event = stormEventFor(slot, seed);
      expect(event.strokes).toBeGreaterThanOrEqual(2);
      expect(event.strokes).toBeLessThanOrEqual(4);
      counts.add(event.strokes);

      // Sample the event finely and count the peaks: a stroke is a peak, and a fade is one
      // peak however long it lasts. The dip between them is the flicker.
      const samples: number[] = [];
      for (let t = event.start; t < event.start + STORM_EVENT_SPAN; t += 0.001) {
        samples.push(stormFlashAt(t, seed));
      }
      let peaks = 0;
      for (let i = 1; i < samples.length - 1; i++) {
        if (samples[i] > samples[i - 1] && samples[i] >= samples[i + 1]) peaks++;
      }
      expect(peaks).toBe(event.strokes);

      // And the flicker is a real one: between two strokes the light drops to a small
      // fraction of the peak rather than merely dimming.
      const peak = Math.max(...samples);
      const between = stormFlashAt(event.start + STORM_RESTRIKE_GAP - 0.004, seed);
      expect(between).toBeLessThan(peak * 0.3);
    }
    // Not every flash the same shape: the count varies over a storm.
    expect(counts.size).toBeGreaterThan(1);
  });
});

describe('the storm is a function of the clock and the seed, and of nothing else', () => {
  test('the same seed and the same clock give the same flashes, twice', () => {
    // The smoke asserts that a seed and a checkpoint reproduce a frame. A flash that landed
    // on its own schedule would put a different luminance under the same name.
    const first = trace(seedFor('storm'), 300, 0.01);
    const second = trace(seedFor('storm'), 300, 0.01);
    expect(second).toEqual(first);
  });

  test('reading the clock out of order gives the same answer as reading it forwards', () => {
    // `pinClock` seeks this clock, including backwards. The schedule has to be seekable.
    const seed = seedFor('storm');
    const forwards = trace(seed, 60, 0.005);
    for (const index of [4821, 17, 9000, 3, 11999]) {
      expect(stormFlashAt(index * 0.005, seed)).toBe(forwards[index]);
    }
  });

  test('two storms are not the same storm', () => {
    const a = trace(seedFor('storm'), 300, 0.01);
    const b = trace(seedFor('storm-b'), 300, 0.01);
    expect(a).not.toEqual(b);
  });
});

describe('the storm is silent where a measurement might be standing', () => {
  test('the checkpoint second, and the head of every slot, are exactly dark', () => {
    // Two checkpoints photograph rain (`noon-rain-overview`, `evening-rain-bus`) at
    // CHECKPOINT_WIND_CLOCK = 0 with the presentation delta frozen. If the schedule could
    // fire there, that frame's luminance would be a coin toss.
    for (const scope of ['storm', 'storm-b', 'storm-c']) {
      const seed = seedFor(scope);
      expect(stormFlashAt(0, seed)).toBe(0);
      for (let slot = 0; slot < 200; slot++) {
        for (let t = 0; t < STORM_QUIET_LEAD; t += 0.01) {
          expect(stormFlashAt(slot * STORM_SLOT_SECONDS + t, seed)).toBe(0);
        }
      }
    }
  });

  test('a clock that has not started yet is dark rather than undefined', () => {
    const seed = seedFor('storm');
    for (const t of [-0.001, -5, -1200]) expect(stormFlashAt(t, seed)).toBe(0);
    expect(Number.isFinite(stormFlashAt(1e6, seed))).toBe(true);
  });
});

describe('a flash brightens and never darkens', () => {
  test('cloud brightness is exactly 1 with no flash and above 1 with one', () => {
    // The standing invariant is that literal rgb(0,0,0) never appears. A multiplier that
    // could dip below 1 would be a way to darken a cloud into it.
    for (const distance of [0, 12, 45, 130, 400]) {
      expect(stormCloudBrightness(0, distance)).toBe(1);
      expect(stormCloudBrightness(1, distance)).toBeGreaterThan(1);
    }
    // The struck cloud lifts most, the rest of the deck lifts a little.
    expect(stormCloudBrightness(1, 0)).toBeCloseTo(1 + 0.15 + STORM_CLOUD_CORE_GAIN, 9);
    expect(stormCloudBrightness(1, 0)).toBeGreaterThan(stormCloudBrightness(1, 60));
    expect(stormCloudBrightness(1, 60)).toBeGreaterThan(stormCloudBrightness(1, 300));
    expect(stormCloudBrightness(1, 1e6)).toBeGreaterThan(1);
  });

  test('the fill it adds to the world is small and never negative', () => {
    expect(STORM_FILL_AMBIENT).toBeGreaterThan(0);
    expect(STORM_FILL_AMBIENT).toBeLessThan(0.25);
    expect(STORM_FILL_HEMISPHERE).toBeLessThan(STORM_FILL_AMBIENT);
  });

  test('the intensity itself stays inside 0..1', () => {
    const seed = seedFor('storm');
    for (const sample of trace(seed, 400, 0.003)) {
      expect(sample).toBeGreaterThanOrEqual(0);
      expect(sample).toBeLessThanOrEqual(1);
    }
  });
});
