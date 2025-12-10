export class VFXGraph {
  private nodes: VFXNode[] = [];
  
  addNode(node: VFXNode): void {
    this.nodes.push(node);
  }
  
  removeNode(node: VFXNode): void {
    const index = this.nodes.indexOf(node);
    if (index !== -1) {
      this.nodes.splice(index, 1);
    }
  }
  
  execute(): void {
    // Execute all nodes in order
    this.nodes.forEach(node => node.execute());
  }
}

export class VFXNode {
  protected inputs: Map<string, any> = new Map();
  protected outputs: Map<string, any> = new Map();
  
  setInput(name: string, value: any): void {
    this.inputs.set(name, value);
  }
  
  getOutput(name: string): any {
    return this.outputs.get(name);
  }
  
  execute(): void {
    // Override in subclasses
  }
}
