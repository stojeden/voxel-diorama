import * as THREE from 'three';
import { describe, expect, test } from 'vitest';
import { createTrain } from './Train';
import { COLORS } from './WorldLayout';

/**
 * The carriage glazing, read off the finished material in the built scene.
 *
 * It had the same defect the bus had: the window colour was `windowLit` -- the warm
 * cream of a lit flat -- with a constant 0.4 emissive, so a daylight train showed rows
 * of glowing cream rectangles and a night train showed exactly the same ones. Glass in
 * daylight is dark and takes its brightness from the sky it reflects; the lit interior
 * is a night state.
 *
 * Not the bus's numbers, though: a carriage window is a large flat pane seen side-on
 * from almost every camera in this diorama, which is the angle where a smooth pane
 * blows out to white, so it is rougher and reflects less than the bus's glass.
 */

const relativeLuminance = (color: THREE.Color) => 0.2126 * color.r + 0.7152 * color.g + 0.0722 * color.b;

/**
 * The glazing, found in the scene rather than taken from the handle, which does not
 * expose it: it is the only train material whose own colour is the product's unlit
 * window. The test asserts it is the only one, so the search cannot silently start
 * matching a headlight or a pantograph.
 */
const glazingOf = (scene: THREE.Scene): THREE.MeshStandardMaterial => {
  const found = new Set<THREE.MeshStandardMaterial>();
  scene.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (!mesh.isMesh || !mesh.material) return;
    for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      const standard = material as THREE.MeshStandardMaterial;
      if (standard.color?.getHex() === COLORS.window) found.add(standard);
    }
  });
  expect(found.size, 'exactly one train material is glazing').toBe(1);
  return [...found][0];
};

describe('train glazing', () => {
  test('is dark glass by day and a lit interior by night', () => {
    const scene = new THREE.Scene();
    const train = createTrain(scene);

    train.update(1 / 60, 1, 0);
    const day = glazingOf(scene);
    expect(day.emissiveIntensity, 'daylight glazing must not glow').toBeCloseTo(0, 5);
    expect(
      relativeLuminance(day.color),
      `daylight pane luminance ${relativeLuminance(day.color).toFixed(3)}`
    ).toBeLessThan(0.2);

    // Reflective enough to be glass, rough enough not to become a white flare at the
    // grazing angles a carriage side is always seen from.
    expect(day.roughness).toBeGreaterThan(0.12);
    expect(day.roughness).toBeLessThan(0.3);
    expect(day.envMapIntensity).toBeGreaterThanOrEqual(1);
    expect(day.envMapIntensity, 'a carriage pane reflects less than the bus glass at 1.2').toBeLessThan(1.2);

    train.update(1 / 60, 2, 1);
    const night = glazingOf(scene);
    expect(night.emissiveIntensity, 'night glazing must glow').toBeGreaterThan(0.9);
    expect(night.emissive.r, 'a lit carriage is warm').toBeGreaterThan(night.emissive.b);
    expect(relativeLuminance(night.emissive)).toBeGreaterThan(0.5);
    // The pane itself stays dark: what lights up is the interior behind it.
    expect(relativeLuminance(night.color)).toBeLessThan(0.2);
  });

  test('dusk ramps the interior instead of switching it', () => {
    const scene = new THREE.Scene();
    const train = createTrain(scene);
    const readings: number[] = [];
    for (const night of [0, 0.25, 0.5, 0.75, 1]) {
      train.update(1 / 60, 1 + night, night);
      readings.push(glazingOf(scene).emissiveIntensity);
    }
    for (let i = 1; i < readings.length; i++) {
      expect(readings[i], `night ${i}: ${readings.join(', ')}`).toBeGreaterThanOrEqual(readings[i - 1]);
    }
    expect(readings[0]).toBeCloseTo(0, 5);
    expect(readings[readings.length - 1]).toBeGreaterThan(0.9);
  });

  test('Cyberpunk changes the light inside the glass, not the glass into a lamp', () => {
    const scene = new THREE.Scene();
    const train = createTrain(scene);
    train.setLivery('cyber');
    train.update(1 / 60, 1, 1);
    const material = glazingOf(scene);
    // Cyan interior, still emitting, and the pane is still a dark pane.
    expect(material.emissive.b).toBeGreaterThan(material.emissive.r);
    expect(material.emissiveIntensity).toBeGreaterThan(0.9);
    expect(relativeLuminance(material.color)).toBeLessThan(0.2);

    train.setLivery('modern');
    train.update(1 / 60, 2, 1);
    expect(material.emissive.r, 'back to a warm interior').toBeGreaterThan(material.emissive.b);
  });
});
