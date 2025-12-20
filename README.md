# @interverse/three-particles

AAA-quality GPU particle system for Three.js with Niagara/Unity VFX Graph-like features, powered by **TSL (Three Shader Language)**.

## Features

- ✅ **GPU Compute Shaders** - Physics simulation via TSL compute
- ✅ **High Performance** - 100K+ particles at 60fps
- ✅ **Indirect Rendering** - Efficient instanced mesh rendering
- ✅ **Ribbon Trails** - GPU-accelerated smooth trails with position history
- ✅ **Advanced Curves** - Non-linear control over size, opacity, and color
- ✅ **Texture Sheet Animation** - Sprite sheet support with configurable FPS
- ✅ **Soft Particles** - Depth-aware edge fading
- ✅ **Depth Buffer Collisions** - Particles bounce off scene geometry
- ✅ **Provider System** - Extensible behaviors (physics, vortex, boids, etc.)
- ✅ **VFX Graph Foundation** - Node-based effect composition
- ✅ **TypeScript Support** - Full type definitions included

## Requirements

- Three.js ≥ 0.182.0
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

## Advanced Features

### Ribbon Trails

Create smooth, flowing trails behind particles using GPU position history.

```typescript
const particles = new GPUParticleSystem({
  // ... basic config
  trail: {
    enabled: true,
    segments: 16,        // Number of history points
    width: 0.2,          // Width relative to particle size
    updateInterval: 0.02, // Sampling rate (seconds)
    fadeAlpha: true      // Fade opacity from head to tail
  }
});
```

### Curves & Gradients

Control properties over particle lifetime using non-linear curves.

```typescript
import { LifetimeCurve, GradientCurve } from '@interverse/three-particles';

const particles = new GPUParticleSystem({
  // Ease-out size
  sizeCurve: new LifetimeCurve([
    { p: 0, v: 0.1 }, 
    { p: 0.2, v: 1.0 }, 
    { p: 1, v: 0.0 }
  ]),
  
  // Color gradient: red -> yellow -> smoke
  colorGradient: new GradientCurve([
    { t: 0, c: new THREE.Color(1, 0, 0) },
    { t: 0.5, c: new THREE.Color(1, 1, 0) },
    { t: 1, c: new THREE.Color(0.2, 0.2, 0.2) }
  ])
});
```

### Advanced Physics

Enable complex interactions like depth collisions and vector fields.

```typescript
const particles = new GPUParticleSystem({
  // Bounce off scene geometry (requires depth texture)
  depthCollisions: true,
  bounciness: 0.6,
  
  // Simple floor collision
  floorY: 0, 
  
  // 3D Vector field for flow effects
  vectorField: myVectorFieldTexture3D,
  turbulence: 0.5,
});

// Important: Pass depth texture for depth collisions inside render loop
particles.setDepthTexture(depthTexture);
```

### Custom Materials

Inject your own TSL-based material for full shader control. Two approaches available:

#### Option A: Material Injection
Pass a pre-created material and access `particleNodes` after construction.

```typescript
import { SpriteNodeMaterial } from 'three/webgpu';
import { mix, color, instanceIndex } from 'three/tsl';

const customMaterial = new SpriteNodeMaterial();

const particles = new GPUParticleSystem({
  material: customMaterial,
  // ... other config
});

// Build shader using particle nodes
const { velocities, progress, speed } = particles.particleNodes;

// Use helper functions for cleaner code
customMaterial.colorNode = mix(color(0xff0000), color(0xffff00), speed().div(10));
customMaterial.opacityNode = progress().oneMinus();
customMaterial.scaleNode = progress().oneMinus().mul(0.5);
```

#### Option B: Material Factory (Recommended)
Use `materialFactory` callback for cleaner access to particle context.

