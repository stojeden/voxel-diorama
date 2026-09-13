import { describe, expect, test } from 'vitest';
import {
  BUS_FINAL_LOOP_MINUTE,
  BUS_SERVICE_START_MINUTE,
  busServiceWindowAt,
  residentialWindowActivityAt,
  residentialWindowAverageAt,
  WINDOW_COHORT_COUNT,
} from './CityRhythm';
import { wallClock01 } from '../units.testing';

const at = (hours: number, minutes = 0) => (hours * 60 + minutes) / (24 * 60);

describe('city rhythm', () => {
  test('runs the last bus from 23:30 and restarts service at 04:50', () => {
    expect(BUS_FINAL_LOOP_MINUTE).toBe(23 * 60 + 30);
    expect(BUS_SERVICE_START_MINUTE).toBe(4 * 60 + 50);
    expect(busServiceWindowAt(wallClock01(at(23, 29)))).toBe('day');
    expect(busServiceWindowAt(wallClock01(at(23, 30)))).toBe('final-loop');
    expect(busServiceWindowAt(wallClock01(at(2, 0)))).toBe('off');
    expect(busServiceWindowAt(wallClock01(at(4, 49)))).toBe('off');
    expect(busServiceWindowAt(wallClock01(at(4, 50)))).toBe('day');
  });

  test('reduces apartment activity through the night', () => {
    expect(residentialWindowAverageAt(wallClock01(at(23, 50)))).toBeGreaterThan(0.9);
    expect(residentialWindowAverageAt(wallClock01(at(0, 5)))).toBeCloseTo(0.8, 1);
    expect(residentialWindowAverageAt(wallClock01(at(1, 42)))).toBeLessThan(0.55);
    expect(residentialWindowAverageAt(wallClock01(at(1, 42)))).toBeGreaterThan(0.35);
    expect(residentialWindowAverageAt(wallClock01(at(2, 30)))).toBeCloseTo(0.2, 1);
    expect(residentialWindowAverageAt(wallClock01(at(2, 45)))).toBe(0);
  });

  test('wakes households sequentially from 04:00', () => {
    expect(residentialWindowAverageAt(wallClock01(at(3, 55)))).toBe(0);
    expect(residentialWindowAverageAt(wallClock01(at(4, 5)))).toBeGreaterThan(0);
    expect(residentialWindowAverageAt(wallClock01(at(4, 25)))).toBeGreaterThan(
      residentialWindowAverageAt(wallClock01(at(4, 5)))
    );
    expect(residentialWindowAverageAt(wallClock01(at(5, 35)))).toBeCloseTo(1, 2);
  });

  test('uses smooth fades instead of binary light changes', () => {
    const samples = Array.from({ length: 7 }, (_, index) =>
      residentialWindowActivityAt(wallClock01(at(1, 39 + index)), 2)
    );
    expect(samples[0]).toBeGreaterThan(samples[samples.length - 1]);
    expect(samples.some((value) => value > 0 && value < 1)).toBe(true);
    expect(WINDOW_COHORT_COUNT).toBe(5);
  });
});
