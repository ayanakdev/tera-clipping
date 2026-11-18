import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import {
  Activity,
  ArrowDownToLine,
  ArrowUpRight,
  Check,
  Clock3,
  Cpu,
  Download,
  Film,
  Gauge,
  Link2,
  MessageSquare,
  Mic2,
  Radio,
  RadioTower,
  RefreshCw,
  Scissors,
  ShieldCheck,
  Signal,
  Sparkles,
  Square,
  Trash2,
  Users,
  Wand2,
  Wifi,
  WifiOff,
} from 'lucide-react';
import type { LiveSession } from '@shared/types';
import { LIVE_PLATFORMS, PLATFORM_BY_ID } from '@shared/platforms';
import { api, mediaUrl, type LiveListItem, type LiveResolution } from '@web/lib/api';
import { bytes, clock, plural, shortDate, timeAgo } from '@web/lib/format';
import { useAsyncData } from '@web/lib/hooks';
import { useApp } from '@web/state/AppContext';
import {
  Badge,
  Button,
  EmptyState,
  Field,
  Input,
  Panel,
  ProgressBar,
  Select,
  Spinner,
  Toggle,
  cx,
} from '@web/components/ui';
import { HeatTimeline, MiniSpark, ProjectPoster } from '@web/components/media';
import CreatorRadar from '@web/components/CreatorRadar';

