import * as THREE from 'three';

/**
 * Hot-air balloon (and, in cyberpunk mode, a space jet).
 *
 * The balloon no longer pops into existence: it enters LOW at the map edge,
 * climbs gently to cruise altitude, and descends again before slipping off
 * the far side. It also flies at dusk — when the burner bursts, the flame
 * lights the envelope from below (point light + emissive), which looks
 * gorgeous against the evening sky.
 */

const CRUISE_Y = 46;
const ENTRY_Y = 16;
const EDGE = 115;

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

export class Balloon {
  private readonly scene: THREE.Scene;
  private readonly group = new THREE.Group();
  private readonly balloonGroup = new THREE.Group();
  private readonly jetGroup = new THREE.Group();
  private readonly burnerMaterial: THREE.MeshStandardMaterial;
  private readonly envelopeMaterial: THREE.MeshStandardMaterial;
  private readonly burnerLight: THREE.PointLight;
  private readonly engineMaterial: THREE.MeshStandardMaterial;
  private readonly arm: THREE.Mesh;
  private readonly disposables: Array<{ dispose: () => void }> = [];

  private cyber = false;
  private flying = false;
  private cooldown = 18;
  private z = 0;
  private bobPhase = 0;

  constructor(scene: THREE.Scene) {
    this.scene = scene;

    // ── Balloon model ──
    this.envelopeMaterial = new THREE.MeshStandardMaterial({ color: 0xd23a3a, roughness: 0.6 });
    const bandMat = new THREE.MeshStandardMaterial({ color: 0xf2c84b, roughness: 0.6 });
    const basketMat = new THREE.MeshStandardMaterial({ color: 0x7a5a32, roughness: 0.9 });
    const ropeMat = new THREE.MeshStandardMaterial({ color: 0x3a3a3a, roughness: 0.8 });
    this.burnerMaterial = new THREE.MeshStandardMaterial({
      color: 0xffc46b,
      emissive: 0xff9a2e,
      emissiveIntensity: 0.4,
    });
    this.disposables.push(this.envelopeMaterial, bandMat, basketMat, ropeMat, this.burnerMaterial);

    const envelopeGeo = new THREE.SphereGeometry(3, 16, 14);
    this.disposables.push(envelopeGeo);
    const envelope = new THREE.Mesh(envelopeGeo, this.envelopeMaterial);
    envelope.scale.set(1, 1.15, 1);
    envelope.castShadow = true;
    this.balloonGroup.add(envelope);

    const bandGeo = new THREE.CylinderGeometry(3.02, 3.02, 1.1, 16, 1, true);
    this.disposables.push(bandGeo);
    this.balloonGroup.add(new THREE.Mesh(bandGeo, bandMat));

    const basketGeo = new THREE.BoxGeometry(1.4, 1, 1.4);
    this.disposables.push(basketGeo);
    const basket = new THREE.Mesh(basketGeo, basketMat);
    basket.position.y = -4.6;
    basket.castShadow = true;
    this.balloonGroup.add(basket);

    const ropeGeo = new THREE.BoxGeometry(0.06, 1.8, 0.06);
    this.disposables.push(ropeGeo);
    for (const [rx, rz] of [[-0.6, -0.6], [0.6, -0.6], [-0.6, 0.6], [0.6, 0.6]] as const) {
      const rope = new THREE.Mesh(ropeGeo, ropeMat);
      rope.position.set(rx, -3.4, rz);
      this.balloonGroup.add(rope);
    }

    const burnerGeo = new THREE.BoxGeometry(0.5, 0.5, 0.5);
    this.disposables.push(burnerGeo);
    const burner = new THREE.Mesh(burnerGeo, this.burnerMaterial);
    burner.position.y = -3.6;
    this.balloonGroup.add(burner);

    // The burner flame lights the envelope from below at dusk.
    this.burnerLight = new THREE.PointLight(0xff9a2e, 0, 16, 1.6);
    this.burnerLight.position.y = -3.2;
    this.balloonGroup.add(this.burnerLight);

    // Tiny waving passenger
    const passengerMat = new THREE.MeshStandardMaterial({ color: 0x2b5f9a, roughness: 0.8 });
    const headMat = new THREE.MeshStandardMaterial({ color: 0xe8c39a, roughness: 0.8 });
    const bodyGeo = new THREE.BoxGeometry(0.45, 0.6, 0.35);
    const headGeo = new THREE.BoxGeometry(0.32, 0.32, 0.32);
    const armGeo = new THREE.BoxGeometry(0.14, 0.55, 0.14);
    this.disposables.push(passengerMat, headMat, bodyGeo, headGeo, armGeo);
    const body = new THREE.Mesh(bodyGeo, passengerMat);
    body.position.set(0.3, -4.0, 0);
    this.balloonGroup.add(body);
    const head = new THREE.Mesh(headGeo, headMat);
    head.position.set(0.3, -3.55, 0);
    this.balloonGroup.add(head);
    this.arm = new THREE.Mesh(armGeo, passengerMat);
    this.arm.position.set(0.62, -3.85, 0);
    this.balloonGroup.add(this.arm);

    // ── Space jet (cyberpunk) — front faces +x (direction of travel) ──
    const hullMat = new THREE.MeshStandardMaterial({ color: 0x1a2029, metalness: 0.9, roughness: 0.25 });
    hullMat.envMapIntensity = 1.6;
    this.engineMaterial = new THREE.MeshStandardMaterial({
      color: 0x06262e,
      emissive: 0x35e6ff,
      emissiveIntensity: 2.4,
    });
    this.disposables.push(hullMat, this.engineMaterial);

    const fuselageGeo = new THREE.BoxGeometry(5.2, 0.9, 1.1);
    this.disposables.push(fuselageGeo);
    const fuselage = new THREE.Mesh(fuselageGeo, hullMat);
    this.jetGroup.add(fuselage);

    const noseGeo = new THREE.ConeGeometry(0.55, 1.8, 4);
    this.disposables.push(noseGeo);
    const nose = new THREE.Mesh(noseGeo, hullMat);
    nose.rotation.z = -Math.PI / 2;
    nose.rotation.y = Math.PI / 4;
    nose.position.x = 3.4;
    this.jetGroup.add(nose);

    const wingGeo = new THREE.BoxGeometry(1.6, 0.12, 4.6);
    this.disposables.push(wingGeo);
    const wing = new THREE.Mesh(wingGeo, hullMat);
    wing.position.x = -0.4;
    this.jetGroup.add(wing);

    const engineGeo = new THREE.BoxGeometry(0.7, 0.5, 0.5);
    this.disposables.push(engineGeo);
    for (const ez of [-1.6, 1.6]) {
      const engine = new THREE.Mesh(engineGeo, this.engineMaterial);
      engine.position.set(-2.4, -0.1, ez);
      this.jetGroup.add(engine);
    }
    this.jetGroup.visible = false;

    this.group.add(this.balloonGroup, this.jetGroup);
    this.group.visible = false;
    scene.add(this.group);
  }

