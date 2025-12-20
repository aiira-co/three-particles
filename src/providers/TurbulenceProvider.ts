import * as THREE from 'three';
import { uniform, vec3, float, Fn } from 'three/tsl';
// Note: mx_fractal_noise_vec3 may need to be imported from addons in actual usage
import { BaseProvider, ProviderContext } from './BaseProvider.js';

/**
 * Configuration for turbulence field
 */
export interface TurbulenceConfig {
    /** Noise frequency - higher = more detail */
    frequency?: number;
    /** Noise amplitude - strength of turbulence */
    amplitude?: number;
    /** Number of noise octaves (more = more detail, more expensive) */
    octaves?: number;
    /** Lacunarity - frequency multiplier per octave */
    lacunarity?: number;
    /** Gain - amplitude multiplier per octave */
    gain?: number;
    /** Friction/damping applied to velocity */
    friction?: number;
    /** Time-based offset for animated noise */
    animated?: boolean;
    /** Animation speed multiplier */
    animationSpeed?: number;
}

/**
 * Turbulence provider that applies noise-based forces to particles
 * Based on Three.js webgpu_tsl_vfx_linkedparticles example
 */
export class TurbulenceProvider extends BaseProvider {
    name = 'TurbulenceProvider';
    priority = 40;

    // Uniforms
    private uFrequency: any;
    private uAmplitude: any;
    private uOctaves: any;
    private uLacunarity: any;
    private uGain: any;
    private uFriction: any;
    private uTimeOffset: any;
    private uAnimationSpeed: any;

    private animated: boolean;
    private timeAccumulator: number = 0;

    constructor(config: TurbulenceConfig = {}) {
        super();

        this.uFrequency = uniform(config.frequency ?? 0.5);
        this.uAmplitude = uniform(config.amplitude ?? 0.5);
        this.uOctaves = uniform(config.octaves ?? 2);
        this.uLacunarity = uniform(config.lacunarity ?? 2.0);
        this.uGain = uniform(config.gain ?? 0.5);
        this.uFriction = uniform(config.friction ?? 0.01);
        this.uTimeOffset = uniform(new THREE.Vector3(0, 0, 0));
        this.uAnimationSpeed = uniform(config.animationSpeed ?? 1.0);
        this.animated = config.animated ?? true;
    }

    // Setters for runtime configuration
    setFrequency(value: number): void { this.uFrequency.value = value; }
    setAmplitude(value: number): void { this.uAmplitude.value = value; }
    setOctaves(value: number): void { this.uOctaves.value = value; }
    setLacunarity(value: number): void { this.uLacunarity.value = value; }
    setGain(value: number): void { this.uGain.value = value; }
    setFriction(value: number): void { this.uFriction.value = value; }
    setAnimationSpeed(value: number): void { this.uAnimationSpeed.value = value; }

    onSystemUpdate(deltaTime: number, camera: THREE.Camera): void {
        if (this.animated) {
            this.timeAccumulator += deltaTime * this.uAnimationSpeed.value;
            // Use time to offset the noise sample position for animation
            this.uTimeOffset.value.set(
                this.timeAccumulator * 0.1,
                this.timeAccumulator * 0.13,
                this.timeAccumulator * 0.17
            );
        }
    }

    /**
     * Generate TSL force calculation node using fractal noise
     * Note: This uses a simplified noise implementation since mx_fractal_noise_vec3
     * may not be available in all setups. For production, import from MaterialX addons.
     */
    getForceNode(ctx: ProviderContext): any {
        const frequency = this.uFrequency;
        const amplitude = this.uAmplitude;
        const timeOffset = this.uTimeOffset;

        return Fn(() => {
            // Sample position for noise (with time offset for animation)
            const samplePos = ctx.position.mul(frequency).add(timeOffset);

            // Simple 3D noise approximation using sin/cos
            // In production, use mx_fractal_noise_vec3 for better quality
            const noiseX = samplePos.x.add(samplePos.y.mul(0.5)).sin()
                .mul(samplePos.z.mul(1.3).cos())
                .mul(amplitude);
            const noiseY = samplePos.y.add(samplePos.z.mul(0.7)).sin()
                .mul(samplePos.x.mul(1.1).cos())
                .mul(amplitude);
            const noiseZ = samplePos.z.add(samplePos.x.mul(0.3)).sin()
                .mul(samplePos.y.mul(0.9).cos())
                .mul(amplitude);

            return vec3(noiseX, noiseY, noiseZ);
        })();
    }

    /**
     * Apply friction/damping to velocity
     */
    getVelocityModifierNode(ctx: ProviderContext): any {
        const friction = this.uFriction;

        return Fn(() => {
            // Return a multiplier for velocity (1 - friction)
            return ctx.velocity.mul(float(1.0).sub(friction));
        })();
    }

    getUniforms(): Record<string, any> {
        return {
            uTurbFrequency: this.uFrequency,
            uTurbAmplitude: this.uAmplitude,
            uTurbOctaves: this.uOctaves,
            uTurbLacunarity: this.uLacunarity,
            uTurbGain: this.uGain,
            uTurbFriction: this.uFriction,
            uTurbTimeOffset: this.uTimeOffset,
            uTurbAnimationSpeed: this.uAnimationSpeed
        };
    }

    dispose(): void {
        // Nothing to dispose
    }
}
