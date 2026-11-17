import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  Film,
  Filter,
  FolderOpen,
  HardDrive,
  Plus,
  Search,
  SlidersHorizontal,
  Sparkles,
  Star,
  Trash2,
} from 'lucide-react';
import type { Campaign, ClipRecord, LibraryClip } from '@shared/types';
import { PLATFORMS } from '@shared/platforms';
import { api, mediaUrl } from '@web/lib/api';
import { clock, plural, shortDate } from '@web/lib/format';
import { useAsyncData } from '@web/lib/hooks';
import { useApp } from '@web/state/AppContext';
import {
  Badge,
  Button,
  CopyButton,
  EmptyState,
  IconButton,
  Input,
  Modal,
  Panel,
  Segmented,
  Select,
  Skeleton,
  Spinner,
  cx,
} from '@web/components/ui';
import { ClipCard, ProjectPoster } from '@web/components/media';

type SortMode = 'newest' | 'score' | 'longest';

export default function Library() {
  const navigate = useNavigate();
  const { notify, confirm } = useApp();
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [platform, setPlatform] = useState('');
  const [campaign, setCampaign] = useState('');
  const [starredOnly, setStarredOnly] = useState(false);
  const [sort, setSort] = useState<SortMode>('newest');
  const [kitClip, setKitClip] = useState<LibraryClip | null>(null);
  const [kitText, setKitText] = useState('');
  const [kitLoading, setKitLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(query.trim()), 320);
    return () => window.clearTimeout(timer);
  }, [query]);

  const load = useCallback(async () => {
    const [clips, campaignData] = await Promise.all([
      api.library({
        q: debounced || undefined,
        platform: platform || undefined,
        campaign: campaign || undefined,
        starred: starredOnly || undefined,
      }),
      api.campaigns(),
    ]);
    return { clips, campaigns: campaignData.campaigns };
  }, [debounced, platform, campaign, starredOnly]);

  const { data, loading, reload } = useAsyncData(load, {
    deps: [debounced, platform, campaign, starredOnly],
    events: ['clip.updated', 'project.updated'],
    delay: 600,
  });

  const clips = data?.clips ?? [];
  const campaigns = data?.campaigns ?? [];
  const campaignById = useMemo(() => {
    const map = new Map<string, Campaign>();
    for (const entry of campaigns) map.set(entry.id, entry);
    return map;
  }, [campaigns]);

  const sorted = useMemo(() => {
    const list = [...clips];
    if (sort === 'score') list.sort((a, b) => b.clip.score - a.clip.score);
    else if (sort === 'longest') list.sort((a, b) => b.clip.duration - a.clip.duration);
    else list.sort((a, b) => b.clip.createdAt.localeCompare(a.clip.createdAt));
    return list;
  }, [clips, sort]);

  const filtersActive = Boolean(query || platform || campaign || starredOnly);

  const star = async (entry: LibraryClip) => {
    setBusyId(entry.clip.id);
    try {
      await api.updateClip(entry.clip.projectId, entry.clip.id, { starred: !entry.clip.starred });
      notify({
        tone: 'success',
        title: entry.clip.starred ? 'Star removed' : 'Starred for later',
        message: entry.clip.title,
      });
      void reload(true);
    } catch (error) {
      notify({ tone: 'error', title: 'Could not update the clip', message: (error as Error).message });
    } finally {
      setBusyId(null);
    }
  };

  const openKit = async (entry: LibraryClip) => {
    setKitClip(entry);
    setKitText('');
    setKitLoading(true);
    try {
      const result = await api.libraryKit(entry.clip.id);
      setKitText(result.kit);
    } catch (error) {
      notify({ tone: 'error', title: 'Could not build the posting kit', message: (error as Error).message });
      setKitClip(null);
    } finally {
      setKitLoading(false);
    }
  };

  const remove = async (entry: LibraryClip) => {
    const ok = await confirm({
      title: 'Delete this clip?',
      body: 'The rendered file, captions and thumbnail are removed from this laptop. The project stays in the library.',
      confirmLabel: 'Delete clip',
    });
    if (!ok) return;
    setBusyId(entry.clip.id);
    try {
      await api.deleteLibraryClip(entry.clip.id);
      notify({ tone: 'info', title: 'Clip deleted', message: entry.clip.title });
      void reload(true);
    } catch (error) {
      notify({ tone: 'error', title: 'Could not delete the clip', message: (error as Error).message });
    } finally {
      setBusyId(null);
    }
  };

  const clearFilters = () => {
    setQuery('');
    setPlatform('');
    setCampaign('');
    setStarredOnly(false);
  };

  return (
    <>
      <div className="page-head">
        <div className="page-head-copy">
          <p className="page-kicker">
            <Film size={13} /> Clip library
          </p>
          <h1 className="page-title">Everything you’ve cut</h1>
          <p className="page-sub">
            Every finished clip lives on this laptop, with its captions, thumbnail and posting kit ready to go. Star
            the best ones so they’re easy to find.
          </p>
        </div>
        <div className="head-actions">
          <Link to="/new" className="btn btn-primary">
            <Plus size={15} /> Make more clips
          </Link>
        </div>
      </div>

      <div className="library-toolbar">
        <div className="search-field">
          <Search size={15} />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search titles, hooks, captions, source…"
            aria-label="Search clips"
          />
        </div>
        <div className="select-wrap filter-select">
          <select
            className="input select"
            value={platform}
            onChange={(event) => setPlatform(event.target.value)}
            aria-label="Filter by platform"
          >
            <option value="">All platforms</option>
            {PLATFORMS.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </div>
        {campaigns.length ? (
          <div className="select-wrap filter-select">
            <select
              className="input select"
              value={campaign}
              onChange={(event) => setCampaign(event.target.value)}
              aria-label="Filter by campaign"
            >
              <option value="">All campaigns</option>
              {campaigns.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.name}
                </option>
              ))}
            </select>
          </div>
        ) : null}
        <button
          type="button"
          className={cx('chip', starredOnly && 'is-active')}
          onClick={() => setStarredOnly((current) => !current)}
          aria-pressed={starredOnly}
        >
          <Star size={12} fill={starredOnly ? 'currentColor' : 'none'} />
          Starred
        </button>
        <div className="select-wrap filter-select">
          <select
            className="input select"
            value={sort}
            onChange={(event) => setSort(event.target.value as SortMode)}
            aria-label="Sort clips"
          >
            <option value="newest">Newest first</option>
            <option value="score">Highest score</option>
            <option value="longest">Longest first</option>
          </select>
        </div>
        {filtersActive ? (
          <Button variant="ghost" size="sm" onClick={clearFilters} icon={SlidersHorizontal}>
            Clear
          </Button>
        ) : null}
        <span className="library-count">
          {loading ? 'Reading the shelf…' : `${plural(sorted.length, 'clip')} · saved locally`}
        </span>
      </div>

      {starredOnly && sorted.length ? (
        <div className="library-selection">
          <Star size={13} fill="currentColor" />
          Showing your starred clips only.
          <button type="button" className="text-link" onClick={() => setStarredOnly(false)}>
            Show everything
          </button>
        </div>
      ) : null}

      {loading && !data ? (
        <div className="library-grid">
          {Array.from({ length: 10 }, (_, index) => (
            <div key={index}>
              <Skeleton style={{ aspectRatio: '9 / 16', borderRadius: 15 }} />
              <Skeleton style={{ height: 12, marginTop: 10, width: '84%' }} />
              <Skeleton style={{ height: 10, marginTop: 6, width: '48%' }} />
            </div>
          ))}
        </div>
      ) : sorted.length ? (
        <div className="library-grid">
          {sorted.map((entry) => {
            const campaignEntry = entry.project.campaignId ? campaignById.get(entry.project.campaignId) : undefined;
            return (
              <div key={entry.clip.id} style={{ minWidth: 0 }}>
                <ClipCard
                  clip={entry.clip}
                  projectTitle={entry.project.title}
                  showProject
                  onOpen={() => navigate(`/project/${entry.clip.projectId}?clip=${entry.clip.id}`)}
                  onStar={() => void star(entry)}
                  onDownload={() =>
                    window.open(api.libraryDownloadUrl(entry.clip.id), '_blank', 'noopener')
                  }
                  onKit={() => void openKit(entry)}
                  actions={
                    <>
                      {busyId === entry.clip.id ? (
                        <span className="mini-action" aria-label="Working">
                          <Spinner size={13} />
                        </span>
                      ) : (
                        <IconButton
                          icon={Trash2}
                          label="Delete clip"
                          className="mini-action"
                          onClick={() => void remove(entry)}
                        />
                      )}
                    </>
                  }
                />
                <div className="clip-meta" style={{ marginTop: 4 }}>
                  <span>{entry.project.platform}</span>
                  <span className="meta-dot" />
                  <span>{shortDate(entry.clip.createdAt)}</span>
                  {campaignEntry ? (
                    <>
                      <span className="meta-dot" />
                      <span style={{ color: campaignEntry.color }}>{campaignEntry.name}</span>
                    </>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <EmptyState
          icon={filtersActive ? Filter : Film}
          title={filtersActive ? 'Nothing matches those filters' : 'Your library is still empty'}
          body={
            filtersActive
              ? 'Try a wider search or clear the platform and campaign filters.'
              : 'Make your first clip set from a link or upload. Finished clips and their posting kits land here.'
          }
          action={
            filtersActive ? (
              <Button variant="secondary" onClick={clearFilters} icon={SlidersHorizontal}>
                Clear filters
              </Button>
            ) : (
              <Link to="/new" className="btn btn-primary btn-sm">
                <Plus size={14} /> Make your first clips
              </Link>
            )
          }
        />
      )}

      {!loading && sorted.length ? (
        <p className="library-note">
          <HardDrive size={12} /> Stored under <code>data/projects</code> on this laptop. Nothing syncs to a cloud.
        </p>
      ) : null}

      <Modal open={Boolean(kitClip)} onClose={() => setKitClip(null)} size="md" labelledBy="library-kit-title">
        {kitClip ? (
          <>
            <div className="kit-head">
              <div className="kit-thumb">
                <ProjectPoster src={mediaUrl(kitClip.clip.files.thumb)} alt="" ratio="9 / 16" />
              </div>
              <div className="kit-copy">
                <h3 id="library-kit-title">Posting kit</h3>
                <p>{kitClip.clip.title}</p>
                <div style={{ display: 'flex', gap: 5, marginTop: 6, flexWrap: 'wrap' }}>
                  <Badge tone="violet">{clock(kitClip.clip.duration)}</Badge>
                  <Badge tone="neutral">{kitClip.project.title}</Badge>
                </div>
              </div>
            </div>
            {kitLoading ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '22px 0' }}>
                <Spinner size={16} /> Building caption, hashtags and campaign notes…
              </div>
            ) : (
              <>
                <pre className="copy-kit">{kitText}</pre>
                <div className="modal-actions">
                  <Button variant="secondary" icon={FolderOpen} onClick={() => navigate(`/project/${kitClip.clip.projectId}?clip=${kitClip.clip.id}`)}>
                    Open clip
                  </Button>
                  <CopyButton text={kitText} label="Copy the kit" variant="primary" />
                </div>
              </>
            )}
          </>
        ) : null}
      </Modal>
    </>
  );
}
