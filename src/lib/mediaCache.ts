type Reply = { urls: { key: string; url: string }[]; expiresIn: number };
type Entry = {
  promise: Promise<string>;
  resolve: (url: string) => void;
  reject: (error: unknown) => void;
  expires: number;
};

/** Deduplicate private reads and keep signed URLs below their five-minute lifetime. */
export function mediaCache(load: (keys: string[]) => Promise<Reply>) {
  const entries = new Map<string, Entry>();
  const waiting: { key: string; entry: Entry }[] = [];
  let running = false;
  async function drain() {
    while (waiting.length) {
      const batch = waiting.splice(0, 50),
        started = Date.now();
      try {
        const reply = await load(batch.map(({ key }) => key));
        const urls = new Map(reply.urls.map(({ key, url }) => [key, url]));
        for (const { key, entry } of batch) {
          const url = urls.get(key);
          if (!url) {
            if (entries.get(key) === entry) entries.delete(key);
            entry.reject(Error('Image unavailable.'));
            continue;
          }
          entry.expires = started + Math.max(0, Math.min(240, reply.expiresIn)) * 1000;
          entry.resolve(url);
        }
      } catch (error) {
        for (const { key, entry } of batch) {
          if (entries.get(key) === entry) entries.delete(key);
          entry.reject(error);
        }
      }
    }
    running = false;
  }
  return {
    get(key: string) {
      const previous = entries.get(key);
      if (previous && previous.expires > Date.now()) return previous.promise;
      // One document has at most 500 originals and 1,500 display keys.
      if (entries.size >= 2048) {
        for (const [oldKey, entry] of entries) {
          if (entry.expires !== Infinity) {
            entries.delete(oldKey);
            break;
          }
        }
        if (entries.size >= 2048) return Promise.reject(Error('Too many pending image requests.'));
      }
      let resolve!: Entry['resolve'], reject!: Entry['reject'];
      const promise = new Promise<string>((done, fail) => {
        resolve = done;
        reject = fail;
      });
      const entry = { promise, resolve, reject, expires: Infinity };
      entries.set(key, entry);
      waiting.push({ key, entry });
      if (!running) {
        running = true;
        setTimeout(() => void drain(), 25);
      }
      return promise;
    },
    invalidate(key: string) {
      entries.delete(key);
    },
    clear() {
      entries.clear();
    },
  };
}
