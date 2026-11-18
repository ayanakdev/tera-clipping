import { memo, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import {
  ArrowUpRight,
  Check,
  Clock3,
  Download,
  Film,
  Pause,
  Play,
  Sparkles,
  Star,
  Wand2,
} from 'lucide-react';
import type {
  ClipPresetVisual,
  ClipRecord,
  HeatPoint,
  HookStyleId,
  LiveMoment,
  PlatformId,
  ProjectStatus,
} from '@shared/types';
import { HOOK_STYLES } from '@shared/presets';
import { mediaUrl } from '@web/lib/api';
import { clock } from '@web/lib/format';
import { cx, IconButton, PlatformMark, ScoreBadge } from './ui';

export function ProjectPoster({
  src,
  alt,
  className,
  ratio = '16 / 9',
}: {
  src?: string | null;
  alt: string;
  className?: string;
  ratio?: string;
}) {
  return (
    <div className={cx('poster', className)} style={{ aspectRatio: ratio }}>
      {src ? (
        <img src={src} alt={alt} loading="lazy" />
      ) : (
        <span className="poster-fallback" aria-hidden>
          <Film size={22} />
        </span>
      )}
    </div>
  );
}

export function VideoFrame({
  src,
  poster,
  className,
  aspectRatio = '9 / 16',
  controls,
  autoPlay = false,
  badge,
  onClick,
  children,
}: {
  src?: string;
  poster?: string;
  className?: string;
  aspectRatio?: string;
  controls?: boolean;
  autoPlay?: boolean;
  badge?: ReactNode;
  onClick?: () => void;
  children?: ReactNode;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [hovering, setHovering] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!src) setFailed(false);
  }, [src]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !src) return;
    if (autoPlay) {
      video.play().catch(() => undefined);
    }
  }, [autoPlay, src]);

  const play = () => {
    const video = videoRef.current;
    if (!video) return;
    void video.play().catch(() => setFailed(true));
  };

  const pause = () => {
    const video = videoRef.current;
    if (!video) return;
    video.pause();
  };

  const onEnter = () => {
    setHovering(true);
    if (src && !controls) play();
  };
  const onLeave = () => {
    setHovering(false);
    if (!controls && !autoPlay) {
      pause();
      if (videoRef.current) videoRef.current.currentTime = 0;
    }
  };

  return (
    <div
      className={cx('video-frame', className)}
      style={{ aspectRatio }}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      onClick={onClick}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={
        onClick
          ? (event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                onClick();
              }
            }
          : undefined
      }
    >
      {src && !failed ? (
        <video
          ref={videoRef}
          src={src}
          poster={poster}
          muted
          loop
          playsInline
          preload="none"
          controls={controls}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onError={() => setFailed(true)}
          className="video-el"
        />
      ) : poster ? (
        <img src={poster} alt="" loading="lazy" className="video-el" />
      ) : (
        <span className="video-fallback">
          <Film size={24} />
        </span>
      )}
      {badge}
      {!controls && src && !playing ? (
        <span className={cx('play-hint', hovering && 'is-hovering')}>
          <Play size={15} fill="currentColor" />
        </span>
      ) : null}
      {children}
    </div>
  );
}

export interface ClipCardProps {
  clip: ClipRecord;
  projectTitle?: string;
  onOpen?: (clip: ClipRecord) => void;
  onStar?: (clip: ClipRecord) => void;
  onDownload?: (clip: ClipRecord) => void;
  onKit?: (clip: ClipRecord) => void;
  onDelete?: (clip: ClipRecord) => void;
  actions?: ReactNode;
  size?: 'default' | 'small' | 'wide';
  showProject?: boolean;
  className?: string;
}