  /** Cyberpunk swap: balloon ⇄ space jet. */
  setCyberMode(on: boolean): void {
    if (on === this.cyber) return;
    this.cyber = on;
    this.balloonGroup.visible = !on;
    this.jetGroup.visible = on;
    if (this.flying) {
      // Whatever is mid-air just leaves; the next flight uses the new craft.
      this.flying = false;
      this.group.visible = false;
      this.cooldown = 6;
    }
  }

  update(delta: number, elapsed: number, night: number, cloudCover: number, wind: number): void {
    if (!this.flying) {
      this.cooldown -= delta;
      // The jet flies anytime; the balloon flies in fair weather, day & dusk.
      const weatherOk = this.cyber || (night < 0.8 && cloudCover < 0.4);
      if (this.cooldown <= 0 && weatherOk) {
        this.flying = true;
        this.z = (Math.random() - 0.5) * 90;
        this.bobPhase = Math.random() * Math.PI * 2;
        this.group.position.set(-EDGE, this.cyber ? CRUISE_Y - 6 : ENTRY_Y, this.z);
        this.group.visible = true;
      }
      return;
    }

    const speed = this.cyber ? 19 : 3 + wind * 3.5;
    this.group.position.x += speed * delta;
    const progress = (this.group.position.x + EDGE) / (2 * EDGE);

    if (this.cyber) {
      // Fast, flat pass with a slight bank.
      this.group.position.y = CRUISE_Y - 6 + Math.sin(elapsed * 0.9 + this.bobPhase) * 1.2;
      this.group.position.z = this.z + Math.sin(elapsed * 0.5 + this.bobPhase) * 8;
      this.group.rotation.z = Math.sin(elapsed * 0.5 + this.bobPhase) * 0.12;
      this.engineMaterial.emissiveIntensity = 2 + Math.sin(elapsed * 26) * 0.7;
    } else {
      // Graceful profile: climb in, cruise, descend out.
      const lift = smoothstep(0, 0.22, progress) * (1 - smoothstep(0.78, 1, progress));
      this.group.position.y =
        ENTRY_Y + (CRUISE_Y - ENTRY_Y) * lift + Math.sin(elapsed * 0.35 + this.bobPhase) * 2;
      this.group.position.z = this.z + Math.sin(elapsed * 0.2 + this.bobPhase) * 5;
      this.group.rotation.y = elapsed * 0.06;

      // Burner: periodic roar — at dusk it beautifully lights the envelope.
      const burst = Math.sin(elapsed * 0.7 + this.bobPhase) > 0.45;
      const flicker = burst ? 1 + Math.sin(elapsed * 30) * 0.3 : 0;
      this.burnerMaterial.emissiveIntensity = 0.35 + flicker * 2.2;
      this.burnerLight.intensity = flicker * (8 + night * 90);
      this.envelopeMaterial.emissive.setHex(0xff5a20);
      this.envelopeMaterial.emissiveIntensity = flicker * (0.04 + night * 0.5);

      this.arm.rotation.z = -2.4 + Math.sin(elapsed * 5) * 0.35;
    }

    if (this.group.position.x > EDGE) {
      this.flying = false;
      this.group.visible = false;
      this.cooldown = 50 + Math.random() * 100;
    }
  }

  dispose(): void {
    this.scene.remove(this.group);
    for (const d of this.disposables) d.dispose();
  }
}
