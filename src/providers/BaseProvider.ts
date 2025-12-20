import * as THREE from 'three';
import { uniform, vec3 } from 'three/tsl';

/**
 * Context passed to providers for TSL node generation
 */
export interface ProviderContext {
  /** Particle position storage node */
  position: any;
  /** Particle velocity storage node */
  velocity: any;
  /** Particle age/spawnTime storage node */
  age: any;
  /** Particle lifetime storage node */
  lifetime: any;
  /** Current particle index (instanceIndex) */
  index: any;
  /** Delta time uniform */
  delta: any;
  /** Global time uniform */
  time: any;
}

/**
 * Interface for particle behavior providers
 * Providers can inject TSL nodes into the compute shader
 */
export interface ParticleProvider {
  /** Unique name for this provider */
  name: string;

  /** Priority for execution order (higher = later) */
  priority?: number;

  /**
   * Return a TSL node that calculates force contribution (vec3)
   * This force will be added to the particle's velocity
   */
  getForceNode?(ctx: ProviderContext): any;

  /**
   * Return a TSL node that modifies velocity directly (vec3)
   * Applied after forces, useful for damping, clamping, etc.
   */
  getVelocityModifierNode?(ctx: ProviderContext): any;

  /**
   * Return a TSL node that modifies position directly (vec3)
   * Applied after velocity integration, useful for constraints
   */
  getPositionModifierNode?(ctx: ProviderContext): any;

  /**
   * Called when the system updates (CPU-side)
   * Use for updating uniforms, camera tracking, etc.
   */
  onSystemUpdate?(deltaTime: number, camera: THREE.Camera): void;

  /**
   * Get all uniforms used by this provider
   * These will be synced to the compute shader
   */
  getUniforms?(): Record<string, any>;

  /**
   * Cleanup resources
   */
  dispose?(): void;
}

/**
 * Base class for particle providers with TSL node injection
 */
export abstract class BaseProvider implements ParticleProvider {
  abstract name: string;
  priority: number = 0;

  /** Override to provide force calculation node */
  getForceNode?(ctx: ProviderContext): any;

  /** Override to provide velocity modifier node */
  getVelocityModifierNode?(ctx: ProviderContext): any;

  /** Override to provide position modifier node */
  getPositionModifierNode?(ctx: ProviderContext): any;

  /** Override for per-frame updates */
  onSystemUpdate?(deltaTime: number, camera: THREE.Camera): void;

  /** Override to expose uniforms */
  getUniforms?(): Record<string, any>;

  /** Override for cleanup */
  dispose?(): void;
}