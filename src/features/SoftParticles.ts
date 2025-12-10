import * as THREE from 'three';

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