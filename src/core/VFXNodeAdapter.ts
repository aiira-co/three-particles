import * as THREE from 'three';
import { BaseProvider, type ParticleProvider } from '../providers/BaseProvider.js';
import { AttractorProvider } from '../providers/AttractorProvider.js';
import { TurbulenceProvider } from '../providers/TurbulenceProvider.js';
import { VortexProvider } from '../providers/VortexProvider.js';
import { WindProvider } from '../providers/WindProvider.js';
import type { EmitterShape, GPUParticleSystemConfig } from '../types/index.js';

export type Vector3Like = THREE.Vector3 | [number, number, number] | { x: number; y: number; z: number };
export type ColorLike = THREE.Color | string | [number, number, number] | { r: number; g: number; b: number };

export interface VFXNodeEmitterConfig {
  rate?: number;
  burst?: number;
  shape?: 'point' | 'sphere' | 'box' | 'cone' | 'circle' | 'line' | 'mesh';
  radius?: number;
  velocity?: Vector3Like;
  velocityRandom?: number | Vector3Like;
  lifetime?: number;
  lifetimeRandom?: number;
}

export interface VFXNodeOutputConfig {
  color?: {
    start?: ColorLike;
    end?: ColorLike;
  };
  size?: {
    start?: number;
    end?: number;
  };
  opacity?: {
    start?: number;
    end?: number;
  };
  texture?: THREE.Texture;
}

export interface VFXGravityForceConfig {
  type: 'gravity';
  gravity?: Vector3Like;
  direction?: Vector3Like;
  strength?: number;
}

export interface VFXTurbulenceForceConfig {
  type: 'turbulence' | 'noise';
  frequency?: number;
  amplitude?: number;
  octaves?: number;
  animated?: boolean;
  velocitySensitivity?: number;
}

export interface VFXAttractorForceConfig {
  type: 'attractor';
  position?: Vector3Like;
  strength?: number;
  spinStrength?: number;
  spinAxis?: Vector3Like;
}

export interface VFXVortexForceConfig {
  type: 'vortex';
  axis?: Vector3Like;
  center?: Vector3Like;
  strength?: number;
  pull?: number;
  radius?: number;
}

export interface VFXWindForceConfig {
  type: 'wind';
  direction?: Vector3Like;
  strength?: number;
  turbulence?: number;
}

export type VFXNodeForceConfig =
  | ParticleProvider
  | VFXGravityForceConfig
  | VFXTurbulenceForceConfig
  | VFXAttractorForceConfig
  | VFXVortexForceConfig
  | VFXWindForceConfig
  | Record<string, unknown>;

export interface VFXNodeSystemConfig {
  maxParticles?: number;
  blending?: string | THREE.Blending;
  depthWrite?: boolean;
  depthTest?: boolean;
  emitter?: VFXNodeEmitterConfig;
  output?: VFXNodeOutputConfig;
  forces?: VFXNodeForceConfig[];
  sorted?: boolean;
  sortFrameInterval?: number | null;
  softParticles?: boolean;
  trail?: GPUParticleSystemConfig['trail'];
}

export interface VFXNodeBuildResult {
  config: GPUParticleSystemConfig;
  providers: ParticleProvider[];
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function toVector3(value: Vector3Like | undefined, fallback: THREE.Vector3): THREE.Vector3 {
  if (!value) return fallback.clone();
  if (value instanceof THREE.Vector3) return value.clone();
  if (Array.isArray(value)) return new THREE.Vector3(value[0] ?? 0, value[1] ?? 0, value[2] ?? 0);
  return new THREE.Vector3(value.x ?? 0, value.y ?? 0, value.z ?? 0);
}

function toColor(value: ColorLike | undefined, fallback: THREE.Color): THREE.Color {
  if (!value) return fallback.clone();
  if (value instanceof THREE.Color) return value.clone();
  if (typeof value === 'string') return new THREE.Color(value);
  if (Array.isArray(value)) return new THREE.Color(value[0] ?? 1, value[1] ?? 1, value[2] ?? 1);
  return new THREE.Color(value.r ?? 1, value.g ?? 1, value.b ?? 1);
}

function toBlending(value: string | THREE.Blending | undefined): THREE.Blending | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'number') return value;

  switch (value.toLowerCase()) {
    case 'normal':
      return THREE.NormalBlending;
    case 'additive':
      return THREE.AdditiveBlending;
    case 'multiply':
      return THREE.MultiplyBlending;
    case 'subtractive':
      return THREE.SubtractiveBlending;
    default:
      return undefined;
  }
}

