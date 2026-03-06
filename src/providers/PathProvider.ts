import * as THREE from 'three';
import { uniform, uniformArray, vec3, float, Fn, Loop, If, select } from 'three/tsl';
import { BaseProvider, ProviderContext } from './BaseProvider.js';

/**
 * Configuration for path following behavior
 */
export interface PathConfig {
    /** Points defining the path (minimum 2) */
    pathPoints?: THREE.Vector3[];
    /** Strength of attraction toward path */
    attraction?: number;
    /** How strongly to align with path direction */
    alignment?: number;
    /** Whether to loop the path */
    loop?: boolean;
    /** How far from path particles can wander */
    spread?: number;
    /** Speed along the path */
    speed?: number;
}

/**
 * Path provider that guides particles along a predefined path
 * Particles are attracted toward the closest path segment and pushed along its direction
 */
export class PathProvider extends BaseProvider {
    name = 'PathProvider';
    priority = 38;

    // Path data
    private pathPoints: THREE.Vector3[] = [];
    private pathDirections: THREE.Vector3[] = [];
    private pathLengths: number[] = [];
    private totalLength: number = 0;

    // Uniforms
    private uAttraction: any;
    private uAlignment: any;
    private uSpread: any;
    private uSpeed: any;
    private uLoop: any;
    private uTime: any;

    // GPU path representation
    private readonly maxPathPoints: number = 32;
    private uPathPoints: any;
    private uPathSegmentCount: any;

    private timeAccumulator: number = 0;

    constructor(config: PathConfig = {}) {
        super();

        this.uAttraction = uniform(config.attraction ?? 2.0);
        this.uAlignment = uniform(config.alignment ?? 1.0);
        this.uSpread = uniform(config.spread ?? 1.0);
        this.uSpeed = uniform(config.speed ?? 1.0);
        this.uLoop = uniform(config.loop ? 1.0 : 0.0);
        this.uTime = uniform(0.0);

        const defaultPoints = Array(this.maxPathPoints).fill(null).map(() => new THREE.Vector3(0, 0, 0));
        this.uPathPoints = uniformArray(defaultPoints);
        this.uPathSegmentCount = uniform(1);

        // Set initial path
        if (config.pathPoints && config.pathPoints.length >= 2) {
            this.setPath(config.pathPoints);
        } else {
            // Default simple path
            this.setPath([
                new THREE.Vector3(-5, 0, 0),
                new THREE.Vector3(0, 3, 0),
                new THREE.Vector3(5, 0, 0)
            ]);
        }
    }

    /**
     * Set the path points
     */
    setPath(points: THREE.Vector3[]): void {
        if (points.length < 2) {
            console.warn('PathProvider: Path must have at least 2 points');
            return;
        }

        if (points.length > this.maxPathPoints) {
            console.warn(`PathProvider: Path has ${points.length} points, truncating to ${this.maxPathPoints}`);
        }

        this.pathPoints = points.slice(0, this.maxPathPoints).map(p => p.clone());

        // Calculate directions and segment lengths
        this.pathDirections = [];
        this.pathLengths = [];
        this.totalLength = 0;

        for (let i = 0; i < this.pathPoints.length - 1; i++) {
            const dir = this.pathPoints[i + 1].clone().sub(this.pathPoints[i]);
            const len = dir.length();
            this.pathLengths.push(len);
            this.totalLength += len;
            this.pathDirections.push(len > 0 ? dir.normalize() : new THREE.Vector3(1, 0, 0));
        }

        this.syncPathUniforms();
    }

    private syncPathUniforms(): void {
        const count = this.pathPoints.length;
        const lastPoint = count > 0 ? this.pathPoints[count - 1] : new THREE.Vector3(0, 0, 0);

        for (let i = 0; i < this.maxPathPoints; i++) {
            const point = i < count ? this.pathPoints[i] : lastPoint;
            this.uPathPoints.array[i].copy(point);
        }

        const segmentCount = Math.max(1, count - 1);
        this.uPathSegmentCount.value = Math.min(segmentCount, this.maxPathPoints - 1);
    }

    setAttraction(value: number): void {
        this.uAttraction.value = value;
    }

    setAlignment(value: number): void {
        this.uAlignment.value = value;
    }

    setSpread(value: number): void {
        this.uSpread.value = value;
    }

