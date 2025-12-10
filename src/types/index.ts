import * as THREE from 'three';

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
  
  // Physics
  velocity?: THREE.Vector3;
  velocityVariation?: THREE.Vector3;
  gravity?: THREE.Vector3;
  drag?: number;
  turbulence?: number;
  
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

