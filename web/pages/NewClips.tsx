import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import {
  ArrowRight,
  Check,
  Clock3,
  FileVideo2,
  Film,
  Link2,
  Loader2,
  MonitorPlay,
  Radio,
  RotateCcw,
  Sparkles,
  Upload,
  Wand2,
  X,
} from 'lucide-react';
import type {
  AspectRatio,
  AiMode,
  AppSettings,
  Campaign,
  ClipPresetVisual,
  ClipSettings,
  HookStyleId,
  PacingMode,
  PlatformId,
  QualityMode,
  ReframeMode,
} from '@shared/types';
import { CAPTION_BY_ID } from '@shared/presets';
import { CAPTION_PRESETS, HOOK_STYLES } from '@shared/presets';
import { api, type ResolvedImport } from '@web/lib/api';
import { bytes, clamp, clock, estimateRenderSeconds, hostOf } from '@web/lib/format';
import { useAsyncData } from '@web/lib/hooks';
import { useApp } from '@web/state/AppContext';
import {
  Badge,
  Button,
  Field,
  Input,
  Panel,
  ProgressBar,
  Range,
  Segmented,
  Select,
  Toggle,
  cx,
} from '@web/components/ui';
import { ClipStagePreview, HookCard } from '@web/components/media';

type ImportMode = 'url' | 'upload';

const VIDEO_EXTENSIONS = /\.(mp4|mov|mkv|webm|m4v|avi|ts)$/i;

const HOOK_PREVIEW: Record<HookStyleId, string> = {
  white: 'Wait for the end 😳',
  black: 'This has to be fake 😳',
  purple: 'He never saw it coming 😳',
  none: '',
};

const AI_COPY: Record<AiMode, string> = {
  smart:
    'Local scoring finds the moments. Gemini only names the best ones, so a 2-hour stream stays cheap.',
  full: 'Gemini reviews every candidate for the sharpest titles and hooks. Best quality, more requests.',
  off: 'No cloud calls at all. Speech, audio energy and heuristics do the whole edit on this laptop.',
};

function toSettings(defaults: Partial<ClipSettings> | undefined): ClipSettings {
  return {
    clipCount: clamp(defaults?.clipCount ?? 5, 1, 10),
    minDuration: clamp(defaults?.minDuration ?? 18, 5, 90),
    maxDuration: clamp(defaults?.maxDuration ?? 45, 10, 180),
    aspect: defaults?.aspect ?? '9:16',
    captionPreset: defaults?.captionPreset ?? 'tera-box',
    captionScale: defaults?.captionScale ?? 1,
    hookStyle: defaults?.hookStyle ?? 'white',
    pacing: defaults?.pacing ?? 'balanced',
    reframe: defaults?.reframe ?? 'smart',
    quality: defaults?.quality ?? 'balanced',
    aiMode: defaults?.aiMode ?? 'smart',
    asrModel: defaults?.asrModel ?? 'base.en',
    language: defaults?.language ?? 'en',
    audioEnhance: defaults?.audioEnhance ?? false,
    watermark: defaults?.watermark ?? false,
  };
}

/** Settings store project defaults under `default*` names; map them for a new project. */
function fromAppSettings(settings: AppSettings | null): Partial<ClipSettings> | undefined {
  if (!settings) return undefined;
  return {
    clipCount: settings.defaultClipCount,
    minDuration: settings.defaultMinDuration,
    maxDuration: settings.defaultMaxDuration,
    aspect: settings.defaultAspect,
    captionPreset: settings.defaultCaptionPreset,
    captionScale: settings.defaultCaptionScale,
    hookStyle: settings.defaultHookStyle,
    pacing: settings.defaultPacing,
    reframe: settings.defaultReframe,
    quality: settings.defaultQuality,
    aiMode: settings.defaultAiMode,
    asrModel: settings.defaultAsrModel,
    language: settings.asrLanguage,
    watermark: settings.watermark,
  };
}

function aspectCss(aspect: AspectRatio): string {
  return aspect.replace(':', ' / ');
}

function looksLikeVideo(file: File): boolean {
  return VIDEO_EXTENSIONS.test(file.name) || file.type.startsWith('video/');
}

