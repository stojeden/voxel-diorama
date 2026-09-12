import * as THREE from 'three';
import { describe, expect, test } from 'vitest';
import { EclipseCrowdProps } from '../effects/EclipseCrowdProps';
import {
  applyPassengerEclipsePose,
  buildPassenger,
  eclipseBodyTurn,
  eclipsePassengerPoseFor,
  SHARED_PASSENGER_GEOMETRY,
  sunGazeFrom,
  type EclipsePassengerPose,
  type PassengerBuild,
  type PassengerSunGaze,
} from './PassengerCrowd';
import { eclipseWorldReactionAt } from '../experience/EclipseWorldReaction';
import { eclipseViewClock } from '../experience/EclipseView';
import { JUNE_DECLINATION_DEG, sunDirectionAt } from '../environment/sky';

describe('eclipse passenger pose', () => {
  test('looks upward and keeps glasses attached to the head transform', () => {
    const scene = new THREE.Scene();
    const passenger = buildPassenger();
    passenger.group.name = 'station-passenger-Test-0';
    passenger.group.position.set(3, 0.5, -2);
    passenger.group.rotation.y = 0.35;
    for (const material of passenger.materials) material.opacity = 1;
    scene.add(passenger.group);

    applyPassengerEclipsePose(passenger, 'glasses', 1);
    const gaze = new THREE.Vector3(0, 0, 1).applyQuaternion(passenger.head.quaternion);
    expect(gaze.y).toBeGreaterThan(0);

    const props = new EclipseCrowdProps(scene);
    props.update(
      { attention: 1, movementScale: 0.2, eyeProtection: 1, projection: 0, dogAlert: 1 },
      -0.2
    );

    const glasses = scene.getObjectByName('eclipse-crowd-glasses') as THREE.InstancedMesh;
    const actual = new THREE.Matrix4();
    glasses.getMatrixAt(0, actual);
    passenger.head.updateWorldMatrix(true, false);
    const expected = new THREE.Matrix4().multiplyMatrices(
      passenger.head.matrixWorld,
      new THREE.Matrix4().makeTranslation(0, 0, 0.33)
    );
    actual.elements.forEach((value, index) => {
      expect(value).toBeCloseTo(expected.elements[index], 5);
    });

    props.dispose();
    passenger.group.traverse((object) => {
      if (object instanceof THREE.Mesh) object.geometry.dispose();
    });
    passenger.materials.forEach((material) => material.dispose());
  });
});

/** The staged eclipse's own sun, read the way the frame loop reads it. */
const STAGED_DECLINATION = THREE.MathUtils.degToRad(JUNE_DECLINATION_DEG);
const STAGED_SUN = sunGazeFrom(
  sunDirectionAt(eclipseViewClock(STAGED_DECLINATION), STAGED_DECLINATION)
);

/** The crowd as the city actually builds it: two stations of six, five bus stops of four. */
const CROWD_SHAPE = [6, 6, 4, 4, 4, 4, 4] as const;

interface Figure {
  build: PassengerBuild;
  pose: EclipsePassengerPose;
  baseFacing: number;
}

function buildFleet(): Figure[] {
  const figures: Figure[] = [];
  for (let stop = 0; stop < CROWD_SHAPE.length; stop++) {
    // A different resting yaw per stop, so a pose that quietly ignores `baseFacing` and one
    // that composes it twice both come out wrong instead of both coming out right.
    const baseFacing = stop * 0.9 - 1.4;
    for (let index = 0; index < CROWD_SHAPE[stop]; index++) {
      const build = buildPassenger(() => 0.3);
      build.group.rotation.y = baseFacing;
      figures.push({ build, pose: eclipsePassengerPoseFor(index), baseFacing });
    }
  }
  return figures;
}

function disposeFleet(figures: Figure[]): void {
  for (const figure of figures) {
    for (const material of figure.build.materials) material.dispose();
  }
}

/** Where the head is actually pointing, in the world, after every parent transform. */
function faceDirection(build: PassengerBuild): THREE.Vector3 {
  build.group.updateWorldMatrix(true, true);
  return new THREE.Vector3(0, 0, 1).applyQuaternion(build.head.getWorldQuaternion(new THREE.Quaternion()));
}

