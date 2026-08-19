/**
 * Regression: an emitter transform must reach a particle exactly ONCE.
 *
 * GPUParticleSystem bakes its world matrix into spawn positions - emit() on the CPU,
 * setEmitterMatrix() for GPU spawns - so the storage buffer holds world-space positions.
 * It used to ALSO parent its render mesh to itself, which handed the same matrix to the
 * draw as the model matrix. A particle from an emitter at x = 1 therefore rendered at
 * x = 2. Measured on WebGPU (Edge 151, orthographic camera, lit-pixel centroid of a
 * one-particle burst): x = 0 -> -0.013, x = 1 -> 1.988, x = 2 -> 3.988.
 *
 * These tests reproduce that on the CPU, no GPU needed. The vertex shader adds the stored
 * particle position to positionLocal and three multiplies the result by the mesh world
 * matrix, so `mesh.matrixWorld * storedPosition` is exactly what the draw produces for a
 * quad centre. Both halves are asserted: the bake must happen (stored == offset) and the
 * draw must not repeat it (mesh.matrixWorld == identity).
 *
 * Matrices are refreshed through updateSceneMatrices() before every rendered-position
 * read, because that is the state a real frame draws from - three's renderer calls
 * scene.updateMatrixWorld() itself. Reading them without it hides the bug, since the
 * mesh's world matrix is then still an untouched identity.
 *
 * The suite imports the built package in dist/, so a build has to run first. `npm test`
 * (or `yarn test`) does both: tsc, then node --test.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { GPUParticleSystem, VFXSystemGroup } from '../../dist/index.js';

const IDENTITY = new THREE.Matrix4();
const EPSILON = 1e-6;

/** Config that spawns nothing on its own, so index 0 is whatever the test bursts. */
function systemConfig(extra = {}) {
  return {
    maxParticles: 8,
    emissionRate: 0,
    ...extra,
  };
}

/** What three's renderer does once per frame, before it draws anything. */
function updateSceneMatrices(object) {
  let root = object;
  while (root.parent) root = root.parent;
  root.updateMatrixWorld(true);
}

function storedPosition(system, index = 0) {
  return new THREE.Vector3().fromBufferAttribute(system.particleNodes.positions.value, index);
}

/** Where the vertex shader puts the particle: storage position through the model matrix. */
function renderedPosition(system, index = 0) {
  updateSceneMatrices(system);
  return storedPosition(system, index).applyMatrix4(system.mesh.matrixWorld);
}

function assertVectorEquals(actual, expected, what) {
  assert.ok(
    actual.distanceTo(expected) < EPSILON,
    `${what}: expected ${expected.toArray()}, got ${actual.toArray()}`
  );
}

test('a burst renders at the emitter offset, not double it', () => {
  // The three offsets measured on the GPU, including the 0 control.
  for (const offset of [0, 1, 2]) {
    const system = new GPUParticleSystem(systemConfig());
    system.position.set(offset, 0, 0);
    system.burst(1);

    const expected = new THREE.Vector3(offset, 0, 0);
    const doubled = new THREE.Vector3(offset * 2, 0, 0);
    const rendered = renderedPosition(system);

    assertVectorEquals(storedPosition(system), expected, `spawn position for x = ${offset}`);
    assertVectorEquals(rendered, expected, `rendered position for x = ${offset}`);
    if (offset !== 0) {
      assert.ok(
        rendered.distanceTo(doubled) > EPSILON,
        `emitter transform applied twice: x = ${offset} rendered at ${rendered.toArray()}`
      );
    }

    system.dispose();
  }
});

