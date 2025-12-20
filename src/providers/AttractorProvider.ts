import * as THREE from 'three';
import { uniform, uniformArray, vec3, float, Fn, Loop } from 'three/tsl';
import { BaseProvider, ProviderContext } from './BaseProvider.js';

/**
 * Configuration for a single attractor/force field
 */
export interface AttractorConfig {
    /** Position of the attractor */
    position: THREE.Vector3;
    /** Strength of the gravitational pull (higher = stronger) */
    strength: number;
    /** Optional spin axis for vortex-like motion */
    spinAxis?: THREE.Vector3;
    /** Spin strength multiplier */
    spinStrength?: number;
    /** Type of falloff: 'linear', 'inverse', 'inverseSq' (default) */
    falloff?: 'linear' | 'inverse' | 'inverseSq';
}

/**
 * Force field provider that creates gravitational/magnetic attractors
 * Based on Three.js webgpu_tsl_compute_attractors_particles example
 */
export class AttractorProvider extends BaseProvider {
    name = 'AttractorProvider';
    priority = 50;

    private attractors: AttractorConfig[] = [];
    private maxAttractors: number;

    // Uniforms
    private uPositions: any;
    private uStrengths: any;
    private uSpinAxes: any;
    private uSpinStrengths: any;
    private uCount: any;

    constructor(maxAttractors: number = 8) {
        super();
        this.maxAttractors = maxAttractors;

        // Initialize uniform arrays with correct types for TSL
        const defaultPositions = Array(maxAttractors).fill(null).map(() => new THREE.Vector3(0, 0, 0));
        const defaultAxes = Array(maxAttractors).fill(null).map(() => new THREE.Vector3(0, 1, 0));
        const defaultStrengths = Array(maxAttractors).fill(0) as number[];
        const defaultSpinStrengths = Array(maxAttractors).fill(0) as number[];

        this.uPositions = uniformArray(defaultPositions);
        this.uSpinAxes = uniformArray(defaultAxes);
        this.uStrengths = uniformArray(defaultStrengths);
        this.uSpinStrengths = uniformArray(defaultSpinStrengths);
        this.uCount = uniform(0, 'uint');
    }

    /**
     * Add an attractor/force field
     */
    addAttractor(config: AttractorConfig): number {
        if (this.attractors.length >= this.maxAttractors) {
            console.warn(`AttractorProvider: Max attractors (${this.maxAttractors}) reached`);
            return -1;
        }

        const index = this.attractors.length;
        this.attractors.push({
            ...config,
            spinAxis: config.spinAxis?.clone().normalize() || new THREE.Vector3(0, 1, 0),
            spinStrength: config.spinStrength || 0,
            falloff: config.falloff || 'inverseSq'
        });

        this.syncUniforms();
        return index;
    }

    /**
     * Update an existing attractor
     */
    updateAttractor(index: number, config: Partial<AttractorConfig>): void {
        if (index < 0 || index >= this.attractors.length) return;

        const attractor = this.attractors[index];
        if (config.position) attractor.position.copy(config.position);
        if (config.strength !== undefined) attractor.strength = config.strength;
        if (config.spinAxis) attractor.spinAxis = config.spinAxis.clone().normalize();
        if (config.spinStrength !== undefined) attractor.spinStrength = config.spinStrength;
        if (config.falloff) attractor.falloff = config.falloff;

        this.syncUniforms();
    }

    /**
     * Remove an attractor
     */
    removeAttractor(index: number): void {
        if (index < 0 || index >= this.attractors.length) return;
        this.attractors.splice(index, 1);
        this.syncUniforms();
    }

    /**
     * Clear all attractors
     */
    clearAttractors(): void {
        this.attractors = [];
        this.syncUniforms();
    }

    private syncUniforms(): void {
        for (let i = 0; i < this.attractors.length; i++) {
            const a = this.attractors[i];
            this.uPositions.array[i].copy(a.position);
            this.uSpinAxes.array[i].copy(a.spinAxis!);
            this.uStrengths.array[i] = a.strength;
            this.uSpinStrengths.array[i] = a.spinStrength!;
        }
        this.uCount.value = this.attractors.length;
    }

    /**
     * Generate TSL force calculation node
     */
    getForceNode(ctx: ProviderContext): any {
        const positions = this.uPositions;
        const strengths = this.uStrengths;
        const spinAxes = this.uSpinAxes;
        const spinStrengths = this.uSpinStrengths;
        const count = this.uCount;

        return Fn(() => {
            const force = vec3(0, 0, 0).toVar();

            Loop(count, ({ i }) => {
                const attractorPos = positions.element(i);
                const strength = strengths.element(i);
                const spinAxis = spinAxes.element(i);
                const spinStrength = spinStrengths.element(i);

                // Direction to attractor
                const toAttractor = attractorPos.sub(ctx.position);
                const distance = toAttractor.length();
                const direction = toAttractor.normalize();

                // Gravitational force (inverse square falloff)
                const gravityStrength = strength.div(distance.pow(2).max(0.1));
                force.addAssign(direction.mul(gravityStrength));

                // Spinning force (cross product for angular velocity)
                const spinForce = spinAxis.cross(toAttractor).mul(spinStrength).mul(gravityStrength);
                force.addAssign(spinForce);
            });

            return force;
        })();
    }

    getUniforms(): Record<string, any> {
        return {
            uAttractorPositions: this.uPositions,
            uAttractorStrengths: this.uStrengths,
            uAttractorSpinAxes: this.uSpinAxes,
            uAttractorSpinStrengths: this.uSpinStrengths,
            uAttractorCount: this.uCount
        };
    }

    dispose(): void {
        this.attractors = [];
    }
}