function toEmitterShape(shape: VFXNodeEmitterConfig['shape']): EmitterShape | undefined {
  if (!shape) return undefined;

  switch (shape) {
    case 'point':
    case 'sphere':
    case 'box':
    case 'line':
    case 'mesh':
      return shape;
    case 'circle':
      return 'sphere';
    case 'cone':
      // Cone is not yet a native emitter shape in three-particles.
      // Sphere is the closest fallback until a dedicated cone emitter is added.
      return 'sphere';
    default:
      return undefined;
  }
}

function isProviderLike(value: unknown): value is ParticleProvider {
  if (!value || typeof value !== 'object') return false;

  const candidate = value as Record<string, unknown>;
  if (typeof candidate.name !== 'string') return false;

  return (
    typeof candidate.getForceNode === 'function' ||
    typeof candidate.getVelocityModifierNode === 'function' ||
    typeof candidate.getPositionModifierNode === 'function'
  );
}

function resolveGravity(force: VFXGravityForceConfig): THREE.Vector3 {
  if (force.gravity) {
    return toVector3(force.gravity, new THREE.Vector3(0, -9.81, 0));
  }

  const direction = toVector3(force.direction, new THREE.Vector3(0, -1, 0));
  const strength = isFiniteNumber(force.strength) ? force.strength : 9.81;

  if (direction.lengthSq() <= 0) {
    return new THREE.Vector3(0, -9.81, 0);
  }

  return direction.normalize().multiplyScalar(strength);
}

function createProviderFromForce(force: VFXNodeForceConfig): ParticleProvider | null {
  if (force instanceof BaseProvider || isProviderLike(force)) {
    return force as ParticleProvider;
  }

  const forceType = (force as { type?: unknown }).type;
  const type = typeof forceType === 'string' ? forceType : '';

  switch (type) {
    case 'turbulence':
    case 'noise': {
      const cfg = force as VFXTurbulenceForceConfig;
      return new TurbulenceProvider({
        frequency: cfg.frequency,
        amplitude: cfg.amplitude,
        octaves: cfg.octaves,
        animated: cfg.animated,
        velocitySensitivity: cfg.velocitySensitivity,
      });
    }

    case 'attractor': {
      const cfg = force as VFXAttractorForceConfig;
      const provider = new AttractorProvider(8);
      provider.addAttractor({
        position: toVector3(cfg.position, new THREE.Vector3(0, 0, 0)),
        strength: isFiniteNumber(cfg.strength) ? cfg.strength : 10,
        spinStrength: isFiniteNumber(cfg.spinStrength) ? cfg.spinStrength : 0,
        spinAxis: toVector3(cfg.spinAxis, new THREE.Vector3(0, 1, 0)),
      });
      return provider;
    }

    case 'vortex': {
      const cfg = force as VFXVortexForceConfig;
      return new VortexProvider({
        axis: toVector3(cfg.axis, new THREE.Vector3(0, 1, 0)),
        center: toVector3(cfg.center, new THREE.Vector3(0, 0, 0)),
        strength: isFiniteNumber(cfg.strength) ? cfg.strength : 5,
        pullStrength: isFiniteNumber(cfg.pull) ? cfg.pull : 1,
        radius: isFiniteNumber(cfg.radius) ? cfg.radius : 5,
      });
    }

    case 'wind': {
      const cfg = force as VFXWindForceConfig;
      return new WindProvider({
        direction: toVector3(cfg.direction, new THREE.Vector3(1, 0, 0)),
        strength: isFiniteNumber(cfg.strength) ? cfg.strength : 1,
        turbulence: isFiniteNumber(cfg.turbulence) ? cfg.turbulence : 0.2,
      });
    }

    default:
      return null;
  }
}

