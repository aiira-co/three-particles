import * as THREE from 'three';
import { WebGPURenderer, ComputeNode } from 'three/webgpu';
import {
  Fn, instanceIndex, uniform,
  vec3, vec4, float, If, hash
} from 'three/tsl';
import { StorageManager } from './StorageManager.js';
import { IndirectRenderer } from './IndirectRenderer.js';
import { GPUSorter } from './GPUSorter.js';
import { ParticleProvider, ProviderContext } from '../providers/BaseProvider.js';
import type { EmitterShape } from '../types/index.js';

/**
 * GPU Compute Pipeline for particle simulation
 * Aggregates force nodes from providers and executes physics in a single compute pass
 */
export class ComputePipeline {
  private storageManager: StorageManager;
  private indirectRenderer: IndirectRenderer;
  private providers: ParticleProvider[] = [];
  private features: Map<string, any> = new Map();
  private sorter: GPUSorter | null = null;

  // Compute nodes (built lazily)
  private updateComputeNode: ComputeNode | null = null;
  private dirty: boolean = true;

  // Core uniforms
  private uDelta = uniform(0);
  private uTime = uniform(0);
  private uGravity = uniform(new THREE.Vector3(0, -9.8, 0));
  private uDrag = uniform(0.1);

  // Storage accessors for TSL (passed from GPUParticleSystem to share with render shader)
  private positionsStorage: any = null;
  private velocitiesStorage: any = null;
  private agesStorage: any = null;
  private lifetimesStorage: any = null;

  // Spawn control uniforms
  private uSpawnCount = uniform(0);
  private uSpawnOffset = uniform(0);
  private uSpawnVelocity = uniform(new THREE.Vector3(0, 3, 0));
  private uSpawnVelocityVariation = uniform(new THREE.Vector3(0.5, 0.5, 0.5));
  private uSpawnLifetime = uniform(2.0);
  private uEmitterSize = uniform(new THREE.Vector3(1, 1, 1));
  private uEmitterShapeType = uniform(0); // 0=point, 1=box, 2=sphere, 3=line
  private uEmitterMatrix = uniform(new THREE.Matrix4());

  private sorterInitialized: boolean = false;
  private sortFrameInterval: number = 1;
  private sortFrameCounter: number = 0;
  private sortUrgentFrames: number = 0;

  private static readonly EMITTER_SHAPE_TO_TYPE: Record<EmitterShape, number> = {
    point: 0,
    box: 1,
    sphere: 2,
    line: 3,
    mesh: 0, // Mesh sampling is CPU-side only for now
  };

  constructor(
    storageManager: StorageManager,
    indirectRenderer: IndirectRenderer,
    storageNodes: {
      positions: any;
      velocities: any;
      ages: any;
      lifetimes: any;
    }
  ) {
    this.storageManager = storageManager;
    this.indirectRenderer = indirectRenderer;

    // Use the SAME storage nodes as the render shader so compute results are visible
    this.positionsStorage = storageNodes.positions;
    this.velocitiesStorage = storageNodes.velocities;
    this.agesStorage = storageNodes.ages;
    this.lifetimesStorage = storageNodes.lifetimes;
  }

  addFeature(feature: any): void {
    this.features.set(feature.constructor.name, feature);
    this.dirty = true;
  }

  addSorter(sorter: GPUSorter): void {
    this.sorter = sorter;
    this.sortFrameCounter = 0;
    this.sortUrgentFrames = 0;
    this.sortFrameInterval = this.resolveSortFrameInterval(this.storageManager.maxParticles);
    this.dirty = true;
  }

  setSortFrameInterval(interval: number | null | undefined): void {
    if (interval === null || interval === undefined || interval <= 0) {
      this.sortFrameInterval = this.resolveSortFrameInterval(this.storageManager.maxParticles);
      return;
    }

    this.sortFrameInterval = Math.max(1, Math.floor(interval));
  }

  markSortUrgent(frames: number = 2): void {
    this.sortUrgentFrames = Math.max(this.sortUrgentFrames, Math.max(0, Math.floor(frames)));
  }

  addProvider(provider: ParticleProvider): void {
    this.providers.push(provider);
    // Sort by priority (lower = earlier execution)
    this.providers.sort((a, b) => (a.priority || 0) - (b.priority || 0));
    this.dirty = true;
  }

  removeProvider(name: string): void {
    this.providers = this.providers.filter(p => p.name !== name);
    this.dirty = true;
  }

  getProvider<T extends ParticleProvider>(name: string): T | undefined {
    return this.providers.find(p => p.name === name) as T | undefined;
  }

  setDepthTexture(texture: THREE.Texture): void {
    const depthCollisions = this.features.get('DepthCollisions');
    if (depthCollisions) {
      depthCollisions.setDepthTexture(texture);
    }
  }

  setSpawnVelocity(velocity: THREE.Vector3): void {
    this.uSpawnVelocity.value.copy(velocity);
  }

