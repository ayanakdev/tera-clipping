import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { nanoid } from 'nanoid';
import type {
  AppSettings,
  ClipCandidate,
  ClipRecord,
  ClipSettings,
  HeatPoint,
  PlatformId,
  Project,
  ProjectStatus,
  SourceKind,
  SubtitleCue,
  Word,
} from '../../shared/types';
import { AUTO_CLIP_COUNT, DEFAULT_SETTINGS } from '../../shared/presets';
import { cleanSpokenText } from '../../shared/utils';
import { CONFIG, PATHS, fromData, toData } from '../config';
import { bus } from '../lib/events';
import { log } from '../lib/logger';
import { store } from '../lib/store';
import { analyzeTranscript } from './analyze';
import { analyzeWav, type AudioAnalysis } from './audio';
import { ensureAll, ensureWhisperModel } from './binaries';
import { extractAudioWav, extractFrame, probeMedia } from './media';
import { renderClip, wordsForClip } from './render';
import { warmFaceModel } from './reframe';
import { transcribeProject } from './transcribe';
import { downloadSource } from './ytdlp';

const jobs = new Map<string, { controller: AbortController; kind: 'pipeline' | 'clip'; startedAt: number }>();
const saveMarks = new Map<string, number>();
const renoticing = new Set<string>();

export function projectBusy(projectId: string): boolean {
  return jobs.has(projectId) || renoticing.has(projectId);
}

export function projectJobKind(projectId: string): 'pipeline' | 'clip' | undefined {
  return jobs.get(projectId)?.kind;
}

export function cancelProject(projectId: string): boolean {
  const job = jobs.get(projectId);
  if (!job) return false;
  job.controller.abort();
  return true;
}

export function cancelAllProjects(): void {
  for (const job of jobs.values()) job.controller.abort();
}

async function persist(project: Project, force = false): Promise<void> {
  project.updatedAt = new Date().toISOString();
  bus.emit('project.updated', store.summarize(project));
  if (force) {
    saveMarks.set(project.id, Date.now());
    await store.saveProject(project);
    return;
  }
  const now = Date.now();
  if (now - (saveMarks.get(project.id) || 0) < 2500) return;
  saveMarks.set(project.id, now);
  await store.saveProject(project);
}

function projectLog(project: Project, level: 'info' | 'warn' | 'error', message: string): void {
  project.logs.push({ t: new Date().toISOString(), level, message });
  bus.emit('project.log', { projectId: project.id, level, message });
}

async function setStage(
  project: Project,
  status: ProjectStatus,
  stage: string,
  progress: number,
  message: string,
): Promise<void> {
  project.status = status;
  project.stage = stage;
  project.progress = Math.round(Math.max(0, Math.min(100, progress)));
  project.message = message;
  bus.emit('project.progress', {
    projectId: project.id,
    stage,
    progress: project.progress,
    message,
    status,
  });
  await persist(project, true);
}

function report(project: Project, stage: string, progress: number, message: string, clipId?: string): void {
  project.stage = stage;
  project.progress = Math.round(Math.max(0, Math.min(100, progress)));
  project.message = message;
  bus.emit('project.progress', {
    projectId: project.id,
    stage,
    progress: project.progress,
    message,
    status: project.status,
    clipId,
  });
  bus.emit('project.updated', store.summarize(project));
  void persist(project);
}

export interface CreateProjectInput {
  title?: string;
  channel?: string;
  platform: PlatformId;
  sourceKind: SourceKind;
  sourceUrl?: string;
  /** Absolute path to a local/uploaded file. */
  filePath?: string;
  externalId?: string;
  previewUrl?: string;
  campaignId?: string;
  settings?: Partial<ClipSettings>;
  /** Chat/audio heat captured while recording a live stream. */
  chatHeat?: HeatPoint[];
  /** Do not auto-start the pipeline (used by live capture). */
  defer?: boolean;
  duration?: number;
}

