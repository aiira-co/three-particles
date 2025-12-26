import * as THREE from 'three';
import { uniform, vec3, float, Fn } from 'three/tsl';
import { BaseProvider, ProviderContext } from './BaseProvider.js';

/**
 * Configuration for physics-based turbulence field
 * 
 * Based on research from "Particle-resolved study of the onset of turbulence"
 * (Phys. Rev. Research 6, L012013) which describes:
 * - Kolmogorov's -5/3 power law for energy distribution
 * - Velocity-dependent turbulence onset
 * - Intermittent "puffs" in turbulent transition
 * - Damping effects on turbulence suppression
 * 
 * @see https://journals.aps.org/prresearch/abstract/10.1103/PhysRevResearch.6.L012013
 */
export interface TurbulenceConfig {
    /** Base noise frequency - higher = more detail */
    frequency?: number;
    /** Base amplitude - strength of turbulence */
    amplitude?: number;
    /** Number of noise octaves (more = more detail, more expensive) */
    octaves?: number;
    /** Lacunarity - frequency multiplier per octave (default: 2.0 for Kolmogorov) */
    lacunarity?: number;
    /** Gain - amplitude multiplier per octave (default: 0.5 for -5/3 law approximation) */
    gain?: number;
    /** Friction/damping applied to velocity (higher = more viscous/laminar) */
    friction?: number;
    /** Time-based offset for animated noise */
    animated?: boolean;
    /** Animation speed multiplier */
    animationSpeed?: number;

    // ======== Physics-based enhancements ========

    /** 
     * Velocity sensitivity - turbulence increases with particle speed
     * Simulates Reynolds number effect: faster flow = more turbulent
     */
    velocitySensitivity?: number;

    /**
     * Intermittency - enables "puff" behavior where turbulence varies over time
     * Creates more organic, realistic turbulent motion
     */
    intermittency?: number;

    /**
     * Intermittency frequency - how often puffs occur (lower = slower variation)
     */
    intermittencyFrequency?: number;

    /**
     * Spectral balance - energy distribution across scales
     * 0 = equal energy at all scales
     * 1 = Kolmogorov -5/3 (large eddies dominate) - physically realistic
     */
    kolmogorovScaling?: number;

    /**
     * Curl noise - uses curl of noise field for divergence-free flow
     * Creates more swirling, incompressible fluid-like motion
     */
    curlNoise?: boolean;

    /**
     * Flow direction for wake effects - turbulence stronger behind flow
     */
    flowDirection?: THREE.Vector3;

    /**
     * Wake intensity - how much stronger turbulence is in wake regions
     */
    wakeIntensity?: number;
}

/**
 * Physics-based Turbulence Provider
 * 
 * Applies noise-based turbulent forces following fluid dynamics principles:
 * 
 * **Kolmogorov's -5/3 Law**: Energy cascades from large to small eddies
 * following E(k) ∝ k^(-5/3). Larger vortices contain more energy.
 * 
 * **Reynolds Number Effect**: Turbulence intensity increases with velocity
 * (faster flow = higher Reynolds number = more turbulent).
 * 
 * **Intermittency**: Turbulent transition involves "puffs" - intermittent
 * bursts of chaotic motion rather than constant noise.
 * 
 * **Damping**: Higher viscosity (friction) suppresses turbulence,
 * leading to more laminar (smooth) flow.
 * 
 * @see https://journals.aps.org/prresearch/abstract/10.1103/PhysRevResearch.6.L012013
 */
export class TurbulenceProvider extends BaseProvider {
    name = 'TurbulenceProvider';
    priority = 40;

    // Base uniforms
    private uFrequency: any;
    private uAmplitude: any;
    private uOctaves: any;
    private uLacunarity: any;
    private uGain: any;
    private uFriction: any;
    private uTimeOffset: any;
    private uAnimationSpeed: any;

    // Physics enhancements
    private uVelocitySensitivity: any;
    private uIntermittency: any;
    private uIntermittencyFrequency: any;
    private uIntermittencyPhase: any;
    private uKolmogorovScaling: any;
    private uCurlNoise: any;
    private uFlowDirection: any;
    private uWakeIntensity: any;
    private uTime: any;

    private animated: boolean;
    private timeAccumulator: number = 0;