export function ClipCard({
  clip,
  projectTitle,
  onOpen,
  onStar,
  onDownload,
  onKit,
  onDelete,
  actions,
  size = 'default',
  showProject,
  className,
}: ClipCardProps) {
  const poster = mediaUrl(clip.files.thumb);
  const src = clip.status === 'ready' ? mediaUrl(clip.files.final) : undefined;
  const ready = clip.status === 'ready';
  return (
    <article className={cx('clip-card', `clip-card-${size}`, className)}>
      <VideoFrame
        src={src}
        poster={poster}
        onClick={onOpen ? () => onOpen(clip) : undefined}
        badge={
          <span className="clip-frame-top">
            <ScoreBadge score={clip.score} compact />
            <span className="duration-chip">{clock(clip.duration)}</span>
          </span>
        }
      >
        <span className="clip-frame-bottom">
          <span className={cx('clip-status', `status-${clip.status}`)}>
            {clip.status === 'ready' ? <Check size={11} /> : clip.status === 'rendering' ? <Wand2 size={11} /> : null}
            {clip.status === 'ready' ? 'Ready' : clip.status === 'rendering' ? `${Math.round(clip.progress)}%` : clip.status}
          </span>
          <span className="clip-index">#{String(clip.index + 1).padStart(2, '0')}</span>
        </span>
        {clip.starred ? (
          <span className="clip-star" title="Starred">
            <Star size={13} fill="currentColor" />
          </span>
        ) : null}
        {(onDownload || onKit || onStar || onDelete || actions) && ready ? (
          <div className="clip-hover-actions" onClick={(event) => event.stopPropagation()}>
            {onStar ? (
              <IconButton
                icon={Star}
                label={clip.starred ? 'Remove star' : 'Star clip'}
                className={cx('mini-action', clip.starred && 'is-on')}
                onClick={() => onStar(clip)}
              />
            ) : null}
            {onDownload ? <IconButton icon={Download} label="Download clip" className="mini-action" onClick={() => onDownload(clip)} /> : null}
            {onKit ? <IconButton icon={Sparkles} label="Posting kit" className="mini-action" onClick={() => onKit(clip)} /> : null}
            {actions}
          </div>
        ) : null}
      </VideoFrame>
      <div className="clip-info">
        <button className={cx('clip-title', onOpen ? 'is-button' : undefined)} onClick={() => onOpen?.(clip)}>
          {clip.title || clip.hook || 'Untitled clip'}
        </button>
        <div className="clip-meta">
          {showProject && projectTitle ? <span className="clip-project">{projectTitle}</span> : null}
          <span>{clock(clip.duration)}</span>
          <span className="meta-dot" />
          <span>{clip.hookStyle === 'none' ? 'No hook' : 'Hook on'}</span>
          {clip.status !== 'ready' ? <span className="clip-meta-warning">{clip.stage}</span> : null}
        </div>
      </div>
    </article>
  );
}

export function CaptionPreview({
  preset,
  scale = 'md',
  animate = true,
  words,
  className,
  captionScale = 1,
}: {
  preset: ClipPresetVisual;
  scale?: 'sm' | 'md' | 'lg';
  animate?: boolean;
  words?: string[];
  className?: string;
  captionScale?: number;
}) {
  const list = words?.length ? words : preset.sample.split(' ');
  const [active, setActive] = useState(0);
  useEffect(() => {
    if (!animate || list.length < 2) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const timer = window.setInterval(() => setActive((current) => (current + 1) % list.length), 720);
    return () => window.clearInterval(timer);
  }, [animate, list.length]);

  const css = preset.css;
  const style: CSSProperties = {
    fontFamily: css.fontFamily,
    fontWeight: css.fontWeight,
    letterSpacing: css.letterSpacing,
    textTransform: css.textTransform,
    color: css.color,
    background: preset.box ? preset.boxColor : undefined,
    WebkitTextStroke: css.webkitTextStroke,
    textShadow: css.textShadow,
    borderRadius: preset.box ? '0.55em' : undefined,
    padding: preset.box ? '0.18em 0.5em 0.23em' : undefined,
  };

  return (
    <div
      className={cx('caption-preview', `caption-preview-${scale}`, preset.box && 'is-boxed', className)}
      style={{ ['--caption-scale' as string]: Math.max(0.6, Math.min(1.6, captionScale)) }}
    >
      <span className="caption-text" style={style} lang="en">
        {list.map((word, index) => (
          <span key={`${word}-${index}`} className={cx('caption-word', index === active && 'is-active')} style={{ color: index === active ? preset.activeColor : undefined }}>
            {word}
          </span>
        ))}
      </span>
    </div>
  );
}

