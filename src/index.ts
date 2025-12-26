// Core
export { GPUParticleSystem } from './core/GPUParticleSystem.js';
export { VFXManager } from './core/VFXManager.js';
export { VFXSystemGroup } from './core/VFXSystemGroup.js';
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
export { ParticleTrails } from './features/ParticleTrails.js';
export type { ParticleTrailsConfig } from './features/ParticleTrails.js';

// Providers
export { BaseProvider } from './providers/BaseProvider.js';
export type { ParticleProvider, ProviderContext } from './providers/BaseProvider.js';
export { PhysicsProvider } from './providers/PhysicsProvider.js';
export { VortexProvider } from './providers/VortexProvider.js';
export { AttractorProvider } from './providers/AttractorProvider.js';
export type { AttractorConfig } from './providers/AttractorProvider.js';
export { TurbulenceProvider } from './providers/TurbulenceProvider.js';
export type { TurbulenceConfig } from './providers/TurbulenceProvider.js';
export { BoidsProvider } from './providers/BoidsProvider.js';
export type { BoidsConfig } from './providers/BoidsProvider.js';
export { MouseInteractionProvider } from './providers/MouseInteractionProvider.js';
export { WindProvider } from './providers/WindProvider.js';
export type { WindConfig } from './providers/WindProvider.js';
export { PathProvider } from './providers/PathProvider.js';
export type { PathConfig } from './providers/PathProvider.js';
export { DepthCollisionProvider } from './providers/DepthCollisionProvider.js';
export type { DepthCollisionConfig } from './providers/DepthCollisionProvider.js';

// VFX Graph
export { VFXGraph, VFXNode } from './nodes/VFXGraph.js';
export { NoiseForceNode, VortexNode, AttractorNode } from './nodes/builtin/index.js';

// Curves
export { LifetimeCurve } from './curves/LifetimeCurve.js';
export type { CurvePreset, CurvePoint, LifetimeCurveConfig } from './curves/LifetimeCurve.js';
export { GradientCurve } from './curves/GradientCurve.js';
export type { GradientStop, GradientCurveConfig } from './curves/GradientCurve.js';

// Types
export * from './types/index.js';
export type { PostProcessingConfig, VFXDepthCollisionConfig } from './core/VFXManager.js';