test('the emitter offset survives a rotated, scaled parent chain', () => {
  const parent = new THREE.Group();
  parent.position.set(1, 0, 0);
  parent.scale.setScalar(2);
  parent.rotation.set(0, Math.PI / 2, 0);

  const system = new GPUParticleSystem(systemConfig());
  system.position.set(0, 0, 3);
  parent.add(system);

  system.burst(1);

  // Point emitter, so the spawn point is just the system origin in world space.
  updateSceneMatrices(system);
  const expected = new THREE.Vector3().setFromMatrixPosition(system.matrixWorld);
  assertVectorEquals(expected, new THREE.Vector3(7, 0, 0), 'sanity check on the emitter world position');

  assertVectorEquals(storedPosition(system), expected, 'spawn position under a parent chain');
  assertVectorEquals(renderedPosition(system), expected, 'rendered position under a parent chain');

  system.dispose();
});

test('render meshes keep an identity world matrix across scene updates', () => {
  const system = new GPUParticleSystem(systemConfig({ trail: { enabled: true, segments: 4 } }));
  const scene = new THREE.Scene();
  scene.add(system);

  // Both the particle mesh and the ribbon trail mesh read world-space storage positions.
  assert.equal(system.children.length, 2, 'expected a particle mesh and a trail mesh');

  scene.updateMatrixWorld(true);
  system.position.set(3, -4, 5);
  scene.updateMatrixWorld(true);

  for (const child of system.children) {
    assert.ok(
      child.matrixWorld.equals(IDENTITY),
      `${child.name || child.type} inherited the emitter transform: ${child.matrixWorld.elements}`
    );
  }

  // The system itself must still track its parents - that is what spawning reads.
  assertVectorEquals(
    new THREE.Vector3().setFromMatrixPosition(system.matrixWorld),
    new THREE.Vector3(3, -4, 5),
    'emitter world position'
  );

  system.dispose();
});

test('update() hands the emitter transform to the compute pipeline only', () => {
  const system = new GPUParticleSystem(systemConfig({ emissionRate: 100 }));
  const scene = new THREE.Scene();
  scene.add(system);
  system.position.set(0, 6, 0);

  // update() only needs the renderer to dispatch compute work; nothing here reads a GPU.
  const renderer = { computeAsync: () => {} };
  system.update(renderer, 1 / 60, new THREE.PerspectiveCamera());
  scene.updateMatrixWorld(true);

  // Private, but there is no public accessor: this is the uniform the spawn compute
  // shader multiplies its local spawn point by.
  const emitterMatrix = system.computePipeline.uEmitterMatrix.value;
  assert.ok(
    emitterMatrix.equals(system.matrixWorld),
    'GPU spawns must be placed with the emitter world matrix'
  );
  assert.ok(
    system.mesh.matrixWorld.equals(IDENTITY),
    'the draw must not apply the emitter matrix a second time'
  );

  system.dispose();
});

test('emit({ matrix }) spawns at the override, not the override plus the system transform', () => {
  const system = new GPUParticleSystem(systemConfig());
  system.position.set(1, 0, 0);

  const expected = new THREE.Vector3(-3, 2, 0);
  system.emit({
    count: 1,
    matrix: new THREE.Matrix4().makeTranslation(expected.x, expected.y, expected.z),
  });

  assertVectorEquals(storedPosition(system), expected, 'spawn position from an explicit matrix');
  assertVectorEquals(renderedPosition(system), expected, 'rendered position from an explicit matrix');

  system.dispose();
});

test('a VFXSystemGroup transform moves the emitter, once', () => {
  const group = new VFXSystemGroup(systemConfig({ styles: [{ name: 'sparks', weight: 1 }] }));
  group.position = new THREE.Vector3(5, 0, 0);

  const scene = new THREE.Scene();
  scene.add(group.object);
  scene.updateMatrixWorld(true);

  group.burst(1);

  const expected = new THREE.Vector3(5, 0, 0);
  for (const system of group.systems) {
    assertVectorEquals(storedPosition(system), expected, 'spawn position under a VFXSystemGroup');
    assertVectorEquals(renderedPosition(system), expected, 'rendered position under a VFXSystemGroup');
  }

  group.dispose();
});
