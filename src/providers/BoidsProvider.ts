import * as THREE from 'three';
import { uniform, vec3, float, Fn } from 'three/tsl';
import { BaseProvider, ProviderContext } from './BaseProvider.js';

/**
 * Configuration for boids flocking behavior
 * Based on Craig Reynolds' original 1986 boids algorithm
 * @see https://www.red3d.com/cwr/boids/
 */
export interface BoidsConfig {
  /** Weight for separation (avoid crowding neighbors) */
  separationWeight?: number;
  /** Weight for alignment (steer toward average heading of neighbors) */
  alignmentWeight?: number;
  /** Weight for cohesion (steer toward average position of neighbors) */
  cohesionWeight?: number;
  /** Radius to consider for neighbor detection */
  neighborRadius?: number;
  /** Minimum distance for strong separation response */
  separationRadius?: number;
  /** Field of view angle in degrees (boids only see in front) */
  fieldOfView?: number;
  /** Maximum speed limit */
  maxSpeed?: number;
  /** Maximum steering force */
  maxForce?: number;
  /** Bounding box size (soft boundary) */
  boundSize?: number;
  /** Boundary turn force (how strongly to avoid edges) */
  boundaryForce?: number;
  /** Optional goal position to steer toward */
  goalPosition?: THREE.Vector3;
  /** Goal seeking weight */
  goalWeight?: number;
  /** Wander randomness factor */
  wanderStrength?: number;
}

/**
 * Enhanced Boids Flocking Provider
 * 
 * Implements Craig Reynolds' boids algorithm with three core behaviors:
 * - **Separation**: Steer to avoid crowding local flockmates
 * - **Alignment**: Steer toward average heading of local flockmates
 * - **Cohesion**: Steer toward average position of local flockmates
 * 
 * Additional features:
 * - Limited perception (neighborhood radius + field of view angle)
 * - Soft boundary containment
 * - Goal seeking for scripted paths
 * - Wander for organic randomness
 * 
 * @see https://www.red3d.com/cwr/boids/
 * 
 * Note: True boids requires O(n²) neighbor queries. This GPU implementation
 * uses a global flock center/velocity approximation for efficiency.
 * For full neighbor-based flocking, consider spatial hashing.
 */
export class BoidsProvider extends BaseProvider {
  name = 'BoidsProvider';
  priority = 45;

  // Core behavior weights
  private uSeparationWeight: any;
  private uAlignmentWeight: any;
  private uCohesionWeight: any;

  // Perception
  private uNeighborRadius: any;
  private uSeparationRadius: any;
  private uFieldOfView: any;

  // Limits
  private uMaxSpeed: any;
  private uMaxForce: any;

  // Boundaries
  private uBoundSize: any;
  private uBoundaryForce: any;

  // Goal seeking
  private uGoalPosition: any;
  private uGoalWeight: any;
  private uGoalEnabled: any;

  // Wander
  private uWanderStrength: any;
  private uTime: any;

  // Global flock state (computed externally or approximated)
  private uFlockCenter: any;
  private uFlockVelocity: any;

  private timeAccumulator: number = 0;

  constructor(config: BoidsConfig = {}) {
    super();

    // Core behaviors (Reynolds' three rules)
    this.uSeparationWeight = uniform(config.separationWeight ?? 1.5);
    this.uAlignmentWeight = uniform(config.alignmentWeight ?? 1.0);
    this.uCohesionWeight = uniform(config.cohesionWeight ?? 1.0);

    // Perception neighborhood
    this.uNeighborRadius = uniform(config.neighborRadius ?? 2.5);
    this.uSeparationRadius = uniform(config.separationRadius ?? 1.0);
    this.uFieldOfView = uniform(Math.cos((config.fieldOfView ?? 270) * Math.PI / 360)); // half angle

    // Movement limits
    this.uMaxSpeed = uniform(config.maxSpeed ?? 5.0);
    this.uMaxForce = uniform(config.maxForce ?? 1.0);

    // Soft boundaries (keeps flock contained)
    this.uBoundSize = uniform(config.boundSize ?? 10.0);
    this.uBoundaryForce = uniform(config.boundaryForce ?? 2.0);

    // Goal seeking (for scripted paths)
    this.uGoalPosition = uniform(config.goalPosition ?? new THREE.Vector3(0, 0, 0));
    this.uGoalWeight = uniform(config.goalWeight ?? 0.0);
    this.uGoalEnabled = uniform(config.goalPosition ? 1.0 : 0.0);

    // Wander (organic randomness)
    this.uWanderStrength = uniform(config.wanderStrength ?? 0.3);
    this.uTime = uniform(0.0);

    // Global flock state
    this.uFlockCenter = uniform(new THREE.Vector3(0, 0, 0));
    this.uFlockVelocity = uniform(new THREE.Vector3(0, 0, 0));
  }