function sunDirection(): THREE.Vector3 {
  return new THREE.Vector3(
    Math.cos(STAGED_SUN.elevation) * Math.sin(STAGED_SUN.yaw),
    Math.sin(STAGED_SUN.elevation),
    Math.cos(STAGED_SUN.elevation) * Math.cos(STAGED_SUN.yaw)
  );
}

const angleBetween = (a: THREE.Vector3, b: THREE.Vector3): number =>
  THREE.MathUtils.radToDeg(a.angleTo(b));

describe('the crowd looks at the sun', () => {
  /**
   * The owner's third sentence, as arithmetic: "ludziki zakladaja okulary w tym czasie i
   * patrza w strone slonca".
   *
   * Measured on the shipped build at coverage 0.959: mean angle between a figure's face and
   * the direction to the sun 82.9 degrees, one figure of thirty-two inside 30 degrees, and
   * every single face at the identical pitch of 33.2 degrees -- the hard-coded -0.58 rad --
   * while the sun sits at 8.8. There was no yaw term anywhere; they tipped their heads back
   * by a constant and kept facing whatever they had been facing.
   *
   * The angle is computed from the pose maths and the staged sun, so it is checkable with
   * no renderer and it moves if the staging moves.
   */
  test('every sun-watcher faces the staged sun once the crowd has frozen', () => {
    const figures = buildFleet();
    const reaction = eclipseWorldReactionAt(0.96, 0);
    const bodyTurn = eclipseBodyTurn(reaction.movementScale);
    const sun = sunDirection();

    const sunward: number[] = [];
    const away: number[] = [];
    for (const figure of figures) {
      const gaze: PassengerSunGaze = { ...STAGED_SUN, baseFacing: figure.baseFacing, bodyTurn };
      applyPassengerEclipsePose(figure.build, figure.pose, reaction.attention, gaze);
      const angle = angleBetween(faceDirection(figure.build), sun);
      if (figure.pose === 'projection') away.push(angle);
      else sunward.push(angle);
    }

    expect(sunward.length, 'ilu patrzy w slonce').toBe(23);
    expect(away.length, 'ilu ma slonce za plecami').toBe(9);

    const mean = sunward.reduce((sum, angle) => sum + angle, 0) / sunward.length;
    expect(mean, 'sredni kat twarzy do slonca').toBeLessThan(15);
    expect(sunward.filter((angle) => angle < 30).length, 'ilu w promieniu 30 stopni')
      .toBe(sunward.length);
    // The pinhole cohort is correct at the other end of the same line, not at 90 degrees to it.
    for (const angle of away) expect(angle).toBeGreaterThan(150);

    disposeFleet(figures);
  });

  test('pitches the head to the sun that is there, not to a constant', () => {
    const figures = buildFleet();
    const reaction = eclipseWorldReactionAt(0.96, 0);
    const gaze: PassengerSunGaze = {
      ...STAGED_SUN,
      baseFacing: STAGED_SUN.yaw,
      bodyTurn: eclipseBodyTurn(reaction.movementScale),
    };
    const watcher = figures.find((figure) => figure.pose !== 'projection');
    if (!watcher) throw new Error('fleet has no sun-watcher');
    watcher.build.group.rotation.y = gaze.baseFacing;

    applyPassengerEclipsePose(watcher.build, watcher.pose, reaction.attention, gaze);
    const pitch = Math.asin(faceDirection(watcher.build).y);
    expect(THREE.MathUtils.radToDeg(pitch), 'kat wzniesienia twarzy').toBeCloseTo(
      THREE.MathUtils.radToDeg(STAGED_SUN.elevation),
      3
    );
    // 33.2 degrees is what the shipped constant gave at every hour of every season.
    expect(THREE.MathUtils.radToDeg(pitch)).toBeLessThan(12);

    disposeFleet(figures);
  });

  /**
   * ISO 11226 puts the sustained head/neck band at 0-25 degrees, so past that the figure
   * leans instead of craning. Nothing leans at the staged eclipse -- the sun is 8.8 degrees
   * up -- but the model has to stay honest if the eclipse is ever staged nearer noon, where
   * June's solar noon is 61.2 degrees and a constant-pitch head would be pure "eclipse neck".
   */
  test('leans rather than cranes when the sun is above the sustained neck limit', () => {
    const build = buildPassenger(() => 0.3);
    const highSun = 1.0;
    const gaze: PassengerSunGaze = { yaw: 0.6, elevation: highSun, baseFacing: 0.6, bodyTurn: 1 };
    build.group.rotation.y = gaze.baseFacing;
    applyPassengerEclipsePose(build, 'glasses', 1, gaze);

    expect(-build.head.rotation.x, 'zadarcie samej szyi').toBeCloseTo(0.4363, 6);
    expect(-build.group.rotation.x, 'odchylenie tulowia').toBeCloseTo(0.4363, 6);
    // Neck plus lean carry 50 degrees of the 57.3 the sun asks for; the eyes cover the rest,
    // and a voxel head has no eyes to show it with.
    expect(Math.asin(faceDirection(build).y), 'szyja plus tulow').toBeCloseTo(0.4363 * 2, 6);
    expect(-build.head.rotation.x, 'szyja nigdy ponad limit ISO 11226').toBeLessThanOrEqual(0.4363);

    for (const material of build.materials) material.dispose();
  });

  /**
   * The body turn is gated on the freeze, so a walking figure never swings round on the spot.
   * `movementScale` bottoms at 0.04, which is why the gate is normalised: the un-normalised
   * `1 - movementScale` tops out at 0.96 and leaves every figure four percent short of the
   * sun for the whole of totality.
   */
  test('turns the body only once the crowd has stopped walking, and then all the way', () => {
    expect(eclipseBodyTurn(1), 'zanim tlum zamarl').toBe(0);
    expect(eclipseBodyTurn(eclipseWorldReactionAt(0.5, 0).movementScale)).toBe(0);
    expect(eclipseBodyTurn(eclipseWorldReactionAt(1, 1).movementScale), 'w totalnosci').toBe(1);

    const build = buildPassenger(() => 0.3);
    const walking: PassengerSunGaze = { yaw: 2.4, elevation: 0.15, baseFacing: -0.7, bodyTurn: 0 };
    build.group.rotation.y = walking.baseFacing;
    applyPassengerEclipsePose(build, 'glasses', 1, walking);
    expect(build.group.rotation.y, 'stopy stoja gdzie staly').toBeCloseTo(-0.7, 9);

    applyPassengerEclipsePose(build, 'glasses', 1, { ...walking, bodyTurn: 1 });
    const face = faceDirection(build);
    expect(Math.atan2(face.x, face.z), 'twarz dokladnie na azymucie slonca').toBeCloseTo(2.4, 6);

    for (const material of build.materials) material.dispose();
  });
});

