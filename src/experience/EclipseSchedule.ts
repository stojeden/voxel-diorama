export type IndexedRandomSample = (index: number) => number;

export const ECLIPSE_EARLIEST_T01 = 0.3;
export const ECLIPSE_LATEST_T01 = 0.72;
export const FIRST_ECLIPSE_DAY_MIN = 1;
export const FIRST_ECLIPSE_DAY_MAX = 4;
export const ECLIPSE_GAP_DAYS_MIN = 2;
export const ECLIPSE_GAP_DAYS_MAX = 6;

export interface EclipseScheduleState {
  readonly dayIndex: number;
  readonly scheduledToday: boolean;
  readonly triggerT01: number | null;
  readonly occurredToday: boolean;
  readonly nextAutomaticDay: number;
}

/**
 * Deterministic calendar for natural eclipses. Day zero is deliberately quiet;
 * later days use indexed samples from a named world RNG scope, and an occurrence
 * always forces the following day to stay quiet.
 */
export class EclipseSchedule {
  private dayIndex = 0;
  private triggerT01: number | null = null;
  private lastOccurrenceDay = -1;
  private nextAutomaticDay: number;
  private sampleIndex = 0;

  constructor(private readonly sample: IndexedRandomSample) {
    this.nextAutomaticDay = this.randomDayOffset(
      FIRST_ECLIPSE_DAY_MIN,
      FIRST_ECLIPSE_DAY_MAX
    );
  }

  /** Starts the next simulated day and decides its schedule exactly once. */
  beginNextDay(): void {
    this.dayIndex++;
    this.triggerT01 = null;

    if (this.dayIndex < this.nextAutomaticDay) return;
    this.triggerT01 = ECLIPSE_EARLIEST_T01 +
      this.nextSample() * (ECLIPSE_LATEST_T01 - ECLIPSE_EARLIEST_T01);
  }

  /** A user-started eclipse replaces, rather than duplicates, today's schedule. */
  recordOccurrence(): void {
    if (this.lastOccurrenceDay === this.dayIndex) return;
    this.lastOccurrenceDay = this.dayIndex;
    this.triggerT01 = null;
    this.nextAutomaticDay = this.dayIndex + this.randomDayOffset(
      ECLIPSE_GAP_DAYS_MIN,
      ECLIPSE_GAP_DAYS_MAX
    );
  }

  /** Returns true once when the clock reaches today's scheduled daylight slot. */
  consumeIfDue(previousT01: number, currentT01: number, allowed = true): boolean {
    const trigger = this.triggerT01;
    if (
      this.lastOccurrenceDay === this.dayIndex ||
      trigger === null ||
      currentT01 < previousT01 ||
      previousT01 > trigger ||
      currentT01 < trigger
    ) {
      return false;
    }
    if (!allowed) {
      this.triggerT01 = null;
      this.nextAutomaticDay = this.dayIndex + this.randomDayOffset(
        ECLIPSE_GAP_DAYS_MIN,
        ECLIPSE_GAP_DAYS_MAX
      );
      return false;
    }
    this.recordOccurrence();
    return true;
  }

  getState(): EclipseScheduleState {
    return {
      dayIndex: this.dayIndex,
      scheduledToday: this.triggerT01 !== null,
      triggerT01: this.triggerT01,
      occurredToday: this.lastOccurrenceDay === this.dayIndex,
      nextAutomaticDay: this.nextAutomaticDay,
    };
  }

  private randomDayOffset(min: number, max: number): number {
    return min + Math.floor(this.nextSample() * (max - min + 1));
  }

  private nextSample(): number {
    return this.sample(this.sampleIndex++);
  }
}
