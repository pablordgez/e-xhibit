import { Scene } from '@babylonjs/core/scene';
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder';
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { DynamicTexture } from '@babylonjs/core/Materials/Textures/dynamicTexture';
import { Color3 } from '@babylonjs/core/Maths/math.color';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { type Layout, type MuseumDocument, type Vec, type WalkArea } from '../core/model';
import { straightTreads, SPIRAL_RADIUS } from '../core/architecture';

export type TextureSlot = {
  mesh: Mesh;
  material: StandardMaterial;
  assetId: string;
  size: string;
  loaded: boolean;
  pending: boolean;
  last: number;
};
type Box = (
  name: string,
  x: number,
  y: number,
  z: number,
  w: number,
  h: number,
  d: number,
  color: string,
) => Mesh;
type Material = (color: string) => StandardMaterial;

/** A smooth circular slab edge, without dozens of visible rectangular notches. */
export function buildCircularSlab(
  area: WalkArea,
  openings: WalkArea[],
  scene: Scene,
  box: Box,
  material: Material,
  color: string,
  ceiling = false,
  wood = false,
) {
  const holes = openings.filter(
    (h) =>
      Math.abs(h.y - area.y) < 0.01 &&
      Math.abs(h.x - area.x) < (h.w + area.w) / 2 &&
      Math.abs(h.z - area.z) < (h.d + area.d) / 2,
  );
  if (
    holes.length !== 1 ||
    holes[0].shape !== 'circle' ||
    Math.abs(holes[0].x - area.x) > 0.01 ||
    Math.abs(holes[0].z - area.z) > 0.01
  )
    return false;
  const radius = holes[0].w / 2,
    segments = 96,
    positions: number[] = [],
    indices: number[] = [];
  const bottom = ceiling ? area.y : area.y - 0.12,
    top = bottom + 0.12;
  const quad = (a: Vec, b: Vec, c: Vec, d: Vec) => {
    const i = positions.length / 3;
    for (const p of [a, b, c, d]) positions.push(p.x, p.y, p.z);
    indices.push(i, i + 2, i + 1, i, i + 3, i + 2);
  };
  const point = (angle: number, r: number, y: number): Vec => ({
    x: area.x + Math.cos(angle) * r,
    y,
    z: area.z + Math.sin(angle) * r,
  });
  for (let i = 0; i < segments; i++) {
    const a = (i * Math.PI * 2) / segments,
      b = ((i + 1) * Math.PI * 2) / segments;
    const ra = Math.min(
      area.w / 2 / Math.max(Math.abs(Math.cos(a)), 1e-8),
      area.d / 2 / Math.max(Math.abs(Math.sin(a)), 1e-8),
    );
    const rb = Math.min(
      area.w / 2 / Math.max(Math.abs(Math.cos(b)), 1e-8),
      area.d / 2 / Math.max(Math.abs(Math.sin(b)), 1e-8),
    );
    quad(point(a, radius, top), point(b, radius, top), point(b, rb, top), point(a, ra, top));
    quad(
      point(a, radius, bottom),
      point(a, ra, bottom),
      point(b, rb, bottom),
      point(b, radius, bottom),
    );
    quad(
      point(a, radius, bottom),
      point(b, radius, bottom),
      point(b, radius, top),
      point(a, radius, top),
    );
    quad(point(a, ra, bottom), point(a, ra, top), point(b, rb, top), point(b, rb, bottom));
  }
  const normals: number[] = [];
  VertexData.ComputeNormals(positions, indices, normals);
  const mesh = new Mesh(ceiling ? 'ceiling' : 'floor', scene),
    data = new VertexData();
  data.positions = positions;
  data.indices = indices;
  data.normals = normals;
  data.applyToMesh(mesh);
  mesh.material = material(color);
  if (wood && !ceiling)
    for (let z = area.z - area.d / 2 + 0.4; z < area.z + area.d / 2; z += 0.4) {
      const offset = z - area.z;
      const gap = Math.abs(offset) < radius ? Math.sqrt(radius * radius - offset * offset) : 0;
      if (!gap) box('wood-joint', area.x, area.y + 0.003, z, area.w, 0.002, 0.008, '#a7947d');
      else
        for (const side of [-1, 1]) {
          const width = area.w / 2 - gap;
          box(
            'wood-joint',
            area.x + side * (gap + width / 2),
            area.y + 0.003,
            z,
            width,
            0.002,
            0.008,
            '#a7947d',
          );
        }
    }
  return true;
}

