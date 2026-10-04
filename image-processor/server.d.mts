import type { Server } from 'node:http';
export function createProcessor(options: {
  token: string | undefined;
  maxBytes?: number;
  maxPixels?: number;
  concurrency?: number;
}): Server;