function resolveSettings(partial?: Partial<ClipSettings>): ClipSettings {
  const defaults: AppSettings = store.getSettings() || DEFAULT_SETTINGS;
  const base: ClipSettings = {
    clipCount: defaults.defaultClipCount,
    minDuration: defaults.defaultMinDuration,
    maxDuration: defaults.defaultMaxDuration,
    aspect: defaults.defaultAspect,
    captionPreset: defaults.defaultCaptionPreset,
    captionScale: defaults.defaultCaptionScale ?? 1,
    hookStyle: defaults.defaultHookStyle,
    pacing: defaults.defaultPacing,
    reframe: defaults.defaultReframe,
    quality: defaults.defaultQuality,
    aiMode: defaults.defaultAiMode,
    asrModel: defaults.defaultAsrModel,
    language: defaults.asrLanguage,
    audioEnhance: false,
    watermark: defaults.watermark,
  };
  const merged = { ...base, ...(partial || {}) };
  merged.clipCount = Math.max(AUTO_CLIP_COUNT, Math.min(10, Math.round(merged.clipCount)));
  merged.minDuration = Math.max(5, Math.min(180, merged.minDuration));
  merged.maxDuration = Math.max(merged.minDuration + 2, Math.min(240, merged.maxDuration));
  merged.captionScale = Math.max(0.6, Math.min(1.6, Number(merged.captionScale) || 1));
  return merged;
}

async function adoptSource(projectDir: string, sourcePath: string): Promise<string> {
  const extension = (path.extname(sourcePath) || '.mp4').toLowerCase();
  const dest = path.join(projectDir, `source${extension}`);
  if (path.resolve(sourcePath) === path.resolve(dest)) return dest;
  await fsp.mkdir(projectDir, { recursive: true });
  try {
    await fsp.rename(sourcePath, dest);
  } catch {
    await fsp.copyFile(sourcePath, dest);
    await fsp.rm(sourcePath, { force: true }).catch(() => undefined);
  }
  return dest;
}

export async function createProject(input: CreateProjectInput): Promise<Project> {
  const id = `proj_${nanoid(10)}`;
  const projectDir = path.join(PATHS.projects, id);
  await fsp.mkdir(projectDir, { recursive: true });
  const now = new Date().toISOString();
  const settings = resolveSettings(input.settings);
  let sourceAbs = '';
  if (input.filePath) {
    sourceAbs = await adoptSource(projectDir, input.filePath);
  }
  const fallbackTitle = input.filePath ? path.basename(input.filePath, path.extname(input.filePath)) : 'Untitled stream';
  const project: Project = {
    id,
    title: (input.title || fallbackTitle).trim().slice(0, 140) || 'Untitled stream',
    channel: input.channel?.slice(0, 80),
    platform: input.platform,
    sourceKind: input.sourceKind,
    sourceUrl: input.sourceUrl,
    sourcePath: sourceAbs ? toData(sourceAbs) : '',
    thumbnailPath: undefined,
    previewUrl: input.previewUrl,
    externalId: input.externalId,
    duration: input.duration || 0,
    campaignId: input.campaignId,
    status: 'queued',
    stage: 'queued',
    progress: 0,
    message: input.filePath ? 'File ready — waiting to start.' : 'Waiting for the source.',
    settings,
    clips: [],
    logs: [],
    createdAt: now,
    updatedAt: now,
  };
  projectLog(project, 'info', input.filePath ? 'Uploaded source adopted.' : 'Project created from link.');
  if (input.chatHeat?.length) {
    await fsp.writeFile(path.join(projectDir, 'chat-heat.json'), JSON.stringify(input.chatHeat), 'utf8');
    projectLog(project, 'info', `Loaded ${input.chatHeat.length} live chat heat points.`);
  }
  await store.saveProject(project);
  void store.recordStudio({ projectsCreated: 1 });
  bus.emit('project.updated', store.summarize(project));
  bus.emit('toast', {
    id: nanoid(8),
    tone: 'success',
    title: 'Project created',
    message: project.title,
  });
  if (!input.defer) startProject(project.id);
  return project;
}

export function startProject(projectId: string): void {
  if (jobs.has(projectId)) throw new Error('This project is already working. Wait for it to finish or cancel it.');
  const controller = new AbortController();
  jobs.set(projectId, { controller, kind: 'pipeline', startedAt: Date.now() });
  warmFaceModel();
  void runPipeline(projectId, controller.signal)
    .catch(async (error) => {
      log.error(`project ${projectId} failed`, error);
      const project = await store.getProject(projectId);
      if (!project) return;
      if ((error as Error).name === 'AbortError') {
        project.status = 'cancelled';
        project.stage = 'cancelled';
        project.message = 'Cancelled.';
        for (const clip of project.clips) {
          if (clip.status === 'rendering' || clip.status === 'planned') {
            clip.status = 'cancelled';
            clip.stage = 'cancelled';
          }
        }
      } else {
        project.status = 'failed';
        project.stage = 'failed';
        project.error = (error as Error).message;
        project.message = (error as Error).message;
        projectLog(project, 'error', (error as Error).message);
      }
      await persist(project, true);
    })
    .finally(() => {
      jobs.delete(projectId);
    });
}

