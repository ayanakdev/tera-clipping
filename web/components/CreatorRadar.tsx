import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowUpRight, Clock3, Plus, RadioTower, RefreshCw, Trash2, Users } from 'lucide-react';
import type { CreatorEntry, PlatformId } from '@shared/types';
import { PLATFORM_BY_ID } from '@shared/platforms';
import { creatorChannelUrl, creatorLiveUrl } from '@shared/creators';
import { api } from '@web/lib/api';
import { bigNumber, initials, timeAgo } from '@web/lib/format';
import { useApp } from '@web/state/AppContext';
import { Badge, Button, Input, Panel, Select, Skeleton, Spinner, cx } from '@web/components/ui';

const PLATFORM_OPTIONS: Array<{ value: Extract<PlatformId, 'twitch' | 'kick' | 'youtube'>; label: string }> = [
  { value: 'twitch', label: 'Twitch' },
  { value: 'kick', label: 'Kick' },
  { value: 'youtube', label: 'YouTube' },
];

export default function CreatorRadar({ onStarted }: { onStarted: () => void }) {
  const { notify, confirm } = useApp();
  const [creators, setCreators] = useState<CreatorEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [adding, setAdding] = useState(false);
  const [platform, setPlatform] = useState<Extract<PlatformId, 'twitch' | 'kick' | 'youtube'>>('twitch');
  const [handle, setHandle] = useState('');
  const [liveOnly, setLiveOnly] = useState(false);
  const [recordingId, setRecordingId] = useState<string | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (options: { force?: boolean; silent?: boolean } = {}) => {
      if (!options.silent) setLoading(true);
      if (options.force) setRefreshing(true);
      try {
        const next = options.force ? await api.refreshCreators() : await api.creators();
        setCreators(next.creators);
        setError(null);
      } catch (cause) {
        const message = (cause as Error).message || 'Could not check the creator radar.';
        setError(message);
        if (!options.silent) notify({ tone: 'error', title: 'Creator radar offline', message });
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [notify],
  );

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const timer = window.setInterval(() => void load({ silent: true }), 60_000);
    return () => window.clearInterval(timer);
  }, [load]);

  const live = useMemo(() => creators.filter((creator) => creator.status.live), [creators]);
  const visible = liveOnly ? live : creators;
  const lastChecked = creators.reduce((latest, creator) => {
    const stamp = creator.status.checkedAt;
    return stamp > latest ? stamp : latest;
  }, '');
  const liveViewers = live.reduce((sum, creator) => sum + (creator.status.viewers || 0), 0);

  const add = async () => {
    const value = handle.trim();
    if (!value || adding) return;
    setAdding(true);
    try {
      const next = await api.addCreator({ platform, handle: value });
      setCreators(next.creators);
      setHandle('');
      notify({
        tone: 'success',
        title: 'Added to the radar',
        message: 'TeraClip checked the channel and will keep watching it for live status.',
      });
    } catch (cause) {
      notify({ tone: 'error', title: 'Could not add that creator', message: (cause as Error).message });
    } finally {
      setAdding(false);
    }
  };

  const remove = async (creator: CreatorEntry) => {
    const ok = await confirm({
      title: `Remove ${creator.name} from the radar?`,
      body: 'This only changes your local watchlist. You can add the creator again whenever you want.',
      confirmLabel: 'Remove creator',
    });
    if (!ok) return;
    setRemovingId(creator.id);
    try {
      const next = await api.removeCreator(creator.id);
      setCreators(next.creators);
      notify({ tone: 'info', title: 'Removed from the radar', message: creator.name });
    } catch (cause) {
      notify({ tone: 'error', title: 'Could not remove the creator', message: (cause as Error).message });
    } finally {
      setRemovingId(null);
    }
  };

  const record = async (creator: CreatorEntry) => {
    if (recordingId) return;
    setRecordingId(creator.id);
    try {
      await api.recordCreator(creator.id, true);
      notify({
        tone: 'success',
        title: `Recording ${creator.name}`,
        message: 'The clean copy is rolling with auto-clip armed. Chat and audio spikes will cut highlights as they happen.',
      });
      onStarted();
    } catch (cause) {
      notify({ tone: 'error', title: 'Could not start recording', message: (cause as Error).message });
    } finally {
      setRecordingId(null);
    }
  };

  return (
    <Panel
      className="creator-radar"
      eyebrow="Pre-loaded watchlist · live checks without an API key"
      title={
        <span className="creator-radar-title">
          Creator radar
          <Badge tone={live.length ? 'red' : 'neutral'} dot={Boolean(live.length)}>
            {live.length ? `${live.length} live` : 'none live'}
          </Badge>
        </span>
      }
      action={
        <div className="creator-radar-actions">
          {liveViewers ? <span className="creator-viewer-total">{bigNumber(liveViewers)} watching</span> : null}
          <Button
            size="sm"
            variant="secondary"
            icon={RefreshCw}
            loading={refreshing}
            onClick={() => void load({ force: true, silent: true })}
          >
            Refresh
          </Button>
        </div>
      }
    >
      <div className="creator-toolbar">
        <div className="creator-tabs" role="tablist" aria-label="Filter creators">
          <button
            type="button"
            role="tab"
            aria-selected={!liveOnly}
            className={cx(!liveOnly && 'is-on')}
            onClick={() => setLiveOnly(false)}
          >
            All <span>{creators.length}</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={liveOnly}
            className={cx(liveOnly && 'is-on')}
            onClick={() => setLiveOnly(true)}
          >
            Live now <span>{live.length}</span>
          </button>
        </div>
        <span className="creator-checked">
          <Clock3 size={11} /> {lastChecked ? `checked ${timeAgo(lastChecked)}` : 'checking…'}
        </span>
        <form
          className="creator-add"
          onSubmit={(event) => {
            event.preventDefault();
            void add();
          }}
        >
          <Select
            className="creator-platform-select"
            value={platform}
            onChange={(value) => setPlatform(value as typeof platform)}
          >
            {PLATFORM_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
          <Input
            value={handle}
            onChange={(event) => setHandle(event.target.value)}
            placeholder="@handle or channel URL"
            aria-label="Creator handle"
            spellCheck={false}
          />
          <Button type="submit" size="sm" icon={Plus} loading={adding} disabled={!handle.trim()}>
            Add
          </Button>
        </form>
      </div>

      {error ? <p className="creator-error-banner">{error}</p> : null}

      {loading && !creators.length ? (
        <div className="creator-grid">
          {[0, 1, 2, 3].map((index) => (
            <div key={index} className="creator-card creator-skeleton">
              <Skeleton style={{ aspectRatio: '16 / 9', borderRadius: 0 }} />
              <div className="creator-body">
                <Skeleton style={{ height: 30, width: 30, borderRadius: '50%' }} />
                <Skeleton style={{ height: 12, width: '72%' }} />
                <Skeleton style={{ height: 10, width: '48%' }} />
                <Skeleton style={{ height: 28, width: '100%', marginTop: 'auto' }} />
              </div>
            </div>
          ))}
        </div>
      ) : visible.length ? (
        <div className="creator-grid">
          {visible.map((creator) => {
            const platformInfo = PLATFORM_BY_ID[creator.platform];
            const status = creator.status;
            const displayName = status.displayName || creator.name;
            const removing = removingId === creator.id;
            const recording = recordingId === creator.id;
            return (
              <article key={creator.id} className={cx('creator-card', status.live ? 'is-live' : 'is-offline')}>
                <div className={cx('creator-media', !status.live && 'is-offline')}>
                  <span
                    className="creator-media-fallback"
                    style={{ background: platformInfo?.soft, color: platformInfo?.color }}
                  >
                    {platformInfo?.short || creator.platform.slice(0, 2).toUpperCase()}
                  </span>
                  {status.live && status.thumbnailUrl ? (
                    <img
                      src={status.thumbnailUrl}
                      alt=""
                      loading="lazy"
                      referrerPolicy="no-referrer"
                      onError={(event) => {
                        // A dead CDN URL should fall back to the platform badge,
                        // not leave a blank white card.
                        event.currentTarget.style.display = 'none';
                      }}
                    />
                  ) : null}
                  {status.live ? (
                    <span className="creator-live-badge">
                      <i /> Live
                    </span>
                  ) : (
                    <span className="creator-offline-badge">Offline</span>
                  )}
                  <button
                    type="button"
                    className="creator-remove"
                    title={`Remove ${creator.name}`}
                    aria-label={`Remove ${creator.name}`}
                    disabled={removing}
                    onClick={() => void remove(creator)}
                  >
                    {removing ? <Spinner size={12} /> : <Trash2 size={13} />}
                  </button>
                </div>

                <div className="creator-body">
                  <div className="creator-who">
                    <span className="creator-avatar">
                      {status.avatarUrl ? (
                        <img src={status.avatarUrl} alt="" loading="lazy" />
                      ) : (
                        initials(displayName)
                      )}
                    </span>
                    <span className="creator-who-copy">
                      <span className="creator-name">{displayName}</span>
                      <span className="creator-handle">
                        @{creator.handle} · {platformInfo?.name || creator.platform}
                      </span>
                    </span>
                  </div>

                  {status.live ? (
                    <>
                      <div className="creator-stats">
                        {status.viewers ? (
                          <span>
                            <Users size={10} /> {bigNumber(status.viewers)}
                          </span>
                        ) : null}
                        {status.game ? <span className="creator-game">{status.game}</span> : null}
                      </div>
                      <p className="creator-title" title={status.title}>
                        {status.title || 'Live right now'}
                      </p>
                      <div className="creator-actions">
                        <Button size="sm" icon={RadioTower} loading={recording} onClick={() => void record(creator)}>
                          Record &amp; clip
                        </Button>
                        <a
                          className="icon-btn"
                          href={creatorLiveUrl(creator.platform, creator.handle)}
                          target="_blank"
                          rel="noreferrer"
                          title="Open the live stream"
                        >
                          <ArrowUpRight size={14} />
                        </a>
                      </div>
                    </>
                  ) : (
                    <>
                      <p className="creator-offline-copy">
                        {status.error || 'Not streaming right now. The radar checks again every minute.'}
                      </p>
                      <div className="creator-actions">
                        <a
                          className="btn btn-secondary btn-sm creator-channel"
                          href={creatorChannelUrl(creator.platform, creator.handle)}
                          target="_blank"
                          rel="noreferrer"
                        >
                          Open channel <ArrowUpRight size={12} />
                        </a>
                      </div>
                    </>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      ) : (
        <div className="creator-empty">
          <RadioTower size={16} />
          <div>
            <strong>{liveOnly ? 'Nobody on the radar is live right now.' : 'Your creator radar is empty.'}</strong>
            <p>
              {liveOnly
                ? 'Switch to All to see who is offline, or add another channel above.'
                : 'Add a Twitch, Kick or YouTube handle above. Checks run locally and no API key is needed.'}
            </p>
          </div>
        </div>
      )}
    </Panel>
  );
}
