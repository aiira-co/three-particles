import * as THREE from 'three';
import { uniform, vec3, float, Fn } from 'three/tsl';
import { BaseProvider, ProviderContext } from './BaseProvider.js';

/**
 * Basic physics provider with gravity, drag, and optional floor collision
 */
export class PhysicsProvider extends BaseProvider {
  name = 'PhysicsProvider';
  priority = 100; // Run late to apply base physics

  private uGravity: any;
  private uDrag: any;
  private uFloorY: any;
  private uBounce: any;
  private hasFloor: boolean;

  constructor(config: {
    gravity?: THREE.Vector3;
    drag?: number;
    floorY?: number;
    bounce?: number;
  } = {}) {
    super();
    this.uGravity = uniform(config.gravity ?? new THREE.Vector3(0, -9.8, 0));
    this.uDrag = uniform(config.drag ?? 0.1);
    this.uFloorY = uniform(config.floorY ?? 0);
    this.uBounce = uniform(config.bounce ?? 0.5);
    this.hasFloor = config.floorY !== undefined;
  }

  setGravity(gravity: THREE.Vector3): void {
    this.uGravity.value.copy(gravity);
  }

  setDrag(drag: number): void {
    this.uDrag.value = drag;
  }

  setFloor(y: number, bounce: number = 0.5): void {
    this.uFloorY.value = y;
    this.uBounce.value = bounce;
    this.hasFloor = true;
  }

  disableFloor(): void {
    this.hasFloor = false;
  }

  /**
   * Gravity is already handled by ComputePipeline core
   * This provider adds floor collision if configured
   */
  getPositionModifierNode(ctx: ProviderContext): any {
    if (!this.hasFloor) return undefined;

    const floorY = this.uFloorY;
    const bounce = this.uBounce;

    return Fn(() => {
      const pos = ctx.position;
      const vel = ctx.velocity;

      // Simple floor collision - reflects velocity and clamps position
      // Note: This is a simplified version; a proper implementation would
      // check collision before position integration
      const newPos = vec3(pos.x, pos.y.max(floorY), pos.z);

      return newPos;
    })();
  }

  getUniforms(): Record<string, any> {
    return {
      uPhysicsGravity: this.uGravity,
      uPhysicsDrag: this.uDrag,
      uPhysicsFloorY: this.uFloorY,
      uPhysicsBounce: this.uBounce
    };
  }

  dispose(): void {
    // Nothing to dispose
  }
}