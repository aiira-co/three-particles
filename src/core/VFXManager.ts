import * as THREE from 'three';
import { WebGPURenderer, PostProcessing } from 'three/webgpu';
import { pass } from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { GPUParticleSystem } from './GPUParticleSystem.js';
import { DepthCollisionProvider } from '../providers/DepthCollisionProvider.js';
import type { GPUParticleSystemConfig } from '../types/index.js';

/**
 * Post-processing configuration
 */
export interface PostProcessingConfig {
  /** Enable bloom effect */
  bloom?: boolean;
  /** Bloom strength (default: 0.75) */
  bloomStrength?: number;
  /** Bloom threshold (default: 0.1) */
  bloomThreshold?: number;
  /** Bloom radius (default: 0.5) */
  bloomRadius?: number;
}

/**
 * Depth collision configuration for VFXManager
 */
export interface VFXDepthCollisionConfig {
  /** Enable depth-based collision for all systems */
  enabled: boolean;
  /** Size of the collision area */
  areaSize?: number;
  /** Capture height */
  captureHeight?: number;
  /** Collision mode */
  mode?: 'respawn' | 'bounce';
  /** Respawn height */
  respawnHeight?: number;
}

/**
 * Manages multiple GPU particle systems with shared resources,
 * post-processing effects, and depth collision.
 * 
 * @example
 * ```typescript
 * const vfx = new VFXManager(scene, renderer, camera, {
 *   postProcessing: { bloom: true, bloomStrength: 1.0 },
 *   depthCollision: { enabled: true, mode: 'respawn' }
 * });
 * 
 * const fire = vfx.createSystem('fire', { colorStart: new THREE.Color(1, 0.5, 0) });
 * 
 * // In animation loop
 * vfx.update(deltaTime, camera);
 * vfx.render(); // Uses post-processing if enabled
 * ```
 */
export class VFXManager {
  private systems: Map<string, GPUParticleSystem> = new Map();
  private renderer: WebGPURenderer;
  private camera: THREE.Camera;
  private depthTexture: THREE.DepthTexture | null = null;
  private scene: THREE.Scene;

  // Post-processing
  private postProcessing: PostProcessing | null = null;
  private postProcessingEnabled: boolean = false;
  private bloomPass: any = null;

  // Depth collision
  private depthCollisionProvider: DepthCollisionProvider | null = null;
  private depthCollisionEnabled: boolean = false;

  private stats = {
    totalSystems: 0,
    totalParticles: 0,
    gpuMemory: 0,
    lastFrameTime: 0,
  };

  constructor(
    scene: THREE.Scene,
    renderer: WebGPURenderer,
    camera: THREE.Camera,
    config?: {
      postProcessing?: PostProcessingConfig;
      depthCollision?: VFXDepthCollisionConfig;
    }
  ) {
    this.scene = scene;
    this.renderer = renderer;
    this.camera = camera;

    // Create shared depth texture for soft particles
    this.createDepthTexture();

    // Setup post-processing if enabled
    if (config?.postProcessing) {
      this.setupPostProcessing(config.postProcessing);
    }

    // Setup depth collision if enabled
    if (config?.depthCollision?.enabled) {
      this.setupDepthCollision(config.depthCollision);
    }
  }

  private createDepthTexture(): void {
    const size = this.renderer.getSize(new THREE.Vector2());
    this.depthTexture = new THREE.DepthTexture(size.width, size.height);
  }

  /**
   * Setup bloom post-processing
   */
  private setupPostProcessing(config: PostProcessingConfig): void {
    if (!config.bloom) return;

    this.postProcessing = new PostProcessing(this.renderer);

    const scenePass = pass(this.scene, this.camera);
    const scenePassColor = scenePass.getTextureNode('output');

    this.bloomPass = bloom(
      scenePassColor,
      config.bloomStrength ?? 0.75,
      config.bloomThreshold ?? 0.1,
      config.bloomRadius ?? 0.5
    );

    this.postProcessing.outputNode = scenePassColor.add(this.bloomPass);
    this.postProcessingEnabled = true;
  }

  /**
   * Setup depth collision provider
   */
  private setupDepthCollision(config: VFXDepthCollisionConfig): void {
    this.depthCollisionProvider = new DepthCollisionProvider({
      areaSize: config.areaSize,
      captureHeight: config.captureHeight,
      mode: config.mode,
      respawnHeight: config.respawnHeight
    });

    this.depthCollisionProvider.setScene(this.scene);
    this.depthCollisionEnabled = true;
  }

