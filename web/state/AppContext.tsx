import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { AppSettings, SystemStatus, ToastEvent } from '@shared/types';
import { api, type Bootstrap } from '@web/lib/api';
import { ConfirmDialog } from '@web/components/ui';

export interface AppEvent {
  type: string;
  data: unknown;
  at: number;
}

export interface ConfirmOptions {
  title: string;
  body?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: 'danger' | 'default';
}

interface Toast extends ToastEvent {
  leaving?: boolean;
}

interface AppContextValue {
  bootstrap: Bootstrap | null;
  settings: AppSettings | null;
  system: SystemStatus | null;
  loading: boolean;
  error: string | null;
  connected: boolean;
  toasts: Toast[];
  notify: (toast: Omit<ToastEvent, 'id'> & { id?: string }) => void;
  dismissToast: (id: string) => void;
  refresh: () => Promise<void>;
  refreshSystem: () => Promise<void>;
  saveSettings: (patch: Record<string, unknown>) => Promise<AppSettings>;
  confirm: (options: ConfirmOptions) => Promise<boolean>;
}

const AppContext = createContext<AppContextValue | null>(null);

/**
 * Server events are delivered through a tiny emitter instead of context state.
 * Putting the latest event in React state re-rendered every `useApp()` consumer
 * — the whole shell, page and its charts — once per recording tick. Only the
 * loaders that ask for a given event type should wake up.
 */
type EventListener = (event: AppEvent) => void;
const eventListeners = new Set<EventListener>();