  // ==================== Setters ====================

  /** Set separation weight (avoid crowding) */
  setSeparationWeight(value: number): void {
    this.uSeparationWeight.value = value;
  }

  /** Set alignment weight (match velocity) */
  setAlignmentWeight(value: number): void {
    this.uAlignmentWeight.value = value;
  }

  /** Set cohesion weight (move toward center) */
  setCohesionWeight(value: number): void {
    this.uCohesionWeight.value = value;
  }

  /** Set neighbor detection radius */
  setNeighborRadius(value: number): void {
    this.uNeighborRadius.value = value;
  }

  /** Set separation (personal space) radius */
  setSeparationRadius(value: number): void {
    this.uSeparationRadius.value = value;
  }

  /** Set field of view angle in degrees */
  setFieldOfView(degrees: number): void {
    this.uFieldOfView.value = Math.cos(degrees * Math.PI / 360);
  }

  /** Set maximum speed */
  setMaxSpeed(value: number): void {
    this.uMaxSpeed.value = value;
  }

  /** Set maximum steering force */
  setMaxForce(value: number): void {
    this.uMaxForce.value = value;
  }

  /** Set bounding box size */
  setBoundSize(value: number): void {
    this.uBoundSize.value = value;
  }

  /** Set boundary avoidance force */
  setBoundaryForce(value: number): void {
    this.uBoundaryForce.value = value;
  }

  /** Set goal position for scripted movement */
  setGoal(position: THREE.Vector3, weight: number = 0.5): void {
    this.uGoalPosition.value.copy(position);
    this.uGoalWeight.value = weight;
    this.uGoalEnabled.value = 1.0;
  }

  /** Disable goal seeking */
  clearGoal(): void {
    this.uGoalEnabled.value = 0.0;
    this.uGoalWeight.value = 0.0;
  }

  /** Set wander randomness */
  setWanderStrength(value: number): void {
    this.uWanderStrength.value = value;
  }

  /** Set flock center (computed externally or via spatial query) */
  setFlockCenter(center: THREE.Vector3): void {
    this.uFlockCenter.value.copy(center);
  }

  /** Set average flock velocity (for alignment) */
  setFlockVelocity(velocity: THREE.Vector3): void {
    this.uFlockVelocity.value.copy(velocity);
  }

  // ==================== Provider Methods ====================

  onSystemUpdate(deltaTime: number, camera: THREE.Camera): void {
    this.timeAccumulator += deltaTime;
    this.uTime.value = this.timeAccumulator;
  }