async function ensureSource(project: Project, signal: AbortSignal): Promise<string> {
  if (!project.sourcePath) {
    if (!project.sourceUrl) throw new Error('This project has no video source.');
    const settings = store.getSettings();
    const projectDir = path.join(PATHS.projects, project.id);
    await setStage(project, 'importing', 'importing', 2, 'Downloading the source video…');
    const file = await downloadSource(project.sourceUrl, projectDir, settings, {
      signal,
      onProgress: (percent, message) => report(project, 'importing', 2 + percent * 0.12, message),
    });
    project.sourcePath = toData(file);
    await persist(project, true);
  }
  const abs = fromData(project.sourcePath);
  if (!fs.existsSync(abs)) throw new Error('The source file is missing from the project folder.');
  return abs;
}

async function runPipeline(projectId: string, signal: AbortSignal): Promise<void> {
  const project = await store.getProject(projectId);
  if (!project) throw new Error('Project not found');
  project.status = 'importing';
  project.error = undefined;
  project.message = 'Preparing the source…';
  project.stage = 'importing';
  project.progress = 1;
  bus.emit('project.updated', store.summarize(project));
  const startedAt = new Date().toISOString();
  project.stats = {
    geminiCalls: 0,
    cachedCalls: 0,
    candidates: 0,
    words: 0,
    analysisEngine: 'pending',
    startedAt,
  };
  // Replanning replaces the clip set. Wipe the clips folder so old renders,
  // orphaned files from earlier plans and stale hook PNGs cannot eat disk
  // space. The source file lives in the project root, not here.
  project.clips = [];
  await fsp
    .rm(path.join(PATHS.projects, projectId, 'clips'), { recursive: true, force: true })
    .catch(() => undefined);
  await persist(project, true);

  const sourceAbs = await ensureSource(project, signal);
  const projectDir = path.dirname(sourceAbs);

  await setStage(project, 'importing', 'importing', 15, 'Reading video details…');
  const probe = await probeMedia(sourceAbs);
  if (!probe.hasVideo) throw new Error('That file does not contain a video stream.');
  if (!probe.duration || probe.duration < 3) throw new Error('This source is too short to clip.');
  project.duration = probe.duration;
  project.width = probe.displayWidth;
  project.height = probe.displayHeight;
  project.fps = probe.fps;
  projectLog(project, 'info', `Source: ${probe.displayWidth}×${probe.displayHeight} · ${probe.duration.toFixed(1)}s`);
  await persist(project, true);

  await setStage(project, 'importing', 'importing', 18, 'Making a poster frame…');
  const thumbnailAbs = path.join(projectDir, 'thumb.jpg');
  try {
    await extractFrame(sourceAbs, Math.min(probe.duration * 0.08, 8), thumbnailAbs, 640, signal);
    project.thumbnailPath = toData(thumbnailAbs);
  } catch (error) {
    log.warn('thumbnail failed', (error as Error).message);
  }
  await persist(project, true);

  if (!probe.hasAudio) throw new Error('This video has no audio track, so there is no speech to caption.');

  const audioAbs = path.join(projectDir, 'audio.wav');
  let audioAnalysis: AudioAnalysis | null = null;
  const analysisFile = path.join(projectDir, 'audio-analysis.json');
  if (fs.existsSync(audioAbs) && fs.statSync(audioAbs).size > 1000) {
    if (fs.existsSync(analysisFile)) {
      try {
        audioAnalysis = JSON.parse(await fsp.readFile(analysisFile, 'utf8')) as AudioAnalysis;
      } catch {
        audioAnalysis = null;
      }
    }
  } else {
    await setStage(project, 'transcribing', 'transcribing', 20, 'Extracting clean speech audio…');
    await extractAudioWav(sourceAbs, audioAbs, probe.duration, signal);
  }

  if (!audioAnalysis) {
    report(project, 'transcribing', 24, 'Listening for energy spikes…');
    try {
      audioAnalysis = await analyzeWav(audioAbs, 0.5);
      await fsp.writeFile(analysisFile, JSON.stringify(audioAnalysis), 'utf8');
    } catch (error) {
      log.warn('audio analysis failed', (error as Error).message);
    }
  }

  await setStage(project, 'transcribing', 'transcribing', 28, 'Checking local speech engine…');
  await ensureWhisperModel(project.settings.asrModel);
  const settings = store.getSettings();
  const { transcript, cached } = await transcribeProject({
    audioPath: audioAbs,
    duration: probe.duration,
    projectId: project.id,
    projectDir,
    settings: project.settings,
    threads: settings.asrThreads || CONFIG.asrThreads,
    signal,
    onProgress: (progress, message) => report(project, 'transcribing', 28 + progress * 27, message),
  });
  project.stats.words = transcript.words.length;
  projectLog(project, 'info', `${cached ? 'Reused' : 'Created'} transcript with ${transcript.words.length} words.`);
  await setStage(project, 'analyzing', 'analyzing', 57, cached ? 'Using the cached transcript.' : 'Transcript ready.');

  let chatHeat: HeatPoint[] | undefined;
  try {
    const chatHeatFile = path.join(projectDir, 'chat-heat.json');
    if (fs.existsSync(chatHeatFile)) {
      chatHeat = JSON.parse(await fsp.readFile(chatHeatFile, 'utf8')) as HeatPoint[];
    }
  } catch {
    chatHeat = undefined;
  }

  const analysis = await analyzeTranscript({
    transcript,
    duration: probe.duration,
    settings: project.settings,
    platform: project.platform,
    audio: audioAnalysis,
    chatHeat,
    signal,
    onProgress: (progress, message) => report(project, 'analyzing', 57 + progress * 0.1, message),
  });

  project.stats.geminiCalls = analysis.geminiCalls;
  project.stats.cachedCalls = analysis.cachedCalls;
  project.stats.candidates = analysis.pool;
  project.stats.analysisEngine = analysis.engine;
  projectLog(
    project,
    'info',
    `${analysis.engine}: ${analysis.candidates.length} highlight(s) from ${analysis.pool} candidates${
      analysis.failures ? ' (Gemini fallback)' : ''
    }.`,
  );

  await setStage(project, 'planning', 'planning', 68, 'Building caption timelines…');
  project.clips = analysis.candidates.map((candidate, index) =>
    buildClip(project, candidate, index, transcript.words, probe.duration),
  );
  void store.recordStudio({ clipsPlanned: project.clips.length });
  project.status = 'rendering';
  await persist(project, true);

  const total = project.clips.length;
  let rendered = 0;
  for (let i = 0; i < total; i++) {
    if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
    const clip = project.clips[i]!;
    const slotBase = 70 + (i / total) * 29;
    const slotSpan = 29 / total;
    clip.status = 'rendering';
    clip.stage = 'preparing';
    clip.progress = 1;
    clip.error = undefined;
    bus.emit('clip.updated', { projectId: project.id, clip: { ...clip } });
    bus.emit('project.updated', store.summarize(project));
    try {
      const result = await renderClip({
        clip,
        sourcePath: sourceAbs,
        projectDir,
        words: clip.words,
        aspect: project.settings.aspect,
        quality: project.settings.quality,
        audioEnhance: project.settings.audioEnhance,
        watermark: project.settings.watermark,
        brandHandle: store.getSettings().brandHandle,
        sourceWidth: probe.displayWidth,
        sourceHeight: probe.displayHeight,
        fps: probe.fps,
        acceleration: settings.renderAcceleration,
        signal,
        onProgress: (progress, stage) => {
          clip.progress = Math.round(progress);
          clip.stage = stage;
          bus.emit('clip.updated', { projectId: project.id, clip: { ...clip } });
          report(project, 'rendering', slotBase + (progress / 100) * slotSpan, `${stage} · clip ${i + 1} of ${total}`, clip.id);
        },
      });
      clip.files = result.files;
      clip.faceSamples = result.faceSamples;
      clip.notice = result.notice;
      clip.pipRect = result.pipRect;
      clip.status = 'ready';
      clip.stage = 'ready';
      clip.progress = 100;
      clip.duration = Math.round(result.duration * 100) / 100;
      clip.renderMs = result.renderMs;
      rendered += 1;
      void store.recordStudio({ rendersCompleted: 1, secondsRendered: clip.duration });
      if (result.notice) projectLog(project, 'info', `Clip ${i + 1}: ${result.notice.reason}`);
      projectLog(project, 'info', `Clip ${i + 1} ready in ${(result.renderMs / 1000).toFixed(1)}s.`);
      bus.emit('clip.updated', { projectId: project.id, clip: { ...clip } });
      await persist(project, true);
    } catch (error) {
      if ((error as Error).name === 'AbortError') throw error;
      clip.status = 'failed';
      clip.stage = 'failed';
      clip.error = (error as Error).message;
      projectLog(project, 'error', `Clip ${i + 1} failed: ${(error as Error).message}`);
      await persist(project, true);
    }
  }

  if (rendered === 0) {
    throw new Error('Every clip failed to render. Check the project log for the ffmpeg error.');
  }
  project.status = 'ready';
  project.stage = 'ready';
  project.progress = 100;
  project.message = `${rendered} clip${rendered === 1 ? '' : 's'} ready to post.`;
  project.stats.finishedAt = new Date().toISOString();
  projectLog(project, 'info', project.message);
  await persist(project, true);
  bus.emit('toast', {
    id: nanoid(8),
    tone: 'success',
    title: `${rendered} clip${rendered === 1 ? '' : 's'} ready`,
    message: project.title,
  });
}

