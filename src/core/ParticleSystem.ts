import * as THREE from 'three';
import { WebGPURenderer } from 'three/webgpu';
import { StorageManager } from './StorageManager.js';
import { IndirectRenderer } from './IndirectRenderer.js';
import { GPUSorter } from './GPUSorter.js';
import { ComputePipeline } from './ComputePipeline.js';
import { TextureAtlas } from '../features/TextureAtlas.js';
import { SoftParticles } from '../features/SoftParticles.js';
import { DepthCollisions } from '../features/DepthCollisions.js';
import { BaseProvider } from '../providers/BaseProvider.js';
import { ParticleSystemConfig, ParticleStats } from '../types/index.js';

export class ParticleSystem {
  public mesh: THREE.InstancedMesh;
  public stats: ParticleStats;
  
  private config: ParticleSystemConfig;
  private storageManager: StorageManager;
  private indirectRenderer: IndirectRenderer;
  private sorter: GPUSorter | null = null;
  private computePipeline: ComputePipeline;
  private features: Map<string, any> = new Map();
  private providers: BaseProvider[] = [];
  private scene: THREE.Scene;
  private renderer: WebGPURenderer;
  
  constructor(
    scene: THREE.Scene, 
    renderer: WebGPURenderer, 
    config: ParticleSystemConfig = {}
  ) {
    this.scene = scene;
    this.renderer = renderer;
    this.config = this.applyDefaults(config);
    
    // Initialize core systems
    this.storageManager = new StorageManager(this.config.maxParticles!);
    this.indirectRenderer = new IndirectRenderer(this.storageManager);
    this.computePipeline = new ComputePipeline(this.storageManager, this.indirectRenderer);
    
    // Initialize features
    this.initializeFeatures();
    
    // Create mesh
    this.mesh = this.createMesh();
    this.scene.add(this.mesh);
    
    // Initialize stats
    this.stats = {
      aliveParticles: 0,
      deadParticles: this.config.maxParticles!,
      culledParticles: 0,
      drawCalls: 0,
      gpuMemory: this.storageManager.getGPUMemory(),
      computeTime: 0,
      sortTime: 0
    };
  }
  
  private applyDefaults(config: ParticleSystemConfig): ParticleSystemConfig {
    return {
      maxParticles: 100000,
      emissionRate: 1000,
      billboard: true,
      sorted: true,
      frustumCulled: false,
      softParticles: false,
      ...config
    };
  }
  
  private initializeFeatures(): void {
    if (this.config.textureSheet && this.config.texture) {
      const atlas = new TextureAtlas(this.config.texture, this.config.textureSheet);
      this.features.set('textureAtlas', atlas);
      this.computePipeline.addFeature(atlas);
    }
    
    if (this.config.softParticles) {
      const soft = new SoftParticles();
      this.features.set('softParticles', soft);
    }
    
    if (this.config.collisions?.type === 'depth') {
      const collisions = new DepthCollisions(this.config.collisions);
      this.features.set('depthCollisions', collisions);
      this.computePipeline.addFeature(collisions);
    }
    
    if (this.config.sorted) {
      this.sorter = new GPUSorter(this.storageManager.maxParticles);
      this.computePipeline.addSorter(this.sorter);
    }
  }
  
  private createMesh(): THREE.InstancedMesh {
    const geometry = this.config.particleGeometry || new THREE.PlaneGeometry(1, 1);
    const material = this.createMaterial();
    
    const mesh = new THREE.InstancedMesh(
      geometry, 
      material, 
      this.storageManager.maxParticles
    );
    mesh.count = 0;
    mesh.frustumCulled = this.config.frustumCulled!;
    
    return mesh;
  }
  
  private createMaterial(): THREE.Material {
    const material = new THREE.MeshBasicMaterial({
      map: this.config.texture,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending
    });
    
    return material;
  }
  
  // Public API
  addProvider(provider: BaseProvider): void {
    this.providers.push(provider);
    this.computePipeline.addProvider(provider);
  }
  
  removeProvider(name: string): void {
    this.providers = this.providers.filter(p => p.name !== name);
    this.computePipeline.removeProvider(name);
  }
  
  burst(count: number): void {
    this.indirectRenderer.emit(count);
  }
  
  setDepthTexture(texture: THREE.Texture): void {
    const soft = this.features.get('softParticles');
    if (soft) soft.setDepthTexture(texture);
    
    const collisions = this.features.get('depthCollisions');
    if (collisions) collisions.setDepthTexture(texture);
  }
  
  update(deltaTime: number, camera: THREE.Camera): void {
    const startTime = performance.now();
    
    // Update providers
    this.providers.forEach(p => p.onSystemUpdate?.(deltaTime, camera));
    
    // Execute compute pipeline
    this.computePipeline.execute(this.renderer, deltaTime, camera);
    
    // Update indirect renderer
    this.indirectRenderer.update();
    
    // Update stats
    this.stats.aliveParticles = this.indirectRenderer.getAliveCount();
    this.stats.deadParticles = this.storageManager.maxParticles - this.stats.aliveParticles;
    this.stats.computeTime = performance.now() - startTime;
  }
  
  dispose(): void {
    this.scene.remove(this.mesh);
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    this.storageManager.dispose();
    this.indirectRenderer.dispose();
    this.computePipeline.dispose();
    this.features.forEach(feature => feature.dispose?.());
    this.providers.forEach(provider => provider.dispose?.());
  }
}