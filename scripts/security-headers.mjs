import { readFile, writeFile } from 'node:fs/promises';
import { loadEnv } from 'vite';
let headers = await readFile('public/_headers', 'utf8');
const configured = loadEnv('production', process.cwd(), 'VITE_').VITE_SUPABASE_URL;
if (configured) {
  let url;
  try {
    url = new URL(configured);
  } catch {
    throw Error('VITE_SUPABASE_URL must be a valid public origin.');
  }
  if (url.username || url.password || !['https:', 'http:'].includes(url.protocol))
    throw Error('Invalid public authentication origin.');
  const socket = new URL(url.origin);
  socket.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  headers = headers.replace(
    'https://*.supabase.co wss://*.supabase.co',
    `${url.origin} ${socket.origin}`,
  );
}
await writeFile('dist/_headers', headers);
