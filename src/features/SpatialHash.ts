import * as THREE from 'three';

export class SpatialHash {
  private cellSize: number;
  private cells: Map<string, number[]> = new Map();
  
  constructor(cellSize: number = 1) {
    this.cellSize = cellSize;
  }
  
  private hash(x: number, y: number, z: number): string {
    const cx = Math.floor(x / this.cellSize);
    const cy = Math.floor(y / this.cellSize);
    const cz = Math.floor(z / this.cellSize);
    return `${cx},${cy},${cz}`;
  }
  
  clear(): void {
    this.cells.clear();
  }
  
  insert(index: number, position: THREE.Vector3): void {
    const key = this.hash(position.x, position.y, position.z);
    if (!this.cells.has(key)) {
      this.cells.set(key, []);
    }
    this.cells.get(key)!.push(index);
  }
  
  query(position: THREE.Vector3, radius: number): number[] {
    const result: number[] = [];
    const searchRadius = Math.ceil(radius / this.cellSize);
    
    const cx = Math.floor(position.x / this.cellSize);
    const cy = Math.floor(position.y / this.cellSize);
    const cz = Math.floor(position.z / this.cellSize);
    
    for (let dx = -searchRadius; dx <= searchRadius; dx++) {
      for (let dy = -searchRadius; dy <= searchRadius; dy++) {
        for (let dz = -searchRadius; dz <= searchRadius; dz++) {
          const key = `${cx + dx},${cy + dy},${cz + dz}`;
          const cell = this.cells.get(key);
          if (cell) {
            result.push(...cell);
          }
        }
      }
    }
    
    return result;
  }
  
  dispose(): void {
    this.cells.clear();
  }
}
