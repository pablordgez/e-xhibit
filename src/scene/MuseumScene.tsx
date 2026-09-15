import { surfacePlates, contains, boardLines, CEILING_SLAB } from '../core/architecture';
import { guidedStops, pathToGuidedStop, type GuidedStop } from '../core/guided';
import { buildStairs, buildFurnishings, buildCircularSlab, type TextureSlot } from './details';
import { useEffect, useRef, useState } from 'react';
import { Engine } from '@babylonjs/core/Engines/engine';
import { Scene } from '@babylonjs/core/scene';
import { UniversalCamera } from '@babylonjs/core/Cameras/universalCamera';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { Color3, Color4 } from '@babylonjs/core/Maths/math.color';
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight';
import { DirectionalLight } from '@babylonjs/core/Lights/directionalLight';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { Texture } from '@babylonjs/core/Materials/Textures/texture';
import { DynamicTexture } from '@babylonjs/core/Materials/Textures/dynamicTexture';
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import '@babylonjs/core/Culling/ray';
import '@babylonjs/core/Materials/standardMaterial';
import {
  compile,
  fitExhibit,
  routeBetween,
  avoidOpenings,
  corridorBoundaries,
  walkStep,
  navigationStops,
} from '../core/layout';
import {
  center,
  STOREY,
  HEIGHT,
  sideDelta,
  distance,
  type MuseumDocument,
  type Vec,
} from '../core/model';
import { assetUrl } from '../lib/storage';
export type SceneAction = { kind: 'art' | 'book' | 'shop'; id: string; narrate?: boolean };
type Props = {
  doc: MuseumDocument;
  mode: 'points' | 'walk';
  paused: boolean;
  destination: string | null;
  onAction: (action: SceneAction) => void;
  onRoom: (id: string) => void;
  onError: (message: string) => void;
  onTravel: (moving: boolean) => void;
};
export default function MuseumScene({
  doc,
  mode,
  paused,
  destination,
  onAction,
  onRoom,
  onError,
  onTravel,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null),
    state = useRef({ mode, paused, destination, onAction, onRoom, onError, onTravel }),
    [hint, setHint] = useState(''),
    [locked, setLocked] = useState(false);
  state.current = { mode, paused, destination, onAction, onRoom, onError, onTravel };
  const requestLock = async () => {
    const canvas = canvasRef.current;
    try {
      if (!canvas?.requestPointerLock) throw Error('unavailable');
      canvas.focus();
      await canvas.requestPointerLock();
    } catch {
      setHint('Mouse capture is unavailable. Use Point & explore, or try Start walking again.');
    }
  };
  useEffect(() => {
    const canvas = canvasRef.current!;
    let engine: Engine;
    try {
      engine = new Engine(canvas, true, {
        preserveDrawingBuffer: false,
        stencil: true,
        adaptToDeviceRatio: false,
      });
    } catch {
      onError('3D graphics are unavailable on this device. You can still explore the catalog.');
      return;
    }
    const scene = new Scene(engine);
    scene.clearColor = new Color4(0.89, 0.9, 0.88, 1);
    scene.ambientColor = new Color3(0.75, 0.75, 0.72);
    const layout = compile(doc),
      roomMap = new Map(doc.rooms.map((r) => [r.id, r]));
    const stops = navigationStops(doc, layout);
    const entrance = roomMap.get(doc.entrance) ?? doc.rooms[0];
    const spawn =
      stops
        .filter((p) => p.roomId === entrance.id)
        .sort((a, b) => distance(a, center(entrance)) - distance(b, center(entrance)))[0] ??
      center(entrance);
    let currentRoom = entrance.id,
      body: Vec = { ...spawn },
      path: Vec[] = [],
      goal: string | null = null,
      disposed = false;
    const camera = new UniversalCamera(
      'visitor',
      new Vector3(body.x, body.y + 1.65, body.z),
      scene,
    );
    camera.minZ = 0.06;
    camera.maxZ = 100;
    camera.fov = 1.1;
    camera.rotation.y = Math.PI;
    camera.inputs.clear();
    const light = new HemisphericLight('daylight', new Vector3(0.2, 1, -0.3), scene);
    light.intensity = 0.9;
    light.groundColor = new Color3(0.55, 0.52, 0.45);
    const sun = new DirectionalLight('soft-light', new Vector3(0.4, -1, 0.4), scene);
    sun.intensity = 0.45;
    const materials = new Map<string, StandardMaterial>();
    function material(color: string) {
      if (materials.has(color)) return materials.get(color)!;
      const m = new StandardMaterial(color, scene);
      m.diffuseColor = Color3.FromHexString(color);
      m.specularColor = new Color3(0.07, 0.07, 0.07);
      materials.set(color, m);
      return m;
    }
    function box(
      name: string,
      x: number,
      y: number,
      z: number,
      w: number,
      h: number,
      d: number,
      color: string,
    ) {
      const mesh = MeshBuilder.CreateBox(
        name,
        { width: Math.max(0.01, w), height: Math.max(0.01, h), depth: Math.max(0.01, d) },
        scene,
      );
      mesh.position.set(x, y, z);
      mesh.material = material(color);
      // Architecture occludes interaction with objects in other rooms.
      mesh.isPickable = true;
      return mesh;
    }
    for (const area of layout.areas) {
      const room = roomMap.get(area.roomId ?? '');
      if (
        buildCircularSlab(
          area,
          layout.holes,
          scene,
          box,
          material,
          room?.finish === 'stone' ? '#c2bdb0' : '#bba68a',
          false,
          room?.finish !== 'stone',
        )
      )
        continue;
      const plates = surfacePlates(area, layout.holes);
      for (const plate of plates) {
        box(
          'floor',
          plate.x,
          area.y - 0.06,
          plate.z,
          plate.w,
          0.12,
          plate.d,
          room?.finish === 'stone' ? '#c2bdb0' : '#bba68a',
        );
        if (room?.finish !== 'stone') {
          for (const z of boardLines(plate))
            box('wood-joint', plate.x, area.y + 0.003, z, plate.w, 0.002, 0.008, '#a7947d');
        }
      }
    }
    for (const area of layout.areas) {
      const room = roomMap.get(area.roomId ?? '');
      const ceilingY = area.y + HEIGHT;
      if (
        !buildCircularSlab(
          { ...area, y: ceilingY },
          layout.ceilingHoles,
          scene,
          box,
          material,
          room?.color ?? '#eeece5',
          true,
        )
      )
        for (const plate of surfacePlates({ ...area, y: ceilingY }, layout.ceilingHoles))
          box(
            'ceiling',
            plate.x,
            ceilingY + CEILING_SLAB / 2,
            plate.z,
            plate.w,
            CEILING_SLAB,
            plate.d,
            room?.color ?? '#eeece5',
          );
      const lights = room
        ? [
            [-1.85, -1.85],
            [1.85, -1.85],
            [-1.85, 1.85],
            [1.85, 1.85],
          ]
        : [[0, 0]];
      for (const [x, z] of lights) {
        const p = { x: area.x + x, y: ceilingY, z: area.z + z };
        if (layout.ceilingHoles.some((h) => Math.abs(h.y - ceilingY) < 0.01 && contains(h, p, 0.5)))
          continue;
        box('recessed-light-trim', p.x, p.y - 0.025, p.z, 0.85, 0.045, 0.18, '#454941');
        const glow = box('ceiling-light', p.x, p.y - 0.05, p.z, 0.73, 0.015, 0.095, '#fff1cc');
        const emissive = material('#fff1cc');
        emissive.emissiveColor = new Color3(0.95, 0.86, 0.65);
        glow.material = emissive;
      }
    }
    for (const wall of corridorBoundaries(layout)) {
      box(
        'corridor-boundary',
        wall.x,
        wall.y + HEIGHT / 2,
        wall.z,
        wall.w,
        HEIGHT,
        wall.d,
        '#eeece5',
      );
      box(
        'skirting',
        wall.x,
        wall.y + 0.07,
        wall.z,
        wall.w > wall.d ? wall.w + 0.02 : 0.16,
        0.14,
        wall.d > wall.w ? wall.d + 0.02 : 0.16,
        '#d9d5c9',
      );
    }
    for (const wall of layout.walls) {
      const room = roomMap.get(wall.roomId)!,
        horizontal = wall.side === 'north' || wall.side === 'south';
      const piece = (offset: number, width: number, y: number, height: number) =>
        box(
          'wall',
          wall.center.x + (horizontal ? offset : 0),
          wall.center.y + y,
          wall.center.z + (horizontal ? 0 : offset),
          horizontal ? width : 0.12,
          height,
          horizontal ? 0.12 : width,
          room.color,
        );
      if (wall.opening) {
        piece(-2, 2, HEIGHT / 2, HEIGHT);
        piece(2, 2, HEIGHT / 2, HEIGHT);
        if (
          !doc.connections.some(
            (c) =>
              c.kind === 'stairs' &&
              (c.a === room.id || c.b === room.id) &&
              layout.ramps.some((r) => r.id === c.id),
          )
        )
          piece(0, 2, (HEIGHT + 2.7) / 2, HEIGHT - 2.7);
      } else piece(0, 6, HEIGHT / 2, HEIGHT);
      for (const [offset, length] of wall.opening
        ? [
            [-2, 2.02],
            [2, 2.02],
          ]
        : [[0, 6.02]])
        box(
          'skirting',
          wall.center.x + (horizontal ? offset : 0),
          wall.center.y + 0.07,
          wall.center.z + (horizontal ? 0 : offset),
          horizontal ? length : 0.16,
          0.14,
          horizontal ? 0.16 : length,
          '#d9d5c9',
        );
    }
    buildStairs(layout, scene, box, material);
    const textures: TextureSlot[] = [];
    const plaques: { mesh: Mesh; material: StandardMaterial; draw: () => DynamicTexture }[] = [];
    const frameColors: Record<string, string> = {
      none: '#eee9df',
      black: '#292b28',
      white: '#f9f7f0',
      wood: '#785e43',
      gold: '#ad9155',
    };
    for (const region of doc.regions) {
      const asset = doc.assets.find((a) => a.id === region.assetId),
        wall = layout.walls.find((w) => w.id === region.wall);
      if (!asset || !wall) continue;
      const fit = fitExhibit(region, asset.width / asset.height, region.frame ?? doc.defaultFrame),
        frame = region.frame ?? doc.defaultFrame;
      const normal = sideDelta[wall.side],
        tangent =
          wall.side === 'north'
            ? [1, 0]
            : wall.side === 'south'
              ? [-1, 0]
              : wall.side === 'east'
                ? [0, 1]
                : [0, -1];
      const at = (u: number, v: number, depth: number) =>
        new Vector3(
          wall.center.x + tangent[0] * (u - 3) - normal[0] * depth,
          wall.center.y + v,
          wall.center.z + tangent[1] * (u - 3) - normal[1] * depth,
        );
      const cx = region.x + region.w / 2 - (region.plaque === 'right' ? 0.425 : 0),
        cy = region.y + region.h / 2 + (region.plaque === 'below' ? 0.275 : 0);
      const angle =
        wall.side === 'north'
          ? Math.PI
          : wall.side === 'south'
            ? 0
            : wall.side === 'east'
              ? -Math.PI / 2
              : Math.PI / 2;
      const backing = MeshBuilder.CreateBox(
        `frame-${region.id}`,
        { width: fit.w + fit.border * 2, height: fit.h + fit.border * 2, depth: 0.07 },
        scene,
      );
      backing.position = at(cx, cy, 0.09);
      backing.rotation.y = angle;
      backing.material = material(frameColors[frame.preset]);
      backing.isPickable = false;
      if (frame.mat > 0) {
        const mat = MeshBuilder.CreatePlane(
          'mat',
          {
            width: fit.w + frame.mat * 2,
            height: fit.h + frame.mat * 2,
            sideOrientation: Mesh.DOUBLESIDE,
          },
          scene,
        );
        mat.position = at(cx, cy, 0.132);
        mat.rotation.y = angle;
        mat.material = material('#f5f0e3');
        mat.isPickable = false;
      }
      const mesh = MeshBuilder.CreatePlane(
        `art-${region.id}`,
        { width: fit.w, height: fit.h, sideOrientation: Mesh.DOUBLESIDE },
        scene,
      );
      mesh.position = at(cx, cy, 0.14);
      mesh.rotation.y = angle;
      mesh.metadata = { kind: 'art', id: asset.id };
      const mat = new StandardMaterial(`art-material-${region.id}`, scene);
      mat.specularColor = Color3.Black();
      mat.emissiveColor = new Color3(0.17, 0.17, 0.17);
      mat.diffuseColor = Color3.White();
      mesh.material = mat;
      textures.push({
        mesh,
        material: mat,
        assetId: asset.id,
        size: '',
        loaded: false,
        pending: false,
        last: 0,
      });
      if (region.plaque !== 'none') {
        const pw = region.plaque === 'right' ? 0.7 : Math.min(fit.w, 1.2),
          ph = region.plaque === 'right' ? 0.8 : 0.48,
          plaque = MeshBuilder.CreatePlane(
            'explanation',
            { width: pw, height: ph, sideOrientation: Mesh.DOUBLESIDE },
            scene,
          );
        plaque.position =
          region.plaque === 'right'
            ? at(region.x + region.w - 0.45, cy, 0.1)
            : at(cx, region.y + 0.24, 0.1);
        plaque.rotation.y = angle;
        plaque.metadata = { kind: 'art', id: asset.id, narrate: true };
        const pixelWidth = Math.min(1536, Math.round((2048 * pw) / ph)),
          pixelHeight = Math.round((pixelWidth * ph) / pw);
        const draw = () => {
          const texture = new DynamicTexture(
              'plaque',
              { width: pixelWidth, height: pixelHeight },
              scene,
              true,
            ),
            ctx = texture.getContext();
          const actualSize = texture.getSize();
          ctx.scale(actualSize.width / pixelWidth, actualSize.height / pixelHeight);
          texture.anisotropicFilteringLevel = 16;
          const scale = pixelWidth / pw;
          const margin = scale * 0.025,
            lineHeight = scale * 0.047;
          ctx.fillStyle = '#f7f4ed';
          ctx.fillRect(0, 0, pixelWidth, pixelHeight);
          ctx.fillStyle = '#333a31';
          ctx.font = `bold ${scale * 0.043}px Georgia`;
          ctx.fillText(asset.title, margin, margin + scale * 0.043, pixelWidth - margin * 2);
          ctx.font = `${scale * 0.034}px sans-serif`;
          const words = asset.explanation.split(/\s+/);
          let line = '';
          const lines: string[] = [];
          for (const word of words) {
            if (line && ctx.measureText(line + word).width > pixelWidth - margin * 2) {
              lines.push(line);
              line = '';
            }
            line += word + ' ';
          }
          if (line) lines.push(line);
          const firstLine = margin + scale * 0.105;
          const capacity = Math.max(
            1,
            Math.floor((pixelHeight - margin - firstLine) / lineHeight) + 1,
          );
          const overflow = lines.length > capacity;
          const shown = lines.slice(0, overflow ? Math.max(0, capacity - 1) : capacity);
          shown.forEach((text, i) => ctx.fillText(text, margin, firstLine + i * lineHeight));
          if (overflow) {
            ctx.font = `italic ${scale * 0.029}px sans-serif`;
            ctx.fillText(
              'Select to read the full text',
              margin,
              firstLine + (capacity - 1) * lineHeight,
              pixelWidth - margin * 2,
            );
          }
          texture.update();
          return texture;
        };
        const pm = new StandardMaterial('plaque-mat', scene);
        pm.emissiveColor = new Color3(0.35, 0.35, 0.35);
        pm.diffuseColor = Color3.FromHexString('#f7f4ed');
        plaque.material = pm;
        plaques.push({ mesh: plaque, material: pm, draw });
      }
    }
    buildFurnishings(doc, layout, scene, box, material, textures);
    const markers: Mesh[] = [];
    for (const stop of guidedStops(doc, layout)) {
      const marker = MeshBuilder.CreateCylinder(
        'Move here',
        { diameter: stop.stairs ? 0.7 : 0.85, height: 0.015, tessellation: 40 },
        scene,
      );
      marker.position.set(stop.x, stop.y + 0.025, stop.z);
      marker.material = material('#f4f0e8');
      marker.metadata = { kind: 'move', id: stop.roomId, point: stop, label: stop.label };
      const ring = MeshBuilder.CreateTorus(
        'destination outline',
        { diameter: stop.stairs ? 0.62 : 0.76, thickness: 0.035, tessellation: 40 },
        scene,
      );
      ring.parent = marker;
      ring.position.y = 0.015;
      ring.material = material('#585650');
      ring.isPickable = false;
      if (stop.stairs) {
        const texture = new DynamicTexture(
          'stair-direction',
          { width: 256, height: 256 },
          scene,
          false,
        );
        texture.drawText(
          stop.stairs === 'up' ? '↑ UP' : '↓ DOWN',
          null,
          148,
          'bold 48px sans-serif',
          '#343a34',
          '#f4f0e8',
          true,
        );
        const label = MeshBuilder.CreatePlane(
          stop.label,
          { size: 0.5, sideOrientation: Mesh.DOUBLESIDE },
          scene,
        );
        label.parent = marker;
        label.rotation.x = Math.PI / 2;
        label.position.y = 0.02;
        const ink = new StandardMaterial('stair-direction', scene);
        ink.diffuseTexture = texture;
        ink.emissiveColor = new Color3(0.5, 0.5, 0.5);
        label.material = ink;
        label.isPickable = false;
      }
      markers.push(marker);
    }
    const keys = new Set<string>();
    let dragging = false,
      moved = false,
      lastX = 0,
      lastY = 0;
    const keydown = (e: KeyboardEvent) => {
      if (state.current.paused) return;
      if (
        [
          'KeyW',
          'KeyA',
          'KeyS',
          'KeyD',
          'ArrowUp',
          'ArrowDown',
          'ArrowLeft',
          'ArrowRight',
        ].includes(e.code)
      ) {
        keys.add(e.code);
        e.preventDefault();
      }
    };
    const keyup = (e: KeyboardEvent) => keys.delete(e.code);
    const blur = () => keys.clear();
    function startRoom(id: string, destination?: Vec) {
      const r = roomMap.get(id);
      if (!r || state.current.paused || path.length) return;
      const points = routeBetween(layout, currentRoom, id);
      if (currentRoom !== id && !points.length) return;
      const target =
        destination ??
        stops
          .filter((p) => p.roomId === id)
          .sort((a, b) => distance(a, center(r)) - distance(b, center(r)))[0];
      if (!target) return;
      path = avoidOpenings(layout, [{ ...body }, ...points, target]);
      goal = id;
      state.current.onTravel(path.length > 0);
      if (!path.length) setHint('This destination is blocked. Choose another stop or use Rooms.');
    }
    const down = (e: PointerEvent) => {
      if (state.current.paused) return;
      canvas.focus();
      moved = false;
      if (state.current.mode === 'walk') return;
      dragging = true;
      moved = false;
      lastX = e.clientX;
      lastY = e.clientY;
      canvas.setPointerCapture(e.pointerId);
    };
    const move = (e: PointerEvent) => {
      if (state.current.paused) return;
      if (document.pointerLockElement === canvas || (state.current.mode === 'points' && dragging)) {
        const dx = document.pointerLockElement === canvas ? e.movementX : e.clientX - lastX,
          dy = document.pointerLockElement === canvas ? e.movementY : e.clientY - lastY;
        if (Math.abs(dx) + Math.abs(dy) > 2) moved = true;
        camera.rotation.y += dx * 0.003;
        camera.rotation.x = Math.max(-1.25, Math.min(1.25, camera.rotation.x + dy * 0.003));
        lastX = e.clientX;
        lastY = e.clientY;
      }
    };
    const up = (e: PointerEvent) => {
      dragging = false;
      if (state.current.paused || (state.current.mode === 'points' && moved)) return;
      if (state.current.mode === 'walk' && document.pointerLockElement !== canvas) {
        void requestLock();
        return;
      }
      const bounds = canvas.getBoundingClientRect();
      // Babylon accepts CSS pixels and applies hardware scaling internally.
      const pick = scene.pick(
        document.pointerLockElement === canvas ? bounds.width / 2 : e.clientX - bounds.left,
        document.pointerLockElement === canvas ? bounds.height / 2 : e.clientY - bounds.top,
      );
      const meta = pick?.pickedMesh?.metadata;
      if (meta?.kind === 'move') {
        if (path.length) return;
        path = pathToGuidedStop(layout, body, currentRoom, meta.point as GuidedStop);
        goal = meta.point.inCorridor ? currentRoom : meta.id;
        state.current.onTravel(path.length > 0);
      } else if (meta) {
        path = [];
        goal = null;
        state.current.onTravel(false);
        state.current.onAction(meta);
      } else if (state.current.mode === 'points') {
        setHint('Select a filled floor circle to move here, or choose a destination in Rooms.');
        setTimeout(() => setHint(''), 4000);
      }
    };
    const lockChange = () => {
      setLocked(document.pointerLockElement === canvas);
      dragging = false;
      moved = false;
      keys.clear();
    };
    const pointerCancel = () => {
      dragging = false;
      moved = false;
      keys.clear();
    };
    document.addEventListener('pointerlockchange', lockChange);
    canvas.addEventListener('pointercancel', pointerCancel);
    canvas.addEventListener('pointerdown', down);
    canvas.addEventListener('pointermove', move);
    canvas.addEventListener('pointerup', up);
    window.addEventListener('keydown', keydown);
    window.addEventListener('keyup', keyup);
    window.addEventListener('blur', blur);
    const resize = () => engine.resize();
    window.addEventListener('resize', resize);
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    let lastDestination: string | null = null,
      lastMode = state.current.mode,
      lastUpdate = 0,
      frames = 0;
    state.current.onRoom(currentRoom);
    let movementScale = window.matchMedia('(pointer: coarse)').matches ? 1.5 : 1;
    let lastMotion = performance.now(),
      sharp = false;
    let lastPose = [body.x, body.y, body.z, camera.rotation.x, camera.rotation.y];
    engine.setHardwareScalingLevel(movementScale);
    engine.runRenderLoop(() => {
      if (disposed) return;
      const dt = Math.min(engine.getDeltaTime() / 1000, 0.04),
        s = state.current;
      if (s.paused) {
        keys.clear();
        if (document.pointerLockElement === canvas) document.exitPointerLock();
      }
      if (s.mode !== lastMode) {
        path = [];
        goal = null;
        s.onTravel(false);
        keys.clear();
        if (s.mode !== 'walk' && document.pointerLockElement === canvas) document.exitPointerLock();
        lastMode = s.mode;
      }
      if (s.destination !== lastDestination) {
        lastDestination = s.destination;
        if (s.destination) startRoom(s.destination.split('|')[0]);
      }
      if (!s.paused) {
        if (path.length) {
          let remaining = window.matchMedia('(prefers-reduced-motion: reduce)').matches
            ? Infinity
            : dt * 2.6;
          while (path.length && remaining > 0) {
            const target = path[0],
              length = distance(body, target);
            if (length <= remaining) {
              body = { ...target };
              path.shift();
              remaining -= length;
            } else {
              const t = remaining / length;
              body = {
                x: body.x + (target.x - body.x) * t,
                y: body.y + (target.y - body.y) * t,
                z: body.z + (target.z - body.z) * t,
              };
              remaining = 0;
            }
          }
          if (!path.length && goal) {
            currentRoom = goal;
            s.onRoom(currentRoom);
            s.onTravel(false);
            goal = null;
          }
        } else if (s.mode === 'walk' && document.pointerLockElement === canvas) {
          const forward =
              (keys.has('KeyW') || keys.has('ArrowUp') ? 1 : 0) -
              (keys.has('KeyS') || keys.has('ArrowDown') ? 1 : 0),
            right =
              (keys.has('KeyD') || keys.has('ArrowRight') ? 1 : 0) -
              (keys.has('KeyA') || keys.has('ArrowLeft') ? 1 : 0);
          if (forward || right) {
            body = walkStep(layout, body, camera.rotation.y, forward, right, dt);
            const found = doc.rooms.find(
              (r) =>
                Math.abs(r.floor * STOREY - body.y) < 0.3 &&
                Math.abs(r.x * 6 - body.x) < 3 &&
                Math.abs(r.z * 6 - body.z) < 3,
            );
            if (found && found.id !== currentRoom) {
              currentRoom = found.id;
              s.onRoom(currentRoom);
            }
          }
        }
      }
      camera.position.set(body.x, body.y + 1.65, body.z);
      markers.forEach((m) =>
        m.setEnabled(
          s.mode === 'points' &&
            !path.length &&
            Math.abs(m.position.y - body.y) < 0.2 &&
            (!m.metadata.point.rooms || m.metadata.point.rooms.includes(currentRoom)) &&
            distance(body, m.position) > (m.metadata.point.stairs ? 0.25 : 0.8) &&
            distance(body, m.position) < 7.5,
        ),
      );
      const now = performance.now();
      const pose = [body.x, body.y, body.z, camera.rotation.x, camera.rotation.y];
      if (pose.some((v, i) => Math.abs(v - lastPose[i]) > 0.0001)) lastMotion = now;
      lastPose = pose;
      const reading = now - lastMotion > 700;
      if (reading !== sharp) {
        sharp = reading;
        engine.setHardwareScalingLevel(
          sharp ? 1 / Math.min(2, window.devicePixelRatio || 1) : movementScale,
        );
      }
      if (now - lastUpdate > 800) {
        lastUpdate = now;
        // Only nearby labels need high-resolution canvases on the GPU.
        const nearbyPlaques = new Set(
          plaques
            .map((p) => ({ p, d: Vector3.Distance(camera.position, p.mesh.position) }))
            .filter(({ d }) => d < 12)
            .sort((a, b) => a.d - b.d)
            .slice(0, 24)
            .map(({ p }) => p),
        );
        for (const p of plaques) {
          if (nearbyPlaques.has(p)) {
            if (!p.material.diffuseTexture) p.material.diffuseTexture = p.draw();
          } else if (p.material.diffuseTexture) {
            p.material.diffuseTexture.dispose();
            p.material.diffuseTexture = null;
          }
        }
        for (const t of textures) {
          const d = Vector3.Distance(camera.position, t.mesh.position);
          const visible = d < 20 && Math.abs(camera.position.y - t.mesh.position.y) < 7;
          if (!visible) {
            if (t.loaded && now - t.last > 4000) {
              t.material.diffuseTexture?.dispose();
              t.material.diffuseTexture = null;
              t.loaded = false;
              t.size = '';
            }
            continue;
          }
          t.last = now;
          // Select resolution from projected image size; wide merged cells naturally request larger variants.
          const worldWidth = t.mesh.getBoundingInfo().boundingBox.extendSize.x * 2;
          const projected = (worldWidth / Math.max(d, 1)) * engine.getRenderWidth();
          const size = projected > 900 ? '2048' : projected > 400 ? '1024' : '512';
          if (t.pending || t.size === size) continue;
          t.pending = true;
          const a = doc.assets.find((a) => a.id === t.assetId)!;
          assetUrl(a, size)
            .then((url) => {
              if (disposed) return;
              const texture = new Texture(
                url,
                scene,
                false,
                true,
                Texture.TRILINEAR_SAMPLINGMODE,
                () => {
                  if (disposed) {
                    texture.dispose();
                    return;
                  }
                  t.material.diffuseTexture?.dispose();
                  t.material.diffuseTexture = texture;
                  t.size = size;
                  t.loaded = true;
                  t.pending = false;
                },
                () => {
                  t.pending = false;
                },
              );
            })
            .catch(() => {
              t.pending = false;
            });
        }
      }
      if (++frames % 240 === 0 && !sharp && engine.getFps() < 28 && movementScale < 2.5) {
        movementScale += 0.25;
        engine.setHardwareScalingLevel(movementScale);
      }
      scene.render();
    });
    return () => {
      disposed = true;
      keys.clear();
      document.removeEventListener('pointerlockchange', lockChange);
      canvas.removeEventListener('pointercancel', pointerCancel);
      if (document.pointerLockElement === canvas) document.exitPointerLock();
      canvas.removeEventListener('pointerdown', down);
      canvas.removeEventListener('pointermove', move);
      canvas.removeEventListener('pointerup', up);
      window.removeEventListener('keydown', keydown);
      window.removeEventListener('keyup', keyup);
      window.removeEventListener('blur', blur);
      window.removeEventListener('resize', resize);
      observer.disconnect();
      scene.dispose();
      engine.dispose();
    };
  }, [doc]);
  return (
    <>
      <canvas
        ref={canvasRef}
        className="museum-canvas"
        tabIndex={0}
        aria-label="Interactive 3D museum. Use the room navigation or switch to walking controls."
      />
      {hint && (
        <div className="scene-hint" role="status">
          {hint}
        </div>
      )}
      {mode === 'walk' && !paused && !locked && (
        <button className="walk-start" onClick={() => void requestLock()}>
          Start walking · WASD + mouse
        </button>
      )}
      {mode === 'walk' && !paused && locked && (
        <span className="walk-crosshair" aria-hidden="true">
          +
        </span>
      )}
    </>
  );
}
