import * as THREE from 'three';
import {
  vec3, vec4, float, uniform, storage as tslStorage, Fn, instanceIndex,
  positionLocal, mix, smoothstep, If
} from 'three/tsl';
import { 
  MeshBasicNodeMaterial, StorageInstancedBufferAttribute, 
  WebGPURenderer 
} from 'three/webgpu';
import { StorageManager } from './StorageManager.js';
import { IndirectRenderer } from './IndirectRenderer.js';
import { GPUSorter } from './GPUSorter.js';
import { ComputePipeline } from './ComputePipeline.js';
import { GPUParticleSystemConfig, ParticleStats } from '../types/index.js';
import { BaseProvider } from '../providers/BaseProvider.js';

export class GPUParticleSystem extends THREE.Group {
  public mesh: THREE.InstancedMesh;
  public stats: ParticleStats;
  
  private config: GPUParticleSystemConfig;
  private storageManager: StorageManager;
  private indirectRenderer: IndirectRenderer;
  private sorter: GPUSorter | null = null;
  private computePipeline: ComputePipeline;
  private providers: BaseProvider[] = [];
  
  // Uniforms
  private uTime = uniform(0);
  private uDelta = uniform(0);
  private uEmitterMatrix = uniform(new THREE.Matrix4());
  private uCameraPosition = uniform(new THREE.Vector3());
  
  // TSL Storage accessors (for shader access)
  private positionsNode: any;
  private velocitiesNode: any;
  private agesNode: any;
  private lifetimesNode: any;
  private rotationsNode: any;
  private colorsNode: any;
  
  constructor(config: GPUParticleSystemConfig = {}) {
    super();
    
    this.config = this.applyDefaults(config);
    
    // Initialize core systems
    const maxParticles = this.config.maxParticles!;
    this.storageManager = new StorageManager(maxParticles);
    this.indirectRenderer = new IndirectRenderer(this.storageManager);
    this.computePipeline = new ComputePipeline(this.storageManager, this.indirectRenderer);
    
    // Create TSL storage accessors for shader use
    this.positionsNode = tslStorage(this.storageManager.positions, 'vec3', maxParticles);
    this.velocitiesNode = tslStorage(this.storageManager.velocities, 'vec3', maxParticles);
    this.agesNode = tslStorage(this.storageManager.ages, 'float', maxParticles);
    this.lifetimesNode = tslStorage(this.storageManager.lifetimes, 'float', maxParticles);
    this.rotationsNode = tslStorage(this.storageManager.rotations, 'vec3', maxParticles);
    this.colorsNode = tslStorage(this.storageManager.colors, 'vec4', maxParticles);
    
    // Initialize optional features
    this.initializeFeatures();
    
    // Create mesh
    this.mesh = this.createMesh();
    this.add(this.mesh);
    
    // Initialize stats
    this.stats = {
      aliveParticles: 0,
      deadParticles: maxParticles,
      culledParticles: 0,
      drawCalls: 0,
      gpuMemory: this.storageManager.getGPUMemory(),
      computeTime: 0,
      sortTime: 0
    };
  }
  
  private applyDefaults(config: GPUParticleSystemConfig): GPUParticleSystemConfig {
    return {
      maxParticles: 100000,
      emissionRate: 1000,
      lifetime: 2.0,
      loop: true,
      billboard: true,
      emitterShape: 'point',
      emitterSize: new THREE.Vector3(1, 1, 1),
      velocity: new THREE.Vector3(0, 1, 0),
      velocityVariation: new THREE.Vector3(0.5, 0.5, 0.5),
      gravity: new THREE.Vector3(0, -9.8, 0),
      drag: 0.1,
      turbulence: 0,
      sizeStart: 0.1,
      sizeEnd: 0.05,
      colorStart: new THREE.Color(1, 1, 1),
      colorEnd: new THREE.Color(1, 1, 1),
      opacityStart: 1.0,
      opacityEnd: 0.0,
      sorted: false,
      softParticles: false,
      softness: 0.5,
      depthCollisions: false,
      frustumCulled: false,
      occlusionCulled: false,
      bounciness: 0.5,
      ...config
    };
  }
  
