import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { RainbowAtmosphere, type RainbowFrameInput } from './RainbowAtmosphere';

function frame(overrides: Partial<RainbowFrameInput> = {}): RainbowFrameInput {
  const camera = new THREE.PerspectiveCamera(45, 16 / 9, 0.1, 1_000);
  camera.position.set(-54, 10, 98.2);
  camera.lookAt(-13, 11, 54);
  camera.updateMatrixWorld();
  return {
    camera,
    sunDirection: new THREE.Vector3(-0.8, 0.42, -0.4).normalize(),
    sunElevation: THREE.MathUtils.degToRad(24),
    sunColor: new THREE.Color(1, 0.9, 0.75),
    directSun: 1,
    cloudCover: 0.12,
    rainIntensity: 0,
    airborneMoisture: 1,
    wind: 0.16,
    realDelta: 1,
    elapsed: 4,
    ...overrides,
  };
}

describe('RainbowAtmosphere', () => {
  it('renders only when lit droplets and a physically valid sun elevation coexist', () => {
    const rainbow = new RainbowAtmosphere(() => 0.25);
    rainbow.debugSetSource(0);
    rainbow.update(frame());

    expect(rainbow.getDebugState()).toMatchObject({
      visible: true,
      source: 'lake',
      sourceIndex: 0,
    });

    rainbow.update(frame({
      sunElevation: THREE.MathUtils.degToRad(-2),
      directSun: 0,
      realDelta: 30,
    }));
    expect(rainbow.getDebugState().visible).toBe(false);
  });

  it('selects a deterministic natural moisture zone once per rain event', () => {
    const samples = [0.7, 0.5, 0.5, 0.5, 0.5, 0.5];
    let cursor = 0;
    const rainbow = new RainbowAtmosphere(() => samples[cursor++] ?? 0.5);

    rainbow.update(frame({ rainIntensity: 1 }));
    const selected = rainbow.getDebugState();
    expect(selected.source).toBe('north-park');
    expect(selected.sourceIndex).toBe(2);

    rainbow.update(frame({ rainIntensity: 1 }));
    expect(rainbow.getDebugState().sourceIndex).toBe(2);
  });

  it('updates preallocated uniforms without replacing their objects', () => {
    const rainbow = new RainbowAtmosphere(() => 0.5);
    const uniforms = rainbow.effect.uniforms;
    const objectUniforms = [...uniforms.values()]
      .filter((uniform) => typeof uniform.value === 'object');
    const identities = objectUniforms.map((uniform) => uniform.value);
    for (let index = 0; index < 100; index++) {
      rainbow.update(frame({ elapsed: index, realDelta: 1 / 60 }));
    }
    for (let index = 0; index < objectUniforms.length; index++) {
      expect(objectUniforms[index].value).toBe(identities[index]);
    }
  });

  it('uses the camera world position when a future camera rig adds a parent', () => {
    const rainbow = new RainbowAtmosphere(() => 0.5);
    const camera = frame().camera;
    const rig = new THREE.Object3D();
    rig.add(camera);
    rig.updateMatrixWorld(true);
    rig.position.set(3, 7, -4);
    camera.updateWorldMatrix(true, false);

    rainbow.update(frame({ camera }));
    const cameraPosition = rainbow.effect.uniforms.get('uCameraPosition')!
      .value as THREE.Vector3;
    const expected = new THREE.Vector3().setFromMatrixPosition(camera.matrixWorld);
    expect(cameraPosition.toArray()).toEqual(expected.toArray());
  });

  it('skips the secondary ray family outside High quality', () => {
    const rainbow = new RainbowAtmosphere(() => 0.5);
    const secondary = rainbow.effect.uniforms.get('uSecondary')!;
    rainbow.setQuality('low');
    expect(secondary.value).toBe(0);
    rainbow.setQuality('medium');
    expect(secondary.value).toBe(0);
    rainbow.setQuality('high');
    expect(secondary.value).toBe(1);
  });

  it('bakes the spectrum into a two-row LUT with no more than two shader fetches', () => {
    const rainbow = new RainbowAtmosphere(() => 0.5);
    const lut = rainbow.effect.uniforms.get('uSpectralLut')!
      .value as THREE.DataTexture;
    const shader = rainbow.effect.getFragmentShader();

    expect(lut.image.width).toBe(1_024);
    expect(lut.image.height).toBe(2);
    expect(lut.type).toBe(THREE.HalfFloatType);
    expect(shader.match(/texture2D\s*\(/g)).toHaveLength(2);
    expect(shader).not.toContain('primaryBand');
    expect(shader).not.toContain('secondaryBand');
  });

  it('bakes physical ray tails, Alexander gap and reversed secondary colours', () => {
    const rainbow = new RainbowAtmosphere(() => 0.5);
    const lut = rainbow.effect.uniforms.get('uSpectralLut')!
      .value as THREE.DataTexture;
    const muRange = rainbow.effect.uniforms.get('uSpectralMuRange')!
      .value as THREE.Vector2;
    const data = lut.image.data as Uint16Array;
    const sample = (angleDegrees: number, row: number) => {
      const mu = Math.cos(THREE.MathUtils.degToRad(angleDegrees));
      const unit = THREE.MathUtils.clamp(
        (mu - muRange.x) / (muRange.y - muRange.x),
        0,
        1
      );
      const x = Math.round(unit * (lut.image.width - 1));
      const offset = (row * lut.image.width + x) * 4;
      return [
        THREE.DataUtils.fromHalfFloat(data[offset]),
        THREE.DataUtils.fromHalfFloat(data[offset + 1]),
        THREE.DataUtils.fromHalfFloat(data[offset + 2]),
      ];
    };
    const luminance = (rgb: number[]) =>
      Math.max(0, rgb[0]) * 0.2126 +
      Math.max(0, rgb[1]) * 0.7152 +
      Math.max(0, rgb[2]) * 0.0722;
    const primaryTail = sample(38, 0);
    const primaryInner = sample(40.8, 0);
    const primaryOuter = sample(42.3, 0);
    const gapPrimary = sample(47, 0);
    const gapSecondary = sample(47, 1);
    const secondaryInner = sample(50.3, 1);
    const secondaryOuter = sample(53.2, 1);
    const secondaryTail = sample(57, 1);
    const secondaryFarTail = sample(80, 1);

    expect(luminance(primaryTail)).toBeGreaterThan(luminance(gapPrimary));
    expect(luminance(secondaryTail)).toBeGreaterThan(luminance(gapSecondary));
    expect(luminance(secondaryFarTail)).toBeGreaterThan(luminance(gapSecondary));
    expect(primaryInner[2]).toBeGreaterThan(primaryInner[0]);
    expect(primaryOuter[0]).toBeGreaterThan(primaryOuter[2]);
    expect(secondaryInner[0]).toBeGreaterThan(secondaryInner[2]);
    expect(secondaryOuter[2]).toBeGreaterThan(secondaryOuter[0]);
  });

  it('keeps Beer-Lambert extinction independent from solar irradiance', () => {
    const rainbow = new RainbowAtmosphere(() => 0.5);
    rainbow.debugSetSource(0);
    rainbow.update(frame({
      airborneMoisture: 0.8,
      directSun: 0.5,
      realDelta: 0,
    }));

    expect(rainbow.effect.uniforms.get('uExtinction')!.value).toBeCloseTo(0.8);
    expect(rainbow.effect.uniforms.get('uRadianceScale')!.value).toBeCloseTo(0.5);
    expect(rainbow.effect.getFragmentShader()).not.toContain('angularWindow');
  });

  it('keeps an unlit wet curtain active without reporting a visible rainbow', () => {
    const rainbow = new RainbowAtmosphere(() => 0.5);
    rainbow.debugSetSource(0);
    rainbow.update(frame({
      airborneMoisture: 0.8,
      directSun: 0,
      realDelta: 0,
    }));

    expect(rainbow.getDebugState()).toMatchObject({
      visible: false,
      effectActive: true,
      strength: 0,
      extinction: 0.8,
    });
    expect(rainbow.effect.uniforms.get('uStrength')!.value).toBe(0);
    expect(rainbow.effect.uniforms.get('uExtinction')!.value).toBeCloseTo(0.8);
    expect(rainbow.effect.uniforms.get('uRadianceScale')!.value).toBe(0);
    const shader = rainbow.effect.getFragmentShader();
    const extinctionOnlyBranch = shader.indexOf('if (uStrength <= 0.0005)');
    expect(extinctionOnlyBranch).toBeGreaterThanOrEqual(0);
    expect(extinctionOnlyBranch).toBeLessThan(shader.indexOf('float mu ='));
  });

  it('preserves extinction when the rainbow cone lies below the local horizon', () => {
    const rainbow = new RainbowAtmosphere(() => 0.5);
    rainbow.debugSetSource(0);
    rainbow.setQuality('medium');
    const camera = frame().camera;
    camera.position.y = -0.35;
    camera.updateMatrixWorld();
    rainbow.update(frame({
      camera,
      airborneMoisture: 0.8,
      sunElevation: THREE.MathUtils.degToRad(50),
      realDelta: 0,
    }));

    expect(rainbow.isVisible()).toBe(false);
    expect(rainbow.isEffectActive()).toBe(true);
    expect(rainbow.effect.uniforms.get('uStrength')!.value).toBe(0);
    expect(rainbow.effect.uniforms.get('uExtinction')!.value).toBeCloseTo(0.8);
  });

  it('normalizes non-finite debug indices instead of corrupting source state', () => {
    const rainbow = new RainbowAtmosphere(() => 0.5);
    rainbow.debugSetSource(Number.NaN);
    expect(rainbow.getDebugState()).toMatchObject({
      source: 'lake',
      sourceIndex: 0,
    });

    rainbow.debugSetSource(Number.POSITIVE_INFINITY);
    expect(rainbow.getDebugState().sourceIndex).toBe(0);
  });

  it('gates only cones below the local horizon, preserving elevated observers', () => {
    const rainbow = new RainbowAtmosphere(() => 0.5);
    rainbow.debugSetSource(0);
    const groundCamera = frame().camera;
    groundCamera.position.y = -0.35;
    groundCamera.updateMatrixWorld();

    rainbow.setQuality('medium');
    rainbow.update(frame({
      camera: groundCamera,
      sunElevation: THREE.MathUtils.degToRad(50),
      realDelta: 0,
    }));
    expect(rainbow.isVisible()).toBe(false);

    rainbow.setQuality('high');
    rainbow.update(frame({
      camera: groundCamera,
      sunElevation: THREE.MathUtils.degToRad(50),
      realDelta: 0,
    }));
    expect(rainbow.isVisible()).toBe(true);

    rainbow.update(frame({
      camera: groundCamera,
      sunElevation: THREE.MathUtils.degToRad(58),
      realDelta: 0,
    }));
    expect(rainbow.isVisible()).toBe(true);

    rainbow.update(frame({
      camera: groundCamera,
      sunElevation: THREE.MathUtils.degToRad(80),
      realDelta: 0,
    }));
    expect(rainbow.isVisible()).toBe(true);

    rainbow.update(frame({
      camera: groundCamera,
      sunElevation: THREE.MathUtils.degToRad(90),
      realDelta: 0,
    }));
    expect(rainbow.isVisible()).toBe(false);

    groundCamera.position.y = 8;
    groundCamera.updateMatrixWorld();
    rainbow.update(frame({
      camera: groundCamera,
      sunElevation: THREE.MathUtils.degToRad(58),
      realDelta: 0,
    }));
    expect(rainbow.isVisible()).toBe(true);

    const awayCamera = frame().camera;
    awayCamera.lookAt(-54, 10, 180);
    awayCamera.updateMatrixWorld();
    rainbow.update(frame({
      camera: awayCamera,
      sunElevation: THREE.MathUtils.degToRad(24),
      realDelta: 0,
    }));
    expect(rainbow.isVisible()).toBe(false);
  });

  it('gives the Effect a single disposal path for its owned LUT', () => {
    const rainbow = new RainbowAtmosphere(() => 0.5);
    const secondRainbow = new RainbowAtmosphere(() => 0.5);
    const lut = rainbow.effect.uniforms.get('uSpectralLut')!
      .value as THREE.DataTexture;
    const secondLut = secondRainbow.effect.uniforms.get('uSpectralLut')!
      .value as THREE.DataTexture;
    expect(secondLut).not.toBe(lut);
    expect(secondLut.image.data).not.toBe(lut.image.data);
    expect(secondLut.image.data).toEqual(lut.image.data);
    let disposalCount = 0;
    lut.addEventListener('dispose', () => {
      disposalCount++;
    });

    rainbow.effect.dispose();
    expect(disposalCount).toBe(1);
    expect(secondLut.image.data).toEqual(lut.image.data);
    secondRainbow.effect.dispose();
  });
});
