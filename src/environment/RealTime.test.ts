import SunCalc from 'suncalc';
import { describe, expect, it } from 'vitest';
import { RealTimeSync, solarClockAt } from './RealTime';
import { sunElevationAt } from './sky';

const WARSAW = { lat: 52.2297, lon: 21.0122 };
const DAY_MS = 86_400_000;

/**
 * Real time puts the viewer's sun in the sky, not their time zone's.
 *
 * It handed the wall-clock hour over as the lighting clock, so solar noon sat at 12:00 local
 * and the diorama's sun ran half an hour early: in Warsaw on 2026-09-23 the real solar noon is
 * 12:29 CEST. Checked against SunCalc's own instants, so nothing here depends on the time zone
 * of the machine running it.
 */
describe('real time follows the sun, not the time zone', () => {
  it('puts real solar noon at 0.5', () => {
    for (const day of ['2026-03-20', '2026-06-21', '2026-09-23', '2026-12-21']) {
      const noon = SunCalc.getTimes(new Date(`${day}T12:00:00Z`), WARSAW.lat, WARSAW.lon).solarNoon;
      expect(solarClockAt(noon, WARSAW.lat, WARSAW.lon)).toBeCloseTo(0.5, 9);
    }
  });

  it('reads half an hour before noon at 12:00 in a Warsaw September', () => {
    // 12:00 CEST is 10:00 UTC; solar noon is about 10:29 UTC.
    const t = solarClockAt(new Date('2026-09-23T10:00:00Z'), WARSAW.lat, WARSAW.lon);
    const minutesBeforeNoon = (0.5 - t) * 1440;
    expect(minutesBeforeNoon).toBeGreaterThan(20);
    expect(minutesBeforeNoon).toBeLessThan(40);
  });

  it('sets the diorama sun within minutes of the real one', () => {
    // Through getCycleT, minute by minute, exactly as the product reads it: the first instant
    // after noon at which the diorama's own sun -- product latitude, today's declination --
    // is at the horizon, against SunCalc's sunset. What remains is refraction and the disc's
    // size, which the model does not have (about five minutes), and the declination
    // approximation (a few more). The relabelled wall clock missed by 40 minutes in Warsaw and
    // by hours on a machine whose time zone is not the viewer's.
    const sync = new RealTimeSync();
    for (const day of ['2026-06-21', '2026-09-23', '2026-12-21']) {
      const times = SunCalc.getTimes(new Date(`${day}T11:00:00Z`), WARSAW.lat, WARSAW.lon);
      const declination = sync.getDeclination(times.solarNoon);
      let when = times.solarNoon.getTime();
      while (sunElevationAt(sync.getCycleT(new Date(when)), declination) > 0) when += 60_000;
      const gapMinutes = (times.sunset.getTime() - when) / 60_000;
      expect(Math.abs(gapMinutes), `${day}: ${gapMinutes.toFixed(1)} min apart`).toBeLessThan(12);
    }
  });
});
