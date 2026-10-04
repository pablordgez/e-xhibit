import type { Env } from './index';
import { HttpError } from './http';

export const RESOURCE_TTL = 60 * 60 * 1000;
const KEY = 'control/resources.json';
type Reservation = { bytes: number; user: string; expires: number; complete?: boolean };
export type Resources = {
  bytes: number;
  assets: number;
  publications: number;
  uploads: Record<string, Reservation>;
  jobs: Record<string, Reservation>;
};

async function seed(env: Env): Promise<Resources> {
  let bytes = 0,
    assets = 0,
    publications = 0;
  for (const bucket of [env.MUSEUM, ...(env.DISPLAY ? [env.DISPLAY] : [])]) {
    let cursor: string | undefined;
    for (let page = 0; ; page++) {
      // Fail closed rather than initialize an incomplete budget on a very large legacy bucket.
      if (page === 16)
        throw new HttpError(
          503,
          'Legacy storage needs an inventory before uploads or publications can resume.',
        );
      const list = await bucket.list({ cursor, limit: 1000 });
      for (const object of list.objects) {
        bytes += object.size;
        if (bucket === env.MUSEUM && object.key.startsWith('originals/')) assets++;
        if (bucket === env.MUSEUM && object.key.startsWith('manifests/')) publications++;
      }
      if (!list.truncated) break;
      cursor = list.cursor;
    }
  }
  return { bytes, assets, publications, uploads: {}, jobs: {} };
}

/** One strongly consistent R2 CAS ledger bounds both concurrent and lifetime allocations. */
export async function resources<T>(env: Env, change: (state: Resources) => T): Promise<T> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const stored = await env.MUSEUM.get(KEY);
    const state = stored ? await stored.json<Resources>() : await seed(env);
    const result = change(state);
    const written = await env.MUSEUM.put(KEY, JSON.stringify(state), {
      onlyIf: stored ? { etagMatches: stored.etag } : { etagDoesNotMatch: '*' },
      httpMetadata: { contentType: 'application/json', cacheControl: 'no-store' },
    });
    if (written) return result;
  }
  throw new HttpError(409, 'Storage is busy. Retry in a moment.');
}

export async function reserve(
  env: Env,
  kind: 'uploads' | 'jobs',
  id: string,
  user: string,
  bytes: number,
) {
  return resources(env, (state) => {
    if (state[kind][id])
      throw new HttpError(
        409,
        'This resource already has a reservation. Finish it or wait for cleanup.',
      );
    const active = Object.values(state[kind]).filter((item) => !item.complete);
    if (
      active.length >= (kind === 'uploads' ? 16 : 3) ||
      active.filter((r) => r.user === user).length >= (kind === 'uploads' ? 4 : 2)
    )
      throw new HttpError(
        429,
        'Too many unfinished uploads or publications. Wait for cleanup or finish the existing work.',
      );
    if (
      (kind === 'uploads' && state.assets >= 2000) ||
      (kind === 'jobs' && state.publications >= 1000)
    )
      throw new HttpError(
        409,
        'The museum retention limit has been reached. Archive storage before adding more.',
      );
    const limit = Number(env.MAX_STORAGE_BYTES ?? 20 * 1024 ** 3);
    if (!Number.isSafeInteger(limit) || limit < 1)
      throw new HttpError(503, 'Invalid storage budget configuration.');
    if (state.bytes + bytes > limit)
      throw new HttpError(413, 'The museum storage budget has been reached.');
    state.bytes += bytes;
    if (kind === 'uploads') state.assets++;
    else state.publications++;
    const reservation = { bytes, user, expires: Date.now() + RESOURCE_TTL };
    state[kind][id] = reservation;
    return reservation;
  });
}

export async function completeUpload(env: Env, id: string, actual: number) {
  await resources(env, (state) => {
    const item = state.uploads[id];
    if (!item) throw new HttpError(410, 'Upload expired.');
    if (actual > item.bytes) throw new HttpError(503, 'Image storage exceeded its reservation.');
    state.bytes -= item.bytes - actual;
    item.bytes = actual;
    item.complete = true;
  });
}

export async function reservation(env: Env, kind: 'uploads' | 'jobs', id: string) {
  const stored = await env.MUSEUM.get(KEY);
  const item = stored ? (await stored.json<Resources>())[kind][id] : undefined;
  if (!item || item.expires <= Date.now())
    throw new HttpError(410, 'This upload or publication expired. Start again.');
  return item;
}

export async function settle(env: Env, kind: 'uploads' | 'jobs', id: string, actual?: number) {
  await resources(env, (state) => {
    const item = state[kind][id];
    if (!item) return;
    // Without actual bytes, release everything after cleanup has deleted the objects.
    state.bytes -= item.bytes - (actual ?? 0);
    if (actual === undefined) {
      if (kind === 'uploads') state.assets--;
      else state.publications--;
    }
    delete state[kind][id];
  });
}