function emitEvent(event: AppEvent): void {
  for (const listener of [...eventListeners]) {
    try {
      listener(event);
    } catch {
      /* one failing listener must not starve the others */
    }
  }
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [bootstrap, setBootstrap] = useState<Bootstrap | null>(null);
  const [system, setSystem] = useState<SystemStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [confirmState, setConfirmState] = useState<(ConfirmOptions & { resolve: (value: boolean) => void }) | null>(null);
  const timers = useRef(new Map<string, number>());
  const seenToasts = useRef(new Set<string>());
  const systemTimer = useRef<number | null>(null);
  const booted = useRef(false);

  const dismissToast = useCallback((id: string) => {
    setToasts((current) => current.map((toast) => (toast.id === id ? { ...toast, leaving: true } : toast)));
    const existing = timers.current.get(`remove-${id}`);
    if (existing) window.clearTimeout(existing);
    timers.current.set(
      `remove-${id}`,
      window.setTimeout(() => {
        setToasts((current) => current.filter((toast) => toast.id !== id));
        timers.current.delete(`remove-${id}`);
      }, 260),
    );
  }, []);

  const notify = useCallback(
    (input: Omit<ToastEvent, 'id'> & { id?: string }) => {
      const id = input.id || `toast_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      if (seenToasts.current.has(id)) return;
      seenToasts.current.add(id);
      if (seenToasts.current.size > 60) {
        seenToasts.current = new Set([...seenToasts.current].slice(-30));
      }
      setToasts((current) => [...current.slice(-3), { ...input, id }]);
      const timer = timers.current.get(id);
      if (timer) window.clearTimeout(timer);
      timers.current.set(
        id,
        window.setTimeout(() => {
          dismissToast(id);
          timers.current.delete(id);
        }, 5200),
      );
    },
    [dismissToast],
  );

  const refresh = useCallback(async () => {
    try {
      const data = await api.bootstrap();
      setBootstrap(data);
      setError(null);
    } catch (cause) {
      setError((cause as Error).message || 'Could not reach the local server.');
    } finally {
      setLoading(false);
    }
  }, []);

  const refreshSystem = useCallback(async () => {
    try {
      setSystem(await api.system());
    } catch {
      /* keep the previous system snapshot */
    }
  }, []);

  useEffect(() => {
    // StrictMode mounts effects twice in dev; the bootstrap/system probes spawn
    // ffmpeg, ffprobe and yt-dlp on the server, so only run them once.
    if (booted.current) return;
    booted.current = true;
    void refresh();
    void refreshSystem();
  }, [refresh, refreshSystem]);

  useEffect(() => {
    let source: EventSource | null = null;
    let closed = false;
    let retry: number | null = null;

    const connect = () => {
      if (closed) return;
      source = new EventSource('/api/events');
      source.onopen = () => setConnected(true);
      source.onerror = () => {
        setConnected(false);
        source?.close();
        if (closed) return;
        if (retry) window.clearTimeout(retry);
        retry = window.setTimeout(connect, 2500);
      };
      const names = [
        'project.updated',
        'project.progress',
        'project.log',
        'clip.updated',
        'live.updated',
        'live.progress',
        'toast',
        'setup.status',
        'setup.progress',
      ];
      for (const name of names) {
        source.addEventListener(name, (raw) => {
          let data: unknown = null;
          try {
            data = JSON.parse((raw as MessageEvent).data);
          } catch {
            data = (raw as MessageEvent).data;
          }
          emitEvent({ type: name, data, at: Date.now() });
          if (name === 'toast' && data) notify(data as ToastEvent);
          if (name === 'setup.status' || name === 'setup.progress') {
            if (systemTimer.current) window.clearTimeout(systemTimer.current);
            systemTimer.current = window.setTimeout(() => {
              void refreshSystem();
              void refresh();
            }, name === 'setup.progress' ? 1200 : 350);
          }
        });
      }
    };

    connect();
    return () => {
      closed = true;
      setConnected(false);
      if (retry) window.clearTimeout(retry);
      if (systemTimer.current) window.clearTimeout(systemTimer.current);
      source?.close();
    };
  }, [notify, refresh, refreshSystem]);

  useEffect(
    () => () => {
      for (const timer of timers.current.values()) window.clearTimeout(timer);
    },
    [],
  );

  const saveSettings = useCallback(async (patch: Record<string, unknown>) => {
    const settings = await api.saveSettings(patch);
    setBootstrap((current) => (current ? { ...current, settings } : current));
    return settings;
  }, []);

  const confirm = useCallback(
    (options: ConfirmOptions) =>
      new Promise<boolean>((resolve) => {
        setConfirmState((current) => {
          current?.resolve(false);
          return { ...options, resolve };
        });
      }),
    [],
  );

  const resolveConfirm = useCallback((value: boolean) => {
    setConfirmState((current) => {
      current?.resolve(value);
      return null;
    });
  }, []);

  const value = useMemo<AppContextValue>(
    () => ({
      bootstrap,
      settings: bootstrap?.settings ?? null,
      system,
      loading,
      error,
      connected,
      toasts,
      notify,
      dismissToast,
      refresh,
      refreshSystem,
      saveSettings,
      confirm,
    }),
    [
      bootstrap,
      system,
      loading,
      error,
      connected,
      toasts,
      notify,
      dismissToast,
      refresh,
      refreshSystem,
      saveSettings,
      confirm,
    ],
  );

  return (
    <AppContext.Provider value={value}>
      {children}
      {confirmState ? (
        <ConfirmDialog
          title={confirmState.title}
          body={confirmState.body}
          confirmLabel={confirmState.confirmLabel}
          cancelLabel={confirmState.cancelLabel}
          tone={confirmState.tone}
          onConfirm={() => resolveConfirm(true)}
          onCancel={() => resolveConfirm(false)}
        />
      ) : null}
    </AppContext.Provider>
  );
}

export function useApp(): AppContextValue {
  const context = useContext(AppContext);
  if (!context) throw new Error('useApp must be used inside AppProvider');
  return context;
}

/** Subscribe to server events without pulling in a global store. */
export function useAppEvent(handler: (event: AppEvent) => void, types?: string[]): void {
  const latest = useRef(handler);
  latest.current = handler;
  const accepted = types?.join('|');
  useEffect(() => {
    const wanted = accepted ? new Set(accepted.split('|')) : null;
    const listener: EventListener = (event) => {
      if (wanted && !wanted.has(event.type)) return;
      latest.current(event);
    };
    eventListeners.add(listener);
    return () => {
      eventListeners.delete(listener);
    };
  }, [accepted]);
}

export function useConfirmState() {
  const [state, setState] = useState<ConfirmOptions | null>(null);
  const [resolve, setResolve] = useState<((value: boolean) => void) | null>(null);
  return { state, setState, resolve, setResolve };
}
