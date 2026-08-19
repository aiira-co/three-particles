/**
 * Regression: a config key that is present but undefined must fall back to its default.
 *
 * applyDefaults() used to end with `{ ...defaults, ...config }`, and a spread copies
 * undefined values over the defaults rather than skipping them. VFXSystemGroup derives
 * every style config as `style.x ?? base.x`, so any field neither side sets arrives as an
 * explicit undefined - and `colorStart: undefined` reached
 * `this.uColorStart.value.copy(this.config.colorStart!)`, throwing
 * "Cannot read properties of undefined (reading 'r')" out of THREE.Color.copy. That made
 * every style-based system unconstructible unless the caller happened to pass colours.
 * Numeric fields were clobbered the same way, just without the immediate throw.
 *
 * The suite imports the built package in dist/, so a build has to run first. `npm test`
 * (or `yarn test`) does both: tsc, then node --test.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { GPUParticleSystem, VFXSystemGroup } from '../../dist/index.js';

const WHITE = new THREE.Color(1, 1, 1);

test('undefined config values fall back to the defaults', () => {
  const system = new GPUParticleSystem({
    maxParticles: 8,
    emissionRate: 0,
    // What a caller writing `style.x ?? base.x` hands over when neither side sets x.
    colorStart: undefined,
    colorEnd: undefined,
    sizeStart: undefined,
    lifetime: undefined,
    gravity: undefined,
    emitterSize: undefined,
  });

  // Private, but these are the values that actually reach the shaders.
  assert.ok(system.uColorStart.value.equals(WHITE), 'colorStart uniform should default to white');
  assert.ok(system.uColorEnd.value.equals(WHITE), 'colorEnd uniform should default to white');
  assert.equal(system.uSizeStart.value, 0.1, 'sizeStart uniform should default to 0.1');

  assert.equal(system.config.lifetime, 2.0, 'lifetime should default to 2.0');
  assert.ok(system.config.gravity instanceof THREE.Vector3, 'gravity should default to a vector');
  assert.ok(system.config.emitterSize instanceof THREE.Vector3, 'emitterSize should default to a vector');

  // Values the caller did set still win over the defaults.
  assert.equal(system.config.maxParticles, 8, 'an explicit maxParticles should survive');

  system.dispose();
});

test('explicit falsy config values are kept, not treated as missing', () => {
  const system = new GPUParticleSystem({
    maxParticles: 8,
    emissionRate: 0,
    drag: 0,
    turbulence: 0,
    opacityStart: 0,
    loop: false,
    billboard: false,
    sortFrameInterval: null,
  });

  assert.equal(system.config.emissionRate, 0, '0 is a value, not a missing key');
  assert.equal(system.config.drag, 0, '0 is a value, not a missing key');
  assert.equal(system.config.opacityStart, 0, '0 is a value, not a missing key');
  assert.equal(system.config.loop, false, 'false is a value, not a missing key');
  assert.equal(system.config.billboard, false, 'false is a value, not a missing key');
  assert.equal(system.config.sortFrameInterval, null, 'null means auto and must survive');
  assert.equal(system.uBillboard.value, 0, 'billboard: false should reach the uniform');

  system.dispose();
});

test('VFXSystemGroup builds a style that sets no colours', () => {
  // The reported repro: this threw out of THREE.Color.copy before the fix.
  const group = new VFXSystemGroup({
    maxParticles: 8,
    emissionRate: 0,
    styles: [{ name: 'sparks', weight: 1 }],
  });

  assert.equal(group.systems.length, 1, 'expected one system per style');

  const [system] = group.systems;
  assert.ok(system.uColorStart.value.equals(WHITE), 'style system should get the default colour');
  assert.equal(system.uSizeStart.value, 0.1, 'style system should get the default size');

  // A style config carries no `styles` key onward, so the child system is a leaf.
  assert.equal(system.config.styles, undefined, 'child systems should not inherit styles');

  // Still functional, not just constructible.
  group.burst(1);
  const spawned = new THREE.Vector3().fromBufferAttribute(system.particleNodes.positions.value, 0);
  assert.ok(Number.isFinite(spawned.x), 'burst should have written a spawn position');

  group.dispose();
});