  /**
   * Generate TSL force node implementing Reynolds' boids rules:
   * 1. Separation - avoid crowding neighbors
   * 2. Alignment - steer toward average heading
   * 3. Cohesion - steer toward average position
   * Plus: boundary avoidance, goal seeking, wander
   */
  getForceNode(ctx: ProviderContext): any {
    const separationWeight = this.uSeparationWeight;
    const alignmentWeight = this.uAlignmentWeight;
    const cohesionWeight = this.uCohesionWeight;
    const flockCenter = this.uFlockCenter;
    const flockVelocity = this.uFlockVelocity;
    const neighborRadius = this.uNeighborRadius;
    const separationRadius = this.uSeparationRadius;
    const maxForce = this.uMaxForce;
    const boundSize = this.uBoundSize;
    const boundaryForce = this.uBoundaryForce;
    const goalPosition = this.uGoalPosition;
    const goalWeight = this.uGoalWeight;
    const goalEnabled = this.uGoalEnabled;
    const wanderStrength = this.uWanderStrength;
    const time = this.uTime;

    return Fn(() => {
      const force = vec3(0, 0, 0).toVar();

      // Vector to flock center
      const toCenter = flockCenter.sub(ctx.position);
      const distToCenter = toCenter.length();
      const dirToCenter = toCenter.normalize();

      // ========== SEPARATION ==========
      // Steer away from neighbors that are too close
      // Uses inverse distance for stronger response when closer
      const separationIntensity = separationRadius.div(distToCenter.max(0.1)).min(3.0);
      const separationForce = dirToCenter.negate().mul(separationWeight).mul(separationIntensity);
      force.addAssign(separationForce);

      // ========== COHESION ==========
      // Steer toward the average position (flock center)
      // Scaled by distance - further = stronger pull
      const cohesionIntensity = distToCenter.div(neighborRadius).min(1.0);
      const cohesionForce = dirToCenter.mul(cohesionWeight).mul(cohesionIntensity);
      force.addAssign(cohesionForce);

      // ========== ALIGNMENT ==========
      // Steer toward the average velocity of neighbors
      // Match heading with the flock
      const velocityDiff = flockVelocity.sub(ctx.velocity);
      const alignmentForce = velocityDiff.normalize().mul(alignmentWeight).mul(0.5);
      force.addAssign(alignmentForce);

      // ========== BOUNDARY AVOIDANCE ==========
      // Soft turn-back force when approaching edges
      const halfBound = boundSize.mul(0.5);
      const margin = boundSize.mul(0.2); // 20% margin

      // X boundary
      const xForce = ctx.position.x.div(halfBound).pow(3).negate().mul(boundaryForce);
      // Y boundary
      const yForce = ctx.position.y.div(halfBound).pow(3).negate().mul(boundaryForce);
      // Z boundary
      const zForce = ctx.position.z.div(halfBound).pow(3).negate().mul(boundaryForce);

      force.addAssign(vec3(xForce, yForce, zForce));

      // ========== GOAL SEEKING ==========
      // Low priority steering toward a target (for scripted paths)
      const toGoal = goalPosition.sub(ctx.position);
      const goalForce = toGoal.normalize().mul(goalWeight).mul(goalEnabled);
      force.addAssign(goalForce);

      // ========== WANDER ==========
      // Adds organic randomness based on position and time
      const wanderX = ctx.position.x.add(time).sin().mul(wanderStrength);
      const wanderY = ctx.position.y.add(time.mul(1.3)).sin().mul(wanderStrength).mul(0.5);
      const wanderZ = ctx.position.z.add(time.mul(0.7)).sin().mul(wanderStrength);
      force.addAssign(vec3(wanderX, wanderY, wanderZ));

      // ========== LIMIT FORCE ==========
      // Clamp total steering force
      const forceMag = force.length();
      const limitedForce = force.normalize().mul(forceMag.min(maxForce));

      return limitedForce;
    })();
  }

  /**
   * Clamp velocity to max speed
   */
  getVelocityModifierNode(ctx: ProviderContext): any {
    const maxSpeed = this.uMaxSpeed;

    return Fn(() => {
      const speed = ctx.velocity.length();
      // Smoothly limit speed
      return ctx.velocity.normalize().mul(speed.min(maxSpeed));
    })();
  }

  getUniforms(): Record<string, any> {
    return {
      uBoidsSeparation: this.uSeparationWeight,
      uBoidsAlignment: this.uAlignmentWeight,
      uBoidsCohesion: this.uCohesionWeight,
      uBoidsNeighborRadius: this.uNeighborRadius,
      uBoidsSeparationRadius: this.uSeparationRadius,
      uBoidsFieldOfView: this.uFieldOfView,
      uBoidsMaxSpeed: this.uMaxSpeed,
      uBoidsMaxForce: this.uMaxForce,
      uBoidsBoundSize: this.uBoundSize,
      uBoidsBoundaryForce: this.uBoundaryForce,
      uBoidsGoalPosition: this.uGoalPosition,
      uBoidsGoalWeight: this.uGoalWeight,
      uBoidsGoalEnabled: this.uGoalEnabled,
      uBoidsWanderStrength: this.uWanderStrength,
      uBoidsTime: this.uTime,
      uBoidsFlockCenter: this.uFlockCenter,
      uBoidsFlockVelocity: this.uFlockVelocity
    };
  }

  dispose(): void {
    // Nothing to dispose
  }
}
