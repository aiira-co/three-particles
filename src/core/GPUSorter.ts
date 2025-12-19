import * as THREE from 'three';
import {
  StorageInstancedBufferAttribute,
  WebGPURenderer,
  ComputeNode
} from 'three/webgpu';
import {
  Fn, instanceIndex, uniform, storage as tslStorage,
  float, uint, vec3, If, int
} from 'three/tsl';

/**
 * GPU-based particle sorter using bitonic sort algorithm.
 * Performs back-to-front sorting entirely on GPU using TSL compute shaders.
 */
export class GPUSorter {
  private maxParticles: number;
  private paddedSize: number;

  // GPU storage buffers
  private distanceBuffer: StorageInstancedBufferAttribute;
  private indicesBufferA: StorageInstancedBufferAttribute;
  private indicesBufferB: StorageInstancedBufferAttribute;

  // TSL storage accessors
  private distanceStorage: any;
  private indicesStorageA: any;
  private indicesStorageB: any;

  // Compute nodes
  private distanceComputeNode: ComputeNode | null = null;
  private bitonicPassNodes: Map<string, ComputeNode> = new Map();

  // Uniforms
  private uCameraPos = uniform(new THREE.Vector3());
  private uStageSize = uniform(0);
  private uStepSize = uniform(0);
  private uUseBufferA = uniform(1); // 1 = read from A, write to B

  // External position buffer reference
  private positionsStorage: any = null;

  constructor(maxParticles: number) {
    this.maxParticles = maxParticles;

    // Pad to next power of 2 for bitonic sort
    this.paddedSize = this.nextPowerOf2(maxParticles);

    // Create GPU storage buffers
    this.distanceBuffer = new StorageInstancedBufferAttribute(this.paddedSize, 1);
    this.indicesBufferA = new StorageInstancedBufferAttribute(this.paddedSize, 1);
    this.indicesBufferB = new StorageInstancedBufferAttribute(this.paddedSize, 1);

    // Use Uint32 array for indices
    const indicesArrayA = new Uint32Array(this.paddedSize);
    const indicesArrayB = new Uint32Array(this.paddedSize);
    for (let i = 0; i < this.paddedSize; i++) {
      indicesArrayA[i] = i < maxParticles ? i : 0xFFFFFFFF; // Dead particles go to infinity
      indicesArrayB[i] = i < maxParticles ? i : 0xFFFFFFFF;
    }

    // Initialize distance buffer with max values for dead particles
    const distArray = this.distanceBuffer.array as Float32Array;
    for (let i = 0; i < this.paddedSize; i++) {
      distArray[i] = i < maxParticles ? 0 : -Infinity; // Dead particles sorted to back
    }

    // Create TSL storage accessors
    this.distanceStorage = tslStorage(this.distanceBuffer, 'float', this.paddedSize);
    this.indicesStorageA = tslStorage(this.indicesBufferA, 'uint', this.paddedSize);
    this.indicesStorageB = tslStorage(this.indicesBufferB, 'uint', this.paddedSize);
  }

  /**
   * Set the positions storage buffer from the particle system
   */
  setPositionsStorage(positions: StorageInstancedBufferAttribute): void {
    this.positionsStorage = tslStorage(positions, 'vec3', this.maxParticles);
    this.distanceComputeNode = null; // Force rebuild
  }

  /**
   * Sort particles by distance from camera (back to front)
   * Runs entirely on GPU using compute shaders
   */
  sort(renderer: WebGPURenderer, cameraPosition: THREE.Vector3): void {
    if (!this.positionsStorage) {
      console.warn('GPUSorter: No positions storage set');
      return;
    }

    // Update camera position uniform
    this.uCameraPos.value.copy(cameraPosition);

    // Step 1: Calculate distances on GPU
    this.executeDistanceCompute(renderer);

    // Step 2: Run bitonic sort passes
    this.executeBitonicSort(renderer);
  }

  /**
   * Execute distance calculation compute shader
   */
  private executeDistanceCompute(renderer: WebGPURenderer): void {
    if (!this.distanceComputeNode) {
      this.distanceComputeNode = this.buildDistanceComputeNode();
    }

    renderer.computeAsync(this.distanceComputeNode);
  }

  /**
   * Build distance calculation compute shader
   */
  private buildDistanceComputeNode(): ComputeNode {
    const positions = this.positionsStorage;
    const distances = this.distanceStorage;
    const indices = this.indicesStorageA;
    const camPos = this.uCameraPos;
    const maxParticles = this.maxParticles;

    const computeFn = Fn(() => {
      const i = instanceIndex;

      // Initialize index
      indices.element(i).assign(i);

      // Calculate distance for valid particles
      If(i.lessThan(uint(maxParticles)), () => {
        const pos = positions.element(i);
        const diff = pos.sub(camPos);
        // Store squared distance (negative for back-to-front = descending)
        const distSq = diff.dot(diff);
        distances.element(i).assign(distSq.negate());
      }).Else(() => {
        // Dead particles get pushed to front (will be culled anyway)
        distances.element(i).assign(float(Infinity));
      });
    });

    return computeFn().compute(this.paddedSize);
  }

