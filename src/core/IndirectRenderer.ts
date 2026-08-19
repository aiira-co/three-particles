import * as THREE from 'three';
import { StorageManager } from './StorageManager.js';
import type { EmitterShape } from '../types/index.js';

export interface SpawnOverrides {
  position?: THREE.Vector3;
  velocity?: THREE.Vector3;
  velocityVariation?: THREE.Vector3;
  lifetime?: number;
  lifetimeVariation?: number;
  emitterShape?: EmitterShape;
  emitterSize?: THREE.Vector3;
}

interface EmissionCommand {
  count: number;
  config: SpawnOverrides;
}

interface SpawnConfigSnapshot {
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  velocityVariation: THREE.Vector3;
  lifetime: number;
  lifetimeVariation: number;
  emitterShape: EmitterShape;
  emitterSize: THREE.Vector3;
}

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
  private emitCommands: EmissionCommand[] = [];
  private spawnOverrideStack: SpawnConfigSnapshot[] = [];
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

  // Multi-style support
  private styleWeights: number[] = [1]; // Default: single style with weight 1
  private styleCumulativeWeights: number[] = [1]; // For weighted random selection

  // Ring buffer tracking
  private nextSpawnIndex: number = 0;

  // Current time for spawning (set by update)
  private currentTime: number = 0;

  // Scratch vector to avoid per-particle allocations
  private tmpSpawnPos = new THREE.Vector3();

  constructor(storage: StorageManager) {
    this.storage = storage;
  }

  /**
   * Queue particles to be emitted using default spawn config
   */
  emit(count: number): void {
    const safeCount = Math.max(0, Math.floor(count));
    this.emitQueue += safeCount;
  }

  /**
   * Queue particles to be emitted with per-command spawn overrides
   */
  emitWithConfig(count: number, config: SpawnOverrides): void {
    const safeCount = Math.max(0, Math.floor(count));
    if (safeCount <= 0) return;

    this.emitCommands.push({
      count: safeCount,
      config: {
        position: (config.position ?? this.spawnPosition).clone(),
        velocity: (config.velocity ?? this.spawnVelocity).clone(),
        velocityVariation: (config.velocityVariation ?? this.spawnVelocityVariation).clone(),
        lifetime: config.lifetime ?? this.spawnLifetime,
        lifetimeVariation: config.lifetimeVariation ?? this.spawnLifetimeVariation,
        emitterShape: config.emitterShape ?? this.emitterShape,
        emitterSize: (config.emitterSize ?? this.emitterSize).clone(),
      },
    });
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
   * Configure default spawn parameters
   */
  setSpawnConfig(config: SpawnOverrides): void {
    if (config.position) this.spawnPosition.copy(config.position);
    if (config.velocity) this.spawnVelocity.copy(config.velocity);
    if (config.velocityVariation) this.spawnVelocityVariation.copy(config.velocityVariation);
    if (config.lifetime !== undefined) this.spawnLifetime = config.lifetime;
    if (config.lifetimeVariation !== undefined) this.spawnLifetimeVariation = config.lifetimeVariation;
    if (config.emitterShape) this.emitterShape = config.emitterShape;
    if (config.emitterSize) this.emitterSize.copy(config.emitterSize);
  }

  private captureSpawnConfig(): SpawnConfigSnapshot {
    return {
      position: this.spawnPosition.clone(),
      velocity: this.spawnVelocity.clone(),
      velocityVariation: this.spawnVelocityVariation.clone(),
      lifetime: this.spawnLifetime,
      lifetimeVariation: this.spawnLifetimeVariation,
      emitterShape: this.emitterShape,
      emitterSize: this.emitterSize.clone(),
    };
  }

  private restoreSpawnConfig(snapshot: SpawnConfigSnapshot): void {
    this.spawnPosition.copy(snapshot.position);
    this.spawnVelocity.copy(snapshot.velocity);
    this.spawnVelocityVariation.copy(snapshot.velocityVariation);
    this.spawnLifetime = snapshot.lifetime;
    this.spawnLifetimeVariation = snapshot.lifetimeVariation;
    this.emitterShape = snapshot.emitterShape;
    this.emitterSize.copy(snapshot.emitterSize);
  }

  pushSpawnOverrides(overrides: SpawnOverrides = {}): () => void {
    this.spawnOverrideStack.push(this.captureSpawnConfig());
    this.setSpawnConfig(overrides);

    let restored = false;
    return () => {
      if (restored) return;
      restored = true;
      this.popSpawnOverrides();
    };
  }

  popSpawnOverrides(): void {
    const snapshot = this.spawnOverrideStack.pop();
    if (!snapshot) return;
    this.restoreSpawnConfig(snapshot);
  }

  withSpawnOverrides<T>(overrides: SpawnOverrides, fn: () => T): T {
    const restore = this.pushSpawnOverrides(overrides);
    try {
      return fn();
    } finally {
      restore();
    }
  }

  /**
   * Set style weights for multi-style particle assignment
   * @param weights Array of weights (higher = more particles of that style)
   */
  setStyleWeights(weights: number[]): void {
    if (weights.length === 0) {
      this.styleWeights = [1];
    } else {
      this.styleWeights = weights;
    }

    // Calculate cumulative weights for efficient random selection
    let total = 0;
    this.styleCumulativeWeights = this.styleWeights.map(w => {
      total += w;
      return total;
    });
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

    // Process per-command emissions first (used by multi-emitter spawning)
    while (this.emitCommands.length > 0 && emitted < emissionLimit) {
      const command = this.emitCommands[0];

      while (command.count > 0 && emitted < emissionLimit) {
        this.spawnParticleData(this.nextSpawnIndex, command.config);

        this.nextSpawnIndex = (this.nextSpawnIndex + 1) % this.storage.maxParticles;

        // Track high water mark
        if (this.activeCount < this.storage.maxParticles) {
          this.activeCount++;
        }

        command.count--;
        emitted++;
      }

      if (command.count <= 0) {
        this.emitCommands.shift();
      }
    }

    // Spawn queued particles using default config
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

    // Discard remaining default queue if too large
    if (this.emitQueue > emissionLimit) {
      this.emitQueue = 0;
    }

    // Mark buffers for update if we spawned particles
    // We upload ALL particle data since the ages buffer now stores immutable spawn times
    // The GPU calculates age dynamically, so there's no CPU/GPU conflict
    if (emitted > 0) {
      this.storage.positions.needsUpdate = true;
      this.storage.velocities.needsUpdate = true;
      this.storage.ages.needsUpdate = true; // Now stores spawnTime
      this.storage.lifetimes.needsUpdate = true;
      this.storage.styles.needsUpdate = true; // Style indices
    }
  }

  /**
   * Calculate spawn position based on emitter shape
   */
  private getSpawnPositionForShape(config?: SpawnOverrides, out?: THREE.Vector3): THREE.Vector3 {
    const pos = out ?? new THREE.Vector3();
    pos.set(0, 0, 0);

    const shape = config?.emitterShape ?? this.emitterShape;
    const size = config?.emitterSize ?? this.emitterSize;

    switch (shape) {
      case 'sphere': {
        // Random point within sphere
        const u = Math.random();
        const v = Math.random();
        const theta = 2 * Math.PI * u;
        const phi = Math.acos(2 * v - 1);
        const r = Math.cbrt(Math.random()); // Cube root for uniform volume distribution

        pos.set(
          r * Math.sin(phi) * Math.cos(theta) * size.x,
          r * Math.sin(phi) * Math.sin(theta) * size.y,
          r * Math.cos(phi) * size.z
        );
        break;
      }

      case 'box': {
        // Random point within box
        pos.set(
          (Math.random() - 0.5) * size.x,
          (Math.random() - 0.5) * size.y,
          (Math.random() - 0.5) * size.z
        );
        break;
      }

      case 'line': {
        // Random point along Y-axis line
        pos.set(
          0,
          (Math.random() - 0.5) * size.y,
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
    const basePosition = config?.position ?? this.spawnPosition;
    pos.add(basePosition);
    return pos;
  }

  /**
   * Spawn a single particle at the given index (CPU-side for initial spawn)
   */
  private spawnParticleData(index: number, overrides: SpawnOverrides = {}): void {
    // Random variation
    const rand1 = Math.random() * 2 - 1;
    const rand2 = Math.random() * 2 - 1;
    const rand3 = Math.random() * 2 - 1;
    const rand4 = Math.random() * 2 - 1;

    // Position based on emitter shape
    const spawnPos = this.getSpawnPositionForShape(overrides, this.tmpSpawnPos);
    this.storage.positions.setXYZ(index, spawnPos.x, spawnPos.y, spawnPos.z);

    // Velocity with variation
    const baseVelocity = overrides.velocity ?? this.spawnVelocity;
    const baseVelocityVariation = overrides.velocityVariation ?? this.spawnVelocityVariation;

    this.storage.velocities.setXYZ(
      index,
      baseVelocity.x + rand1 * baseVelocityVariation.x,
      baseVelocity.y + rand2 * baseVelocityVariation.y,
      baseVelocity.z + rand3 * baseVelocityVariation.z
    );

    // Store spawn time (instead of age=0)
    // Age is calculated dynamically in shaders as: age = currentTime - spawnTime
    this.storage.ages.setX(index, this.currentTime);

    // Lifetime with variation (this is immutable per particle)
    const baseLifetime = overrides.lifetime ?? this.spawnLifetime;
    const baseLifetimeVariation = overrides.lifetimeVariation ?? this.spawnLifetimeVariation;
    const lifetime = baseLifetime + rand4 * baseLifetimeVariation;
    this.storage.lifetimes.setX(index, Math.max(0.1, lifetime));

    // Assign style index based on weights
    const styleIndex = this.pickStyleByWeight();
    this.storage.styles.setX(index, styleIndex);
  }

  /**
   * Pick a style index based on configured weights
   */
  private pickStyleByWeight(): number {
    if (this.styleCumulativeWeights.length <= 1) return 0;

    const totalWeight = this.styleCumulativeWeights[this.styleCumulativeWeights.length - 1];
    const rand = Math.random() * totalWeight;

    // Binary search would be more efficient for many styles, but linear is fine for <10
    for (let i = 0; i < this.styleCumulativeWeights.length; i++) {
      if (rand <= this.styleCumulativeWeights[i]) {
        return i;
      }
    }
    return this.styleCumulativeWeights.length - 1;
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
    this.emitCommands.length = 0;
    this.spawnOverrideStack.length = 0;
  }
}


