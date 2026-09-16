import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder';
import { VertexBuffer } from '@babylonjs/core/Buffers/buffer';

/** Babylon's plane UVs face a left-handed viewer; keep text readable in our north-up world. */
export function displayPlane(...args: Parameters<typeof MeshBuilder.CreatePlane>) {
  const mesh = MeshBuilder.CreatePlane(...args);
  const uv = mesh.getVerticesData(VertexBuffer.UVKind)!;
  for (let i = 0; i < uv.length; i += 2) uv[i] = 1 - uv[i];
  mesh.setVerticesData(VertexBuffer.UVKind, uv);
  return mesh;
}
