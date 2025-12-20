import * as THREE from 'three';
import { LifetimeCurve, CurvePreset } from '../curves/LifetimeCurve.js';
import { GradientCurve } from '../curves/GradientCurve.js';

export type EmitterShape = 'point' | 'box' | 'sphere' | 'mesh' | 'line';

export interface GPUParticleSystemConfig {
  // Core
  maxParticles?: number;
  emissionRate?: number;
  lifetime?: number;
  loop?: boolean;

  // Geometry
  particleGeometry?: THREE.BufferGeometry;
  billboard?: boolean;

  // Emitter
  emitterShape?: EmitterShape;
  emitterSize?: THREE.Vector3;
  emitterMesh?: THREE.Mesh;

  // Visual
  texture?: THREE.Texture;
  textureSheet?: TextureSheetConfig;
  colorStart?: THREE.Color;
  colorEnd?: THREE.Color;
  sizeStart?: number;
  sizeEnd?: number;
  opacityStart?: number;
  opacityEnd?: number;

  /** Custom material for particles (overrides built-in material if provided).
   * The material receives particle data via storage nodes accessible through
   * the GPUParticleSystem.particleNodes property.
   */
  material?: THREE.Material;

  /** Material factory callback that receives particle context for building custom shaders.
   * Called once during system initialization. The returned material is used for all particles.
   * This is more convenient than `material` as it provides direct access to particle nodes.
   */
  materialFactory?: (context: ParticleMaterialContext) => THREE.Material;

  /** Define multiple particle styles for varied appearance within the same emitter.
   * Each spawned particle will be assigned a style based on weights.
   */
  styles?: StyleConfig[];

  /** Blending mode for particles (default: AdditiveBlending) */
  blending?: THREE.Blending;

  // Lifetime Curves (optional - defaults to linear)
  /** Curve for size interpolation over lifetime */
  sizeCurve?: LifetimeCurve | CurvePreset;
  /** Curve for opacity interpolation over lifetime */
  opacityCurve?: LifetimeCurve | CurvePreset;
  /** Gradient for color over lifetime (overrides colorStart/End if provided) */
  colorGradient?: GradientCurve;

  // Physics
  velocity?: THREE.Vector3;
  velocityVariation?: THREE.Vector3;
  gravity?: THREE.Vector3;
  drag?: number;
  turbulence?: number;

  // Trails - GPU ribbon trails with position history
  /** Trail configuration for ribbon-style particle trails */
  trail?: {
    /** Enable trail effect */
    enabled: boolean;
    /** Number of trail segments (default: 8) */
    segments?: number;
    /** Seconds between position samples (default: 0.02) */
    updateInterval?: number;
    /** Trail width multiplier (default: 1.0) */
    width?: number;
    /** Fade alpha from head to tail (default: true) */
    fadeAlpha?: boolean;
  };

  // Advanced Physics
  vectorField?: THREE.Data3DTexture;
  floorY?: number | null;
  bounciness?: number;

  // Performance & Quality
  sorted?: boolean;
  softParticles?: boolean;
  softness?: number;
  depthCollisions?: boolean;
  frustumCulled?: boolean;
  occlusionCulled?: boolean;
  receiveShadows?: boolean;
  castShadows?: boolean;

  // LOD
  lod?: LODConfig[];

  // Sub-emitters
  subEmitters?: {
    onDeath?: GPUParticleSystemConfig;
    onCollision?: GPUParticleSystemConfig;
  };
}

export interface TextureSheetConfig {
  tilesX: number;
  tilesY: number;
  totalFrames?: number;
  fps?: number;
  startFrame?: number;
  loop?: boolean;
  randomStart?: boolean;
}

export interface LODConfig {
  distance: number;
  particleCount: number;
  particleSize: number;
}

export interface ParticleStats {
  aliveParticles: number;
  deadParticles: number;
  culledParticles: number;
  drawCalls: number;
  gpuMemory: number;
  computeTime: number;
  sortTime: number;
}

export interface CollisionConfig {
  type: 'none' | 'depth' | 'plane';
  bounciness?: number;
  friction?: number;
  depthThreshold?: number;
  planeY?: number;
}

// Alias for VFXManager compatibility
export type ParticleSystemConfig = GPUParticleSystemConfig & {
  collisions?: CollisionConfig;
};

/**
 * Configuration for a particle style within a multi-style emitter.
 */
export interface StyleConfig {
  /** Optional name for identification */
  name?: string;
  /** Weight for spawn distribution (default: 1). Higher = more particles of this style. */
  weight?: number;
  /** Color associated with this style */
  color?: THREE.Color;
  /** Custom data that can be accessed in materialFactory */
  customData?: Record<string, any>;
}

/**
 * Context provided to materialFactory callback for building custom particle shaders.
 * All nodes are TSL storage/uniform nodes that can be used directly in shader construction.
 */
export interface ParticleMaterialContext {
  /** Storage node for particle positions (vec3) */
  positions: any;
  /** Storage node for particle velocities (vec3) */
  velocities: any;
  /** Storage node for particle ages/spawn times (float) */
  ages: any;
  /** Storage node for particle lifetimes (float) */
  lifetimes: any;
  /** Storage node for particle rotations (vec3) */
  rotations: any;
  /** Storage node for particle colors (vec4) */
  colors: any;
  /** Storage node for particle style index (float, 0 to N-1) */
  styles: any;
  /** Current simulation time uniform */
  time: any;
  /** Delta time uniform */
  delta: any;
  /** Instance index node for current particle */
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
  /** Number of defined styles (from config) */
  styleCount: number;
}
