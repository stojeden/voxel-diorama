import SunCalc from 'suncalc';
import { declinationForDayOfYear } from './sky';
import type { WeatherKind } from './Weather';
import type { Clock01, Radians, WallClock01 } from '../units';

/**
 * REAL TIME mode — synchronises the diorama with the viewer's world:
 *  - the sun from the viewer's SOLAR time: their real solar noon (SunCalc, from geolocation
 *    or Warsaw) lands on t = 0.5, and today's declination sets the season;
 *  - the hour from their wall clock, for everything that runs on a timetable,
 *  - live weather from the Open-Meteo public API (no key required),
 *  - real moon phase.
 * Falls back to Warsaw when geolocation is denied or unavailable.
 */

export interface RealWeather {
  kind: WeatherKind;
  /** Wind normalised to 0..1 (≈40 km/h → 1). */
  windNorm: number;
  cloudCover: number;
}

const FALLBACK = { lat: 52.2297, lon: 21.0122, label: 'Warszawa (domyślnie)' };
const WEATHER_REFRESH_MS = 10 * 60 * 1000;

function weatherCodeToKind(code: number, cloudCover: number): WeatherKind {
  if (code === 45 || code === 48) return 'fog';
  if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82) || code >= 95) return 'rain';
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return 'snow';
  if (code >= 2 || cloudCover > 65) return 'cloudy';
  return 'clear';
}

/**
 * Solar time at a place, as a fraction of a day with real solar noon at 0.5.
 *
 * Exported for the test, which checks it against SunCalc's own solar noon rather than
 * against a constant that could be wrong in the same way.
 */
export function solarClockAt(now: Date, lat: number, lon: number): Clock01 {
  const noon = SunCalc.getTimes(now, lat, lon).solarNoon.getTime();
  const t = 0.5 + (now.getTime() - noon) / 86_400_000;
  return (t - Math.floor(t)) as Clock01;
}

export class RealTimeSync {
  private lat = FALLBACK.lat;
  private lon = FALLBACK.lon;
  private label = FALLBACK.label;
  private active = false;
  private weather: RealWeather | null = null;
  private fetchTimer: number | null = null;

  isActive(): boolean {
    return this.active;
  }

  getLabel(): string {
    return this.label;
  }

  async enable(): Promise<string> {
    this.active = true;
    try {
      const pos = await new Promise<GeolocationPosition>((resolve, reject) => {
        if (!('geolocation' in navigator)) {
          reject(new Error('geolocation unavailable'));
          return;
        }
        navigator.geolocation.getCurrentPosition(resolve, reject, {
          timeout: 6000,
          maximumAge: 10 * 60 * 1000,
        });
      });
      this.lat = pos.coords.latitude;
      this.lon = pos.coords.longitude;
      this.label = `${this.lat.toFixed(2)}°, ${this.lon.toFixed(2)}°`;
    } catch {
      this.lat = FALLBACK.lat;
      this.lon = FALLBACK.lon;
      this.label = FALLBACK.label;
    }

    await this.refreshWeather().catch(() => {
      this.weather = null;
    });
    if (this.fetchTimer !== null) window.clearInterval(this.fetchTimer);
    this.fetchTimer = window.setInterval(() => {
      void this.refreshWeather().catch(() => {});
    }, WEATHER_REFRESH_MS);

    return this.label;
  }

  disable(): void {
    this.active = false;
    this.weather = null;
    if (this.fetchTimer !== null) {
      window.clearInterval(this.fetchTimer);
      this.fetchTimer = null;
    }
  }

  /**
   * The lighting clock for the viewer's sun: their solar time, with real solar noon at 0.5.
   *
   * This returned their wall-clock hour, relabelled, on the reasoning that with a seasonal sun
   * the hour IS the lighting clock. It is not: civil time is a time zone's, not a longitude's,
   * and summer adds an hour. In Warsaw solar noon falls at 12:29 CEST in September -- 60 min of
   * summer time, less 24 for standing 6 degrees east of the zone's 15 E meridian, less the
   * equation of time -- so the diorama's sun ran half an hour early all day, every day, and
   * set forty minutes before the one outside the window.
   *
   * SunCalc's solar noon carries the longitude, the equation of time and the zone at once.
   * What this model still does not have is refraction and the disc's own size, which put the
   * real sunset some minutes after geometric; `sky.ts` documents that as unmodelled.
   *
   * The season that goes with this clock is {@link getDeclination}; a caller that takes one
   * without the other gets today's sun under some other month's path.
   */
  getCycleT(now: Date = new Date()): Clock01 {
    return solarClockAt(now, this.lat, this.lon);
  }

  /**
   * Today's solar declination, in radians.
   *
   * In real time the date decides the season, not the theme: a viewer who asks for the sky
   * above them in October gets October's sun even under a theme whose own season is June.
   * The theme still supplies its palette, its haze and its grade.
   */
  getDeclination(now: Date = new Date()): Radians {
    const start = new Date(now.getFullYear(), 0, 0);
    const dayOfYear = Math.floor((now.getTime() - start.getTime()) / 86_400_000);
    return declinationForDayOfYear(dayOfYear);
  }

  /**
   * The viewer's local hour, as a fraction of a 24-hour day.
   *
   * Deliberately NOT `getCycleT`, which is the sun: half an hour apart in a Warsaw summer.
   * Anything that means an *hour* -- the bus timetable, shop hours, the windows lighting up
   * in the evening -- reads this, and it is the same hour the HUD prints.
   */
  getDayFraction(now: Date = new Date()): WallClock01 {
    return ((now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds()) /
      86_400) as WallClock01;
  }

  getMoon(now: Date = new Date()): { phase: number; fraction: number } {
    const illumination = SunCalc.getMoonIllumination(now);
    return { phase: illumination.phase, fraction: illumination.fraction };
  }

  getWeather(): RealWeather | null {
    return this.weather;
  }

  private async refreshWeather(): Promise<void> {
    const url =
      `https://api.open-meteo.com/v1/forecast?latitude=${this.lat.toFixed(4)}` +
      `&longitude=${this.lon.toFixed(4)}` +
      `&current=weather_code,cloud_cover,wind_speed_10m`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`open-meteo ${response.status}`);
    const data = (await response.json()) as {
      current?: { weather_code?: number; cloud_cover?: number; wind_speed_10m?: number };
    };
    const current = data.current;
    if (!current) throw new Error('open-meteo: missing current block');
    const cloudCover = (current.cloud_cover ?? 0) / 100;
    this.weather = {
      kind: weatherCodeToKind(current.weather_code ?? 0, (current.cloud_cover ?? 0)),
      windNorm: Math.min(1, (current.wind_speed_10m ?? 0) / 40),
      cloudCover,
    };
  }

  dispose(): void {
    this.disable();
  }
}
