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
  /**
   * Sort key for a padding slot, i.e. an index past `maxParticles`.
   *
   * The sort key of a live particle is `-distanceSquared`, so it is always <= 0 and
   * the array ends up ascending: most negative (farthest) first, which is the
   * back-to-front order alpha blending needs. Padding must therefore land *after*
   * every live particle, and any positive value achieves that - if a padding slot
   * sorted to the front it would displace a live particle out of the drawn range.
   *
   * The value must not be `Infinity`. three's WGSL generator formats a float literal
   * as `value + ( value % 1 ? '' : '.0' )` unless its string form contains an `e`;
   * `Infinity % 1` is `NaN`, so `float( Infinity )` emitted the literal `Infinity.0`
   * and every sort shader failed to compile. 1e30 stringifies to `1e+30` -> `1e30`,
   * a valid WGSL literal, and sits far above any plausible squared distance while
   * staying well inside f32 range.
   */
  private static readonly PADDING_SORT_KEY = 1e30;

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
  /**
   * Every bitonic pass is the same shader; only the uniforms below differ, so one
   * node is reused for all of them. This previously cached one node per
   * (stage, step) pair - 153 structurally identical pipelines at maxParticles
   * 100000 - which all shared these same uniform objects anyway.
   */
  private bitonicPassNode: ComputeNode | null = null;

  // Uniforms
  private uCameraPos = uniform(new THREE.Vector3());
  // These feed bitwise operators against instanceIndex, which is a uint. Declared
  // as floats they were the wrong operand type for bitXor/bitAnd entirely.
  private uStageSize = uniform(0, 'uint');
  private uStepSize = uniform(0, 'uint');
  private uUseBufferA = uniform(1, 'uint'); // 1 = read from A, write to B

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

    // Seed the distance buffer using the same convention as the distance compute
    // shader below, which overwrites every element on each sort. This seed only
    // matters if something reads the buffer before the first sort runs; it was
    // previously -Infinity, i.e. the opposite end from where padding belongs.
    const distArray = this.distanceBuffer.array as Float32Array;
    for (let i = 0; i < this.paddedSize; i++) {
      distArray[i] = i < maxParticles ? 0 : GPUSorter.PADDING_SORT_KEY;
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
        // Negated so that ascending order puts the farthest particle first.
        const distSq = diff.dot(diff);
        distances.element(i).assign(distSq.negate());
      }).Else(() => {
        // Padding slots sort after every live particle. See PADDING_SORT_KEY.
        distances.element(i).assign(float(GPUSorter.PADDING_SORT_KEY));
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

        if (!this.bitonicPassNode) {
          this.bitonicPassNode = this.buildBitonicPassNode();
        }

        renderer.computeAsync(this.bitonicPassNode);

        // Swap buffers
        useBufferA = !useBufferA;
      }
    }
  }

  /**
   * Build a single bitonic sort pass compute shader
   */
  /**
   * One compare-exchange pass of the bitonic sort.
   *
   * Every invocation writes exactly one slot - its own. The previous version had
   * the lower thread of each pair write *both* `out[i]` and `out[partner]` while
   * the upper thread also wrote `out[partner]` from its Else branch, so two
   * invocations raced on the same slot and the result was not even a permutation
   * (indices came back duplicated, e.g. [0,1,3,3,7,7,7,7,15,...]).
   *
   * The sort direction also has to be identical for both members of a pair, which
   * means testing the stage bit itself (`i & stageSize`) and not a bit inside the
   * block. The old `(i & (stageSize - 1)) < stageSize / 2` tests the
   * `stageSize / 2` bit, which is exactly the bit `partner = i ^ stepSize` flips on
   * the first step of every stage - so the two halves of a pair disagreed on
   * direction and sorted against each other.
   */
  private buildBitonicPassNode(): ComputeNode {
    const distanceStorage = this.distanceStorage;
    const indicesA = this.indicesStorageA;
    const indicesB = this.indicesStorageB;
    const stageSize = this.uStageSize;
    const stepSize = this.uStepSize;
    const useBufferA = this.uUseBufferA;

    const computeFn = Fn(() => {
      const i = instanceIndex as any;
      const useA = (useBufferA as any).equal(uint(1));

      const partner = i.bitXor(stepSize as any);

      // Same for both members of the pair: stepSize < stageSize, so XOR cannot
      // flip the stageSize bit.
      const ascending = i.bitAnd(stageSize as any).equal(uint(0));

      // `i` is the lower half of the pair.
      const isLow = partner.greaterThan(i);

      const mine = useA.select(indicesA.element(i), indicesB.element(i));
      const theirs = useA.select(indicesA.element(partner), indicesB.element(partner));

      const distMine = distanceStorage.element(mine);
      const distTheirs = distanceStorage.element(theirs);

      // An ascending pair puts the smaller key in the lower slot; a descending pair
      // puts it in the upper slot. Each thread decides only about its own slot.
      const wantSmaller = ascending.select(isLow, isLow.not());
      const takeTheirs = wantSmaller.select(
        distTheirs.lessThan(distMine),
        distTheirs.greaterThan(distMine)
      );
      const result = takeTheirs.select(theirs, mine);

      If(useA, () => {
        indicesB.element(i).assign(result);
      }).Else(() => {
        indicesA.element(i).assign(result);
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
    this.bitonicPassNode = null;
  }
}
