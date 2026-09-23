import * as THREE from 'three';
import { describe, expect, test } from 'vitest';
import { JUNE_DECLINATION_DEG, sunDirectionAt } from '../environment/sky';
import type { Radians } from '../units';
import { eclipseViewClock } from './EclipseView';
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
