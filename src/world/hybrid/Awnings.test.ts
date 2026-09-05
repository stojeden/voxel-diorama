import * as THREE from 'three';
import { describe, expect, test } from 'vitest';
import {
  Awnings,
  CLOCK_JUMP,
  CLOSE_HOUR,
  OPEN_HOUR,
  TRAVEL_SECONDS,
  clockDistance,
  isOpenAt,
} from './Awnings';
import { buildCityModel } from './CityModel';

/**
 * The shop is open from ten to six, and the awning says so.
 *
 * Two things are being held apart here, because conflating them is what broke first:
 *
 *  - the *hour* decides open or closed, and it is a real hour of a 24-hour day. It used to
 *    be `t01`, the lighting phase, which real-time mode warps onto the viewer's real
 *    sunrise and sunset -- so `18/24` was not six in the evening, it was sunset, anywhere
 *    from half past three in December to nine in June;
 *  - the *travel* is a movement, so it is seconds. It used to be 0.012 of a day, which is
 *    two seconds at the default clock and seventeen minutes in real time.
 *
 * And the state is a function of the hour, never of a timer: any jump in the clock snaps
 * the awning to whatever the hour says rather than letting it crawl across the jump.
 */

const HOUR = 1 / 24;
const FRAME = 1 / 60;

const mount = () => {
  const scene = new THREE.Scene();
  const awnings = new Awnings(scene, buildCityModel().buildings, new THREE.MeshStandardMaterial());
  const group = scene.getObjectByName('shop-awnings')!;
  return { awnings, group, shop: group.children[0] as THREE.Group };
};

/** Run real seconds of frames while the world clock creeps from one hour to another. */
const run = (awnings: Awnings, fromHour: number, toHour: number, seconds: number, fps = 60) => {
  const frames = Math.max(1, Math.round(seconds * fps));
  for (let i = 1; i <= frames; i++) {
    const hour = fromHour + ((toHour - fromHour) * i) / frames;
    awnings.update(hour * HOUR, 1 / fps);
  }
};

/**
 * A part's box in the shop's own frame, where the facade is z = 0 and the street is +z.
 *
 * Read from the part's own matrix rather than from world space: the shopfronts these hang
 * on face -z, so a world-space box has its minimum where the assembly reaches *furthest
 * out*, and a test written on world coordinates passes no matter what the geometry does.
 */
const localBox = (part: THREE.Object3D): THREE.Box3 => {
  const mesh = part as THREE.Mesh;
  mesh.updateMatrix();
  mesh.geometry.computeBoundingBox();
  return mesh.geometry.boundingBox!.clone().applyMatrix4(mesh.matrix);
};

/** Where a part's far face sits, in the same frame. */
const farFace = (part: THREE.Object3D, local: THREE.Vector3) => {
  part.updateMatrix();
  return local.clone().applyMatrix4(part.matrix);
};

describe('shop opening hours', () => {
  test('ten to six, by the clock and not by the sun', () => {
    expect(isOpenAt(0)).toBe(false);
    expect(isOpenAt(6 * HOUR)).toBe(false);
    expect(isOpenAt(9.99 * HOUR)).toBe(false);
    expect(isOpenAt(OPEN_HOUR * HOUR)).toBe(true);
    expect(isOpenAt(12 * HOUR)).toBe(true);
    expect(isOpenAt(17.99 * HOUR)).toBe(true);
    expect(isOpenAt(CLOSE_HOUR * HOUR)).toBe(false);
    expect(isOpenAt(20 * HOUR)).toBe(false);
    expect(isOpenAt(23.9 * HOUR)).toBe(false);
    // Whole days either side of the same hour are the same hour.
    expect(isOpenAt(12 * HOUR + 3)).toBe(true);
    expect(isOpenAt(12 * HOUR - 5)).toBe(true);
  });

  test('hours are compared across midnight, not linearly', () => {
    expect(clockDistance(0.01, 0.99)).toBeCloseTo(0.02, 6);
    expect(clockDistance(0.99, 0.01)).toBeCloseTo(0.02, 6);
    expect(clockDistance(0.25, 0.75)).toBeCloseTo(0.5, 6);
  });
});

