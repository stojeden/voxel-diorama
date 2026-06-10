import * as THREE from 'three';
import { COLORS, RAIL_SIGNAL_POSITIONS } from './WorldLayout';

/**
 * Trackside signals that switch red when the train approaches.
 *
 * Each signal has two lamps stacked vertically — top is the "current" state,
 * bottom is the "other" state. We modulate `emissiveIntensity` rather than
 * swapping colors so it reads even in daylight.
 */

interface Signal {
  position: THREE.Vector3;
  redMaterial: THREE.MeshStandardMaterial;
  greenMaterial: THREE.MeshStandardMaterial;
}

export class RailSignals {
  private signals: Signal[] = [];
  private readonly group: THREE.Group;
  private readonly disposables: Array<{ dispose: () => void }> = [];
  private readonly scene: THREE.Scene;

  constructor(scene: THREE.Scene) {
    this.scene = scene;
    this.group = new THREE.Group();
    this.group.name = 'rail-signals';

    const postGeo = new THREE.BoxGeometry(0.4, 5, 0.4);
    const lampGeo = new THREE.BoxGeometry(0.55, 0.55, 0.55);
    const postMaterial = new THREE.MeshStandardMaterial({
      color: COLORS.steel,
      roughness: 0.5,
      metalness: 0.55,
    });
    this.disposables.push(postGeo, lampGeo, postMaterial);

    for (const [x, z] of RAIL_SIGNAL_POSITIONS) {
      const post = new THREE.Mesh(postGeo, postMaterial);
      post.position.set(x, 2.5, z);
      post.castShadow = true;
      this.group.add(post);

      const redMaterial = new THREE.MeshStandardMaterial({
        color: COLORS.signalRed,
        emissive: COLORS.signalRed,
        emissiveIntensity: 0.4,
        roughness: 0.4,
      });
      const greenMaterial = new THREE.MeshStandardMaterial({
        color: COLORS.signalGreen,
        emissive: COLORS.signalGreen,
        emissiveIntensity: 1.0,
        roughness: 0.4,
      });
      this.disposables.push(redMaterial, greenMaterial);

      const redLamp = new THREE.Mesh(lampGeo, redMaterial);
      redLamp.position.set(x, 5.4, z);
      this.group.add(redLamp);

      const greenLamp = new THREE.Mesh(lampGeo, greenMaterial);
      greenLamp.position.set(x, 4.6, z);
      this.group.add(greenLamp);

      this.signals.push({
        position: new THREE.Vector3(x, 5, z),
        redMaterial,
        greenMaterial,
      });
    }

    scene.add(this.group);
  }

  update(trainPosition: THREE.Vector3): void {
    for (const signal of this.signals) {
      const dist = Math.hypot(
        signal.position.x - trainPosition.x,
        signal.position.z - trainPosition.z
      );
      const isClose = dist < 22;
      // Red when train is close; green otherwise. Smooth crossfade via emissive.
      const redTarget = isClose ? 1.2 : 0.05;
      const greenTarget = isClose ? 0.05 : 1.0;
      signal.redMaterial.emissiveIntensity +=
        (redTarget - signal.redMaterial.emissiveIntensity) * 0.08;
      signal.greenMaterial.emissiveIntensity +=
        (greenTarget - signal.greenMaterial.emissiveIntensity) * 0.08;
    }
  }

  dispose(): void {
    this.scene.remove(this.group);
    for (const item of this.disposables) item.dispose();
    this.signals.length = 0;
  }
}
