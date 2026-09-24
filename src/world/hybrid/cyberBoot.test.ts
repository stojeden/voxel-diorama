import * as THREE from 'three';
import { describe, expect, test } from 'vitest';
import { QUALITY_PROFILES } from '../../performance/QualityManager';
import { THEMES } from '../../experience/Themes';
import { attachHybridSpike } from './HybridSpike';

/**
 * A city attached after the theme was set starts where the morph already is.
 *
 * `?checkpoint=cyberpunk` sets the Cyberpunk morph to 1 while booting, and the hybrid is a
 * lazy chunk that attaches afterwards. It used to start at rise 0 regardless, and nothing asked
 * again -- the frame loop only ramps towards a target it has not reached -- so the checkpoint
 * showed the ordinary city under the Cyberpunk grade.
 */
describe('the hybrid city attaches at the current Cyberpunk morph', () => {
  const attach = (cyberRise?: number) => {
    const scene = new THREE.Scene();
    const hybrid = attachHybridSpike({
      scene,
      strategy: 'direct',
      quality: QUALITY_PROFILES.high,
      themePalette: THEMES.find((theme) => theme.id === 'cyberpunk')!.palette,
      cyberRise,
    });
    const awnings = scene.getObjectByName('shop-awnings')!.children;
    return { scene, hybrid, drawnAwnings: () => awnings.filter((a) => a.visible).length, allAwnings: awnings.length };
  };

  test('fully risen, with the ordinary city it replaces already gone', () => {
    const { hybrid, drawnAwnings, allAwnings } = attach(1);
    expect(hybrid.getMetrics().cyber.rise).toBe(1);
    expect(allAwnings, 'no awnings built, so the check below means nothing').toBeGreaterThan(0);
    // The awnings leave with their tenements on the same threshold: none drawn means the
    // ordinary plots were suppressed on the very first swap, not on some later frame.
    expect(drawnAwnings(), 'the ordinary shopfronts are still standing').toBe(0);
    hybrid.dispose();
  });

  test('and a city attached without a morph is the ordinary one, as before', () => {
    const { hybrid, drawnAwnings, allAwnings } = attach();
    expect(hybrid.getMetrics().cyber.rise).toBe(0);
    expect(drawnAwnings()).toBe(allAwnings);
    hybrid.dispose();
  });
});