describe('pinhole projection turns its back on the sun', () => {
  /**
   * A pinhole user holds the card with the sun BEHIND them and looks down at the image it
   * throws on a surface in front (AAS eye-safety/projection). Both cohorts used to be posed
   * identically, and the card was placed 0.51 m behind the figure's back -- the one place
   * the image cannot fall.
   */
  test('faces away from the sun, looks down, and keeps the card in front', () => {
    const scene = new THREE.Scene();
    const holder = buildPassenger(() => 0.3);
    holder.group.name = 'station-passenger-Test-1';
    holder.group.userData.eclipsePose = 'projection';
    holder.group.rotation.y = 0.35;
    for (const material of holder.materials) material.opacity = 1;
    scene.add(holder.group);

    const watcher = buildPassenger(() => 0.6);
    watcher.group.name = 'station-passenger-Test-0';
    watcher.group.userData.eclipsePose = 'glasses';
    watcher.group.position.set(6, 0, 0);
    watcher.group.rotation.y = 0.35;
    for (const material of watcher.materials) material.opacity = 1;
    scene.add(watcher.group);

    const gaze = { ...STAGED_SUN, bodyTurn: 1 };
    applyPassengerEclipsePose(holder, 'projection', 1, { ...gaze, baseFacing: 0.35 });
    applyPassengerEclipsePose(watcher, 'glasses', 1, { ...gaze, baseFacing: 0.35 });

    const sunBearing = new THREE.Vector3(Math.sin(STAGED_SUN.yaw), 0, Math.cos(STAGED_SUN.yaw));
    const flatFace = (build: PassengerBuild) => {
      const face = faceDirection(build);
      return new THREE.Vector3(face.x, 0, face.z).normalize();
    };
    expect(flatFace(holder).dot(sunBearing), 'plecy do slonca').toBeLessThan(-0.99);
    expect(flatFace(watcher).dot(sunBearing), 'twarz do slonca').toBeGreaterThan(0.99);
    expect(holder.head.rotation.x, 'glowa opuszczona na obrazek').toBeGreaterThan(0.3);

    const props = new EclipseCrowdProps(scene);
    props.update(
      { attention: 1, movementScale: 0.04, eyeProtection: 1, projection: 1, dogAlert: 1 },
      -0.2
    );
    const cards = scene.getObjectByName('eclipse-crowd-projection-cards') as THREE.InstancedMesh;
    expect(cards.count, 'jedna kartka na jednego posiadacza').toBe(1);

    const matrix = new THREE.Matrix4();
    cards.getMatrixAt(0, matrix);
    const cardOffset = new THREE.Vector3()
      .setFromMatrixPosition(matrix)
      .sub(holder.group.getWorldPosition(new THREE.Vector3()));
    cardOffset.y = 0;
    // In front of the turned body, which is also away from the sun -- both at once, or the
    // card is somewhere the projected crescent will never reach.
    expect(cardOffset.clone().normalize().dot(flatFace(holder)), 'kartka przed figurka')
      .toBeGreaterThan(0.99);
    expect(cardOffset.clone().normalize().dot(sunBearing)).toBeLessThan(-0.99);

    props.dispose();
    for (const build of [holder, watcher]) {
      for (const material of build.materials) material.dispose();
    }
  });
});

