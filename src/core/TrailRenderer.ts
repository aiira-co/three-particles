import * as THREE from 'three';
import {
    storage, Fn, instanceIndex, float, vec3, vec4, uniform,
    positionLocal, normalize, cross, cameraPosition, select,
    length as tslLength, mix
} from 'three/tsl';
import { MeshBasicNodeMaterial, WebGPURenderer, StorageInstancedBufferAttribute } from 'three/webgpu';

/**
 * TrailRenderer - Renders ribbon trails for particles
 * 
 * Creates a triangle strip mesh that follows each particle's position history.
 * The trail fades from head (current position) to tail (oldest position).
 */
export class TrailRenderer {
    private mesh: THREE.Mesh;
    private maxParticles: number;
    private segments: number;
    private trailWidth: number;
    private fadeAlpha: boolean;

    // GPU Storage for trail positions (ring buffer)
    private trailPositions!: StorageInstancedBufferAttribute;
    private trailHeadIndices!: StorageInstancedBufferAttribute;
    private trailPositionsNode: any;
    private trailHeadIndicesNode: any;

    // Uniforms
    private uTime: any;
    private uLastUpdateTime: any;
    private updateInterval: number;
    private lastUpdateTime = 0;

    // Source storage nodes (from particle system)
    private particlePositionsNode: any;
    private particleAgesNode: any;

    constructor(
        maxParticles: number,
        segments: number = 8,
        updateInterval: number = 0.02,
        trailWidth: number = 0.1,
        fadeAlpha: boolean = true
    ) {
        this.maxParticles = maxParticles;
        this.segments = segments;
        this.updateInterval = updateInterval;
        this.trailWidth = trailWidth;
        this.fadeAlpha = fadeAlpha;

        // Initialize storage buffers
        this.initializeStorage();

        // Create trail mesh
        this.mesh = this.createTrailMesh();
    }

    private initializeStorage(): void {
        // Trail positions: maxParticles * segments positions (vec3 each)
        this.trailPositions = new StorageInstancedBufferAttribute(this.maxParticles * this.segments, 3);
        this.trailPositionsNode = storage(this.trailPositions, 'vec3', this.maxParticles * this.segments);

        // Head indices: one per particle (which segment is the current head)
        this.trailHeadIndices = new StorageInstancedBufferAttribute(this.maxParticles, 1);
        this.trailHeadIndicesNode = storage(this.trailHeadIndices, 'float', this.maxParticles);

        // Uniforms
        this.uTime = uniform(0);
        this.uLastUpdateTime = uniform(0);
    }

    /**
     * Set the particle system's storage nodes for reading positions
     */
    private computeNode: any;

    /**
     * Set the particle system's storage nodes for reading positions
     */
    setParticleStorage(positionsNode: any, agesNode: any): void {
        this.particlePositionsNode = positionsNode;
        this.particleAgesNode = agesNode;

        // Now that we have source nodes, build the compute shader
        this.computeNode = this.buildTrailUpdateCompute().compute(this.maxParticles);
    }

    private createTrailMesh(): THREE.Mesh {
        // Create geometry with vertices for all trail ribbons
        // Each particle has (segments) points, each point has 2 vertices (for ribbon width)
        const verticesPerParticle = this.segments * 2;
        const totalVertices = this.maxParticles * verticesPerParticle;

        // Position attribute (will be computed in vertex shader)
        const positions = new Float32Array(totalVertices * 3);

        // UVs for alpha gradient: U = particle progress, V = segment progress (0 = head, 1 = tail)
        const uvs = new Float32Array(totalVertices * 2);

        // Particle index and segment index attributes
        const particleIndices = new Float32Array(totalVertices);
        const segmentIndices = new Float32Array(totalVertices);
        const sideIndices = new Float32Array(totalVertices); // 0 = left, 1 = right

        for (let p = 0; p < this.maxParticles; p++) {
            for (let s = 0; s < this.segments; s++) {
                const baseIdx = (p * this.segments + s) * 2;

                // Left vertex
                particleIndices[baseIdx] = p;
                segmentIndices[baseIdx] = s;
                sideIndices[baseIdx] = 0;
                uvs[baseIdx * 2] = 0;
                uvs[baseIdx * 2 + 1] = s / (this.segments - 1);

                // Right vertex
                particleIndices[baseIdx + 1] = p;
                segmentIndices[baseIdx + 1] = s;
                sideIndices[baseIdx + 1] = 1;
                uvs[(baseIdx + 1) * 2] = 1;
                uvs[(baseIdx + 1) * 2 + 1] = s / (this.segments - 1);
            }
        }

        // Create indices for triangle strips (converted to triangles)
        const indicesPerParticle = (this.segments - 1) * 6; // 2 triangles per quad, 3 indices per triangle
        const indices = new Uint32Array(this.maxParticles * indicesPerParticle);

        for (let p = 0; p < this.maxParticles; p++) {
            const vertexOffset = p * this.segments * 2;
            const indexOffset = p * indicesPerParticle;

            for (let s = 0; s < this.segments - 1; s++) {
                const i = indexOffset + s * 6;
                const v = vertexOffset + s * 2;

                // Two triangles forming a quad
                indices[i] = v;
                indices[i + 1] = v + 1;
                indices[i + 2] = v + 2;

                indices[i + 3] = v + 1;
                indices[i + 4] = v + 3;
                indices[i + 5] = v + 2;
            }
        }

        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
        geometry.setAttribute('particleIndex', new THREE.BufferAttribute(particleIndices, 1));
        geometry.setAttribute('segmentIndex', new THREE.BufferAttribute(segmentIndices, 1));
        geometry.setAttribute('sideIndex', new THREE.BufferAttribute(sideIndices, 1));
        geometry.setIndex(new THREE.BufferAttribute(indices, 1));

        // Create material with TSL shaders
        const material = this.createTrailMaterial();

        const mesh = new THREE.Mesh(geometry, material);
        mesh.frustumCulled = false;
        return mesh;
    }