export function buildStairs(layout: Layout, scene: Scene, box: Box, material: Material) {
  for (const solid of layout.structures)
    box(
      solid.name,
      solid.x,
      solid.y + solid.h / 2,
      solid.z,
      solid.w,
      solid.h,
      solid.d,
      solid.color,
    );
  for (const ramp of layout.ramps) {
    if (ramp.kind === 'stairs') {
      for (const step of straightTreads(ramp)) {
        const mesh = box(
          'closed-stair-tread',
          step.x,
          step.y + step.h / 2,
          step.z,
          step.w,
          step.h,
          step.d,
          '#b09a7b',
        );
        mesh.rotation.y = step.rotation;
      }
      const points =
        ramp.points[0].y < ramp.points.at(-1)!.y ? ramp.points : [...ramp.points].reverse();
      const a = points[1],
        b = points.at(-2)!;
      const dx = Math.sign(b.x - a.x),
        dz = Math.sign(b.z - a.z);
      for (const side of [-1, 1]) {
        const rail = MeshBuilder.CreateTube(
          'stair-handrail',
          {
            path: [a, b].map(
              (p) => new Vector3(p.x + dz * side * 0.68, p.y + 0.95, p.z + dx * side * 0.68),
            ),
            radius: 0.035,
            tessellation: 8,
          },
          scene,
        );
        rail.material = material('#3d403e');
      }
      continue;
    }
    const points =
      ramp.points[0].y < ramp.points.at(-1)!.y ? ramp.points : [...ramp.points].reverse();
    const bottom = points[0].y,
      top = points.at(-1)!.y;
    const cx = points[1].x - 1.5,
      cz = points[1].z;
    const count = Math.ceil((top - bottom) / 0.15);
    // Wedge treads reach the load-bearing centre column, instead of floating
    // tangential planks around an unrelated post.
    for (let i = 0; i < count; i++) {
      const positions: number[] = [],
        indices: number[] = [];
      const angleA = (i / count) * Math.PI * 2,
        angleB = ((i + 1) / count) * Math.PI * 2 + 0.003;
      const y = bottom + ((top - bottom) * (i + 1)) / count;
      const segments = 4;
      for (const height of [y - 0.13, y])
        for (const radius of [0.1, SPIRAL_RADIUS])
          for (let n = 0; n <= segments; n++) {
            const angle = angleA + ((angleB - angleA) * n) / segments;
            positions.push(cx + radius * Math.cos(angle), height, cz + radius * Math.sin(angle));
          }
      const row = segments + 1;
      const quad = (a: number, b: number, c: number, d: number) => indices.push(a, b, c, a, c, d);
      for (let n = 0; n < segments; n++) {
        quad(n, n + 1, row + n + 1, row + n);
        quad(row * 2 + n, row * 3 + n, row * 3 + n + 1, row * 2 + n + 1);
        quad(n, row * 2 + n, row * 2 + n + 1, n + 1);
        quad(row + n, row + n + 1, row * 3 + n + 1, row * 3 + n);
      }
      quad(0, row, row * 3, row * 2);
      quad(row - 1, row * 3 - 1, row * 4 - 1, row * 2 - 1);
      const normals: number[] = [];
      VertexData.ComputeNormals(positions, indices, normals);
      const mesh = new Mesh('spiral-wedge', scene),
        data = new VertexData();
      data.positions = positions;
      data.indices = indices;
      data.normals = normals;
      data.applyToMesh(mesh);
      mesh.convertToFlatShadedMesh();
      mesh.material = material('#b09a7b');
    }
    const column = MeshBuilder.CreateCylinder(
      'spiral-support-column',
      { diameter: 0.23, height: top - bottom + 0.06, tessellation: 24 },
      scene,
    );
    column.position.set(cx, bottom + (top - bottom + 0.06) / 2, cz);
    column.material = material('#363b38');
    for (const y of [bottom, top]) {
      box('spiral-landing', cx + 1.99, y - 0.06, cz, 1.02, 0.12, 0.94, '#b09a7b');
      const collar = MeshBuilder.CreateCylinder(
        'column-anchor',
        { diameter: 0.4, height: 0.045, tessellation: 24 },
        scene,
      );
      collar.position.set(cx, y + 0.025, cz);
      collar.material = material('#363b38');
    }
    const railPath: Vector3[] = [];
    for (let i = 0; i <= 96; i++) {
      const angle = (i / 96) * Math.PI * 2,
        y = bottom + ((top - bottom) * i) / 96;
      railPath.push(new Vector3(cx + Math.cos(angle) * 2, y + 0.98, cz + Math.sin(angle) * 2));
      if (i % 8 === 0) {
        const post = MeshBuilder.CreateCylinder(
          'spiral-baluster',
          { diameter: 0.04, height: 0.98, tessellation: 8 },
          scene,
        );
        post.position.set(cx + Math.cos(angle) * 2, y + 0.49, cz + Math.sin(angle) * 2);
        post.material = material('#363b38');
      }
    }
    const rail = MeshBuilder.CreateTube(
      'spiral-handrail',
      { path: railPath, radius: 0.035, tessellation: 8 },
      scene,
    );
    rail.material = material('#363b38');
  }
}

