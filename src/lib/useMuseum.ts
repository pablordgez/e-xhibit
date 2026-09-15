import { useCallback, useEffect, useRef, useState } from 'react';
import { type MuseumDocument } from '../core/model';
import { getDraft, saveDraft, publish, rollback, type Snapshot } from './storage';
export function useMuseum() {
  const [state, setState] = useState<{
      doc: MuseumDocument;
      past: MuseumDocument[];
      future: MuseumDocument[];
    } | null>(null),
    [status, setStatus] = useState('Loading draft…'),
    [error, setError] = useState(''),
    [publication, setPublication] = useState<string | null>(null);
  const snapshot = useRef<Snapshot | null>(null),
    queue = useRef<Promise<unknown>>(Promise.resolve()),
    blocked = useRef(false),
    docRef = useRef<MuseumDocument | null>(null);
  const load = useCallback(async () => {
    try {
      const next = await getDraft();
      snapshot.current = next;
      docRef.current = next.document;
      blocked.current = false;
      setState({ doc: next.document, past: [], future: [] });
      setPublication(next.publication);
      setError('');
      setStatus('All changes saved');
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  const change = useCallback((update: MuseumDocument | ((d: MuseumDocument) => MuseumDocument)) => {
    setState((current) => {
      if (!current) return current;
      const next = typeof update === 'function' ? update(current.doc) : update;
      docRef.current = next;
      return { doc: next, past: [...current.past.slice(-49), current.doc], future: [] };
    });
  }, []);
  const undo = () =>
    setState((s) => {
      if (!s?.past.length) return s;
      const doc = s.past.at(-1)!;
      docRef.current = doc;
      return { doc, past: s.past.slice(0, -1), future: [s.doc, ...s.future] };
    });
  const redo = () =>
    setState((s) => {
      if (!s?.future.length) return s;
      const doc = s.future[0];
      docRef.current = doc;
      return { doc, past: [...s.past, s.doc], future: s.future.slice(1) };
    });
  const flush = useCallback(async () => {
    const run = async () => {
      if (blocked.current)
        throw Error('Draft conflict: export your work, then reload the saved draft.');
      const doc = docRef.current,
        current = snapshot.current;
      if (!doc || !current) throw Error('Draft is not ready.');
      if (JSON.stringify(doc) === JSON.stringify(current.document)) {
        setStatus('All changes saved');
        return current;
      }
      setStatus('Saving draft…');
      try {
        const next = await saveDraft(doc, current.revision);
        snapshot.current = next;
        setStatus('All changes saved');
        setError('');
        return next;
      } catch (e) {
        blocked.current = (e as { status?: number }).status === 409;
        setStatus('Not saved');
        setError((e as Error).message);
        throw e;
      }
    };
    const promise = queue.current.then(run, run);
    queue.current = promise.catch(() => {});
    return promise;
  }, []);
  useEffect(() => {
    if (!state) return;
    setStatus('Unsaved changes');
    const timer = setTimeout(() => void flush().catch(() => {}), 800);
    return () => clearTimeout(timer);
  }, [state?.doc, flush]);
  useEffect(() => {
    const unload = (event: BeforeUnloadEvent) => {
      if (
        docRef.current &&
        JSON.stringify(docRef.current) !== JSON.stringify(snapshot.current?.document)
      ) {
        event.preventDefault();
        event.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', unload);
    return () => window.removeEventListener('beforeunload', unload);
  }, []);
  return {
    doc: state?.doc,
    change,
    undo,
    redo,
    canUndo: Boolean(state?.past.length),
    canRedo: Boolean(state?.future.length),
    status,
    error,
    setError,
    publication,
    reload: load,
    flush,
    publish: async () => {
      const saved = await flush();
      const result = await publish(saved.document, saved.revision, publication);
      setPublication(result.id);
      setStatus('Museum published');
      return result.id;
    },
    rollback: async (id: string) => {
      await rollback(id, publication);
      setPublication(id);
    },
  };
}
