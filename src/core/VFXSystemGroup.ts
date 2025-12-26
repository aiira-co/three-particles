import * as THREE from 'three';
import { GPUParticleSystem } from '../core/GPUParticleSystem.js';
import { GPUParticleSystemConfig, StyleConfig, ParticleStats } from '../types/index.js';
import { ParticleProvider } from '../providers/BaseProvider.js';

/**
 * VFXSystemGroup - Manages multiple GPUParticleSystems as a single unit
 * 
 * Use this when you need different particle types with different geometries
 * (e.g., fire + smoke in an explosion). Each style gets its own GPUParticleSystem
 * but they're controlled together.
 * 
 * Example:
 * ```typescript
 * const explosion = new VFXSystemGroup({
 *   styles: [
 *     { name: 'Fire', geometry: quadGeometry, colorStart: yellow, colorEnd: red },
 *     { name: 'Smoke', geometry: coneGeometry, colorStart: gray, colorEnd: black }
 *   ]
 * });
 * scene.add(explosion.object);
 * ```
 */
export class VFXSystemGroup {
    private _systems: Map<string, GPUParticleSystem> = new Map();
    private _group: THREE.Group;
    private _providers: ParticleProvider[] = [];
    private _baseConfig: GPUParticleSystemConfig;
    private _isPlaying: boolean = false;
    private _isPaused: boolean = false;

    constructor(config: GPUParticleSystemConfig & { styles: StyleConfig[] }) {
        this._baseConfig = config;
        this._group = new THREE.Group();
        this._group.name = 'VFXSystemGroup';

        // Create a GPUParticleSystem for each style
        if (config.styles && config.styles.length > 0) {
            for (const style of config.styles) {
                this._createSystemForStyle(style);
            }
        } else {
            // Single system with base config
            this._createSystemForStyle({ name: 'default' });
        }
    }

    /**
     * Create a GPUParticleSystem for a single style
     */
    private _createSystemForStyle(style: StyleConfig): void {
        const name = style.name || `style_${this._systems.size}`;

        // Merge base config with style overrides
        const styleConfig: GPUParticleSystemConfig = {
            ...this._baseConfig,
            // Override with style-specific values
            particleGeometry: style.geometry ?? this._baseConfig.particleGeometry,
            billboard: style.billboard ?? this._baseConfig.billboard,
            colorStart: style.colorStart ?? this._baseConfig.colorStart,
            colorEnd: style.colorEnd ?? this._baseConfig.colorEnd,
            sizeStart: style.sizeStart ?? this._baseConfig.sizeStart,
            sizeEnd: style.sizeEnd ?? this._baseConfig.sizeEnd,
            opacityStart: style.opacityStart ?? this._baseConfig.opacityStart,
            opacityEnd: style.opacityEnd ?? this._baseConfig.opacityEnd,
            sizeCurve: style.sizeCurve ?? this._baseConfig.sizeCurve,
            opacityCurve: style.opacityCurve ?? this._baseConfig.opacityCurve,
            colorGradient: style.colorGradient ?? this._baseConfig.colorGradient,
            texture: style.texture ?? this._baseConfig.texture,
            textureSheet: style.textureSheet ?? this._baseConfig.textureSheet,
            blending: style.blending ?? this._baseConfig.blending,
            lifetime: style.lifetime ?? this._baseConfig.lifetime,
            drag: style.drag ?? this._baseConfig.drag,
            trail: style.trail ?? this._baseConfig.trail,
            // Adjust emission rate based on weight
            emissionRate: (this._baseConfig.emissionRate ?? 100) * (style.weight ?? 1),
        };

        // Apply velocity multiplier if specified
        if (style.velocityMultiplier !== undefined && styleConfig.velocity) {
            styleConfig.velocity = styleConfig.velocity.clone().multiplyScalar(style.velocityMultiplier);
        }

        // Apply gravity multiplier if specified
        if (style.gravityMultiplier !== undefined && styleConfig.gravity) {
            styleConfig.gravity = styleConfig.gravity.clone().multiplyScalar(style.gravityMultiplier);
        }

        // Don't include styles array in child system
        delete (styleConfig as any).styles;

        const system = new GPUParticleSystem(styleConfig);
        system.mesh.name = name;

        this._systems.set(name, system);
        this._group.add(system.mesh);

        console.log(`[VFXSystemGroup] Created system: ${name}`);
    }

