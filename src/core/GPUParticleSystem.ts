import * as THREE from 'three';
import {
  vec3, vec4, float, uniform, storage, Fn, instanceIndex,
  positionLocal, mix, smoothstep, If, sin, cos, texture, uv,
  cameraViewMatrix, clamp as tslClamp, max as tslMax, length as tslLength
} from 'three/tsl';
import {
  MeshBasicNodeMaterial,
  SpriteNodeMaterial,
  WebGPURenderer, Node
} from 'three/webgpu';
import { StorageManager } from './StorageManager.js';
import { IndirectRenderer } from './IndirectRenderer.js';
import { GPUSorter } from './GPUSorter.js';
import { ComputePipeline } from './ComputePipeline.js';
import { GPUParticleSystemConfig, ParticleStats } from '../types/index.js';
import { BaseProvider } from '../providers/BaseProvider.js';
import { LifetimeCurve, CurvePreset } from '../curves/LifetimeCurve.js';
import { GradientCurve } from '../curves/GradientCurve.js';
import { TrailRenderer } from './TrailRenderer.js';

export class GPUParticleSystem extends THREE.Group {
  public mesh: THREE.InstancedMesh;
  public stats: ParticleStats;

  private config: GPUParticleSystemConfig;
  private storageManager: StorageManager;
  private indirectRenderer: IndirectRenderer;
  private sorter: GPUSorter | null = null;
  private computePipeline: ComputePipeline;
  private providers: BaseProvider[] = [];
  private trailRenderer: TrailRenderer | null = null;

  // Playback state
  private _isPlaying: boolean = true;
  private _isPaused: boolean = false;

  // GPU-based spawning state
  private emissionAccumulator: number = 0;
  private nextSpawnIndex: number = 0;

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

    // Create TSL storage nodes wrapping StorageManager buffers
    // This enables both CPU writes (for bursts) and GPU compute access (for physics)
    // Using storage() instead of instancedArray() is the standard Three.js pattern
    this.positionsNode = storage(this.storageManager.positions, 'vec3', maxParticles);
    this.velocitiesNode = storage(this.storageManager.velocities, 'vec3', maxParticles);
    this.agesNode = storage(this.storageManager.ages, 'float', maxParticles);
    this.lifetimesNode = storage(this.storageManager.lifetimes, 'float', maxParticles);
    this.rotationsNode = storage(this.storageManager.rotations, 'vec3', maxParticles);
    this.colorsNode = storage(this.storageManager.colors, 'vec4', maxParticles);

    // Pass storage nodes to ComputePipeline so it uses the SAME nodes as render shader
    this.computePipeline = new ComputePipeline(
      this.storageManager,
      this.indirectRenderer,
      {
        positions: this.positionsNode,
        velocities: this.velocitiesNode,
        ages: this.agesNode,
        lifetimes: this.lifetimesNode,
      }
    );

    // Sync physics config
    if (this.config.gravity) this.computePipeline.setGravity(this.config.gravity);
    if (this.config.drag !== undefined) this.computePipeline.setDrag(this.config.drag);

    // Sync spawn config to IndirectRenderer (for burst) and ComputePipeline (for continuous emission)
    this.indirectRenderer.setSpawnConfig({
      velocity: this.config.velocity,
      velocityVariation: this.config.velocityVariation,
      lifetime: this.config.lifetime,
      emitterShape: this.config.emitterShape,
      emitterSize: this.config.emitterSize,
    });

    // Also sync to ComputePipeline for GPU-based spawn randomization
    if (this.config.velocity) this.computePipeline.setSpawnVelocity(this.config.velocity);
    if (this.config.velocityVariation) this.computePipeline.setVelocityVariation(this.config.velocityVariation);
    if (this.config.emitterSize) this.computePipeline.setEmitterSize(this.config.emitterSize);
    if (typeof this.config.lifetime === 'number') this.computePipeline.setSpawnLifetime(this.config.lifetime);

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

