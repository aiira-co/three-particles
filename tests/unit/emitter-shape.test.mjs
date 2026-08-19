/**
 * Regression: a rotated emitter must spawn a rotated volume on the CPU burst path too.
 *
 * The spawn compute shader places continuously emitted particles with
 * `emitterMatrix.mul(vec4(localSpawnPos, 1.0))`, so the emitter's rotation and scale reach
 * the shape offset. IndirectRenderer.getSpawnPositionForShape() built the same offset on
 * world axes and only added the emitter's world *position*, so burst()/emit() produced an
 * axis-aligned volume from a rotated emitter while emissionRate produced a rotated one.
 *
 * Each test bursts into a long thin box (or line) from a rotated emitter and measures every
 * spawn in the emitter frame: the spread has to run along the rotated long axis, and the
 * distance off that axis has to stay inside the thin extents. Before the fix the offsets ran
 * along world X, which puts them ~1.4 units off a 45-degree axis instead of ~0.07.
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

/**
 * Spread of the first `count` spawns, measured against an axis through the emitter origin:
 * `along` is the extent down the axis, `across` the largest distance off it.
 */
function measureSpread(system, axis, count = COUNT) {
  const origin = system.getWorldPosition(new THREE.Vector3());
  const offAxis = new THREE.Vector3();
  let minAlong = Infinity;
  let maxAlong = -Infinity;
  let maxAcross = 0;

  for (let i = 0; i < count; i++) {
    const offset = storedPosition(system, i).sub(origin);
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

  // Thin extents are +/-0.05 on both minor axes, so nothing may sit further than their
  // diagonal off the long axis. Pre-fix this was ~1.41: the slab ran along world X.
  assert.ok(
    spread.maxAcross <= Math.SQRT2 * 0.05 + EPSILON,
    `spawns should hug the rotated long axis, worst was ${spread.maxAcross} off it`
  );
  // The long axis is 4 wide, so 64 uniform samples span most of it.
  assert.ok(spread.range > 2, `expected a wide spread along the emitter axis, got ${spread.range}`);
  assert.ok(
    spread.maxAlong <= 2 + EPSILON && spread.minAlong >= -2 - EPSILON,
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
  assert.ok(spread.range > 2, `expected a wide spread along the emitter axis, got ${spread.range}`);

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

  // Scale doubles every extent: +/-4 along the axis, +/-0.1 across it.
  assert.ok(
    spread.maxAcross <= Math.SQRT2 * 0.1 + EPSILON,
    `spawns should hug the rotated long axis, worst was ${spread.maxAcross} off it`
  );
  assert.ok(
    spread.maxAlong <= 4 + EPSILON && spread.minAlong >= -4 - EPSILON,
    `scale should be applied once, got ${spread.minAlong}..${spread.maxAlong}`
  );
  assert.ok(spread.range > 4, `expected the scaled spread, got ${spread.range}`);

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
    spread.maxAcross <= Math.SQRT2 * 0.05 + EPSILON,
    `spawns should hug world X, worst was ${spread.maxAcross} off it`
  );
  assert.ok(spread.range > 2, `expected a wide spread along world X, got ${spread.range}`);

  system.dispose();
});