function trimToSpeech(
  transcriptWords: Word[],
  candidate: ClipCandidate,
  pacing: ClipSettings['pacing'],
  duration: number,
): { start: number; end: number; removed: number } {
  if (pacing === 'original') return { start: candidate.start, end: candidate.end, removed: 0 };
  const inRange = transcriptWords.filter((word) => word.end > candidate.start + 0.01 && word.start < candidate.end - 0.01);
  if (!inRange.length) return { start: candidate.start, end: candidate.end, removed: 0 };
  const first = inRange[0]!;
  const last = inRange[inRange.length - 1]!;
  const tight = pacing === 'tight';
  const pre = tight ? 0.12 : 0.2;
  const post = tight ? 0.24 : 0.36;
  const leadGap = first.start - candidate.start;
  const tailGap = candidate.end - last.end;
  let start = leadGap > (tight ? 0.22 : 0.45) ? Math.max(candidate.start, first.start - pre) : candidate.start;
  let end = tailGap > (tight ? 0.3 : 0.55) ? Math.min(candidate.end, last.end + post) : candidate.end;
  if (end - start < 5) {
    start = candidate.start;
    end = Math.min(duration, Math.max(candidate.end, start + 5));
  }
  return {
    start: Math.round(start * 100) / 100,
    end: Math.round(end * 100) / 100,
    removed: Math.max(0, candidate.end - candidate.start - (end - start)),
  };
}

