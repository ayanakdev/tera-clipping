export type PlatformId =
  | 'youtube'
  | 'twitch'
  | 'kick'
  | 'x'
  | 'rumble'
  | 'tiktok'
  | 'instagram'
  | 'vimeo'
  | 'upload'
  | 'generic';

export type SourceKind = 'vod' | 'clip' | 'live' | 'upload' | 'file' | 'url';

export type AspectRatio = '9:16' | '1:1' | '16:9';

export type CaptionPresetId = 'tera-box' | 'hormozi' | 'purple-pop' | 'beast' | 'clean' | 'neon';

export type HookStyleId = 'white' | 'black' | 'purple' | 'none';

/**
 * `auto` notices the stream layout first: a full-frame camera is tracked like
 * `smart`, while a small cam overlaid on a moving game scene becomes `split`.
 * `smart` tracks the primary face and crops to it. `split` keeps the full
 * gameplay frame on top and adds a tracked face-camera crop underneath, which
 * is the layout most stream clips use on Shorts/TikTok/Reels.
 */
export type ReframeMode = 'auto' | 'smart' | 'split' | 'center' | 'blur';

/** What `auto` framing noticed about the source, kept for the UI and re-renders. */
export interface LayoutNotice {
  kind: 'single-cam' | 'game-cam' | 'no-face';
  /** The concrete layout that was used. */
  mode: Exclude<ReframeMode, 'auto'>;
  /** 0–1; higher means the corner-cam/static-scene signal was clearer. */
  confidence: number;
  reason: string;
}

export type PacingMode = 'original' | 'balanced' | 'tight';

export type QualityMode = 'fast' | 'balanced' | 'high';

export type RenderAcceleration = 'auto' | 'cpu';

export type AiMode = 'smart' | 'full' | 'off';

export type AsrModelId = 'base.en' | 'base' | 'small.en' | 'tiny.en';

export type ProjectStatus =
  | 'queued'
  | 'importing'
  | 'transcribing'
  | 'analyzing'
  | 'planning'
  | 'rendering'
  | 'ready'
  | 'failed'
  | 'cancelled';

export type LiveStatus =
  | 'preparing'
  | 'recording'
  | 'reconnecting'
  | 'stopping'
  | 'processing'
  | 'ready'
  | 'failed'
  | 'cancelled';

export type BinStatus = 'ready' | 'missing' | 'downloading' | 'error';

export interface Word {
  text: string;
  start: number;
  end: number;
  /** confidence, when supplied by the ASR engine */
  p?: number;
}

export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
  words: Word[];
}

/** A user-editable subtitle line. Times are relative to the clip start. */
export interface SubtitleCue {
  start: number;
  end: number;
  text: string;
}

export interface Transcript {
  language: string;
  duration: number;
  words: Word[];
  segments: TranscriptSegment[];
  model: string;
  createdAt: string;
}

export interface HeatPoint {
  t: number;
  audio?: number;
  chat?: number;
  heat?: number;
}

export interface ScoreParts {
  hook?: number;
  emotion?: number;
  selfContained?: number;
  payoff?: number;
  audio?: number;
  chat?: number;
  novelty?: number;
}

export interface HookOption {
  text: string;
  style: 'curiosity' | 'stakes' | 'contrarian' | 'question' | 'pov' | 'humor' | 'number';
}

export interface ClipCandidate {
  id: string;
  start: number;
  end: number;
  score: number;
  category: string;
  title: string;
  hook: string;
  hooks: HookOption[];
  caption: string;
  hashtags: string[];
  reason: string;
  scoreParts: ScoreParts;
  source: 'gemini' | 'local';
  geminiCalls?: number;
}

export interface ClipSettings {
  clipCount: number;
  minDuration: number;
  maxDuration: number;
  aspect: AspectRatio;
  captionPreset: CaptionPresetId;
  /** Caption size multiplier. 1 is the preset default, 0.6–1.6 is allowed. */
  captionScale: number;
  hookStyle: HookStyleId;
  pacing: PacingMode;
  reframe: ReframeMode;
  quality: QualityMode;
  aiMode: AiMode;
  asrModel: AsrModelId;
  language: string;
  audioEnhance: boolean;
  watermark: boolean;
}

export interface FaceSample {
  t: number;
  /** normalized centre x of the chosen crop window, 0..1 */
  x: number;
  /** normalized crop width relative to source width, 0..1 */
  w: number;
  /** normalized centre y of the crop window, 0..1 (optional) */
  y?: number;
  /** normalized crop height relative to source height, 0..1 (optional) */
  h?: number;
  /** normalized width of the detected face box, 0..1 (optional) */
  fw?: number;
  /** normalized height of the detected face box, 0..1 (optional) */
  fh?: number;
  /** total faces detected at this instant */
  faces: number;
}

export interface ClipFiles {
  base?: string;
  final?: string;
  thumb?: string;
  ass?: string;
  srt?: string;
  hookPng?: string;
}