```typescript
import { SpriteNodeMaterial } from 'three/webgpu';
import { mix, color } from 'three/tsl';

const particles = new GPUParticleSystem({
  materialFactory: (ctx) => {
    const mat = new SpriteNodeMaterial();
    
    // ctx provides storage nodes + helper functions
    mat.colorNode = mix(color(0xff0000), color(0xffff00), ctx.speed().div(10));
    mat.opacityNode = ctx.progress().oneMinus();
    mat.scaleNode = ctx.progress().oneMinus().mul(0.5);
    
    return mat;
  },
  // ... other config
});
```

**ParticleMaterialContext properties:**
- `positions`, `velocities`, `ages`, `lifetimes`, `rotations`, `colors`, `styles` - Storage nodes
- `time`, `delta` - Uniforms
- `index` - Instance index node
- `progress()` - Returns lifetime progress (0-1)
- `speed()` - Returns velocity magnitude
- `direction()` - Returns normalized velocity
- `styleIndex()` - Returns style index for current particle
- `isStyle(n)` - Returns true if particle matches style n
- `styleCount` - Number of defined styles

### Multi-Style Particles

Create particles with multiple visual styles (e.g., fire + smoke) in a single emitter.

```typescript
import { SpriteNodeMaterial } from 'three/webgpu';
import { mix, color } from 'three/tsl';

const particles = new GPUParticleSystem({
  styles: [
    { name: 'fire', weight: 3, color: new THREE.Color(0xff3300) },
    { name: 'smoke', weight: 1, color: new THREE.Color(0x333333) }
  ],
  materialFactory: (ctx) => {
    const mat = new SpriteNodeMaterial();
    
    // ctx.isStyle(0) returns 1 for fire, 0 for smoke
    const isFire = ctx.isStyle(0);
    mat.colorNode = mix(color(0x333333), color(0xff3300), isFire);
    mat.opacityNode = ctx.progress().oneMinus();
    
    return mat;
  }
});
```

Style weights determine spawn distribution: fire (weight 3) spawns 75%, smoke (weight 1) spawns 25%.

## API Reference

### GPUParticleSystemConfig

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
  emitterMesh?: THREE.Mesh;   // Emit from surface of mesh
  
  // Visual
  texture?: THREE.Texture;
  textureSheet?: TextureSheetConfig; // Sprite sheet config
  colorStart?: THREE.Color;
  colorEnd?: THREE.Color;
  sizeStart?: number;
  sizeEnd?: number;
  opacityStart?: number;
  opacityEnd?: number;
  
  // Curves
  sizeCurve?: LifetimeCurve | CurvePreset;
  opacityCurve?: LifetimeCurve | CurvePreset;
  colorGradient?: GradientCurve;
  
  // Physics
  velocity?: THREE.Vector3;
  velocityVariation?: THREE.Vector3;
  gravity?: THREE.Vector3;
  drag?: number;
  turbulence?: number;
  vectorField?: THREE.Data3DTexture;
  
  // Trails
  trail?: TrailConfig;
  
  // Collisions
  depthCollisions?: boolean;
  bounciness?: number;
  floorY?: number;
  
  // Quality
  sorted?: boolean;           // Back-to-front sorting
  softParticles?: boolean;    // Depth-aware fading
  softness?: number;          // Soft edge distance
  frustumCulled?: boolean;    // GPU frustum culling
  
  // LOD
  lod?: LODConfig[];
}
```

## Performance Tips

1. **Set `maxParticles` appropriately** - Allocates GPU memory upfront.
2. **Use `sorted: false`** unless alpha blending requires strict ordering.
3. **Control Trail Segments**: Higher segments = more memory and vertices. default(8) is usually good.
4. **Disable `softParticles`** if not needed, as it adds a depth read overhead.
5. **Pool particle systems** - Reuse systems for ephemeral effects instead of creating/destroying.

## Browser Support

| Browser | Status |
|---------|--------|
| Chrome 113+ | ✅ Full support |
| Edge 113+ | ✅ Full support |
| Firefox Nightly | ⚠️ Experimental (enable `dom.webgpu.enabled`) |
| Safari 18+ | ⚠️ Experimental |

## License

MIT © Interverse Engine