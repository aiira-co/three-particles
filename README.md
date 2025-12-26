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

## Runtime Property Updates (v1.5.0+)

Particle appearance properties can be updated at runtime without rebuilding the particle system. These properties use GPU uniforms for real-time updates:

```typescript
// Color
particles.setColor(new THREE.Color(0x00ff00));        // Set both start and end
particles.setColorStart(new THREE.Color(1, 0.5, 0));  // Just start color
particles.setColorEnd(new THREE.Color(1, 0, 0));      // Just end color

// Size
particles.setSize(0.2, 0.05);        // Start and end size
particles.setSizeStart(0.3);         // Just start size
particles.setSizeEnd(0.01);          // Just end size

// Opacity
particles.setOpacity(1.0, 0.0);      // Start and end opacity
particles.setOpacityStart(0.8);      // Just start opacity
particles.setOpacityEnd(0.2);        // Just end opacity

// Billboard mode (v1.6.0+)
particles.setBillboard(true);        // Particles face camera
particles.setBillboard(false);       // Particles use geometry orientation

// Geometry (v1.7.0+) - expensive operation, recreates mesh
particles.setGeometry(new THREE.SphereGeometry(0.5, 8, 8));

// Emitter Shape (v1.7.0+)
particles.setEmitterShape('sphere', new THREE.Vector3(2, 2, 2));  // Shape + size
particles.setEmitterShape('box');    // Just shape, keep existing size
```

These setters update uniforms directly (except `setGeometry` which recreates the mesh), so changes are reflected immediately.

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

## Providers

Providers extend particle behavior with modular forces and effects. Add multiple providers to create complex simulations.

### Using Providers

```typescript
import { 
  GPUParticleSystem, 
  AttractorProvider, 
  TurbulenceProvider,
  BoidsProvider 
} from '@interverse/three-particles';

const particles = new GPUParticleSystem({ /* config */ });

// Add attractor force field
const attractor = new AttractorProvider(4); // max 4 attractors
attractor.addAttractor({ 
  position: new THREE.Vector3(0, 2, 0), 
  strength: 5 
});
particles.addProvider(attractor);

// Add turbulence for organic motion
particles.addProvider(new TurbulenceProvider({ 
  frequency: 0.5, 
  amplitude: 1.0 
}));
```

### Available Providers

