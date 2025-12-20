import * as THREE from 'three';
import { StorageManager } from './StorageManager';
import type { EmitterShape } from '../types/index.js';

/**
 * Handles particle spawning and lifecycle management.
 * Manages the particle pool using a ring buffer approach.
 * 
 * NOTE: This uses "spawnTime" instead of "age" to avoid CPU/GPU buffer conflicts.
 * The ages buffer stores the time when each particle was spawned.
 * Age is calculated dynamically in shaders as: age = currentTime - spawnTime
 */
export class IndirectRenderer {
  private storage: StorageManager;
  private activeCount: number = 0; // High water mark of used particles
  private emitQueue: number = 0;
  private emissionAccumulator: number = 0;

  // Spawn configuration
  private spawnPosition = new THREE.Vector3(0, 0, 0);
  private spawnVelocity = new THREE.Vector3(0, 1, 0);
  private spawnVelocityVariation = new THREE.Vector3(0.5, 0.5, 0.5);
  private spawnLifetime = 2.0;
  private spawnLifetimeVariation = 0.5;

  // Emitter shape
  private emitterShape: EmitterShape = 'point';
  private emitterSize = new THREE.Vector3(1, 1, 1);

  // Ring buffer tracking
  private nextSpawnIndex: number = 0;

  // Current time for spawning (set by update)
  private currentTime: number = 0;

  constructor(storage: StorageManager) {
    this.storage = storage;
  }

  /**
   * Queue particles to be emitted
   */
  emit(count: number): void {
    this.emitQueue += count;
  }

  /**
   * Set continuous emission rate (particles per second)
   */
  emitRate(rate: number, deltaTime: number): void {
    this.emissionAccumulator += rate * deltaTime;
    const toEmit = Math.floor(this.emissionAccumulator);
    if (toEmit > 0) {
      this.emit(toEmit);
      this.emissionAccumulator -= toEmit;
    }
  }

  /**
   * Configure spawn parameters
   */
  setSpawnConfig(config: {
    position?: THREE.Vector3;
    velocity?: THREE.Vector3;
    velocityVariation?: THREE.Vector3;
    lifetime?: number;
    lifetimeVariation?: number;
    emitterShape?: EmitterShape;
    emitterSize?: THREE.Vector3;
  }): void {
    if (config.position) this.spawnPosition.copy(config.position);
    if (config.velocity) this.spawnVelocity.copy(config.velocity);
    if (config.velocityVariation) this.spawnVelocityVariation.copy(config.velocityVariation);
    if (config.lifetime !== undefined) this.spawnLifetime = config.lifetime;
    if (config.lifetimeVariation !== undefined) this.spawnLifetimeVariation = config.lifetimeVariation;
    if (config.emitterShape) this.emitterShape = config.emitterShape;
    if (config.emitterSize) this.emitterSize.copy(config.emitterSize);
  }

  /**
   * Process queued emissions
   * @param currentTime The current simulation time (used as spawn time for new particles)
   */
  update(currentTime: number = 0): void {
    this.currentTime = currentTime;

    // Cap emission to a reasonable amount per frame to avoid freezing
    const emissionLimit = 10000;
    let emitted = 0;

    // Spawn queued particles
    while (this.emitQueue > 0 && emitted < emissionLimit) {
      this.spawnParticleData(this.nextSpawnIndex);

      this.nextSpawnIndex = (this.nextSpawnIndex + 1) % this.storage.maxParticles;

      // Track high water mark
      if (this.activeCount < this.storage.maxParticles) {
        this.activeCount++;
      }

      this.emitQueue--;
      emitted++;
    }

    // Discard remaining queue if too large
    if (this.emitQueue > emissionLimit) {
      this.emitQueue = 0;
    }

    // Mark buffers for update if we spawned particles
    // We upload ALL particle data since the ages buffer now stores immutable spawn times
    // The GPU calculates age dynamically, so there's no CPU/GPU conflict
    if (emitted > 0) {
      this.storage.positions.needsUpdate = true;
      this.storage.velocities.needsUpdate = true;
      this.storage.ages.needsUpdate = true;      // Now stores spawnTime
      this.storage.lifetimes.needsUpdate = true;
    }
  }

  /**
   * Calculate spawn position based on emitter shape
   */
  private getSpawnPositionForShape(): THREE.Vector3 {
    const pos = new THREE.Vector3();

    switch (this.emitterShape) {
      case 'sphere': {
        // Random point within sphere
        const u = Math.random();
        const v = Math.random();
        const theta = 2 * Math.PI * u;
        const phi = Math.acos(2 * v - 1);
        const r = Math.cbrt(Math.random()); // Cube root for uniform volume distribution

        pos.set(
          r * Math.sin(phi) * Math.cos(theta) * this.emitterSize.x,
          r * Math.sin(phi) * Math.sin(theta) * this.emitterSize.y,
          r * Math.cos(phi) * this.emitterSize.z
        );
        break;
      }

      case 'box': {
        // Random point within box
        pos.set(
          (Math.random() - 0.5) * this.emitterSize.x,
          (Math.random() - 0.5) * this.emitterSize.y,
          (Math.random() - 0.5) * this.emitterSize.z
        );
        break;
      }

      case 'line': {
        // Random point along Y-axis line
        pos.set(
          0,
          (Math.random() - 0.5) * this.emitterSize.y,
          0
        );
        break;
      }

      case 'point':
      default:
        // Point emitter - no offset
        break;
    }

    // Add base spawn position
    pos.add(this.spawnPosition);
    return pos;
  }

  /**
   * Spawn a single particle at the given index (CPU-side for initial spawn)
   */
  private spawnParticleData(index: number): void {
    // Random variation
    const rand1 = Math.random() * 2 - 1;
    const rand2 = Math.random() * 2 - 1;
    const rand3 = Math.random() * 2 - 1;
    const rand4 = Math.random() * 2 - 1;

    // Position based on emitter shape
    const spawnPos = this.getSpawnPositionForShape();
    this.storage.positions.setXYZ(index, spawnPos.x, spawnPos.y, spawnPos.z);

    // Velocity with variation
    this.storage.velocities.setXYZ(
      index,
      this.spawnVelocity.x + rand1 * this.spawnVelocityVariation.x,
      this.spawnVelocity.y + rand2 * this.spawnVelocityVariation.y,
      this.spawnVelocity.z + rand3 * this.spawnVelocityVariation.z
    );

    // Store spawn time (instead of age=0)
    // Age is calculated dynamically in shaders as: age = currentTime - spawnTime
    this.storage.ages.setX(index, this.currentTime);

    // Lifetime with variation (this is immutable per particle)
    const lifetime = this.spawnLifetime + rand4 * this.spawnLifetimeVariation;
    this.storage.lifetimes.setX(index, Math.max(0.1, lifetime));
  }

  /**
   * Get number of particles to draw
   */
  getAliveCount(): number {
    return this.activeCount;
  }

  getSpawnPosition(): THREE.Vector3 {
    return this.spawnPosition;
  }

  dispose(): void {
    // Nothing to dispose currently
  }
}
