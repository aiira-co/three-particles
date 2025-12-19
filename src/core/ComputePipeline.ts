import * as THREE from 'three';
import { WebGPURenderer, ComputeNode } from 'three/webgpu';
import {
  Fn, instanceIndex, uniform, storage as tslStorage,
  vec3, float, If
} from 'three/tsl';
import { StorageManager } from './StorageManager.js';
import { IndirectRenderer } from './IndirectRenderer.js';
import { GPUSorter } from './GPUSorter.js';
import { ParticleProvider } from '../providers/BaseProvider.js';

export class ComputePipeline {
  private storageManager: StorageManager;
  private indirectRenderer: IndirectRenderer;
  private providers: ParticleProvider[] = [];
  private features: Map<string, any> = new Map();
  private sorter: GPUSorter | null = null;

  // Compute nodes (built lazily)
  private updateComputeNode: ComputeNode | null = null;
  private dirty: boolean = true;

  // Uniforms shared with material
  private uDelta = uniform(0);
  private uTime = uniform(0);
  private uGravity = uniform(new THREE.Vector3(0, -9.8, 0));
  private uDrag = uniform(0.1);

  // Storage accessors for TSL (initialized in constructor)
  private positionsStorage: any = null;
  private velocitiesStorage: any = null;
  private agesStorage: any = null;
  private lifetimesStorage: any = null;

  constructor(storageManager: StorageManager, indirectRenderer: IndirectRenderer) {
    this.storageManager = storageManager;
    this.indirectRenderer = indirectRenderer;
    this.initStorageAccessors();
  }

  private initStorageAccessors(): void {
    // Create TSL storage accessors for the buffers
    this.positionsStorage = tslStorage(this.storageManager.positions, 'vec3', this.storageManager.maxParticles);
    this.velocitiesStorage = tslStorage(this.storageManager.velocities, 'vec3', this.storageManager.maxParticles);
    this.agesStorage = tslStorage(this.storageManager.ages, 'float', this.storageManager.maxParticles);
    this.lifetimesStorage = tslStorage(this.storageManager.lifetimes, 'float', this.storageManager.maxParticles);
  }

  addFeature(feature: any): void {
    this.features.set(feature.constructor.name, feature);
    this.dirty = true;
  }

  addSorter(sorter: GPUSorter): void {
    this.sorter = sorter;
    this.dirty = true;
  }

  addProvider(provider: ParticleProvider): void {
    this.providers.push(provider);
    this.dirty = true;
  }

  removeProvider(name: string): void {
    this.providers = this.providers.filter(p => p.name !== name);
    this.dirty = true;
  }

  setDepthTexture(texture: THREE.Texture): void {
    // Pass to features that need it
    const depthCollisions = this.features.get('DepthCollisions');
    if (depthCollisions) {
      depthCollisions.setDepthTexture(texture);
    }
  }

  private buildUpdateComputeNode(): ComputeNode {
    const positions = this.positionsStorage;
    const velocities = this.velocitiesStorage;
    const ages = this.agesStorage;
    const lifetimes = this.lifetimesStorage;

    const gravity = this.uGravity;
    const drag = this.uDrag;
    const delta = this.uDelta;

    const computeFn = Fn(() => {
      const i = instanceIndex;

      // Load current particle state
      const pos = positions.element(i);
      const vel = velocities.element(i);
      const age = ages.element(i);
      const lifetime = lifetimes.element(i);

      // Check if particle is alive
      If(age.lessThan(lifetime), () => {
        // Apply gravity
        vel.addAssign(gravity.mul(delta));

        // Apply drag
        vel.mulAssign(float(1.0).sub(drag.mul(delta)));

        // Integrate position
        pos.addAssign(vel.mul(delta));

        // Age the particle
        age.addAssign(delta);
      });
    });

    return computeFn().compute(this.storageManager.maxParticles);
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

    // Rebuild compute nodes if dirty
    if (this.dirty || !this.updateComputeNode) {
      this.updateComputeNode = this.buildUpdateComputeNode();
      this.dirty = false;
    }

    // Execute the update compute shader
    renderer.computeAsync(this.updateComputeNode);

    // Handle GPU sorting if enabled
    if (this.sorter) {
      // Initialize sorter with positions if not done
      if (!this.sorterInitialized) {
        this.sorter.setPositionsStorage(this.storageManager.positions);
        this.sorterInitialized = true;
      }
      this.sorter.sort(renderer, camera.position);
    }
  }

  private sorterInitialized: boolean = false;

  getUniforms(): Record<string, any> {
    return {
      uDelta: this.uDelta,
      uTime: this.uTime,
      uGravity: this.uGravity,
      uDrag: this.uDrag
    };
  }

  setGravity(gravity: THREE.Vector3): void {
    this.uGravity.value.copy(gravity);
  }

  setDrag(drag: number): void {
    this.uDrag.value = drag;
  }

  dispose(): void {
    this.updateComputeNode = null;
    this.providers = [];
    this.features.clear();
  }
}
