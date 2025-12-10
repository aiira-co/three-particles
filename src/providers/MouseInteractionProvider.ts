import * as THREE from 'three';
import { BaseProvider } from './BaseProvider.js';

export class MouseInteractionProvider extends BaseProvider {
  name = 'MouseInteractionProvider';
  
  private mousePosition: THREE.Vector2 = new THREE.Vector2();
  private worldPosition: THREE.Vector3 = new THREE.Vector3();
  private strength: number;
  private radius: number;
  private attract: boolean;
  
  constructor(config: {
    strength?: number;
    radius?: number;
    attract?: boolean;
  } = {}) {
    super();
    this.strength = config.strength ?? 5.0;
    this.radius = config.radius ?? 3.0;
    this.attract = config.attract ?? true;
  }
  
  setMousePosition(x: number, y: number): void {
    this.mousePosition.set(x, y);
  }
  
  setWorldPosition(position: THREE.Vector3): void {
    this.worldPosition.copy(position);
  }
  
  dispose(): void {
    // Nothing to dispose
  }
}
