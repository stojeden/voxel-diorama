import * as THREE from 'three';
import { describe, expect, test } from 'vitest';
import { AUTUMN_DECLINATION_DEG, JUNE_DECLINATION_DEG, sunDirectionAt } from '../environment/sky';
import type { Radians } from '../units';
import { eclipseClockAt, eclipseViewCameraPosition, eclipseViewClock } from './EclipseView';
import { FIXED_TOUR_SHOTS } from './ShotDefinitions';

/**
 * The totality chapter and the two totality checkpoints must have the eclipsed sun in frame.
 *
 * The billboard stands at `sunDirection * 680 + camera.position`, so this projects exactly
 * that point. The old literal shot put it at x = 1.03 in a 16:9 frame -- fifteen pixels of
 * limb at 1920 -- and fully off screen at 16:10 and 4:3.
 */
describe('the totality shot frames the eclipsed sun', () => {
  const june = THREE.MathUtils.degToRad(JUNE_DECLINATION_DEG) as Radians;

  test.each([
    ['16:9', 16 / 9],
    ['16:10', 16 / 10],
    ['4:3', 4 / 3],
  ])('at %s', (_label, aspect) => {
    const shot = FIXED_TOUR_SHOTS.totality;
    const camera = new THREE.PerspectiveCamera(50, aspect, 0.5, 2000);
    camera.position.fromArray(shot.position);
    camera.lookAt(new THREE.Vector3().fromArray(shot.target));
    camera.updateMatrixWorld(true);

    const sun = sunDirectionAt(eclipseViewClock(june), june, new THREE.Vector3());
    const disc = sun.multiplyScalar(680).add(camera.position).project(camera);
    expect(Math.abs(disc.x), 'the eclipsed sun is at or past the side of the frame').toBeLessThan(0.8);
    expect(Math.abs(disc.y), 'the eclipsed sun is at or past the top of the frame').toBeLessThan(0.8);
    expect(disc.z, 'the sun is behind the camera').toBeLessThan(1);
  });
});

describe('the eclipse view keeps the sun in frame while the clock runs', () => {
  // The clock runs an hour through the eclipse, so the sun is not where the camera was aimed
  // at first and last contact. The Zacmienie button's camera must still hold it.
  const seasons = [
    ['June', JUNE_DECLINATION_DEG],
    ['autumn', AUTUMN_DECLINATION_DEG],
  ] as const;
  const aspects = [16 / 9, 16 / 10, 4 / 3];

  test.each(seasons)('%s', (_label, degrees) => {
    const declination = THREE.MathUtils.degToRad(degrees) as Radians;
    for (const aspect of aspects) {
      const camera = new THREE.PerspectiveCamera(50, aspect, 0.5, 2000);
      eclipseViewCameraPosition(declination, camera.position);
      camera.lookAt(0, 36, 0);
      camera.updateMatrixWorld(true);
      for (const progress of [0, 0.5, 1]) {
        const sun = sunDirectionAt(eclipseClockAt(declination, progress), declination, new THREE.Vector3());
        const disc = sun.multiplyScalar(680).add(camera.position).project(camera);
        const where = `aspect ${aspect.toFixed(2)}, progress ${progress}`;
        expect(Math.abs(disc.x), `off the side: ${where}`).toBeLessThan(0.85);
        expect(Math.abs(disc.y), `off the top or bottom: ${where}`).toBeLessThan(0.85);
      }
    }
  });
});

