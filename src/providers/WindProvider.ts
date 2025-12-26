import * as THREE from 'three';
import { uniform, vec3, float, Fn } from 'three/tsl';
import { BaseProvider, ProviderContext } from './BaseProvider.js';

/**
 * Configuration for wind force field
 */
export interface WindConfig {
    /** Wind direction (will be normalized) */
    direction?: THREE.Vector3;
    /** Base wind strength */
    strength?: number;
    /** Additional gust strength (random bursts) */
    gustStrength?: number;
    /** Gust frequency (changes per second) */
    gustFrequency?: number;
    /** Random turbulence factor (0-1) */
    turbulence?: number;
    /** Height falloff - wind stronger at higher Y */
    heightFactor?: number;
}

/**
 * Wind provider that applies directional wind forces with gusts
 * Simulates natural wind with varying strength and direction
 */
export class WindProvider extends BaseProvider {
    name = 'WindProvider';
    priority = 35;

    // Uniforms
    private uDirection: any;
    private uStrength: any;
    private uGustStrength: any;
    private uGustPhase: any;
    private uTurbulence: any;
    private uHeightFactor: any;
    private uTime: any;

    private gustFrequency: number;
    private timeAccumulator: number = 0;

    constructor(config: WindConfig = {}) {
        super();

        const direction = (config.direction ?? new THREE.Vector3(1, 0, 0)).clone().normalize();

        this.uDirection = uniform(direction);
        this.uStrength = uniform(config.strength ?? 1.0);
        this.uGustStrength = uniform(config.gustStrength ?? 0.5);
        this.uGustPhase = uniform(0.0);
        this.uTurbulence = uniform(config.turbulence ?? 0.2);
        this.uHeightFactor = uniform(config.heightFactor ?? 0.0);
        this.uTime = uniform(0.0);
        this.gustFrequency = config.gustFrequency ?? 0.5;
    }

    // Setters for runtime configuration
    setDirection(direction: THREE.Vector3): void {
        this.uDirection.value.copy(direction).normalize();
    }

    setStrength(value: number): void {
        this.uStrength.value = value;
    }

    setGustStrength(value: number): void {
        this.uGustStrength.value = value;
    }

    setGustFrequency(value: number): void {
        this.gustFrequency = value;
    }

    setTurbulence(value: number): void {
        this.uTurbulence.value = value;
    }

    setHeightFactor(value: number): void {
        this.uHeightFactor.value = value;
    }

    onSystemUpdate(deltaTime: number, camera: THREE.Camera): void {
        this.timeAccumulator += deltaTime;
        this.uTime.value = this.timeAccumulator;

        // Update gust phase based on time
        this.uGustPhase.value = Math.sin(this.timeAccumulator * this.gustFrequency * Math.PI * 2) * 0.5 + 0.5;
    }

    /**
     * Generate TSL force calculation node
     */
    getForceNode(ctx: ProviderContext): any {
        const direction = this.uDirection;
        const strength = this.uStrength;
        const gustStrength = this.uGustStrength;
        const gustPhase = this.uGustPhase;
        const turbulence = this.uTurbulence;
        const heightFactor = this.uHeightFactor;
        const time = this.uTime;

        return Fn(() => {
            // Base wind force in direction
            const baseForce = direction.mul(strength);

            // Gust modulation (smooth sine wave)
            const gustMod = gustPhase.mul(gustStrength);
            const gustForce = direction.mul(gustMod);

            // Turbulence - position-based noise for variation
            const turbX = ctx.position.x.add(time.mul(0.5)).sin().mul(turbulence);
            const turbY = ctx.position.y.add(time.mul(0.7)).sin().mul(turbulence).mul(0.3);
            const turbZ = ctx.position.z.add(time.mul(0.3)).sin().mul(turbulence);
            const turbForce = vec3(turbX, turbY, turbZ);

            // Height factor - wind stronger at higher positions
            const heightMod = float(1.0).add(ctx.position.y.max(0).mul(heightFactor));

            // Combine all forces
            return baseForce.add(gustForce).add(turbForce).mul(heightMod);
        })();
    }

    getUniforms(): Record<string, any> {
        return {
            uWindDirection: this.uDirection,
            uWindStrength: this.uStrength,
            uWindGustStrength: this.uGustStrength,
            uWindGustPhase: this.uGustPhase,
            uWindTurbulence: this.uTurbulence,
            uWindHeightFactor: this.uHeightFactor,
            uWindTime: this.uTime
        };
    }

    dispose(): void {
        // Nothing to dispose
    }
}