| Provider | Description |
|----------|-------------|
| **AttractorProvider** | Point/area attraction with optional spin |
| **BoidsProvider** | Flocking behavior ([Reynolds' Boids](https://www.red3d.com/cwr/boids/)) |
| **TurbulenceProvider** | Noise-based turbulent motion |
| **VortexProvider** | Spiral/vortex swirling forces |
| **WindProvider** | Directional wind with gusts |
| **PathProvider** | Guide particles along curves |
| **MouseInteractionProvider** | Mouse/touch push/pull interaction |
| **DepthCollisionProvider** | Bounce off scene geometry |

---

### AttractorProvider

Creates gravitational/magnetic point attractors that pull particles.

```typescript
import { AttractorProvider } from '@interverse/three-particles';

const attractor = new AttractorProvider(8); // max 8 attractors

// Simple gravity point
attractor.addAttractor({
  position: new THREE.Vector3(0, 5, 0),
  strength: 10
});

// Spinning attractor (vortex-like)
attractor.addAttractor({
  position: new THREE.Vector3(3, 0, 0),
  strength: 5,
  spinAxis: new THREE.Vector3(0, 1, 0),
  spinStrength: 2.0
});

// Update attractor position at runtime
attractor.updateAttractor(0, { position: new THREE.Vector3(0, 8, 0) });

particles.addProvider(attractor);
```

**AttractorConfig:**
- `position: Vector3` - Attractor world position
- `strength: number` - Pull force (higher = stronger)
- `spinAxis?: Vector3` - Axis for orbital spin
- `spinStrength?: number` - Spin force multiplier
- `falloff?: 'linear' | 'inverse' | 'inverseSq'` - Distance falloff (default: inverseSq)

---

### BoidsProvider

Implements Craig Reynolds' [flocking algorithm](https://www.red3d.com/cwr/boids/) with three core rules: separation, alignment, and cohesion. Enhanced with goal seeking and boundary avoidance.

```typescript
import { BoidsProvider } from '@interverse/three-particles';

const boids = new BoidsProvider({
  // Core Reynolds' rules
  separationWeight: 1.5,  // Avoid crowding
  alignmentWeight: 1.0,   // Match neighbor velocity
  cohesionWeight: 1.2,    // Move toward flock center
  
  // Perception
  neighborRadius: 2.5,    // How far to look for neighbors
  separationRadius: 1.0,  // Personal space radius
  
  // Movement limits
  maxSpeed: 5.0,
  maxForce: 1.0,          // Max steering force
  
  // Containment
  boundSize: 10,          // Soft boundary size
  boundaryForce: 2.0,     // Edge avoidance strength
  
  // Optional goal seeking (for scripted paths)
  goalPosition: new THREE.Vector3(5, 0, 0),
  goalWeight: 0.5,
  
  // Organic randomness
  wanderStrength: 0.3
});

// Adjust at runtime
boids.setSeparationWeight(2.0);
boids.setGoal(new THREE.Vector3(10, 5, 0), 0.8);

particles.addProvider(boids);
```

**BoidsConfig:**
- `separationWeight?: number` - Avoid crowding neighbors
- `alignmentWeight?: number` - Steer toward average heading
- `cohesionWeight?: number` - Steer toward average position
- `neighborRadius?: number` - Perception distance
- `separationRadius?: number` - Personal space distance
- `maxSpeed?: number` - Maximum speed limit
- `maxForce?: number` - Maximum steering force
- `boundSize?: number` - Soft boundary size
- `boundaryForce?: number` - Edge avoidance strength
- `goalPosition?: Vector3` - Optional goal to steer toward
- `goalWeight?: number` - Goal seeking strength
- `wanderStrength?: number` - Random organic motion

---

### TurbulenceProvider

Physics-based turbulent forces following [fluid dynamics principles](https://journals.aps.org/prresearch/abstract/10.1103/PhysRevResearch.6.L012013). Implements Kolmogorov's energy cascade and Reynolds number effects.

```typescript
import { TurbulenceProvider } from '@interverse/three-particles';

const turbulence = new TurbulenceProvider({
  // Base turbulence
  frequency: 0.5,
  amplitude: 1.0,
  octaves: 3,
  friction: 0.02,
  
  // Physics enhancements
  velocitySensitivity: 0.3,   // More turbulence at higher speeds
  intermittency: 0.4,         // Puff-like variation over time
  intermittencyFrequency: 0.5,
  kolmogorovScaling: 0.7,     // Follow -5/3 energy law
  
  // Wake effect
  flowDirection: new THREE.Vector3(1, 0, 0),
  wakeIntensity: 0.5          // Stronger behind flow
});

// Adjust at runtime
turbulence.setVelocitySensitivity(0.5);
turbulence.setKolmogorovScaling(1.0);

particles.addProvider(turbulence);
```

**TurbulenceConfig:**
- `frequency?: number` - Noise spatial frequency
- `amplitude?: number` - Force strength
- `octaves?: number` - Noise layers (1-4)
- `friction?: number` - Velocity damping (viscosity)
- `velocitySensitivity?: number` - Reynolds effect (faster = more turbulent)
- `intermittency?: number` - Puff behavior intensity
- `intermittencyFrequency?: number` - Puff frequency
- `kolmogorovScaling?: number` - 0=flat, 1=physically realistic -5/3 law
- `flowDirection?: Vector3` - Direction for wake calculation
- `wakeIntensity?: number` - Turbulence boost in wake regions

---

### VortexProvider

Creates a swirling vortex that pulls particles while spinning them around an axis.

```typescript
import { VortexProvider } from '@interverse/three-particles';

const vortex = new VortexProvider({
  center: new THREE.Vector3(0, 0, 0),
  axis: new THREE.Vector3(0, 1, 0),  // Spin around Y
  strength: 2.0,      // Spin force
  pullStrength: 0.5,  // Pull toward center
  radius: 8.0         // Effect radius
});

// Move vortex at runtime
vortex.setCenter(new THREE.Vector3(5, 0, 0));
vortex.setStrength(3.0);

particles.addProvider(vortex);
```

**VortexConfig:**
- `center?: Vector3` - Vortex center position
- `axis?: Vector3` - Rotation axis (normalized)
- `strength?: number` - Spinning force
- `pullStrength?: number` - Inward pull force
- `radius?: number` - Effect radius (falloff)

---

### MouseInteractionProvider

Enables mouse/touch interaction to push or pull particles.

```typescript
import { MouseInteractionProvider } from '@interverse/three-particles';

const mouse = new MouseInteractionProvider({
  strength: 5.0,
  radius: 3.0,
  push: true  // false = pull particles
});

particles.addProvider(mouse);

// Update mouse position in animation loop
mouse.setMousePosition(mouseWorldPos);
```

---

### WindProvider

Applies directional wind forces with gusts and turbulence for natural outdoor effects.

```typescript
import { WindProvider } from '@interverse/three-particles';

const wind = new WindProvider({
  direction: new THREE.Vector3(1, 0, 0.2),  // Wind direction
  strength: 2.0,         // Base force
  gustStrength: 1.5,     // Extra burst force
  gustFrequency: 0.3,    // Gusts per second
  turbulence: 0.3,       // Random variation
  heightFactor: 0.1      // Stronger wind at higher Y
});

// Change wind direction at runtime
wind.setDirection(new THREE.Vector3(-1, 0.2, 0));
wind.setStrength(4.0);

particles.addProvider(wind);
```

**WindConfig:**
- `direction?: Vector3` - Wind direction (normalized)
- `strength?: number` - Base wind force
- `gustStrength?: number` - Additional burst force
- `gustFrequency?: number` - Gust frequency (per second)
- `turbulence?: number` - Random position-based variation (0-1)
- `heightFactor?: number` - Wind strength increase per unit Y

---

### PathProvider

Guides particles along a predefined path with attraction and alignment forces.

```typescript
import { PathProvider } from '@interverse/three-particles';

const path = new PathProvider({
  pathPoints: [
    new THREE.Vector3(-5, 0, 0),
    new THREE.Vector3(0, 4, 2),
    new THREE.Vector3(5, 1, -1),
    new THREE.Vector3(8, 0, 0)
  ],
  attraction: 2.0,   // Pull toward path
  alignment: 1.5,    // Push along path direction
  spread: 1.0,       // Max distance from path
  speed: 1.0
});

// Update path at runtime
path.setPath([...newPoints]);

particles.addProvider(path);
```

**PathConfig:**
- `pathPoints?: Vector3[]` - Path control points (min 2)
- `attraction?: number` - Force pulling toward path
- `alignment?: number` - Force pushing along path
- `spread?: number` - Allowed deviation distance
- `speed?: number` - Movement speed along path
- `loop?: boolean` - Loop back to start

---

### Creating Custom Providers

Extend `BaseProvider` to create custom force behaviors:

```typescript
import { BaseProvider, ProviderContext } from '@interverse/three-particles';
import { vec3, Fn } from 'three/tsl';

class WindProvider extends BaseProvider {
  name = 'WindProvider';
  priority = 30;

  getForceNode(ctx: ProviderContext) {
    return Fn(() => {
      // Simple wind force
      return vec3(1.0, 0, 0.5).mul(2.0);
    })();
  }
}
```

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