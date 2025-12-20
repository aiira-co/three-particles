import { float, Fn, pow, smoothstep, sub, mul, add, min, max } from 'three/tsl';

/**
 * Preset curve types for particle property interpolation over lifetime
 */
export type CurvePreset =
    | 'linear'      // t
    | 'easeIn'      // t²
    | 'easeOut'     // 1 - (1-t)²
    | 'easeInOut'   // Smooth S-curve
    | 'easeInCubic' // t³
    | 'easeOutCubic'// 1 - (1-t)³
    | 'easeInQuart' // t⁴
    | 'easeOutQuart'// 1 - (1-t)⁴
    | 'bounce'      // Bounce effect
    | 'elastic'     // Spring effect
    | 'custom';     // Custom control points (future)

/**
 * Control point for custom curves
 */
export interface CurvePoint {
    time: number;  // 0-1 (normalized age)
    value: number; // 0-1 (interpolation factor)
}

/**
 * Lifetime curve configuration
 * Controls how a property interpolates from start to end over particle lifetime
 */
export interface LifetimeCurveConfig {
    preset?: CurvePreset;
    /** Custom control points (future support) */
    points?: CurvePoint[];
}

/**
 * LifetimeCurve - Easing functions for particle property interpolation
 * 
 * Inspired by Unreal Engine Niagara's Float from Curve system.
 * All curves take normalized age (0-1) and return an interpolation factor (0-1).
 * 
 * Usage:
 * ```typescript
 * const curve = new LifetimeCurve('easeOut');
 * const easedProgress = curve.sample(normalizedAge);
 * const value = mix(startValue, endValue, easedProgress);
 * ```
 */
export class LifetimeCurve {
    readonly preset: CurvePreset;
    private points: CurvePoint[];

    constructor(config: LifetimeCurveConfig | CurvePreset = 'linear') {
        if (typeof config === 'string') {
            this.preset = config;
            this.points = [];
        } else {
            this.preset = config.preset || 'linear';
            this.points = config.points || [];
        }
    }

    /**
     * Sample the curve at the given normalized age (0-1)
     * Returns a TSL node representing the interpolation factor
     * 
     * @param t - Normalized particle age (0 = birth, 1 = death)
     * @returns TSL node with value 0-1
     */
    sample(t: any): any {
        return this.getSampleFunction()(t);
    }

    /**
     * Get the TSL easing function for this curve
     */
    private getSampleFunction(): (t: any) => any {
        switch (this.preset) {
            case 'linear':
                return (t) => t;

            case 'easeIn':
                // Quadratic ease in: t²
                return (t) => pow(t, float(2));

            case 'easeOut':
                // Quadratic ease out: 1 - (1-t)²
                return (t) => sub(float(1), pow(sub(float(1), t), float(2)));

            case 'easeInOut':
                // Smooth S-curve: 3t² - 2t³ (equivalent to smoothstep(0,1,t))
                return (t) => smoothstep(float(0), float(1), t);

            case 'easeInCubic':
                // Cubic ease in: t³
                return (t) => pow(t, float(3));

            case 'easeOutCubic':
                // Cubic ease out: 1 - (1-t)³
                return (t) => sub(float(1), pow(sub(float(1), t), float(3)));

            case 'easeInQuart':
                // Quartic ease in: t⁴
                return (t) => pow(t, float(4));

            case 'easeOutQuart':
                // Quartic ease out: 1 - (1-t)⁴
                return (t) => sub(float(1), pow(sub(float(1), t), float(4)));

            case 'bounce':
                // Simplified bounce approximation using smoothstep
                // Real bounce would need more complex math
                return (t) => {
                    const bounce1 = smoothstep(float(0), float(0.4), t);
                    const bounce2 = smoothstep(float(0.4), float(0.7), t);
                    const bounce3 = smoothstep(float(0.7), float(1), t);
                    // Combine bounces with diminishing amplitude
                    return min(float(1), add(
                        mul(bounce1, float(0.7)),
                        mul(bounce2, float(0.2)),
                        mul(bounce3, float(0.1))
                    ));
                };

            case 'elastic':
                // Simplified elastic approximation
                // Real elastic uses sin - would need more TSL math
                return (t) => {
                    // Overshoot then settle: smoothstep with slight correction
                    const base = smoothstep(float(0), float(1), t);
                    const overshoot = mul(
                        sub(float(1), t),
                        mul(t, float(0.3))
                    );
                    return add(base, overshoot);
                };

            case 'custom':
                // Cubic Bezier interpolation using control points
                return this.getCustomBezierFunction();

            default:
                return (t) => t;
        }
    }

    /**
     * Get cubic Bezier sampling function for custom curves
     * Uses the y-coordinates of control points for value interpolation
     */
    private getCustomBezierFunction(): (t: any) => any {
        // Ensure we have 4 control points for cubic Bezier
        if (this.points.length !== 4) {
            // Fall back to linear if not enough points
            return (t) => t;
        }

        // Extract y-values (the interpolation values) from control points
        const p0y = float(this.points[0].value);
        const p1y = float(this.points[1].value);
        const p2y = float(this.points[2].value);
        const p3y = float(this.points[3].value);

        // Cubic Bezier formula: B(t) = (1-t)³P0 + 3(1-t)²tP1 + 3(1-t)t²P2 + t³P3
        return (t: any) => {
            const oneMinusT = sub(float(1), t);
            const oneMinusT2 = mul(oneMinusT, oneMinusT);
            const oneMinusT3 = mul(oneMinusT2, oneMinusT);
            const t2 = mul(t, t);
            const t3 = mul(t2, t);

            // (1-t)³ * P0
            const term0 = mul(oneMinusT3, p0y);
            // 3 * (1-t)² * t * P1
            const term1 = mul(mul(float(3), mul(oneMinusT2, t)), p1y);
            // 3 * (1-t) * t² * P2
            const term2 = mul(mul(float(3), mul(oneMinusT, t2)), p2y);
            // t³ * P3
            const term3 = mul(t3, p3y);

            return add(add(add(term0, term1), term2), term3);
        };
    }

    /**
     * Create a curve from preset name
     */
    static fromPreset(preset: CurvePreset): LifetimeCurve {
        return new LifetimeCurve(preset);
    }

    /**
     * Get list of available presets
     */
    static getPresets(): CurvePreset[] {
        return [
            'linear',
            'easeIn',
            'easeOut',
            'easeInOut',
            'easeInCubic',
            'easeOutCubic',
            'easeInQuart',
            'easeOutQuart',
            'bounce',
            'elastic'
        ];
    }
}

export default LifetimeCurve;