function buildClip(
  project: Project,
  candidate: ClipCandidate,
  index: number,
  transcriptWords: Word[],
  duration: number,
): ClipRecord {
  const trimmed = trimToSpeech(transcriptWords, candidate, project.settings.pacing, duration);
  const words = wordsForClip(transcriptWords, trimmed.start, trimmed.end);
  const now = new Date().toISOString();
  return {
    id: `clip_${nanoid(9)}`,
    projectId: project.id,
    index,
    start: trimmed.start,
    end: trimmed.end,
    duration: Math.round((trimmed.end - trimmed.start) * 100) / 100,
    title: candidate.title,
    hook: candidate.hook,
    hooks: candidate.hooks,
    caption: candidate.caption,
    hashtags: candidate.hashtags,
    transcript: words.map((word) => word.text).join(' '),
    words,
    score: candidate.score,
    scoreParts: candidate.scoreParts,
    reason: candidate.reason,
    category: candidate.category,
    source: candidate.source,
    status: 'planned',
    progress: 0,
    stage: 'queued',
    captionPreset: project.settings.captionPreset,
    captionScale: project.settings.captionScale,
    hookStyle: project.settings.hookStyle,
    framing: project.settings.reframe,
    files: {},
    removedSilence: Math.round(trimmed.removed * 10) / 10,
    createdAt: now,
    updatedAt: now,
  };
}