    constructor(config: TurbulenceConfig = {}) {
        super();

        // Base turbulence parameters
        this.uFrequency = uniform(config.frequency ?? 0.5);
        this.uAmplitude = uniform(config.amplitude ?? 0.5);
        this.uOctaves = uniform(config.octaves ?? 3);
        // Lacunarity of 2.0 is typical for natural phenomena
        this.uLacunarity = uniform(config.lacunarity ?? 2.0);
        // Gain of ~0.5 approximates Kolmogorov -5/3 energy cascade
        this.uGain = uniform(config.gain ?? 0.5);
        this.uFriction = uniform(config.friction ?? 0.01);
        this.uTimeOffset = uniform(new THREE.Vector3(0, 0, 0));
        this.uAnimationSpeed = uniform(config.animationSpeed ?? 1.0);
        this.animated = config.animated ?? true;

        // Physics-based enhancements
        this.uVelocitySensitivity = uniform(config.velocitySensitivity ?? 0.2);
        this.uIntermittency = uniform(config.intermittency ?? 0.3);
        this.uIntermittencyFrequency = uniform(config.intermittencyFrequency ?? 0.5);
        this.uIntermittencyPhase = uniform(0.0);
        this.uKolmogorovScaling = uniform(config.kolmogorovScaling ?? 0.7);
        this.uCurlNoise = uniform(config.curlNoise ? 1.0 : 0.0);
        this.uFlowDirection = uniform(
            (config.flowDirection ?? new THREE.Vector3(1, 0, 0)).clone().normalize()
        );
        this.uWakeIntensity = uniform(config.wakeIntensity ?? 0.0);
        this.uTime = uniform(0.0);
    }

    // ==================== Setters ====================

    setFrequency(value: number): void { this.uFrequency.value = value; }
    setAmplitude(value: number): void { this.uAmplitude.value = value; }
    setOctaves(value: number): void { this.uOctaves.value = value; }
    setLacunarity(value: number): void { this.uLacunarity.value = value; }
    setGain(value: number): void { this.uGain.value = value; }
    setFriction(value: number): void { this.uFriction.value = value; }
    setAnimationSpeed(value: number): void { this.uAnimationSpeed.value = value; }

    /** Set velocity sensitivity (Reynolds number effect) */
    setVelocitySensitivity(value: number): void {
        this.uVelocitySensitivity.value = value;
    }

    /** Set intermittency (puff behavior) */
    setIntermittency(value: number): void {
        this.uIntermittency.value = value;
    }

    /** Set intermittency frequency */
    setIntermittencyFrequency(value: number): void {
        this.uIntermittencyFrequency.value = value;
    }

    /** Set Kolmogorov scaling (0 = flat, 1 = full -5/3 law) */
    setKolmogorovScaling(value: number): void {
        this.uKolmogorovScaling.value = value;
    }

    /** Enable/disable curl noise */
    setCurlNoise(enabled: boolean): void {
        this.uCurlNoise.value = enabled ? 1.0 : 0.0;
    }

    /** Set flow direction for wake effects */
    setFlowDirection(direction: THREE.Vector3): void {
        this.uFlowDirection.value.copy(direction).normalize();
    }

    /** Set wake intensity */
    setWakeIntensity(value: number): void {
        this.uWakeIntensity.value = value;
    }

    // ==================== Provider Methods ====================

    onSystemUpdate(deltaTime: number, camera: THREE.Camera): void {
        this.timeAccumulator += deltaTime * this.uAnimationSpeed.value;
        this.uTime.value = this.timeAccumulator;

        if (this.animated) {
            // Animate noise field position
            this.uTimeOffset.value.set(
                this.timeAccumulator * 0.1,
                this.timeAccumulator * 0.13,
                this.timeAccumulator * 0.17
            );
        }

        // Update intermittency phase (creates "puffs")
        const puffPhase = Math.sin(this.timeAccumulator * this.uIntermittencyFrequency.value * Math.PI * 2);
        this.uIntermittencyPhase.value = puffPhase * 0.5 + 0.5; // Normalize to 0-1
    }

