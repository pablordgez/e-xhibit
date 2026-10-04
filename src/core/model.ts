import { z } from 'zod';

export const MODULE = 6;
export const STOREY = 4;
export const HEIGHT = 3.8;
export const SIDES = ['north', 'east', 'south', 'west'] as const;
export type Side = (typeof SIDES)[number];
const id = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[\w-]+$/);
export const frameSchema = z.object({
  preset: z.enum(['none', 'black', 'white', 'wood', 'gold']),
  width: z.number().min(0.01).max(0.2),
  mat: z.number().min(0).max(0.25),
});
export type Frame = z.infer<typeof frameSchema>;
export const roomSchema = z.object({
  id,
  name: z.string().max(100),
  x: z.number().int().min(-20).max(20),
  z: z.number().int().min(-20).max(20),
  floor: z.number().int().min(0).max(4),
  rotation: z.number().int().min(0).max(3),
  kind: z.enum(['gallery', 'information', 'shop']),
  color: z.string().regex(/^#[0-9a-f]{6}$/i),
  finish: z.enum(['wood', 'stone']),
  pages: z.array(z.string().max(5000)).max(50),
  shelves: z.array(id).max(12),
});
export type Room = z.infer<typeof roomSchema>;
const point = z.object({
  x: z.number().int().min(-120).max(120),
  z: z.number().int().min(-120).max(120),
});
export const connectionSchema = z.object({
  id,
  a: id,
  b: id,
  kind: z.enum(['door', 'merged', 'closed', 'corridor', 'stairs', 'spiral']),
  route: z.array(point).max(60).default([]),
});
export type Connection = z.infer<typeof connectionSchema>;
export const assetSchema = z.object({
  id,
  title: z.string().min(1).max(160),
  explanation: z.string().max(10000),
  attribution: z.string().max(500),
  width: z.number().int().positive().max(40000),
  height: z.number().int().positive().max(40000),
  bytes: z.number().int().min(0).max(500_000_000),
  mime: z.enum(['image/jpeg', 'image/png', 'image/webp']),
  source: z.string().max(500),
  variants: z.record(z.string().max(500)),
  downloadable: z.boolean(),
  ready: z.boolean(),
  categoryIds: z.array(id).max(100).optional(),
});
export type Asset = z.infer<typeof assetSchema>;
export const categorySchema = z.object({ id, name: z.string().trim().min(1).max(80) });
export type Category = z.infer<typeof categorySchema>;
export const regionSchema = z.object({
  id,
  wall: z.string().max(150),
  x: z.number().min(0).max(6),
  y: z.number().min(0).max(3.8),
  w: z.number().positive().max(6),
  h: z.number().positive().max(3.8),
  assetId: id.optional(),
  frame: frameSchema.optional(),
  plaque: z.enum(['none', 'right', 'below']),
  plaqueAuto: z.boolean().optional(),
});
export type Region = z.infer<typeof regionSchema>;
export const museumSchema = z.object({
  schemaVersion: z.literal(1),
  name: z.string().min(1).max(120),
  subtitle: z.string().max(300),
  language: z.string().min(2).max(30),
  audioguide: z.boolean(),
  defaultFrame: frameSchema,
  entrance: id,
  rooms: z.array(roomSchema).min(1).max(50),
  connections: z.array(connectionSchema).max(200),
  assets: z.array(assetSchema).max(500),
  categories: z.array(categorySchema).max(100).optional(),
  regions: z.array(regionSchema).max(3000),
  unplaced: z.array(regionSchema).max(3000),
});
export type MuseumDocument = z.infer<typeof museumSchema>;
export type Vec = { x: number; y: number; z: number };
export type Issue = { code: string; message: string; target: string };
export type Wall = {
  id: string;
  roomId: string;
  side: Side;
  floor: number;
  center: Vec;
  length: number;
  opening: boolean;
};
export type WalkArea = {
  x: number;
  z: number;
  w: number;
  d: number;
  y: number;
  roomId?: string;
  shape?: 'circle';
};
export type Structure = WalkArea & { h: number; color: string; name: string };
export type Ramp = { id: string; points: Vec[]; width: number; kind: 'stairs' | 'spiral' };
export type Furnishing = WalkArea & {
  roomId: string;
  kind: 'stand' | 'shelf' | 'table' | 'plant';
  rotation: number;
  mounted?: boolean;
  wall?: string;
};
export type Layout = {
  walls: Wall[];
  areas: WalkArea[];
  holes: WalkArea[];
  ceilingHoles: WalkArea[];
  structures: Structure[];
  stairClearances: WalkArea[];
  ramps: Ramp[];
  furnishings: Furnishing[];
  edges: Map<string, { to: string; points: Vec[] }[]>;
  issues: Issue[];
};
export const uid = () => crypto.randomUUID();
export const center = (r: Room): Vec => ({ x: r.x * MODULE, y: r.floor * STOREY, z: r.z * MODULE });
export const defaultRoom = (x: number, z: number, floor = 0): Room => ({
  id: uid(),
  name: 'Untitled room',
  x,
  z,
  floor,
  rotation: 0,
  kind: 'gallery',
  color: '#eeece5',
  finish: 'wood',
  pages: ['# Welcome\n\nA place for looking a little closer.'],
  shelves: [],
});
export const wallId = (room: string, side: Side) => `${room}:${side}`;
export const sideDelta: Record<Side, [number, number]> = {
  north: [0, -1],
  east: [1, 0],
  south: [0, 1],
  west: [-1, 0],
};
export const physicalSide = (room: Room, side: Side): Side =>
  SIDES[(SIDES.indexOf(side) + room.rotation) % 4];
export const localSide = (room: Room, side: Side): Side =>
  SIDES[(SIDES.indexOf(side) - room.rotation + 4) % 4];
export function facing(a: Room, b: Room): Side {
  const dx = b.x - a.x,
    dz = b.z - a.z;
  return Math.abs(dx) > Math.abs(dz) ? (dx > 0 ? 'east' : 'west') : dz > 0 ? 'south' : 'north';
}
export function distance(a: Vec, b: Vec) {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}