function normalizeSubtitles(input: SubtitleCue[], duration: number): SubtitleCue[] {
  const cues = input
    .map((cue) => ({
      start: Math.max(0, Math.min(duration, Number(cue?.start) || 0)),
      end: Math.max(0, Math.min(duration, Number(cue?.end) || 0)),
      text: cleanSpokenText(String(cue?.text || '')).slice(0, 240),
    }))
    .filter((cue) => cue.text.length > 0)
    .sort((a, b) => a.start - b.start);
  const out: SubtitleCue[] = [];
  for (const cue of cues) {
    if (cue.end <= cue.start + 0.15) cue.end = Math.min(duration, cue.start + Math.max(0.8, cue.text.split(/\s+/).length * 0.32));
    const previous = out[out.length - 1];
    if (previous && cue.start < previous.end) cue.start = previous.end;
    if (cue.end <= cue.start + 0.1) continue;
    out.push({
      start: Math.round(cue.start * 100) / 100,
      end: Math.round(cue.end * 100) / 100,
      text: cue.text,
    });
  }
  return out.slice(0, 300);
}

export interface ClipEdit {
  title?: string;
  hook?: string;
  hookStyle?: ClipSettings['hookStyle'];
  captionPreset?: ClipSettings['captionPreset'];
  captionScale?: number;
  caption?: string;
  hashtags?: string[];
  /** Full replacement for the burned subtitle rows, relative to the clip. */
  subtitles?: SubtitleCue[];
  framing?: ClipSettings['reframe'];
  start?: number;
  end?: number;
  starred?: boolean;
}

