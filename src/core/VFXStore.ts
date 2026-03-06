import type { ParticleStats } from '../types/index.js';

/**
 * Minimal runtime surface needed for registration in VFXStore.
 * Works with GPUParticleSystem, VFXSystemGroup, and external wrappers.
 */
export interface VFXSystemHandle {
  burst(count: number): void;
  emit?(options: EmitOptions): void;
  play?(): void;
  pause?(): void;
  stop?(): void;
  setEmissionRate?(rate: number): void;
  getStats?(): ParticleStats;
  stats?: ParticleStats;
  isPlaying?: boolean | (() => boolean);
  systems?: Array<{
    setEmissionRate?(rate: number): void;
  }>;
}

export interface RegisterVFXSystemOptions {
  /**
   * Replace an existing system with the same name.
   * Defaults to false.
   */
  replace?: boolean;
  /**
   * Optional custom emission function.
   * Useful when wrapping external runtimes.
   */
  emit?: (count: number, system: VFXSystemHandle) => void;
}

export interface EmitOptions {
  /**
   * Number of particles to emit.
   * Defaults to 20.
   */
  count?: number;
  [key: string]: unknown;
}

interface RegisteredSystem {
  system: VFXSystemHandle;
  emit: (count: number, system: VFXSystemHandle) => void;
  customEmit: boolean;
}

function normalizeCount(value: number | undefined, fallback: number): number {
  const raw = value ?? fallback;
  if (!Number.isFinite(raw)) return fallback;
  return Math.max(0, Math.floor(raw));
}

/**
 * Central registry/store for named VFX systems.
 * Inspired by emitter-system registries from production VFX packages.
 */
export class VFXStore {
  private systems = new Map<string, RegisteredSystem>();

  register(
    name: string,
    system: VFXSystemHandle,
    options: RegisterVFXSystemOptions = {}
  ): boolean {
    if (!name) return false;

    const existing = this.systems.has(name);
    if (existing && !options.replace) {
      console.warn(`[VFXStore] System "${name}" already exists. Pass replace=true to overwrite.`);
      return false;
    }

    const customEmit = typeof options.emit === 'function';
    const emitFn = options.emit ?? ((count: number, target: VFXSystemHandle) => target.burst(count));
    this.systems.set(name, { system, emit: emitFn, customEmit });
    return true;
  }

  unregister(name: string): boolean {
    return this.systems.delete(name);
  }

  clear(): void {
    this.systems.clear();
  }

  has(name: string): boolean {
    return this.systems.has(name);
  }

  get<T extends VFXSystemHandle = VFXSystemHandle>(name: string): T | undefined {
    return this.systems.get(name)?.system as T | undefined;
  }

  names(): string[] {
    return Array.from(this.systems.keys());
  }

  size(): number {
    return this.systems.size;
  }

  emit(name: string, options: EmitOptions = {}): boolean {
    const entry = this.systems.get(name);
    if (!entry) {
      console.warn(`[VFXStore] No system registered with name "${name}".`);
      return false;
    }

    // Prefer native emit(options) when available and no custom emit callback is set.
    if (!entry.customEmit && typeof entry.system.emit === 'function') {
      entry.system.emit(options);
      return true;
    }

    const count = normalizeCount(options.count, 20);
    if (count <= 0) return true;

    entry.emit(count, entry.system);
    return true;
  }

  burst(name: string, count = 20): boolean {
    return this.emit(name, { count });
  }

  play(name: string): boolean {
    const system = this.systems.get(name)?.system;
    if (!system?.play) {
      console.warn(`[VFXStore] System "${name}" does not support play().`);
      return false;
    }
    system.play();
    return true;
  }

  pause(name: string): boolean {
    const system = this.systems.get(name)?.system;
    if (!system?.pause) {
      console.warn(`[VFXStore] System "${name}" does not support pause().`);
      return false;
    }
    system.pause();
    return true;
  }

  stop(name: string): boolean {
    const system = this.systems.get(name)?.system;
    if (!system?.stop) {
      console.warn(`[VFXStore] System "${name}" does not support stop().`);
      return false;
    }
    system.stop();
    return true;
  }

  setEmissionRate(name: string, rate: number): boolean {
    const system = this.systems.get(name)?.system;
    if (!system) return false;

    if (typeof system.setEmissionRate === 'function') {
      system.setEmissionRate(rate);
      return true;
    }

    if (Array.isArray(system.systems)) {
      for (const child of system.systems) {
        if (typeof child.setEmissionRate === 'function') {
          child.setEmissionRate(rate);
        }
      }
      return true;
    }

    console.warn(`[VFXStore] System "${name}" does not support setEmissionRate().`);
    return false;
  }

  getStats(name: string): ParticleStats | null {
    const system = this.systems.get(name)?.system;
    if (!system) return null;

    if (typeof system.getStats === 'function') return system.getStats();
    if (system.stats) return system.stats;
    return null;
  }

  isPlaying(name: string): boolean {
    const system = this.systems.get(name)?.system;
    if (!system) return false;

    const value = system.isPlaying;
    if (typeof value === 'function') return !!value();
    if (typeof value === 'boolean') return value;
    return false;
  }
}

/**
 * Default global store instance.
 */
export const vfxStore = new VFXStore();
