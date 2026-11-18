import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  AlertTriangle,
  ArrowLeft,
  ArrowUpRight,
  Captions,
  Check,
  Clock3,
  Download,
  Film,
  FolderOpen,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Sparkles,
  Square,
  Trash2,
  Wand2,
  X,
} from 'lucide-react';
import type {
  ClipPresetVisual,
  ClipRecord,
  ClipSettings,
  HookStyleId,
  Project,
  ReframeMode,
  SubtitleCue,
} from '@shared/types';
import { CAPTION_BY_ID, CAPTION_PRESETS, HOOK_STYLES } from '@shared/presets';
import { cuesFromWords } from '@shared/utils';
import { api, mediaUrl, type ClipPatch } from '@web/lib/api';
import { clock, shortDate, timeAgo } from '@web/lib/format';
import { useAsyncData } from '@web/lib/hooks';
import { useApp } from '@web/state/AppContext';
import {
  Badge,
  Button,
  CopyButton,
  EmptyState,
  Field,
  IconButton,
  Input,
  Modal,
  Panel,
  ProgressBar,
  Range,
  ScoreBadge,
  Segmented,
  Select,
  Skeleton,
  Spinner,
  cx,
} from '@web/components/ui';
import {
  ClipCard,
  ClipStagePreview,
  Pipeline,
  ProjectPoster,
  StageTimecode,
  StatusChip,
  VideoFrame,
} from '@web/components/media';

const ASPECT_CSS: Record<string, string> = {
  '9:16': '9 / 16',
  '1:1': '1 / 1',
  '16:9': '16 / 9',
};

const HOOK_PREVIEW: Record<HookStyleId, string> = {
  white: 'Wait for the end 😳',
  black: 'This has to be fake 😳',
  purple: 'He never saw it coming 😳',
  none: '',
};

