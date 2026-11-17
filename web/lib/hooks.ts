import { useCallback, useEffect, useRef, useState } from 'react';
import { useAppEvent, useApp } from '@web/state/AppContext';

/** Re-run a loader after matching server events, coalescing bursts. */
export function useRefetchOnEvents(loader: () => void, events: string[], delay = 700): void {
  const ref = useRef(loader);
  ref.current = loader;
  const timer = useRef<number | null>(null);
  const types = events.join('|');
  useAppEvent(() => {
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      ref.current();
    }, delay);
  }, types.split('|'));
  useEffect(
    () => () => {
      if (timer.current) window.clearTimeout(timer.current);
    },
    [],
  );
}

export function useAsyncData<T>(
  loader: () => Promise<T>,
  options: { events?: string[]; deps?: unknown[]; delay?: number } = {},
) {
  const { notify } = useApp();
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const loaderRef = useRef(loader);
  loaderRef.current = loader;
  const alive = useRef(true);

  useEffect(
    () => () => {
      alive.current = false;
    },
    [],
  );

  const reload = useCallback(
    async (silent = true) => {
      if (!silent) setLoading(true);
      try {
        const next = await loaderRef.current();
        if (!alive.current) return;
        setData(next);
        setError(null);
      } catch (cause) {
        if (!alive.current) return;
        const message = (cause as Error).message || 'Could not load this view.';
        setError(message);
        if (!silent) notify({ tone: 'error', title: 'Could not load the page', message });
      } finally {
        if (alive.current) setLoading(false);
      }
    },
    [notify],
  );

  useEffect(() => {
    alive.current = true;
    void reload(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, options.deps ?? []);

  useRefetchOnEvents(() => void reload(true), options.events ?? [], options.delay ?? 700);

  return { data, loading, error, reload };
}

export function useDebouncedCallback<T extends (...args: never[]) => void>(callback: T, delay = 400): T {
  const ref = useRef(callback);
  ref.current = callback;
  const timer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (timer.current) window.clearTimeout(timer.current);
    },
    [],
  );
  return useCallback(
    ((...args: never[]) => {
      if (timer.current) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => ref.current(...args), delay);
    }) as T,
    [delay],
  );
}
