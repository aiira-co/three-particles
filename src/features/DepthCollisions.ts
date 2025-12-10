import * as THREE from 'three';
import { Node } from 'three/webgpu';
import { uniform, texture, Fn, vec2, vec3, vec4, If, normalize, dot, cameraViewMatrix, cameraProjectionMatrix, float } from 'three/tsl';
import type { CollisionConfig } from '../types/index.js';

/**
 * Depth buffer collision detection for particles.
 * Allows particles to bounce off scene geometry using the depth buffer.
 */
export class DepthCollisions {
  private depthTexture: THREE.Texture | null = null;
  private config: CollisionConfig;
  private uniforms: Record<string, any>;
  
  constructor(config: CollisionConfig) {
    this.config = config;
    this.uniforms = {
      uBounciness: uniform(config.bounciness ?? 0.5),
      uFriction: uniform(config.friction ?? 0.8),
      uDepthThreshold: uniform(config.depthThreshold ?? 0.01),
    };
  }
  
  setDepthTexture(tex: THREE.Texture): void {
    this.depthTexture = tex;
  }
  
  /**
   * Creates a TSL node that applies collision detection.
   * NOTE: This is a design stub - actual implementation requires
   * the depth texture to be passed as a uniform, not runtime checked.
   */
  applyCollision(position: Node, velocity: Node): Node | null {
    // Guard: depth texture must be set before building the node
    if (!this.depthTexture) {
      console.warn('DepthCollisions: No depth texture set, skipping collision node');
      return null;
    }
    
    const depthTex = this.depthTexture;
    const bounciness = this.uniforms.uBounciness;
    const friction = this.uniforms.uFriction;
    const depthThreshold = this.uniforms.uDepthThreshold;
    
    return Fn(() => {
      // Screen-space collision detection
      // Convert position to screen space
      const viewPos = cameraViewMatrix.mul(vec4(position, 1.0));
      const projPos = cameraProjectionMatrix.mul(viewPos);
      const ndc = projPos.xyz.div(projPos.w);
      const screenPos = ndc.xy.mul(0.5).add(0.5);
      
      // Sample depth buffer
      const sceneDepth = texture(depthTex, screenPos).r;
      
      // Check collision
      If(ndc.z.greaterThan(sceneDepth.add(depthThreshold)), () => {
        // Calculate normal from depth gradient
        const depthL = texture(depthTex, screenPos.add(vec2(-0.001, 0))).r;
        const depthR = texture(depthTex, screenPos.add(vec2(0.001, 0))).r;
        const depthU = texture(depthTex, screenPos.add(vec2(0, -0.001))).r;
        const depthD = texture(depthTex, screenPos.add(vec2(0, 0.001))).r;
        
        const normal = normalize(vec3(
          depthR.sub(depthL),
          depthD.sub(depthU),
          float(0.1)
        ));
        
        // Reflect velocity
        const dotProduct = dot(velocity, normal);
        const reflection = velocity.sub(normal.mul(dotProduct.mul(2.0)));
        velocity.assign(reflection.mul(bounciness));
        
        // Apply friction
        velocity.xz.mulAssign(friction);
        
        // Push out of collision
        const push = normal.mul(ndc.z.sub(sceneDepth).add(0.01));
        position.assign(position.sub(push));
      });
    })();
  }
  
  getUniforms(): Record<string, any> {
    return this.uniforms;
  }
  
  dispose(): void {
    // Nothing to dispose
  }
}