export default function NewClips() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const { settings: appSettings, bootstrap, notify } = useApp();

  const initialUrl = params.get('url') || '';
  const [mode, setMode] = useState<ImportMode>(initialUrl ? 'url' : 'url');
  const [url, setUrl] = useState(initialUrl);
  const [resolved, setResolved] = useState<ResolvedImport | null>(null);
  const [resolving, setResolving] = useState(false);
  const [resolveError, setResolveError] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [settings, setSettings] = useState<ClipSettings>(() => toSettings(fromAppSettings(appSettings)));
  const [campaignId, setCampaignId] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);
  const [uploadPercent, setUploadPercent] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const urlInput = useRef<HTMLInputElement | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const autoResolved = useRef(false);

  const { data: campaignData } = useAsyncData(
    useCallback(async () => {
      const data = await api.campaigns();
      return data;
    }, []),
    {},
  );
  const campaigns = campaignData?.campaigns ?? [];

  const preset: ClipPresetVisual = CAPTION_BY_ID[settings.captionPreset] ?? CAPTION_PRESETS[0];
  const platformList = (bootstrap?.platforms ?? []).filter((platform) => platform.id !== 'upload');
  const estimated = estimateRenderSeconds({
    clipCount: settings.clipCount,
    quality: settings.quality,
    duration: resolved?.duration,
  });

  const update = useCallback(<K extends keyof ClipSettings>(key: K, value: ClipSettings[K]) => {
    setSettings((current) => ({ ...current, [key]: value }));
  }, []);

  const setMinDuration = (value: number) => {
    setSettings((current) => ({
      ...current,
      minDuration: value,
      maxDuration: Math.max(current.maxDuration, value + 5),
    }));
  };

  const setMaxDuration = (value: number) => {
    setSettings((current) => ({
      ...current,
      maxDuration: value,
      minDuration: Math.min(current.minDuration, value - 5),
    }));
  };

  const resolve = useCallback(
    async (raw?: string) => {
      const target = (raw ?? url).trim();
      if (!target) {
        setResolveError('Paste a video link first.');
        return;
      }
      setResolving(true);
      setResolveError(null);
      try {
        const data = await api.resolveImport(target);
        setResolved(data);
        setUrl(data.url || target);
        setTitle(data.title || '');
        if (!data.isLive) setMode('url');
      } catch (error) {
        setResolved(null);
        setResolveError((error as Error).message || 'That link could not be read.');
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

  const chooseFile = useCallback((next: File | null) => {
    if (!next) return;
    if (!looksLikeVideo(next)) {
      setResolveError('Use an MP4, MOV, MKV, WebM, M4V or TS file.');
      return;
    }
    setResolveError(null);
    setFile(next);
    setTitle((current) => current || next.name.replace(/\.[^.]+$/, ''));
  }, []);

  const create = async () => {
    if (submitting) return;
    setSubmitting(true);
    try {
      if (mode === 'upload') {
        if (!file) {
          notify({ tone: 'error', title: 'Pick a file', message: 'Choose a video from this laptop first.' });
          setSubmitting(false);
          return;
        }
        setUploadPercent(0);
        const project = await api.uploadProject({
          file,
          title: title.trim() || undefined,
          platform: 'upload',
          campaignId: campaignId || undefined,
          settings,
          onProgress: setUploadPercent,
        });
        notify({ tone: 'success', title: 'Source uploaded', message: 'Finding the moments worth posting.' });
        navigate(`/project/${project.id}`);
        return;
      }
      if (!resolved) {
        notify({ tone: 'error', title: 'Read the link first', message: 'Resolve the video so TeraClip can see its length and title.' });
        setSubmitting(false);
        return;
      }
      if (resolved.isLive) {
        notify({
          tone: 'error',
          title: 'That channel is live',
          message: 'Use the Live recorder to capture it cleanly while it happens.',
        });
        setSubmitting(false);
        return;
      }
      const project = await api.createProject({
        url: resolved.url || url,
        title: title.trim() || resolved.title,
        platform: resolved.platform,
        campaignId: campaignId || undefined,
        settings,
      });
      notify({ tone: 'success', title: 'Downloading the source', message: 'The clip engine is warming up.' });
      navigate(`/project/${project.id}`);
    } catch (error) {
      notify({ tone: 'error', title: 'Could not start this project', message: (error as Error).message });
    } finally {
      setSubmitting(false);
    }
  };

  const readyToCreate = mode === 'url' ? Boolean(resolved && !resolved.isLive) : Boolean(file);
  const busy = submitting || resolving;
  const titlePreview = useMemo(
    () => title.trim() || resolved?.title || (file ? file.name.replace(/\.[^.]+$/, '') : 'Your next stream'),
    [title, resolved, file],
  );

  return (
    <>
      <div className="page-head">
        <div className="page-head-copy">
          <p className="page-kicker">
            <Wand2 size={13} /> New clip set
          </p>
          <h1 className="page-title">Make something postable</h1>
          <p className="page-sub">
            One link or one file in. Vertically framed, word-timed, hook-topped clips out — with every heavy step
            running on this laptop.
          </p>
        </div>
        <div className="head-actions">
          <Link to="/live" className="btn btn-secondary">
            <Radio size={15} /> Record live instead
          </Link>
        </div>
      </div>

      <div className="new-grid">
        <div className="new-main">
          <Panel
            className="step-panel"
            eyebrow="Step 01 · Source"
            title={
              <span className="panel-title-row">
                <span className="step-number">1</span>
                Where’s the video?
              </span>
            }
            action={
              resolved?.duration ? <Badge tone="violet">{clock(resolved.duration)} source</Badge> : undefined
            }
          >
            <div className="import-tabs">
              <Segmented
                value={mode}
                onChange={(value) => {
                  setMode(value);
                  setResolveError(null);
                }}
                options={[
                  { value: 'url', label: 'Paste a link', icon: Link2 },
                  { value: 'upload', label: 'Upload a file', icon: Upload },
                ]}
              />
            </div>

            {mode === 'url' ? (
              <>
                <div className="url-form">
                  <div className="url-row">
                    <Input
                      ref={urlInput}
                      className="input-lg"
                      value={url}
                      onChange={(event) => {
                        setUrl(event.target.value);
                        if (resolved) setResolved(null);
                      }}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') void resolve();
                      }}
                      placeholder="https://twitch.tv/videos/… or https://youtube.com/watch?v=…"
                      aria-label="Video or VOD link"
                      spellCheck={false}
                    />
                    <Button
                      variant={resolved ? 'secondary' : 'primary'}
                      icon={resolved ? RotateCcw : Sparkles}
                      loading={resolving}
                      onClick={() => void resolve()}
                    >
                      {resolved ? 'Read again' : 'Read link'}
                    </Button>
                  </div>
                  <div className="platform-row">
                    <span className="platform-hint">Works with</span>
                    {platformList.map((platform) => (
                      <button
                        key={platform.id}
                        type="button"
                        className="platform-mini"
                        title={platform.note}
                        onClick={() => {
                          setUrl('');
                          setResolved(null);
                          if (urlInput.current) {
                            urlInput.current.placeholder = platform.placeholder;
                            urlInput.current.focus();
                          }
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
                    ))}
                  </div>
                </div>

                {resolved ? (
                  <div className="resolved-card">
                    <div className="resolved-thumb">
                      {resolved.thumbnail ? (
                        <img
                          src={resolved.thumbnail}
                          alt=""
                          style={{ width: '100%', aspectRatio: '16/10', objectFit: 'cover' }}
                          loading="lazy"
                        />
                      ) : (
                        <span className="poster-fallback" style={{ aspectRatio: '16/10' }}>
                          <Film size={20} />
                        </span>
                      )}
                    </div>
                    <div className="resolved-copy">
                      <span className="resolved-kicker">
                        {resolved.platform} · {hostOf(resolved.url) || 'source'}
                        {resolved.isLive ? ' · live now' : ''}
                      </span>
                      <p className="resolved-title">{resolved.title || 'Untitled source'}</p>
                      <div className="resolved-meta">
                        <span>{resolved.channel || 'Unknown channel'}</span>
                        {resolved.duration ? (
                          <>
                            <span className="meta-dot" />
                            <span>{clock(resolved.duration)}</span>
                          </>
                        ) : null}
                        {resolved.width && resolved.height ? (
                          <>
                            <span className="meta-dot" />
                            <span>
                              {resolved.width}×{resolved.height}
                            </span>
                          </>
                        ) : null}
                      </div>
                      <div className="resolved-actions">
                        {resolved.isLive ? (
                          <Link to={`/live?url=${encodeURIComponent(resolved.url || url)}`} className="btn btn-primary btn-sm">
                            <Radio size={13} /> Record it live
                          </Link>
                        ) : (
                          <Badge tone="green" dot>
                            Source ready to clip
                          </Badge>
                        )}
                        <Button
                          variant="ghost"
                          size="sm"
                          icon={X}
                          onClick={() => {
                            setResolved(null);
                            setTitle('');
                          }}
                        >
                          Clear
                        </Button>
                      </div>
                    </div>
                  </div>
                ) : null}

                {resolveError ? (
                  <p className="field-help" style={{ marginTop: 10, color: 'var(--red)' }}>
                    {resolveError}
                  </p>
                ) : null}

                {resolved ? (
                  <div style={{ marginTop: 14 }}>
                    <Field label="Clip set name" hint="Shown in the library">
                      <Input
                        value={title}
                        onChange={(event) => setTitle(event.target.value)}
                        placeholder={resolved.title}
                        maxLength={140}
                      />
                    </Field>
                  </div>
                ) : null}
              </>
            ) : (
              <>
                <button
                  type="button"
                  className={cx('dropzone', dragging && 'is-dragging')}
                  style={{ width: '100%' }}
                  onClick={() => fileInput.current?.click()}
                  onDragOver={(event) => {
                    event.preventDefault();
                    setDragging(true);
                  }}
                  onDragLeave={() => setDragging(false)}
                  onDrop={(event) => {
                    event.preventDefault();
                    setDragging(false);
                    chooseFile(event.dataTransfer.files?.[0] ?? null);
                  }}
                >
                  <span className="dropzone-icon">
                    <FileVideo2 size={21} />
                  </span>
                  <span className="dropzone-title">Drop a recording here</span>
                  <span className="dropzone-sub">
                    MP4, MOV, MKV, WebM or TS · <strong>up to 6 GB</strong>
                    <br />
                    Nothing is uploaded anywhere. The file is copied into your local studio folder.
                  </span>
                  {file ? (
                    <span className="dropzone-file" onClick={(event) => event.stopPropagation()}>
                      <span className="dropzone-file-icon">
                        <FileVideo2 size={15} />
                      </span>
                      <span className="dropzone-file-copy">
                        <span className="dropzone-file-name">{file.name}</span>
                        <span className="dropzone-file-size">{bytes(file.size)}</span>
                      </span>
                      <button
                        type="button"
                        className="icon-btn"
                        aria-label="Remove file"
                        onClick={() => {
                          setFile(null);
                          if (fileInput.current) fileInput.current.value = '';
                        }}
                      >
                        <X size={15} />
                      </button>
                    </span>
                  ) : null}
                </button>
                <input
                  ref={fileInput}
                  type="file"
                  accept="video/mp4,video/quicktime,video/x-matroska,video/webm,.mp4,.mov,.mkv,.webm,.m4v,.avi,.ts"
                  className="sr-only"
                  onChange={(event) => chooseFile(event.target.files?.[0] ?? null)}
                />
                {resolveError ? (
                  <p className="field-help" style={{ marginTop: 10, color: 'var(--red)' }}>
                    {resolveError}
                  </p>
                ) : null}
                {file ? (
                  <div style={{ marginTop: 14 }}>
                    <Field label="Clip set name" hint="Shown in the library">
                      <Input
                        value={title}
                        onChange={(event) => setTitle(event.target.value)}
                        placeholder={file.name.replace(/\.[^.]+$/, '')}
                        maxLength={140}
                      />
                    </Field>
                  </div>
                ) : null}
                {submitting && uploadPercent > 0 && uploadPercent < 100 ? (
                  <div style={{ marginTop: 14 }}>
                    <div className="create-summary-row" style={{ marginBottom: 6 }}>
                      <span>Copying into the studio…</span>
                      <strong>{uploadPercent}%</strong>
                    </div>
                    <ProgressBar value={uploadPercent} animated />
                  </div>
                ) : null}
              </>
            )}
          </Panel>

          <Panel
            className="step-panel"
            eyebrow="Step 02 · Look"
            title={
              <span className="panel-title-row">
                <span className="step-number">2</span>
                Choose the caption look
              </span>
            }
            action={<Badge tone="lilac">{preset.name}</Badge>}
          >
            <div className="settings-block">
              <div className="settings-block-head">
                <div>
                  <p className="settings-block-title">Caption style</p>
                  <p className="settings-block-sub">Word-by-word timing, burned into the video.</p>
                </div>
              </div>
              <div className="preset-grid">
                {CAPTION_PRESETS.map((option) => {
                  const css = option.css;
                  const active = settings.captionPreset === option.id;
                  return (
                    <button
                      key={option.id}
                      type="button"
                      className={cx('preset-option', active && 'is-active')}
                      onClick={() => update('captionPreset', option.id)}
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
                          {option.sample.split(' ').map((word, index) => (
                            <span
                              key={`${option.id}-${word}-${index}`}
                              style={{ color: index === 0 ? option.activeColor : undefined }}
                            >
                              {word}{' '}
                            </span>
                          ))}
                        </span>
                      </span>
                      <span className="preset-name">
                        {active ? <Check size={10} style={{ display: 'inline', marginRight: 3 }} /> : null}
                        {option.name}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="settings-block">
              <Range
                label="Caption size"
                value={Math.round(settings.captionScale * 100)}
                min={60}
                max={160}
                step={5}
                suffix="%"
                onChange={(value) => update('captionScale', value / 100)}
                hint="Scales the word-by-word text that is burned into the finished clip."
              />
            </div>

            <div className="settings-block">
              <div className="settings-block-head">
                <div>
                  <p className="settings-block-title">Hook card</p>
                  <p className="settings-block-sub">Sits above the first line, like the reference.</p>
                </div>
                <HookCard text={HOOK_PREVIEW[settings.hookStyle] || 'Hook off'} style={settings.hookStyle} scale="sm" />
              </div>
              <div className="hook-options">
                {HOOK_STYLES.map((option) => {
                  const active = settings.hookStyle === option.id;
                  return (
                    <button
                      key={option.id}
                      type="button"
                      className={cx('hook-option', active && 'is-active')}
                      onClick={() => update('hookStyle', option.id)}
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
            </div>

            <div className="settings-block">
              <div className="settings-block-head">
                <div>
                  <p className="settings-block-title">Frame</p>
                  <p className="settings-block-sub">How the source gets cropped for each ratio.</p>
                </div>
              </div>
              <div className="settings-two">
                <Field label="Aspect ratio">
                  <Segmented
                    className="segmented-wide"
                    value={settings.aspect}
                    onChange={(value) => update('aspect', value as AspectRatio)}
                    options={[
                      { value: '9:16', label: '9:16' },
                      { value: '1:1', label: '1:1' },
                      { value: '16:9', label: '16:9' },
                    ]}
                  />
                </Field>
                <Field label="Reframing" hint={settings.reframe === 'smart' ? 'tracks faces' : undefined}>
                  <Segmented
                    className="segmented-wide"
                    value={settings.reframe}
                    onChange={(value) => update('reframe', value as ReframeMode)}
                    options={[
                      { value: 'smart', label: 'Smart' },
                      { value: 'center', label: 'Center' },
                      { value: 'blur', label: 'Blur fill' },
                    ]}
                  />
                </Field>
              </div>
            </div>
          </Panel>

          <Panel
            className="step-panel"
            eyebrow="Step 03 · Rules"
            title={
              <span className="panel-title-row">
                <span className="step-number">3</span>
                Shape the clip set
              </span>
            }
            action={<Badge tone="neutral">{settings.clipCount} clip{settings.clipCount === 1 ? '' : 's'}</Badge>}
          >
            <div className="settings-block">
              <div className="settings-three">
                <Field label="Clip count" hint="1–10">
                  <Select value={String(settings.clipCount)} onChange={(value) => update('clipCount', Number(value))}>
                    {Array.from({ length: 10 }, (_, index) => index + 1).map((count) => (
                      <option key={count} value={count}>
                        {count} clip{count === 1 ? '' : 's'}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Shortest clip" hint={`${settings.minDuration}s`}>
                  <input
                    className="range"
                    type="range"
                    min={5}
                    max={60}
                    step={1}
                    value={settings.minDuration}
                    onChange={(event) => setMinDuration(Number(event.target.value))}
                    style={{ ['--range-progress' as string]: `${((settings.minDuration - 5) / 55) * 100}%` }}
                    aria-label="Shortest clip duration"
                  />
                </Field>
                <Field label="Longest clip" hint={`${settings.maxDuration}s`}>
                  <input
                    className="range"
                    type="range"
                    min={10}
                    max={120}
                    step={1}
                    value={settings.maxDuration}
                    onChange={(event) => setMaxDuration(Number(event.target.value))}
                    style={{ ['--range-progress' as string]: `${((settings.maxDuration - 10) / 110) * 100}%` }}
                    aria-label="Longest clip duration"
                  />
                </Field>
              </div>
            </div>

            <div className="settings-block">
              <div className="settings-two">
                <Field label="Cutting pace" hint="How tightly the dead air is trimmed">
                  <Segmented
                    className="segmented-wide"
                    value={settings.pacing}
                    onChange={(value) => update('pacing', value as PacingMode)}
                    options={[
                      { value: 'original', label: 'Natural' },
                      { value: 'balanced', label: 'Balanced' },
                      { value: 'tight', label: 'Tight' },
                    ]}
                  />
                </Field>
                <Field label="Render quality" hint={settings.quality === 'high' ? 'crisper, slower' : undefined}>
                  <Segmented
                    className="segmented-wide"
                    value={settings.quality}
                    onChange={(value) => update('quality', value as QualityMode)}
                    options={[
                      { value: 'fast', label: 'Fast' },
                      { value: 'balanced', label: 'Balanced' },
                      { value: 'high', label: 'High' },
                    ]}
                  />
                </Field>
              </div>
            </div>

            <div className="settings-block">
              <div className="settings-block-head">
                <div>
                  <p className="settings-block-title">Editorial AI</p>
                  <p className="settings-block-sub">{AI_COPY[settings.aiMode]}</p>
                </div>
              </div>
              <Segmented
                className="segmented-wide"
                value={settings.aiMode}
                onChange={(value) => update('aiMode', value as AiMode)}
                options={[
                  { value: 'smart', label: 'Smart · Gemini assists' },
                  { value: 'full', label: 'Full review' },
                  { value: 'off', label: 'Local only' },
                ]}
              />
              {!bootstrap?.geminiConfigured ? (
                <div className="ai-note" style={{ marginTop: 10 }}>
                  <Sparkles size={13} />
                  <span>
                    No Gemini key found, so TeraClip will use local scoring. Add <strong>GEMINI_API</strong> to{' '}
                    <code>.env.local</code> to unlock editorial hooks.
                  </span>
                </div>
              ) : null}
            </div>

            <div className="settings-block">
              <div className="settings-two">
                <Toggle
                  checked={settings.audioEnhance}
                  onChange={(value) => update('audioEnhance', value)}
                  label="Clean up the audio"
                  hint="Gentle -14 LUFS loudness match and 35 Hz rumble trim. No compression."
                />
                <Toggle
                  checked={settings.watermark}
                  onChange={(value) => update('watermark', value)}
                  label="Add a brand handle"
                  hint={
                    appSettings?.brandHandle
                      ? `Burns “${appSettings.brandHandle}” in the corner.`
                      : 'Set a handle in Settings to use this.'
                  }
                  disabled={!appSettings?.brandHandle}
                />
              </div>
            </div>

            {campaigns.length ? (
              <div className="settings-block">
                <Field
                  label="Attach to a campaign"
                  hint="Carries the rules through to the posting kit"
                >
                  <Select value={campaignId} onChange={setCampaignId}>
                    <option value="">No campaign — just my own clips</option>
                    {campaigns.map((campaign: Campaign) => (
                      <option key={campaign.id} value={campaign.id}>
                        {campaign.name} · {campaign.brand}
                      </option>
                    ))}
                  </Select>
                </Field>
              </div>
            ) : null}
          </Panel>
        </div>

        <aside className="new-rail">
          <div className="preview-stack">
            <div className="preview-shell">
              <div className="preview-shell-head">
                <span className="preview-shell-title">
                  <MonitorPlay size={13} /> Live preview
                </span>
                <span className="preview-shell-badge">updates as you choose</span>
              </div>
              <div className="preview-stage-inner">
                <ClipStagePreview
                  preset={preset}
                  hook={HOOK_PREVIEW[settings.hookStyle] || ''}
                  hookStyle={settings.hookStyle}
                  aspect={aspectCss(settings.aspect)}
                  captionScale={settings.captionScale}
                />
              </div>
              <div className="preview-caption-meta">
                <span>
                  <Film size={11} /> {settings.aspect} · {preset.name}
                </span>
                <span>
                  <Clock3 size={11} /> {settings.minDuration}–{settings.maxDuration}s cuts
                </span>
              </div>
            </div>

            <div className="create-summary">
              <div className="create-summary-row">
                <span>Source</span>
                <strong>
                  {mode === 'upload'
                    ? file?.name || 'No file yet'
                    : resolved
                      ? `${resolved.platform} · ${clock(resolved.duration)}`
                      : 'No link yet'}
                </strong>
              </div>
              <div className="create-summary-row">
                <span>Clips</span>
                <strong>
                  {settings.clipCount} × {settings.minDuration}–{settings.maxDuration}s
                </strong>
              </div>
              <div className="create-summary-row">
                <span>Look</span>
                <strong>
                  {preset.name} · {settings.hookStyle === 'none' ? 'no hook' : `${settings.hookStyle} hook`}
                </strong>
              </div>
              <div className="create-summary-row">
                <span>Editorial</span>
                <strong>
                  {settings.aiMode === 'off'
                    ? '100% local'
                    : settings.aiMode === 'full'
                      ? 'Gemini on every cut'
                      : 'Gemini for the finals'}
                </strong>
              </div>
              <div className="create-summary-total">
                <span>Estimated render</span>
                <strong>~{estimated < 60 ? `${estimated}s` : `${Math.round(estimated / 60)} min`}</strong>
              </div>
            </div>

            <div className="create-cta">
              <Button
                size="lg"
                icon={mode === 'upload' ? Upload : Sparkles}
                loading={busy}
                disabled={!readyToCreate || resolving}
                onClick={() => void create()}
              >
                {mode === 'upload'
                  ? submitting
                    ? uploadPercent > 0 && uploadPercent < 100
                      ? `Uploading ${uploadPercent}%`
                      : 'Starting the engine…'
                    : 'Upload & make clips'
                  : resolved?.isLive
                    ? 'Use the live recorder'
                    : submitting
                      ? 'Starting the engine…'
                      : `Make ${settings.clipCount} clip${settings.clipCount === 1 ? '' : 's'}`}
              </Button>
              <span className="create-cta-note">
                <Check size={11} /> {titlePreview ? `“${titlePreview.slice(0, 42)}${titlePreview.length > 42 ? '…' : ''}”` : 'Everything runs locally'}
              </span>
            </div>

            <div className="ai-note">
              {settings.aiMode === 'off' ? <Film size={13} /> : <Sparkles size={13} />}
              <span>
                {settings.aiMode === 'off' ? (
                  <>
                    <strong>Zero cloud calls.</strong> Local audio heat, speech structure and Gemini-free scoring pick
                    the moments.
                  </>
                ) : (
                  <>
                    <strong>Gemini stays on a leash.</strong> One cached editorial pass per project, with a daily cap
                    and local fallbacks.
                  </>
                )}
              </span>
            </div>

            {resolved?.isLive ? (
              <div className="tool-note">
                <Radio size={14} />
                <span>
                  <strong>Live link detected.</strong> Clipping needs a finished file. Record the stream first and the
                  clips will appear automatically.
                </span>
              </div>
            ) : null}

            <div className="tool-note">
              <Wand2 size={14} />
              <span>
                <strong>First render?</strong> The engine downloads the source, transcribes speech, tracks faces and
                burns captions. A 20-minute VOD usually takes a few minutes.
              </span>
            </div>
          </div>
        </aside>
      </div>
    </>
  );
}