export function HookCard({
  text,
  style,
  scale = 'md',
  className,
}: {
  text: string;
  style: HookStyleId;
  scale?: 'sm' | 'md' | 'lg';
  className?: string;
}) {
  if (style === 'none' || !text.trim()) return null;
  const theme = HOOK_STYLES.find((item) => item.id === style) || HOOK_STYLES[0];
  return (
    <div className={cx('hook-card', `hook-${scale}`, className)} style={{ background: theme.cardColor, color: theme.textColor }}>
      <span>{text}</span>
    </div>
  );
}

export function StageScene({
  aspect = '9 / 16',
  children,
  className,
  tone = 'studio',
  label,
}: {
  aspect?: string;
  children?: ReactNode;
  className?: string;
  tone?: 'studio' | 'clean';
  label?: string;
}) {
  return (
    <div className={cx('stage-frame', `stage-${tone}`, className)} style={{ aspectRatio: aspect }}>
      <div className="stage-scene" aria-hidden>
        <span className="stage-lamp" />
        <span className="stage-figure" />
        <span className="stage-floor" />
      </div>
      {label ? <span className="stage-label">{label}</span> : null}
      {children}
    </div>
  );
}

export function ClipStagePreview({
  preset,
  hook,
  hookStyle,
  aspect = '9 / 16',
  className,
  compact,
  captionScale = 1,
}: {
  preset: ClipPresetVisual;
  hook: string;
  hookStyle: HookStyleId;
  aspect?: string;
  className?: string;
  compact?: boolean;
  captionScale?: number;
}) {
  return (
    <StageScene aspect={aspect} className={cx('clip-stage', className)} label={compact ? undefined : 'Preview'}>
      <HookCard text={hook || 'This is the hook'} style={hookStyle} scale={compact ? 'sm' : 'md'} />
      <div className="clip-stage-captions">
        <CaptionPreview
          preset={preset}
          scale={compact ? 'sm' : 'md'}
          words={preset.sample.split(' ')}
          captionScale={captionScale}
        />
      </div>
      <span className="stage-scanlines" aria-hidden />
    </StageScene>
  );
}

const PIPELINE_STEPS = [
  { key: 'import', label: 'Import', detail: 'Source in' },
  { key: 'transcribe', label: 'Transcribe', detail: 'Word timing' },
  { key: 'analyze', label: 'Find moments', detail: 'Viral score' },
  { key: 'plan', label: 'Plan', detail: 'Hook + captions' },
  { key: 'render', label: 'Render', detail: 'Ready to post' },
];

function stepIndex(status: ProjectStatus, stage: string): number {
  if (status === 'ready') return PIPELINE_STEPS.length;
  if (stage === 'importing' || status === 'importing' || status === 'queued') return 0;
  if (stage === 'transcribing' || status === 'transcribing') return 1;
  if (stage === 'analyzing' || status === 'analyzing') return 2;
  if (stage === 'planning' || status === 'planning') return 3;
  if (stage === 'rendering' || status === 'rendering') return 4;
  return 0;
}

export function Pipeline({
  status,
  stage,
  progress,
  message,
  compact,
}: {
  status: ProjectStatus;
  stage: string;
  progress: number;
  message?: string;
  compact?: boolean;
}) {
  const index = stepIndex(status, stage);
  const failed = status === 'failed' || status === 'cancelled';
  return (
    <div className={cx('pipeline', compact && 'is-compact', failed && 'is-failed')}>
      <div className="pipeline-steps">
        {PIPELINE_STEPS.map((step, stepNumber) => {
          const state = stepNumber < index ? 'done' : stepNumber === index ? (failed ? 'error' : 'active') : 'todo';
          return (
            <div key={step.key} className={cx('pipeline-step', `is-${state}`)}>
              <span className="pipeline-node">
                {state === 'done' ? <Check size={11} strokeWidth={3} /> : stepNumber === index ? <span className="pipeline-pulse" /> : stepNumber + 1}
              </span>
              <span className="pipeline-copy">
                <span className="pipeline-label">{step.label}</span>
                {!compact ? <span className="pipeline-detail">{step.detail}</span> : null}
              </span>
            </div>
          );
        })}
      </div>
      <div className="pipeline-track">
        <span className={cx('pipeline-fill', failed && 'is-failed')} style={{ width: `${status === 'ready' ? 100 : Math.max(3, Math.min(100, progress))}%` }} />
      </div>
      <div className="pipeline-meta">
        <span className={cx('pipeline-status', `status-${status}`)}>
          {status === 'ready'
            ? 'All clips ready'
            : failed
              ? status === 'cancelled'
                ? 'Cancelled'
                : 'Needs attention'
              : message || `${PIPELINE_STEPS[Math.min(index, 4)]?.label}…`}
        </span>
        {status !== 'ready' && !failed ? <span className="pipeline-percent">{Math.round(progress)}%</span> : null}
        {status === 'ready' ? <span className="pipeline-percent">100%</span> : null}
      </div>
    </div>
  );
}

