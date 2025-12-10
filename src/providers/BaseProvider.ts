import * as THREE from 'three';

export interface ParticleProvider {
  name: string;
  priority?: number;
  onSpawn?(index: number): void;
  onUpdate?(index: number, deltaTime: number): void;
  onSystemUpdate?(deltaTime: number, camera: THREE.Camera): void;
  getUniforms?(): Record<string, any>;
  dispose?(): void;
}

export abstract class BaseProvider implements ParticleProvider {
  abstract name: string;
  priority: number = 0;
  
  onSpawn?(index: number): void;
  onUpdate?(index: number, deltaTime: number): void;
  onSystemUpdate?(deltaTime: number, camera: THREE.Camera): void;
  getUniforms?(): Record<string, any>;
  dispose?(): void;
}