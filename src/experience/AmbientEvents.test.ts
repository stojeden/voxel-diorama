import { describe, expect, it } from 'vitest';
import {
  AMBIENT_MIN_EXPOSURE_SECONDS,
  AMBIENT_PRIORITY,
  AmbientEventProjection,
  canFrameEvent,
  type AmbientWorldSnapshot,
} from './AmbientEvents';

function quietWorld(): AmbientWorldSnapshot {
  return {
    eclipseActive: false,
    tourChapterLabel: null,
    rainbowVisible: false,
    rainbowZone: 'lake',
    trainStopLabel: null,
    trainStopSecondsLeft: 0,
    busStopLabel: null,
    cameraAutomation: null,
  };
}

/** Every event must be observed absent once before it counts as entered. */
function primed(projection: AmbientEventProjection, time = 0): void {
  projection.select(quietWorld(), time);
}

describe('AmbientEventProjection', () => {
  it('shows nothing while nothing notable is happening', () => {
    const projection = new AmbientEventProjection();
    expect(projection.select(quietWorld(), 0)).toBeNull();
    expect(projection.select(quietWorld(), 10)).toBeNull();
  });

  it('treats state that was already true at boot as an initial condition', () => {
    const projection = new AmbientEventProjection();
    const world = quietWorld();
    world.trainStopLabel = 'Stacja Zachodnia';
    world.trainStopSecondsLeft = 5;

    // The diorama opens with the train already at a platform; that is the world
    // as found, not an event, so the status stays empty.
    expect(projection.select(world, 0)).toBeNull();

    world.trainStopLabel = null;
    expect(projection.select(world, 6)).toBeNull();

    world.trainStopLabel = 'Przystanek Wiadukt';
    world.trainStopSecondsLeft = 4;
    expect(projection.select(world, 20)?.kind).toBe('train-stop');
  });

  it('reports the highest priority active event only', () => {
    const projection = new AmbientEventProjection();
    primed(projection);
    const world = quietWorld();
    world.eclipseActive = true;
    world.tourChapterLabel = 'TOTALNOŚĆ';
    world.rainbowVisible = true;
    world.trainStopLabel = 'Stacja Zachodnia';
    world.busStopLabel = 'Rynek';
    expect(projection.select(world, 1)?.kind).toBe('eclipse');
  });

  it('falls through the documented priority order as events end', () => {
    const world = quietWorld();
    world.eclipseActive = true;
    world.tourChapterLabel = 'POCIĄG';
    world.rainbowVisible = true;
    world.trainStopLabel = 'Stacja Zachodnia';
    world.busStopLabel = 'Rynek';

    const observed: string[] = [];
    const projection = new AmbientEventProjection();
    primed(projection);
    let time = 1;
    for (const kind of AMBIENT_PRIORITY) {
      observed.push(projection.select(world, time)?.kind ?? 'null');
      time += AMBIENT_MIN_EXPOSURE_SECONDS + 1;
      if (kind === 'eclipse') world.eclipseActive = false;
      if (kind === 'tour') world.tourChapterLabel = null;
      if (kind === 'rainbow') world.rainbowVisible = false;
      if (kind === 'train-stop') world.trainStopLabel = null;
      if (kind === 'bus-stop') world.busStopLabel = null;
    }
    expect(observed).toEqual([...AMBIENT_PRIORITY]);
    expect(projection.select(world, time)).toBeNull();
  });

  it('drops the status the moment the event ends, minimum exposure included', () => {
    const projection = new AmbientEventProjection();
    primed(projection);
    const world = quietWorld();
    world.rainbowVisible = true;
    expect(projection.select(world, 10)?.kind).toBe('rainbow');

    world.rainbowVisible = false;
    // Well inside the anti-flicker window: the message must still disappear.
    expect(projection.select(world, 10.1)).toBeNull();
  });

  it('holds one kind through the exposure window when events overlap', () => {
    const projection = new AmbientEventProjection();
    primed(projection);
    const world = quietWorld();
    world.busStopLabel = 'Rynek';
    expect(projection.select(world, 10)?.kind).toBe('bus-stop');

    world.eclipseActive = true;
    expect(projection.select(world, 10.5)?.kind).toBe('bus-stop');
    expect(projection.select(world, 11.9)?.kind).toBe('bus-stop');
    expect(projection.select(world, 12.6)?.kind).toBe('eclipse');
  });

  it('does not restart the exposure window while the same kind stays on screen', () => {
    const projection = new AmbientEventProjection();
    primed(projection);
    const world = quietWorld();
    world.trainStopLabel = 'Stacja Zachodnia';
    world.trainStopSecondsLeft = 5;
    expect(projection.select(world, 10)?.detail).toBe('Stacja Zachodnia · 5 s');

    world.trainStopSecondsLeft = 3.2;
    expect(projection.select(world, 11)?.detail).toBe('Stacja Zachodnia · 4 s');

    world.rainbowVisible = true;
    expect(projection.select(world, 12.6)?.kind).toBe('rainbow');
  });

  it('drops the dwell countdown once the vehicle is about to leave', () => {
    const projection = new AmbientEventProjection();
    primed(projection);
    const world = quietWorld();
    world.trainStopLabel = 'Przystanek Wiadukt';
    world.trainStopSecondsLeft = 0.2;
    expect(projection.select(world, 5)?.detail).toBe('Przystanek Wiadukt');
  });

  it('keeps the eclipse detail empty so the eclipse HUD stays the single source', () => {
    const projection = new AmbientEventProjection();
    primed(projection);
    const world = quietWorld();
    world.eclipseActive = true;
    const event = projection.select(world, 1);
    expect(event?.title).toBe('ZAĆMIENIE SŁOŃCA');
    expect(event?.detail).toBe('');
  });

  it('labels the visible rainbow with its own moisture curtain', () => {
    const projection = new AmbientEventProjection();
    primed(projection);
    const world = quietWorld();
    world.rainbowVisible = true;
    world.rainbowZone = 'north-park';
    expect(projection.select(world, 1)?.detail).toBe('nad parkiem');
  });

  it('never offers an action for a tour chapter or a camera already framing it', () => {
    expect(canFrameEvent('tour', null)).toBe(false);
    expect(canFrameEvent('eclipse', 'tour')).toBe(false);
    expect(canFrameEvent('train-stop', 'tour')).toBe(false);
    expect(canFrameEvent('eclipse', 'eclipse')).toBe(false);
    expect(canFrameEvent('train-stop', 'train')).toBe(false);
    expect(canFrameEvent('bus-stop', 'bus')).toBe(false);

    expect(canFrameEvent('eclipse', null)).toBe(true);
    expect(canFrameEvent('rainbow', null)).toBe(true);
    expect(canFrameEvent('train-stop', 'bus')).toBe(true);
    expect(canFrameEvent('bus-stop', 'overview')).toBe(true);
  });

  it('exposes the action flag through the projected event', () => {
    const projection = new AmbientEventProjection();
    primed(projection);
    const world = quietWorld();
    world.tourChapterLabel = 'JEZIORO';
    world.cameraAutomation = 'tour';
    expect(projection.select(world, 1)?.canFrame).toBe(false);
  });

  it('reuses one result object instead of allocating per update', () => {
    const projection = new AmbientEventProjection();
    primed(projection);
    const world = quietWorld();
    world.rainbowVisible = true;
    const first = projection.select(world, 10);
    const second = projection.select(world, 10.1);
    expect(second).toBe(first);
  });
});