describe('shop awnings', () => {
  test('a few shops have one, not the whole estate', () => {
    const { awnings } = mount();
    expect(awnings.count).toBeGreaterThan(0);
    // Small enough to read as a signal. The city has thirty-four blocks.
    expect(awnings.count).toBeLessThanOrEqual(8);
    awnings.dispose();
  });

  test('the travel takes seconds of real time, not a slice of the day', () => {
    const { awnings } = mount();
    // Sit closed just before ten, then creep the clock past it -- time passing, not a
    // jump -- and count the real seconds the movement takes.
    let clock = 10 * HOUR - 1e-5;
    awnings.update(clock, 0);
    expect(awnings.progress).toBe(0);

    let elapsed = 0;
    while (awnings.progress < 0.999 && elapsed < 10) {
      clock += 1e-5;
      awnings.update(clock, FRAME);
      elapsed += FRAME;
    }
    expect(elapsed).toBeGreaterThan(TRAVEL_SECONDS * 0.9);
    expect(elapsed).toBeLessThan(TRAVEL_SECONDS * 1.4);
    awnings.dispose();
  });

  test('opening is a short calm move, and every step of it is small', () => {
    const { awnings, shop } = mount();
    awnings.update(9.9 * HOUR, 0);
    const reach = () => (shop.children[1] as THREE.Mesh).scale.z;
    const before = reach();

    let biggest = 0;
    let previous = before;
    let rising = 0;
    // Cross ten o'clock at the default clock: a day in 240 s, so a frame is 6 s of world.
    for (let i = 0; i < 240; i++) {
      awnings.update((9.9 + i * 0.0025) * HOUR, FRAME);
      const now = reach();
      biggest = Math.max(biggest, Math.abs(now - previous));
      if (now > previous + 1e-6) rising += 1;
      previous = now;
    }
    expect(reach()).toBeGreaterThan(before + 1);
    // Tens of frames of movement, none of them a jump: that is what calm means.
    expect(rising).toBeGreaterThan(20);
    expect(biggest).toBeLessThan(0.2);
    awnings.dispose();
  });

  test('a jump in the clock lands on the hour, in either direction', () => {
    const { awnings } = mount();
    // Arrive at noon: open, fully out, no travel owed.
    awnings.update(12 * HOUR, 0);
    expect(awnings.progress).toBe(1);

    // Dragged back to the small hours, and forward again, one frame each.
    awnings.update(3 * HOUR, FRAME);
    expect(awnings.progress, 'skok w tył: markiza od razu zwinięta').toBe(0);
    awnings.update(14 * HOUR, FRAME);
    expect(awnings.progress, 'skok w przód: markiza od razu rozwinięta').toBe(1);
    awnings.update(22 * HOUR, FRAME);
    expect(awnings.progress).toBe(0);

    // A day either way is the same hour, so nothing moves.
    awnings.update(22 * HOUR + 1, FRAME);
    expect(awnings.progress).toBe(0);
    awnings.dispose();
  });

  test('a change of time mode is a jump, and mid-travel state does not survive it', () => {
    const { awnings } = mount();
    awnings.update(9.99 * HOUR, 0);
    // Half a second into the opening move.
    run(awnings, 9.99, 10.01, 0.5);
    expect(awnings.progress).toBeGreaterThan(0);
    expect(awnings.progress).toBeLessThan(1);

    // Real-time mode hands over a different hour entirely. Whatever it says, wins.
    awnings.update(2 * HOUR, FRAME);
    expect(awnings.progress).toBe(0);
    awnings.dispose();
  });

  test('a locked checkpoint has no delta, and shows the hour it was taken at', () => {
    const { awnings } = mount();
    awnings.update(23 * HOUR, 0);
    // A checkpoint zeroes the presentation delta. The awning still has to be right.
    for (let i = 0; i < 30; i++) awnings.update(13 * HOUR, 0);
    expect(awnings.progress, 'checkpoint w środku dnia: markiza rozwinięta').toBe(1);
    for (let i = 0; i < 30; i++) awnings.update(5 * HOUR, 0);
    expect(awnings.progress, 'checkpoint nocą: markiza zwinięta').toBe(0);
    awnings.dispose();
  });

  test('coming back to the tab finishes the move instead of overshooting', () => {
    const { awnings } = mount();
    awnings.update(11 * HOUR, 0);
    awnings.update(3 * HOUR, FRAME);
    expect(awnings.progress).toBe(0);
    // A hidden tab stops the frame loop; the frame that follows carries a huge delta and
    // an hour that barely moved.
    awnings.update(3 * HOUR + CLOCK_JUMP / 2, 12);
    expect(awnings.progress).toBe(0);
    awnings.update(11 * HOUR, 0);
    awnings.update(11 * HOUR + CLOCK_JUMP / 2, 12);
    expect(awnings.progress).toBe(1);
    awnings.dispose();
  });

  test('folded, the whole assembly is put away in its housing', () => {
    const { awnings, shop } = mount();
    awnings.update(3 * HOUR, 0);
    for (const part of shop.children) {
      // The housing is 18 cm deep; nothing may stand out past it when the shop is shut.
      expect(localBox(part).max.z, 'coś wystaje ze zwiniętej markizy').toBeLessThanOrEqual(0.2);
    }
    awnings.dispose();
  });

  test('open, it reaches out, slopes down and stays one piece', () => {
    const { awnings, shop } = mount();
    awnings.update(12 * HOUR, 0);
    const [, fabric, valance, ...arms] = shop.children;

    // Out over the pavement, and the far edge lower than the roller it hangs from.
    const tip = farFace(fabric, new THREE.Vector3(0, 0, 0.5));
    expect(tip.z).toBeGreaterThan(1);
    expect(tip.y).toBeLessThan(-0.2);

    // The skirt hangs off that very edge, and both arms end at it: the covering cannot
    // float off its supports or hang through them.
    expect(farFace(valance, new THREE.Vector3(0, 0.5, 0)).z).toBeCloseTo(tip.z, 6);
    expect(farFace(valance, new THREE.Vector3(0, 0.5, 0)).y).toBeCloseTo(tip.y, 6);
    for (const arm of arms) {
      const end = farFace(arm, new THREE.Vector3(0, 0, 0.5));
      expect(end.z).toBeCloseTo(tip.z, 6);
      expect(end.y).toBeCloseTo(tip.y, 6);
    }
    // And the arms are two members under the sheet, not edging along its rim.
    const xs = arms.map((arm) => arm.position.x).sort((a, b) => a - b);
    expect(xs[1] - xs[0]).toBeGreaterThan(0.8);
    awnings.dispose();
  });

  test('the assembly never reaches back into the wall it hangs on', () => {
    const { awnings, shop } = mount();
    // Every step of the movement, not just its two ends.
    for (let step = 0; step <= 20; step++) {
      awnings.update(10 * HOUR, 0);
      run(awnings, 10, 10.001, (TRAVEL_SECONDS * step) / 20);
      for (const part of shop.children) {
        expect(localBox(part).min.z, `krok ${step}: element wchodzi w elewację`).toBeGreaterThan(-0.02);
      }
    }
    awnings.dispose();
  });
});
