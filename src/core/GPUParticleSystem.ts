import * as THREE from 'three';
import {
  vec3, vec4, float, uniform, storage, Fn, instanceIndex,
  positionLocal, mix, smoothstep, If, sin, cos, texture, uv,
  cameraViewMatrix, clamp as tslClamp, max as tslMax, length as tslLength,
  normalize as tslNormalize,
  abs as tslAbs, atan as tslAtan, hash, mx_fractal_noise_float, Discard,
  viewportDepthTexture, perspectiveDepthToViewZ, positionView, cameraNear, cameraFar
} from 'three/tsl';
import {
  MeshBasicNodeMaterial,
  SpriteNodeMaterial,
  WebGPURenderer
} from 'three/webgpu';
import { StorageManager } from './StorageManager.js';
import { IndirectRenderer, type SpawnOverrides } from './IndirectRenderer.js';
import { GPUSorter } from './GPUSorter.js';
import { ComputePipeline } from './ComputePipeline.js';
import { GPUParticleSystemConfig, ParticleStats, ParticleSpawnOptions, EmitterShape, ParticleShapeMask } from '../types/index.js';
import { BaseProvider } from '../providers/BaseProvider.js';
import { LifetimeCurve, CurvePreset } from '../curves/LifetimeCurve.js';
import { GradientCurve } from '../curves/GradientCurve.js';
import { TrailRenderer } from './TrailRenderer.js';

export class GPUParticleSystem extends THREE.Group {
  public mesh: THREE.InstancedMesh;
  public stats: ParticleStats;

  /** Particle data nodes for custom materials.
   * Access these to read particle attributes in your custom TSL shaders.
   * Use instanceIndex to get data for the current particle.
   */
  public particleNodes!: {
    positions: any;
    velocities: any;
    ages: any;
    lifetimes: any;
    rotations: any;
    colors: any;
    /** Storage node for particle style index */
    styles: any;
    /** Current simulation time uniform */
    time: any;
    /** Delta time uniform */
    delta: any;
    /** Instance index for current particle */
    index: any;

    // Helper functions that return computed TSL nodes
    /** Returns lifetime progress (0-1) for current particle */
    progress: () => any;
    /** Returns speed (length of velocity) for current particle */
    speed: () => any;
    /** Returns normalized velocity direction for current particle */
    direction: () => any;
    /** Returns style index for current particle */
    styleIndex: () => any;
    /** Check if current particle matches given style index */
    isStyle: (styleIndex: number) => any;
    /** Number of defined styles */
    styleCount: number;
  };

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

  /**
   * Longest step continuous emission will integrate, in seconds.
   *
   * A backgrounded tab, a shader compile or a blocking asset decode can hand
   * `update()` a multi-second delta. Without a bound, the fractional accumulator
   * resolves to `emissionRate * delta` spawns in one frame — at the default rate
   * of 1000/s a two-second stall recycles 2000 slots at once, wiping every live
   * particle in a smaller system and spiking the frame that was already late.
   * Hosts should clamp their own frame delta too; this makes the package safe
   * standalone.
   */
  private static readonly MAX_EMISSION_STEP = 1 / 20;

  /** Fragment alpha below which a particle fragment is discarded outright. */
  private static readonly ALPHA_EPSILON = 1 / 255;

  // GPU-based spawning state
  private emissionAccumulator: number = 0;
  private nextSpawnIndex: number = 0;

  // Uniforms
  private uTime = uniform(0);
  private uDelta = uniform(0);
  private uEmitterMatrix = uniform(new THREE.Matrix4());
  private uCameraPosition = uniform(new THREE.Vector3());

  // Runtime-editable appearance uniforms
  private uColorStart = uniform(new THREE.Color(1, 1, 1));
  private uColorEnd = uniform(new THREE.Color(1, 1, 1));
  private uSizeStart = uniform(0.1);
  private uSizeEnd = uniform(0.05);
  private uOpacityStart = uniform(1.0);
  private uOpacityEnd = uniform(0.0);
  private uBillboard = uniform(1); // 1 = billboard mode, 0 = geometry mode
  /** Depth-fade distance for soft particles, in world units. */
  private uSoftness = uniform(0.5);

