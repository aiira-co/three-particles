import * as THREE from 'three';
import { uniform, vec3, float, Fn } from 'three/tsl';
import { BaseProvider, ProviderContext } from './BaseProvider.js';

/**
 * Vortex provider that creates a swirling force field
 * Particles are pulled toward a center while spinning around an axis
 */
export class VortexProvider extends BaseProvider {
  name = 'VortexProvider';
  priority = 45;

  private uCenter: any;
  private uAxis: any;
  private uStrength: any;
  private uPullStrength: any;
  private uRadius: any;

  constructor(config: {
    center?: THREE.Vector3;
    axis?: THREE.Vector3;
    strength?: number;
    pullStrength?: number;
    radius?: number;
  } = {}) {
    super();
    this.uCenter = uniform(config.center ?? new THREE.Vector3(0, 0, 0));
    this.uAxis = uniform((config.axis ?? new THREE.Vector3(0, 1, 0)).normalize());
    this.uStrength = uniform(config.strength ?? 1.0);
    this.uPullStrength = uniform(config.pullStrength ?? 0.5);
    this.uRadius = uniform(config.radius ?? 5.0);
  }

  setCenter(center: THREE.Vector3): void {
    this.uCenter.value.copy(center);
  }

  setAxis(axis: THREE.Vector3): void {
    this.uAxis.value.copy(axis).normalize();
  }

  setStrength(strength: number): void {
    this.uStrength.value = strength;
  }

  setPullStrength(pullStrength: number): void {
    this.uPullStrength.value = pullStrength;
  }

  setRadius(radius: number): void {
    this.uRadius.value = radius;
  }

  getForceNode(ctx: ProviderContext): any {
    const center = this.uCenter;
    const axis = this.uAxis;
    const strength = this.uStrength;
    const pullStrength = this.uPullStrength;
    const radius = this.uRadius;

    return Fn(() => {
      // Vector from particle to center
      const toCenter = center.sub(ctx.position);
      const distance = toCenter.length();

      // Falloff based on radius
      const falloff = float(1.0).sub(distance.div(radius)).max(0);

      // Pull force toward center
      const pullForce = toCenter.normalize().mul(pullStrength).mul(falloff);

      // Spinning force (cross product of axis and toCenter)
      const spinForce = axis.cross(toCenter).normalize().mul(strength).mul(falloff);

      return pullForce.add(spinForce);
    })();
  }

  getUniforms(): Record<string, any> {
    return {
      uVortexCenter: this.uCenter,
      uVortexAxis: this.uAxis,
      uVortexStrength: this.uStrength,
      uVortexPullStrength: this.uPullStrength,
      uVortexRadius: this.uRadius
    };
  }

  dispose(): void {
    // Nothing to dispose
  }
}
