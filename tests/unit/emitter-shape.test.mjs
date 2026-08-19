/**
 * Regression: emitter shape volumes, on the CPU burst path.
 *
 * Two things used to go wrong here, both of them a disagreement with the spawn compute
 * shader, which places continuously emitted particles with
 * `emitterMatrix.mul(vec4(localSpawnPos, 1.0))` and reads emitterSize as a half extent.
 *
 * 1. Orientation. IndirectRenderer.getSpawnPositionForShape() built the shape offset on
 *    world axes and only added the emitter's world *position*, so burst()/emit() produced an
 *    axis-aligned volume from a rotated emitter while emissionRate produced a rotated one.
 *    Before the fix a 45-degree slab's spawns sat ~1.4 units off the axis instead of ~0.1.
 * 2. Extents. box and line read emitterSize as a full width, i.e. half the volume the same
 *    config filled through emissionRate.
 *
 * So extents below follow the convention documented in the README: emitterSize is a half
 * extent per axis, and a box of (4, 0.1, 0.1) spans 8 x 0.2 x 0.2.
 *
 * Positions are read straight out of the storage buffer, which holds world space by design -
 * see the GPUParticleSystem class comment and the README "Simulation Space" section.
 *
 * The suite imports the built package in dist/, so a build has to run first. `npm test`
 * (or `yarn test`) does both: tsc, then node --test.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { GPUParticleSystem } from '../../dist/index.js';

const COUNT = 64;
const EPSILON = 1e-6;

function storedPosition(system, index) {
  return new THREE.Vector3().fromBufferAttribute(system.particleNodes.positions.value, index);
}

/** Offsets of the first `count` spawns from the emitter origin, in world space. */
function spawnOffsets(system, count = COUNT) {
  const origin = system.getWorldPosition(new THREE.Vector3());
  return Array.from({ length: count }, (_, i) => storedPosition(system, i).sub(origin));
}

/**
 * Spread of those offsets against an axis through the emitter origin: `along` is the extent
 * down the axis, `across` the largest distance off it.
 */
function measureSpread(system, axis, count = COUNT) {
  const offAxis = new THREE.Vector3();
  let minAlong = Infinity;
  let maxAlong = -Infinity;
  let maxAcross = 0;

  for (const offset of spawnOffsets(system, count)) {
    const along = offset.dot(axis);
    offAxis.copy(offset).addScaledVector(axis, -along);

    minAlong = Math.min(minAlong, along);
    maxAlong = Math.max(maxAlong, along);
    maxAcross = Math.max(maxAcross, offAxis.length());
  }

  return { minAlong, maxAlong, range: maxAlong - minAlong, maxAcross };
}

/** The emitter's local +axis in world space. */
function worldAxis(system, local) {
  return local.clone().applyQuaternion(system.getWorldQuaternion(new THREE.Quaternion()));
}

test('a burst from a rotated box emitter spawns a rotated slab', () => {
  const system = new GPUParticleSystem({
    maxParticles: 128,
    emissionRate: 0,
    emitterShape: 'box',
    emitterSize: new THREE.Vector3(4, 0.1, 0.1),
  });
  // Offset as well as rotated, so a rotation applied after translating would show up too.
  system.position.set(5, 0, 0);
  system.rotation.y = Math.PI / 4;

  system.burst(COUNT);

  const spread = measureSpread(system, worldAxis(system, new THREE.Vector3(1, 0, 0)));

  // Half extents are 0.1 on both minor axes, so nothing may sit further than their diagonal
  // off the long axis. Pre-fix this was ~1.41: the slab ran along world X.
  assert.ok(
    spread.maxAcross <= Math.SQRT2 * 0.1 + EPSILON,
    `spawns should hug the rotated long axis, worst was ${spread.maxAcross} off it`
  );
  // The long axis spans 8, so 64 uniform samples cover most of it.
  assert.ok(spread.range > 4, `expected a wide spread along the emitter axis, got ${spread.range}`);
  assert.ok(
    spread.maxAlong <= 4 + EPSILON && spread.minAlong >= -4 - EPSILON,
    `spawns should stay inside the box, got ${spread.minAlong}..${spread.maxAlong}`
  );

  system.dispose();
});