export async function editClip(
  projectId: string,
  clipId: string,
  patch: ClipEdit,
  mode: 'auto' | 'always' = 'auto',
): Promise<ClipRecord> {
  if (jobs.has(projectId)) throw new Error('Wait for the current render to finish before editing this clip.');
  const project = await store.getProject(projectId);
  if (!project) throw new Error('Project not found');
  const clip = project.clips.find((item) => item.id === clipId);
  if (!clip) throw new Error('Clip not found');
  const transcriptPath = path.join(PATHS.projects, projectId, 'transcript.json');
  const transcript = JSON.parse(await fsp.readFile(transcriptPath, 'utf8')) as { words: Word[] };

  const oldStart = clip.start;
  const oldEnd = clip.end;
  if (patch.start !== undefined) clip.start = Math.max(0, Math.min(project.duration - 2, patch.start));
  if (patch.end !== undefined) clip.end = Math.max(clip.start + 3, Math.min(project.duration, patch.end));
  if (clip.end - clip.start > project.settings.maxDuration + 5) {
    clip.end = clip.start + project.settings.maxDuration + 5;
  }
  const boundariesChanged = clip.start !== oldStart || clip.end !== oldEnd;
  if (boundariesChanged) {
    clip.words = wordsForClip(transcript.words, clip.start, clip.end);
    clip.transcript = clip.words.map((word) => word.text).join(' ');
    clip.duration = Math.round((clip.end - clip.start) * 100) / 100;
    clip.faceSamples = undefined;
    clip.notice = undefined;
    clip.pipRect = undefined;
  }
  if (patch.title !== undefined) clip.title = patch.title.slice(0, 120);
  if (patch.hook !== undefined) clip.hook = patch.hook.slice(0, 120);
  if (patch.hookStyle !== undefined) clip.hookStyle = patch.hookStyle;
  if (patch.captionPreset !== undefined) clip.captionPreset = patch.captionPreset;
  if (patch.captionScale !== undefined) {
    clip.captionScale = Math.max(0.6, Math.min(1.6, Number(patch.captionScale) || 1));
  }
  if (patch.caption !== undefined) clip.caption = patch.caption.slice(0, 240);
  if (patch.hashtags !== undefined) clip.hashtags = patch.hashtags.slice(0, 8);
  if (patch.subtitles !== undefined) {
    clip.subtitles = normalizeSubtitles(patch.subtitles, clip.end - clip.start);
  } else if (boundariesChanged) {
    // Old subtitle times no longer line up after trimming, so fall back to the
    // freshly cut words.
    clip.subtitles = undefined;
  }
  if (patch.framing !== undefined) {
    clip.framing = patch.framing;
    clip.faceSamples = undefined;
    clip.notice = undefined;
    clip.pipRect = undefined;
  }
  if (patch.starred !== undefined) clip.starred = patch.starred;

  const framingChanged = patch.framing !== undefined || boundariesChanged;
  const visualChanged =
    patch.hook !== undefined ||
    patch.hookStyle !== undefined ||
    patch.captionPreset !== undefined ||
    patch.captionScale !== undefined ||
    patch.subtitles !== undefined ||
    patch.framing !== undefined ||
    boundariesChanged;
  const shouldRender = mode === 'always' || visualChanged;
  if (!shouldRender) {
    clip.updatedAt = new Date().toISOString();
    await store.saveProject(project);
    bus.emit('clip.updated', { projectId, clip: { ...clip } });
    bus.emit('project.updated', store.summarize(project));
    return clip;
  }
  const controller = new AbortController();
  jobs.set(projectId, { controller, kind: 'clip', startedAt: Date.now() });
  clip.status = 'rendering';
  clip.stage = 'preparing';
  clip.progress = 1;
  clip.error = undefined;
  repoEmit(project, clip);
  await store.saveProject(project);

  void (async () => {
    const sourceAbs = fromData(project.sourcePath);
    const probe = await probeMedia(sourceAbs);
    const result = await renderClip({
      clip,
      sourcePath: sourceAbs,
      projectDir: path.dirname(sourceAbs),
      words: clip.words,
      aspect: project.settings.aspect,
      quality: project.settings.quality,
      audioEnhance: project.settings.audioEnhance,
      watermark: project.settings.watermark,
      brandHandle: store.getSettings().brandHandle,
      sourceWidth: probe.displayWidth,
      sourceHeight: probe.displayHeight,
      fps: probe.fps,
      acceleration: store.getSettings().renderAcceleration,
      reuseFraming: !framingChanged,
      signal: controller.signal,
      onProgress: (progress, stage) => {
        clip.progress = Math.round(progress);
        clip.stage = stage;
        bus.emit('clip.updated', { projectId, clip: { ...clip } });
        bus.emit('project.progress', {
          projectId,
          stage: 'rendering',
          progress,
          message: `Re-rendering “${clip.title}” · ${stage}`,
          clipId: clip.id,
        });
      },
    });
    clip.files = result.files;
    clip.faceSamples = result.faceSamples;
    if (result.notice) clip.notice = result.notice;
    clip.pipRect = result.pipRect;
    clip.status = 'ready';
    clip.stage = 'ready';
    clip.progress = 100;
    clip.renderMs = result.renderMs;
    void store.recordStudio({ rendersCompleted: 1, secondsRendered: clip.duration });
    const fresh = await store.getProject(projectId);
    if (fresh) {
      const target = fresh.clips.find((item) => item.id === clip.id);
      if (target) Object.assign(target, clip);
      await store.saveProject(fresh);
      bus.emit('project.updated', store.summarize(fresh));
    }
    bus.emit('clip.updated', { projectId, clip: { ...clip } });
    bus.emit('toast', { id: nanoid(8), tone: 'success', title: 'Clip re-rendered', message: clip.title });
  })()
    .catch(async (error) => {
      log.error(`clip rerender failed ${clip.id}`, error);
      const fresh = await store.getProject(projectId);
      if (fresh) {
        const target = fresh.clips.find((item) => item.id === clip.id);
        if (target) {
          target.status = 'failed';
          target.stage = 'failed';
          target.error = (error as Error).message;
        }
        await store.saveProject(fresh);
        bus.emit('project.updated', store.summarize(fresh));
      }
    })
    .finally(() => {
      jobs.delete(projectId);
    });

  return clip;
}

function repoEmit(project: Project, clip: ClipRecord): void {
  bus.emit('clip.updated', { projectId: project.id, clip: { ...clip } });
  bus.emit('project.updated', store.summarize(project));
}