export interface ClipRecord {
  id: string;
  projectId: string;
  index: number;
  start: number;
  end: number;
  duration: number;
  title: string;
  hook: string;
  hooks: HookOption[];
  caption: string;
  hashtags: string[];
  transcript: string;
  words: Word[];
  /** User-editable subtitle lines, relative to the clip start. */
  subtitles?: SubtitleCue[];
  score: number;
  scoreParts: ScoreParts;
  reason: string;
  category: string;
  source: 'gemini' | 'local';
  status: 'planned' | 'rendering' | 'ready' | 'failed' | 'cancelled';
  progress: number;
  stage: string;
  error?: string;
  captionPreset: CaptionPresetId;
  captionScale?: number;
  hookStyle: HookStyleId;
  framing: ReframeMode;
  /** Result of `auto` framing; also tells a re-render which layout to reuse. */
  notice?: LayoutNotice;
  files: ClipFiles;
  faceSamples?: FaceSample[];
  removedSilence?: number;
  renderMs?: number;
  starred?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface LibraryClip {
  clip: ClipRecord;
  project: {
    id: string;
    title: string;
    platform: PlatformId;
    sourceUrl?: string;
    campaignId?: string;
    createdAt: string;
  };
}

export interface Project {
  id: string;
  title: string;
  channel?: string;
  platform: PlatformId;
  sourceKind: SourceKind;
  sourceUrl?: string;
  sourcePath: string;
  thumbnailPath?: string;
  previewUrl?: string;
  externalId?: string;
  duration: number;
  width?: number;
  height?: number;
  fps?: number;
  campaignId?: string;
  status: ProjectStatus;
  stage: string;
  progress: number;
  message: string;
  error?: string;
  settings: ClipSettings;
  clips: ClipRecord[];
  stats?: {
    geminiCalls: number;
    cachedCalls: number;
    candidates: number;
    words: number;
    analysisEngine: string;
    startedAt: string;
    finishedAt?: string;
  };
  logs: Array<{ t: string; level: 'info' | 'warn' | 'error'; message: string }>;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectSummary {
  id: string;
  title: string;
  channel?: string;
  platform: PlatformId;
  sourceKind: SourceKind;
  sourceUrl?: string;
  thumbnailPath?: string;
  duration: number;
  campaignId?: string;
  status: ProjectStatus;
  stage: string;
  progress: number;
  message: string;
  error?: string;
  clipCount: number;
  readyClips: number;
  settings: Pick<ClipSettings, 'aspect' | 'captionPreset' | 'hookStyle' | 'quality'>;
  stats?: Project['stats'];
  createdAt: string;
  updatedAt: string;
}

export interface Campaign {
  id: string;
  name: string;
  brand: string;
  platform: PlatformId;
  status: 'active' | 'paused' | 'ended';
  link?: string;
  color: string;
  payoutPer1k?: number;
  rules: {
    minDuration: number;
    maxDuration: number;
    aspect: AspectRatio;
    requiredTags: string[];
    mentions: string[];
    cta: string;
    notes: string;
  };
  createdAt: string;
  updatedAt: string;
}

export interface Submission {
  id: string;
  clipId: string;
  projectId: string;
  campaignId: string;
  platform: string;
  url: string;
  views: number;
  earnings: number;
  status: 'posted' | 'approved' | 'rejected' | 'paid';
  postedAt: string;
  createdAt: string;
}

export interface LiveMoment {
  id: string;
  t: number;
  score: number;
  reason: string;
  clipId?: string;
  projectId?: string;
}

export interface LiveSession {
  id: string;
  platform: PlatformId;
  url: string;
  channel: string;
  title: string;
  thumbnailUrl?: string;
  status: LiveStatus;
  startedAt: string;
  endedAt?: string;
  duration: number;
  segments: number;
  bytes: number;
  health: 'good' | 'unstable' | 'reconnecting' | 'offline';
  chatConnected: boolean;
  chatMessages: number;
  audioHeat: HeatPoint[];
  chatHeat: HeatPoint[];
  moments: LiveMoment[];
  autoClip: boolean;
  projectId?: string;
  error?: string;
  log: Array<{ t: string; level: 'info' | 'warn' | 'error'; message: string }>;
  updatedAt: string;
  /**
   * Monotonic capture clock the web renders. It is advanced only by the server
   * capture loop and is the single source of truth for the on-screen timer, so
   * a reconnect can never make the displayed time step backwards.
   */
  elapsed?: number;
  /**
   * Set whenever the capture loop discovers the stream was interrupted and
   * ffmpeg re-encoded/resumed from a discontinuity. The web surfaces this so
   * the user knows why a few seconds may rewind at the cut point.
   */
  spliceMarker?: {
    at: number;
    kind: 'reconnect' | 'gap';
    explanation: string;
  };
}

export interface StudioStats {
  projectsCreated: number;
  clipsPlanned: number;
  rendersCompleted: number;
  secondsRendered: number;
  liveSecondsCaptured: number;
  updatedAt: string;
}

export interface CreatorProfile {
  id: string;
  platform: PlatformId;
  handle: string;
  name: string;
  source: 'seed' | 'custom';
  addedAt: string;
}

export interface CreatorStatus {
  live: boolean;
  viewers?: number;
  title?: string;
  game?: string;
  thumbnailUrl?: string;
  avatarUrl?: string;
  displayName?: string;
  startedAt?: string;
  checkedAt: string;
  error?: string;
}

export interface CreatorEntry extends CreatorProfile {
  status: CreatorStatus;
}

export interface GeminiUsage {
  date: string;
  requests: number;
  cachedHits: number;
  tokensIn: number;
  tokensOut: number;
  failures: number;
}

export interface AppSettings {
  defaultClipCount: number;
  defaultMinDuration: number;
  defaultMaxDuration: number;
  defaultAspect: AspectRatio;
  defaultCaptionPreset: CaptionPresetId;
  defaultCaptionScale: number;
  defaultHookStyle: HookStyleId;
  defaultPacing: PacingMode;
  defaultQuality: QualityMode;
  /** Auto uses a hardware H.264 encoder when ffmpeg can open one. */
  renderAcceleration: RenderAcceleration;
  defaultReframe: ReframeMode;
  defaultAiMode: AiMode;
  defaultAsrModel: AsrModelId;
  asrThreads: number;
  asrLanguage: string;
  geminiModel: string;
  geminiDailyLimit: number;
  cookiesBrowser: string;
  cookiesFile: string;
  watermark: boolean;
  brandHandle: string;
  autoDeleteBasesDays: number;
  recordQuality: 'best' | '720p' | '1080p';
  liveLookback: number;
  /** Seconds to rewind when chat surges, because reactions lag the moment. */
  liveChatLag: number;
  liveAutoClip: boolean;
  liveAutoClipThreshold: number;
  /** Keep the raw session file after a clip project has adopted its own copy. */
  liveKeepRecording: boolean;
  /** Rolling buffer: discard older segments once auto-clip has had its window. */
  liveMomentOnly: boolean;
}

export interface StageLog {
  id: string;
  stage: string;
  status: 'pending' | 'active' | 'done' | 'error';
  message?: string;
  startedAt?: string;
  endedAt?: string;
}

export interface JobProgress {
  projectId?: string;
  liveId?: string;
  stage: string;
  progress: number;
  message: string;
  status?: string;
  clipId?: string;
}

export interface ToastEvent {
  id: string;
  tone: 'success' | 'error' | 'info';
  title: string;
  message?: string;
}

export interface AppEvents {
  'project.updated': ProjectSummary;
  'project.progress': JobProgress;
  'project.log': { projectId: string; level: 'info' | 'warn' | 'error'; message: string };
  'clip.updated': { projectId: string; clip: ClipRecord };
  'live.updated': LiveSession;
  'live.progress': { liveId: string; message: string; progress: number };
  toast: ToastEvent;
  'setup.status': { ready: boolean; missing: string[]; message: string };
  'setup.progress': { tool: string; received: number; total: number; message: string };
}

export interface SystemStatus {
  app: { version: string; uptime: number };
  binaries: {
    ffmpeg: { status: BinStatus; version?: string; path?: string };
    ffprobe: { status: BinStatus; version?: string; path?: string };
    ytdlp: { status: BinStatus; version?: string; path?: string };
    whisper: { status: BinStatus; version?: string; path?: string };
    whisperModel: { status: BinStatus; path?: string; size?: number; name?: string };
    yunet: { status: BinStatus; path?: string };
    fonts: { status: BinStatus; count: number };
  };
  gemini: { configured: boolean; model: string; usage: GeminiUsage; dailyLimit: number };
  storage: { dataDir: string; freeBytes: number; totalBytes: number; usedBytes: number; projects: number };
  cpu: { cores: number; model: string };
}

export interface ClipPresetVisual {
  id: CaptionPresetId;
  name: string;
  tagline: string;
  font: 'poppins' | 'anton' | 'bebas';
  uppercase: boolean;
  box: boolean;
  wordsPerCue: number;
  sample: string;
  textColor: string;
  activeColor: string;
  boxColor: string;
  strokeColor: string;
  css: {
    fontFamily: string;
    fontWeight: number;
    letterSpacing: string;
    textTransform: 'none' | 'uppercase';
    color: string;
    background?: string;
    webkitTextStroke?: string;
    textShadow?: string;
    borderRadius?: string;
    padding?: string;
  };
}

export type PlatformCategory = 'streaming' | 'video' | 'social' | 'local';

export interface PlatformInfo {
  id: PlatformId;
  name: string;
  short: string;
  category: PlatformCategory;
  color: string;
  soft: string;
  hosts: string[];
  kinds: SourceKind[];
  placeholder: string;
  note: string;
}