  // TSL Storage accessors (for shader access)
  private positionsNode: any;
  private velocitiesNode: any;
  private agesNode: any;
  private lifetimesNode: any;
  private rotationsNode: any;
  private colorsNode: any;

  // Scratch objects for world-space emitter spawning
  private readonly _tmpEmitPosition = new THREE.Vector3();
  private readonly _tmpEmitQuaternion = new THREE.Quaternion();
  private readonly _tmpEmitScale = new THREE.Vector3(1, 1, 1);
  private readonly _tmpEmitVelocity = new THREE.Vector3();
  private readonly _tmpEmitVelocityVariation = new THREE.Vector3();

  constructor(config: GPUParticleSystemConfig = {}) {
    super();

    this.config = this.applyDefaults(config);

    // Initialize appearance uniforms from config
    this.uColorStart.value.copy(this.config.colorStart!);
    this.uColorEnd.value.copy(this.config.colorEnd!);
    this.uSizeStart.value = this.config.sizeStart!;
    this.uSizeEnd.value = this.config.sizeEnd!;
    this.uOpacityStart.value = this.config.opacityStart!;
    this.uOpacityEnd.value = this.config.opacityEnd!;
    this.uBillboard.value = this.config.billboard !== false ? 1 : 0;
    this.uSoftness.value = this.config.softness ?? 0.5;

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
    const stylesNode = storage(this.storageManager.styles, 'float', maxParticles);

    // Expose particle nodes for custom materials
    const posNode = this.positionsNode;
    const velNode = this.velocitiesNode;
    const agesNode = this.agesNode;
    const lifetimesNode = this.lifetimesNode;
    const timeUniform = this.uTime;
    const styleCount = this.config.styles?.length ?? 1;

    this.particleNodes = {
      positions: posNode,
      velocities: velNode,
      ages: agesNode,
      lifetimes: lifetimesNode,
      rotations: this.rotationsNode,
      colors: this.colorsNode,
      styles: stylesNode,
      time: timeUniform,
      delta: this.uDelta,
      index: instanceIndex,

      // Helper functions that return computed TSL nodes
      progress: () => {
        const age = timeUniform.sub(agesNode.element(instanceIndex));
        const lifetime = lifetimesNode.element(instanceIndex);
        return age.div(lifetime).clamp(0, 1);
      },
      speed: () => {
        return tslLength(velNode.element(instanceIndex));
      },
      direction: () => {
        return tslNormalize(velNode.element(instanceIndex));
      },
      styleIndex: () => {
        return stylesNode.element(instanceIndex);
      },
      isStyle: (idx: number) => {
        return stylesNode.element(instanceIndex).equal(float(idx));
      },
      styleCount
    };

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
    if (this.config.emitterShape) this.computePipeline.setEmitterShape(this.config.emitterShape);
    if (this.config.emitterSize) this.computePipeline.setEmitterSize(this.config.emitterSize);
    if (typeof this.config.lifetime === 'number') this.computePipeline.setSpawnLifetime(this.config.lifetime);

    // Sync style weights for multi-style particle assignment
    if (this.config.styles && this.config.styles.length > 0) {
      const weights = this.config.styles.map(s => s.weight ?? 1);
      this.indirectRenderer.setStyleWeights(weights);
    }

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
      shape: 'square',
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
      sortFrameInterval: null,
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
      this.computePipeline.setSortFrameInterval(this.config.sortFrameInterval);
    }

