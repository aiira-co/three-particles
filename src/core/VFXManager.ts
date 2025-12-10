import * as THREE from 'three';
import { WebGPURenderer } from 'three/webgpu';
import { ParticleSystem } from './ParticleSystem.js';
import type { ParticleSystemConfig } from '../types/index.js';

export class VFXManager {
  private systems: Map<string, ParticleSystem> = new Map();
  private renderer: WebGPURenderer;
  private depthTexture: THREE.DepthTexture | null = null;
  private scene: THREE.Scene;
  
  private stats = {
    totalSystems: 0,
    totalParticles: 0,
    gpuMemory: 0,
    lastFrameTime: 0,
  };
  
  constructor(scene: THREE.Scene, renderer: WebGPURenderer) {
    this.scene = scene;
    this.renderer = renderer;
    
    // Create shared depth texture for soft particles
    this.createDepthTexture();
  }
  
  private createDepthTexture(): void {
    const size = this.renderer.getSize(new THREE.Vector2());
    this.depthTexture = new THREE.DepthTexture(size.width, size.height);
  }
  
  createSystem(name: string, config: ParticleSystemConfig): ParticleSystem {
    if (this.systems.has(name)) {
      throw new Error(`Particle system with name "${name}" already exists`);
    }
    
    const system = new ParticleSystem(this.scene, this.renderer, config);
    
    // Set shared depth texture
    if (this.depthTexture && (config.softParticles || config.collisions?.type === 'depth')) {
      system.setDepthTexture(this.depthTexture);
    }
    
    this.systems.set(name, system);
    this.updateStats();
    
    return system;
  }
  
  getSystem(name: string): ParticleSystem | undefined {
    return this.systems.get(name);
  }
  
  removeSystem(name: string): boolean {
    const system = this.systems.get(name);
    if (system) {
      system.dispose();
      this.systems.delete(name);
      this.updateStats();
      return true;
    }
    return false;
  }
  
  burstAll(count: number): void {
    this.systems.forEach(system => system.burst(count));
  }
  
  update(deltaTime: number, camera: THREE.Camera): void {
    const startTime = performance.now();
    
    // Update all systems
    this.systems.forEach(system => {
      system.update(deltaTime, camera);
    });
    
    // Update stats
    this.stats.lastFrameTime = performance.now() - startTime;
    this.updateStats();
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
  
  getStats(): typeof this.stats {
    return { ...this.stats };
  }
  
  dispose(): void {
    this.systems.forEach(system => system.dispose());
    this.systems.clear();
    
    if (this.depthTexture) {
      this.depthTexture.dispose();
    }
  }
}