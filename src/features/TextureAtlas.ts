import * as THREE from 'three';
import { Node } from 'three/webgpu';
import { texture, uniform, Fn, vec2, float } from 'three/tsl';
import type { TextureSheetConfig } from '../types';

export class TextureAtlas {
  private texture: THREE.Texture;
  private config: TextureSheetConfig;
  private uniforms: Record<string, any>;
  
  constructor(texture: THREE.Texture, config: TextureSheetConfig) {
    this.texture = texture;
    this.config = config;
    
    this.uniforms = {
      uTextureSheetTiles: uniform(new THREE.Vector2(config.tilesX, config.tilesY)),
      uTextureSheetFPS: uniform(config.fps || 24),
      uTextureSheetLoop: uniform(config.loop || true),
    };
  }
  
  sample(index: Node, uv: Node, progress: Node): Node {
    return Fn(() => {
      // Calculate current frame
      const frame = this.calculateFrame(index, progress);
      
      // Calculate tile coordinates
      const tileX = frame.mod(this.uniforms.uTextureSheetTiles.value.x);
      const tileY = frame.div(this.uniforms.uTextureSheetTiles.value.x).floor();
      
      const tileSizeX = float(1.0).div(this.uniforms.uTextureSheetTiles.value.x);
      const tileSizeY = float(1.0).div(this.uniforms.uTextureSheetTiles.value.y);
      
      // Calculate UV within tile
      const uvX = tileX.mul(tileSizeX).add(uv.x.mul(tileSizeX));
      const uvY = tileY.mul(tileSizeY).add(uv.y.mul(tileSizeY));
      
      // Sample texture
      return texture(this.texture, vec2(uvX, uvY));
    })();
  }
  
  private calculateFrame(index: Node, progress: Node): Node {
    const totalFrames = this.config.totalFrames || 
      (this.config.tilesX * this.config.tilesY);
    
    const time = progress.mul(float(totalFrames).div(this.uniforms.uTextureSheetFPS));
    
    if (this.config.loop) {
      return time.mod(totalFrames).floor();
    } else {
      return time.clamp(0, totalFrames - 1).floor();
    }
  }
  
  getUniforms(): Record<string, any> {
    return this.uniforms;
  }
  
  dispose(): void {
    this.texture.dispose();
  }
}