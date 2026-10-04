import { createClient } from '@supabase/supabase-js';
import { museumSchema, type MuseumDocument, type Asset } from '../core/model';
import { sample } from '../core/sample';
import { publicDocument } from '../core/publication';
import { validateMuseumImport } from '../core/documentImport';
export const cloudConfigured = Boolean(
  import.meta.env.VITE_SUPABASE_URL && import.meta.env.VITE_SUPABASE_ANON_KEY,
);
export const demo = import.meta.env.DEV && !cloudConfigured;
export const invitationFlow = /type=(invite|recovery)/.test(
  typeof location === 'undefined' ? '' : location.hash,
);
export const supabase = cloudConfigured
  ? createClient(import.meta.env.VITE_SUPABASE_URL, import.meta.env.VITE_SUPABASE_ANON_KEY)
  : null;
export type Snapshot = { document: MuseumDocument; revision: number; publication: string | null };
let limitRequest: Promise<{ bytes: number; pixels: number }> | undefined;
export function imageUploadLimits() {
  if (demo) return Promise.resolve({ bytes: 100_000_000, pixels: 100_000_000 });
  return (limitRequest ??= api('/limits').catch((error) => {
    limitRequest = undefined;
    throw error;
  }));
}
const migrations = new Map<string, Promise<void>>();
async function prepareExistingImages(document: MuseumDocument) {
  const assets = document.assets.filter((asset) => /^originals\/[\w-]+$/.test(asset.source));
  for (let offset = 0; offset < assets.length; offset += 50) {
    const group = assets.slice(offset, offset + 50);
    const statuses = await api<{ id: string; validated: boolean }[]>(
      '/asset-status?ids=' + group.map((asset) => asset.id).join(','),
    );
    for (const asset of group) {
      if (statuses.find((status) => status.id === asset.id)?.validated) continue;
      let pending = migrations.get(asset.id);
      if (!pending) {
        pending = (async () => {
          try {
            await api('/uploads/revalidate', {
              method: 'POST',
              body: JSON.stringify({ id: asset.id }),
            });
          } catch (error) {
            throw Error(
              `Existing artwork “${asset.title}” could not be prepared: ${(error as Error).message}`,
            );
          }
          // Leave room in the member request budget during a large one-time migration.
          await new Promise((resolve) => setTimeout(resolve, 1100));
        })();
        migrations.set(asset.id, pending);
        void pending.catch(() => migrations.delete(asset.id));
      }
      await pending;
    }
  }
}
const key = 'exhibit-draft-v1';
export async function api<T = any>(path: string, init: RequestInit = {}): Promise<T> {
  const token = (await supabase?.auth.getSession())?.data.session?.access_token;
  const response = await fetch(`/api${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...init.headers,
    },
  });
  if (!response.ok) {
    const data = (await response.json().catch(() => ({ error: response.statusText }))) as {
      error?: string;
    };
    throw Object.assign(Error(data.error ?? 'Request failed'), { status: response.status });
  }
  return (response.status === 204 ? null : await response.json()) as T;
}
export async function getDraft(): Promise<Snapshot> {
  if (!demo) return api('/draft');
  const raw = localStorage.getItem(key);
  if (raw) {
    const result = JSON.parse(raw);
    museumSchema.parse(result.document);
    return result;
  }
  return {
    document: structuredClone(sample),
    revision: 0,
    publication: localStorage.getItem('exhibit-current'),
  };
}
export async function saveDraft(document: MuseumDocument, revision: number): Promise<Snapshot> {
  museumSchema.parse(document);
  if (!demo) {
    await prepareExistingImages(document);
    return api('/draft', { method: 'PUT', body: JSON.stringify({ document, revision }) });
  }
  const current = await getDraft();
  if (current.revision !== revision)
    throw Object.assign(
      Error('Another editor saved changes. Export your work before reloading the server draft.'),
      { status: 409 },
    );
  const result = {
    document,
    revision: revision + 1,
    publication: localStorage.getItem('exhibit-current'),
  };
  localStorage.setItem(key, JSON.stringify(result));
  return result;
}
export async function importDraft(value: MuseumDocument, revision: number): Promise<Snapshot> {
  const document = validateMuseumImport(value);
  const uploaded = document.assets.filter((asset) => !asset.source.startsWith('/art/'));
  if (demo && uploaded.length) {
    const database = await db();
    const store = database.transaction('blobs', 'readonly').objectStore('blobs');
    await Promise.all(
      uploaded.flatMap((asset) =>
        [asset.source, ...Object.values(asset.variants)].map(
          (key) =>
            new Promise<void>((resolve, reject) => {
              const request = store.get(key);
              request.onsuccess = () =>
                request.result instanceof Blob
                  ? resolve()
                  : reject(
                      Error(
                        `Artwork “${asset.title}” is missing from this browser. Import into the browser containing its image files. Your current draft has not been replaced.`,
                      ),
                    );
              request.onerror = () => reject(request.error);
            }),
        ),
      ),
    );
  }
  if (!demo) {
    await prepareExistingImages(document);
    for (let start = 0; start < uploaded.length; start += 10) {
      const group = uploaded.slice(start, start + 10);
      const statuses = await api<{ id: string; validated: boolean; filesAvailable: boolean }[]>(
        '/asset-status?check-files=1&ids=' + group.map((asset) => asset.id).join(','),
      );
      const missing = group.find(
        (asset) =>
          !statuses.some(
            (status) => status.id === asset.id && status.validated && status.filesAvailable,
          ),
      );
      if (missing)
        throw Error(
          `Artwork “${missing.title}” is unavailable in this installation. Restore its image files and asset records from your backups before importing. Your current draft has not been replaced.`,
        );
    }
    return api('/draft', { method: 'PUT', body: JSON.stringify({ document, revision }) });
  }
  return saveDraft(document, revision);
}
export async function publish(document: MuseumDocument, revision: number, previous: string | null) {
  if (!demo) {
    // An unchanged saved legacy draft can publish without passing through saveDraft.
    await prepareExistingImages(document);
    let progress = await api<{ id: string; done: boolean; cursor: number }>('/publish', {
      method: 'POST',
      body: JSON.stringify({ revision, previous }),
    });
    while (!progress.done)
      progress = await api('/publish/' + progress.id + '/step', {
        method: 'POST',
        body: JSON.stringify({ cursor: progress.cursor }),
      });
    return { id: progress.id };
  }
  if (localStorage.getItem('exhibit-current') !== previous)
    throw Error('Publication changed. Reload before publishing again.');
  const id = crypto.randomUUID();
  localStorage.setItem(`exhibit-version-${id}`, JSON.stringify(publicDocument(document)));
  localStorage.setItem('exhibit-current', id);
  return { id };
}
export async function getPublished(): Promise<{ document: MuseumDocument; id: string }> {
  if (demo) {
    const id = localStorage.getItem('exhibit-current');
    return {
      id: id ?? 'sample',
      document: id
        ? museumSchema.parse(JSON.parse(localStorage.getItem(`exhibit-version-${id}`)!))
        : structuredClone(sample),
    };
  }
  return api('/current');
}
export async function versions(
  offset = 0,
): Promise<{ id: string; name: string; createdAt: string }[]> {
  if (!demo) return api(`/versions?offset=${offset}`);
  return Object.keys(localStorage)
    .filter((k) => k.startsWith('exhibit-version-'))
    .map((k) => ({
      id: k.slice(16),
      name: JSON.parse(localStorage.getItem(k)!).name,
      createdAt: '',
    }));
}
export async function rollback(id: string, previous: string | null) {
  if (!demo) return api('/rollback', { method: 'POST', body: JSON.stringify({ id, previous }) });
  if (localStorage.getItem('exhibit-current') !== previous) throw Error('Publication changed.');
  localStorage.setItem('exhibit-current', id);
  return { id };
}
let dbPromise: Promise<IDBDatabase> | undefined;
function db() {
  return (dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open('exhibit-assets', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('blobs');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
}
export async function putBlob(key: string, value: Blob) {
  const database = await db();
  await new Promise<void>((resolve, reject) => {
    const tx = database.transaction('blobs', 'readwrite');
    tx.objectStore('blobs').put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
const blobUrls = new Map<string, string>();
export async function assetUrl(asset: Asset, size = '1024'): Promise<string> {
  const key = size === 'original' ? asset.source : (asset.variants[size] ?? asset.variants['1024']);
  if (key.startsWith('/art/')) return key;
  if (demo) {
    if (blobUrls.has(key)) return blobUrls.get(key)!;
    const database = await db();
    const blob = await new Promise<Blob | undefined>((resolve, reject) => {
      const req = database.transaction('blobs').objectStore('blobs').get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    if (!blob) throw Error('Local image missing. Re-upload it in the editor.');
    const url = URL.createObjectURL(blob);
    blobUrls.set(key, url);
    return url;
  }
  if (key.startsWith('published/')) return `/api/media/${encodeURIComponent(key)}`;
  return (await api<{ url: string }>(`/media-url?key=${encodeURIComponent(key)}`)).url;
}
export function exportDocument(document: MuseumDocument) {
  const blob = new Blob([JSON.stringify(document, null, 2)], { type: 'application/json' }),
    url = URL.createObjectURL(blob),
    a = window.document.createElement('a');
  a.href = url;
  a.download = 'museum-backup.json';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
