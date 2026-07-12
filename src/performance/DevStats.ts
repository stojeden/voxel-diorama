import type * as THREE from 'three';

export interface DevStatsHandle {
  update: () => void;
  dispose: () => void;
}

export async function mountDevStats(renderer: THREE.WebGLRenderer): Promise<DevStatsHandle> {
  const { default: Stats } = await import('stats-gl');
  const stats = new Stats({
    trackFPS: true,
    trackGPU: true,
    trackHz: true,
    minimal: true,
    horizontal: true,
  });
  await stats.init(renderer);
  stats.dom.dataset.dioramaProfiler = 'true';
  stats.dom.style.zIndex = '120';
  stats.dom.style.position = 'fixed';
  stats.dom.style.top = '8px';
  stats.dom.style.left = '50%';
  stats.dom.style.transform = 'translateX(-50%)';
  document.body.appendChild(stats.dom);

  return {
    update: () => stats.update(),
    dispose: () => {
      stats.dom.remove();
      stats.dispose();
    },
  };
}
