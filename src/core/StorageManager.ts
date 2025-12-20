import * as THREE from 'three';
import { StorageInstancedBufferAttribute } from 'three/webgpu';

export class StorageManager {
  public maxParticles: number;

  // Core particle data
  public positions: StorageInstancedBufferAttribute;
  public velocities: StorageInstancedBufferAttribute;
  public rotations: StorageInstancedBufferAttribute;
  public angularVelocities: StorageInstancedBufferAttribute;
  public ages: StorageInstancedBufferAttribute;
  public lifetimes: StorageInstancedBufferAttribute;
  public colors: StorageInstancedBufferAttribute;
  public sizes: StorageInstancedBufferAttribute;

  // Custom data for providers
  public customData1: StorageInstancedBufferAttribute;
  public customData2: StorageInstancedBufferAttribute;
  public customData3: StorageInstancedBufferAttribute;
  public customData4: StorageInstancedBufferAttribute;

  constructor(maxParticles: number) {
    this.maxParticles = maxParticles;

    // Allocate GPU storage
    this.positions = new StorageInstancedBufferAttribute(maxParticles, 3);
    this.velocities = new StorageInstancedBufferAttribute(maxParticles, 3);
    this.rotations = new StorageInstancedBufferAttribute(maxParticles, 3);
    this.angularVelocities = new StorageInstancedBufferAttribute(maxParticles, 3);
    this.ages = new StorageInstancedBufferAttribute(maxParticles, 1);
    this.lifetimes = new StorageInstancedBufferAttribute(maxParticles, 1);
    this.colors = new StorageInstancedBufferAttribute(maxParticles, 4);
    this.sizes = new StorageInstancedBufferAttribute(maxParticles, 1);

    this.customData1 = new StorageInstancedBufferAttribute(maxParticles, 4);
    this.customData2 = new StorageInstancedBufferAttribute(maxParticles, 4);
    this.customData3 = new StorageInstancedBufferAttribute(maxParticles, 4);
    this.customData4 = new StorageInstancedBufferAttribute(maxParticles, 4);

    this.initialize();
  }

  private initialize(): void {
    // Initialize all particles as dead (off-screen with expired age)
    // Ages now store spawnTime. Setting spawnTime to a large negative value
    // means age = currentTime - spawnTime will be very large, exceeding lifetime
    for (let i = 0; i < this.maxParticles; i++) {
      this.positions.setXYZ(i, 0, -999999, 0);
      this.ages.setX(i, -1000000); // Spawn time far in the past = very old = dead
      this.lifetimes.setX(i, 1.0);
      this.colors.setXYZW(i, 1, 1, 1, 0);
      this.sizes.setX(i, 0.1);
    }
  }

  getGPUMemory(): number {
    const attributes = [
      this.positions, this.velocities, this.rotations, this.angularVelocities,
      this.ages, this.lifetimes, this.colors, this.sizes,
      this.customData1, this.customData2, this.customData3, this.customData4
    ];

    return attributes.reduce((total, attr) => {
      return total + (attr.count * attr.itemSize * 4); // 4 bytes per float
    }, 0);
  }

  dispose(): void {
    // Cleanup if needed
  }
}