  setVelocityVariation(variation: THREE.Vector3): void {
    this.uSpawnVelocityVariation.value.copy(variation);
  }

  setEmitterSize(size: THREE.Vector3): void {
    this.uEmitterSize.value.copy(size);
  }

  setEmitterShape(shape: EmitterShape): void {
    this.uEmitterShapeType.value = ComputePipeline.EMITTER_SHAPE_TO_TYPE[shape] ?? 0;
  }

  setEmitterMatrix(matrix: THREE.Matrix4): void {
    this.uEmitterMatrix.value.copy(matrix);
  }

  setSpawnLifetime(lifetime: number): void {
    this.uSpawnLifetime.value = lifetime;
  }

  /**
   * Build the main update compute node
   * This aggregates force nodes from all providers
   */
  private buildUpdateComputeNode(): ComputeNode {
    const positions = this.positionsStorage;
    const velocities = this.velocitiesStorage;
    const ages = this.agesStorage;
    const lifetimes = this.lifetimesStorage;

    const gravity = this.uGravity;
    const drag = this.uDrag;
    const delta = this.uDelta;
    const time = this.uTime;
    const spawnCount = this.uSpawnCount;
    const spawnOffset = this.uSpawnOffset;
    const spawnVelocity = this.uSpawnVelocity;
    const velocityVariation = this.uSpawnVelocityVariation;
    const spawnLifetime = this.uSpawnLifetime;
    const emitterSize = this.uEmitterSize;
    const emitterShapeType = this.uEmitterShapeType;
    const emitterMatrix = this.uEmitterMatrix;
    const maxParticles = float(this.storageManager.maxParticles);

    const computeFn = Fn(() => {
      const i = instanceIndex;

      // Load current particle state
      const pos = positions.element(i);
      const vel = velocities.element(i);
      const spawnTime = ages.element(i);
      const lifetime = lifetimes.element(i);

      // Calculate age = currentTime - spawnTime
      const age = time.sub(spawnTime);

      // Check if this particle should be SPAWNED this frame
      const indexInSpawnRange = i.sub(spawnOffset.toInt()).mod(maxParticles.toInt());
      const shouldSpawn = indexInSpawnRange.lessThan(spawnCount.toInt());

      If(shouldSpawn, () => {
        // Generate per-particle random values using hash based on index + time
        const seed = i.add(time.mul(1000).toInt());
        const randX = hash(seed).mul(2.0).sub(1.0); // [-1, 1]
        const randY = hash(seed.add(1)).mul(2.0).sub(1.0);
        const randZ = hash(seed.add(2)).mul(2.0).sub(1.0);

        // Random velocity variation
        const randVelX = hash(seed.add(3)).mul(2.0).sub(1.0);
        const randVelY = hash(seed.add(4)).mul(2.0).sub(1.0);
        const randVelZ = hash(seed.add(5)).mul(2.0).sub(1.0);

        // Spawn position in local emitter space based on emitter shape.
        const localSpawnPos = vec3(0, 0, 0).toVar();

        // BOX
        If(emitterShapeType.equal(float(1)), () => {
          localSpawnPos.assign(
            vec3(
              randX.mul(emitterSize.x),
              randY.mul(emitterSize.y),
              randZ.mul(emitterSize.z)
            )
          );
        }).Else(() => {
          // SPHERE
          If(emitterShapeType.equal(float(2)), () => {
            const randDir = vec3(randX, randY, randZ);
            const randDirLen = randDir.length().max(float(0.0001));
            const sphereRadius = hash(seed.add(6)).pow(float(0.3333333333));
            localSpawnPos.assign(
              randDir.div(randDirLen).mul(
                vec3(
                  sphereRadius.mul(emitterSize.x),
                  sphereRadius.mul(emitterSize.y),
                  sphereRadius.mul(emitterSize.z)
                )
              )
            );
          }).Else(() => {
            // LINE (Y axis)
            If(emitterShapeType.equal(float(3)), () => {
              localSpawnPos.assign(vec3(float(0), randY.mul(emitterSize.y), float(0)));
            });
          });
        });

        // Transform spawn position to world space using emitter matrix
        const worldSpawnPos = emitterMatrix.mul(vec4(localSpawnPos, float(1.0))).xyz;
        pos.assign(worldSpawnPos);

        // Velocity with variation in local emitter space
        const velVariation = vec3(
          randVelX.mul(velocityVariation.x),
          randVelY.mul(velocityVariation.y),
          randVelZ.mul(velocityVariation.z)
        );
        const localSpawnVel = spawnVelocity.add(velVariation);

        // Transform velocity by emitter orientation (w=0 to ignore translation)
        const worldSpawnVel = emitterMatrix.mul(vec4(localSpawnVel, float(0.0))).xyz;
        vel.assign(worldSpawnVel);

        spawnTime.assign(time);
        lifetime.assign(spawnLifetime);
      });

      // Check if particle is ALIVE (0 <= age < lifetime)
      const isAlive = age.greaterThanEqual(float(0)).and(age.lessThan(lifetime));

      If(isAlive, () => {
        // Create provider context for TSL node generation
        const ctx: ProviderContext = {
          position: pos,
          velocity: vel,
          age: spawnTime,
          lifetime: lifetime,
          index: i,
          delta: delta,
          time: time
        };

        // Accumulate forces from all providers
        const totalForce = vec3(0, 0, 0).toVar();

        // Built-in gravity
        totalForce.addAssign(gravity);

        // Add forces from providers
        for (const provider of this.providers) {
          if (provider.getForceNode) {
            const forceNode = provider.getForceNode(ctx);
            if (forceNode) {
              totalForce.addAssign(forceNode);
            }
          }
        }

        // Apply accumulated forces to velocity
        vel.addAssign(totalForce.mul(delta));

        // Apply velocity modifiers from providers
        for (const provider of this.providers) {
          if (provider.getVelocityModifierNode) {
            const modifierNode = provider.getVelocityModifierNode(ctx);
            if (modifierNode) {
              vel.assign(modifierNode);
            }
          }
        }

        // Built-in drag (if no velocity modifier handles it)
        vel.mulAssign(float(1.0).sub(drag.mul(delta)));

        // Integrate position
        pos.addAssign(vel.mul(delta));

        // Apply position modifiers from providers
        for (const provider of this.providers) {
          if (provider.getPositionModifierNode) {
            const modifierNode = provider.getPositionModifierNode(ctx);
            if (modifierNode) {
              pos.assign(modifierNode);
            }
          }
        }
      });
    });

    return computeFn().compute(this.storageManager.maxParticles);
  }

