import * as THREE from 'three';

export class VectorField {
  private texture: THREE.Data3DTexture | null = null;
  
  constructor(texture?: THREE.Data3DTexture) {
    if (texture) {
      this.texture = texture;
    }
  }
  
  setTexture(texture: THREE.Data3DTexture): void {
    this.texture = texture;
  }
  
  getTexture(): THREE.Data3DTexture | null {
    return this.texture;
  }
  
  dispose(): void {
    if (this.texture) {
      this.texture.dispose();
      this.texture = null;
    }
  }
}