/**
 * Convert graph-style VFX node config into three-particles runtime config.
 * Returns both GPUParticleSystemConfig and provider instances.
 */
export function buildVFXFromNodeConfig(
  nodeConfig: VFXNodeSystemConfig,
  baseConfig: GPUParticleSystemConfig = {}
): VFXNodeBuildResult {
  const config: GPUParticleSystemConfig = {
    ...baseConfig,
  };

  const providers: ParticleProvider[] = [];

  if (isFiniteNumber(nodeConfig.maxParticles)) {
    config.maxParticles = nodeConfig.maxParticles;
  }

  const blending = toBlending(nodeConfig.blending);
  if (blending !== undefined) {
    config.blending = blending;
  }

  if (typeof nodeConfig.sorted === 'boolean') {
    config.sorted = nodeConfig.sorted;
  }

  if (nodeConfig.sortFrameInterval === null) {
    config.sortFrameInterval = null;
  } else if (isFiniteNumber(nodeConfig.sortFrameInterval)) {
    config.sortFrameInterval = nodeConfig.sortFrameInterval;
  }

  if (typeof nodeConfig.softParticles === 'boolean') {
    config.softParticles = nodeConfig.softParticles;
  }

  if (nodeConfig.trail) {
    config.trail = { ...nodeConfig.trail };
  }

  const emitter = nodeConfig.emitter;
  if (emitter) {
    if (isFiniteNumber(emitter.rate)) {
      config.emissionRate = emitter.rate;
    }

    if (isFiniteNumber(emitter.lifetime)) {
      config.lifetime = emitter.lifetime;
    }

    const shape = toEmitterShape(emitter.shape);
    if (shape) {
      config.emitterShape = shape;
    }

    if (isFiniteNumber(emitter.radius)) {
      config.emitterSize = new THREE.Vector3(emitter.radius, emitter.radius, emitter.radius);
    }

    if (emitter.velocity) {
      config.velocity = toVector3(emitter.velocity, new THREE.Vector3(0, 1, 0));
    }

    if (emitter.velocityRandom !== undefined) {
      if (typeof emitter.velocityRandom === 'number') {
        const v = emitter.velocityRandom;
        config.velocityVariation = new THREE.Vector3(v, v, v);
      } else {
        config.velocityVariation = toVector3(
          emitter.velocityRandom,
          new THREE.Vector3(0.5, 0.5, 0.5)
        );
      }
    }
  }

  const output = nodeConfig.output;
  if (output) {
    if (output.color) {
      config.colorStart = toColor(output.color.start, new THREE.Color(1, 1, 1));
      config.colorEnd = toColor(output.color.end, config.colorStart);
    }

    if (output.size) {
      if (isFiniteNumber(output.size.start)) config.sizeStart = output.size.start;
      if (isFiniteNumber(output.size.end)) config.sizeEnd = output.size.end;
    }

    if (output.opacity) {
      if (isFiniteNumber(output.opacity.start)) config.opacityStart = output.opacity.start;
      if (isFiniteNumber(output.opacity.end)) config.opacityEnd = output.opacity.end;
    }

    if (output.texture) {
      config.texture = output.texture;
    }
  }

  for (const force of nodeConfig.forces ?? []) {
    if (!force) continue;

    const forceType = (force as { type?: unknown }).type;
    const type = typeof forceType === 'string' ? forceType : '';
    if (type === 'gravity') {
      config.gravity = resolveGravity(force as VFXGravityForceConfig);
      continue;
    }

    const provider = createProviderFromForce(force);
    if (provider) {
      providers.push(provider);
    }
  }

  return { config, providers };
}

/**
 * Attach providers to a particle system-like runtime.
 */
export function attachVFXProviders(
  system: { addProvider(provider: ParticleProvider): void },
  providers: ParticleProvider[]
): void {
  for (const provider of providers) {
    system.addProvider(provider);
  }
}