    // Soft particles need nothing here: the fade samples the framebuffer's own
    // depth in the fragment shader (see buildSoftFadeNode), so there is no
    // prepass to set up and no depth texture to hand around.

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
    // Use custom material if provided
    if (this.config.material) {
      // Apply default settings to custom material
      const mat = this.config.material;
      if ('transparent' in mat) {
        (mat as any).transparent = true;
        (mat as any).depthWrite = false;
        (mat as any).blending = this.config.blending ?? THREE.AdditiveBlending;
      }
      // IMPORTANT: Inject particle transform while preserving standard local-space flow
      if (!(mat as any).positionNode) {
        (mat as any).positionNode = positionLocal.add(this.buildParticleOffsetNode());
      }
      return mat;
    }

    // Use material factory if provided
    if (this.config.materialFactory) {
      const mat = this.config.materialFactory(this.particleNodes);
      if ('transparent' in mat) {
        (mat as any).transparent = true;
        (mat as any).depthWrite = false;
        (mat as any).blending = this.config.blending ?? THREE.AdditiveBlending;
      }
      // IMPORTANT: Inject particle transform while preserving standard local-space flow
      if (!(mat as any).positionNode) {
        (mat as any).positionNode = positionLocal.add(this.buildParticleOffsetNode());
      }
      return mat;
    }

    // Always use MeshBasicNodeMaterial - billboard mode is handled via uniform in vertex shader
    const material = new MeshBasicNodeMaterial();
    material.transparent = true;
    material.depthWrite = false;
    material.blending = this.config.blending ?? THREE.AdditiveBlending;

    if (this.config.castShadows) {
      material.shadowSide = THREE.FrontSide;
    }

    // Build shader nodes
    material.positionNode = this.buildVertexShader();
    material.colorNode = this.buildFragmentShader();