export async function deleteProjectCascade(projectId: string): Promise<void> {
  const job = jobs.get(projectId);
  if (job) {
    job.controller.abort();
    const deadline = Date.now() + 20_000;
    while (jobs.has(projectId) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  await store.deleteProject(projectId);
  bus.emit('toast', { id: nanoid(8), tone: 'info', title: 'Project deleted' });
}

export async function deleteClip(projectId: string, clipId: string): Promise<void> {
  if (jobs.has(projectId)) throw new Error('Wait for the current render to finish before deleting a clip.');
  const project = await store.getProject(projectId);
  if (!project) throw new Error('Project not found');
  const clip = project.clips.find((item) => item.id === clipId);
  if (!clip) throw new Error('Clip not found');
  for (const relative of Object.values(clip.files)) {
    if (!relative) continue;
    await fsp.rm(fromData(relative), { force: true }).catch(() => undefined);
  }
  project.clips = project.clips.filter((item) => item.id !== clipId);
  project.clips.forEach((item, index) => {
    item.index = index;
  });
  await store.saveProject(project);
  bus.emit('project.updated', store.summarize(project));
}

/** Re-plan clips from the cached transcript without re-downloading or re-transcribing. */
export async function replanProject(projectId: string, settings?: Partial<ClipSettings>): Promise<Project> {
  if (projectBusy(projectId)) throw new Error('This project is busy.');
  const project = await store.getProject(projectId);
  if (!project) throw new Error('Project not found');
  if (settings) project.settings = resolveSettings({ ...project.settings, ...settings });
  await store.saveProject(project);
  startProject(projectId);
  return project;
}

/**
 * Re-check the layout of every finished clip with Auto framing and re-render it.
 * Projects made before Auto existed (or with a forced split) get their duplicate
 * facecam panels replaced with a single tracked crop.
 */
export async function renoticeProject(projectId: string): Promise<{ queued: number }> {
  if (projectBusy(projectId)) throw new Error('This project is busy.');
  const project = await store.getProject(projectId);
  if (!project) throw new Error('Project not found');
  const clips = project.clips.filter((clip) => clip.status === 'ready');
  if (!clips.length) throw new Error('There are no finished clips to re-notice yet.');

  renoticing.add(projectId);
  project.settings.reframe = 'auto';
  projectLog(
    project,
    'info',
    `Re-noticing framing for ${clips.length} clip${clips.length === 1 ? '' : 's'} with Auto…`,
  );
  await store.saveProject(project);
  bus.emit('project.updated', store.summarize(project));

  void (async () => {
    const waitForIdle = async () => {
      const deadline = Date.now() + 15 * 60_000;
      while (jobs.has(projectId) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
    };
    try {
      for (const clip of clips) {
        await waitForIdle();
        const fresh = await store.getProject(projectId);
        const target = fresh?.clips.find((item) => item.id === clip.id);
        if (!fresh || !target || target.status !== 'ready') continue;
        try {
          await editClip(projectId, clip.id, { framing: 'auto' }, 'always');
        } catch (error) {
          log.error(`re-notice failed ${clip.id}`, error);
          projectLog(
            fresh,
            'warn',
            `Clip ${clip.index + 1} could not be re-noticed: ${(error as Error).message}`,
          );
          await store.saveProject(fresh);
        }
      }
      await waitForIdle();
      const done = await store.getProject(projectId);
      if (!done) return;
      const single = done.clips.filter((clip) => clip.notice?.kind === 'single-cam').length;
      const split = done.clips.filter((clip) => clip.notice?.kind === 'game-cam').length;
      projectLog(done, 'info', `Framing re-noticed: ${single} single cam, ${split} game + cam.`);
      await store.saveProject(done);
      bus.emit('project.updated', store.summarize(done));
      bus.emit('toast', {
        id: nanoid(8),
        tone: 'success',
        title: 'Framing re-noticed',
        message: `${done.clips.length} clip${done.clips.length === 1 ? '' : 's'} rendered with Auto.`,
      });
    } finally {
      renoticing.delete(projectId);
    }
  })();

  return { queued: clips.length };
}

/** Mark work that was cut off by a server restart so the UI never shows a ghost job. */
export async function recoverInterruptedProjects(): Promise<void> {
  for (const summary of store.listProjects()) {
    if (['ready', 'failed', 'cancelled'].includes(summary.status)) continue;
    const project = await store.getProject(summary.id);
    if (!project) continue;
    project.status = 'failed';
    project.stage = 'failed';
    project.error = 'Interrupted by a server restart. Press Retry to continue.';
    project.message = project.error;
    for (const clip of project.clips) {
      if (clip.status === 'rendering' || clip.status === 'planned') {
        clip.status = 'failed';
        clip.stage = 'interrupted';
        clip.error = 'Interrupted by a restart.';
      }
    }
    await store.saveProject(project);
    bus.emit('project.updated', store.summarize(project));
  }
}

export async function bootstrapTools(): Promise<void> {
  try {
    const ready = await ensureAll(false);
    if (!ready) log.warn('some local tools are missing; run npm run setup');
  } catch (error) {
    log.warn('tool check failed', error);
  }
}