describe('one derivation of who wears what', () => {
  function stampedCrowd(scene: THREE.Scene): THREE.Group[] {
    const groups: THREE.Group[] = [];
    const stops: Array<[string, number]> = [
      ['bus-passenger-A', 4],
      ['bus-passenger-B', 4],
      ['station-passenger-C', 6],
    ];
    for (const [prefix, count] of stops) {
      for (let index = 0; index < count; index++) {
        const build = buildPassenger(() => 0.4);
        build.group.name = `${prefix}-${index}`;
        build.group.userData.eclipsePose = eclipsePassengerPoseFor(index);
        build.group.position.set(groups.length * 4, 0, 0);
        for (const material of build.materials) material.opacity = 1;
        scene.add(build.group);
        groups.push(build.group);
      }
    }
    return groups;
  }

  /**
   * The props used to split the crowd with `index % 3 === 1` over their own name-sorted
   * global list while the pose came from a per-stop index. The two agree at the first stop
   * and nowhere after it: with four figures to a bus stop, stop two's global 4..7 map to
   * per-stop 0..3, so the global rule picked per-stop 0 and 3 -- both glasses wearers.
   */
  test('every card sits on a projection pose and every pair of glasses does not', () => {
    const scene = new THREE.Scene();
    const groups = stampedCrowd(scene);
    const props = new EclipseCrowdProps(scene);
    props.update(
      { attention: 1, movementScale: 0.04, eyeProtection: 1, projection: 1, dogAlert: 1 },
      -0.2
    );

    const poseNearest = (matrix: THREE.Matrix4): EclipsePassengerPose => {
      const position = new THREE.Vector3().setFromMatrixPosition(matrix);
      let best = groups[0];
      let bestDistance = Number.POSITIVE_INFINITY;
      for (const group of groups) {
        const origin = group.getWorldPosition(new THREE.Vector3());
        const distance = Math.hypot(position.x - origin.x, position.z - origin.z);
        if (distance < bestDistance) {
          bestDistance = distance;
          best = group;
        }
      }
      return best.userData.eclipsePose as EclipsePassengerPose;
    };

    const cards = scene.getObjectByName('eclipse-crowd-projection-cards') as THREE.InstancedMesh;
    const glasses = scene.getObjectByName('eclipse-crowd-glasses') as THREE.InstancedMesh;
    // 4 + 4 + 6 figures, poses cycling g,p,w per stop: one projection per bus stop, two at
    // the station.
    expect(cards.count, 'kartki').toBe(4);
    expect(glasses.count, 'okulary').toBe(10);

    const matrix = new THREE.Matrix4();
    for (let index = 0; index < cards.count; index++) {
      cards.getMatrixAt(index, matrix);
      expect(poseNearest(matrix), `kartka ${index}`).toBe('projection');
    }
    for (let index = 0; index < glasses.count; index++) {
      glasses.getMatrixAt(index, matrix);
      expect(poseNearest(matrix), `okulary ${index}`).not.toBe('projection');
    }

    props.dispose();
    for (const group of groups) {
      group.traverse((object) => {
        if (object instanceof THREE.Mesh) {
          const material = Array.isArray(object.material) ? object.material[0] : object.material;
          material.dispose();
        }
      });
    }
  });

  /**
   * Why only six of thirty-two reacting figures were measured wearing glasses.
   *
   * The density budget bounded the loop INDEX, so every candidate skipped for being faded
   * out burned a budgeted slot and the visible figures further down the list got nothing.
   * The candidate order makes that systematic: the name sort puts all twenty bus-stop
   * figures ahead of the twelve station ones, and a bus-stop figure is invisible whenever it
   * is riding the bus. The cap itself is unchanged -- same ceiling, same instance capacity,
   * same single draw call.
   */
  test('spends the density budget on figures that are actually visible', () => {
    const scene = new THREE.Scene();
    const groups = stampedCrowd(scene);
    const glassesGroups = groups.filter((group) => group.userData.eclipsePose !== 'projection');
    // The first eight of ten glasses candidates are away on the bus.
    for (const group of glassesGroups.slice(0, 8)) group.visible = false;

    const props = new EclipseCrowdProps(scene);
    props.setQuality('medium');
    props.update(
      { attention: 1, movementScale: 0.04, eyeProtection: 1, projection: 1, dogAlert: 1 },
      -0.2
    );

    const glasses = scene.getObjectByName('eclipse-crowd-glasses') as THREE.InstancedMesh;
    expect(glasses.count, 'okulary na tych, ktorych widac').toBe(2);
    expect(glasses.count, 'nigdy ponad limit gestosci').toBeLessThanOrEqual(
      Math.ceil(glassesGroups.length * 0.7)
    );

    props.dispose();
    for (const group of groups) {
      group.traverse((object) => {
        if (object instanceof THREE.Mesh) {
          const material = Array.isArray(object.material) ? object.material[0] : object.material;
          material.dispose();
        }
      });
    }
  });
});