    return material;
  }

  private buildParticleOffsetNode(): any {
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
      const sizeOverLife = mix(
        this.uSizeStart,
        this.uSizeEnd,
        easedProgress
      );

      // Collapse dead and not-yet-spawned particles to a zero-size point.
      //
      // The fragment stage discards them anyway, but only after the rasteriser
      // has walked every pixel of a full-size quad. Buffers spend most of their
      // life mostly dead — a 100k system emitting 1000/s over a 2s lifetime has
      // ~2k live particles and 98k corpses — so without this the overwhelming
      // majority of the fill rate is spent generating fragments that are thrown
      // away. A degenerate quad produces no fragments at all.
      const isAlive = age.greaterThanEqual(float(0)).and(age.lessThan(life));
      const size = sizeOverLife.mul(isAlive.select(float(1), float(0)));

      // For billboard mode, orient local quad axes to camera
      const viewMat: any = cameraViewMatrix;
      const right = vec3(viewMat[0][0], viewMat[1][0], viewMat[2][0]);
      const up = vec3(viewMat[0][1], viewMat[1][1], viewMat[2][1]);

      // Billboard offset: local X/Y projected to camera-facing basis
      const billboardOffset = right.mul(positionLocal.x).add(up.mul(positionLocal.y)).mul(size);

      // Geometry mode offset in local space
      const simpleOffset = positionLocal.mul(size);

      const isBillboard = this.uBillboard.greaterThan(float(0.5));
      const offset = isBillboard.select(billboardOffset, simpleOffset);

      // Final particle position from origin
      const finalPosition = pos.add(offset);

      // Return delta from original local position so callers can compose as positionLocal + delta
      return finalPosition.sub(positionLocal);
    })();
  }

  private buildVertexShader(): any {
    return positionLocal.add(this.buildParticleOffsetNode());
  }

  /**
   * Depth fade that stops a particle quad from showing a hard seam where it
   * intersects opaque geometry — smoke meeting the floor, steam against a wall.
   *
   * The reference implementations of this render a dedicated half-resolution
   * depth prepass and sample it as packed RGBA. On WebGPU none of that is
   * necessary: `viewportDepthTexture` copies the framebuffer's real depth once
   * per render call (not per draw) into a texture shared by every system that
   * asks for it, so this is full resolution, exact, and costs one copy per frame
   * no matter how many particle systems opt in.
   *
   * The comparison is done in **view space** rather than via the normalised
   * `linearDepth()` / `viewportLinearDepth` pair, because view-space Z needs no
   * assumption about the clip-depth convention or the near/far normalisation on
   * either side. Verified against a wall at known distances: the fade matches
   * `gap / softness` to within 0.003, so `softness` is a real distance in world
   * units and does not need re-tuning when the camera's near/far change.
   *
   * Perspective cameras only — an orthographic camera needs
   * `orthographicDepthToViewZ` here instead.
   *
   * Requires `depthWrite: false` on the particle material — which is already
   * the case — or particles would occlude each other in the sampled depth.
   */
  private buildSoftFadeNode(): any {
    // Both are negative in front of the camera, and the scene behind the
    // particle is the more negative of the two, so this difference is positive
    // and measured in world units.
    const sceneViewZ = perspectiveDepthToViewZ(viewportDepthTexture(), cameraNear, cameraFar);
    const gap = positionView.z.sub(sceneViewZ);
    return gap.div(tslMax(this.uSoftness, float(1e-4))).clamp(0, 1);
  }

  /**
   * Procedural fragment silhouette for `config.shape`.
   *
   * Every shape is a signed-distance-ish expression over the quad's own UVs, so
   * a soft ember, a smoke puff, a spark streak and a shockwave ring all cost a
   * handful of ALU and zero texture bandwidth — no sprite, no atlas, no filter
   * taps, and nothing to author or ship. The shape is baked into the material,
   * so each one compiles to its own program rather than branching per fragment.
   *
   * Note on `smoothstep`: GLSL and WGSL both leave `smoothstep(hi, lo, x)`
   * undefined for `hi > lo`, so every falling edge here is written as the
   * complement of a rising one instead of relying on reversed edges.
   *
   * @returns a 0..1 coverage node, or `null` for `'square'` — in which case
   *   nothing at all is added to the shader.
   */
  private buildShapeMaskNode(): any {
    const shape: ParticleShapeMask = this.config.shape ?? 'square';
    if (shape === 'square') return null;

    // Quad UV remapped to -1..1 about the centre; `d` is the radius.
    const c = uv().sub(0.5).mul(2);
    const cx = c.x;
    const cy = c.y;
    const d = tslLength(c);

    // Stable per-particle randomness, so eroded and fractured shapes do not all
    // come out identical.
    const seed = hash(instanceIndex.toFloat());

    switch (shape) {
      case 'soft':
        return smoothstep(float(0), float(1), d).oneMinus();

      case 'smoke': {
        // Fractal noise added to the radius before the falloff, scrolling in the
        // third dimension so the puff churns rather than shimmering in place.
        const n = mx_fractal_noise_float(
          vec3(c.mul(1.6), seed.mul(21).add(this.uTime.mul(0.25))),
          3
        );
        return smoothstep(float(0.05), float(1), d.add(n.mul(0.42))).oneMinus().mul(0.9);
      }

      case 'streak': {
        // Narrow across, tapered along: reads as motion even on a static quad.
        const core = smoothstep(float(0), float(1), tslAbs(cx).mul(3.4)).oneMinus();
        const along = smoothstep(float(0), float(1), tslAbs(cy)).oneMinus();
        return core.mul(along);
      }

      case 'leaf': {
        // Half-width at this height, floored so the two tips cannot collapse the
        // smoothstep edges onto each other and divide by zero.
        const w = tslMax(float(1).sub(cy.mul(cy)), float(0.02));
        const body = smoothstep(w.mul(0.30), w.mul(0.62), tslAbs(cx)).oneMinus();
        const vein = smoothstep(float(0), float(0.06), tslAbs(cx)).oneMinus().mul(0.35);
        return tslClamp(body.sub(vein.mul(0.4)), 0, 1);
      }

      case 'chip': {
        // Radius wobbled by two incommensurate harmonics of the angle — an
        // angular fragment whose facets are stable for the particle's lifetime.
        const ang = tslAtan(cy, cx);
        const r = float(0.62)
          .add(sin(ang.mul(5).add(seed.mul(30))).mul(0.24))
          .add(sin(ang.mul(9).sub(seed.mul(11))).mul(0.1));
        return smoothstep(r.sub(0.14), r, d).oneMinus();
      }

      case 'ring':
        return smoothstep(float(0), float(0.14), tslAbs(d.sub(0.82))).oneMinus();

      default:
        return null;
    }
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

      // Kill dead and not-yet-spawned particles outright.
      //
      // `Discard` is a real TSL statement (three/tsl), so there is no need to
      // fake it with a zero alpha: a zero-alpha fragment still runs the whole
      // shader and the blend, and on an additive material contributes nothing
      // while costing everything.
      const isAlive = age.greaterThanEqual(float(0)).and(age.lessThan(life));
      Discard(isAlive.not());

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
            this.uOpacityStart,
            this.uOpacityEnd,
            opacityEased
          );
        } else {
          opacity = gradientSample.w;
        }
      } else {
        // Simple start/end color with easing
        const colorEase = smoothstep(float(0), float(1), progress);
        color = mix(
          this.uColorStart.xyz,
          this.uColorEnd.xyz,
          colorEase
        );

        // Opacity with curve easing
        const opacityEased = opacityCurve.sample(progress);
        opacity = mix(
          this.uOpacityStart,
          this.uOpacityEnd,
          opacityEased
        );
      }

      // Fade in at start for smoother appearance
      const fadeIn = smoothstep(float(0), float(0.1), progress);

      let alpha: any = opacity.mul(fadeIn);

      // Procedural silhouette. Without one, an untextured particle is a hard
      // square, which is why every soft look used to require a sprite.
      const shapeMask = this.buildShapeMaskNode();
      if (shapeMask) {
        alpha = alpha.mul(shapeMask);
      }

      // Soft particles: fade out where the quad slices into opaque geometry.
      if (this.config.softParticles) {
        alpha = alpha.mul(this.buildSoftFadeNode());
      }

      let finalColor: any = vec4(color, alpha);

      // Texture sampling
      if (this.config.texture) {
        const texColor = texture(this.config.texture, uv());
        finalColor = vec4(finalColor.rgb.mul(texColor.rgb), finalColor.a.mul(texColor.a));
      }

      // Drop fragments the blend could not distinguish from nothing. On the
      // masked shapes this is most of the quad.
      Discard(finalColor.a.lessThan(float(GPUParticleSystem.ALPHA_EPSILON)));

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
        this.uSizeStart,
        this.uSizeEnd,
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
        this.uOpacityStart,
        this.uOpacityEnd,
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
    let rotated: any = vec3(
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
    this.computePipeline.setEmitterMatrix(this.uEmitterMatrix.value);
    camera.getWorldPosition(this.uCameraPosition.value);

    // Update providers
    this.providers.forEach(provider => {
      provider.onSystemUpdate?.(deltaTime, camera);
    });

    // STEP 1: Calculate how many particles to spawn this frame (GPU-based spawning)
    if (this.config.emissionRate! > 0) {
      // Accumulate fractional particles. The step is clamped so one very long
      // frame cannot resolve into a spawn burst — see MAX_EMISSION_STEP.
      const emissionStep = Math.min(deltaTime, GPUParticleSystem.MAX_EMISSION_STEP);
      this.emissionAccumulator = (this.emissionAccumulator || 0) + this.config.emissionRate! * emissionStep;
      let toSpawn = Math.floor(this.emissionAccumulator);
      this.emissionAccumulator -= toSpawn;

      const cap = this.config.maxSpawnPerFrame;
      if (cap !== undefined && toSpawn > cap) {
        toSpawn = Math.max(0, Math.floor(cap));
        // Drop the debt instead of carrying it, so a recovered hitch resumes the
        // nominal rate rather than emitting at the cap for the next N frames.
        this.emissionAccumulator = 0;
      }

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

    // STEP 3: Update trail renderer (records position history for ribbon trails)
    if (this.trailRenderer) {
      this.trailRenderer.update(renderer, deltaTime, this.uTime.value);
    }

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
    this.emit({ count });
  }

  /**
   * Emit particles with optional world-space spawn overrides.
   * Useful for multi-emitter setups sharing one particle system.
   */
  emit(options: ParticleSpawnOptions = {}): void {
    const count = Math.max(0, Math.floor(options.count ?? 20));
    if (count <= 0) return;

    const overrides = this.buildSpawnOverrides(options);
    this.indirectRenderer.withSpawnOverrides(overrides, () => {
      this.indirectRenderer.emitWithConfig(count, {});
      this.indirectRenderer.update(this.uTime.value);
    });
    this.computePipeline.markSortUrgent(2);
  }

  private buildSpawnOverrides(options: ParticleSpawnOptions): SpawnOverrides {
    const overrides: SpawnOverrides = {};

    // Resolve emitter transform from explicit matrix or system world transform
    if (options.matrix) {
      options.matrix.decompose(this._tmpEmitPosition, this._tmpEmitQuaternion, this._tmpEmitScale);
    } else {
      this.updateWorldMatrix(true, false);
      this.matrixWorld.decompose(this._tmpEmitPosition, this._tmpEmitQuaternion, this._tmpEmitScale);
    }

    overrides.position = (options.position ?? this._tmpEmitPosition).clone();

    if (options.emitterShape) {
      overrides.emitterShape = options.emitterShape;
    }

    const localSpaceEmitter = options.localSpaceEmitter !== false;
    const baseEmitterSize = options.emitterSize ?? this.config.emitterSize;
    if (baseEmitterSize) {
      this._tmpEmitVelocityVariation.copy(baseEmitterSize);
      if (localSpaceEmitter) {
        this._tmpEmitVelocityVariation.multiply(this._tmpEmitScale);
      }
      this._tmpEmitVelocityVariation.set(
        Math.abs(this._tmpEmitVelocityVariation.x),
        Math.abs(this._tmpEmitVelocityVariation.y),
        Math.abs(this._tmpEmitVelocityVariation.z)
      );
      overrides.emitterSize = this._tmpEmitVelocityVariation.clone();
    }

    const localSpaceVelocity = options.localSpaceVelocity !== false;

    this._tmpEmitVelocity.copy(options.velocity ?? this.config.velocity ?? new THREE.Vector3(0, 1, 0));
    if (localSpaceVelocity) {
      this._tmpEmitVelocity.applyQuaternion(this._tmpEmitQuaternion);
    }
    overrides.velocity = this._tmpEmitVelocity.clone();

    this._tmpEmitVelocityVariation.copy(
      options.velocityVariation ?? this.config.velocityVariation ?? new THREE.Vector3(0.5, 0.5, 0.5)
    );
    if (localSpaceVelocity) {
      this._tmpEmitVelocityVariation.applyQuaternion(this._tmpEmitQuaternion);
      this._tmpEmitVelocityVariation.set(
        Math.abs(this._tmpEmitVelocityVariation.x),
        Math.abs(this._tmpEmitVelocityVariation.y),
        Math.abs(this._tmpEmitVelocityVariation.z)
      );
    }
    overrides.velocityVariation = this._tmpEmitVelocityVariation.clone();

    if (options.lifetime !== undefined) {
      overrides.lifetime = options.lifetime;
    }
    if (options.lifetimeVariation !== undefined) {
      overrides.lifetimeVariation = options.lifetimeVariation;
    }

    return overrides;
  }

  /**
   * Set emission rate (particles per second)
   */
  setEmissionRate(rate: number): void {
    this.config.emissionRate = rate;
  }

  /**
   * Set sort cadence when sorting is enabled (1 = every frame, null/undefined = auto).
   */
  setSortFrameInterval(interval: number | null | undefined): void {
    this.config.sortFrameInterval = interval ?? null;
    this.computePipeline.setSortFrameInterval(interval);
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
    this.uSizeStart.value = start;
    this.uSizeEnd.value = end;
    this.config.sizeStart = start;
    this.config.sizeEnd = end;
  }

  /**
   * Set start size
   */
  setSizeStart(size: number): void {
    this.uSizeStart.value = size;
    this.config.sizeStart = size;
  }

  /**
   * Set end size
   */
  setSizeEnd(size: number): void {
    this.uSizeEnd.value = size;
    this.config.sizeEnd = size;
  }

  /**
   * Set particle color (start and end same)
   */
  setColor(color: THREE.Color): void {
    this.uColorStart.value.copy(color);
    this.uColorEnd.value.copy(color);
    this.config.colorStart?.copy(color);
    this.config.colorEnd?.copy(color);
  }

  /**
   * Set start color
   */
  setColorStart(color: THREE.Color): void {
    this.uColorStart.value.copy(color);
    this.config.colorStart?.copy(color);
  }

  /**
   * Set end color
   */
  setColorEnd(color: THREE.Color): void {
    this.uColorEnd.value.copy(color);
    this.config.colorEnd?.copy(color);
  }

  /**
   * Set opacity range
   */
  setOpacity(start: number, end: number): void {
    this.uOpacityStart.value = start;
    this.uOpacityEnd.value = end;
    this.config.opacityStart = start;
    this.config.opacityEnd = end;
  }

  /**
   * Set start opacity
   */
  setOpacityStart(opacity: number): void {
    this.uOpacityStart.value = opacity;
    this.config.opacityStart = opacity;
  }

  /**
   * Set end opacity
   */
  setOpacityEnd(opacity: number): void {
    this.uOpacityEnd.value = opacity;
    this.config.opacityEnd = opacity;
  }

  /**
   * Set billboard mode (particles face camera when enabled)
   */
  setBillboard(enabled: boolean): void {
    this.uBillboard.value = enabled ? 1 : 0;
    this.config.billboard = enabled;
  }

  /**
   * Set the soft-particle fade distance, in world units.
   *
   * Live: the value is a uniform, so tuning it costs nothing and does not
   * rebuild the material. Only toggling `softParticles` itself does, since that
   * decides whether the fade is compiled in at all.
   */
  setSoftness(softness: number): void {
    this.uSoftness.value = softness;
    this.config.softness = softness;
  }

  /**
   * Set particle geometry (recreates mesh - expensive operation)
   * Use sparingly, prefer setting geometry at construction time when possible.
   */
  setGeometry(geometry: THREE.BufferGeometry): void {
    if (!geometry) return;

    // Store old mesh transform
    const oldPosition = this.mesh.position.clone();
    const oldQuaternion = this.mesh.quaternion.clone();
    const oldScale = this.mesh.scale.clone();
    const oldMaterial = this.mesh.material;

    // Dispose old geometry
    if (this.mesh.geometry) {
      this.mesh.geometry.dispose();
    }

    // Remove old mesh from group
    this.remove(this.mesh);

    // Create new mesh with new geometry
    this.config.particleGeometry = geometry;
    this.mesh = new THREE.InstancedMesh(
      geometry,
      oldMaterial,
      this.storageManager.maxParticles
    );

    // Restore transform
    this.mesh.position.copy(oldPosition);
    this.mesh.quaternion.copy(oldQuaternion);
    this.mesh.scale.copy(oldScale);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;

    // Add new mesh to group
    this.add(this.mesh);
  }

  /**
   * Set emitter shape configuration
   */
  setEmitterShape(shape: EmitterShape, size?: THREE.Vector3): void {
    this.config.emitterShape = shape;
    if (size) {
      this.config.emitterSize = size;
    }

    this.indirectRenderer.setSpawnConfig({
      emitterShape: shape,
      emitterSize: this.config.emitterSize
    });

    this.computePipeline.setEmitterShape(shape);

    if (this.config.emitterSize) {
      this.computePipeline.setEmitterSize(this.config.emitterSize);
    }
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












