import * as THREE from 'three';
import { BaseProvider } from './BaseProvider.js';

export class BoidsProvider extends BaseProvider {
  name = 'BoidsProvider';
  
  private separationWeight: number;
  private alignmentWeight: number;
  private cohesionWeight: number;
  private neighborRadius: number;
  
  constructor(config: {
    separationWeight?: number;
    alignmentWeight?: number;
    cohesionWeight?: number;
    neighborRadius?: number;
  } = {}) {
    super();
    this.separationWeight = config.separationWeight ?? 1.5;
    this.alignmentWeight = config.alignmentWeight ?? 1.0;
    this.cohesionWeight = config.cohesionWeight ?? 1.0;
    this.neighborRadius = config.neighborRadius ?? 2.0;
  }
  
  dispose(): void {
    // Nothing to dispose
  }
}
