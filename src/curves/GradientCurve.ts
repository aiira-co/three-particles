import * as THREE from 'three';
import { vec3, vec4, float, mix, Fn, If, select } from 'three/tsl';
import { LifetimeCurve, CurvePreset } from './LifetimeCurve.js';

/**
 * A color stop in a gradient
 */
export interface GradientStop {
    /** Position in the gradient (0-1) */
    position: number;
    /** Color at this position */
    color: THREE.Color;
    /** Alpha at this position (default 1) */
    alpha?: number;
}

/**
 * Gradient configuration
 */
export interface GradientCurveConfig {
    /** Color stops (must have at least 2) */
    stops: GradientStop[];
    /** Easing between stops (default: linear) */
    interpolation?: CurvePreset;
}

/**
 * GradientCurve - Multi-stop color gradient for particle lifetime
 * 
 * Inspired by Unreal Engine Niagara's Color from Curve system.
 * Supports multiple color stops with configurable interpolation.
 * 
 * Usage:
 * ```typescript
 * const gradient = new GradientCurve({
 *   stops: [
 *     { position: 0, color: new THREE.Color(1, 0.3, 0.1), alpha: 1 },
 *     { position: 0.5, color: new THREE.Color(1, 0.8, 0.2), alpha: 1 },
 *     { position: 1, color: new THREE.Color(0.2, 0.1, 0.1), alpha: 0 }
 *   ]
 * });
 * const colorNode = gradient.sample(normalizedAge);
 * ```
 */
export class GradientCurve {
    private stops: GradientStop[];
    private interpolation: LifetimeCurve;
    private maxStops = 8; // Maximum stops for GPU uniform arrays

    constructor(config: GradientCurveConfig) {
        // Sort stops by position
        this.stops = [...config.stops].sort((a, b) => a.position - b.position);

        // Ensure at least 2 stops
        if (this.stops.length < 2) {
            throw new Error('GradientCurve requires at least 2 color stops');
        }

        // Limit stops for GPU performance
        if (this.stops.length > this.maxStops) {
            console.warn(`GradientCurve: Limiting to ${this.maxStops} stops for GPU performance`);
            this.stops = this.stops.slice(0, this.maxStops);
        }

        // Ensure first stop is at 0 and last at 1
        if (this.stops[0].position > 0) {
            this.stops.unshift({ ...this.stops[0], position: 0 });
        }
        if (this.stops[this.stops.length - 1].position < 1) {
            this.stops.push({ ...this.stops[this.stops.length - 1], position: 1 });
        }

        this.interpolation = new LifetimeCurve(config.interpolation || 'linear');
    }

    /**
     * Sample the gradient at the given normalized age (0-1)
     * Returns a TSL vec4 node (RGB + Alpha)
     * 
     * For GPU efficiency, this creates a chain of conditional interpolations.
     * 
     * @param t - Normalized particle age (0 = birth, 1 = death)
     * @returns TSL vec4 node with RGBA color
     */
    sample(t: any): any {
        // For 2 stops, simple mix
        if (this.stops.length === 2) {
            const s0 = this.stops[0];
            const s1 = this.stops[1];
            const easedT = this.interpolation.sample(t);

            return vec4(
                mix(float(s0.color.r), float(s1.color.r), easedT),
                mix(float(s0.color.g), float(s1.color.g), easedT),
                mix(float(s0.color.b), float(s1.color.b), easedT),
                mix(float(s0.alpha ?? 1), float(s1.alpha ?? 1), easedT)
            );
        }

        // For multiple stops, create segment-based interpolation
        return this.sampleMultiStop(t);
    }

