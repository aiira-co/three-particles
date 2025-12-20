import * as THREE from 'three';
import { WebGPURenderer, MeshBasicNodeMaterial, RenderTarget } from 'three/webgpu';
import { uniform, texture, vec2, vec3, float, Fn, If, positionWorld, hash } from 'three/tsl';
import { BaseProvider, ProviderContext } from './BaseProvider.js';

/**
 * Configuration for depth-based collision
 */
export interface DepthCollisionConfig {
    /** Size of the collision area (default: 100) */
    areaSize?: number;
    /** Height from which to capture collision (default: 50) */
    captureHeight?: number;
    /** Resolution of collision texture (default: 1024) */
    resolution?: number;
    /** Collision mode: 'respawn' teleports to top, 'bounce' reflects velocity */
    mode?: 'respawn' | 'bounce';
    /** Respawn height (default: 25) */
    respawnHeight?: number;
    /** Bounce coefficient (default: 0.5) */
    bounciness?: number;
    /** Surface offset to prevent z-fighting (default: 0.05) */
    surfaceOffset?: number;
    /** Layer for collision objects (default: 1) */
    collisionLayer?: number;
}

/**
 * Depth-based collision provider using height field approach
 * Based on Three.js webgpu_compute_particles_rain example
 * 
 * This provider:
 * 1. Renders scene from above with orthographic camera to capture height field
 * 2. Samples height field in compute shader to detect collisions
 * 3. Respawns or bounces particles on collision
 */
export class DepthCollisionProvider extends BaseProvider {
    name = 'DepthCollisionProvider';
    priority = 90; // Run late to apply constraints after physics

    // Collision capture setup
    private collisionCamera: THREE.OrthographicCamera;
    private collisionRT: RenderTarget;
    private collisionMaterial: MeshBasicNodeMaterial;

    // Uniforms
    private uAreaSize: any;
    private uRespawnHeight: any;
    private uBounciness: any;
    private uSurfaceOffset: any;
    private uCollisionTexture: any;
    private uTime: any;

    private config: DepthCollisionConfig;
    private scene: THREE.Scene | null = null;
    private initialized: boolean = false;

    constructor(config: DepthCollisionConfig = {}) {
        super();
        this.config = {
            areaSize: config.areaSize ?? 100,
            captureHeight: config.captureHeight ?? 50,
            resolution: config.resolution ?? 1024,
            mode: config.mode ?? 'respawn',
            respawnHeight: config.respawnHeight ?? 25,
            bounciness: config.bounciness ?? 0.5,
            surfaceOffset: config.surfaceOffset ?? 0.05,
            collisionLayer: config.collisionLayer ?? 1
        };

        // Create uniforms
        this.uAreaSize = uniform(this.config.areaSize!);
        this.uRespawnHeight = uniform(this.config.respawnHeight!);
        this.uBounciness = uniform(this.config.bounciness!);
        this.uSurfaceOffset = uniform(this.config.surfaceOffset!);
        this.uTime = uniform(0);

        // Create orthographic camera for top-down capture
        const halfSize = this.config.areaSize! / 2;
        this.collisionCamera = new THREE.OrthographicCamera(
            -halfSize, halfSize, halfSize, -halfSize,
            0.1, this.config.captureHeight!
        );
        this.collisionCamera.position.y = this.config.captureHeight!;
        this.collisionCamera.lookAt(0, 0, 0);
        this.collisionCamera.layers.disableAll();
        this.collisionCamera.layers.enable(this.config.collisionLayer!);

        // Create render target for height field
        this.collisionRT = new RenderTarget(this.config.resolution!, this.config.resolution!);
        this.collisionRT.texture.type = THREE.HalfFloatType;
        this.collisionRT.texture.magFilter = THREE.NearestFilter;
        this.collisionRT.texture.minFilter = THREE.NearestFilter;
        this.collisionRT.texture.generateMipmaps = false;

        // Create material that outputs world position (Y = height)
        this.collisionMaterial = new MeshBasicNodeMaterial();
        this.collisionMaterial.colorNode = positionWorld;
    }

    /**
     * Set the scene to render for collision
     */
    setScene(scene: THREE.Scene): void {
        this.scene = scene;
        this.initialized = true;
    }

