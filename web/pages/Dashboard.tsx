import { useCallback, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  ArrowRight,
  CalendarDays,
  CircleDollarSign,
  Clock3,
  Cpu,
  Film,
  Gauge,
  HardDrive,
  Link2,
  Play,
  Plus,
  Radio,
  Sparkles,
  Timer,
  Upload,
  Wand2,
} from 'lucide-react';
import type { Campaign, LibraryClip, ProjectSummary, StudioStats, Submission } from '@shared/types';
import { AUTO_CLIP_COUNT } from '@shared/presets';
import { api, mediaUrl } from '@web/lib/api';
import { bytes, clock, dateLabel, greeting, plural, timeAgo } from '@web/lib/format';
import { useAsyncData } from '@web/lib/hooks';
import { useApp } from '@web/state/AppContext';
import { Badge, Button, EmptyState, Input, Panel, ProgressBar, ScoreBadge, Skeleton } from '@web/components/ui';
import { ClipCard, StatusChip } from '@web/components/media';

interface DashboardData {
  projects: ProjectSummary[];
  library: LibraryClip[];
  campaigns: Campaign[];
  submissions: Submission[];
  studio: { stats: StudioStats; dataDir: string };
}

export default function Dashboard() {
  const navigate = useNavigate();
  const { settings, system, notify, confirm, bootstrap } = useApp();
  const [quickUrl, setQuickUrl] = useState('');

  const load = useCallback(async (): Promise<DashboardData> => {
    const [projects, library, campaignData, studio] = await Promise.all([
      api.projects(),
      api.library(),
      api.campaigns(),
      api.studio(),
    ]);
    return {
      projects,
      library,
      campaigns: campaignData.campaigns,
      submissions: campaignData.submissions,
      studio,
    };
  }, []);

  const { data, loading, reload } = useAsyncData(load, {
    events: ['project.updated', 'clip.updated', 'live.updated'],
  });

  const library = data?.library ?? [];
  const ready = library.filter((entry) => entry.clip.status === 'ready');
  const weekAgo = Date.now() - 7 * 86_400_000;
  const thisWeek = ready.filter((entry) => new Date(entry.clip.createdAt).getTime() >= weekAgo);
  const minutes = ready.reduce((sum, entry) => sum + entry.clip.duration, 0) / 60;
  const projects = useMemo(() => {
    const list = data?.projects ?? [];
    return [...list].sort((a, b) => {
      const aActive = a.status !== 'ready' && a.status !== 'failed' && a.status !== 'cancelled' ? 1 : 0;
      const bActive = b.status !== 'ready' && b.status !== 'failed' && b.status !== 'cancelled' ? 1 : 0;
      if (aActive !== bActive) return bActive - aActive;
      return b.updatedAt.localeCompare(a.updatedAt);
    });
  }, [data?.projects]);
  const activeProjects = projects.filter((project) => project.status !== 'ready' && project.status !== 'failed');
  const campaign = data?.campaigns.find((item) => item.status === 'active') ?? data?.campaigns[0];
  const campaignSubmissions = campaign ? data?.submissions.filter((submission) => submission.campaignId === campaign.id) ?? [] : [];
  const earned = campaignSubmissions.reduce((sum, submission) => sum + submission.earnings, 0);
  const usage = system?.gemini.usage;
  const limit = system?.gemini.dailyLimit ?? 40;

  const starClip = async (clip: LibraryClip['clip']) => {
    try {
      await api.updateClip(clip.projectId, clip.id, { starred: !clip.starred });
      notify({
        tone: 'success',
        title: clip.starred ? 'Removed from starred' : 'Clipped for later',
        message: clip.title,
      });
      void reload(true);
    } catch (error) {
      notify({ tone: 'error', title: 'Could not update the clip', message: (error as Error).message });
    }
  };

  const openQuickImport = () => {
    if (!quickUrl.trim()) {
      navigate('/new');
      return;
    }
    const url = quickUrl.trim();
    navigate(`/new?url=${encodeURIComponent(url)}`);
  };

  return (
    <>
      <section className="hero">
        <div className="hero-ticks" aria-hidden />
        <div className="hero-grid">
          <div className="hero-copy">
            <span className="hero-badge">
              <span className="hero-badge-dot" />
              Local-first · no account needed
            </span>
            <h1 className="hero-title">
              <span className="hero-line">Last night’s stream.</span>
              <span className="hero-line">Today’s clips.</span>
            </h1>
            <p className="hero-text">
              Drop a link or a file. TeraClip finds the moments worth posting, cuts them vertical, and burns in captions
              that land on every word.
            </p>
            <div className="hero-actions">
              <Link to="/new" className="btn btn-lg btn-hero">
                <Sparkles size={17} strokeWidth={2.2} />
                Make clips
              </Link>
              <Link to="/live" className="btn btn-lg btn-hero-ghost">
                <Radio size={16} strokeWidth={2.2} />
                Record a live stream
              </Link>
            </div>
            <div className="hero-meta">
              <span>
                <Upload size={12} /> Files stay on this laptop
              </span>
              <span>
                <Gauge size={12} /> Gemini optional
              </span>
              <span>
                <Wand2 size={12} /> Smart reframe + hooks
              </span>
            </div>
          </div>
          <div className="hero-reel" aria-label="Recent clips">
            {ready.slice(0, 3).map((entry, index) => (
              <button
                key={entry.clip.id}
                className="hero-frame"
                onClick={() => navigate(`/project/${entry.clip.projectId}?clip=${entry.clip.id}`)}
                type="button"
                aria-label={`Open ${entry.clip.title}`}
              >
                {mediaUrl(entry.clip.files.thumb) ? (
                  <img src={mediaUrl(entry.clip.files.thumb)} alt="" loading="lazy" />
                ) : (
                  <span className="hero-frame-empty">
                    <Play size={18} />
                  </span>
                )}
                <span className="hero-frame-score">{Math.round(entry.clip.score)}</span>
                <span className="hero-frame-time">
                  <span>#{String(entry.clip.index + 1).padStart(2, '0')} · {clock(entry.clip.duration)}</span>
                  <i />
                </span>
                {index === 2 ? <span className="hero-frame-score" style={{ left: 'auto', right: 6, background: 'rgba(124,58,237,.8)' }}>READY</span> : null}
              </button>
            ))}
            {!ready.length && !loading
              ? [0, 1, 2].map((index) => (
                  <span key={index} className="hero-frame">
                    <span className="hero-frame-empty">
                      <Film size={20} />
                    </span>
                    <span className="hero-frame-time">
                      <span>Your clip reel</span>
                      <i />
                    </span>
                  </span>
                ))
              : null}
          </div>
        </div>
        <div className="hero-foot">
          <span>
            <strong>No account. No cloud.</strong> Everything is processed by the engine on this laptop.
          </span>
          <span>Local engine {bootstrap?.version ? `v${bootstrap.version}` : ''}</span>
        </div>
      </section>

      <section className="ledger" aria-label="Studio totals">
        <div className="ledger-item">
          <span className="ledger-label">
            <Film size={12} /> Ready clips
          </span>
          <div className="ledger-value">{loading ? '—' : ready.length}</div>
          <div className="ledger-note">{loading ? 'loading library' : `${ready.filter((entry) => entry.clip.starred).length} starred for later`}</div>
        </div>
        <div className="ledger-item">
          <span className="ledger-label">
            <CalendarDays size={12} /> This week
          </span>
          <div className="ledger-value">{loading ? '—' : thisWeek.length}</div>
          <div className="ledger-note">{thisWeek.length ? `Last made ${timeAgo(thisWeek[0]?.clip.createdAt)}` : 'No clips made yet'}</div>
        </div>
        <div className="ledger-item">
          <span className="ledger-label">
            <Timer size={12} /> Talk time cut
          </span>
          <div className="ledger-value">
            {loading ? '—' : minutes >= 10 ? Math.round(minutes) : minutes.toFixed(1)}
            <small> min</small>
          </div>
          <div className="ledger-note">
            {settings ? (settings.defaultClipCount === AUTO_CLIP_COUNT ? 'Auto clips per source by default' : `${settings.defaultClipCount} clips per source by default`) : 'Clip length is up to you'}
          </div>
        </div>
        <div className="ledger-item">
          <span className="ledger-label">
            <Sparkles size={12} /> Gemini today
          </span>
          <div className="ledger-value">
            {loading ? '—' : usage?.requests ?? 0}
            <small> / {limit}</small>
          </div>
          <div className="ledger-note">
            {system?.gemini.configured ? `${usage?.cachedHits ?? 0} cached · ${usage?.failures ?? 0} fallbacks` : 'Key not configured — local mode only'}
          </div>
        </div>
      </section>

      {data?.studio ? (
        <div className="local-shelf">
          <span className="local-shelf-icon">
            <HardDrive size={13} />
          </span>
          <span className="local-shelf-copy">
            <strong>Saved on this laptop.</strong> Projects, clips, captions and these counters live in{' '}
            <code title={data.studio.dataDir}>{data.studio.dataDir.split(/[\\/]/).filter(Boolean).pop() || 'data'}/</code>{' '}
            — nothing syncs to a cloud.
          </span>
          <span className="local-shelf-stats">
            {plural(data.studio.stats.projectsCreated, 'project')} made ·{' '}
            {plural(data.studio.stats.clipsPlanned, 'clip')} planned all-time ·{' '}
            {Math.round(data.studio.stats.secondsRendered / 60)} min rendered
          </span>
          <span className="local-shelf-time">
            <Clock3 size={11} /> ledger saved {timeAgo(data.studio.stats.updatedAt)}
          </span>
        </div>
      ) : null}

      <div className="dash-columns">
        <div>
          <div className="section-head">
            <div>
              <h2 className="section-title">Recent clips</h2>
              <p className="section-sub">Finished, captioned, ready to post.</p>
            </div>
            <Link to="/library" className="text-link">
              Open library <ArrowRight size={13} />
            </Link>
          </div>
          {loading ? (
            <div className="recent-grid">
              {[0, 1, 2, 3].map((index) => (
                <div key={index}>
                  <Skeleton className="skeleton-frame" />
                  <Skeleton style={{ height: 13, marginTop: 10, width: '82%' }} />
                  <Skeleton style={{ height: 10, marginTop: 6, width: '46%' }} />
                </div>
              ))}
            </div>
          ) : ready.length ? (
            <div className="recent-grid">
              {ready.slice(0, 4).map((entry) => (
                <ClipCard
                  key={entry.clip.id}
                  clip={entry.clip}
                  projectTitle={entry.project.title}
                  onOpen={(clip) => navigate(`/project/${clip.projectId}?clip=${clip.id}`)}
                  onStar={starClip}
                />
              ))}
            </div>
          ) : (
            <EmptyState
              icon={Sparkles}
              title="Your clip reel is empty"
              body="Paste a Kick, Twitch or YouTube link on New clips, or drop a file. The first render takes a few minutes."
              action={
                <Link to="/new" className="btn btn-primary btn-sm">
                  <Plus size={14} /> Make your first clips
                </Link>
              }
            />
          )}

          <div className="section-head">
            <div>
              <h2 className="section-title">How the cut is made</h2>
              <p className="section-sub">Everything below happens locally, in order.</p>
            </div>
          </div>
          <div className="panel">
            <div className="panel-body">
              <div className="how-list">
                <div className="how-item">
                  <span className="how-num">1</span>
                  <div className="how-copy">
                    <strong>Listen for the moment</strong>
                    Speech is transcribed with word timestamps, then scored for hooks, emotion, payoff and self-contained stories. Live audio and chat heat are folded in.
                  </div>
                </div>
                <div className="how-item">
                  <span className="how-num">2</span>
                  <div className="how-copy">
                    <strong>Cut, frame and caption</strong>
                    Faces are tracked at 2 fps and the crop follows the speaker. Captions are timed word by word, with the hook card rendered above.
                  </div>
                </div>
                <div className="how-item">
                  <span className="how-num">3</span>
                  <div className="how-copy">
                    <strong>Post without opening an editor</strong>
                    Download each clip, export the whole set as a zip, or copy a posting kit with the title, caption, hashtags and campaign rules.
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <aside className="dash-rail">
          <Panel
            title="In the works"
            action={
              <Link to="/new" className="text-link">
                New <Plus size={12} />
              </Link>
            }
            bodyClassName="panel-body"
          >
            {loading ? (
              <div className="stack" style={{ gap: 12 }}>
                {[0, 1, 2].map((index) => (
                  <Skeleton key={index} style={{ height: 48 }} />
                ))}
              </div>
            ) : projects.length ? (
              <div className="project-list">
                {projects.slice(0, 4).map((project) => (
                  <div key={project.id} className="project-row">
                    <button className="project-row-thumb" onClick={() => navigate(`/project/${project.id}`)} type="button">
                      {mediaUrl(project.thumbnailPath) ? (
                        <img src={mediaUrl(project.thumbnailPath)} alt="" style={{ width: '100%', aspectRatio: '16/10', objectFit: 'cover' }} loading="lazy" />
                      ) : (
                        <span className="poster-fallback" style={{ aspectRatio: '16/10' }}>
                          <Film size={14} />
                        </span>
                      )}
                    </button>
                    <div className="project-row-main">
                      <button className="project-row-title" onClick={() => navigate(`/project/${project.id}`)} type="button">
                        {project.title}
                      </button>
                      <div className="project-row-meta">
                        <StatusChip status={project.status} />
                        <span>{project.status === 'ready' ? `${project.readyClips} clips` : project.message}</span>
                      </div>
                      {project.status !== 'ready' && project.status !== 'failed' ? (
                        <div className="project-row-progress">
                          <ProgressBar value={project.progress} />
                        </div>
                      ) : null}
                    </div>
                    <div className="project-row-side">
                      <span className="project-row-count">
                        {project.readyClips}
                        <span>/{project.clipCount || project.readyClips}</span>
                      </span>
                      <ArrowRight size={13} color="var(--muted-2)" />
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <EmptyState
                icon={Wand2}
                title="No projects yet"
                body="Your active jobs show up here with a live progress trace."
                action={
                  <Link to="/new" className="btn btn-secondary btn-sm">
                    Start a project
                  </Link>
                }
              />
            )}
            {activeProjects.length ? (
              <div className="tool-note" style={{ marginTop: 14 }}>
                <Cpu size={14} />
                <span>
                  <strong>{activeProjects.length === 1 ? 'One job is' : `${activeProjects.length} jobs are`} running.</strong> Rendering uses local ffmpeg; you can keep browsing.
                </span>
              </div>
            ) : null}
          </Panel>

          <Panel title="Quick import" eyebrow="From a link" bodyClassName="panel-body">
            <div className="quick-import">
              <div className="quick-import-row">
                <Input
                  value={quickUrl}
                  onChange={(event) => setQuickUrl(event.target.value)}
                  placeholder="Twitch, Kick, YouTube, X…"
                  aria-label="Video link"
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') openQuickImport();
                  }}
                />
                <Button size="sm" icon={Link2} onClick={openQuickImport} aria-label="Open in New clips">
                  Open
                </Button>
              </div>
              <p className="quick-import-note">
                <Upload size={11} /> Review caption style and clip count before it starts.
              </p>
            </div>
          </Panel>

          {campaign ? (
            <div className="campaign-strip">
              <div className="campaign-strip-top">
                <span className="campaign-strip-mark" style={{ background: campaign.color }}>
                  {campaign.brand.slice(0, 2).toUpperCase()}
                </span>
                <div>
                  <p className="campaign-strip-title">{campaign.name}</p>
                  <p className="campaign-strip-sub">
                    {campaign.brand} · {campaignSubmissions.length} submission{campaignSubmissions.length === 1 ? '' : 's'}
                  </p>
                </div>
                <Badge tone={campaign.status === 'active' ? 'green' : 'neutral'} style={{ marginLeft: 'auto' }}>
                  {campaign.status}
                </Badge>
              </div>
              <p>{campaign.rules.cta || 'Clip the brand, post it, and track the payout in one place.'}</p>
              <div className="campaign-strip-foot">
                <span className="campaign-strip-value">
                  ${earned.toFixed(0)}
                  <span> tracked</span>
                </span>
                <Link to="/campaigns" className="btn btn-secondary btn-sm">
                  Open
                </Link>
              </div>
            </div>
          ) : (
            <div className="campaign-strip">
              <div className="campaign-strip-top">
                <span className="campaign-strip-mark" style={{ background: 'var(--violet-600)' }}>
                  <CircleDollarSign size={15} />
                </span>
                <div>
                  <p className="campaign-strip-title">Clipping campaigns</p>
                  <p className="campaign-strip-sub">Track rules and payouts</p>
                </div>
              </div>
              <p>Add the campaigns you clip for, enforce their rules, and log every post you make.</p>
              <div className="campaign-strip-foot">
                <Link to="/campaigns" className="btn btn-secondary btn-sm">
                  Add a campaign
                </Link>
              </div>
            </div>
          )}

          <Panel title="Studio status" action={<Link to="/settings" className="text-link">Settings</Link>}>
            <div className="signal-list">
              <div className="signal-row">
                <span className="signal-icon">
                  <Cpu size={12} />
                </span>
                Video engine
                <span>{system?.binaries.ffmpeg.status === 'ready' ? 'Ready' : 'Missing'}</span>
              </div>
              <div className="signal-row">
                <span className="signal-icon">
                  <Clock3 size={12} />
                </span>
                Speech to text
                <span>{system?.binaries.whisperModel.status === 'ready' ? 'base.en ready' : 'Not ready'}</span>
              </div>
              <div className="signal-row">
                <span className="signal-icon">
                  <Sparkles size={12} />
                </span>
                Editorial AI
                <span>{system?.gemini.configured ? 'Gemini linked' : 'Local only'}</span>
              </div>
              <div className="signal-row">
                <span className="signal-icon">
                  <Film size={12} />
                </span>
                Free disk
                <span>{system ? bytes(system.storage.freeBytes) : '—'}</span>
              </div>
            </div>
          </Panel>
        </aside>
      </div>
    </>
  );
}