describe('shared figure geometry', () => {
  test('every figure draws the same four shapes, and both arms the same one', () => {
    /**
     * A budget guard, not a style preference. There are thirty-four voxel figures in the
     * city and each one used to build five `BoxGeometry` of its own: 170 geometries out of
     * a budget of 600, from four distinct shapes whose dimensions are literal constants.
     *
     * The count this protects is `renderer.info.memory.geometries`, which rises on a
     * geometry's first bind for rendering and falls only on dispose -- so it is a
     * high-water mark for a session, and 170 of it was being spent on repetition.
     */
    const a = buildPassenger(() => 0.1);
    const b = buildPassenger(() => 0.9);

    for (const part of ['legs', 'body', 'head'] as const) {
      expect(a[part].geometry, `${part} nie jest wspoldzielona miedzy figurkami`).toBe(
        b[part].geometry
      );
    }
    expect(a.leftArm.geometry, 'ramiona jednej figurki nie sa tym samym kształtem').toBe(
      a.rightArm.geometry
    );
    expect(a.leftArm.geometry, 'ramie nie jest wspoldzielone miedzy figurkami').toBe(
      b.rightArm.geometry
    );

    // Cztery kształty na piec meshy, i ani jeden wiecej.
    const kształty = new Set([
      a.legs.geometry, a.body.geometry, a.head.geometry, a.leftArm.geometry, a.rightArm.geometry,
      b.legs.geometry, b.body.geometry, b.head.geometry, b.leftArm.geometry, b.rightArm.geometry,
    ]);
    expect(kształty.size, 'liczba roznych kształtow na dwie figurki').toBe(4);
    for (const g of kształty) expect(SHARED_PASSENGER_GEOMETRY.has(g)).toBe(true);

    // Kolory zostaja per figurka -- wspoldzielenie kształtu nie moze ich zrownac.
    expect(a.materials[0]).not.toBe(b.materials[0]);
  });
});
