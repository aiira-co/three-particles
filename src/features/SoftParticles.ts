import * as THREE from 'three';

/**
 * @deprecated Holds state and contributes nothing to any shader.
 *
 * Soft particles are implemented inside `GPUParticleSystem`'s fragment shader
 * (see `buildSoftFadeNode`), driven by `softParticles` / `softness` on the
 * system config. This class is retained only because it is part of the
 * published surface, and is referenced solely by the non-exported legacy
 * `ParticleSystem`. Do not wire new code to it.
 */
export class SoftParticles {
  private depthTexture: THREE.Texture | null = null;
  private softness: number;
  
  constructor(softness: number = 0.5) {
    this.softness = softness;
  }
  
  setDepthTexture(texture: THREE.Texture): void {
    this.depthTexture = texture;
  }
  
  setSoftness(softness: number): void {
    this.softness = softness;
  }
  
  getDepthTexture(): THREE.Texture | null {
    return this.depthTexture;
  }
  
  getSoftness(): number {
    return this.softness;
  }
  
  dispose(): void {
    // Nothing specific to dispose
  }
}