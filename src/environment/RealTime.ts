import SunCalc from 'suncalc';
import { realTimeToCycleT } from './sky';
import type { WeatherKind } from './Weather';

/**
 * REAL TIME mode — synchronises the diorama with the viewer's world:
 *  - time of day / sun position from the browser's geolocation + SunCalc
 *    (real sunrise maps to t=0.25, solar noon to 0.5, sunset to 0.75),
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

  /** Simulated-day parameter (0..1) matching the viewer's local sun. */
  getCycleT(now: Date = new Date()): number {
    const times = SunCalc.getTimes(now, this.lat, this.lon);
    return realTimeToCycleT(now, {
      sunrise: times.sunrise,
      solarNoon: times.solarNoon,
      sunset: times.sunset,
    });
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