test('a burst from a rotated line emitter spawns along the rotated line', () => {
  const system = new GPUParticleSystem({
    maxParticles: 128,
    emissionRate: 0,
    emitterShape: 'line',
    emitterSize: new THREE.Vector3(0, 4, 0),
  });
  // Rolls the local Y line onto world X.
  system.rotation.z = Math.PI / 2;

  system.burst(COUNT);

  const spread = measureSpread(system, worldAxis(system, new THREE.Vector3(0, 1, 0)));

  assert.ok(spread.maxAcross <= EPSILON, `a line emitter has no width, got ${spread.maxAcross}`);
  assert.ok(spread.range > 4, `expected a wide spread along the emitter axis, got ${spread.range}`);
  assert.ok(
    spread.maxAlong <= 4 + EPSILON && spread.minAlong >= -4 - EPSILON,
    `spawns should stay on the line, got ${spread.minAlong}..${spread.maxAlong}`
  );

  system.dispose();
});

test('emitter scale and rotation are each applied once', () => {
  const system = new GPUParticleSystem({
    maxParticles: 128,
    emissionRate: 0,
    emitterShape: 'box',
    emitterSize: new THREE.Vector3(4, 0.1, 0.1),
  });
  system.rotation.y = Math.PI / 4;
  system.scale.setScalar(2);

  system.burst(COUNT);

  const spread = measureSpread(system, worldAxis(system, new THREE.Vector3(1, 0, 0)));

  // Scale doubles every half extent: 8 along the axis, 0.2 across it.
  assert.ok(
    spread.maxAcross <= Math.SQRT2 * 0.2 + EPSILON,
    `spawns should hug the rotated long axis, worst was ${spread.maxAcross} off it`
  );
  assert.ok(
    spread.maxAlong <= 8 + EPSILON && spread.minAlong >= -8 - EPSILON,
    `scale should be applied once, got ${spread.minAlong}..${spread.maxAlong}`
  );
  assert.ok(spread.range > 8, `expected the scaled spread, got ${spread.range}`);

  system.dispose();
});

test('localSpaceEmitter: false keeps the volume aligned to the world axes', () => {
  const system = new GPUParticleSystem({
    maxParticles: 128,
    emissionRate: 0,
    emitterShape: 'box',
    emitterSize: new THREE.Vector3(4, 0.1, 0.1),
  });
  system.rotation.y = Math.PI / 4;

  system.emit({ count: COUNT, localSpaceEmitter: false });

  // Opting out leaves the slab on world X, the same opt-out that leaves the size unscaled.
  const spread = measureSpread(system, new THREE.Vector3(1, 0, 0));

  assert.ok(
    spread.maxAcross <= Math.SQRT2 * 0.1 + EPSILON,
    `spawns should hug world X, worst was ${spread.maxAcross} off it`
  );
  assert.ok(spread.range > 4, `expected a wide spread along world X, got ${spread.range}`);

  system.dispose();
});

test('emitterSize is a half extent per axis, not a full width', () => {
  // Each shape gets the same nominal size, so the reach that proves the convention is the
  // same too: spawns must get past 1 (a full-width reading caps them there) and never past 2.
  const HALF = 2;
  const shapes = [
    { emitterShape: 'box', axis: new THREE.Vector3(1, 0, 0), size: new THREE.Vector3(HALF, HALF, HALF) },
    { emitterShape: 'sphere', axis: null, size: new THREE.Vector3(HALF, HALF, HALF) },
    { emitterShape: 'line', axis: new THREE.Vector3(0, 1, 0), size: new THREE.Vector3(0, HALF, 0) },
  ];

  for (const { emitterShape, axis, size } of shapes) {
    const system = new GPUParticleSystem({
      maxParticles: 128,
      emissionRate: 0,
      emitterShape,
      emitterSize: size,
    });

    system.burst(COUNT);

    // A sphere is isotropic, so measure its radius rather than an axis.
    const reach = spawnOffsets(system).map((offset) => (axis ? Math.abs(offset.dot(axis)) : offset.length()));
    const furthest = Math.max(...reach);

    assert.ok(
      furthest > HALF / 2,
      `${emitterShape}: emitterSize ${HALF} should reach past ${HALF / 2}, furthest was ${furthest}`
    );
    assert.ok(
      furthest <= HALF + EPSILON,
      `${emitterShape}: emitterSize ${HALF} should not reach past ${HALF}, furthest was ${furthest}`
    );

    system.dispose();
  }
});
