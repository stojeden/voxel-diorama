import * as THREE from 'three';
import { describe, expect, test } from 'vitest';
import { EclipseCrowdProps, PROP_VISIBILITY_GATE } from '../effects/EclipseCrowdProps';
import {
  applyPassengerEclipsePose,
  buildPassenger,
  eclipseBodyTurn,
  eclipsePassengerPoseFor,
  eclipseTurnOrigin,
  PassengerCrowd,
  SHARED_PASSENGER_GEOMETRY,
  sunGazeFrom,
  type EclipsePassengerPose,
  type EclipsePoseDrive,
  type PassengerBuild,
  type PassengerSunGaze,
} from './PassengerCrowd';
import { eclipseWorldReactionAt } from '../experience/EclipseWorldReaction';
import { EclipseTimeline } from '../experience/EclipseTimeline';
import { eclipseClockAt, eclipseViewClock } from '../experience/EclipseView';
import { JUNE_DECLINATION_DEG, sunDirectionAt } from '../environment/sky';
import { STATION_STOPS } from './WorldLayout';
import type { Radians } from '../units';
import { radians } from '../units.testing';

describe('eclipse passenger pose', () => {
  test('looks upward and keeps glasses attached to the head transform', () => {
    const scene = new THREE.Scene();
    const passenger = buildPassenger();
    passenger.group.name = 'station-passenger-Test-0';
    passenger.group.position.set(3, 0.5, -2);
    passenger.group.rotation.y = 0.35;
    for (const material of passenger.materials) material.opacity = 1;
    scene.add(passenger.group);

    applyPassengerEclipsePose(passenger, 'glasses', {
      attention: 1,
      eyeProtection: 1,
      projection: 0,
    });
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
const STAGED_DECLINATION = THREE.MathUtils.degToRad(JUNE_DECLINATION_DEG) as Radians;
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

/** Deep partial: everyone attending, both props out. What the drive looks like at coverage 0.96. */
const FULL_PARTIAL: EclipsePoseDrive = { attention: 1, eyeProtection: 1, projection: 1 };

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
      applyPassengerEclipsePose(figure.build, figure.pose, reaction, gaze);
      const angle = angleBetween(faceDirection(figure.build), sun);
      if (figure.pose === 'projection') away.push(angle);
      else sunward.push(angle);
    }

    expect(sunward.length, 'ilu patrzy w slonce').toBe(23);
    expect(away.length, 'ilu ma slonce za plecami').toBe(9);

    /**
     * Both cohorts as measured numbers, not as a bound with no regression in it.
     *
     * At coverage 0.96 `bodyTurn` is 0.9839 -- the freeze is not quite complete -- so the
     * feet are 1.6 % short of the sun's bearing and the twenty-three sun-watchers average
     * 0.7626 degrees off it, spread 0.0000 to 1.9566, all twenty-three inside 30. The nine
     * card-holders average 164.6662 degrees off it, none inside 30: half a turn of azimuth
     * away, less the 24.06-degree downward pitch of a head reading a card in its hands.
     * Against 82.9 degrees mean and 1 of 32 inside 30 on the build this replaces.
     */
    const mean = (angles: number[]) => angles.reduce((sum, a) => sum + a, 0) / angles.length;
    expect(mean(sunward), 'sredni kat twarzy do slonca').toBeCloseTo(0.7626, 4);
    expect(Math.max(...sunward), 'najgorszy z patrzacych').toBeCloseTo(1.9566, 4);
    expect(sunward.filter((angle) => angle < 30).length, 'ilu w promieniu 30 stopni')
      .toBe(sunward.length);
    expect(mean(away), 'sredni kat kartkowiczow do slonca').toBeCloseTo(164.6662, 4);
    expect(away.filter((angle) => angle < 30).length, 'kartkowicze w promieniu 30 stopni').toBe(0);

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

    applyPassengerEclipsePose(watcher.build, watcher.pose, reaction, gaze);
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
    applyPassengerEclipsePose(build, 'glasses', FULL_PARTIAL, gaze);

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
    // A figure mid-path: the walk loop wrote TRAVEL from its own step this frame, and PLATFORM
    // is the stop facing it will not hold again until it arrives.
    const TRAVEL = 1.9;
    const PLATFORM = -0.7;
    const SUN_YAW = 3.9;
    const walking: PassengerSunGaze = {
      yaw: SUN_YAW,
      elevation: 0.15,
      baseFacing: PLATFORM,
      bodyTurn: 0,
    };
    build.group.rotation.y = TRAVEL;
    applyPassengerEclipsePose(build, 'glasses', FULL_PARTIAL, walking);
    expect(build.group.rotation.y, 'stopy ida tam, gdzie szly').toBeCloseTo(TRAVEL, 9);

    // The frame the turn starts, the origin is the heading the figure actually had.
    const origin = eclipseTurnOrigin(null, 0.5, build.group.rotation.y);
    expect(origin, 'obrot zaczyna sie tam, gdzie figurka stala').toBe(TRAVEL);
    expect(eclipseTurnOrigin(origin, 0.9, 99), 'raz zapamietany, trzymany').toBe(TRAVEL);
    expect(eclipseTurnOrigin(origin, 0, TRAVEL), 'po odmrozeniu stopy wracaja do petli chodu')
      .toBeNull();

    applyPassengerEclipsePose(build, 'glasses', FULL_PARTIAL, {
      ...walking,
      baseFacing: origin ?? TRAVEL,
      bodyTurn: 0.5,
    });
    // 2.0 rad of bearing to make up, of which the neck comfortably takes 0.785 and the feet
    // carry 1.215 -- half of it at bodyTurn 0.5, measured from TRAVEL and not from PLATFORM.
    expect(build.group.rotation.y, 'polowa obrotu stop, liczona od kursu marszu')
      .toBeCloseTo(TRAVEL + (2.0 - 0.785) * 0.5, 9);

    applyPassengerEclipsePose(build, 'glasses', FULL_PARTIAL, {
      ...walking,
      baseFacing: origin ?? TRAVEL,
      bodyTurn: 1,
    });
    const face = faceDirection(build);
    expect(Math.atan2(face.x, face.z), 'twarz dokladnie na azymucie slonca').toBeCloseTo(
      SUN_YAW - 2 * Math.PI,
      6
    );

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
    applyPassengerEclipsePose(holder, 'projection', FULL_PARTIAL, { ...gaze, baseFacing: 0.35 });
    applyPassengerEclipsePose(watcher, 'glasses', FULL_PARTIAL, { ...gaze, baseFacing: 0.35 });

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

  /**
   * The nine figures who spent the whole of totality with their backs turned, holding nothing.
   *
   * The pinhole posture -- body yaw sunYaw + pi, head pitched +0.42 rad DOWN at the card --
   * was driven by `attention`, which is 1 from coverage 0.87 to the end of the eclipse. The
   * card that explains it is drawn with `projection`, which carries `partialLight` and is
   * exactly 0 through totality. So for the 14.6 s of totality nine of thirty-two figures --
   * the projection cohort, 4 of 12 at the stations and 5 of 20 at the bus stops -- stood
   * facing away from the one thing in the frame, reading a card that had been faded out.
   *
   * A real pinhole user has nothing to read at that point: the image is made by the
   * photosphere, and the photosphere is what has just gone. It is also the one moment in the
   * ninety seconds when looking straight at the sun is safe (AAS eclipse-basics/eclipse-
   * phenomena: the corona is about as bright as a full moon). So they turn round and look up
   * with everybody else, and they do it because the pose now reads the card's own strength.
   */
  test('comes round to the sun for totality, when the card has nothing left to show', () => {
    const figures = buildFleet();
    const partial = eclipseWorldReactionAt(0.96, 0);
    const totality = eclipseWorldReactionAt(1, 1);
    expect(totality.projection, 'kartka w totalnosci').toBe(0);
    expect(totality.attention, 'uwaga w totalnosci').toBe(1);

    const sun = sunDirection();
    const angles: number[] = [];
    for (const figure of figures) {
      if (figure.pose !== 'projection') continue;
      const gaze: PassengerSunGaze = {
        ...STAGED_SUN,
        baseFacing: figure.baseFacing,
        bodyTurn: eclipseBodyTurn(partial.movementScale),
      };
      // Posed through the deep partial first, so this measures a figure that really did have
      // its back to the sun a moment ago rather than one that never turned away.
      applyPassengerEclipsePose(figure.build, figure.pose, partial, gaze);
      expect(angleBetween(faceDirection(figure.build), sun)).toBeGreaterThan(150);

      // The arms as the update loop hands them over: both crowds write their idle sway every
      // frame before the pose runs, so a pose that no longer raises an arm leaves it resting.
      figure.build.leftArm.rotation.x = 0;
      figure.build.rightArm.rotation.x = 0;
      applyPassengerEclipsePose(figure.build, figure.pose, totality, {
        ...gaze,
        bodyTurn: eclipseBodyTurn(totality.movementScale),
      });
      angles.push(angleBetween(faceDirection(figure.build), sun));
      expect(figure.build.head.rotation.x, 'glowa juz nie wisi nad kartka').toBeLessThanOrEqual(0);
      expect(figure.build.leftArm.rotation.x, 'rece opadaja razem z kartka').toBeCloseTo(0, 6);
    }

    // Measured: all nine inside 30 degrees, mean 0.0000 -- `bodyTurn` is exactly 1 in
    // totality, so the feet finish the turn they were 1.6 % short of a moment earlier.
    expect(angles.length, 'ilu ma kartki').toBe(9);
    expect(angles.filter((angle) => angle < 30).length, 'kartkowicze w promieniu 30 stopni')
      .toBe(9);
    const mean = angles.reduce((sum, angle) => sum + angle, 0) / angles.length;
    expect(mean, 'sredni kat kartkowiczow do slonca w totalnosci').toBeCloseTo(0, 6);

    disposeFleet(figures);
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

describe('the turn is continuous across the whole schedule', () => {
  /**
   * Endpoint tests cannot see a snap.
   *
   * The pinhole cohort's bearing was written `wrapPi(yaw + PI * hold - baseFacing)`, so the
   * argument itself swept half a turn as the card left and crossed +/-PI on the way. `wrapPi`
   * threw it 2PI the other way, `headYaw` flipped sign with it, and the torso moved 86.56
   * degrees in one 16 ms frame -- on the frame of the diamond ring, which is the frame this
   * whole rework exists to make beautiful. Four of the seven stop facings in the fleet hit it.
   *
   * Every test that existed sampled two static states and asserted the angle between the face
   * and the sun, which body and head cancel out of exactly. So this one runs the real timeline
   * at 60 fps from first contact to fourth and watches the shoulders instead.
   */
  const FRAME_SECONDS = 1 / 60;
  /** Radians of body yaw in one frame. A brisk human turn is ~2.6 rad/s, so 0.26 is generous. */
  const MAX_FRAME_YAW = 0.26;

  test.each(['projection', 'glasses', 'watch'] as const)(
    'a %s figure never jumps within a frame',
    (pose) => {
      const timeline = new EclipseTimeline();
      timeline.seek(0, true);
      const worst = { yaw: 0, head: 0, progress: 0, baseFacing: 0 };

      // The seven stop facings the city actually builds, so the sweep covers the real fleet.
      for (const baseFacing of [0.4, 1.3, 2.2, 3.1, -0.5, -1.4, -2.3]) {
        const build = buildPassenger(() => 0.5);
        build.group.rotation.y = baseFacing;
        let previousYaw: number | null = null;
        let previousHead: number | null = null;
        timeline.seek(0, true);

        for (let frame = 0; frame * FRAME_SECONDS <= timeline.durationSeconds; frame++) {
          const state = timeline.update(frame === 0 ? 0 : FRAME_SECONDS);
          const reaction = eclipseWorldReactionAt(state.coverage, state.totality);
          const drive: EclipsePoseDrive = {
            attention: reaction.attention,
            eyeProtection: reaction.eyeProtection,
            projection: reaction.projection,
          };
          const gaze: PassengerSunGaze = {
            ...STAGED_SUN,
            baseFacing,
            bodyTurn: eclipseBodyTurn(reaction.movementScale),
          };
          applyPassengerEclipsePose(build, pose, drive, gaze);

          if (previousYaw !== null && previousHead !== null) {
            const dYaw = Math.abs(build.group.rotation.y - previousYaw);
            const dHead = Math.abs(build.head.rotation.y - previousHead);
            if (dYaw > worst.yaw) {
              worst.yaw = dYaw;
              worst.head = dHead;
              worst.progress = state.progress;
              worst.baseFacing = baseFacing;
            }
          }
          previousYaw = build.group.rotation.y;
          previousHead = build.head.rotation.y;
        }
      }

      expect(
        worst.yaw,
        `najwiekszy skok tulowia ${((worst.yaw * 180) / Math.PI).toFixed(2)} st. przy postepie ` +
          `${worst.progress.toFixed(5)}, ustawienie ${worst.baseFacing}`
      ).toBeLessThan(MAX_FRAME_YAW);
      expect(worst.head, 'glowa nie kompensuje skoku tulowia').toBeLessThan(MAX_FRAME_YAW);
    }
  );
});

describe('the turn stays continuous now that the sun moves during the eclipse', () => {
  /**
   * The clock used to stand still for the eclipse, and the pose code leans on that: `toSun` is
   * wrapped on its own because it "does not sweep". The clock now runs an hour through the
   * eclipse and the sun moves with it, about eleven degrees of azimuth, so the bearing does
   * sweep. This runs the real timeline against the moving sun, at every five degrees of stop
   * facing, so a facing whose bearing crosses the wrap during a hold transition cannot hide.
   */
  const FRAME_SECONDS = 1 / 60;
  const MAX_FRAME_YAW = 0.26;

  test.each(['projection', 'glasses', 'watch'] as const)('a %s figure never jumps within a frame', (pose) => {
    const timeline = new EclipseTimeline();
    const sun = new THREE.Vector3();
    let worst = 0;
    let where = '';
    for (let degrees = -180; degrees < 180; degrees += 5) {
      const baseFacing = THREE.MathUtils.degToRad(degrees);
      const build = buildPassenger(() => 0.5);
      build.group.rotation.y = baseFacing;
      let previousYaw: number | null = null;
      // Captured the way the crowd and the bus capture it: on the frame the body turn begins.
      let sunOrigin: number | null = null;
      timeline.seek(0, true);
      for (let frame = 0; frame * FRAME_SECONDS <= timeline.durationSeconds; frame++) {
        const state = timeline.update(frame === 0 ? 0 : FRAME_SECONDS);
        const reaction = eclipseWorldReactionAt(state.coverage, state.totality);
        sunDirectionAt(eclipseClockAt(STAGED_DECLINATION, state.progress), STAGED_DECLINATION, sun);
        const sunGaze = sunGazeFrom(sun);
        const bodyTurn = eclipseBodyTurn(reaction.movementScale);
        sunOrigin = eclipseTurnOrigin(sunOrigin, bodyTurn, sunGaze.yaw);
        const gaze: PassengerSunGaze = {
          ...sunGaze,
          baseFacing,
          bodyTurn,
          sunYawOrigin: sunOrigin,
        };
        applyPassengerEclipsePose(
          build,
          pose,
          { attention: reaction.attention, eyeProtection: reaction.eyeProtection, projection: reaction.projection },
          gaze
        );
        if (previousYaw !== null) {
          const raw = Math.abs(build.group.rotation.y - previousYaw) % (2 * Math.PI);
          const step = Math.min(raw, 2 * Math.PI - raw);
          if (step > worst) {
            worst = step;
            where = `ustawienie ${degrees} st., postep ${state.progress.toFixed(4)}`;
          }
        }
        previousYaw = build.group.rotation.y;
      }
    }
    expect(worst, `skok tulowia ${((worst * 180) / Math.PI).toFixed(2)} st. (${where})`).toBeLessThan(MAX_FRAME_YAW);
  });
});

/**
 * The dwell cycle, which had no test at all until the platforms emptied in front of the owner.
 *
 * Two things make a naive test here worthless, and both were caught by review after I wrote one:
 *
 * `THREE.Object3D.visible` defaults to TRUE, so counting visible figures cannot tell a crowd
 * that faded in from a crowd that was never updated at all -- three earlier versions of these
 * tests passed with the update loop replaced by a no-op. Presence is therefore counted as the
 * draw flag AND the opacity behind it.
 *
 * The product never steps this class at a frame rate. `main.ts` drives it off an accumulator at
 * `optionalActorHz` -- 20, 20 and 24 in the three profiles -- and hands it the accumulated time,
 * so the smallest step it can ever see is 1/20 s, four times the length of a 60 Hz frame. The
 * fade crosses its 0.01 gate between 1/30 and 1/24, so a test written at 1/60 asks a question
 * the product never asks: at 1/60 a disembarker dies on its first frame, and at 1/20 it does not.
 */
describe('a station that a train has visited still has people on it', () => {
  /** The slowest cadence the product can deliver, and the one that flatters the bug least. */
  const STEP = 1 / 20;
  const PER_STATION = 6;

  const runFrames = (crowd: PassengerCrowd, seconds: number, dwelling: Set<string>): void => {
    for (let i = 0; i < Math.round(seconds / STEP); i++) crowd.update(STEP, dwelling);
  };

  const at = (crowd: PassengerCrowd, label: string) =>
    crowd.getPassengerDebugState().filter((p) => p.station === label);

  /** Drawn, and worth drawing: the flag alone is true on a figure nobody has ever touched. */
  const present = (crowd: PassengerCrowd, label: string): number =>
    at(crowd, label).filter((p) => p.visible && p.opacity > 0.5).length;

  test('the platform refills after the train has come and gone', () => {
    const scene = new THREE.Scene();
    const crowd = new PassengerCrowd(scene);
    const label = STATION_STOPS[0].label;

    runFrames(crowd, 3, new Set());
    expect(present(crowd, label), 'the platform never filled in the first place').toBe(PER_STATION);

    // The station's own dwell, not a made-up one. The boarding fade is the last quarter of the
    // walk, not an extra stretch after it, so the slowest boarder is gone about 3.9 s in: a
    // 3.4 s walk whose last 0.85 s is the ramp, plus the half-second tail of the 6/s lerp.
    let boarded = false;
    let boardingSeen = false;
    const dwell = new Set([label]);
    for (let i = 0; i < Math.round(STATION_STOPS[0].dwellSeconds / STEP); i++) {
      crowd.update(STEP, dwell);
      const state = at(crowd, label);
      if (state.some((p) => p.activity === 'boarding')) boardingSeen = true;
      if (state.some((p) => p.activity === 'boarding' && p.opacity < 0.05)) boarded = true;
    }
    expect(boardingSeen, 'nobody ever walked towards the train').toBe(true);
    expect(boarded, 'the boarders reached the carriage and stood there instead of getting on').toBe(
      true
    );
    expect(
      present(crowd, label),
      'the train took nobody: the platform is as full as it was'
    ).toBeLessThan(PER_STATION);

    runFrames(crowd, 6, new Set());
    expect(
      present(crowd, label),
      'the platform is empty for the rest of the session after one train'
    ).toBe(PER_STATION);
  });

  test('somebody gets off the train', () => {
    const scene = new THREE.Scene();
    const crowd = new PassengerCrowd(scene);
    const label = STATION_STOPS[0].label;

    runFrames(crowd, 3, new Set());
    runFrames(crowd, 2, new Set([label]));

    const arriving = at(crowd, label).filter(
      (p) => p.activity === 'disembarking' && p.visible && p.opacity > 0.5
    );
    expect(arriving.length, 'everyone who got off the train is invisible').toBeGreaterThan(0);
  });

  test('the quality profile still switches figures off, and back on again', () => {
    const scene = new THREE.Scene();
    const crowd = new PassengerCrowd(scene);
    const label = STATION_STOPS[0].label;

    runFrames(crowd, 3, new Set());
    expect(present(crowd, label)).toBe(PER_STATION);

    // `setDensity` keeps a floor of two figures per station at any density.
    crowd.setDensity(0);
    runFrames(crowd, 1, new Set());
    expect(present(crowd, label), 'the low profile draws the whole crowd').toBe(2);

    crowd.setDensity(1);
    runFrames(crowd, 1, new Set());
    expect(present(crowd, label), 'the crowd never came back').toBe(PER_STATION);
  });

  test('a train that stops during totality leaves a station behind it, not a ghost town', () => {
    const scene = new THREE.Scene();
    const crowd = new PassengerCrowd(scene);
    const label = STATION_STOPS[0].label;

    runFrames(crowd, 3, new Set());
    expect(present(crowd, label)).toBe(PER_STATION);

    // Totality slows every figure to a twenty-fifth of its pace, which is what made the owner's
    // report read the way it did: the dwell runs to its end while the walk barely advances, so
    // the ones stepping off the train are still nearly transparent when the train leaves.
    crowd.setEclipseReaction(eclipseWorldReactionAt(1, 1));
    const dwell = new Set([label]);
    let arrivingDrawn = false;
    for (let i = 0; i < Math.round(STATION_STOPS[0].dwellSeconds / STEP); i++) {
      crowd.update(STEP, dwell);
      if (at(crowd, label).some((p) => p.activity === 'disembarking' && p.visible)) {
        arrivingDrawn = true;
      }
    }
    expect(
      arrivingDrawn,
      'under totality the figures stepping off the train were switched off instead of faded in'
    ).toBe(true);

    runFrames(crowd, 4, new Set());
    crowd.setEclipseReaction(eclipseWorldReactionAt(0, 0));
    runFrames(crowd, 6, new Set());

    expect(present(crowd, label), 'the eclipse emptied the platform for good').toBe(PER_STATION);
  });
});