function signMaterial(scene: Scene, kind: 'info' | 'download' | 'book' | 'shop') {
  const texture = new DynamicTexture(`sign-${kind}`, { width: 512, height: 512 }, scene, false);
  const ctx = texture.getContext() as CanvasRenderingContext2D;
  ctx.fillStyle = kind === 'book' ? '#f3ecd9' : '#253932';
  ctx.fillRect(0, 0, 512, 512);
  ctx.fillStyle = kind === 'book' ? '#4c463a' : '#f5f0e3';
  ctx.strokeStyle = ctx.fillStyle;
  ctx.textAlign = 'center';
  if (kind === 'info') {
    ctx.lineWidth = 12;
    ctx.beginPath();
    ctx.arc(256, 185, 102, 0, Math.PI * 2);
    ctx.stroke();
    ctx.font = 'bold 165px Georgia';
    ctx.fillText('i', 256, 244);
  } else if (kind === 'download') {
    ctx.lineWidth = 18;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(256, 85);
    ctx.lineTo(256, 225);
    ctx.moveTo(200, 177);
    ctx.lineTo(256, 237);
    ctx.lineTo(312, 177);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(170, 240);
    ctx.lineTo(170, 275);
    ctx.lineTo(342, 275);
    ctx.lineTo(342, 240);
    ctx.stroke();
  } else if (kind === 'shop') {
    ctx.lineWidth = 12;
    ctx.strokeRect(166, 145, 180, 160);
    ctx.beginPath();
    ctx.arc(256, 147, 48, Math.PI, 0);
    ctx.stroke();
  } else {
    ctx.fillStyle = '#d5c8ad';
    ctx.fillRect(250, 0, 12, 512);
    ctx.fillStyle = '#665e4d';
    ctx.font = 'bold 25px Georgia';
    ctx.fillText('VISITOR GUIDE', 132, 88);
    ctx.fillText('WELCOME', 380, 88);
    for (let y = 135; y < 445; y += 30) {
      ctx.fillRect(30, y, 180, 3);
      ctx.fillRect(287, y, 185, 3);
    }
  }
  if (kind !== 'book') {
    ctx.font = 'bold 38px sans-serif';
    ctx.fillText(
      kind === 'info' ? 'INFORMATION' : kind === 'shop' ? 'MUSEUM SHOP' : 'DOWNLOADS',
      256,
      372,
    );
    ctx.font = '23px sans-serif';
    ctx.fillText(
      kind === 'info'
        ? 'Open the visitor book'
        : kind === 'shop'
          ? 'Prints · Books · Editions'
          : 'Browse the collection',
      256,
      422,
    );
  }
  texture.update();
  const material = new StandardMaterial(`sign-material-${kind}`, scene);
  material.diffuseTexture = texture;
  material.emissiveColor = new Color3(0.38, 0.38, 0.38);
  material.specularColor = Color3.Black();
  return material;
}

