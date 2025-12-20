import * as THREE from 'three';
import { WebGPURenderer, StorageInstancedBufferAttribute } from 'three/webgpu';
import { Fn, storage, instanceIndex, vec3, vec4, float, Loop, If } from 'three/tsl';

/**
 * Configuration for particle trails/links
 */
export interface ParticleTrailsConfig {
    /** Maximum number of particles to connect */
    maxParticles: number;
    /** Number of connections per particle (default: 2) */
    connectionsPerParticle?: number;
    /** Width of trail lines (default: 0.01) */
    trailWidth?: number;
    /** Opacity falloff based on lifetime (default: true) */
    lifetimeFalloff?: boolean;
    /** Maximum distance for connections (default: 5) */
    maxConnectionDistance?: number;
}

/**
 * Particle trails/links feature
 * Based on Three.js webgpu_tsl_vfx_linkedparticles example
 * 
 * This creates quad-based connections between nearest particles.
 * The tricky part is that this requires separate geometry that is updated
 * by the compute shader alongside particle positions.
 * 
 * Usage:
 * 1. Create ParticleTrails with particle position storage
 * 2. Add the trails mesh to your scene
 * 3. Call updateCompute each frame (run the compute shader)
 * 4. The mesh will render the connections automatically
 */
export class ParticleTrails {
    private maxParticles: number;
    private connectionsPerParticle: number;
    private trailWidth: number;

    // Storage buffers for link vertices and colors
    private linksPositionsSBA: StorageInstancedBufferAttribute;
    private linksColorsSBA: StorageInstancedBufferAttribute;

    // The mesh to render
    public mesh: THREE.Mesh;

    // Compute node for updating links
    private updateLinksCompute: any = null;

    constructor(
        config: ParticleTrailsConfig,
        particlePositionsStorage: any,  // storage() node for particle positions
        particleLifetimesStorage: any   // storage() node for particle lifetimes
    ) {
        this.maxParticles = config.maxParticles;
        this.connectionsPerParticle = config.connectionsPerParticle ?? 2;
        this.trailWidth = config.trailWidth ?? 0.01;

        // Each particle connects to N neighbors
        // Each connection = 2 triangles = 6 vertices (but we use index buffer, so 4 verts per quad)
        const verticesPerParticle = this.connectionsPerParticle * 4;
        const totalVertices = this.maxParticles * verticesPerParticle;

        // Create storage buffers for link geometry
        this.linksPositionsSBA = new StorageInstancedBufferAttribute(
            new Float32Array(totalVertices * 4), // vec4 (xyz + padding)
            4
        );
        this.linksColorsSBA = new StorageInstancedBufferAttribute(
            new Float32Array(totalVertices * 4), // vec4 (rgb + alpha/lifetime)
            4
        );

        // Create geometry for links (indexed quad mesh)
        const geometry = new THREE.BufferGeometry();

        // Set up positions and colors as attributes
        geometry.setAttribute('position', this.linksPositionsSBA);
        geometry.setAttribute('color', this.linksColorsSBA);

        // Create index buffer for quads (2 triangles per quad)
        const indices = [];
        for (let i = 0; i < this.maxParticles * this.connectionsPerParticle; i++) {
            const baseVertex = i * 4;
            // Triangle 1: 0, 1, 2
            indices.push(baseVertex, baseVertex + 1, baseVertex + 2);
            // Triangle 2: 0, 2, 3
            indices.push(baseVertex, baseVertex + 2, baseVertex + 3);
        }
        geometry.setIndex(indices);

        // Create material for links
        const material = new THREE.MeshBasicMaterial({
            vertexColors: true,
            transparent: true,
            blending: THREE.AdditiveBlending,
            side: THREE.DoubleSide,
            depthWrite: false
        });

        this.mesh = new THREE.Mesh(geometry, material);
        this.mesh.frustumCulled = false;

        // Build the compute shader for updating links
        this.buildUpdateCompute(particlePositionsStorage, particleLifetimesStorage);
    }

