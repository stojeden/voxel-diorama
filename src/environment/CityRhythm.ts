import * as THREE from 'three';
import type { WallClock01 } from '../units';

/**
 * Everything in this file is an HOUR, not a light level.
 *
 * Its constants are wall-clock minutes -- 390 to 430 is 06:30 to 07:10, 1080 is 18:00 -- and
 * the module describes household and timetable behaviour, not daylight. So it takes
 * `WallClock01`, and it used to take `Clock01` only because that is what its two callers
 * happen to hand it. A brand stamped to match the caller rather than the meaning is worse
 * than no brand: it made `residentialWindowActivityAt(clockT, cohort)` -- the CORRECT call --
 * a type error, which points the next reader at the bug instead of away from it.
 */

export const MINUTES_PER_DAY = 24 * 60;
export const WINDOW_COHORT_COUNT = 5;
export const BUS_FINAL_LOOP_MINUTE = 23 * 60 + 30;
export const BUS_SERVICE_START_MINUTE = 4 * 60 + 50;

export type BusServiceWindow = 'off' | 'day' | 'final-loop';

export interface ScheduledWindowMaterial {
  material: THREE.MeshStandardMaterial;
  cohort: number;
  litColor: THREE.Color;
  darkColor: THREE.Color;
  activity: number;
}

const WINDOW_NIGHT_OFF_MINUTES = [0, 20, 102, 140, 160] as const;
const WINDOW_MORNING_ON_MINUTES = [240, 258, 278, 302, 328] as const;
const WINDOW_DAYLIGHT_OFF_MINUTES = [390, 400, 410, 420, 430] as const;
const WINDOW_EVENING_ON_MINUTES = [1080, 1095, 1110, 1125, 1140] as const;
const WINDOW_FADE_MINUTES = 8;

export function minuteOfDay(t01: WallClock01): number {
  return (((t01 % 1) + 1) % 1) * MINUTES_PER_DAY;
}

export function busServiceWindowAt(t01: WallClock01): BusServiceWindow {
  const minute = minuteOfDay(t01);
  const epsilon = 1e-6;
  if (minute + epsilon >= BUS_FINAL_LOOP_MINUTE) return 'final-loop';
  if (minute + epsilon < BUS_SERVICE_START_MINUTE) return 'off';
  return 'day';
}

function smoothstep(edge0: number, edge1: number, value: number): number {
  if (edge0 === edge1) return value < edge0 ? 0 : 1;
  const t = THREE.MathUtils.clamp((value - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

function fadeUp(minute: number, eventMinute: number): number {
  const halfFade = WINDOW_FADE_MINUTES / 2;
  return smoothstep(eventMinute - halfFade, eventMinute + halfFade, minute);
}

function fadeDown(minute: number, eventMinute: number): number {
  return 1 - fadeUp(minute, eventMinute);
}

/**
 * Residential light activity for one deterministic window group. The output
 * deliberately describes household behaviour, not daylight; DayNightCycle
 * multiplies it by the current night strength.
 */
export function residentialWindowActivityAt(t01: WallClock01, cohort: number): number {
  const index = THREE.MathUtils.clamp(Math.floor(cohort), 0, WINDOW_COHORT_COUNT - 1);
  const minute = minuteOfDay(t01);

  if (minute < 3 * 60) {
    if (index === 0) return 0;
    return fadeDown(minute, WINDOW_NIGHT_OFF_MINUTES[index]);
  }

  if (minute < 8 * 60) {
    return (
      fadeUp(minute, WINDOW_MORNING_ON_MINUTES[index]) *
      fadeDown(minute, WINDOW_DAYLIGHT_OFF_MINUTES[index])
    );
  }

  if (minute >= 18 * 60) {
    const evening = fadeUp(minute, WINDOW_EVENING_ON_MINUTES[index]);
    if (index === 0) {
      // This first household group starts retiring shortly before midnight.
      return evening * fadeDown(minute, MINUTES_PER_DAY - WINDOW_FADE_MINUTES / 2);
    }
    return evening;
  }

  return 0;
}

export function residentialWindowAverageAt(t01: WallClock01): number {
  let sum = 0;
  for (let cohort = 0; cohort < WINDOW_COHORT_COUNT; cohort++) {
    sum += residentialWindowActivityAt(t01, cohort);
  }
  return sum / WINDOW_COHORT_COUNT;
}
