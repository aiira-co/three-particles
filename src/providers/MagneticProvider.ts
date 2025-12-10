import * as THREE from 'three';
import { BaseProvider } from './BaseProvider.js';

export class MagneticProvider extends BaseProvider {
  name = 'MagneticProvider';
  
  private sources: THREE.Vector3[] = [];
  private strength: number;
  
  constructor(strength: number = 1.0) {
    super();
    this.strength = strength;
  }
  
  addSource(position: THREE.Vector3): void {
    this.sources.push(position.clone());
  }
  
  removeSource(index: number): void {
    this.sources.splice(index, 1);
  }
  
  dispose(): void {
    this.sources = [];
  }
}
