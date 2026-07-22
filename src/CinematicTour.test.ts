import { describe, expect, it, vi } from 'vitest';
import { CinematicTour, TOUR_CHAPTERS } from './CinematicTour';

describe('CinematicTour', () => {
  it('walks all seven chapters and finishes once', () => {
    const finish = vi.fn();
    const tour = new CinematicTour();
    expect(tour.start(finish).chapter.id).toBe('train');
    for (const chapter of TOUR_CHAPTERS.slice(0, -1)) {
      expect(tour.update(chapter.duration)?.entered).toBe(true);
    }
    expect(tour.update(TOUR_CHAPTERS[TOUR_CHAPTERS.length - 1].duration)).toBeNull();
    expect(finish).toHaveBeenCalledTimes(1);
    expect(tour.update(1)).toBeNull();
  });

  it('crosses multiple chapter boundaries with a large delta', () => {
    const tour = new CinematicTour();
    tour.start();
    const frame = tour.update(15);
    expect(frame?.chapter.id).toBe('residents');
    expect(frame?.entered).toBe(true);
  });

  it('seeks deterministically for tests without waiting', () => {
    const tour = new CinematicTour();
    const frame = tour.seek('totality', 0.5);
    expect(frame.chapter.id).toBe('totality');
    expect(frame.localProgress).toBe(0.5);
  });
});
