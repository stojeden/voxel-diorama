import * as THREE from 'three';
import { describe, expect, test } from 'vitest';
import { buildCityModel } from './CityModel';
import { emitBuilding } from './architecture';
import { emitDominant } from './dominants';
import { emitStreetscape } from './streetscape';
import { buildDirect } from './strategies/DirectSurfaceStrategy';
import { ATTRIBUTES } from './strategies/strategy';
import type { Cluster } from './surface';

/**
 * Determinism of the geometry itself, not of the counters over it. One seed has to
 * produce the same buffers: the same vertex positions and normals, and the same
 * per-vertex palette, cohort, ambient-occlusion and style values, because those are
 * what the material reads. Two builds are compared through a digest of every
 * attribute's bytes.
 *
 * A digest is only evidence if it changes when the geometry changes, so every case
 * here is paired with a perturbation: one float moved by a millimetre, one cohort
 * index changed, one style flag flipped.
 */

/** FNV-1a over the raw bytes of an attribute, returned as hex. Order-sensitive. */
function digest(view: ArrayBufferView): string {
  const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  let hash = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    hash ^= bytes[i];
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${bytes.length.toString(16)}:${hash.toString(16).padStart(8, '0')}`;
}

/** Digest of every attribute of every geometry a cluster produces, keyed by both. */
function fingerprint(cluster: Cluster): Record<string, string> {
  const out: Record<string, string> = {};
  const built = buildDirect(cluster);
  for (const [key, geometry] of [...built.geometries].sort(([a], [b]) => a.localeCompare(b))) {
    for (const attribute of ATTRIBUTES) {
      const data = geometry.getAttribute(attribute) as THREE.BufferAttribute;
      out[`${key}/${attribute}`] = digest(data.array as Float32Array);
    }
  }
  return out;
}

const clustersOf = (model: ReturnType<typeof buildCityModel>): Record<string, Cluster> => ({
  ...Object.fromEntries(model.buildings.map((building) => [`block-${building.index}`, emitBuilding(building)])),
  streetscape: emitStreetscape(model),
  // Both dominants at both detail levels: `low` is a different geometry, not a
  // different draw of the same one, so each has to be deterministic on its own.
  ...Object.fromEntries(model.dominants.flatMap((dominant) => [false, true].map(
    (low) => [`${dominant.kind}-${low ? 'low' : 'high'}`, emitDominant(dominant, low)] as const
  ))),
});

describe('deterministic geometry', () => {
  test('two builds of one model agree byte for byte, attribute by attribute', () => {
    const model = buildCityModel();
    const clusters = clustersOf(model);
    let attributesCompared = 0;
    for (const [name, cluster] of Object.entries(clusters)) {
      const first = fingerprint(cluster);
      const second = fingerprint(cluster);
      expect(Object.keys(first).length, `${name}: brak atrybutow`).toBeGreaterThan(0);
      expect(second, name).toEqual(first);
      attributesCompared += Object.keys(first).length;
    }
    // Guard against a green run that compared nothing: every class/layer of every
    // cluster contributes one digest per attribute.
    expect(attributesCompared).toBeGreaterThan(100);
  });

  test('rebuilding the model from the seed reproduces the same buffers', () => {
    // The layout is seeded, so a second `buildCityModel` has to yield geometry with
    // the same digests -- this is the check that catches a Math.random or a Date in
    // the emitters, which a comparison of two builds of one model cannot see.
    const a = clustersOf(buildCityModel());
    const b = clustersOf(buildCityModel());
    expect(Object.keys(b)).toEqual(Object.keys(a));
    for (const name of Object.keys(a)) {
      expect(fingerprint(b[name]), name).toEqual(fingerprint(a[name]));
    }
  });

  test('the digest notices a millimetre, a cohort and a style flag', () => {
    const model = buildCityModel();
    const reference = fingerprint(emitBuilding(model.buildings[0]));

    // A vertex moved by one millimetre.
    const moved = emitBuilding(model.buildings[0]);
    const box = moved.primitives.find((prim) => prim.kind === 'box')!;
    if (box.kind === 'box') box.y += 0.001;
    const movedPrint = fingerprint(moved);
    expect(movedPrint).not.toEqual(reference);
    // ...and it shows up in position, not somewhere unrelated.
    const movedKeys = Object.keys(movedPrint).filter((key) => movedPrint[key] !== reference[key]);
    expect(movedKeys.every((key) => key.endsWith('/position'))).toBe(true);

    // A window's cohort index: the value that decides when its light comes on.
    const recohorted = emitBuilding(model.buildings[0]);
    const glazed = recohorted.primitives.find((prim) => prim.cohort >= 0)!;
    glazed.cohort = (glazed.cohort + 1) % 5;
    const cohortPrint = fingerprint(recohorted);
    expect(cohortPrint).not.toEqual(reference);
    expect(Object.keys(cohortPrint).filter((key) => cohortPrint[key] !== reference[key]))
      .toEqual(expect.arrayContaining([expect.stringContaining('/aCohort')]));

    // A style flag, which selects the noise the shader applies.
    const restyled = emitBuilding(model.buildings[0]);
    restyled.primitives[0].style += 1;
    const stylePrint = fingerprint(restyled);
    expect(stylePrint).not.toEqual(reference);
    expect(Object.keys(stylePrint).filter((key) => stylePrint[key] !== reference[key]))
      .toEqual(expect.arrayContaining([expect.stringContaining('/aStyle')]));
  });

  test('a digest depends on order, so a reshuffled buffer is not equal', () => {
    // Otherwise a merge that emitted the same vertices in a different order would
    // pass as identical, and the geometry would still be a different mesh.
    const straight = new Float32Array([1, 2, 3, 4, 5, 6]);
    const swapped = new Float32Array([4, 5, 6, 1, 2, 3]);
    expect(digest(swapped)).not.toEqual(digest(straight));
    expect(digest(new Float32Array([1, 2, 3, 4, 5, 6]))).toEqual(digest(straight));
  });
});