const LIVE_STATUS_LABEL: Record<LiveSession['status'], string> = {
  preparing: 'Preparing',
  recording: 'Recording live',
  reconnecting: 'Reconnecting',
  stopping: 'Saving',
  processing: 'Processing',
  ready: 'Saved',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

function liveTone(status: LiveSession['status']): 'green' | 'violet' | 'red' | 'amber' | 'neutral' {
  if (status === 'recording') return 'red';
  if (status === 'reconnecting' || status === 'stopping' || status === 'processing' || status === 'preparing') return 'violet';
  if (status === 'ready') return 'green';
  if (status === 'failed' || status === 'cancelled') return 'red';
  return 'neutral';
}

function isRecording(session: LiveSession | null | undefined): boolean {
  return Boolean(session && ['preparing', 'recording', 'reconnecting', 'stopping'].includes(session.status));
}

/** Project the current disk usage to an hourly rate once enough data exists. */
function storageRate(totalBytes: number, seconds: number): string {
  if (!totalBytes || seconds < 30) return 'measuring…';
  return `≈ ${bytes((totalBytes / seconds) * 3600)}/h`;
}

export default function Live() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const { settings: appSettings, notify, confirm, connected } = useApp();

  const load = useCallback(() => api.live(), []);
  const { data, loading, reload } = useAsyncData(load, {
    events: ['live.updated', 'live.progress', 'project.updated'],
    delay: 500,
  });

  const active = data?.active ?? null;
  const sessions = data?.sessions ?? [];
  const pastSessions = sessions.filter((session) => session.id !== active?.id);

  const initialUrl = params.get('url') || '';
  const [url, setUrl] = useState(initialUrl);
  const [resolved, setResolved] = useState<LiveResolution | null>(null);
  const [resolving, setResolving] = useState(false);
  const [resolveError, setResolveError] = useState<string | null>(null);
  const [autoClip, setAutoClip] = useState<boolean | null>(null);
  const [starting, setStarting] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [creatingId, setCreatingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [tick, setTick] = useState(() => Date.now());
  const autoResolved = useRef(false);

  const effectiveAutoClip = autoClip ?? data?.autoClipDefault ?? appSettings?.liveAutoClip ?? false;
  const threshold = appSettings?.liveAutoClipThreshold ?? 68;
  const lookback = appSettings?.liveLookback ?? 90;
  const chatLag = appSettings?.liveChatLag ?? 14;

  // A real clock, not a counter: setInterval drifts and browsers throttle it,
  // so use Date.now() and reconcile with the server's monotonic elapsed.
  useEffect(() => {
    if (!active) return;
    const id = window.setInterval(() => setTick(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [active?.id]);

  // SSE pushes live state as it changes. As a safety net when the connection
  // sleeps or stalls, poll the session every 3s while a recording is live so
  // bytes, segments, heat and moments stay current.
  useEffect(() => {
    if (!isRecording(active)) return;
    const refresh = () => {
      if (document.hidden) return;
      void reload(true);
    };
    const timer = window.setInterval(refresh, 3000);
    const onVisible = () => {
      if (!document.hidden) void reload(true);
    };
    const onOnline = () => void reload(true);
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', onOnline);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', onOnline);
    };
  }, [active?.id, active?.status, reload, connected]);

  const resolve = useCallback(
    async (raw?: string) => {
      const target = (raw ?? url).trim();
      if (!target) {
        setResolveError('Paste a channel link first.');
        return;
      }
      setResolving(true);
      setResolveError(null);
      try {
        const info = await api.resolveLive(target);
        setResolved(info);
        setUrl(target);
      } catch (error) {
        setResolved(null);
        setResolveError((error as Error).message || 'That channel could not be read.');
      } finally {
        setResolving(false);
      }
    },
    [url],
  );

  useEffect(() => {
    if (!initialUrl || autoResolved.current) return;
    autoResolved.current = true;
    void resolve(initialUrl);
  }, [initialUrl, resolve]);

  const shownElapsed = useRef(0);
  useEffect(() => {
    shownElapsed.current = 0;
  }, [active?.id]);

  const elapsed = useMemo(() => {
    if (!active) return 0;
    const base = Math.max(0, active.elapsed ?? active.duration ?? 0);
    const updated = Date.parse(active.updatedAt);
    const drift = Number.isFinite(updated) ? Math.max(0, (tick - updated) / 1000) : 0;
    // Clamp to the highest value we have ever shown for this session. A stale
    // SSE snapshot, a reconnect or a stop-time probe can never rewind the timer.
    shownElapsed.current = Math.max(shownElapsed.current, base + drift);
    return shownElapsed.current;
  }, [active, tick]);

  const platformInfo = active ? PLATFORM_BY_ID[active.platform] : null;
  const latest = sessions[0];
  const finalising = sessions.some((session) => session.status === 'processing' || session.status === 'stopping');

  const start = async () => {
    if (starting) return;
    if (!resolved) {
      setResolveError('Read the channel before starting the recorder.');
      return;
    }
    if (!resolved.isLive) {
      notify({ tone: 'error', title: 'This channel is not live', message: 'The recorder needs an active stream.' });
      return;
    }
    setStarting(true);
    try {
      const session = await api.startLive({
        url: url.trim(),
        title: resolved.title,
        autoClip: effectiveAutoClip,
      });
      notify({
        tone: 'success',
        title: 'Recorder started',
        message: `Clean copy of ${session.channel || resolved.channel} is being written to this laptop.`,
      });
      setResolved(null);
      void reload();
    } catch (error) {
      notify({ tone: 'error', title: 'Could not start recording', message: (error as Error).message });
    } finally {
      setStarting(false);
    }
  };

  const stop = async () => {
    if (!active || stopping) return;
    const ok = await confirm({
      title: 'Stop and save this recording?',
      body:
        appSettings?.liveMomentOnly && active.autoClip
          ? `Moment buffer mode is on, so only the last ≈ ${Math.round((lookback + 180) / 60)} minutes are on disk. TeraClip will finalise that tail for current and future clip projects.`
          : `TeraClip will close the segments and finalise ${clock(elapsed, true)} of capture. Chat heat and detected moments are kept.`,
      confirmLabel: 'Stop recording',
      cancelLabel: 'Keep recording',
    });
    if (!ok) return;
    setStopping(true);
    try {
      await api.stopLive(active.id);
      notify({ tone: 'info', title: 'Stopping the recorder', message: 'Finalising the recording and chat heat.' });
      void reload();
    } catch (error) {
      notify({ tone: 'error', title: 'Could not stop cleanly', message: (error as Error).message });
    } finally {
      setStopping(false);
    }
  };

  const changeAutoClip = async (value: boolean) => {
    setAutoClip(value);
    if (!active) return;
    try {
      await api.toggleLiveAutoClip(active.id, value);
      notify({
        tone: 'success',
        title: value ? 'Auto-clip armed' : 'Auto-clip off',
        message: value ? `A clip is cut whenever heat passes ${threshold}.` : 'You can still cut the recording afterwards.',
      });
    } catch (error) {
      setAutoClip(!value);
      notify({ tone: 'error', title: 'Could not change auto-clip', message: (error as Error).message });
    }
  };

  const makeClips = async (session: LiveListItem) => {
    if (creatingId) return;
    setCreatingId(session.id);
    try {
      const result = await api.createLiveClips(session.id);
      notify({
        tone: 'success',
        title: 'Recording handed to the clipper',
        message: result.rawRecordingKept
          ? 'Chat heat is included in the moment scoring. The raw recording was kept.'
          : 'Chat heat is included. The full recording now lives inside the project; the duplicate live copy was removed.',
      });
      navigate(`/project/${result.projectId}`);
    } catch (error) {
      notify({ tone: 'error', title: 'Could not create clips', message: (error as Error).message });
    } finally {
      setCreatingId(null);
    }
  };

  const deleteSession = async (session: LiveListItem) => {
    const ok = await confirm({
      title: 'Delete this recording?',
      body: 'The local recording, segments and chat heat are removed. Any project already made from it stays in the library.',
      confirmLabel: 'Delete recording',
    });
    if (!ok) return;
    setDeletingId(session.id);
    try {
      await api.deleteLive(session.id);
      notify({ tone: 'info', title: 'Recording deleted' });
      void reload();
    } catch (error) {
      notify({ tone: 'error', title: 'Could not delete the recording', message: (error as Error).message });
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <>
      <div className="page-head">
        <div className="page-head-copy">
          <p className="page-kicker">
            <Radio size={13} /> Live recorder
          </p>
          <h1 className="page-title">{active ? 'The tape is rolling' : 'Catch it while it happens'}</h1>
          <p className="page-sub">
            A clean stream copy is written straight to disk — no screen capture, no browser tab, no dropped frames. Chat
            heat and audio spikes mark the moments while you watch.
          </p>
        </div>
        <div className="head-actions">
          <Link to="/new" className="btn btn-secondary">
            <Film size={15} /> Clip a VOD instead
          </Link>
          <Link to="/settings" className="btn btn-primary">
            <Gauge size={15} /> Live settings
          </Link>
        </div>
      </div>

      {!active ? <CreatorRadar onStarted={() => void reload()} /> : null}

      {loading && !data ? (
        <div className="live-setup">
          <div className="live-main">
            <div className="panel">
              <div className="panel-body" style={{ display: 'flex', alignItems: 'center', gap: 10, padding: 40 }}>
                <Spinner size={16} /> Checking the recorder…
              </div>
            </div>
          </div>
        </div>
      ) : active ? (
        <div className="live-grid">
          <div className="live-main">
            <section className="recorder-card">
              <div className="recorder-top">
                {active.thumbnailUrl ? (
                  <div className="rec-live-thumb">
                    <img src={active.thumbnailUrl} alt="" referrerPolicy="no-referrer" />
                  </div>
                ) : null}
                <div style={{ minWidth: 0, flex: 1 }}>
                  <span className={cx('rec-status', isRecording(active) && 'is-live')}>
                    <span className="rec-dot" />
                    {LIVE_STATUS_LABEL[active.status]}
                  </span>
                  <h2 className="rec-title">{active.title || 'Live stream'}</h2>
                  <p className="rec-sub">
                    {platformInfo?.name ?? active.platform} · {active.channel || 'channel'} · started{' '}
                    {timeAgo(active.startedAt)}
                  </p>
                </div>
                <Badge tone={active.health === 'good' ? 'green' : active.health === 'offline' ? 'red' : 'amber'} dot>
                  {active.health}
                </Badge>
              </div>

              <div className="rec-time">
                {clock(elapsed, true)}
                <small>captured</small>
              </div>
              {active.spliceMarker ? (
                <p className="rec-splice-note" title={active.spliceMarker.explanation}>
                  <WifiOff size={12} /> Reconnected at {clock(active.spliceMarker.at, true)} · a few seconds may be missing.
                </p>
              ) : null}

              <div className="rec-health-row">
                <span className="rec-health">
                  <i /> Stream copy
                </span>
                <span className={cx('rec-health', !active.chatConnected && 'is-off')}>
                  {active.chatConnected ? <i /> : <i />} Chat{' '}
                  {active.chatConnected ? `${active.chatMessages.toLocaleString()} lines` : 'not connected'}
                </span>
                <span className={cx('rec-health', !active.autoClip && 'is-off')}>
                  <i /> Auto-clip {active.autoClip ? `at ${threshold}+` : 'off'}
                </span>
                <span className={cx('rec-health', active.moments.length === 0 && 'is-off')}>
                  <i /> {plural(active.moments.length, 'moment')} marked
                </span>
              </div>

              <MiniSpark points={active.audioHeat.slice(-70)} className="rec-spark" />

              <div className="rec-metrics">
                <div className="rec-metric">
                  <span>On disk</span>
                  <strong>{bytes(active.bytes)}</strong>
                </div>
                <div className="rec-metric">
                  <span>{appSettings?.liveMomentOnly && active.autoClip ? 'Buffer' : 'Write rate'}</span>
                  <strong>
                    {appSettings?.liveMomentOnly && active.autoClip
                      ? `≈ ${Math.round((lookback + 180) / 60)} min`
                      : storageRate(active.bytes, elapsed)}
                  </strong>
                </div>
                <div className="rec-metric">
                  <span>Chat lines</span>
                  <strong>{active.chatMessages.toLocaleString()}</strong>
                </div>
                <div className="rec-metric">
                  <span>Heat moments</span>
                  <strong>{active.moments.length}</strong>
                </div>
              </div>

              <div className="rec-actions">
                <Button
                  variant="danger"
                  icon={Square}
                  loading={stopping || active.status === 'stopping'}
                  onClick={() => void stop()}
                >
                  Stop & save
                </Button>
                <a
                  className="btn btn-hero-ghost"
                  href={active.url}
                  target="_blank"
                  rel="noreferrer"
                  title="Open the stream in a new tab — the recorder keeps running"
                >
                  <ArrowUpRight size={15} /> Open stream
                </a>
                <div className="rec-auto">
                  <span>Auto-clip</span>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={active.autoClip}
                    aria-label="Auto-clip during recording"
                    className={cx('switch', active.autoClip && 'is-on')}
                    onClick={() => void changeAutoClip(!active.autoClip)}
                  >
                    <span className="switch-knob" />
                  </button>
                </div>
              </div>
            </section>

            <section className="live-timeline-panel">
              <div className="live-timeline-head">
                <div>
                  <p className="live-timeline-title">Heat across the stream</p>
                  <p className="live-timeline-sub">
                    Audio energy from the stream itself, chat heat from the platform, and every moment the engine
                    marked.
                  </p>
                </div>
                <div className="live-timeline-legend">
                  <span>audio</span>
                  <span>chat</span>
                  <span>moments</span>
                </div>
              </div>
              <HeatTimeline
                audioHeat={active.audioHeat}
                chatHeat={active.chatHeat}
                moments={active.moments}
                duration={Math.max(active.duration, 60)}
                height={150}
              />
            </section>

            <Panel
              title="Detected moments"
              eyebrow="Marked live, no AI required"
              action={
                <Badge tone={active.moments.length ? 'violet' : 'neutral'}>
                  {active.moments.length} so far
                </Badge>
              }
            >
              {active.moments.length ? (
                <div className="moment-list">
                  {[...active.moments]
                    .reverse()
                    .slice(0, 12)
                    .map((moment) => (
                      <div key={moment.id} className="moment-row">
                        <span className="moment-time">{clock(moment.t)}</span>
                        <div className="moment-copy">
                          <p className="moment-reason">{moment.reason}</p>
                          <p className="moment-sub">
                            audio + chat heat
                            {moment.projectId ? ' · clip project queued' : ''}
                          </p>
                        </div>
                        <span
                          className={cx(
                            'moment-score',
                            moment.score >= 75 ? 'is-hot' : moment.score >= 55 ? 'is-warm' : 'is-cool',
                          )}
                        >
                          {Math.round(moment.score)}
                        </span>
                        <div className="moment-actions">
                          {moment.projectId ? (
                            <Link
                              to={`/project/${moment.projectId}`}
                              className="icon-btn"
                              title="Open the auto-clip project"
                            >
                              <Film size={14} />
                            </Link>
                          ) : (
                            <span className="icon-btn" title="Cut after the recording stops" style={{ cursor: 'default' }}>
                              <Scissors size={14} />
                            </span>
                          )}
                        </div>
                      </div>
                    ))}
                </div>
              ) : (
                <div className="live-empty">
                  <Sparkles size={14} />
                  <span>
                    Moments appear when chat speeds up or the stream gets loud. A little patience — the first few
                    minutes are usually quiet.
                  </span>
                </div>
              )}
              <div className="tool-note" style={{ marginTop: 14 }}>
                <Scissors size={14} />
                <span>
                  <strong>The cut happens after you stop.</strong> Hit “Stop &amp; save”, then turn the recording into
                  1–10 clips with chat heat included.
                </span>
              </div>
            </Panel>
          </div>

          <aside className="live-side">
            <div className="live-side-card">
              <div className="live-side-title">
                Session <span>{LIVE_STATUS_LABEL[active.status]}</span>
              </div>
              <div className="fact-list">
                <div className="fact-row">
                  <span className="fact-label">Channel</span>
                  <span className="fact-value">{active.channel || '—'}</span>
                </div>
                <div className="fact-row">
                  <span className="fact-label">Platform</span>
                  <span className="fact-value">{platformInfo?.name ?? active.platform}</span>
                </div>
                <div className="fact-row">
                  <span className="fact-label">Quality</span>
                  <span className="fact-value">{appSettings?.recordQuality ?? 'best'}</span>
                </div>
                <div className="fact-row">
                  <span className="fact-label">Lookback</span>
                  <span className="fact-value">{lookback}s</span>
                </div>
                <div className="fact-row">
                  <span className="fact-label">Chat lag</span>
                  <span className="fact-value">{chatLag}s rewind</span>
                </div>
                <div className="fact-row">
                  <span className="fact-label">Auto threshold</span>
                  <span className="fact-value">{threshold}+ heat</span>
                </div>
                <div className="fact-row">
                  <span className="fact-label">Segments</span>
                  <span className="fact-value">{active.segments}</span>
                </div>
                {appSettings?.liveMomentOnly ? (
                  <div className="fact-row">
                    <span className="fact-label">Buffer</span>
                    <span className="fact-value">
                      {active.autoClip ? `rolling ≈ ${Math.round((lookback + 180) / 60)} min` : 'off — auto-clip disabled'}
                    </span>
                  </div>
                ) : null}
                <div className="fact-row">
                  <span className="fact-label">Last write</span>
                  <span className="fact-value">{timeAgo(active.updatedAt)}</span>
                </div>
              </div>
              {active.error ? (
                <div className="live-empty" style={{ marginTop: 12, borderColor: 'rgba(217,45,63,.3)', color: 'var(--red)' }}>
                  <WifiOff size={14} />
                  <span>{active.error}</span>
                </div>
              ) : null}
            </div>

            <div className="live-side-card">
              <div className="live-side-title">
                Recorder log <span>{active.log.length ? 'latest first' : ''}</span>
              </div>
              <div className="live-log">
                {[...active.log]
                  .reverse()
                  .slice(0, 60)
                  .map((entry, index) => (
                    <div key={`${entry.t}-${index}`} className={cx('live-log-row', `is-${entry.level}`)}>
                      <time>{new Date(entry.t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>
                      <span>{entry.message}</span>
                    </div>
                  ))}
                {!active.log.length ? <span className="live-log-row">Waiting for the first segment…</span> : null}
              </div>
            </div>

            <div className="live-side-card">
              <div className="live-side-title">
                Capture health <span>local only</span>
              </div>
              <div className="signal-list">
                <div className="signal-row">
                  <span className="signal-icon">
                    {active.chatConnected ? <MessageSquare size={12} /> : <WifiOff size={12} />}
                  </span>
                  Chat feed
                  <span>{active.chatConnected ? `${active.chatMessages} lines` : 'offline'}</span>
                </div>
                <div className="signal-row">
                  <span className="signal-icon">
                    <Mic2 size={12} />
                  </span>
                  Audio sampling
                  <span>{active.audioHeat.length} points</span>
                </div>
                <div className="signal-row">
                  <span className="signal-icon">
                    <Cpu size={12} />
                  </span>
                  Local analysis
                  <span>running</span>
                </div>
                <div className="signal-row">
                  <span className="signal-icon">
                    <ShieldCheck size={12} />
                  </span>
                  Cloud AI during capture
                  <span>never</span>
                </div>
              </div>
              <p className="live-note" style={{ marginTop: 10 }}>
                <ShieldCheck size={12} /> Gemini is never called while recording. Moments are scored locally and the
                cloud is optional later.
              </p>
            </div>
          </aside>
        </div>
      ) : (
        <>
          {finalising ? (
            <div className="project-alert" style={{ marginTop: 0, marginBottom: 16, borderColor: 'rgba(124,58,237,.25)', background: 'var(--violet-50)', color: 'var(--violet-900)' }}>
              <RefreshCw size={15} className="spin" />
              <div>
                <strong>Saving the recording</strong>
                Segments are being joined and chat heat written. Clips unlock as soon as this finishes.
                {latest ? (
                  <span>
                    {' '}
                    Latest: {latest.title} · {clock(latest.duration)}
                  </span>
                ) : null}
              </div>
            </div>
          ) : null}

          <div className="live-setup">
            <div className="live-main">
              <Panel
                eyebrow="Step 01 · Channel"
                title="Point at a live stream"
                action={
                  resolved?.isLive ? (
                    <Badge tone="red" dot>
                      live now
                    </Badge>
                  ) : undefined
                }
              >
                <div className="live-url-block">
                  <div className="url-row">
                    <Input
                      className="input-lg"
                      value={url}
                      onChange={(event) => {
                        setUrl(event.target.value);
                        if (resolved) setResolved(null);
                      }}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') void resolve();
                      }}
                      placeholder="https://twitch.tv/channel · https://kick.com/channel · youtube.com/@channel/live"
                      aria-label="Live channel link"
                      spellCheck={false}
                    />
                    <Button
                      variant={resolved ? 'secondary' : 'primary'}
                      icon={resolved ? RefreshCw : Link2}
                      loading={resolving}
                      onClick={() => void resolve()}
                    >
                      {resolved ? 'Check again' : 'Read channel'}
                    </Button>
                  </div>
                  <div className="platform-row">
                    <span className="platform-hint">Live now on</span>
                    {LIVE_PLATFORMS.map((id) => {
                      const platform = PLATFORM_BY_ID[id];
                      if (!platform) return null;
                      return (
                        <button
                          key={id}
                          type="button"
                          className="platform-mini"
                          title={platform.note}
                          onClick={() => {
                            setUrl('');
                            setResolved(null);
                            setResolveError(null);
                          }}
                        >
                          <span
                            className="platform-tile"
                            style={{ background: platform.soft, color: platform.color }}
                            aria-hidden
                          >
                            {platform.short}
                          </span>
                          {platform.name}
                        </button>
                      );
                    })}
                    <span className="platform-hint" style={{ marginLeft: 'auto' }}>
                      ended streams belong in New clips
                    </span>
                  </div>
                </div>

                {resolveError ? (
                  <p className="field-help" style={{ marginTop: 10, color: 'var(--red)' }}>
                    {resolveError}
                  </p>
                ) : null}

                {resolved ? (
                  <div className="live-poster-row" style={{ marginTop: 16 }}>
                    <div className="live-poster">
                      {resolved.thumbnail ? (
                        <img
                          src={resolved.thumbnail}
                          alt=""
                          style={{ width: '100%', aspectRatio: '16 / 9', objectFit: 'cover' }}
                          loading="lazy"
                        />
                      ) : (
                        <ProjectPoster alt={resolved.title} ratio="16 / 9" />
                      )}
                    </div>
                    <div className="live-poster-copy">
                      <p className="live-poster-title">{resolved.title || 'Untitled live stream'}</p>
                      <div className="live-poster-meta">
                        <span>{resolved.channel}</span>
                        <span className="meta-dot" />
                        <span>{PLATFORM_BY_ID[resolved.platform]?.name ?? resolved.platform}</span>
                        {resolved.duration ? (
                          <>
                            <span className="meta-dot" />
                            <span>{clock(resolved.duration)} so far</span>
                          </>
                        ) : null}
                        <Badge tone={resolved.isLive ? 'red' : 'neutral'} dot={resolved.isLive}>
                          {resolved.isLive ? 'live' : 'not live'}
                        </Badge>
                      </div>
                      {resolved.width && resolved.height ? (
                        <p className="live-poster-meta">
                          Source {resolved.width}×{resolved.height}
                        </p>
                      ) : null}
                    </div>
                  </div>
                ) : null}

                <div className="settings-block" style={{ marginTop: 16 }}>
                  <Toggle
                    checked={effectiveAutoClip}
                    onChange={(value) => void changeAutoClip(value)}
                    label="Cut clips automatically when heat spikes"
                    hint={`The engine cuts a ${lookback}s lookback window once chat and audio heat pass ${threshold}. Chat surges rewind ${chatLag}s to catch the action. Runs locally and is off by default.`}
                  />
                </div>

                <div className="live-go-live" style={{ marginTop: 14 }}>
                  <Button
                    size="lg"
                    icon={RadioTower}
                    loading={starting}
                    disabled={!resolved?.isLive || resolving}
                    onClick={() => void start()}
                  >
                    {resolved?.isLive
                      ? starting
                        ? 'Starting the recorder…'
                        : 'Start recording live'
                      : resolved
                        ? 'Channel is not live'
                        : 'Read the channel first'}
                  </Button>
                  <span className="live-note">
                    <ShieldCheck size={12} /> A stream copy is written to <code>data/live</code> in 6-second segments.
                    {appSettings?.liveMomentOnly ? ' Moment buffer mode deletes all but the recent window.' : ''} Closing
                    this tab does not stop the recorder.
                  </span>
                </div>
              </Panel>

              <Panel
                title="Recordings on this laptop"
                eyebrow="Every capture, kept locally"
                action={<Badge tone="neutral">{pastSessions.length} saved</Badge>}
              >
                {pastSessions.length ? (
                  <div className="live-session-list">
                    {pastSessions.map((session) => (
                      <div key={session.id} className="live-session-row">
                        <div className="live-session-thumb">
                          {session.thumbnailUrl ? (
                            <img
                              src={session.thumbnailUrl}
                              alt=""
                              style={{ width: '100%', aspectRatio: '16 / 9', objectFit: 'cover' }}
                              loading="lazy"
                            />
                          ) : (
                            <ProjectPoster alt={session.title} ratio="16 / 9" />
                          )}
                        </div>
                        <div className="live-session-copy">
                          <p className="live-session-title">{session.title || 'Live recording'}</p>
                          <div className="live-session-meta">
                            <Badge tone={liveTone(session.status)}>{LIVE_STATUS_LABEL[session.status]}</Badge>
                            <span>{PLATFORM_BY_ID[session.platform]?.name ?? session.platform}</span>
                            <span className="meta-dot" />
                            <span>{shortDate(session.startedAt)}</span>
                            <span className="meta-dot" />
                            <span>{clock(session.duration, true)}</span>
                            {session.moments.length ? (
                              <>
                                <span className="meta-dot" />
                                <span>{plural(session.moments.length, 'moment')}</span>
                              </>
                            ) : null}
                          </div>
                        </div>
                        <div className="live-session-actions">
                          {session.recordingAvailable ? (
                            <a
                              className="icon-btn"
                              href={api.liveRecordingUrl(session.id)}
                              title="Download the recording"
                              target="_blank"
                              rel="noreferrer"
                            >
                              <Download size={15} />
                            </a>
                          ) : null}
                          {session.projectId ? (
                            <Link
                              to={`/project/${session.projectId}`}
                              className="btn btn-secondary btn-sm"
                              title="Open the clip project made from this recording"
                            >
                              <Film size={13} /> Open clips
                            </Link>
                          ) : null}
                          {session.recordingAvailable && !session.projectId ? (
                            <Button
                              size="sm"
                              icon={Scissors}
                              loading={creatingId === session.id}
                              disabled={session.busy || Boolean(creatingId)}
                              onClick={() => void makeClips(session)}
                            >
                              Make clips
                            </Button>
                          ) : null}
                          {session.projectId && session.recordingAvailable ? (
                            <Button
                              size="sm"
                              variant="secondary"
                              icon={Scissors}
                              loading={creatingId === session.id}
                              disabled={session.busy || Boolean(creatingId)}
                              onClick={() => void makeClips(session)}
                              title="Scan the full recording again for moments the live pass missed"
                            >
                              Re-cut
                            </Button>
                          ) : null}
                          <button
                            type="button"
                            className="icon-btn"
                            title="Delete this recording"
                            disabled={deletingId === session.id || session.busy}
                            onClick={() => void deleteSession(session)}
                          >
                            {deletingId === session.id ? <Spinner size={14} /> : <Trash2 size={15} />}
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <EmptyState
                    icon={Radio}
                    title="No recordings yet"
                    body="Point the recorder at a live channel. Segments, chat heat and marked moments will appear here after the first capture."
                  />
                )}
              </Panel>
            </div>

            <aside className="live-side">
              <div className="live-side-card">
                <div className="live-side-title">
                  Why a clean copy? <span>zero re-encode</span>
                </div>
                <div className="how-list">
                  <div className="how-item">
                    <span className="how-num">
                      <Check size={11} />
                    </span>
                    <div className="how-copy">
                      <strong>No screen capture</strong>
                      The stream is pulled directly in its native format. Nothing is re-encoded while recording, so
                      the laptop stays quiet and the video never freezes.
                    </div>
                  </div>
                  <div className="how-item">
                    <span className="how-num">
                      <Check size={11} />
                    </span>
                    <div className="how-copy">
                      <strong>Crash-friendly segments</strong>
                      Six-second MPEG-TS parts are written independently. A dropped connection reconnects without
                      losing the tape.
                    </div>
                  </div>
                  <div className="how-item">
                    <span className="how-num">
                      <Check size={11} />
                    </span>
                    <div className="how-copy">
                      <strong>Two heat signals</strong>
                      Audio RMS plus live chat rate. Chat spikes from viewers carry as much weight as loud moments.
                    </div>
                  </div>
                  <div className="how-item">
                    <span className="how-num">
                      <Check size={11} />
                    </span>
                    <div className="how-copy">
                      <strong>AI stays off</strong>
                      No Gemini calls while capturing. Foreground guardrails keep the recorder on the local machine.
                    </div>
                  </div>
                </div>
              </div>

              <div className="live-side-card">
                <div className="live-side-title">
                  Recorder defaults <span>from Settings</span>
                </div>
                <div className="fact-list">
                  <div className="fact-row">
                    <span className="fact-label">Capture quality</span>
                    <span className="fact-value">{appSettings?.recordQuality ?? 'best'}</span>
                  </div>
                  <div className="fact-row">
                    <span className="fact-label">Auto-clip</span>
                    <span className="fact-value">{appSettings?.liveAutoClip ? 'armed' : 'off'}</span>
                  </div>
                  <div className="fact-row">
                    <span className="fact-label">Heat threshold</span>
                    <span className="fact-value">{threshold} / 100</span>
                  </div>
                  <div className="fact-row">
                    <span className="fact-label">Lookback</span>
                    <span className="fact-value">{lookback}s</span>
                  </div>
                  <div className="fact-row">
                    <span className="fact-label">Chat lag</span>
                    <span className="fact-value">{chatLag}s rewind</span>
                  </div>
                </div>
                <Link to="/settings" className="btn btn-secondary btn-sm" style={{ marginTop: 12, width: '100%' }}>
                  <Gauge size={13} /> Change defaults
                </Link>
              </div>

              <div className="live-side-card">
                <div className="live-side-title">
                  Supported live <span>chat included</span>
                </div>
                <div className="signal-list">
                  <div className="signal-row">
                    <span className="signal-icon">
                      <Users size={12} />
                    </span>
                    Twitch
                    <span>IRC chat</span>
                  </div>
                  <div className="signal-row">
                    <span className="signal-icon">
                      <Signal size={12} />
                    </span>
                    Kick
                    <span>Pusher chat</span>
                  </div>
                  <div className="signal-row">
                    <span className="signal-icon">
                      <Activity size={12} />
                    </span>
                    YouTube
                    <span>audio heat</span>
                  </div>
                  <div className="signal-row">
                    <span className="signal-icon">
                      <Wifi size={12} />
                    </span>
                    Rumble
                    <span>audio heat</span>
                  </div>
                </div>
                <p className="live-note" style={{ marginTop: 10 }}>
                  <Clock3 size={12} /> Chat capture needs a public channel name. Private or age-gated chat falls back to
                  audio only.
                </p>
              </div>
            </aside>
          </div>
        </>
      )}

      <div className="live-footer">
        <span>
          <ArrowDownToLine size={11} /> Recordings and clips never leave this laptop.
        </span>
        <span>{latest ? `Last capture ${timeAgo(latest.updatedAt)}` : 'Recorder idle'}</span>
      </div>
    </>
  );
}