export function buildFurnishings(
  doc: MuseumDocument,
  layout: Layout,
  scene: Scene,
  box: Box,
  material: Material,
  textures: TextureSlot[],
) {
  const signs = new Map<string, StandardMaterial>();
  const sign = (kind: 'info' | 'download' | 'book' | 'shop') => {
    if (!signs.has(kind)) signs.set(kind, signMaterial(scene, kind));
    return signs.get(kind)!;
  };
  for (const f of layout.furnishings) {
    const room = doc.rooms.find((r) => r.id === f.roomId)!;
    const cos = Math.cos(f.rotation),
      sin = Math.sin(f.rotation);
    const at = (x: number, y: number, z: number): Vec => ({
      x: f.x + x * cos + z * sin,
      y: f.y + y,
      z: f.z - x * sin + z * cos,
    });
    const w = Math.abs(sin) > 0.5 ? f.d : f.w,
      d = Math.abs(sin) > 0.5 ? f.w : f.d;
    const part = (
      name: string,
      x: number,
      y: number,
      z: number,
      width: number,
      height: number,
      depth: number,
      color: string,
    ) => {
      const p = at(x, y, z);
      const m = box(name, p.x, p.y, p.z, width, height, depth, color);
      m.rotation.y = f.rotation;
      if (f.kind === 'stand')
        m.metadata = { kind: room.kind === 'shop' ? 'shop' : 'book', id: room.id };
      return m;
    };
    const panel = (
      kind: 'info' | 'download' | 'book' | 'shop',
      x: number,
      y: number,
      z: number,
      width: number,
      height: number,
      flat = false,
    ) => {
      const m = MeshBuilder.CreatePlane(
        `sign-${kind}`,
        { width, height, sideOrientation: Mesh.DOUBLESIDE },
        scene,
      );
      const p = at(x, y, z);
      m.position.set(p.x, p.y, p.z);
      m.rotation.y = f.rotation;
      if (flat) m.rotation.x = Math.PI / 2;
      m.material = sign(kind);
      if (f.kind === 'stand')
        m.metadata = { kind: room.kind === 'shop' ? 'shop' : 'book', id: room.id };
      return m;
    };
    if (f.kind === 'stand' && room.kind === 'information') {
      part('information-booth', 0, 0.48, 0, w, 0.96, d, '#a17f55');
      part('information-counter', 0, 1.005, 0, w, 0.09, d, '#e0d2b9');
      if (!f.mounted) {
        part('booth-recess', 0, 0.49, -d / 2 - 0.003, w - 0.14, 0.66, 0.01, '#353e36');
        part('information-sign-post', w * 0.33, 1.37, d * 0.28, 0.045, 0.7, 0.045, '#353e36');
        panel('info', w * 0.33, 1.79, d * 0.28 - 0.03, 0.44, 0.44);
      } else panel('info', 0, 1.8, -d / 2 - 0.01, 0.55, 0.55);
      part(
        'book-binding',
        -w * 0.12,
        1.07,
        -0.015,
        Math.min(w * 0.6, 0.55),
        0.04,
        Math.min(d * 0.8, 0.4),
        '#684737',
      );
      panel(
        'book',
        -w * 0.12,
        1.094,
        -0.015,
        Math.min(w * 0.6, 0.53),
        Math.min(d * 0.8, 0.38),
        true,
      );
    } else if (f.kind === 'stand') {
      if (!f.mounted) {
        part('kiosk-base', 0, 0.05, 0, w, 0.1, d, '#323a36');
        part('kiosk-pedestal', 0, 0.64, 0, w * 0.55, 1.18, d * 0.62, '#59665e');
      }
      part('kiosk-screen-housing', 0, 1.5, 0, w, 0.86, Math.min(d, 0.18), '#26312c');
      panel('download', 0, 1.52, -Math.min(d, 0.18) / 2 - 0.005, w * 0.86, 0.72);
      part(
        'kiosk-status-light',
        0,
        1.1,
        -Math.min(d, 0.18) / 2 - 0.01,
        0.08,
        0.018,
        0.015,
        '#c5dbb3',
      );
    } else if (f.kind === 'shelf') {
      for (let row = 0; row < 3; row++) {
        const y = 0.68 + row * 0.68;
        part('shop-shelf', 0, y, 0, w, 0.08, d, '#99734c');
        for (const x of [-w * 0.37, w * 0.37])
          part('shelf-bracket', x, y - 0.12, d * 0.15, 0.035, 0.2, d * 0.75, '#39433c');
        const ids = room.shelves.slice(0, 9);
        for (let j = 0; j < 3; j++) {
          const a = doc.assets.find((a) => a.id === ids[(row * 3 + j) % Math.max(ids.length, 1)]);
          if (!a) {
            part(
              'edition-spines',
              (j - 1) * 0.43,
              y + 0.15,
              0,
              0.25,
              0.22,
              0.12,
              ['#bead88', '#526756', '#9d6553'][j],
            );
            continue;
          }
          const iw = Math.min(0.33, (0.48 * a.width) / a.height),
            ih = (iw * a.height) / a.width;
          const cy = y + 0.04 + (ih + 0.04) / 2;
          part('shop-print-frame', (j - 1) * 0.43, cy, 0, iw + 0.04, ih + 0.04, 0.035, '#544331');
          const mesh = MeshBuilder.CreatePlane('shop-print', { width: iw, height: ih }, scene);
          const p = at((j - 1) * 0.43, cy, -0.021);
          mesh.position.set(p.x, p.y, p.z);
          mesh.rotation.y = f.rotation;
          mesh.isPickable = false;
          const mat = new StandardMaterial('shop-print-material', scene);
          mat.specularColor = Color3.Black();
          mesh.material = mat;
          textures.push({
            mesh,
            material: mat,
            assetId: a.id,
            size: '',
            loaded: false,
            pending: false,
            last: 0,
          });
        }
      }
      panel('shop', 0, 2.73, -d / 2 - 0.01, 1.0, 0.55);
    } else if (f.kind === 'table') {
      part('shop-display-table', 0, 0.76, 0, w, 0.1, d, '#a98861');
      for (const x of [-w * 0.38, w * 0.38])
        for (const z of [-d * 0.35, d * 0.35])
          part('display-table-leg', x, 0.36, z, 0.05, 0.72, 0.05, '#37443b');
      for (let i = 0; i < 3; i++) {
        for (let n = 0; n < 3; n++)
          part(
            'catalog-stack',
            (i - 1) * 0.3,
            0.83 + n * 0.04,
            0,
            0.25,
            0.035,
            0.32,
            ['#607865', '#ded2b4', '#af7157'][i],
          );
        part('edition-band', (i - 1) * 0.3, 0.935, 0, 0.06, 0.005, 0.325, '#eee7d9');
      }
      part('display-rug', 0, 0.006, 0, w, 0.009, d, '#b5b0a0').isPickable = false;
    } else {
      const pot = MeshBuilder.CreateCylinder(
        'shop-planter',
        { diameterTop: 0.4, diameterBottom: 0.3, height: 0.45, tessellation: 20 },
        scene,
      );
      pot.position.set(f.x, f.y + 0.225, f.z);
      pot.material = material('#b39170');
      part('plant-stem', 0, 0.71, 0, 0.025, 0.6, 0.025, '#47553d');
      for (let i = 0; i < 7; i++) {
        const leaf = MeshBuilder.CreateSphere('plant-leaf', { diameter: 1, segments: 6 }, scene);
        leaf.scaling.set(0.12, 0.32, 0.06);
        leaf.position.set(
          f.x + Math.sin(i * 2.4) * 0.11,
          f.y + 0.77 + (i % 3) * 0.12,
          f.z + Math.cos(i * 2.4) * 0.11,
        );
        leaf.rotation.z = Math.sin(i * 2.4) * 0.7;
        leaf.material = material(i % 2 ? '#52664a' : '#73835b');
      }
    }
  }
}
