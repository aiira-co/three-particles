import * as THREE from 'three';
import { WebGPURenderer, Node } from 'three/webgpu';
import { Fn, instanceIndex, storage, float, If, hash } from 'three/tsl';
import { StorageManager } from './StorageManager';

/**
 * Handles particle spawning and lifecycle management.
 * Manages the alive/dead particle pool using a ring buffer approach.
 */
export class IndirectRenderer {
  private storage: StorageManager;
  private aliveCount: number = 0;
  private emitQueue: number = 0;
  private emissionAccumulator: number = 0;
  
  // Spawn configuration
  private spawnPosition = new THREE.Vector3(0, 0, 0);
  private spawnVelocity = new THREE.Vector3(0, 1, 0);
  private spawnVelocityVariation = new THREE.Vector3(0.5, 0.5, 0.5);
  private spawnLifetime = 2.0;
  private spawnLifetimeVariation = 0.5;
  
  // Ring buffer tracking
  private nextSpawnIndex: number = 0;
  
  constructor(storage: StorageManager) {
    this.storage = storage;
  }
  
  /**
   * Queue particles to be emitted
   */
  emit(count: number): void {
    this.emitQueue += Math.min(count, this.storage.maxParticles - this.aliveCount);
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
  }): void {
    if (config.position) this.spawnPosition.copy(config.position);
    if (config.velocity) this.spawnVelocity.copy(config.velocity);
    if (config.velocityVariation) this.spawnVelocityVariation.copy(config.velocityVariation);
    if (config.lifetime !== undefined) this.spawnLifetime = config.lifetime;
    if (config.lifetimeVariation !== undefined) this.spawnLifetimeVariation = config.lifetimeVariation;
  }
  
  /**
   * Process queued emissions and update alive count
   */
  update(): void {
    // Spawn queued particles
    while (this.emitQueue > 0 && this.aliveCount < this.storage.maxParticles) {
      this.spawnParticle(this.nextSpawnIndex);
      this.nextSpawnIndex = (this.nextSpawnIndex + 1) % this.storage.maxParticles;
      this.aliveCount++;
      this.emitQueue--;
    }
    
    // Count alive particles by checking ages vs lifetimes
    this.updateAliveCount();
  }
  
  /**
   * Spawn a single particle at the given index (CPU-side for initial spawn)
   */
  private spawnParticle(index: number): void {
    // Random variation
    const rand1 = Math.random() * 2 - 1;
    const rand2 = Math.random() * 2 - 1;
    const rand3 = Math.random() * 2 - 1;
    const rand4 = Math.random() * 2 - 1;
    
    // Position
    this.storage.positions.setXYZ(
      index,
      this.spawnPosition.x,
      this.spawnPosition.y,
      this.spawnPosition.z
    );
    
    // Velocity with variation
    this.storage.velocities.setXYZ(
      index,
      this.spawnVelocity.x + rand1 * this.spawnVelocityVariation.x,
      this.spawnVelocity.y + rand2 * this.spawnVelocityVariation.y,
      this.spawnVelocity.z + rand3 * this.spawnVelocityVariation.z
    );
    
    // Age (start at 0)
    this.storage.ages.setX(index, 0);
    
    // Lifetime with variation
    const lifetime = this.spawnLifetime + rand4 * this.spawnLifetimeVariation;
    this.storage.lifetimes.setX(index, Math.max(0.1, lifetime));
    
    // Mark buffers as needing upload
    this.storage.positions.needsUpdate = true;
    this.storage.velocities.needsUpdate = true;
    this.storage.ages.needsUpdate = true;
    this.storage.lifetimes.needsUpdate = true;
  }
  
  /**
   * Update the alive count by scanning particle states
   * In a full GPU implementation, this would use an atomic counter
   */
  private updateAliveCount(): void {
    let alive = 0;
    const ages = this.storage.ages.array as Float32Array;
    const lifetimes = this.storage.lifetimes.array as Float32Array;
    
    for (let i = 0; i < this.storage.maxParticles; i++) {
      if (ages[i] < lifetimes[i]) {
        alive++;
      }
    }
    
    this.aliveCount = alive;
  }
  
  getAliveCount(): number {
    return this.aliveCount;
  }
  
  getSpawnPosition(): THREE.Vector3 {
    return this.spawnPosition;
  }
  
  dispose(): void {
    // Nothing to dispose currently
  }
}
