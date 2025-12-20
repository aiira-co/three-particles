import * as THREE from 'three';
import { uniform, vec3, float, Fn } from 'three/tsl';
import { BaseProvider, ProviderContext } from './BaseProvider.js';

/**
 * Mouse/touch interaction provider
 * Applies attraction or repulsion forces based on pointer position
 */
export class MouseInteractionProvider extends BaseProvider {
  name = 'MouseInteractionProvider';
  priority = 60;

  private uWorldPosition: any;
  private uStrength: any;
  private uRadius: any;
  private uAttract: any;

  private mousePosition: THREE.Vector2 = new THREE.Vector2();

  constructor(config: {
    strength?: number;
    radius?: number;
    attract?: boolean;
  } = {}) {
    super();
    this.uWorldPosition = uniform(new THREE.Vector3(0, 0, 0));
    this.uStrength = uniform(config.strength ?? 5.0);
    this.uRadius = uniform(config.radius ?? 3.0);
    this.uAttract = uniform(config.attract ? 1.0 : -1.0);
  }

  setStrength(strength: number): void {
    this.uStrength.value = strength;
  }

  setRadius(radius: number): void {
    this.uRadius.value = radius;
  }

  setAttract(attract: boolean): void {
    this.uAttract.value = attract ? 1.0 : -1.0;
  }

  setMousePosition(x: number, y: number): void {
    this.mousePosition.set(x, y);
  }

  setWorldPosition(position: THREE.Vector3): void {
    this.uWorldPosition.value.copy(position);
  }

  /**
   * Calculate attraction/repulsion force from mouse position
   */
  getForceNode(ctx: ProviderContext): any {
    const worldPos = this.uWorldPosition;
    const strength = this.uStrength;
    const radius = this.uRadius;
    const attract = this.uAttract;

    return Fn(() => {
      const toMouse = worldPos.sub(ctx.position);
      const distance = toMouse.length();

      // Falloff based on radius
      const falloff = float(1.0).sub(distance.div(radius)).max(0);

      // Direction (positive = attract, negative = repel)
      const direction = toMouse.normalize().mul(attract);

      // Force with inverse distance falloff
      return direction.mul(strength).mul(falloff);
    })();
  }

  getUniforms(): Record<string, any> {
    return {
      uMouseWorldPosition: this.uWorldPosition,
      uMouseStrength: this.uStrength,
      uMouseRadius: this.uRadius,
      uMouseAttract: this.uAttract
    };
  }

  dispose(): void {
    // Nothing to dispose
  }
}
