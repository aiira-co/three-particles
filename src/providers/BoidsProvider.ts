import * as THREE from 'three';
import { uniform, vec3, float, Fn, Loop, If } from 'three/tsl';
import { BaseProvider, ProviderContext } from './BaseProvider.js';

/**
 * Configuration for boids flocking behavior
 */
export interface BoidsConfig {
  /** Weight for separation (avoid crowding) */
  separationWeight?: number;
  /** Weight for alignment (match velocity with neighbors) */
  alignmentWeight?: number;
  /** Weight for cohesion (move toward center of flock) */
  cohesionWeight?: number;
  /** Radius to consider for neighbors */
  neighborRadius?: number;
  /** Maximum speed limit */
  maxSpeed?: number;
  /** Bounding box size (particles wrap around) */
  boundSize?: number;
}

/**
 * Boids flocking provider
 * Implements Reynolds' boids algorithm with separation, alignment, and cohesion
 * Note: Full boids requires neighbor queries which is expensive in GPU.
 * This is a simplified version using center-seeking and velocity damping.
 */
export class BoidsProvider extends BaseProvider {
  name = 'BoidsProvider';
  priority = 45;

  private uSeparationWeight: any;
  private uAlignmentWeight: any;
  private uCohesionWeight: any;
  private uNeighborRadius: any;
  private uMaxSpeed: any;
  private uBoundSize: any;
  private uFlockCenter: any;
  private uFlockVelocity: any;

  constructor(config: BoidsConfig = {}) {
    super();
    this.uSeparationWeight = uniform(config.separationWeight ?? 1.5);
    this.uAlignmentWeight = uniform(config.alignmentWeight ?? 1.0);
    this.uCohesionWeight = uniform(config.cohesionWeight ?? 1.0);
    this.uNeighborRadius = uniform(config.neighborRadius ?? 2.0);
    this.uMaxSpeed = uniform(config.maxSpeed ?? 5.0);
    this.uBoundSize = uniform(config.boundSize ?? 8.0);
    this.uFlockCenter = uniform(new THREE.Vector3(0, 0, 0));
    this.uFlockVelocity = uniform(new THREE.Vector3(0, 0, 0));
  }

  // Setters
  setSeparationWeight(value: number): void { this.uSeparationWeight.value = value; }
  setAlignmentWeight(value: number): void { this.uAlignmentWeight.value = value; }
  setCohesionWeight(value: number): void { this.uCohesionWeight.value = value; }
  setNeighborRadius(value: number): void { this.uNeighborRadius.value = value; }
  setMaxSpeed(value: number): void { this.uMaxSpeed.value = value; }
  setBoundSize(value: number): void { this.uBoundSize.value = value; }

  /**
   * Set flock center (computed externally or via spatial query)
   */
  setFlockCenter(center: THREE.Vector3): void {
    this.uFlockCenter.value.copy(center);
  }

  /**
   * Set average flock velocity (for alignment)
   */
  setFlockVelocity(velocity: THREE.Vector3): void {
    this.uFlockVelocity.value.copy(velocity);
  }

  /**
   * Simplified boids force:
   * - Cohesion: steer toward flock center
   * - Separation: repel from center if too close
   * - Alignment: match flock velocity
   */
  getForceNode(ctx: ProviderContext): any {
    const separationWeight = this.uSeparationWeight;
    const alignmentWeight = this.uAlignmentWeight;
    const cohesionWeight = this.uCohesionWeight;
    const flockCenter = this.uFlockCenter;
    const flockVelocity = this.uFlockVelocity;
    const neighborRadius = this.uNeighborRadius;

    return Fn(() => {
      const force = vec3(0, 0, 0).toVar();

      // Vector to flock center
      const toCenter = flockCenter.sub(ctx.position);
      const distance = toCenter.length();

      // Cohesion: steer toward center
      const cohesionForce = toCenter.normalize().mul(cohesionWeight).mul(float(0.5));
      force.addAssign(cohesionForce);

      // Separation: if too close to center, move away
      const separationForce = toCenter.normalize().negate()
        .mul(separationWeight)
        .mul(neighborRadius.div(distance.max(0.1)));
      force.addAssign(separationForce);

      // Alignment: match flock velocity
      const alignmentForce = flockVelocity.sub(ctx.velocity).mul(alignmentWeight).mul(float(0.1));
      force.addAssign(alignmentForce);

      return force;
    })();
  }

  /**
   * Clamp velocity to max speed and apply wrapping
   */
  getVelocityModifierNode(ctx: ProviderContext): any {
    const maxSpeed = this.uMaxSpeed;

    return Fn(() => {
      const speed = ctx.velocity.length();
      const clampedVel = ctx.velocity.normalize().mul(speed.min(maxSpeed));
      return clampedVel;
    })();
  }

  /**
   * Wrap position within bounding box
   */
  getPositionModifierNode(ctx: ProviderContext): any {
    const boundSize = this.uBoundSize;

    return Fn(() => {
      const halfBound = boundSize.div(2);
      // Wrap using modulo
      const wrappedX = ctx.position.x.add(halfBound).mod(boundSize).sub(halfBound);
      const wrappedY = ctx.position.y.add(halfBound).mod(boundSize).sub(halfBound);
      const wrappedZ = ctx.position.z.add(halfBound).mod(boundSize).sub(halfBound);
      return vec3(wrappedX, wrappedY, wrappedZ);
    })();
  }

  getUniforms(): Record<string, any> {
    return {
      uBoidsSeparation: this.uSeparationWeight,
      uBoidsAlignment: this.uAlignmentWeight,
      uBoidsCohesion: this.uCohesionWeight,
      uBoidsNeighborRadius: this.uNeighborRadius,
      uBoidsMaxSpeed: this.uMaxSpeed,
      uBoidsBoundSize: this.uBoundSize,
      uBoidsFlockCenter: this.uFlockCenter,
      uBoidsFlockVelocity: this.uFlockVelocity
    };
  }

  dispose(): void {
    // Nothing to dispose
  }
}