    private buildUpdateCompute(
        particlePositions: any,
        particleLifetimes: any
    ): void {
        const linksPositions = storage(this.linksPositionsSBA, 'vec4', this.linksPositionsSBA.count);
        const linksColors = storage(this.linksColorsSBA, 'vec4', this.linksColorsSBA.count);
        const maxParticles = this.maxParticles;
        const connectionsPerParticle = this.connectionsPerParticle;
        const width = this.trailWidth;

        this.updateLinksCompute = Fn(() => {
            const position = particlePositions.element(instanceIndex).xyz;
            const lifetime = particleLifetimes.element(instanceIndex);

            // Find two closest particles using Loop
            const closestDist1 = float(10000.0).toVar();
            const closestPos1 = vec3(0.0).toVar();
            const closestLife1 = float(0.0).toVar();
            const closestDist2 = float(10000.0).toVar();
            const closestPos2 = vec3(0.0).toVar();
            const closestLife2 = float(0.0).toVar();

            Loop(maxParticles, ({ i }) => {
                const otherPos = particlePositions.element(i).xyz;
                const otherLife = particleLifetimes.element(i);

                If(i.notEqual(instanceIndex).and(otherLife.greaterThan(0.0)), () => {
                    const dist = position.sub(otherPos).lengthSq();

                    If(dist.lessThan(closestDist1).and(dist.greaterThan(0.0)), () => {
                        closestDist2.assign(closestDist1);
                        closestPos2.assign(closestPos1);
                        closestLife2.assign(closestLife1);
                        closestDist1.assign(dist);
                        closestPos1.assign(otherPos);
                        closestLife1.assign(otherLife);
                    }).ElseIf(dist.lessThan(closestDist2).and(dist.greaterThan(0.0)), () => {
                        closestDist2.assign(dist);
                        closestPos2.assign(otherPos);
                        closestLife2.assign(otherLife);
                    });
                });
            });

            // Update link geometry
            const baseIndex = instanceIndex.mul(connectionsPerParticle * 4);

            // Link 1: from current particle to closest
            const link1Base = baseIndex;
            linksPositions.element(link1Base).assign(vec4(position.x, position.y.add(width), position.z, 1.0));
            linksPositions.element(link1Base.add(1)).assign(vec4(position.x, position.y.sub(width), position.z, 1.0));
            linksPositions.element(link1Base.add(2)).assign(vec4(closestPos1.x, closestPos1.y.sub(width), closestPos1.z, 1.0));
            linksPositions.element(link1Base.add(3)).assign(vec4(closestPos1.x, closestPos1.y.add(width), closestPos1.z, 1.0));

            // Link 2: from current particle to second closest
            const link2Base = baseIndex.add(4);
            linksPositions.element(link2Base).assign(vec4(position.x, position.y.add(width), position.z, 1.0));
            linksPositions.element(link2Base.add(1)).assign(vec4(position.x, position.y.sub(width), position.z, 1.0));
            linksPositions.element(link2Base.add(2)).assign(vec4(closestPos2.x, closestPos2.y.sub(width), closestPos2.z, 1.0));
            linksPositions.element(link2Base.add(3)).assign(vec4(closestPos2.x, closestPos2.y.add(width), closestPos2.z, 1.0));

            // Colors with lifetime-based alpha
            const alpha1 = lifetime.mul(closestLife1).pow(0.8);
            const alpha2 = lifetime.mul(closestLife2).pow(0.8);
            const color = vec4(1.0, 0.8, 0.5, 1.0); // Base color

            Loop(4, ({ i: vertIdx }) => {
                linksColors.element(link1Base.add(vertIdx)).assign(vec4(color.x, color.y, color.z, alpha1));
                linksColors.element(link2Base.add(vertIdx)).assign(vec4(color.x, color.y, color.z, alpha2));
            });

        })().compute(maxParticles);
    }

    /**
     * Update the trail links - call this each frame
     */
    update(renderer: WebGPURenderer): void {
        if (this.updateLinksCompute) {
            renderer.computeAsync(this.updateLinksCompute);
        }
    }

    /**
     * Set trail color
     */
    setColor(color: THREE.Color): void {
        // Would need to update a uniform for this
    }

    dispose(): void {
        this.mesh.geometry.dispose();
        (this.mesh.material as THREE.Material).dispose();
    }
}