    /**
     * Multi-stop gradient sampling using conditional TSL
     */
    private sampleMultiStop(t: any): any {
        // Build color from last segment working backwards
        // This creates a chain: if t >= p[n-1] then lerp(n-1, n) else if t >= p[n-2] then lerp(n-2, n-1) ...

        let result = this.getStopVec4(this.stops.length - 1);

        for (let i = this.stops.length - 2; i >= 0; i--) {
            const s0 = this.stops[i];
            const s1 = this.stops[i + 1];

            // Calculate local t within this segment
            const segmentStart = float(s0.position);
            const segmentEnd = float(s1.position);
            const segmentLength = segmentEnd.sub(segmentStart);
            const localT = t.sub(segmentStart).div(segmentLength).clamp(0, 1);
            const easedT = this.interpolation.sample(localT);

            // Interpolate within this segment
            const segmentColor = vec4(
                mix(float(s0.color.r), float(s1.color.r), easedT),
                mix(float(s0.color.g), float(s1.color.g), easedT),
                mix(float(s0.color.b), float(s1.color.b), easedT),
                mix(float(s0.alpha ?? 1), float(s1.alpha ?? 1), easedT)
            );

            // If t is in this segment, use this color, otherwise use result from higher segments
            const inSegment = t.lessThan(segmentEnd);
            result = select(inSegment, segmentColor, result);
        }

        return result;
    }

    /**
     * Get vec4 for a stop
     */
    private getStopVec4(index: number): any {
        const s = this.stops[index];
        return vec4(
            float(s.color.r),
            float(s.color.g),
            float(s.color.b),
            float(s.alpha ?? 1)
        );
    }

    /**
     * Sample just the RGB color (vec3)
     */
    sampleRGB(t: any): any {
        const rgba = this.sample(t);
        return vec3(rgba.x, rgba.y, rgba.z);
    }

    /**
     * Sample just the alpha (float)
     */
    sampleAlpha(t: any): any {
        const rgba = this.sample(t);
        return rgba.w;
    }

    /**
     * Get the stops (for UI display)
     */
    getStops(): GradientStop[] {
        return [...this.stops];
    }

    /**
     * Create a simple 2-color gradient
     */
    static fromColors(
        startColor: THREE.Color,
        endColor: THREE.Color,
        startAlpha = 1,
        endAlpha = 1,
        interpolation: CurvePreset = 'linear'
    ): GradientCurve {
        return new GradientCurve({
            stops: [
                { position: 0, color: startColor, alpha: startAlpha },
                { position: 1, color: endColor, alpha: endAlpha }
            ],
            interpolation
        });
    }

    /**
     * Create a fire-like gradient
     */
    static fire(): GradientCurve {
        return new GradientCurve({
            stops: [
                { position: 0, color: new THREE.Color(1, 1, 0.8), alpha: 1 },    // Bright yellow-white
                { position: 0.2, color: new THREE.Color(1, 0.8, 0.2), alpha: 1 }, // Yellow
                { position: 0.5, color: new THREE.Color(1, 0.3, 0.1), alpha: 0.8 }, // Orange
                { position: 0.8, color: new THREE.Color(0.6, 0.1, 0.05), alpha: 0.4 }, // Dark red
                { position: 1, color: new THREE.Color(0.2, 0.05, 0.02), alpha: 0 }  // Smoke
            ],
            interpolation: 'easeOut'
        });
    }

    /**
     * Create a smoke-like gradient
     */
    static smoke(): GradientCurve {
        return new GradientCurve({
            stops: [
                { position: 0, color: new THREE.Color(0.3, 0.3, 0.3), alpha: 0.8 },
                { position: 0.5, color: new THREE.Color(0.5, 0.5, 0.5), alpha: 0.4 },
                { position: 1, color: new THREE.Color(0.7, 0.7, 0.7), alpha: 0 }
            ],
            interpolation: 'easeOut'
        });
    }

    /**
     * Create a magic/energy gradient
     */
    static magic(): GradientCurve {
        return new GradientCurve({
            stops: [
                { position: 0, color: new THREE.Color(1, 1, 1), alpha: 1 },
                { position: 0.3, color: new THREE.Color(0.8, 0.4, 1), alpha: 0.9 },
                { position: 0.7, color: new THREE.Color(0.4, 0.1, 0.8), alpha: 0.5 },
                { position: 1, color: new THREE.Color(0.1, 0.02, 0.3), alpha: 0 }
            ],
            interpolation: 'easeOut'
        });
    }
}

export default GradientCurve;