    /**
     * Update the collision texture by rendering scene from above
     * Call this each frame before particle update
     */
    updateCollisionTexture(renderer: WebGPURenderer): void {
        if (!this.scene || !this.initialized) return;

        const originalOverrideMaterial = this.scene.overrideMaterial;

        // Render scene with position material
        this.scene.overrideMaterial = this.collisionMaterial;
        renderer.setRenderTarget(this.collisionRT);
        renderer.render(this.scene, this.collisionCamera);

        // Restore
        this.scene.overrideMaterial = originalOverrideMaterial;
        renderer.setRenderTarget(null);
    }

    /**
     * Called each frame - updates time uniform
     */
    onSystemUpdate(deltaTime: number, camera: THREE.Camera): void {
        this.uTime.value += deltaTime;
    }

    /**
     * Position modifier that handles collision response
     */
    getPositionModifierNode(ctx: ProviderContext): any {
        const areaSize = this.uAreaSize;
        const respawnHeight = this.uRespawnHeight;
        const surfaceOffset = this.uSurfaceOffset;
        const collisionTexture = this.collisionRT.texture;
        const time = this.uTime;
        const mode = this.config.mode;

        return Fn(() => {
            // Convert world XZ to texture UV [0, 1]
            const halfSize = areaSize.div(2);
            const uvX = ctx.position.x.add(halfSize).div(areaSize);
            const uvZ = ctx.position.z.add(halfSize).div(areaSize);
            const uv = vec2(uvX, uvZ);

            // Sample height field (Y component of world position)
            const heightSample = texture(collisionTexture, uv);
            const floorHeight = heightSample.y.add(surfaceOffset);

            // Current position
            const pos = ctx.position.toVar();

            // Check collision
            If(pos.y.lessThan(floorHeight), () => {
                if (mode === 'respawn') {
                    // Respawn at top with random XZ offset
                    pos.y.assign(respawnHeight);
                    // Randomize position to avoid patterns
                    pos.x.assign(hash(ctx.index.add(time.mul(1000))).mul(areaSize).sub(halfSize));
                    pos.z.assign(hash(ctx.index.add(time.mul(1000).add(12345))).mul(areaSize).sub(halfSize));
                } else {
                    // Bounce mode - push above surface
                    pos.y.assign(floorHeight);
                }
            });

            return pos;
        })();
    }

    /**
     * Velocity modifier for bounce mode
     */
    getVelocityModifierNode(ctx: ProviderContext): any {
        if (this.config.mode !== 'bounce') return undefined;

        const areaSize = this.uAreaSize;
        const bounciness = this.uBounciness;
        const surfaceOffset = this.uSurfaceOffset;
        const collisionTexture = this.collisionRT.texture;

        return Fn(() => {
            // Convert world XZ to texture UV
            const halfSize = areaSize.div(2);
            const uvX = ctx.position.x.add(halfSize).div(areaSize);
            const uvZ = ctx.position.z.add(halfSize).div(areaSize);
            const uv = vec2(uvX, uvZ);

            // Sample height field
            const heightSample = texture(collisionTexture, uv);
            const floorHeight = heightSample.y.add(surfaceOffset);

            const vel = ctx.velocity.toVar();

            // If below floor and moving down, bounce
            If(ctx.position.y.lessThan(floorHeight).and(vel.y.lessThan(0)), () => {
                vel.y.assign(vel.y.negate().mul(bounciness));
                // Apply friction to XZ
                vel.x.mulAssign(float(0.9));
                vel.z.mulAssign(float(0.9));
            });

            return vel;
        })();
    }

    /**
     * Get collision camera for external manipulation if needed
     */
    getCollisionCamera(): THREE.OrthographicCamera {
        return this.collisionCamera;
    }

    /**
     * Enable collision layer on a mesh
     */
    enableCollision(mesh: THREE.Object3D): void {
        mesh.layers.enable(this.config.collisionLayer!);
    }

    getUniforms(): Record<string, any> {
        return {
            uCollisionAreaSize: this.uAreaSize,
            uCollisionRespawnHeight: this.uRespawnHeight,
            uCollisionBounciness: this.uBounciness,
            uCollisionSurfaceOffset: this.uSurfaceOffset
        };
    }

    dispose(): void {
        this.collisionRT.dispose();
        this.collisionMaterial.dispose();
        this.scene = null;
    }
}
