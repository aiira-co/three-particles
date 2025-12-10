// Core
export { GPUParticleSystem } from './core/GPUParticleSystem.js';
export { VFXManager } from './core/VFXManager.js';
export { IndirectRenderer } from './core/IndirectRenderer.js';
export { GPUSorter } from './core/GPUSorter.js';
export { StorageManager } from './core/StorageManager.js';
export { ComputePipeline } from './core/ComputePipeline.js';

// Features
export { TextureAtlas } from './features/TextureAtlas.js';
export { SoftParticles } from './features/SoftParticles.js';
export { DepthCollisions } from './features/DepthCollisions.js';
export { VectorField } from './features/VectorField.js';
export { FrustumCulling } from './features/FrustumCulling.js';
export { SpatialHash } from './features/SpatialHash.js';

// Providers
export { BaseProvider } from './providers/BaseProvider.js';
export { PhysicsProvider } from './providers/PhysicsProvider.js';
export { MagneticProvider } from './providers/MagneticProvider.js';
export { VortexProvider } from './providers/VortexProvider.js';
export { BoidsProvider } from './providers/BoidsProvider.js';
export { MouseInteractionProvider } from './providers/MouseInteractionProvider.js';

// VFX Graph
export { VFXGraph, VFXNode } from './nodes/VFXGraph.js';
export { NoiseForceNode, VortexNode, AttractorNode } from './nodes/builtin/index.js';

// Types
export * from './types/index.js';