  private initializeFeatures(): void {
    // Sorting
    if (this.config.sorted) {
      this.sorter = new GPUSorter(this.storageManager.maxParticles);
      this.computePipeline.addSorter(this.sorter);
    }
    
    // Soft particles
    if (this.config.softParticles) {
      // Will be configured when setDepthTexture is called
    }
    
    // Frustum culling
    if (this.config.frustumCulled) {
      // Will be handled in compute pipeline
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
    
    mesh.count = 0; // Will be set by indirect renderer
    mesh.frustumCulled = false; // We handle culling ourselves
    
    return mesh;
  }
  
  private createMaterial(): THREE.Material {
    const material = new MeshBasicNodeMaterial();
    material.transparent = true;
    material.depthWrite = false;
    material.blending = THREE.AdditiveBlending;
    
    if (this.config.castShadows) {
      material.shadowSide = THREE.FrontSide;
    }
    
    // Build shader nodes
    material.positionNode = this.buildVertexShader();
    material.colorNode = this.buildFragmentShader();
    
    return material;
  }
  
  private buildVertexShader(): any {
    return Fn(() => {
      // Get particle data
      const index = instanceIndex;
      const pos = this.positionsNode.element(index);
      const age = this.agesNode.element(index);
      const life = this.lifetimesNode.element(index);
      const progress = age.div(life).clamp(0, 1);
      
      // Size over lifetime
      const size = mix(
        float(this.config.sizeStart!),
        float(this.config.sizeEnd!),
        smoothstep(float(0), float(1), progress)
      );
      
      if (this.config.billboard) {
        // Billboard mode
        const mvPosition = this.uEmitterMatrix.mul(vec4(pos, 1.0));
        mvPosition.xyz.addAssign(positionLocal.mul(size));
        return mvPosition;
      } else {
        // 3D mesh mode with rotation
        const rot = this.rotationsNode.element(index);
        let localPos = positionLocal;
        
        // Apply rotation (simplified - use quaternions in production)
        localPos = this.rotateVector(localPos, rot);
        
        return pos.add(localPos.mul(size));
      }
    })();
  }
  
  private buildFragmentShader(): any {
    return Fn(() => {
      const index = instanceIndex;
      const age = this.agesNode.element(index);
      const life = this.lifetimesNode.element(index);
      const progress = age.div(life).clamp(0, 1);
      
      // Color over lifetime
      const ease = smoothstep(float(0), float(1), progress);
      const color = mix(
        vec3(this.config.colorStart!.r, this.config.colorStart!.g, this.config.colorStart!.b),
        vec3(this.config.colorEnd!.r, this.config.colorEnd!.g, this.config.colorEnd!.b),
        ease
      );
      
      // Opacity over lifetime
      const opacity = mix(
        float(this.config.opacityStart!),
        float(this.config.opacityEnd!),
        ease
      );
      
      // Fade in/out for smoother appearance
      const fadeIn = smoothstep(float(0), float(0.1), progress);
      const fadeOut = smoothstep(float(1), float(0.9), progress);
      const fade = fadeIn.mul(fadeOut);
      
      const finalColor = vec4(color, opacity.mul(fade));
      
      // Texture sampling
      if (this.config.texture) {
        // Texture atlas support would go here
        // const texColor = texture(this.config.texture, uv());
        // finalColor = vec4(finalColor.rgb.mul(texColor.rgb), finalColor.a.mul(texColor.a));
      }
      
      return finalColor;
    })();
  }
  
  private rotateVector(v: any, euler: any): any {
    // Simplified rotation - use proper quaternion math in production
    return v;
  }
  
  // -------------------------------------------------------
  // Public API
  // -------------------------------------------------------
  
  /**
   * Update the particle system
   * @param renderer - WebGPU renderer
   * @param deltaTime - Time since last frame in seconds
   * @param camera - Camera for sorting and culling
   */
  update(renderer: WebGPURenderer, deltaTime: number, camera: THREE.Camera): void {
    const startTime = performance.now();
    
    // Update uniforms
    this.uTime.value += deltaTime;
    this.uDelta.value = deltaTime;
    this.updateWorldMatrix(true, false);
    this.uEmitterMatrix.value.copy(this.matrixWorld);
    camera.getWorldPosition(this.uCameraPosition.value);
    
    // Update providers
    this.providers.forEach(provider => {
      provider.onSystemUpdate?.(deltaTime, camera);
    });
    
    // Execute compute pipeline
    this.computePipeline.execute(renderer, deltaTime, camera, this.uTime, this.uDelta);
    
    // Update indirect renderer
    this.indirectRenderer.update();
    
    // Update stats
    this.stats.aliveParticles = this.indirectRenderer.getAliveCount();
    this.stats.deadParticles = this.storageManager.maxParticles - this.stats.aliveParticles;
    this.stats.computeTime = performance.now() - startTime;
  }
  
  /**
   * Emit a burst of particles
   */
  burst(count: number): void {
    this.indirectRenderer.emit(count);
  }
  
  /**
   * Set emission rate (particles per second)
   */
  setEmissionRate(rate: number): void {
    this.config.emissionRate = rate;
  }
  
  /**
   * Add a behavior provider
   */
  addProvider(provider: BaseProvider): void {
    this.providers.push(provider);
    this.computePipeline.addProvider(provider);
  }
  
  /**
   * Remove a provider by name
   */
  removeProvider(name: string): void {
    this.providers = this.providers.filter(p => p.name !== name);
    this.computePipeline.removeProvider(name);
  }
  
  /**
   * Get a provider by name
   */
  getProvider<T extends BaseProvider>(name: string): T | undefined {
    return this.providers.find(p => p.name === name) as T;
  }
  
  /**
   * Set depth texture for soft particles and depth collisions
   */
  setDepthTexture(texture: THREE.Texture): void {
    // Pass to features that need it
    this.computePipeline.setDepthTexture(texture);
  }
  
  /**
   * Play the particle system
   */
  play(): void {
    // Resume emission
  }
  
  /**
   * Pause the particle system
   */
  pause(): void {
    // Stop emission
  }
  
  /**
   * Stop and reset the particle system
   */
  stop(): void {
    // Kill all particles and reset
  }
  
  /**
   * Dispose of all resources
   */
  dispose(): void {
    this.remove(this.mesh);
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    
    this.storageManager.dispose();
    this.indirectRenderer.dispose();
    this.computePipeline.dispose();
    this.sorter?.dispose();
    
    this.providers.forEach(provider => provider.dispose?.());
  }
}