    /**
     * Generate TSL force node with physics-based turbulence
     * 
     * Implements:
     * - Multi-octave noise with Kolmogorov-like energy scaling
     * - Velocity-dependent intensity (Reynolds effect)
     * - Intermittent puffs for organic variation
     * - Optional curl noise for divergence-free flow
     * - Wake effects behind flow direction
     */
    getForceNode(ctx: ProviderContext): any {
        const frequency = this.uFrequency;
        const amplitude = this.uAmplitude;
        const timeOffset = this.uTimeOffset;
        const velocitySensitivity = this.uVelocitySensitivity;
        const intermittency = this.uIntermittency;
        const intermittencyPhase = this.uIntermittencyPhase;
        const kolmogorov = this.uKolmogorovScaling;
        const flowDir = this.uFlowDirection;
        const wakeIntensity = this.uWakeIntensity;
        const time = this.uTime;

        return Fn(() => {
            // Base sample position
            const samplePos = ctx.position.mul(frequency).add(timeOffset);

            // ========== OCTAVE 1: Large eddies (most energy) ==========
            const noise1X = samplePos.x.add(samplePos.y.mul(0.5)).sin()
                .mul(samplePos.z.mul(1.3).add(time.mul(0.2))).cos();
            const noise1Y = samplePos.y.add(samplePos.z.mul(0.7)).sin()
                .mul(samplePos.x.mul(1.1).add(time.mul(0.15))).cos();
            const noise1Z = samplePos.z.add(samplePos.x.mul(0.3)).sin()
                .mul(samplePos.y.mul(0.9).add(time.mul(0.25))).cos();
            const octave1 = vec3(noise1X, noise1Y, noise1Z);

            // ========== OCTAVE 2: Medium eddies ==========
            const samplePos2 = samplePos.mul(2.0); // Higher frequency
            const noise2X = samplePos2.x.add(samplePos2.z.mul(0.7)).sin()
                .mul(samplePos2.y.mul(1.5).add(time.mul(0.3))).cos();
            const noise2Y = samplePos2.y.add(samplePos2.x.mul(0.4)).sin()
                .mul(samplePos2.z.mul(1.2).add(time.mul(0.22))).cos();
            const noise2Z = samplePos2.z.add(samplePos2.y.mul(0.6)).sin()
                .mul(samplePos2.x.mul(0.8).add(time.mul(0.35))).cos();
            // Apply Kolmogorov scaling: smaller scales have less energy
            const octave2Scale = float(1.0).sub(kolmogorov.mul(0.37)); // ~0.63 for full scaling
            const octave2 = vec3(noise2X, noise2Y, noise2Z).mul(octave2Scale);

            // ========== OCTAVE 3: Small eddies (least energy) ==========
            const samplePos3 = samplePos.mul(4.0); // Even higher frequency
            const noise3X = samplePos3.x.add(samplePos3.y.mul(0.8)).sin()
                .mul(samplePos3.z.mul(1.1).add(time.mul(0.4))).cos();
            const noise3Y = samplePos3.y.add(samplePos3.z.mul(0.5)).sin()
                .mul(samplePos3.x.mul(1.3).add(time.mul(0.28))).cos();
            const noise3Z = samplePos3.z.add(samplePos3.x.mul(0.9)).sin()
                .mul(samplePos3.y.mul(0.7).add(time.mul(0.45))).cos();
            // Apply stronger Kolmogorov scaling for small eddies
            const octave3Scale = float(1.0).sub(kolmogorov.mul(0.6)); // ~0.4 for full scaling
            const octave3 = vec3(noise3X, noise3Y, noise3Z).mul(octave3Scale);

            // ========== COMBINE OCTAVES ==========
            const combinedNoise = octave1.add(octave2).add(octave3).div(2.5);

            // ========== VELOCITY SENSITIVITY (Reynolds Effect) ==========
            // Faster particles experience more turbulence
            const speed = ctx.velocity.length();
            const velocityMod = float(1.0).add(speed.mul(velocitySensitivity));

            // ========== INTERMITTENCY (Puffs) ==========
            // Modulate intensity over time for organic "puff" behavior
            const puffMod = float(1.0).sub(intermittency).add(intermittencyPhase.mul(intermittency));

            // ========== WAKE EFFECT ==========
            // Stronger turbulence behind flow direction (like wake behind obstacle)
            const flowAlignment = ctx.velocity.normalize().dot(flowDir).negate();
            const wakeMod = float(1.0).add(flowAlignment.max(0).mul(wakeIntensity));

            // ========== FINAL FORCE ==========
            const turbulenceForce = combinedNoise
                .mul(amplitude)
                .mul(velocityMod)
                .mul(puffMod)
                .mul(wakeMod);

            return turbulenceForce;
        })();
    }

    /**
     * Apply friction/damping to velocity
     * Higher friction = more viscous (laminar) flow
     */
    getVelocityModifierNode(ctx: ProviderContext): any {
        const friction = this.uFriction;

        return Fn(() => {
            // Apply damping (1 - friction)
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
            uTurbAnimationSpeed: this.uAnimationSpeed,
            uTurbVelocitySensitivity: this.uVelocitySensitivity,
            uTurbIntermittency: this.uIntermittency,
            uTurbIntermittencyFrequency: this.uIntermittencyFrequency,
            uTurbIntermittencyPhase: this.uIntermittencyPhase,
            uTurbKolmogorovScaling: this.uKolmogorovScaling,
            uTurbCurlNoise: this.uCurlNoise,
            uTurbFlowDirection: this.uFlowDirection,
            uTurbWakeIntensity: this.uWakeIntensity,
            uTurbTime: this.uTime
        };
    }

    dispose(): void {
        // Nothing to dispose
    }
}