  /**
   * Execute all bitonic sort passes
   */
  private executeBitonicSort(renderer: WebGPURenderer): void {
    const n = this.paddedSize;
    const numStages = Math.log2(n);

    let useBufferA = true;

    // Bitonic sort: log²(n) total passes
    for (let stage = 0; stage < numStages; stage++) {
      const stageSize = 1 << (stage + 1);

      for (let step = stage; step >= 0; step--) {
        const stepSize = 1 << step;

        // Update uniforms
        this.uStageSize.value = stageSize;
        this.uStepSize.value = stepSize;
        this.uUseBufferA.value = useBufferA ? 1 : 0;

        // Get or create compute node for this pass
        const passKey = `${stage}_${step}`;
        let passNode = this.bitonicPassNodes.get(passKey);

        if (!passNode) {
          passNode = this.buildBitonicPassNode();
          this.bitonicPassNodes.set(passKey, passNode);
        }

        renderer.computeAsync(passNode);

        // Swap buffers
        useBufferA = !useBufferA;
      }
    }
  }

  /**
   * Build a single bitonic sort pass compute shader
   */
  private buildBitonicPassNode(): ComputeNode {
    const distanceStorage = this.distanceStorage;
    const indicesA = this.indicesStorageA;
    const indicesB = this.indicesStorageB;
    const stageSize = this.uStageSize;
    const stepSize = this.uStepSize;
    const useBufferA = this.uUseBufferA;

    const computeFn = Fn(() => {
      const i = instanceIndex;

      // Calculate partner index using XOR
      const partner = i.bitXor(stepSize);

      // Only process if partner is greater (avoid duplicate swaps)
      If(partner.greaterThan(i), () => {
        // Determine sort direction for this section
        // Elements in first half of each bitonically sorted section should be ascending
        const sectionMask = stageSize.sub(int(1));
        const indexInSection = i.bitAnd(sectionMask);
        const halfSection = stageSize.div(int(2));
        const ascending = indexInSection.lessThan(halfSection);

        // Read indices from appropriate buffer
        const idxI = useBufferA.equal(int(1)).select(
          indicesA.element(i),
          indicesB.element(i)
        );
        const idxPartner = useBufferA.equal(int(1)).select(
          indicesA.element(partner),
          indicesB.element(partner)
        );

        // Get distances
        const distI = distanceStorage.element(idxI);
        const distPartner = distanceStorage.element(idxPartner);

        // Determine if swap is needed
        const needsSwap = ascending.select(
          distI.greaterThan(distPartner), // Ascending: swap if i > partner
          distI.lessThan(distPartner)     // Descending: swap if i < partner
        );

        // Write to other buffer with potential swap
        const outI = needsSwap.select(idxPartner, idxI);
        const outPartner = needsSwap.select(idxI, idxPartner);

        If(useBufferA.equal(int(1)), () => {
          indicesB.element(i).assign(outI);
          indicesB.element(partner).assign(outPartner);
        }).Else(() => {
          indicesA.element(i).assign(outI);
          indicesA.element(partner).assign(outPartner);
        });
      }).Else(() => {
        // Partner is less than us, just copy without change
        const idx = useBufferA.equal(int(1)).select(
          indicesA.element(i),
          indicesB.element(i)
        );

        If(useBufferA.equal(int(1)), () => {
          indicesB.element(i).assign(idx);
        }).Else(() => {
          indicesA.element(i).assign(idx);
        });
      });
    });

    return computeFn().compute(this.paddedSize);
  }

  /**
   * Get the sorted indices buffer
   */
  getSortedIndicesBuffer(): StorageInstancedBufferAttribute {
    // Return whichever buffer has the final result
    // After all passes, result alternates - track which one is current
    const numPasses = this.getTotalPasses();
    return (numPasses % 2 === 0) ? this.indicesBufferA : this.indicesBufferB;
  }

  /**
   * Get TSL storage accessor for sorted indices (for use in vertex shader)
   */
  getSortedIndicesStorage(): any {
    const numPasses = this.getTotalPasses();
    return (numPasses % 2 === 0) ? this.indicesStorageA : this.indicesStorageB;
  }

  /**
   * Calculate total number of bitonic sort passes
   */
  private getTotalPasses(): number {
    const numStages = Math.log2(this.paddedSize);
    return (numStages * (numStages + 1)) / 2;
  }

  /**
   * Round up to next power of 2
   */
  private nextPowerOf2(n: number): number {
    return Math.pow(2, Math.ceil(Math.log2(n)));
  }

  dispose(): void {
    this.distanceComputeNode = null;
    this.bitonicPassNodes.clear();
  }
}