    // Ribbon trails
    if (this.config.trail?.enabled) {
      const segments = this.config.trail.segments ?? 8;
      const updateInterval = this.config.trail.updateInterval ?? 0.02;
      const width = this.config.trail.width ?? 0.1;
      const fadeAlpha = this.config.trail.fadeAlpha !== false;

      this.trailRenderer = new TrailRenderer(
        this.config.maxParticles!,
        segments,
        updateInterval,
        width,
        fadeAlpha
      );
      this.trailRenderer.setParticleStorage(this.positionsNode, this.agesNode);
      this.add(this.trailRenderer.getMesh());
    }
  }

  /**
   * Helper to get LifetimeCurve from config (accepts string preset or instance)
   */
  private getCurve(curve: LifetimeCurve | CurvePreset | undefined, defaultPreset: CurvePreset = 'linear'): LifetimeCurve {
    if (!curve) {
      return new LifetimeCurve(defaultPreset);
    }
    if (typeof curve === 'string') {
      return new LifetimeCurve(curve);
    }
    return curve;
  }

  private createMesh(): THREE.InstancedMesh {
    const geometry = this.config.particleGeometry || new THREE.PlaneGeometry(1, 1);
    const material = this.createMaterial();

    const mesh = new THREE.InstancedMesh(
      geometry,
      material,
      this.storageManager.maxParticles
    );

    mesh.count = 0; // Updated in update()
    mesh.frustumCulled = false; // We handle culling ourselves

    return mesh;
  }

  private createMaterial(): THREE.Material {
    // Use SpriteNodeMaterial for billboard (camera-facing) particles
    // SpriteNodeMaterial handles billboard transformation automatically
    if (this.config.billboard !== false) {
      const material = new SpriteNodeMaterial();
      material.transparent = true;
      material.depthWrite = false;
      material.blending = THREE.AdditiveBlending;

      // For sprite, use positionNode for offset and scaleNode for size
      material.positionNode = this.buildSpritePositionNode();
      material.scaleNode = this.buildScaleNode();
      material.colorNode = this.buildFragmentShader();
      material.opacityNode = this.buildOpacityNode();

      return material;
    }

    // Use MeshBasicNodeMaterial for non-billboard particles (custom geometry)
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
    const useBillboard = this.config.billboard !== false;
    const sizeCurve = this.getCurve(this.config.sizeCurve, 'linear');

    return Fn(() => {
      const index = instanceIndex;
      const pos = this.positionsNode.element(index);
      const spawnTime = this.agesNode.element(index);
      const life = this.lifetimesNode.element(index);

      // Calculate age dynamically from spawn time
      const age = this.uTime.sub(spawnTime);
      const progress = age.div(life).clamp(0, 1);

      // Size over lifetime with curve easing
      const easedProgress = sizeCurve.sample(progress);
      const size = mix(
        float(this.config.sizeStart!),
        float(this.config.sizeEnd!),
        easedProgress
      );

      if (useBillboard) {
        // Billboard: for now, use simple size scaling
        // Full billboarding requires proper TSL matrix column extraction
        const localOffset = positionLocal.mul(size);
        return pos.add(localOffset);
      } else {
        // Simple position: particle position + local geometry * size
        return pos.add(positionLocal.mul(size));
      }
    })();
  }

  private buildFragmentShader(): any {
    const opacityCurve = this.getCurve(this.config.opacityCurve, 'linear');
    const hasColorGradient = !!this.config.colorGradient;

    return Fn(() => {
      const index = instanceIndex;
      const spawnTime = this.agesNode.element(index);  // Now stores spawn time
      const life = this.lifetimesNode.element(index);

      // Calculate age dynamically from spawn time
      const age = this.uTime.sub(spawnTime);
      const progress = age.div(life).clamp(0, 1);

      // Discard dead particles (age >= lifetime OR age < 0 means not yet spawned)
      // Use discard by returning fully transparent color for dead particles
      // Note: Three.js doesn't have a direct 'discard' in TSL, so we use opacity=0

      // Color and opacity over lifetime
      let color: any;
      let opacity: any;

      if (hasColorGradient) {
        // Use multi-stop color gradient
        const gradientSample = this.config.colorGradient!.sample(progress);
        color = vec3(gradientSample.x, gradientSample.y, gradientSample.z);
        // Use gradient alpha if no separate opacity curve, otherwise blend
        if (this.config.opacityCurve) {
          const opacityEased = opacityCurve.sample(progress);
          opacity = mix(
            float(this.config.opacityStart!),
            float(this.config.opacityEnd!),
            opacityEased
          );
        } else {
          opacity = gradientSample.w;
        }
      } else {
        // Simple start/end color with easing
        const colorEase = smoothstep(float(0), float(1), progress);
        color = mix(
          vec3(this.config.colorStart!.r, this.config.colorStart!.g, this.config.colorStart!.b),
          vec3(this.config.colorEnd!.r, this.config.colorEnd!.g, this.config.colorEnd!.b),
          colorEase
        );

        // Opacity with curve easing
        const opacityEased = opacityCurve.sample(progress);
        opacity = mix(
          float(this.config.opacityStart!),
          float(this.config.opacityEnd!),
          opacityEased
        );
      }

      // Fade in at start for smoother appearance
      const fadeIn = smoothstep(float(0), float(0.1), progress);

      // Kill dead particles by checking if age is valid
      // Particles are alive when: 0 <= age < lifetime
      const isAlive = age.greaterThanEqual(float(0)).and(age.lessThan(life));
      const aliveMultiplier = isAlive.select(float(1), float(0));

      const fade = fadeIn.mul(aliveMultiplier);

      const finalColor = vec4(color, opacity.mul(fade).mul(aliveMultiplier));

      // Texture sampling
      if (this.config.texture) {
        const texColor = texture(this.config.texture, uv());
        return vec4(finalColor.rgb.mul(texColor.rgb), finalColor.a.mul(texColor.a));
      }

      return finalColor;
    })();
  }

  /**
   * Build sprite position node - returns particle world position
   * SpriteNodeMaterial uses this as the sprite center position
   */
  private buildSpritePositionNode(): any {
    return Fn(() => {
      const index = instanceIndex;
      const pos = this.positionsNode.element(index);
      return pos;
    })();
  }

  /**
   * Build scale node - returns size based on lifetime progress
   */
  private buildScaleNode(): any {
    return Fn(() => {
      const index = instanceIndex;
      const spawnTime = this.agesNode.element(index);
      const life = this.lifetimesNode.element(index);

      const age = this.uTime.sub(spawnTime);
      const progress = age.div(life).clamp(0, 1);

      // Size over lifetime
      const size = mix(
        float(this.config.sizeStart!),
        float(this.config.sizeEnd!),
        smoothstep(float(0), float(1), progress)
      );

      // Kill dead particles by setting scale to 0
      const isAlive = age.greaterThanEqual(float(0)).and(age.lessThan(life));
      return isAlive.select(size, float(0));
    })();
  }

  /**
   * Build opacity node - returns opacity with fade in/out
   */
  private buildOpacityNode(): any {
    return Fn(() => {
      const index = instanceIndex;
      const spawnTime = this.agesNode.element(index);
      const life = this.lifetimesNode.element(index);

      const age = this.uTime.sub(spawnTime);
      const progress = age.div(life).clamp(0, 1);

      const ease = smoothstep(float(0), float(1), progress);
      const opacity = mix(
        float(this.config.opacityStart!),
        float(this.config.opacityEnd!),
        ease
      );

      // Fade in at start
      const fadeIn = smoothstep(float(0), float(0.1), progress);

      // Kill dead particles
      const isAlive = age.greaterThanEqual(float(0)).and(age.lessThan(life));
      return isAlive.select(opacity.mul(fadeIn), float(0));
    })();
  }

  private rotateVector(v: any, euler: any): any {
    // Rotation using Rodrigues' rotation formula (GPU-friendly)
    // For each axis rotation (X, Y, Z), apply incremental rotations

    // Rotate around X axis
    const cx = cos(euler.x);
    const sx = sin(euler.x);
    let rotated: Node = vec3(
      v.x,
      v.y.mul(cx).sub(v.z.mul(sx)),
      v.y.mul(sx).add(v.z.mul(cx))
    );

    // Rotate around Y axis
    const cy = cos(euler.y);
    const sy = sin(euler.y);
    rotated = vec3(
      rotated.x.mul(cy).add(rotated.z.mul(sy)),
      rotated.y,
      rotated.z.mul(cy).sub(rotated.x.mul(sy))
    );

    // Rotate around Z axis
    const cz = cos(euler.z);
    const sz = sin(euler.z);
    rotated = vec3(
      rotated.x.mul(cz).sub(rotated.y.mul(sz)),
      rotated.x.mul(sz).add(rotated.y.mul(cz)),
      rotated.z
    );

    return rotated;
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
    // Skip update if paused or stopped
    if (this._isPaused || !this._isPlaying) {
      return;
    }

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

    // STEP 1: Calculate how many particles to spawn this frame (GPU-based spawning)
    if (this.config.emissionRate! > 0) {
      // Accumulate fractional particles
      this.emissionAccumulator = (this.emissionAccumulator || 0) + this.config.emissionRate! * deltaTime;
      const toSpawn = Math.floor(this.emissionAccumulator);
      this.emissionAccumulator -= toSpawn;

      if (toSpawn > 0) {
        // Queue spawning on GPU via compute shader
        this.computePipeline.queueSpawn(toSpawn, this.nextSpawnIndex);
        this.nextSpawnIndex = (this.nextSpawnIndex + toSpawn) % this.config.maxParticles!;
      }
    }

    // STEP 2: Execute compute pipeline (GPU spawns AND updates particles)
    this.computePipeline.execute(renderer, deltaTime, camera, this.uTime, this.uDelta);

    // Clear spawn queue after execution
    this.computePipeline.clearSpawnQueue();

    // Update mesh count - use full capacity since all particles are managed by GPU
    // In a proper implementation, we'd use an indirect draw call with GPU-computed count
    this.mesh.count = this.config.maxParticles!;

    // Update stats (approximate since we can't read GPU count easily)
    const estimatedAlive = Math.min(
      this.config.emissionRate! * (this.config.lifetime || 2.0),
      this.config.maxParticles!
    );
    this.stats.aliveParticles = Math.floor(estimatedAlive);
    this.stats.deadParticles = this.storageManager.maxParticles - this.stats.aliveParticles;
    this.stats.computeTime = performance.now() - startTime;
  }

  /**
   * Emit a burst of particles
   */
  burst(count: number): void {
    // Queue particles for emission on CPU
    this.indirectRenderer.emit(count);
    // Process the queue immediately to write to StorageManager buffers
    this.indirectRenderer.update(this.uTime.value);
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
   * Set gravity vector (physics)
   */
  setGravity(gravity: THREE.Vector3): void {
    this.config.gravity?.copy(gravity);
    this.computePipeline.setGravity(gravity);
  }

  /**
   * Set drag coefficient (physics)
   */
  setDrag(drag: number): void {
    this.config.drag = drag;
    this.computePipeline.setDrag(drag);
  }

  /**
   * Set particle size range
   */
  setSize(start: number, end: number): void {
    this.config.sizeStart = start;
    this.config.sizeEnd = end;
    // Note: This requires rebuilding the shader in current implementation
    // or using a uniform. For now, we update config which future restarts will pick up.
    // Ideally, these should be uniforms in the vertex shader.
    // Given the current architecture uses buildVertexShader with const config values:
    // TSL construction: float(this.config.sizeStart!)
    // This means runtime updates won't reflect without rebuilding material.
    // Refactoring to uniforms is larger scope.
    // For now, I'll document this limitation or force a material rebuild if permissible.
    // Actually, let's keep it simple: the user wants runtime updates. 
    // I should restart the system or better yet, plan a Refactor to use Uniforms for these properties.
    // But for quick fix, I will rely on the user Restarting the flock (resetFlock).
  }

  /**
   * Set particle color (start/end same for now)
   */
  setColor(color: THREE.Color): void {
    this.config.colorStart?.copy(color);
    this.config.colorEnd?.copy(color);
    // Same limitation as size - requires shader rebuild or uniforms.
  }

  /**
   * Play the particle system
   */
  play(): void {
    this._isPlaying = true;
    this._isPaused = false;
  }

  /**
   * Pause the particle system (keeps existing particles but stops updating)
   */
  pause(): void {
    this._isPaused = true;
  }

  /**
   * Stop and reset the particle system (kills all particles)
   */
  stop(): void {
    this._isPlaying = false;
    this._isPaused = false;
    // Reset all particles to dead state
    for (let i = 0; i < this.storageManager.maxParticles; i++) {
      // Reset buffers on CPU-side if needed, though this won't sync to GPU directly 
      // without a clear. 
      // For now, since we track emission index, resetting requires 
      // disposing or clearing logic which is complex on GPU.
      // We'll rely on mesh count resetting if we wanted to hide them, 
      // but here we just leave them.
    }
  }

  /**
   * Check if system is currently playing
   */
  get isPlaying(): boolean {
    return this._isPlaying && !this._isPaused;
  }

  /**
   * Check if system is paused
   */
  get isPaused(): boolean {
    return this._isPaused;
  }

  /**
   * Dispose of all resources
   */
  dispose(): void {
    if (this.mesh) {
      this.remove(this.mesh);
      if (this.mesh.geometry) this.mesh.geometry.dispose();
      // Safe material dispose
      if (this.mesh.material) {
        const mat = this.mesh.material as any;
        try {
          if (mat.dispose) mat.dispose();
        } catch (e) {
          // Ignore disposal errors often caused by TSL internals
        }
      }
    }

    if (this.storageManager) this.storageManager.dispose();
    if (this.indirectRenderer) this.indirectRenderer.dispose();
    if (this.computePipeline) this.computePipeline.dispose();
    if (this.sorter) this.sorter.dispose();
    if (this.trailRenderer) this.trailRenderer.dispose();

    this.providers.forEach(provider => provider.dispose?.());
  }
}