    setSpeed(value: number): void {
        this.uSpeed.value = value;
    }

    setLoop(loop: boolean): void {
        this.uLoop.value = loop ? 1.0 : 0.0;
    }

    onSystemUpdate(deltaTime: number, camera: THREE.Camera): void {
        this.timeAccumulator += deltaTime;
        this.uTime.value = this.timeAccumulator;
    }

    /**
     * Find the closest point on the path to a given position
     * Returns [closestPoint, direction, t (0-1 along path)]
     */
    private findClosestPathPoint(position: THREE.Vector3): { point: THREE.Vector3; direction: THREE.Vector3; t: number } {
        let closestDist = Infinity;
        let closestPoint = this.pathPoints[0].clone();
        let closestDir = this.pathDirections[0]?.clone() || new THREE.Vector3(1, 0, 0);
        let closestT = 0;

        let accumulatedLength = 0;

        for (let i = 0; i < this.pathPoints.length - 1; i++) {
            const segStart = this.pathPoints[i];
            const segDir = this.pathDirections[i];
            const segLen = this.pathLengths[i];

            // Project position onto segment
            const toPos = position.clone().sub(segStart);
            const proj = toPos.dot(segDir);
            const clampedProj = Math.max(0, Math.min(segLen, proj));

            const pointOnSeg = segStart.clone().add(segDir.clone().multiplyScalar(clampedProj));
            const dist = position.distanceTo(pointOnSeg);

            if (dist < closestDist) {
                closestDist = dist;
                closestPoint = pointOnSeg;
                closestDir = segDir.clone();
                closestT = this.totalLength > 0 ? (accumulatedLength + clampedProj) / this.totalLength : 0;
            }

            accumulatedLength += segLen;
        }

        return { point: closestPoint, direction: closestDir, t: closestT };
    }

    /**
     * Generate TSL force calculation node
     * Uses uniformArray path points and loops over all active segments.
     */
    getForceNode(ctx: ProviderContext): any {
        const attraction = this.uAttraction;
        const alignment = this.uAlignment;
        const spread = this.uSpread;
        const speed = this.uSpeed;
        const pathPoints = this.uPathPoints;
        const pathSegmentCount = this.uPathSegmentCount;

        return Fn(() => {
            const closestDistSq = float(1e9).toVar();
            const closestPoint = vec3(0, 0, 0).toVar();
            const closestDir = vec3(1, 0, 0).toVar();

            Loop(pathSegmentCount, ({ i }) => {
                const segStart = pathPoints.element(i);
                const segEnd = pathPoints.element(i.add(1));

                const segVec = segEnd.sub(segStart);
                const segLen = segVec.length().max(0.0001);
                const segDir = segVec.div(segLen);

                const toPos = ctx.position.sub(segStart);
                const proj = toPos.dot(segDir).clamp(0, segLen);
                const pointOnSeg = segStart.add(segDir.mul(proj));

                const toPath = pointOnSeg.sub(ctx.position);
                const distSq = toPath.dot(toPath);

                If(distSq.lessThan(closestDistSq), () => {
                    closestDistSq.assign(distSq);
                    closestPoint.assign(pointOnSeg);
                    closestDir.assign(segDir);
                });
            });

            // Attraction force toward closest path point
            const toPath = closestPoint.sub(ctx.position);
            const distToPath = toPath.length();
            const toPathDir = select(
                distToPath.greaterThan(float(1e-5)),
                toPath.div(distToPath),
                vec3(0, 0, 0)
            );
            const attractForce = toPathDir.mul(attraction).mul(distToPath.div(spread).min(1));

            // Alignment force along closest segment direction
            const alignForce = closestDir.mul(alignment).mul(speed);

            return attractForce.add(alignForce);
        })();
    }

    getUniforms(): Record<string, any> {
        return {
            uPathAttraction: this.uAttraction,
            uPathAlignment: this.uAlignment,
            uPathSpread: this.uSpread,
            uPathSpeed: this.uSpeed,
            uPathLoop: this.uLoop,
            uPathTime: this.uTime,
            uPathPoints: this.uPathPoints,
            uPathSegmentCount: this.uPathSegmentCount
        };
    }

    dispose(): void {
        this.pathPoints = [];
        this.pathDirections = [];
        this.pathLengths = [];
    }
}