  /**
   * Enable collision layer on a mesh for depth collision
   */
  enableCollision(mesh: THREE.Object3D): void {
    this.depthCollisionProvider?.enableCollision(mesh);
  }

  /**
   * Update bloom settings at runtime
   */
  setBloomSettings(strength: number, threshold?: number, radius?: number): void {
    if (this.bloomPass) {
      this.bloomPass.strength.value = strength;
      if (threshold !== undefined) this.bloomPass.threshold.value = threshold;
      if (radius !== undefined) this.bloomPass.radius.value = radius;
    }
  }

  /**
   * Create a named particle system.
   * @param name - Unique name for the system
   * @param config - GPUParticleSystem configuration
   * @returns The created GPUParticleSystem
   */
  createSystem(name: string, config: GPUParticleSystemConfig): GPUParticleSystem {
    if (this.systems.has(name)) {
      throw new Error(`Particle system with name "${name}" already exists`);
    }

    const system = new GPUParticleSystem(config);

    // Set shared depth texture for soft particles
    if (this.depthTexture && config.softParticles) {
      system.setDepthTexture(this.depthTexture);
    }

    // Add depth collision provider if enabled
    if (this.depthCollisionEnabled && this.depthCollisionProvider) {
      system.addProvider(this.depthCollisionProvider);
    }

    // Add to scene
    this.scene.add(system);

    this.systems.set(name, system);
    this.updateStats();

    return system;
  }

  /**
   * Get a particle system by name.
   */
  getSystem(name: string): GPUParticleSystem | undefined {
    return this.systems.get(name);
  }

  /**
   * Remove and dispose a particle system by name.
   */
  removeSystem(name: string): boolean {
    const system = this.systems.get(name);
    if (system) {
      this.scene.remove(system);
      system.dispose();
      this.systems.delete(name);
      this.updateStats();
      return true;
    }
    return false;
  }

  /**
   * Burst all systems with the given count.
   */
  burstAll(count: number): void {
    this.systems.forEach(system => system.burst(count));
  }

  /**
   * Play all systems.
   */
  playAll(): void {
    this.systems.forEach(system => system.play());
  }

  /**
   * Pause all systems.
   */
  pauseAll(): void {
    this.systems.forEach(system => system.pause());
  }

  /**
   * Stop all systems.
   */
  stopAll(): void {
    this.systems.forEach(system => system.stop());
  }

  /**
   * Update all particle systems.
   * @param deltaTime - Time since last frame in seconds
   * @param camera - Camera for sorting and culling
   */
  update(deltaTime: number, camera: THREE.Camera): void {
    const startTime = performance.now();

    // Update depth collision texture if enabled
    if (this.depthCollisionEnabled && this.depthCollisionProvider) {
      this.depthCollisionProvider.updateCollisionTexture(this.renderer);
    }

    // Update all systems
    this.systems.forEach(system => {
      system.update(this.renderer, deltaTime, camera);
    });

    // Update stats
    this.stats.lastFrameTime = performance.now() - startTime;
    this.updateStats();
  }

  /**
   * Render the scene with post-processing if enabled.
   * Call this instead of renderer.render() when using post-processing.
   */
  render(): void {
    if (this.postProcessingEnabled && this.postProcessing) {
      this.postProcessing.render();
    } else {
      this.renderer.render(this.scene, this.camera);
    }
  }

  private updateStats(): void {
    let totalParticles = 0;
    let gpuMemory = 0;

    this.systems.forEach(system => {
      totalParticles += system.stats.aliveParticles;
      gpuMemory += system.stats.gpuMemory;
    });

    this.stats.totalSystems = this.systems.size;
    this.stats.totalParticles = totalParticles;
    this.stats.gpuMemory = gpuMemory;
  }

  /**
   * Get combined stats for all systems.
   */
  getStats(): typeof this.stats {
    return { ...this.stats };
  }

  /**
   * Get the depth collision provider for direct manipulation
   */
  getDepthCollisionProvider(): DepthCollisionProvider | null {
    return this.depthCollisionProvider;
  }

  /**
   * Dispose all systems and resources.
   */
  dispose(): void {
    this.systems.forEach(system => {
      this.scene.remove(system);
      system.dispose();
    });
    this.systems.clear();

    if (this.depthTexture) {
      this.depthTexture.dispose();
    }

    if (this.depthCollisionProvider) {
      this.depthCollisionProvider.dispose();
    }
  }
}