export const HeatTimeline = memo(function HeatTimeline({
  audioHeat,
  chatHeat,
  moments,
  duration,
  height = 132,
  onSeek,
  className,
}: {
  audioHeat: HeatPoint[];
  chatHeat: HeatPoint[];
  moments: LiveMoment[];
  duration: number;
  height?: number;
  onSeek?: (t: number) => void;
  className?: string;
}) {
  const width = 720;
  const maxT = Math.max(60, duration || 0);
  const pad = 8;
  const viewHeight = height;
  const x = (t: number) => (Math.max(0, Math.min(t, maxT)) / maxT) * (width - pad * 2) + pad;
  const y = (value: number) => viewHeight - 22 - value * (viewHeight - 42);
  const chatValues = chatHeat
    .map((point) => Number(point.chat) || 0)
    .filter((value) => value > 0)
    .sort((a, b) => a - b);
  // Divide by the 95th percentile instead of a fixed 8 messages. Big streams
  // sit at 30+ messages a tick, small chats at 2; both should look readable.
  const chatCeiling = Math.max(
    4,
    (chatValues[Math.min(chatValues.length - 1, Math.floor(chatValues.length * 0.95))] ?? 0) * 1.15,
  );
  const build = (points: HeatPoint[], key: 'audio' | 'chat') => {
    const usable = points.filter((point) => point[key] !== undefined);
    if (!usable.length) return '';
    return usable
      .map((point, index) => {
        const raw = Number(point[key]);
        const value = key === 'chat' ? raw / chatCeiling : raw;
        return `${index === 0 ? 'M' : 'L'}${x(point.t).toFixed(1)},${y(Math.max(0, Math.min(1, value))).toFixed(1)}`;
      })
      .join(' ');
  };
  const audioPath = build(audioHeat, 'audio');
  const chatPath = build(chatHeat, 'chat');
  const audioArea = audioPath ? `${audioPath} L${x(maxT)},${viewHeight - 22} L${x(0)},${viewHeight - 22} Z` : '';
  const chatArea = chatPath ? `${chatPath} L${x(maxT)},${viewHeight - 22} L${x(0)},${viewHeight - 22} Z` : '';
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((fraction) => Math.round(maxT * fraction));

  return (
    <div className={cx('heat-timeline', className)}>
      <svg viewBox={`0 0 ${width} ${viewHeight}`} preserveAspectRatio="none" role="img" aria-label="Audio and chat heat over the recording">
        <defs>
          <linearGradient id="heat-audio" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#7c3aed" stopOpacity="0.34" />
            <stop offset="100%" stopColor="#7c3aed" stopOpacity="0.02" />
          </linearGradient>
          <linearGradient id="heat-chat" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#f0a500" stopOpacity="0.26" />
            <stop offset="100%" stopColor="#f0a500" stopOpacity="0.02" />
          </linearGradient>
        </defs>
        {ticks.map((tick) => (
          <g key={tick}>
            <line x1={x(tick)} x2={x(tick)} y1={12} y2={viewHeight - 18} stroke="#e9e4f2" strokeWidth="1" strokeDasharray="2 5" />
            <text x={x(tick)} y={viewHeight - 4} textAnchor={tick === 0 ? 'start' : tick === ticks[ticks.length - 1] ? 'end' : 'middle'} className="heat-tick">
              {clock(tick)}
            </text>
          </g>
        ))}
        {audioArea ? <path d={audioArea} fill="url(#heat-audio)" /> : null}
        {chatArea ? <path d={chatArea} fill="url(#heat-chat)" /> : null}
        {chatPath ? <path d={chatPath} fill="none" stroke="#e7a400" strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" opacity="0.72" /> : null}
        {audioPath ? <path d={audioPath} fill="none" stroke="#6d28d9" strokeWidth="1.9" strokeLinejoin="round" strokeLinecap="round" /> : null}
        {moments.map((moment) => (
          <g key={moment.id} className="heat-moment">
            <line x1={x(moment.t)} x2={x(moment.t)} y1={10} y2={viewHeight - 20} stroke="#2e1065" strokeWidth="1.2" strokeDasharray="3 3" opacity="0.45" />
            <circle cx={x(moment.t)} cy={10} r="4" fill="#fff" stroke="#5b21f6" strokeWidth="2" />
            <title>{`${clock(moment.t)} — ${moment.reason} (${moment.score})`}</title>
          </g>
        ))}
        <line x1={pad} x2={width - pad} y1={viewHeight - 22} y2={viewHeight - 22} stroke="#dcd4ec" strokeWidth="1" />
      </svg>
      <div className="heat-key">
        <span>
          <i className="key-audio" /> Audio energy
        </span>
        <span>
          <i className="key-chat" /> Chat heat
        </span>
        <span>
          <i className="key-moment" /> Detected moment
        </span>
      </div>
    </div>
  );
});

export const MiniSpark = memo(function MiniSpark({ points, className }: { points: HeatPoint[]; className?: string }) {
  const values = points
    .map((point) => point.heat ?? ((point.audio ?? 0) * 0.6 + (point.chat ?? 0) / 20))
    .slice(-40);
  if (!values.length) return <span className={cx('mini-spark', className)} aria-hidden />;
  const max = Math.max(0.3, ...values);
  const path = values
    .map((value, index) => `${index === 0 ? 'M' : 'L'}${(index / Math.max(1, values.length - 1)) * 100},${28 - (value / max) * 26}`)
    .join(' ');
  return (
    <svg className={cx('mini-spark', className)} viewBox="0 0 100 30" preserveAspectRatio="none" aria-hidden>
      <path d={`${path} L100,30 L0,30 Z`} fill="rgba(124,58,237,.12)" />
      <path d={path} fill="none" stroke="#7c3aed" strokeWidth="1.6" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
    </svg>
  );
});

export function StatusChip({ status }: { status: ProjectStatus }) {
  const tone =
    status === 'ready'
      ? 'green'
      : status === 'failed' || status === 'cancelled'
        ? 'red'
        : status === 'queued'
          ? 'neutral'
          : 'violet';
  const label =
    status === 'ready'
      ? 'Ready'
      : status === 'failed'
        ? 'Failed'
        : status === 'cancelled'
          ? 'Cancelled'
          : status === 'queued'
            ? 'Queued'
            : status === 'importing'
              ? 'Importing'
              : status === 'transcribing'
                ? 'Transcribing'
                : status === 'analyzing'
                  ? 'Finding moments'
                  : status === 'planning'
                    ? 'Planning'
                    : status === 'rendering'
                      ? 'Rendering'
                      : status;
  return (
    <span className={cx('status-chip', `tone-${tone}`, (status === 'rendering' || status === 'transcribing' || status === 'analyzing') && 'is-working')}>
      <span className="status-chip-dot" />
      {label}
    </span>
  );
}

export function SourceLine({
  platform,
  title,
  channel,
  url,
  className,
}: {
  platform: PlatformId;
  title: string;
  channel?: string;
  url?: string;
  className?: string;
}) {
  return (
    <div className={cx('source-line', className)}>
      <PlatformMark platform={platform} size={34} />
      <div className="source-copy">
        <span className="source-title">{title}</span>
        <span className="source-meta">{channel || 'Local upload'}</span>
      </div>
      {url ? (
        <a className="source-link" href={url} target="_blank" rel="noreferrer" title="Open the source">
          <ArrowUpRight size={15} />
        </a>
      ) : null}
    </div>
  );
}

export function StageTimecode({ start, end, className }: { start: number; end: number; className?: string }) {
  return (
    <span className={cx('stage-timecode', className)}>
      <Clock3 size={12} />
      {clock(start)} <span className="timecode-dash">→</span> {clock(end)}
    </span>
  );
}

export function PlayGlyph({ playing }: { playing: boolean }) {
  return playing ? <Pause size={15} /> : <Play size={15} />;
}
