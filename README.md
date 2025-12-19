# @interverse/three-particles

AAA-quality GPU particle system for Three.js with Niagara/Unity VFX Graph-like features, powered by **TSL (Three Shader Language)**.

## Features

- ✅ **GPU Compute Shaders** - Physics simulation via TSL compute
- ✅ **High Performance** - 100K+ particles at 60fps
- ✅ **Indirect Rendering** - Efficient instanced mesh rendering
- ✅ **Texture Sheet Animation** - Sprite sheet support with configurable FPS
- ✅ **Soft Particles** - Depth-aware edge fading
- ✅ **Depth Buffer Collisions** - Particles bounce off scene geometry
- ✅ **Provider System** - Extensible behaviors (physics, vortex, boids, etc.)
- ✅ **VFX Graph Foundation** - Node-based effect composition
- ✅ **TypeScript Support** - Full type definitions included

## Requirements

- Three.js ≥ 0.181.0
- WebGPU-enabled browser (Chrome 113+, Edge 113+, or Firefox Nightly)

## Installation

```bash
yarn add @interverse/three-particles
# or
npm install @interverse/three-particles
```

## Quick Start

```typescript
import * as THREE from 'three';
import { WebGPURenderer } from 'three/webgpu';
import { GPUParticleSystem } from '@interverse/three-particles';

// Create WebGPU renderer
const renderer = new WebGPURenderer();
await renderer.init();
document.body.appendChild(renderer.domElement);

// Create scene and camera
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight);
camera.position.z = 5;

// Create particle system
const particles = new GPUParticleSystem({
  maxParticles: 10000,
  emissionRate: 500,
  lifetime: 2.0,
  
  // Visual properties
  sizeStart: 0.1,
  sizeEnd: 0.02,
  colorStart: new THREE.Color(1, 0.5, 0),
  colorEnd: new THREE.Color(1, 0, 0),
  opacityStart: 1.0,
  opacityEnd: 0.0,
  
  // Physics
  velocity: new THREE.Vector3(0, 2, 0),
  velocityVariation: new THREE.Vector3(0.5, 0.5, 0.5),
  gravity: new THREE.Vector3(0, -9.8, 0),
  drag: 0.1,
});

scene.add(particles);

// Emit particles
particles.burst(1000);

// Animation loop
function animate() {
  requestAnimationFrame(animate);
  particles.update(renderer, 0.016, camera);
  renderer.render(scene, camera);
}
animate();
```

## API Reference

### GPUParticleSystem

The main particle system class. Extends `THREE.Group`.

#### Constructor Options

```typescript
interface GPUParticleSystemConfig {
  // Core
  maxParticles?: number;      // Default: 100000
  emissionRate?: number;      // Particles per second
  lifetime?: number;          // Particle lifetime in seconds
  loop?: boolean;             // Continuous emission
  
  // Geometry
  particleGeometry?: THREE.BufferGeometry;  // Custom geometry
  billboard?: boolean;        // Face camera (default: true)
  
  // Emitter Shape
  emitterShape?: 'point' | 'box' | 'sphere' | 'mesh' | 'line';
  emitterSize?: THREE.Vector3;
  
  // Visual
  texture?: THREE.Texture;
  textureSheet?: TextureSheetConfig;
  colorStart?: THREE.Color;
  colorEnd?: THREE.Color;
  sizeStart?: number;
  sizeEnd?: number;
  opacityStart?: number;
  opacityEnd?: number;
  
  // Physics
  velocity?: THREE.Vector3;
  velocityVariation?: THREE.Vector3;
  gravity?: THREE.Vector3;
  drag?: number;
  turbulence?: number;
  
  // Quality
  sorted?: boolean;           // Back-to-front sorting
  softParticles?: boolean;    // Depth-aware fading
  depthCollisions?: boolean;  // Bounce off geometry
  frustumCulled?: boolean;    // GPU frustum culling
}
```

#### Methods

| Method | Description |
|--------|-------------|
| `update(renderer, deltaTime, camera)` | Update physics and rendering (skips if paused) |
| `burst(count)` | Emit a burst of particles |
| `setEmissionRate(rate)` | Set continuous emission rate |
| `addProvider(provider)` | Add behavior provider |
| `removeProvider(name)` | Remove provider by name |
| `getProvider<T>(name)` | Get provider by name |
| `setDepthTexture(texture)` | Set depth buffer for soft particles |
| `play()` | Resume playback |
| `pause()` | Pause (keeps particles visible) |
| `stop()` | Stop and reset all particles |
| `dispose()` | Clean up resources |

#### Properties

| Property | Type | Description |
|----------|------|-------------|
| `isPlaying` | `boolean` | `true` if system is playing and not paused |
| `isPaused` | `boolean` | `true` if system is paused |
| `stats` | `ParticleStats` | Alive/dead counts, GPU memory, compute time |
| `mesh` | `THREE.InstancedMesh` | The underlying particle mesh |

#### Playback Control

```typescript
// Pause and resume
particles.pause();
console.log(particles.isPaused); // true

particles.play();
console.log(particles.isPlaying); // true

// Stop kills all particles and resets
particles.stop();
console.log(particles.isPlaying); // false
```

### VFXManager

Manages multiple particle systems with shared resources.

```typescript
import { VFXManager } from '@interverse/three-particles';

const vfx = new VFXManager(scene, renderer);

// Create named system
const fire = vfx.createSystem('fire', { /* config */ });
const smoke = vfx.createSystem('smoke', { /* config */ });

// Update all systems
vfx.update(deltaTime, camera);

// Access system
vfx.getSystem('fire')?.burst(100);

// Cleanup
vfx.dispose();
```

### Providers

Providers add custom behaviors to particles.

```typescript
import { PhysicsProvider, VortexProvider } from '@interverse/three-particles';

// Add upward force
particles.addProvider(new PhysicsProvider({
  gravity: new THREE.Vector3(0, 5, 0),
  drag: 0.1
}));

// Add swirl effect
particles.addProvider(new VortexProvider(
  new THREE.Vector3(0, 0, 0),  // center
  new THREE.Vector3(0, 1, 0),  // axis
  2.0                           // strength
));
```

Available providers:
- `PhysicsProvider` - Gravity and drag
- `VortexProvider` - Swirl/tornado effect
- `MagneticProvider` - Attraction to points
- `BoidsProvider` - Flocking behavior
- `MouseInteractionProvider` - Mouse attraction/repulsion

## Texture Sheets

Animate particles with sprite sheets:

```typescript
const particles = new GPUParticleSystem({
  texture: await textureLoader.loadAsync('explosion.png'),
  textureSheet: {
    tilesX: 8,
    tilesY: 8,
    totalFrames: 64,
    fps: 30,
    loop: true,
    randomStart: true
  }
});
```

## Performance Tips

1. **Set `maxParticles` appropriately** - Allocates GPU memory upfront
2. **Use `sorted: false`** when transparency order doesn't matter
3. **Disable `softParticles`** if not needed (requires depth pass)
4. **Pool particle systems** - Reuse instead of creating/destroying

## Browser Support

| Browser | Status |
|---------|--------|
| Chrome 113+ | ✅ Full support |
| Edge 113+ | ✅ Full support |
| Firefox Nightly | ⚠️ Experimental (enable `dom.webgpu.enabled`) |
| Safari 18+ | ⚠️ Experimental |

## License

MIT © Interverse Engine