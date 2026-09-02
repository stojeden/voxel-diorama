import { describe, expect, it } from 'vitest';
import { createWorldRandom } from '../core/Random';
import {
  ECLIPSE_EARLIEST_T01,
  ECLIPSE_GAP_DAYS_MAX,
  ECLIPSE_GAP_DAYS_MIN,
  ECLIPSE_LATEST_T01,
  FIRST_ECLIPSE_DAY_MAX,
  FIRST_ECLIPSE_DAY_MIN,
  EclipseSchedule,
} from './EclipseSchedule';

function sequence(...values: number[]): (index: number) => number {
  return (index) => values[Math.min(index, values.length - 1)] ?? 0;
}

describe('EclipseSchedule', () => {
  it('never schedules the first simulated day', () => {
    const schedule = new EclipseSchedule(sequence(0, 0));
    expect(schedule.getState()).toMatchObject({
      dayIndex: 0,
      scheduledToday: false,
      triggerT01: null,
    });
    expect(schedule.consumeIfDue(0, 1)).toBe(false);
  });

  it('samples a daylight slot when the selected day begins', () => {
    const schedule = new EclipseSchedule(sequence(0, 0.5));
    schedule.beginNextDay();
    const state = schedule.getState();
    expect(state.dayIndex).toBe(1);
    expect(state.scheduledToday).toBe(true);
    expect(state.triggerT01).toBeCloseTo(
      ECLIPSE_EARLIEST_T01 + (ECLIPSE_LATEST_T01 - ECLIPSE_EARLIEST_T01) * 0.5
    );
  });

  it('fires only once when the clock crosses the scheduled slot', () => {
    const schedule = new EclipseSchedule(sequence(0, 0.5, 0));
    schedule.beginNextDay();
    const trigger = schedule.getState().triggerT01!;
    expect(schedule.consumeIfDue(trigger - 0.01, trigger - 0.001)).toBe(false);
    expect(schedule.consumeIfDue(trigger - 0.001, trigger)).toBe(true);
    expect(schedule.consumeIfDue(trigger, trigger + 0.01)).toBe(false);
  });

  it('never allows eclipses on consecutive days', () => {
    const schedule = new EclipseSchedule(sequence(0, 0.5, 0, 0.5));
    schedule.beginNextDay();
    schedule.recordOccurrence();
    schedule.beginNextDay();
    expect(schedule.getState()).toMatchObject({
      dayIndex: 2,
      scheduledToday: false,
    });
    schedule.beginNextDay();
    expect(schedule.getState().scheduledToday).toBe(true);
  });

  it('manual activation cancels the automatic event for the same day', () => {
    const schedule = new EclipseSchedule(sequence(0, 0.4, 0));
    schedule.beginNextDay();
    expect(schedule.getState().scheduledToday).toBe(true);
    schedule.recordOccurrence();
    expect(schedule.getState()).toMatchObject({
      scheduledToday: false,
      triggerT01: null,
      occurredToday: true,
    });
    expect(schedule.consumeIfDue(0, 1)).toBe(false);
  });

  it('skips a blocked slot instead of surprising the user later that day', () => {
    const schedule = new EclipseSchedule(sequence(0, 0.5, 0));
    schedule.beginNextDay();
    const trigger = schedule.getState().triggerT01!;
    expect(schedule.consumeIfDue(trigger - 0.01, trigger, false)).toBe(false);
    expect(schedule.getState()).toMatchObject({
      scheduledToday: false,
      occurredToday: false,
      nextAutomaticDay: 1 + ECLIPSE_GAP_DAYS_MIN,
    });
    expect(schedule.consumeIfDue(trigger, trigger + 0.01)).toBe(false);
  });

  it('is reproducible for the same world seed', () => {
    const firstRandom = createWorldRandom(20260722);
    const secondRandom = createWorldRandom(20260722);
    const first = new EclipseSchedule((index) => firstRandom.sample('eclipse-schedule', index));
    const second = new EclipseSchedule((index) => secondRandom.sample('eclipse-schedule', index));
    const firstDays = [];
    const secondDays = [];
    for (let day = 0; day < 12; day++) {
      first.beginNextDay();
      second.beginNextDay();
      firstDays.push(first.getState());
      secondDays.push(second.getState());
      if (first.getState().scheduledToday) first.recordOccurrence();
      if (second.getState().scheduledToday) second.recordOccurrence();
    }
    expect(secondDays).toEqual(firstDays);
  });

  it('keeps automatic occurrences within the documented day ranges', () => {
    const earliest = new EclipseSchedule(sequence(0, 0, 0));
    const latest = new EclipseSchedule(sequence(0.999999, 0.999999));
    expect(earliest.getState().nextAutomaticDay).toBe(FIRST_ECLIPSE_DAY_MIN);
    expect(latest.getState().nextAutomaticDay).toBe(FIRST_ECLIPSE_DAY_MAX);

    earliest.recordOccurrence();
    latest.recordOccurrence();
    expect(earliest.getState().nextAutomaticDay).toBe(ECLIPSE_GAP_DAYS_MIN);
    expect(latest.getState().nextAutomaticDay).toBe(ECLIPSE_GAP_DAYS_MAX);
  });
});
