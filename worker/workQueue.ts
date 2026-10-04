import { HttpError } from './http';
/** Bound buffer-heavy work within each isolate while allowing normal bursts to wait. */
export function workQueue(limit: number) {
  let active = 0;
  const waiting: { resolve: () => void; timer: ReturnType<typeof setTimeout> }[] = [];
  return async () => {
    if (active >= limit) {
      if (waiting.length >= 32) throw new HttpError(429, 'The museum is busy. Retry shortly.');
      await new Promise<void>((resolve, reject) => {
        const item = {
          resolve,
          timer: setTimeout(() => {
            const index = waiting.indexOf(item);
            if (index >= 0) waiting.splice(index, 1);
            reject(new HttpError(429, 'The museum is busy. Retry shortly.'));
          }, 60_000),
        };
        waiting.push(item);
      });
    } else active++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = waiting.shift();
      if (next) {
        clearTimeout(next.timer);
        next.resolve();
      } else active--;
    };
  };
}