    /**
     * Get the THREE.Group containing all particle systems
     */
    get object(): THREE.Group {
        return this._group;
    }

    /**
     * Get the THREE.Group (alias for object)
     */
    get mesh(): THREE.Group {
        return this._group;
    }

    /**
     * Get all systems
     */
    get systems(): GPUParticleSystem[] {
        return Array.from(this._systems.values());
    }

    /**
     * Get a system by name
     */
    getSystem(name: string): GPUParticleSystem | undefined {
        return this._systems.get(name);
    }

    /**
     * Add a provider to all systems
     */
    addProvider(provider: ParticleProvider): void {
        this._providers.push(provider);
        for (const system of this._systems.values()) {
            // Cast to any to handle interface compatibility
            system.addProvider(provider as any);
        }
    }

    /**
     * Remove a provider from all systems
     */
    removeProvider(provider: ParticleProvider): void {
        const idx = this._providers.indexOf(provider);
        if (idx >= 0) {
            this._providers.splice(idx, 1);
        }
        for (const system of this._systems.values()) {
            // Use provider name for removal
            system.removeProvider(provider.name);
        }
    }

    /**
     * Update all systems
     */
    update(renderer: THREE.WebGLRenderer, deltaTime: number, camera: THREE.Camera): void {
        for (const system of this._systems.values()) {
            system.update(renderer as any, deltaTime, camera);
        }
    }

    /**
     * Play all systems
     */
    play(): void {
        this._isPlaying = true;
        this._isPaused = false;
        for (const system of this._systems.values()) {
            system.play();
        }
    }

    /**
     * Pause all systems
     */
    pause(): void {
        this._isPaused = true;
        for (const system of this._systems.values()) {
            system.pause();
        }
    }

    /**
     * Stop all systems
     */
    stop(): void {
        this._isPlaying = false;
        this._isPaused = false;
        for (const system of this._systems.values()) {
            system.stop();
        }
    }

    /**
     * Trigger burst on all systems
     */
    burst(count: number): void {
        // Distribute burst count among systems based on weights
        const totalWeight = Array.from(this._systems.values()).length;
        const countPerSystem = Math.ceil(count / totalWeight);

        for (const system of this._systems.values()) {
            system.burst(countPerSystem);
        }
    }

    /**
     * Get combined stats from all systems
     */
    get stats(): ParticleStats {
        const combined: ParticleStats = {
            aliveParticles: 0,
            deadParticles: 0,
            culledParticles: 0,
            drawCalls: 0,
            gpuMemory: 0,
            computeTime: 0,
            sortTime: 0
        };

        for (const system of this._systems.values()) {
            const s = system.stats;
            combined.aliveParticles += s.aliveParticles;
            combined.deadParticles += s.deadParticles;
            combined.culledParticles += s.culledParticles;
            combined.drawCalls += s.drawCalls;
            combined.gpuMemory += s.gpuMemory;
            combined.computeTime = Math.max(combined.computeTime, s.computeTime);
            combined.sortTime = Math.max(combined.sortTime, s.sortTime);
        }

        return combined;
    }

    /**
     * Set position for all systems
     */
    set position(pos: THREE.Vector3) {
        this._group.position.copy(pos);
    }

    get position(): THREE.Vector3 {
        return this._group.position;
    }

    /**
     * Set rotation for all systems
     */
    set rotation(rot: THREE.Euler) {
        this._group.rotation.copy(rot);
    }

    get rotation(): THREE.Euler {
        return this._group.rotation;
    }

    /**
     * Dispose all systems
     */
    dispose(): void {
        for (const system of this._systems.values()) {
            system.dispose();
        }
        this._systems.clear();
        this._group.clear();
    }

    /**
     * Check if playing
     */
    isPlaying(): boolean {
        return this._isPlaying && !this._isPaused;
    }

    /**
     * Check if paused
     */
    isPaused(): boolean {
        return this._isPaused;
    }
}
