import * as THREE from 'three';
import { BaseProvider } from './BaseProvider.js';

export class VortexProvider extends BaseProvider {
  name = 'VortexProvider';
  
  private center: THREE.Vector3;
  private axis: THREE.Vector3;
  private strength: number;
  
  constructor(
    center: THREE.Vector3 = new THREE.Vector3(0, 0, 0),
    axis: THREE.Vector3 = new THREE.Vector3(0, 1, 0),
    strength: number = 1.0
  ) {
    super();
    this.center = center.clone();
    this.axis = axis.clone().normalize();
    this.strength = strength;
  }
  
  setCenter(center: THREE.Vector3): void {
    this.center.copy(center);
  }
  
  setAxis(axis: THREE.Vector3): void {
    this.axis.copy(axis).normalize();
  }
  
  setStrength(strength: number): void {
    this.strength = strength;
  }
  
  dispose(): void {
    // Nothing to dispose
  }
}