  /**
   * Queue particles to spawn on GPU
   */
  queueSpawn(count: number, offset: number): void {
    this.uSpawnCount.value = count;
    this.uSpawnOffset.value = offset;

    if (count > 0) {
      this.markSortUrgent(2);
    }
  }

  /**
   * Clear spawn queue after execution
   */
  clearSpawnQueue(): void {
    this.uSpawnCount.value = 0;
  }

  /**
   * Update spawn configuration
   */
  setSpawnConfig(velocity: THREE.Vector3, lifetime: number): void {
    this.uSpawnVelocity.value.copy(velocity);
    this.uSpawnLifetime.value = lifetime;
  }

  execute(
    renderer: WebGPURenderer,
    deltaTime: number,
    camera: THREE.Camera,
    uTime?: any,
    uDelta?: any
  ): void {
    // Update uniforms
    this.uDelta.value = deltaTime;
    this.uTime.value += deltaTime;

    // Update providers (CPU-side callbacks)
    for (const provider of this.providers) {
      if (provider.onSystemUpdate) {
        provider.onSystemUpdate(deltaTime, camera);
      }
    }

    // Rebuild compute nodes if dirty (providers changed)
    if (this.dirty || !this.updateComputeNode) {
      this.updateComputeNode = this.buildUpdateComputeNode();
      this.dirty = false;
    }

    // Execute the update compute shader
    renderer.computeAsync(this.updateComputeNode);

    // Handle GPU sorting if enabled
    if (this.sorter) {
      if (!this.sorterInitialized) {
        this.sorter.setPositionsStorage(this.storageManager.positions);
        this.sorterInitialized = true;
      }

      const shouldSortThisFrame =
        this.sortUrgentFrames > 0 ||
        (this.sortFrameCounter % this.sortFrameInterval) === 0;

      this.sortFrameCounter++;

      if (shouldSortThisFrame) {
        this.sorter.sort(renderer, camera.position);
      }

      if (this.sortUrgentFrames > 0) {
        this.sortUrgentFrames--;
      }
    }
  }

  getUniforms(): Record<string, any> {
    const uniforms: Record<string, any> = {
      uDelta: this.uDelta,
      uTime: this.uTime,
      uGravity: this.uGravity,
      uDrag: this.uDrag
    };

    // Collect uniforms from providers
    for (const provider of this.providers) {
      if (provider.getUniforms) {
        Object.assign(uniforms, provider.getUniforms());
      }
    }

    return uniforms;
  }

  setGravity(gravity: THREE.Vector3): void {
    this.uGravity.value.copy(gravity);
  }

  setDrag(drag: number): void {
    this.uDrag.value = drag;
  }

  private resolveSortFrameInterval(maxParticles: number): number {
    if (maxParticles >= 200000) return 4;
    if (maxParticles >= 100000) return 3;
    if (maxParticles >= 50000) return 2;
    return 1;
  }

  /**
   * Mark pipeline as dirty to force rebuild on next execute
   */
  markDirty(): void {
    this.dirty = true;
  }

  dispose(): void {
    this.updateComputeNode = null;

    // Dispose providers
    for (const provider of this.providers) {
      if (provider.dispose) {
        provider.dispose();
      }
    }
    this.providers = [];
    this.features.clear();
  }
}