    private createTrailMaterial(): MeshBasicNodeMaterial {
        const material = new MeshBasicNodeMaterial({
            transparent: true,
            depthWrite: false,
            blending: THREE.AdditiveBlending,
            side: THREE.DoubleSide
        });

        const segments = this.segments;
        const trailWidth = this.trailWidth;
        const fadeAlpha = this.fadeAlpha;
        const trailPositionsNode = this.trailPositionsNode;
        const trailHeadIndicesNode = this.trailHeadIndicesNode;

        // Vertex shader: compute ribbon vertex positions from trail history
        material.positionNode = Fn(() => {
            // Get data from attributes (stored in positionLocal xyz)
            const particleIdx = positionLocal.x;
            const segmentIdx = positionLocal.y;
            const sideIdx = positionLocal.z; // 0 or 1

            // Ring buffer logic:
            // headIdx is where the LATEST position was written.
            // We want to read from headIdx backwards based on segmentIdx.
            // readIdx = (headIdx - segmentIdx + segments) % segments
            const headIdx = trailHeadIndicesNode.element(particleIdx);

            // Note: Use float conversion for modulo to be safe in TSL across platforms
            const offset = float(segments).sub(segmentIdx);
            const readSegment = headIdx.add(offset).mod(float(segments)).toVar();
            const storageIdx = particleIdx.mul(float(segments)).add(readSegment).toInt();

            // Get current position (P0)
            const p0 = trailPositionsNode.element(storageIdx);

            // Calculate direction for ribbon width
            // We need P1 (next point in trail, i.e., older point) to determine direction
            // So P0 is at segmentIdx. P1 is at segmentIdx + 1 (older).

            // Let's get "next" segment index (older position)
            const nextSegmentOffset = offset.sub(1);
            const nextReadSegment = headIdx.add(nextSegmentOffset).mod(float(segments));
            const nextStorageIdx = particleIdx.mul(float(segments)).add(nextReadSegment).toInt();
            const p1 = trailPositionsNode.element(nextStorageIdx);

            // Direction from P0 to P1 (to older)
            const dir = p0.sub(p1).normalize();

            // Safe fallback if zero length (no movement yet)
            const safeDir = select(tslLength(dir).greaterThan(0.001), dir, vec3(0, 1, 0));

            // View vector for billboarding
            const viewDir = cameraPosition.sub(p0).normalize();

            // Perpendicular vector (right)
            const right = cross(safeDir, viewDir).normalize();

            // Width offset
            const widthOffset = right.mul(float(trailWidth).mul(0.5));
            const finalOffset = select(sideIdx.equal(1), widthOffset, widthOffset.negate());

            return p0.add(finalOffset);
        })();

        // Fragment shader: apply alpha fade
        material.colorNode = Fn(() => {
            // Alpha fades from 1.0 at head (segment 0) to 0.0 at tail
            const segmentProgress = positionLocal.y.div(float(segments - 1));
            const alpha = fadeAlpha ? float(1).sub(segmentProgress) : float(1);

            return vec4(1, 1, 1, alpha);
        })();

        return material;
    }

    /**
     * Build the trail update compute shader
     */
    buildTrailUpdateCompute(): any {
        const segments = this.segments;
        const trailPositionsNode = this.trailPositionsNode;
        const trailHeadIndicesNode = this.trailHeadIndicesNode;
        const particlePositionsNode = this.particlePositionsNode;

        if (!particlePositionsNode) {
            console.warn('TrailRenderer: particlePositionsNode not set');
            return null;
        }

        return Fn(() => {
            const particleIdx = instanceIndex;

            // Get current particle position from main system
            const currentPos = particlePositionsNode.element(particleIdx);

            // Get current head index
            const headIdx = trailHeadIndicesNode.element(particleIdx);

            // Move head forward: (head + 1) % segments
            const newHeadIdx = headIdx.add(1).mod(float(segments));

            // Save new position at new head
            const storageIdx = particleIdx.mul(float(segments)).add(newHeadIdx).toInt();
            trailPositionsNode.element(storageIdx).assign(currentPos);

            // Update head index
            trailHeadIndicesNode.element(particleIdx).assign(newHeadIdx);
        })();
    }

    /**
     * Update trail positions (called each frame)
     */
    update(renderer: WebGPURenderer, deltaTime: number, currentTime: number): void {
        // Check if we should record a new trail position
        if (currentTime - this.lastUpdateTime >= this.updateInterval) {
            this.lastUpdateTime = currentTime;
            this.uTime.value = currentTime;

            // Run trail update compute shader
            if (this.computeNode) {
                renderer.compute(this.computeNode);
            }
        }
    }

    getMesh(): THREE.Mesh {
        return this.mesh;
    }

    getTrailPositionsNode(): any {
        return this.trailPositionsNode;
    }

    getTrailHeadIndicesNode(): any {
        return this.trailHeadIndicesNode;
    }

    getGPUMemory(): number {
        // Trail positions: maxParticles * segments * 3 * 4 bytes
        // Head indices: maxParticles * 4 bytes
        return (this.maxParticles * this.segments * 3 * 4) + (this.maxParticles * 4);
    }

    dispose(): void {
        this.mesh.geometry.dispose();
        if (this.mesh.material instanceof THREE.Material) {
            this.mesh.material.dispose();
        }
    }
}