function logTime(iso: string): string {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return '—';
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function isActive(project: Project): boolean {
  return !['ready', 'failed', 'cancelled'].includes(project.status);
}

export default function ProjectPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const { notify, confirm } = useApp();

  const load = useCallback(() => api.project(id), [id]);
  const { data: project, loading, error, reload } = useAsyncData<Project>(load, {
    deps: [id],
    events: ['project.updated', 'project.progress', 'project.log', 'clip.updated'],
    delay: 800,
  });

  const [editorId, setEditorId] = useState<string | null>(params.get('clip'));
  const [kitClip, setKitClip] = useState<ClipRecord | null>(null);
  const [kitText, setKitText] = useState('');
  const [kitLoading, setKitLoading] = useState(false);
  const [replanOpen, setReplanOpen] = useState(false);
  const [replanCount, setReplanCount] = useState(5);
  const [replanAi, setReplanAi] = useState<ClipSettings['aiMode']>('smart');
  const [replanBusy, setReplanBusy] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);

  useEffect(() => {
    setEditorId(params.get('clip'));
    // The query param is the external source of truth when it changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.get('clip')]);

  const openEditor = (clip: ClipRecord) => {
    setEditorId(clip.id);
    const next = new URLSearchParams(params);
    next.set('clip', clip.id);
    setParams(next, { replace: true });
  };

  const closeEditor = () => {
    setEditorId(null);
    const next = new URLSearchParams(params);
    next.delete('clip');
    setParams(next, { replace: true });
  };

  const openKit = async (clip: ClipRecord) => {
    setKitClip(clip);
    setKitText('');
    setKitLoading(true);
    try {
      const data = await api.libraryKit(clip.id);
      setKitText(data.kit);
    } catch (cause) {
      notify({ tone: 'error', title: 'Could not build the posting kit', message: (cause as Error).message });
      setKitClip(null);
    } finally {
      setKitLoading(false);
    }
  };

  const toggleStar = async (clip: ClipRecord) => {
    try {
      await api.updateClip(id, clip.id, { starred: !clip.starred });
      notify({
        tone: 'success',
        title: clip.starred ? 'Star removed' : 'Kept for later',
        message: clip.title,
      });
      void reload(true);
    } catch (cause) {
      notify({ tone: 'error', title: 'Could not update the clip', message: (cause as Error).message });
    }
  };

  const exportAll = () => {
    if (!project) return;
    window.location.href = api.exportUrl(project.id);
  };

  const cancel = async () => {
    if (!project) return;
    const ok = await confirm({
      title: 'Stop this job?',
      body: 'The project keeps any clips already finished, but the current stage will stop.',
      confirmLabel: 'Stop the job',
      cancelLabel: 'Let it run',
    });
    if (!ok) return;
    setBusyAction('cancel');
    try {
      await api.cancelProject(project.id);
      notify({ tone: 'info', title: 'Job cancelled', message: 'Finished clips are still available.' });
      void reload(true);
    } catch (cause) {
      notify({ tone: 'error', title: 'Could not cancel', message: (cause as Error).message });
    } finally {
      setBusyAction(null);
    }
  };

  const retry = async () => {
    if (!project) return;
    setBusyAction('retry');
    try {
      await api.retryProject(project.id);
      notify({ tone: 'info', title: 'Retrying the project', message: 'Picking up from the last good stage.' });
      void reload(true);
    } catch (cause) {
      notify({ tone: 'error', title: 'Could not retry', message: (cause as Error).message });
    } finally {
      setBusyAction(null);
    }
  };

  const removeProject = async () => {
    if (!project) return;
    const ok = await confirm({
      title: 'Delete this project?',
      body: 'The source video, every clip and all captions will be removed from this laptop. This cannot be undone.',
      confirmLabel: 'Delete project',
    });
    if (!ok) return;
    setBusyAction('delete');
    try {
      await api.deleteProject(project.id);
      notify({ tone: 'info', title: 'Project deleted' });
      navigate('/library');
    } catch (cause) {
      notify({ tone: 'error', title: 'Could not delete the project', message: (cause as Error).message });
      setBusyAction(null);
    }
  };

  const retryClip = async (clip: ClipRecord) => {
    try {
      await api.renderClip(id, clip.id);
      notify({ tone: 'info', title: 'Re-queued the clip', message: clip.title });
      void reload(true);
    } catch (cause) {
      notify({ tone: 'error', title: 'Could not re-render the clip', message: (cause as Error).message });
    }
  };

  const deleteClip = async (clip: ClipRecord) => {
    const ok = await confirm({
      title: 'Delete this clip?',
      body: 'The rendered file, captions and thumbnail will be removed. You can replan the project for new moments.',
      confirmLabel: 'Delete clip',
    });
    if (!ok) return;
    try {
      await api.deleteClip(id, clip.id);
      if (editorId === clip.id) closeEditor();
      notify({ tone: 'info', title: 'Clip deleted' });
      void reload(true);
    } catch (cause) {
      notify({ tone: 'error', title: 'Could not delete the clip', message: (cause as Error).message });
    }
  };

  const openReplan = () => {
    if (!project) return;
    setReplanCount(project.settings.clipCount);
    setReplanAi(project.settings.aiMode);
    setReplanOpen(true);
  };

  const submitReplan = async () => {
    if (!project || replanBusy) return;
    setReplanBusy(true);
    try {
      await api.replanProject(project.id, { clipCount: replanCount, aiMode: replanAi });
      setReplanOpen(false);
      notify({ tone: 'success', title: 'Finding new moments', message: `${replanCount} clips this time.` });
      void reload(true);
    } catch (cause) {
      notify({ tone: 'error', title: 'Could not replan', message: (cause as Error).message });
    } finally {
      setReplanBusy(false);
    }
  };

  const editorClip = useMemo(
    () => project?.clips.find((clip) => clip.id === editorId) ?? null,
    [project?.clips, editorId],
  );

  const readyClips = project?.clips.filter((clip) => clip.status === 'ready') ?? [];
  const totalWords = project?.stats?.words ?? 0;
  const campaignName = project?.campaignId ? 'Campaign linked' : 'Personal clips';

  if (loading && !project) {
    return (
      <>
        <div className="back-link">
          <ArrowLeft size={13} /> Back to library
        </div>
        <Skeleton style={{ height: 172, borderRadius: 22 }} />
        <Skeleton style={{ height: 84, marginTop: 14, borderRadius: 16 }} />
        <div className="clips-grid" style={{ marginTop: 28 }}>
          {[0, 1, 2, 3].map((index) => (
            <Skeleton key={index} style={{ aspectRatio: '9 / 16', height: 'auto' }} />
          ))}
        </div>
      </>
    );
  }

  if (!project) {
    return (
      <EmptyState
        icon={FolderOpen}
        title={error || 'That project could not be opened'}
        body="It may have been deleted. The library still has every clip you have finished."
        action={
          <div style={{ display: 'flex', gap: 8 }}>
            <Button variant="secondary" onClick={() => void reload()}>
              Try again
            </Button>
            <Link to="/library" className="btn btn-primary btn-sm">
              Open library
            </Link>
          </div>
        }
      />
    );
  }

  return (
    <>
      <Link to="/library" className="back-link">
        <ArrowLeft size={13} /> Back to library
      </Link>

      <section className="project-hero">
        <div className="project-cover">
          {project.thumbnailPath ? (
            <ProjectPoster src={mediaUrl(project.thumbnailPath)} alt={project.title} ratio="16 / 9" />
          ) : (
            <ProjectPoster alt={project.title} ratio="16 / 9" />
          )}
          <span className="project-cover-time">{clock(project.duration)}</span>
        </div>
        <div className="project-hero-main">
          <div className="project-kicker">
            <StatusChip status={project.status} />
            <Badge tone="neutral">{campaignName}</Badge>
            {project.settings.aiMode !== 'off' && project.stats?.analysisEngine?.includes('gemini') ? (
              <Badge tone="lilac">
                <Sparkles size={10} /> Geminian pass
              </Badge>
            ) : null}
          </div>
          <h1 className="project-title">{project.title}</h1>
          <div className="project-sub">
            <span>{project.channel || 'Local source'}</span>
            <span className="project-sub-sep" />
            <span>{project.platform}</span>
            <span className="project-sub-sep" />
            <span>{shortDate(project.createdAt)}</span>
            {project.sourceUrl ? (
              <>
                <span className="project-sub-sep" />
                <a href={project.sourceUrl} target="_blank" rel="noreferrer" className="text-link">
                  Source <ArrowUpRight size={11} />
                </a>
              </>
            ) : null}
          </div>
          <div className="project-stats-row">
            <div className="project-stat">
              <span>Source</span>
              <strong>{clock(project.duration)}</strong>
            </div>
            <div className="project-stat">
              <span>Clips ready</span>
              <strong>
                {readyClips.length}/{project.clips.length || project.settings.clipCount}
              </strong>
            </div>
            <div className="project-stat">
              <span>Words heard</span>
              <strong>{totalWords.toLocaleString()}</strong>
            </div>
            <div className="project-stat">
              <span>Gemini calls</span>
              <strong>{project.stats?.geminiCalls ?? 0}</strong>
            </div>
          </div>
        </div>
        <div className="project-hero-actions">
          <Button
            variant="primary"
            icon={Download}
            disabled={!readyClips.length}
            onClick={exportAll}
            title={readyClips.length ? 'Download every clip as a zip' : 'Nothing finished yet'}
          >
            Export {readyClips.length ? `${readyClips.length} clip${readyClips.length === 1 ? '' : 's'}` : 'clips'}
          </Button>
          <Button variant="secondary" icon={Wand2} onClick={openReplan} disabled={isActive(project)}>
            Find new moments
          </Button>
          {project.status === 'failed' || project.status === 'cancelled' ? (
            <Button variant="secondary" icon={RefreshCw} loading={busyAction === 'retry'} onClick={() => void retry()}>
              Retry project
            </Button>
          ) : null}
          {isActive(project) ? (
            <Button variant="ghost" icon={Square} loading={busyAction === 'cancel'} onClick={() => void cancel()}>
              Stop job
            </Button>
          ) : null}
        </div>
      </section>

      <div className="project-pipeline-panel">
        <Pipeline
          status={project.status}
          stage={project.stage}
          progress={project.progress}
          message={project.message}
        />
      </div>

      {project.error ? (
        <div className="project-alert">
          <AlertTriangle size={16} />
          <div>
            <strong>The engine stopped early</strong>
            {project.error}
            {project.status === 'failed' ? ' You can retry from the button above; finished clips are kept.' : ''}
          </div>
        </div>
      ) : null}

      <div className="section-head">
        <div>
          <h2 className="section-title">
            Clips <span style={{ color: 'var(--muted-2)', fontWeight: 500 }}>{project.clips.length}</span>
          </h2>
          <p className="section-sub">
            {readyClips.length
              ? `${readyClips.length} ready to post · ${project.settings.aspect} · ${project.settings.captionPreset}`
              : 'The first cut appears here as soon as it is planned.'}
          </p>
        </div>
        <div className="clips-toolbar">
          <Badge tone={project.settings.quality === 'high' ? 'violet' : 'neutral'}>
            {project.settings.quality} render
          </Badge>
          <Badge tone="neutral">{project.settings.aspect}</Badge>
          {isActive(project) ? (
            <Badge tone="violet" dot>
              working
            </Badge>
          ) : null}
          <Button
            variant="secondary"
            size="sm"
            icon={Download}
            disabled={!readyClips.length}
            onClick={exportAll}
          >
            Zip all
          </Button>
        </div>
      </div>

      {project.clips.length ? (
        <div className="clips-grid">
          {project.clips.map((clip) => {
            if (clip.status === 'ready') {
              return (
                <ClipCard
                  key={clip.id}
                  clip={clip}
                  projectTitle={project.title}
                  onOpen={openEditor}
                  onStar={(item) => void toggleStar(item)}
                  onDownload={(item) =>
                    window.open(api.clipDownloadUrl(project.id, item.id), '_blank', 'noopener')
                  }
                  onKit={(item) => void openKit(item)}
                  actions={
                    <IconButton
                      icon={Pencil}
                      label="Edit clip"
                      className="mini-action"
                      onClick={() => openEditor(clip)}
                    />
                  }
                />
              );
            }
            const rendering = clip.status === 'rendering';
            const failed = clip.status === 'failed' || clip.status === 'cancelled';
            return (
              <div key={clip.id} className="render-card">
                <div className="render-card-top">
                  <Badge tone={failed ? 'red' : rendering ? 'violet' : 'neutral'}>
                    #{String(clip.index + 1).padStart(2, '0')}
                  </Badge>
                  {!failed ? <ScoreBadge score={clip.score} compact /> : <Badge tone="red">failed</Badge>}
                </div>
                <div className="render-card-mid">
                  <span className="render-card-icon">
                    {failed ? <AlertTriangle size={19} /> : rendering ? <Spinner size={19} /> : <Clock3 size={19} />}
                  </span>
                  <p className="render-card-title">{clip.title || clip.hook || 'Untitled moment'}</p>
                  <span className="render-card-stage">
                    {failed
                      ? clip.error || 'The render did not finish.'
                      : rendering
                        ? `${clip.stage} · ${Math.round(clip.progress)}%`
                        : 'Waiting in the render queue'}
                  </span>
                  {rendering ? <ProgressBar value={clip.progress} animated /> : null}
                  {failed ? (
                    <Button size="sm" variant="secondary" icon={RotateCcw} onClick={() => void retryClip(clip)}>
                      Retry clip
                    </Button>
                  ) : null}
                </div>
                <div className="render-card-foot">
                  <StageTimecode start={clip.start} end={clip.end} />
                  <span>{clock(clip.duration)}</span>
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <EmptyState
          icon={Film}
          title={isActive(project) ? 'Reading the room…' : 'No clips were planned'}
          body={
            isActive(project)
              ? 'Speech is being transcribed and scored. Moments show up here as soon as they are chosen.'
              : 'Try replanning with a longer maximum duration or local-only analysis.'
          }
          action={
            !isActive(project) ? (
              <div style={{ display: 'flex', gap: 8 }}>
                <Button variant="secondary" onClick={openReplan} icon={Wand2}>
                  Replan the cut
                </Button>
                {project.status !== 'ready' ? (
                  <Button onClick={() => void retry()} icon={RefreshCw}>
                    Retry project
                  </Button>
                ) : null}
              </div>
            ) : undefined
          }
        />
      )}

      <div className="project-bottom-grid">
        <Panel
          title="Engine trace"
          eyebrow="What the local pipeline did"
          action={<Badge tone="neutral">{project.logs.length} events</Badge>}
        >
          {project.logs.length ? (
            <div className="log-list">
              {project.logs.slice(-140).map((entry, index) => (
                <div key={`${entry.t}-${index}`} className={cx('log-row', `is-${entry.level}`)}>
                  <span className="log-time">{logTime(entry.t)}</span>
                  <span className="log-mark" />
                  <span>{entry.message}</span>
                </div>
              ))}
            </div>
          ) : (
            <p className="field-help">No trace yet — the engine has not started on this project.</p>
          )}
        </Panel>

        <Panel title="Project facts" eyebrow="Source and look">
          <div className="fact-list">
            <div className="fact-row">
              <span className="fact-label">Platform</span>
              <span className="fact-value">{project.platform}</span>
            </div>
            <div className="fact-row">
              <span className="fact-label">Source kind</span>
              <span className="fact-value">{project.sourceKind}</span>
            </div>
            <div className="fact-row">
              <span className="fact-label">Duration</span>
              <span className="fact-value">{clock(project.duration)}</span>
            </div>
            <div className="fact-row">
              <span className="fact-label">Resolution</span>
              <span className="fact-value">
                {project.width && project.height ? `${project.width}×${project.height}` : '—'}
              </span>
            </div>
            <div className="fact-row">
              <span className="fact-label">Frame rate</span>
              <span className="fact-value">{project.fps ? `${project.fps.toFixed(2)} fps` : '—'}</span>
            </div>
            <div className="fact-row">
              <span className="fact-label">Caption look</span>
              <span className="fact-value">{CAPTION_BY_ID[project.settings.captionPreset]?.name ?? project.settings.captionPreset}</span>
            </div>
            <div className="fact-row">
              <span className="fact-label">Reframing</span>
              <span className="fact-value">{project.settings.reframe}</span>
            </div>
            <div className="fact-row">
              <span className="fact-label">Speech model</span>
              <span className="fact-value">{project.settings.asrModel}</span>
            </div>
            <div className="fact-row">
              <span className="fact-label">Cached Gemini</span>
              <span className="fact-value">{project.stats?.cachedCalls ?? 0}</span>
            </div>
            <div className="fact-row">
              <span className="fact-label">Updated</span>
              <span className="fact-value">{timeAgo(project.updatedAt)}</span>
            </div>
          </div>
          {project.stats?.finishedAt ? (
            <div className="tool-note" style={{ marginTop: 12 }}>
              <Check size={14} />
              <span>
                <strong>Pipeline finished.</strong> Speech, scoring and rendering wrapped in{' '}
                {Math.max(
                  1,
                  Math.round(
                    (new Date(project.stats.finishedAt).getTime() - new Date(project.stats.startedAt).getTime()) /
                      60_000,
                  ),
                )}{' '}
                min of local wall time.
              </span>
            </div>
          ) : null}
        </Panel>
      </div>

      <div className="project-danger">
        <div>
          <strong>Remove this project</strong>
          <p>Deletes the source, all {project.clips.length} clips, captions and thumbnails from this laptop.</p>
        </div>
        <Button variant="danger" size="sm" icon={Trash2} loading={busyAction === 'delete'} onClick={() => void removeProject()}>
          Delete project
        </Button>
      </div>

      {editorClip ? (
        <ClipEditor
          key={editorClip.id}
          project={project}
          clip={editorClip}
          onClose={closeEditor}
          onChanged={() => void reload(true)}
          onToast={notify}
          onDelete={() => void deleteClip(editorClip)}
        />
      ) : null}

      <Modal
        open={Boolean(kitClip)}
        onClose={() => setKitClip(null)}
        size="md"
        labelledBy="kit-title"
      >
        {kitClip ? (
          <>
            <div className="kit-head">
              <div className="kit-thumb">
                <ProjectPoster src={mediaUrl(kitClip.files.thumb)} alt="" ratio="9 / 16" />
              </div>
              <div className="kit-copy">
                <h3 id="kit-title">Posting kit</h3>
                <p>{kitClip.title}</p>
                <div style={{ display: 'flex', gap: 5, marginTop: 6, flexWrap: 'wrap' }}>
                  <Badge tone="violet">{clock(kitClip.duration)}</Badge>
                  <Badge tone="green" dot>
                    ready
                  </Badge>
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
                  <Button variant="secondary" onClick={() => setKitClip(null)}>
                    Close
                  </Button>
                  <CopyButton text={kitText} label="Copy the kit" variant="primary" />
                </div>
              </>
            )}
          </>
        ) : null}
      </Modal>

      <Modal
        open={replanOpen}
        onClose={() => setReplanOpen(false)}
        size="md"
        labelledBy="replan-title"
      >
        <h2 id="replan-title" className="modal-title">
          Find different moments
        </h2>
        <p className="modal-subtitle">
          TeraClip keeps the source and caption look, re-reads the transcript, and replaces this clip set with a fresh
          selection. Nothing is re-downloaded.
        </p>
        <div style={{ display: 'grid', gap: 16, marginTop: 20 }}>
          <Field label="How many clips?" hint={`${replanCount} of 10`}>
            <Select value={String(replanCount)} onChange={(value) => setReplanCount(Number(value))}>
              {Array.from({ length: 10 }, (_, index) => index + 1).map((count) => (
                <option key={count} value={count}>
                  {count} clip{count === 1 ? '' : 's'}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Editorial pass" hint="Gemini only shapes the winners">
            <Segmented
              className="segmented-wide"
              value={replanAi}
              onChange={(value) => setReplanAi(value as ClipSettings['aiMode'])}
              options={[
                { value: 'smart', label: 'Smart' },
                { value: 'full', label: 'Full review' },
                { value: 'off', label: 'Local only' },
              ]}
            />
          </Field>
        </div>
        <div className="modal-actions">
          <Button variant="secondary" onClick={() => setReplanOpen(false)}>
            Keep these clips
          </Button>
          <Button icon={Wand2} loading={replanBusy} onClick={() => void submitReplan()}>
            Replan {replanCount} clips
          </Button>
        </div>
      </Modal>
    </>
  );
}

interface EditorProps {
  project: Project;
  clip: ClipRecord;
  onClose: () => void;
  onChanged: () => void;
  onToast: ReturnType<typeof useApp>['notify'];
  onDelete: () => void;
}

interface EditorForm {
  title: string;
  hook: string;
  caption: string;
  hashtags: string[];
  captionPreset: ClipRecord['captionPreset'];
  captionScale: number;
  hookStyle: ClipRecord['hookStyle'];
  framing: ReframeMode;
  subtitles: SubtitleCue[];
  start: number;
  end: number;
}

function ClipEditor({ project, clip, onClose, onChanged, onToast, onDelete }: EditorProps) {
  const initialSubtitles = useMemo<SubtitleCue[]>(
    () =>
      clip.subtitles?.length
        ? clip.subtitles.map((cue) => ({ ...cue }))
        : cuesFromWords(clip.words, clip.duration),
    [clip.id, clip.updatedAt],
  );
  const [form, setForm] = useState<EditorForm>(() => ({
    title: clip.title,
    hook: clip.hook,
    caption: clip.caption,
    hashtags: clip.hashtags,
    captionPreset: clip.captionPreset,
    captionScale: clip.captionScale ?? project.settings.captionScale ?? 1,
    hookStyle: clip.hookStyle,
    framing: clip.framing,
    subtitles: initialSubtitles.map((cue) => ({ ...cue })),
    start: Math.round(clip.start * 10) / 10,
    end: Math.round(clip.end * 10) / 10,
  }));
  const [tagDraft, setTagDraft] = useState('');
  const [view, setView] = useState<'playback' | 'style'>(clip.status === 'ready' ? 'playback' : 'style');
  const [saving, setSaving] = useState(false);
  const [rendering, setRendering] = useState(false);

  const preset: ClipPresetVisual = CAPTION_BY_ID[form.captionPreset] ?? CAPTION_PRESETS[0];
  const sourcePoster = mediaUrl(clip.files.thumb);
  const videoSrc = clip.status === 'ready' ? mediaUrl(clip.files.final) : undefined;
  const aspect = ASPECT_CSS[project.settings.aspect] ?? '9 / 16';

  const set = <K extends keyof EditorForm>(key: K, value: EditorForm[K]) => {
    setForm((current) => ({ ...current, [key]: value }));
  };

  useEffect(() => {
    if (clip.status === 'rendering') setRendering(true);
    if (clip.status === 'ready' && rendering) {
      setRendering(false);
    }
  }, [clip.status, clip.progress, rendering]);

  const changes = useMemo<ClipPatch>(() => {
    const patch: ClipPatch = {};
    if (form.title !== clip.title) patch.title = form.title;
    if (form.hook !== clip.hook) patch.hook = form.hook;
    if (form.caption !== clip.caption) patch.caption = form.caption;
    if (JSON.stringify(form.hashtags) !== JSON.stringify(clip.hashtags)) patch.hashtags = form.hashtags;
    if (JSON.stringify(form.subtitles) !== JSON.stringify(initialSubtitles)) patch.subtitles = form.subtitles;
    if (form.captionPreset !== clip.captionPreset) patch.captionPreset = form.captionPreset;
    const clipScale = clip.captionScale ?? project.settings.captionScale ?? 1;
    if (Math.abs(form.captionScale - clipScale) > 0.005) patch.captionScale = form.captionScale;
    if (form.hookStyle !== clip.hookStyle) patch.hookStyle = form.hookStyle;
    if (form.framing !== clip.framing) patch.framing = form.framing;
    if (Math.abs(form.start - clip.start) > 0.05) patch.start = form.start;
    if (Math.abs(form.end - clip.end) > 0.05) patch.end = form.end;
    return patch;
  }, [form, clip]);

  const visualDirty = Boolean(
    changes.hook !== undefined ||
      changes.captionPreset !== undefined ||
      changes.captionScale !== undefined ||
      changes.subtitles !== undefined ||
      changes.hookStyle !== undefined ||
      changes.framing !== undefined ||
      changes.start !== undefined ||
      changes.end !== undefined,
  );
  const dirty = Object.keys(changes).length > 0;
  const locked = clip.status === 'rendering' || saving || rendering;
  const maxEnd = Math.max(3, Math.round(project.duration * 10) / 10);
  const editLength = Math.max(0, Math.round((form.end - form.start) * 10) / 10);

  const addTag = () => {
    const raw = tagDraft.trim().replace(/^#+/, '').replace(/\s+/g, '');
    if (!raw) return;
    if (form.hashtags.length >= 8) {
      onToast({ tone: 'error', title: 'Eight hashtags is the limit' });
      return;
    }
    if (form.hashtags.some((tag) => tag.replace(/^#/, '').toLowerCase() === raw.toLowerCase())) {
      setTagDraft('');
      return;
    }
    set('hashtags', [...form.hashtags, `#${raw}`]);
    setTagDraft('');
  };

  const cueLimit = Math.max(0.5, Math.round((form.end - form.start) * 10) / 10);
  const updateCue = (index: number, patch: Partial<SubtitleCue>) => {
    setForm((current) => {
      const limit = Math.max(0.5, Math.round((current.end - current.start) * 10) / 10);
      const subtitles = current.subtitles.map((cue, i) => {
        if (i !== index) return cue;
        const next = { ...cue, ...patch };
        const rawStart = Number(next.start);
        const rawEnd = Number(next.end);
        const start = Math.max(0, Math.min(limit - 0.2, Number.isFinite(rawStart) ? rawStart : cue.start));
        const end = Math.max(start + 0.2, Math.min(limit, Number.isFinite(rawEnd) ? rawEnd : cue.end));
        return {
          start: Math.round(start * 100) / 100,
          end: Math.round(end * 100) / 100,
          text: next.text,
        };
      });
      return { ...current, subtitles };
    });
  };
  const addCue = () => {
    const last = form.subtitles[form.subtitles.length - 1];
    const start = Math.min(Math.max(0, cueLimit - 0.5), last ? last.end : 0);
    set('subtitles', [...form.subtitles, { start, end: Math.min(cueLimit, start + 2), text: '' }]);
  };
  const resetCues = () => {
    set('subtitles', cuesFromWords(clip.words, clip.duration).map((cue) => ({ ...cue })));
  };

  const save = async () => {
    if (!dirty) {
      onClose();
      return;
    }
    if (form.end - form.start < 3) {
      onToast({ tone: 'error', title: 'The clip is too short', message: 'Keep at least 3 seconds between in and out.' });
      return;
    }
    setSaving(true);
    try {
      await api.updateClip(project.id, clip.id, changes);
      if (visualDirty) setRendering(true);
      onToast({
        tone: 'success',
        title: visualDirty ? 'Saved — re-rendering the clip' : 'Clip details updated',
        message: visualDirty ? 'New captions and frames are being burned in.' : form.title,
      });
      onChanged();
      onClose();
    } catch (cause) {
      onToast({ tone: 'error', title: 'Could not save the clip', message: (cause as Error).message });
    } finally {
      setSaving(false);
    }
  };

  const forceRender = async () => {
    setSaving(true);
    try {
      await api.renderClip(project.id, clip.id);
      setRendering(true);
      onToast({ tone: 'info', title: 'Re-rendering the clip', message: 'The finished file will update shortly.' });
      onChanged();
    } catch (cause) {
      onToast({ tone: 'error', title: 'Could not start the render', message: (cause as Error).message });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal open onClose={onClose} size="xl" className="editor-modal" labelledBy="editor-title">
      <div className="editor-head">
        <div className="editor-head-copy">
          <div className="editor-kicker">
            <span>Clip #{String(clip.index + 1).padStart(2, '0')}</span>
            <span className="project-sub-sep" />
            <StageTimecode start={form.start} end={form.end} />
            {clip.source === 'gemini' ? (
              <Badge tone="lilac">
                <Sparkles size={9} /> AI pick
              </Badge>
            ) : (
              <Badge tone="neutral">local pick</Badge>
            )}
          </div>
          <h2 className="editor-title" id="editor-title">
            {form.title || 'Untitled clip'}
          </h2>
        </div>
        <div className="editor-head-actions">
          <Button
            variant="secondary"
            size="sm"
            icon={RotateCcw}
            loading={saving}
            disabled={clip.status === 'rendering'}
            onClick={() => void forceRender()}
          >
            Re-render
          </Button>
          {clip.status === 'ready' ? (
            <a
              className="btn btn-ink btn-sm"
              href={api.clipDownloadUrl(project.id, clip.id)}
              target="_blank"
              rel="noreferrer"
            >
              <Download size={14} /> Download
            </a>
          ) : null}
        </div>
      </div>

      <div className="editor-grid">
        <div className="editor-preview">
          <Segmented
            className="segmented-wide"
            value={view}
            onChange={setView}
            options={[
              { value: 'playback', label: 'Playback', icon: Play },
              { value: 'style', label: 'Style preview', icon: Captions },
            ]}
          />
          <div className="editor-preview-stage">
            {view === 'playback' && videoSrc ? (
              <VideoFrame src={videoSrc} poster={sourcePoster} aspectRatio={aspect} controls autoPlay />
            ) : (
              <ClipStagePreview
                preset={preset}
                hook={form.hook}
                hookStyle={form.hookStyle}
                aspect={aspect}
                captionScale={form.captionScale}
              />
            )}
          </div>
          {rendering || clip.status === 'rendering' ? (
            <div className="editor-render-banner">
              <Spinner size={15} />
              <div style={{ flex: 1 }}>
                <strong>Re-rendering</strong>
                <div style={{ marginTop: 4 }}>
                  <ProgressBar value={clip.progress} animated />
                </div>
              </div>
              <span style={{ fontVariantNumeric: 'tabular-nums' }}>{Math.round(clip.progress)}%</span>
            </div>
          ) : null}
          <div className="editor-preview-meta">
            <ScoreBadge score={clip.score} />
            <Badge tone="neutral">{clock(editLength)}</Badge>
            <Badge tone="violet">{preset.name}</Badge>
            <Badge tone="neutral">{form.framing}</Badge>
          </div>
          <div className="editor-details">
            <div className="editor-detail">
              <span>Source range</span>
              <strong>
                {clock(form.start)} → {clock(form.end)}
              </strong>
            </div>
            <div className="editor-detail">
              <span>Category</span>
              <strong>{clip.category || 'moment'}</strong>
            </div>
            <div className="editor-detail">
              <span>Viral score</span>
              <strong>{Math.round(clip.score)} / 100</strong>
            </div>
            <div className="editor-detail">
              <span>Last render</span>
              <strong>{clip.renderMs ? `${(clip.renderMs / 1000).toFixed(1)}s` : '—'}</strong>
            </div>
          </div>
          {clip.reason ? (
            <div className="editor-reason">
              <strong>Why this moment:</strong> {clip.reason}
            </div>
          ) : null}
          {clip.status !== 'ready' && !rendering ? (
            <div className="tool-note">
              <AlertTriangle size={14} />
              <span>
                <strong>Not rendered yet.</strong> Saving a look will queue this clip for its first render.
              </span>
            </div>
          ) : null}
        </div>

        <div className="editor-form">
          <div className="editor-form-section">
            <div className="editor-form-title">
              Post copy <span>Title, hook, caption and tags</span>
            </div>
            <div style={{ display: 'grid', gap: 12 }}>
              <Field label="Title" hint={`${form.title.length}/120`}>
                <Input
                  value={form.title}
                  maxLength={120}
                  onChange={(event) => set('title', event.target.value)}
                  placeholder="What happens in the clip"
                />
              </Field>
              <Field label="Top hook (text on video)" hint={`${form.hook.length}/120`}>
                <Input
                  value={form.hook}
                  maxLength={120}
                  onChange={(event) => set('hook', event.target.value)}
                  placeholder="The line that stops the scroll"
                />
                <div className="emoji-row" aria-label="Add an emoji to the hook">
                  {['😳', '😭', '🔥', '🤯', '👀', '💀', '😅', '🚨', '💯', '🤣'].map((emoji) => (
                    <button
                      key={emoji}
                      type="button"
                      className="emoji-chip"
                      onClick={() => set('hook', `${form.hook.trim()} ${emoji}`.trim().slice(0, 120))}
                      title={`Add ${emoji} to the hook`}
                    >
                      {emoji}
                    </button>
                  ))}
                </div>
              </Field>
              <Field label="Caption" hint={`${form.caption.length}/240`}>
                <textarea
                  className="input"
                  value={form.caption}
                  maxLength={240}
                  rows={3}
                  onChange={(event) => set('caption', event.target.value)}
                  placeholder="The post description"
                />
              </Field>
              <Field label="Hashtags" hint="Press Enter to add · 8 max">
                <div className="tag-input-row">
                  <Input
                    value={tagDraft}
                    onChange={(event) => setTagDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ',') {
                        event.preventDefault();
                        addTag();
                      }
                    }}
                    placeholder="#shorts"
                    maxLength={40}
                  />
                  <Button variant="secondary" icon={Plus} onClick={addTag} type="button">
                    Add
                  </Button>
                </div>
                {form.hashtags.length ? (
                  <div className="tag-list">
                    {form.hashtags.map((tag) => (
                      <span key={tag} className="tag-pill">
                        {tag}
                        <button
                          type="button"
                          aria-label={`Remove ${tag}`}
                          onClick={() => set('hashtags', form.hashtags.filter((item) => item !== tag))}
                        >
                          <X size={11} />
                        </button>
                      </span>
                    ))}
                  </div>
                ) : null}
              </Field>
            </div>
          </div>

          <div className="editor-form-section">
            <div className="editor-form-title">
              Caption look <span>Burned into the video</span>
            </div>
            <div className="preset-grid">
              {CAPTION_PRESETS.map((option) => {
                const css = option.css;
                const active = form.captionPreset === option.id;
                return (
                  <button
                    key={option.id}
                    type="button"
                    className={cx('preset-option', active && 'is-active')}
                    onClick={() => set('captionPreset', option.id)}
                    aria-pressed={active}
                    title={option.tagline}
                  >
                    <span className="preset-mini">
                      <span
                        style={{
                          fontFamily: css.fontFamily,
                          fontWeight: css.fontWeight,
                          letterSpacing: css.letterSpacing,
                          textTransform: css.textTransform,
                          color: css.color,
                          background: option.box ? option.boxColor : undefined,
                          WebkitTextStroke: css.webkitTextStroke,
                          textShadow: css.textShadow,
                          borderRadius: option.box ? '5px' : undefined,
                          padding: option.box ? '3px 5px' : undefined,
                        }}
                      >
                        {option.sample}
                      </span>
                    </span>
                    <span className="preset-name">{option.name}</span>
                  </button>
                );
              })}
            </div>
            <div style={{ marginTop: 14 }}>
              <Range
                label="Caption size"
                value={Math.round(form.captionScale * 100)}
                min={60}
                max={160}
                step={5}
                suffix="%"
                onChange={(value) => set('captionScale', value / 100)}
                hint="100% is the preset default. Changing this re-renders the clip with the new size."
              />
            </div>
          </div>

          <div className="editor-form-section">
            <div className="editor-form-title">
              Subtitles <span>Editable burn-in lines</span>
            </div>
            <p className="field-help">
              Rewrite any line, fix a word or retime it. Times are relative to this clip and saving re-renders the burned captions.
            </p>
            <div className="subtitle-rows">
              {form.subtitles.map((cue, index) => (
                <div className="subtitle-row" key={`cue-${index}`}>
                  <div className="subtitle-times">
                    <input
                      className="input subtitle-time"
                      type="number"
                      min={0}
                      max={cueLimit}
                      step={0.1}
                      value={cue.start}
                      onChange={(event) => updateCue(index, { start: Number(event.target.value) })}
                      aria-label={`Subtitle ${index + 1} start`}
                    />
                    <span aria-hidden>→</span>
                    <input
                      className="input subtitle-time"
                      type="number"
                      min={0}
                      max={cueLimit}
                      step={0.1}
                      value={cue.end}
                      onChange={(event) => updateCue(index, { end: Number(event.target.value) })}
                      aria-label={`Subtitle ${index + 1} end`}
                    />
                  </div>
                  <textarea
                    className="input subtitle-text"
                    rows={2}
                    maxLength={240}
                    value={cue.text}
                    placeholder="Subtitle text"
                    onChange={(event) => updateCue(index, { text: event.target.value })}
                    aria-label={`Subtitle ${index + 1} text`}
                  />
                  <IconButton
                    icon={X}
                    label={`Remove subtitle ${index + 1}`}
                    onClick={() => set('subtitles', form.subtitles.filter((_, i) => i !== index))}
                  />
                </div>
              ))}
              {!form.subtitles.length ? (
                <p className="field-help">No subtitle lines yet. Add one, or reset from the transcript.</p>
              ) : null}
            </div>
            <div className="subtitle-actions">
              <Button variant="secondary" size="sm" icon={Plus} onClick={addCue} type="button">
                Add line
              </Button>
              <Button variant="ghost" size="sm" icon={RotateCcw} onClick={resetCues} type="button">
                Reset from transcript
              </Button>
            </div>
          </div>

          <div className="editor-form-section">
            <div className="editor-form-title">
              Hook & framing <span>Re-renders on save</span>
            </div>
            <div style={{ display: 'grid', gap: 13 }}>
              <Field label="Hook style">
                <div className="hook-options">
                  {HOOK_STYLES.map((option) => {
                    const active = form.hookStyle === option.id;
                    return (
                      <button
                        key={option.id}
                        type="button"
                        className={cx('hook-option', active && 'is-active')}
                        onClick={() => set('hookStyle', option.id)}
                        aria-pressed={active}
                      >
                        <span
                          className={cx('hook-swatch', option.id === 'none' && 'is-none')}
                          style={
                            option.id === 'none'
                              ? undefined
                              : { background: option.cardColor, color: option.textColor }
                          }
                        >
                          {option.id === 'none' ? 'OFF' : 'HOOK'}
                        </span>
                        <span className="hook-option-name">{option.name}</span>
                      </button>
                    );
                  })}
                </div>
              </Field>
              <Field label="Reframing">
                <Segmented
                  className="segmented-wide"
                  value={form.framing}
                  onChange={(value) => set('framing', value as ReframeMode)}
                  options={[
                    { value: 'smart', label: 'Smart' },
                    { value: 'split', label: 'Game + cam' },
                    { value: 'center', label: 'Center' },
                    { value: 'blur', label: 'Blur fill' },
                  ]}
                />
              </Field>
              {form.hookStyle !== 'none' ? (
                <ClipStagePreview
                  preset={preset}
                  hook={form.hook || HOOK_PREVIEW[form.hookStyle]}
                  hookStyle={form.hookStyle}
                  aspect="16 / 10"
                  compact
                  captionScale={form.captionScale}
                />
              ) : null}
            </div>
          </div>

          <div className="editor-form-section">
            <div className="editor-form-title">
              Trim <span>{clock(editLength)} selected</span>
            </div>
            <div className="editor-trim">
              <Field label="Clip in" hint={clock(form.start)}>
                <input
                  className="range"
                  type="range"
                  min={0}
                  max={Math.max(0, form.end - 3)}
                  step={0.1}
                  value={form.start}
                  onChange={(event) => {
                    const value = Number(event.target.value);
                    setForm((current) => ({ ...current, start: Math.min(value, current.end - 3) }));
                  }}
                  style={{
                    ['--range-progress' as string]: `${((form.start / Math.max(1, form.end)) * 100).toFixed(1)}%`,
                  }}
                  aria-label="Clip in point"
                />
              </Field>
              <Field label="Clip out" hint={clock(form.end)}>
                <input
                  className="range"
                  type="range"
                  min={Math.min(maxEnd, form.start + 3)}
                  max={maxEnd}
                  step={0.1}
                  value={form.end}
                  onChange={(event) => {
                    const value = Number(event.target.value);
                    setForm((current) => ({ ...current, end: Math.max(value, current.start + 3) }));
                  }}
                  style={{
                    ['--range-progress' as string]: `${Math.min(100, ((form.end - form.start) / Math.max(1, maxEnd - form.start)) * 100).toFixed(1)}%`,
                  }}
                  aria-label="Clip out point"
                />
              </Field>
            </div>
            <p className="field-help" style={{ marginTop: 8 }}>
              Source is {clock(project.duration)} long. Trimming re-aligns the word timing and tracks faces again.
            </p>
          </div>

          <div className="editor-actions">
            <div className="editor-actions-note">
              {rendering || clip.status === 'rendering' ? (
                <span>Rendering now — editing unlocks when the file is ready.</span>
              ) : dirty ? (
                visualDirty ? (
                  <span>Saving re-renders the clip with the new look.</span>
                ) : (
                  <span>Post copy only — the video does not need a re-render.</span>
                )
              ) : (
                <span>Change something to save.</span>
              )}
            </div>
            <div className="editor-actions-buttons">
              <Button
                variant="ghost"
                size="sm"
                icon={Trash2}
                onClick={onDelete}
                disabled={locked}
                title={locked ? 'Wait for the render to finish' : 'Delete this clip'}
              >
                Delete
              </Button>
              <Button variant="secondary" size="sm" onClick={onClose}>
                Close
              </Button>
              <Button
                size="sm"
                icon={visualDirty ? Wand2 : Check}
                loading={saving}
                disabled={!dirty || locked}
                onClick={() => void save()}
              >
                {visualDirty ? 'Save & re-render' : 'Save changes'}
              </Button>
            </div>
          </div>
        </div>
      </div>
    </Modal>
  );
}
