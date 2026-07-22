import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { CameraDirector } from './CameraDirector';

function setup() {
  const element = new EventTarget() as HTMLElement;
  const position = new THREE.Vector3(4, 5, 6);
  const target = new THREE.Vector3(1, 2, 3);
  const controls = {
    enabled: true,
    setLookAt: vi.fn(),
    getPosition: vi.fn((out: THREE.Vector3) => out.copy(position)),
    getTarget: vi.fn((out: THREE.Vector3) => out.copy(target)),
    stop: vi.fn(),
  };
  const onInterrupt = vi.fn();
  const director = new CameraDirector({
    controls: controls as never,
    inputElement: element,
    onInterrupt,
    onModeChange: vi.fn(),
  });
  return { director, controls, element, onInterrupt };
}

function trustedEvent(type: string): Event {
  const event = new Event(type);
  Object.defineProperty(event, 'isTrusted', { value: true });
  return event;
}

describe('CameraDirector', () => {
  it.each(['pointerdown', 'wheel'])('interrupts automation synchronously on %s', (type) => {
    const { director, controls, element, onInterrupt } = setup();
    director.toggleVehicleMode('train');
    element.dispatchEvent(trustedEvent(type));

    expect(director.getMode()).toBe('free');
    expect(director.getAutomation()).toBeNull();
    expect(controls.enabled).toBe(true);
    expect(controls.stop).toHaveBeenCalledTimes(1);
    expect(onInterrupt).toHaveBeenCalledWith('train');
  });

  it('is idempotent after the user takes control', () => {
    const { director, controls } = setup();
    director.toggleVehicleMode('bus');
    director.interrupt('user-input');
    director.interrupt('user-input');
    expect(controls.stop).toHaveBeenCalledTimes(1);
  });

  it('captures the current pose before stopping a transition', () => {
    const { director, controls } = setup();
    director.frameAbsolute(new THREE.Vector3(20, 20, 20), new THREE.Vector3(), true, 'eclipse');
    director.interrupt('user-input');
    expect(controls.getPosition.mock.invocationCallOrder[0]).toBeLessThan(
      controls.stop.mock.invocationCallOrder[0]
    );
    expect(controls.getTarget.mock.invocationCallOrder[0]).toBeLessThan(
      controls.stop.mock.invocationCallOrder[0]
    );
  });
});
