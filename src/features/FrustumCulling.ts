import * as THREE from 'three';

export class FrustumCulling {
  private frustum = new THREE.Frustum();
  private projScreenMatrix = new THREE.Matrix4();
  
  update(camera: THREE.Camera): void {
    camera.updateMatrixWorld();
    this.projScreenMatrix.multiplyMatrices(
      camera.projectionMatrix,
      camera.matrixWorldInverse
    );
    this.frustum.setFromProjectionMatrix(this.projScreenMatrix);
  }
  
  isVisible(position: THREE.Vector3, radius: number = 0): boolean {
    const sphere = new THREE.Sphere(position, radius);
    return this.frustum.intersectsSphere(sphere);
  }
  
  dispose(): void {
    // Nothing to dispose
  }
}
