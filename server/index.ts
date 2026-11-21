import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { pipeline as streamPipeline } from 'node:stream/promises';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import archiver from 'archiver';
import { nanoid } from 'nanoid';
import type {
  AppSettings,
  Campaign,
  ClipFiles,
  ClipRecord,
  ClipSettings,
  LibraryClip,
  PlatformId,
  SourceKind,
  Submission,
  SystemStatus,
} from '../shared/types';
import { ASPECT_SIZES, AUTO_CLIP_COUNT, CAPTION_PRESETS, DEFAULT_SETTINGS, HOOK_STYLES } from '../shared/presets';
import { PLATFORMS, detectPlatform, guessSourceKind } from '../shared/platforms';
import { CONFIG, PATHS, fromData, mediaUrl } from './config';
import { bus } from './lib/events';
import { log } from './lib/logger';
import { store } from './lib/store';
import { inspectTools, ensureAll, getBinaries, getToolVersions, updateYtdlp } from './services/binaries';
import {
  cancelProject,
  cancelAllProjects,
  createProject,
  deleteClip,
  deleteProjectCascade,
  editClip,
  projectBusy,
  recoverInterruptedProjects,
  renoticeProject,
  replanProject,
  startProject,
} from './services/pipeline';
import { resolveSource } from './services/ytdlp';
import {
  addCreator,
  creatorsWithStatus,
  recordCreator,
  removeCreator,
} from './services/creators';
import {
  activeLiveSession,
  createClipsFromLive,
  deleteLive,
  liveBusy,
  markInterruptedLive,
  recordingPath,
  resolveLive,
  setLiveAutoClip,
  startLive,
  stopLive,
} from './services/live';

class HttpError extends Error {
  statusCode: number;
  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
  }
}

const ASPECTS = ['9:16', '1:1', '16:9'] as const;
const CAPTION_IDS = new Set(CAPTION_PRESETS.map((preset) => preset.id));
const HOOK_IDS = new Set(HOOK_STYLES.map((style) => style.id));
const AI_MODES = new Set(['smart', 'full', 'off']);
const PACING = new Set(['original', 'balanced', 'tight']);
const QUALITY = new Set(['fast', 'balanced', 'high']);
const REFRAME = new Set(['auto', 'smart', 'split', 'split-cam-top', 'center', 'blur']);
const ASR = new Set(['base.en', 'base', 'small.en', 'tiny.en']);
const PLATFORM_IDS = new Set(PLATFORMS.map((platform) => platform.id));

/**
 * Service code signals user-facing failures with plain Errors (not live, busy,
 * bad link). Those are not server faults, so they must not surface as a 500.
 */
async function asHttp<T>(task: () => Promise<T>, fallback = 400): Promise<T> {
  try {
    return await task();
  } catch (error) {
    if (error instanceof HttpError) throw error;
    const message = (error as Error)?.message || 'That request could not be completed.';
    const busy = /already (running|working|busy)|is busy|already on your/i.test(message);
    throw new HttpError(busy ? 409 : fallback, message);
  }
}

function number(value: unknown): number | undefined {
  const parsed = typeof value === 'string' ? Number(value) : typeof value === 'number' ? value : NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}

function cleanSettings(raw: unknown): Partial<ClipSettings> {
  if (!raw || typeof raw !== 'object') return {};
  const body = raw as Record<string, unknown>;
  const out: Partial<ClipSettings> = {};
  const count = number(body.clipCount);
  if (count !== undefined) out.clipCount = Math.max(AUTO_CLIP_COUNT, Math.min(10, Math.round(count)));
  const min = number(body.minDuration);
  if (min !== undefined) out.minDuration = Math.max(5, Math.min(180, Math.round(min)));
  const max = number(body.maxDuration);
  if (max !== undefined) out.maxDuration = Math.max(6, Math.min(240, Math.round(max)));
  if (typeof body.aspect === 'string' && (ASPECTS as readonly string[]).includes(body.aspect)) {
    out.aspect = body.aspect as ClipSettings['aspect'];
  }
  if (typeof body.captionPreset === 'string' && CAPTION_IDS.has(body.captionPreset as ClipSettings['captionPreset'])) {
    out.captionPreset = body.captionPreset as ClipSettings['captionPreset'];
  }
  const captionScale = number(body.captionScale);
  if (captionScale !== undefined) {
    out.captionScale = Math.round(Math.max(0.6, Math.min(1.6, captionScale)) * 100) / 100;
  }
  if (typeof body.hookStyle === 'string' && HOOK_IDS.has(body.hookStyle as ClipSettings['hookStyle'])) {
    out.hookStyle = body.hookStyle as ClipSettings['hookStyle'];
  }
  if (typeof body.pacing === 'string' && PACING.has(body.pacing)) out.pacing = body.pacing as ClipSettings['pacing'];
  if (typeof body.reframe === 'string' && REFRAME.has(body.reframe)) out.reframe = body.reframe as ClipSettings['reframe'];
  if (typeof body.quality === 'string' && QUALITY.has(body.quality)) out.quality = body.quality as ClipSettings['quality'];
  if (typeof body.aiMode === 'string' && AI_MODES.has(body.aiMode)) out.aiMode = body.aiMode as ClipSettings['aiMode'];
  if (typeof body.asrModel === 'string' && ASR.has(body.asrModel)) out.asrModel = body.asrModel as ClipSettings['asrModel'];
  if (typeof body.language === 'string') out.language = body.language.slice(0, 12);
  if (typeof body.audioEnhance === 'boolean') out.audioEnhance = body.audioEnhance;
  if (typeof body.watermark === 'boolean') out.watermark = body.watermark;
  if (out.minDuration !== undefined && out.maxDuration !== undefined && out.maxDuration < out.minDuration + 2) {
    out.maxDuration = out.minDuration + 2;
  }
  return out;
}

function cleanAppSettings(raw: unknown): Partial<AppSettings> {
  if (!raw || typeof raw !== 'object') return {};
  const body = raw as Record<string, unknown>;
  const out: Partial<AppSettings> = {};
  const clip = cleanSettings(body);
  if (clip.clipCount !== undefined) out.defaultClipCount = clip.clipCount;
  if (clip.minDuration !== undefined) out.defaultMinDuration = clip.minDuration;
  if (clip.maxDuration !== undefined) out.defaultMaxDuration = clip.maxDuration;
  if (clip.aspect !== undefined) out.defaultAspect = clip.aspect;
  if (clip.captionPreset !== undefined) out.defaultCaptionPreset = clip.captionPreset;
  if (clip.captionScale !== undefined) out.defaultCaptionScale = clip.captionScale;
  if (clip.hookStyle !== undefined) out.defaultHookStyle = clip.hookStyle;
  if (clip.pacing !== undefined) out.defaultPacing = clip.pacing;
  if (clip.quality !== undefined) out.defaultQuality = clip.quality;
  if (typeof body.renderAcceleration === 'string' && ['auto', 'cpu'].includes(body.renderAcceleration)) {
    out.renderAcceleration = body.renderAcceleration as AppSettings['renderAcceleration'];
  }
  if (clip.reframe !== undefined) out.defaultReframe = clip.reframe;
  if (clip.aiMode !== undefined) out.defaultAiMode = clip.aiMode;
  if (clip.asrModel !== undefined) out.defaultAsrModel = clip.asrModel;
  if (clip.language !== undefined) out.asrLanguage = clip.language;
  if (typeof body.watermark === 'boolean') out.watermark = body.watermark;
  const threads = number(body.asrThreads);
  if (threads !== undefined) out.asrThreads = Math.max(0, Math.min(16, Math.round(threads)));
  if (typeof body.geminiModel === 'string') out.geminiModel = body.geminiModel.slice(0, 60);
  const limit = number(body.geminiDailyLimit);
  if (limit !== undefined) out.geminiDailyLimit = Math.max(0, Math.min(500, Math.round(limit)));
  if (typeof body.cookiesBrowser === 'string') out.cookiesBrowser = body.cookiesBrowser.slice(0, 40);
  if (typeof body.cookiesFile === 'string') out.cookiesFile = body.cookiesFile.slice(0, 400);
  if (typeof body.brandHandle === 'string') out.brandHandle = body.brandHandle.slice(0, 40);
  const retention = number(body.autoDeleteBasesDays);
  if (retention !== undefined) out.autoDeleteBasesDays = Math.max(0, Math.min(120, Math.round(retention)));
  if (typeof body.recordQuality === 'string' && ['best', '720p', '1080p'].includes(body.recordQuality)) {
    out.recordQuality = body.recordQuality as AppSettings['recordQuality'];
  }
  const lookback = number(body.liveLookback);
  if (lookback !== undefined) out.liveLookback = Math.max(15, Math.min(300, Math.round(lookback)));
  const chatLag = number(body.liveChatLag);
  if (chatLag !== undefined) out.liveChatLag = Math.max(0, Math.min(45, Math.round(chatLag)));
  if (typeof body.liveAutoClip === 'boolean') out.liveAutoClip = body.liveAutoClip;
  const threshold = number(body.liveAutoClipThreshold);
  if (threshold !== undefined) out.liveAutoClipThreshold = Math.max(40, Math.min(95, Math.round(threshold)));
  if (typeof body.liveKeepRecording === 'boolean') out.liveKeepRecording = body.liveKeepRecording;
  if (typeof body.liveMomentOnly === 'boolean') out.liveMomentOnly = body.liveMomentOnly;
  return out;
}

function normalizeUrl(raw: unknown): string {
  const value = String(raw || '').trim();
  if (!value) throw new HttpError(400, 'Paste a video or channel link first.');
  const withProtocol = /^https?:\/\//i.test(value) ? value : `https://${value}`;
  let parsed: URL;
  try {
    parsed = new URL(withProtocol);
  } catch {
    throw new HttpError(400, 'That does not look like a valid link.');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new HttpError(400, 'Only http and https links are supported.');
  return parsed.toString();
}

function platformFrom(value: unknown, fallback: PlatformId): PlatformId {
  return typeof value === 'string' && PLATFORM_IDS.has(value as PlatformId) ? (value as PlatformId) : fallback;
}

function slugify(text: string, fallback = 'teraclip'): string {
  const clean = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 70);
  return clean || fallback;
}

async function findClipAsync(clipId: string): Promise<{ projectId: string; clip: ClipRecord } | undefined> {
  for (const summary of store.listProjects()) {
    const project = await store.getProject(summary.id);
    const clip = project?.clips.find((item) => item.id === clipId);
    if (clip) return { projectId: summary.id, clip };
  }
  return undefined;
}

function existingFile(relative: string | undefined): string | undefined {
  if (!relative) return undefined;
  try {
    const abs = fromData(relative);
    return fs.existsSync(abs) ? abs : undefined;
  } catch {
    return undefined;
  }
}

function postingKit(projectTitle: string, clip: ClipRecord, campaign?: Campaign): string {
  const tags = clip.hashtags.map((tag) => (tag.startsWith('#') ? tag : `#${tag}`)).join(' ');
  const lines = [
    `TeraClip posting kit — ${projectTitle}`,
    '',
    `Title: ${clip.title}`,
    `Hook: ${clip.hook}`,
    `Caption: ${clip.caption}`,
    `Hashtags: ${tags}`,
    `Length: ${clip.duration.toFixed(1)}s`,
    '',
  ];
  if (campaign) {
    lines.push(
      `Campaign: ${campaign.name} (${campaign.brand})`,
      campaign.link ? `Campaign link: ${campaign.link}` : '',
      campaign.rules.requiredTags.length ? `Required tags: ${campaign.rules.requiredTags.join(' ')}` : '',
      campaign.rules.mentions.length ? `Mentions: ${campaign.rules.mentions.join(' ')}` : '',
      campaign.rules.cta ? `CTA: ${campaign.rules.cta}` : '',
      campaign.rules.notes ? `Notes: ${campaign.rules.notes}` : '',
      '',
    );
  }
  lines.push('Sources:', `- ${clip.projectId}`, `- clip ${clip.id}`);
  return lines.filter((line) => line !== null).join('\n');
}

function mediaResponse(reply: FastifyReply, abs: string, filename: string, contentType: string): FastifyReply {
  reply
    .header('Content-Type', contentType)
    .header('Content-Disposition', `attachment; filename="${filename.replace(/"/g, '')}"`)
    .header('Cache-Control', 'no-store');
  return reply.send(fs.createReadStream(abs));
}

async function diskStats(): Promise<{ freeBytes: number; totalBytes: number }> {
  try {
    const stats = fs.statfsSync(CONFIG.dataDir);
    return {
      freeBytes: Number(stats.bavail) * Number(stats.bsize),
      totalBytes: Number(stats.blocks) * Number(stats.bsize),
    };
  } catch {
    return { freeBytes: 0, totalBytes: 0 };
  }
}

async function systemStatus(): Promise<SystemStatus> {
  const bins = getBinaries();
  const versions = await getToolVersions();
  const settings = store.getSettings();
  const usage = store.getUsage();
  const disk = await diskStats();
  let fontCount = 0;
  try {
    fontCount = (await fsp.readdir(PATHS.fonts)).filter((file) => /\.(ttf|otf)$/i.test(file)).length;
  } catch {
    fontCount = 0;
  }
  const model = bins.whisperModel;
  let modelSize = 0;
  try {
    modelSize = model.path ? (await fsp.stat(model.path)).size : 0;
  } catch {
    modelSize = 0;
  }
  return {
    app: { version: CONFIG.version, uptime: Math.round(process.uptime()) },
    binaries: {
      ffmpeg: { status: bins.ffmpeg.status, version: versions.ffmpeg, path: bins.ffmpeg.path },
      ffprobe: { status: bins.ffprobe.status, version: versions.ffprobe, path: bins.ffprobe.path },
      ytdlp: { status: bins.ytdlp.status, version: versions.ytdlp, path: bins.ytdlp.path },
      whisper: { status: bins.whisper.status, version: versions.whisper, path: bins.whisper.path },
      whisperModel: {
        status: bins.whisperModel.status,
        path: model.path,
        size: modelSize,
        name: model.path ? path.basename(model.path) : undefined,
      },
      yunet: { status: bins.yunet.status, path: bins.yunet.path },
      fonts: { status: bins.fonts.status, count: fontCount },
    },
    gemini: {
      configured: Boolean(CONFIG.geminiKey),
      model: settings.geminiModel || CONFIG.geminiModel,
      usage,
      dailyLimit:
        settings.geminiDailyLimit === 0
          ? 0
          : Math.min(settings.geminiDailyLimit || CONFIG.geminiDailyLimit, CONFIG.geminiDailyLimit),
    },
    storage: {
      dataDir: CONFIG.dataDir,
      freeBytes: disk.freeBytes,
      totalBytes: disk.totalBytes,
      usedBytes: await store.storageUsed(),
      projects: store.listProjects().length,
    },
    cpu: {
      cores: os.cpus().length,
      model: os.cpus()[0]?.model?.trim() || 'Unknown CPU',
    },
  };
}

async function cleanupStorage(): Promise<{ freedBytes: number; removed: string[] }> {
  const removed: string[] = [];
  let freedBytes = 0;
  const remove = async (file: string, label: string) => {
    try {
      const stat = await fsp.stat(file);
      await fsp.rm(file, { recursive: true, force: true });
      freedBytes += stat.size;
      removed.push(label);
    } catch {
      /* ignore */
    }
  };

  try {
    const tmpEntries = await fsp.readdir(PATHS.tmp);
    for (const entry of tmpEntries) await remove(path.join(PATHS.tmp, entry), `tmp/${entry}`);
  } catch {
    /* ignore */
  }

  const settings = store.getSettings();
  const cutoff = Date.now() - Math.max(0, settings.autoDeleteBasesDays) * 86_400_000;
  for (const summary of store.listProjects()) {
    if (projectBusy(summary.id) || summary.status !== 'ready') continue;
    const project = await store.getProject(summary.id);
    if (!project?.clips.some((clip) => clip.status === 'ready')) continue;
    const projectDir = path.join(PATHS.projects, project.id);
    await remove(path.join(projectDir, 'audio.wav'), `${project.id}/audio.wav`);
    await remove(path.join(projectDir, 'work'), `${project.id}/work`);
    if (settings.autoDeleteBasesDays > 0 && project.sourcePath) {
      const source = existingFile(project.sourcePath);
      if (source) {
        const stat = await fsp.stat(source).catch(() => null);
        if (stat && stat.mtimeMs < cutoff) await remove(source, `${project.id}/${path.basename(source)}`);
      }
    }
  }

  for (const session of store.listLiveSessions()) {
    if (liveBusy(session.id) || !recordingPath(session)) continue;
    await remove(path.join(PATHS.live, session.id, 'segments'), `${session.id}/segments`);
    await remove(path.join(PATHS.live, session.id, 'concat.txt'), `${session.id}/concat.txt`);
  }

  store.invalidateStorage();
  return { freedBytes, removed: removed.slice(0, 100) };
}

function registerSse(app: FastifyInstance): void {
  app.get('/api/events', (request, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    reply.raw.write(': connected\n\n');
    const off = bus.onAny((event, payload) => {
      try {
        reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
      } catch {
        /* client disconnected */
      }
    });
    const ping = setInterval(() => {
      try {
        reply.raw.write(': ping\n\n');
      } catch {
        /* ignore */
      }
    }, 20_000);
    request.raw.on('close', () => {
      clearInterval(ping);
      off();
    });
  });
}

function registerRoutes(app: FastifyInstance): void {
  app.get('/api/health', async () => ({ ok: true, version: CONFIG.version, uptime: process.uptime() }));

  app.get('/api/bootstrap', async () => ({
    version: CONFIG.version,
    settings: store.getSettings(),
    defaults: DEFAULT_SETTINGS,
    presets: CAPTION_PRESETS,
    hooks: HOOK_STYLES,
    platforms: PLATFORMS,
    aspects: ASPECT_SIZES,
    geminiConfigured: Boolean(CONFIG.geminiKey),
    live: activeLiveSession(),
  }));

  app.get('/api/settings', async () => store.getSettings());
  app.patch('/api/settings', async (request) => {
    const patch = cleanAppSettings((request.body as { patch?: unknown })?.patch ?? request.body);
    const settings = await store.updateSettings(patch);
    bus.emit('toast', { id: nanoid(8), tone: 'success', title: 'Settings saved' });
    return settings;
  });

  app.get('/api/system', async () => systemStatus());
  app.get('/api/studio', async () => ({ stats: store.getStudioStats(), dataDir: CONFIG.dataDir }));
  app.post('/api/system/setup', async (request) => {
    const force = Boolean((request.body as { force?: boolean } | undefined)?.force);
    const ready = await ensureAll(force);
    await inspectTools();
    return { ready };
  });
  app.post('/api/system/ytdlp-update', async () => {
    await updateYtdlp();
    return { ok: true, version: (await getToolVersions()).ytdlp };
  });
  app.post('/api/system/cleanup', async () => cleanupStorage());

  /** A /live or /watch link that yt-dlp reports as finished is a VOD, not a live channel. */
  const resolvedSourceKind = (url: string, platform: PlatformId, isLive: boolean): SourceKind => {
    if (isLive) return 'live';
    const guessed = guessSourceKind(url, platform);
    return guessed === 'live' ? 'vod' : guessed;
  };

  app.post('/api/import/resolve', async (request) => {
    const url = normalizeUrl((request.body as { url?: unknown })?.url);
    const info = await asHttp(() => resolveSource(url, store.getSettings()));
    const platform = info.platform || detectPlatform(url) || 'generic';
    return {
      url,
      id: info.id,
      title: info.title,
      channel: info.channel,
      duration: info.duration,
      thumbnail: info.thumbnail,
      platform,
      isLive: info.isLive,
      liveStatus: info.liveStatus,
      width: info.width,
      height: info.height,
      description: info.description,
      kind: resolvedSourceKind(url, platform, info.isLive),
      sourceKind: resolvedSourceKind(url, platform, info.isLive),
      previewUrl: mediaUrl(undefined),
    };
  });

  app.post('/api/projects', async (request) => {
    const body = (request.body || {}) as Record<string, unknown>;
    const url = normalizeUrl(body.url);
    const info = await asHttp(() => resolveSource(url, store.getSettings()));
    if (info.isLive) throw new HttpError(400, 'That channel is live. Use the Live page to record it first.');
    const platform = platformFrom(body.platform, info.platform);
    const project = await createProject({
      title: typeof body.title === 'string' ? body.title : info.title,
      channel: info.channel,
      platform,
      sourceKind: resolvedSourceKind(url, platform, info.isLive),
      sourceUrl: url,
      externalId: info.id,
      previewUrl: info.thumbnail,
      campaignId: typeof body.campaignId === 'string' ? body.campaignId : undefined,
      settings: cleanSettings(body.settings),
      duration: info.duration,
    });
    return project;
  });

  app.post('/api/projects/upload', async (request, reply) => {
    if (!request.isMultipart()) throw new HttpError(400, 'Choose a video file to upload.');
    const fields: Record<string, string> = {};
    let dest = '';
    let originalName = 'Uploaded video.mp4';
    try {
      for await (const part of request.parts()) {
        if (part.type === 'field') {
          fields[part.fieldname] = typeof part.value === 'string' ? part.value : String(part.value ?? '');
          continue;
        }
        if (part.fieldname !== 'file') {
          part.file.resume();
          continue;
        }
        originalName = part.filename || originalName;
        const extension = path.extname(originalName).toLowerCase() || '.mp4';
        if (!/\.(mp4|mov|mkv|webm|m4v|avi|ts)$/i.test(extension)) {
          part.file.resume();
          throw new HttpError(400, 'Upload an MP4, MOV, MKV, WebM or TS file.');
        }
        dest = path.join(PATHS.uploads, `upload-${Date.now()}-${nanoid(6)}${extension}`);
        await fsp.mkdir(PATHS.uploads, { recursive: true });
        await streamPipeline(part.file, fs.createWriteStream(dest));
      }
    } catch (error) {
      if (dest) await fsp.rm(dest, { force: true }).catch(() => undefined);
      const code = (error as { code?: string }).code;
      if (code === 'FST_REQ_FILE_TOO_LARGE' || code === 'FST_FILES_LIMIT') {
        throw new HttpError(413, 'That file is larger than the 6 GB upload limit.');
      }
      throw error;
    }
    if (!dest) throw new HttpError(400, 'Choose a video file to upload.');

    let settings: Partial<ClipSettings> = {};
    if (fields.settings) {
      try {
        settings = cleanSettings(JSON.parse(fields.settings));
      } catch {
        await fsp.rm(dest, { force: true }).catch(() => undefined);
        throw new HttpError(400, 'The clip settings were not valid JSON.');
      }
    }
    const platform = platformFrom(fields.platform, 'upload');
    const project = await createProject({
      title: fields.title || path.basename(originalName, path.extname(originalName)),
      platform,
      sourceKind: 'upload',
      filePath: dest,
      campaignId: fields.campaignId,
      settings,
    });
    reply.code(201);
    return project;
  });

  app.get('/api/projects', async () => store.listProjects());
  app.get('/api/projects/:id', async (request) => {
    const { id } = request.params as { id: string };
    const project = await store.getProject(id);
    if (!project) throw new HttpError(404, 'Project not found.');
    return project;
  });
  app.delete('/api/projects/:id', async (request) => {
    const { id } = request.params as { id: string };
    const project = await store.getProject(id);
    if (!project) throw new HttpError(404, 'Project not found.');
    await deleteProjectCascade(id);
    return { ok: true };
  });
  app.post('/api/projects/:id/retry', async (request) => {
    const { id } = request.params as { id: string };
    const project = await store.getProject(id);
    if (!project) throw new HttpError(404, 'Project not found.');
    if (projectBusy(id)) throw new HttpError(409, 'This project is already working.');
    startProject(id);
    return { ok: true };
  });
  app.post('/api/projects/:id/cancel', async (request) => {
    const { id } = request.params as { id: string };
    const cancelled = cancelProject(id);
    return { cancelled };
  });
  app.post('/api/projects/:id/replan', async (request) => {
    const { id } = request.params as { id: string };
    const settings = cleanSettings((request.body as { settings?: unknown } | undefined)?.settings);
    const project = await asHttp(() => replanProject(id, settings), 409);
    return project;
  });
  app.post('/api/projects/:id/renotice', async (request) => {
    const { id } = request.params as { id: string };
    if (projectBusy(id)) throw new HttpError(409, 'This project is already working.');
    return renoticeProject(id);
  });
  app.patch('/api/projects/:id/clips/:clipId', async (request) => {
    const { id, clipId } = request.params as { id: string; clipId: string };
    const body = (request.body || {}) as Record<string, unknown>;
    const patch: Parameters<typeof editClip>[2] = {};
    if (typeof body.title === 'string') patch.title = body.title;
    if (typeof body.hook === 'string') patch.hook = body.hook;
    if (typeof body.hookStyle === 'string' && HOOK_IDS.has(body.hookStyle as ClipRecord['hookStyle'])) {
      patch.hookStyle = body.hookStyle as ClipRecord['hookStyle'];
    }
    if (typeof body.captionPreset === 'string' && CAPTION_IDS.has(body.captionPreset as ClipRecord['captionPreset'])) {
      patch.captionPreset = body.captionPreset as ClipRecord['captionPreset'];
    }
    if (typeof body.captionScale === 'number' && Number.isFinite(body.captionScale)) {
      patch.captionScale = Math.max(0.6, Math.min(1.6, body.captionScale));
    }
    if (typeof body.caption === 'string') patch.caption = body.caption;
    if (Array.isArray(body.hashtags)) patch.hashtags = body.hashtags.filter((tag): tag is string => typeof tag === 'string');
    if (Array.isArray(body.subtitles)) {
      patch.subtitles = body.subtitles
        .filter((cue): cue is Record<string, unknown> => Boolean(cue) && typeof cue === 'object')
        .map((cue) => ({
          start: Number(cue.start) || 0,
          end: Number(cue.end) || 0,
          text: typeof cue.text === 'string' ? cue.text : '',
        }))
        .slice(0, 300);
    }
    if (typeof body.framing === 'string' && REFRAME.has(body.framing)) patch.framing = body.framing as ClipRecord['framing'];
    if (typeof body.start === 'number') patch.start = body.start;
    if (typeof body.end === 'number') patch.end = body.end;
    if (typeof body.starred === 'boolean') patch.starred = body.starred;
    const clip = await editClip(id, clipId, patch);
    return clip;
  });
  app.post('/api/projects/:id/clips/:clipId/render', async (request) => {
    const { id, clipId } = request.params as { id: string; clipId: string };
    const clip = await editClip(id, clipId, {}, 'always');
    return clip;
  });
  app.delete('/api/projects/:id/clips/:clipId', async (request) => {
    const { id, clipId } = request.params as { id: string; clipId: string };
    await deleteClip(id, clipId);
    return { ok: true };
  });
  app.get('/api/projects/:id/clips/:clipId/download', async (request, reply) => {
    const { id, clipId } = request.params as { id: string; clipId: string };
    const project = await store.getProject(id);
    const clip = project?.clips.find((item) => item.id === clipId);
    if (!project || !clip) throw new HttpError(404, 'Clip not found.');
    const abs = existingFile(clip.files.final);
    if (!abs) throw new HttpError(404, 'This clip has not finished rendering.');
    return mediaResponse(reply, abs, `${slugify(project.title)}-clip-${String(clip.index + 1).padStart(2, '0')}.mp4`, 'video/mp4');
  });

  app.get('/api/projects/:id/export', async (request, reply) => {
    const { id } = request.params as { id: string };
    const project = await store.getProject(id);
    if (!project) throw new HttpError(404, 'Project not found.');
    const clips = project.clips.filter((clip) => clip.status === 'ready' && existingFile(clip.files.final));
    if (!clips.length) throw new HttpError(400, 'There are no finished clips to export yet.');
    const campaign = project.campaignId ? store.getCampaign(project.campaignId) : undefined;

    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${slugify(project.title)}-teraclip.zip"`,
      'Cache-Control': 'no-store',
    });
    const archive = archiver('zip', { zlib: { level: 6 } });
    archive.on('warning', (error) => log.warn('zip warning', error));
    archive.on('error', (error) => log.error('zip failed', error));
    archive.pipe(reply.raw);
    for (const clip of clips) {
      const final = existingFile(clip.files.final);
      const number = String(clip.index + 1).padStart(2, '0');
      if (final) archive.file(final, { name: `clips/clip-${number}.mp4` });
      const thumb = existingFile(clip.files.thumb);
      if (thumb) archive.file(thumb, { name: `thumbnails/clip-${number}.jpg` });
      const srt = existingFile(clip.files.srt);
      if (srt) archive.file(srt, { name: `captions/clip-${number}.srt` });
      const ass = existingFile(clip.files.ass);
      if (ass) archive.file(ass, { name: `captions/clip-${number}.ass` });
      archive.append(postingKit(project.title, clip, campaign), { name: `posting-kit/clip-${number}.txt` });
    }
    archive.append(
      JSON.stringify(
        {
          project: {
            id: project.id,
            title: project.title,
            channel: project.channel,
            platform: project.platform,
            sourceUrl: project.sourceUrl,
            settings: project.settings,
            stats: project.stats,
          },
          clips: clips.map((clip) => ({
            id: clip.id,
            title: clip.title,
            hook: clip.hook,
            caption: clip.caption,
            hashtags: clip.hashtags,
            start: clip.start,
            end: clip.end,
            score: clip.score,
          })),
        },
        null,
        2,
      ),
      { name: 'teraclip.json' },
    );
    await archive.finalize();
  });

  app.get('/api/library', async (request) => {
    const query = request.query as { q?: string; platform?: string; starred?: string; campaign?: string };
    const search = (query.q || '').trim().toLowerCase();
    let clips = await store.listClips();
    if (search) {
      clips = clips.filter(({ clip, project }) => {
        const haystack = `${clip.title} ${clip.hook} ${clip.caption} ${clip.hashtags.join(' ')} ${project.title} ${clip.transcript}`.toLowerCase();
        return haystack.includes(search);
      });
    }
    if (query.platform) clips = clips.filter(({ project }) => project.platform === query.platform);
    if (query.starred === '1') clips = clips.filter(({ clip }) => clip.starred);
    if (query.campaign) clips = clips.filter(({ project }) => project.campaignId === query.campaign);
    return clips;
  });

  app.post('/api/library/bulk-delete', async (request) => {
    const body = (request.body || {}) as { clipIds?: unknown; ids?: unknown };
    const raw = Array.isArray(body.clipIds) ? body.clipIds : Array.isArray(body.ids) ? body.ids : [];
    const ids = [...new Set(raw.filter((id): id is string => typeof id === 'string' && id.trim().length > 2))].slice(0, 300);
    if (!ids.length) throw new HttpError(400, 'Choose at least one clip to delete.');
    let deleted = 0;
    const missing: string[] = [];
    for (const clipId of ids) {
      const found = await findClipAsync(clipId);
      if (!found) {
        missing.push(clipId);
        continue;
      }
      try {
        await deleteClip(found.projectId, clipId);
        deleted += 1;
      } catch {
        missing.push(clipId);
      }
    }
    return { deleted, missing };
  });

  app.get('/api/library/export', async (request, reply) => {
    const query = request.query as { ids?: string; starred?: string };
    const wanted = new Set(
      (query.ids || '')
        .split(',')
        .map((id) => id.trim())
        .filter(Boolean),
    );
    let clips = await store.listClips();
    if (wanted.size) clips = clips.filter(({ clip }) => wanted.has(clip.id));
    if (!wanted.size && query.starred === '1') clips = clips.filter(({ clip }) => clip.starred);
    clips = clips.filter(({ clip }) => clip.status === 'ready' && existingFile(clip.files.final));
    if (!clips.length) throw new HttpError(400, 'There are no finished clips to download.');

    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="teraclip-library-${new Date().toISOString().slice(0, 10)}.zip"`,
      'Cache-Control': 'no-store',
    });
    const archive = archiver('zip', { zlib: { level: 6 } });
    archive.on('warning', (error) => log.warn('zip warning', error));
    archive.on('error', (error) => log.error('zip failed', error));
    archive.pipe(reply.raw);
    const used = new Set<string>();
    for (const { clip, project } of clips) {
      let base = `${slugify(project.title)}-${String(clip.index + 1).padStart(2, '0')}`;
      if (used.has(base)) base = `${base}-${clip.id.slice(-4)}`;
      used.add(base);
      const final = existingFile(clip.files.final);
      if (final) archive.file(final, { name: `${base}.mp4` });
      const thumb = existingFile(clip.files.thumb);
      if (thumb) archive.file(thumb, { name: `${base}.jpg` });
      const srt = existingFile(clip.files.srt);
      if (srt) archive.file(srt, { name: `${base}.srt` });
      const ass = existingFile(clip.files.ass);
      if (ass) archive.file(ass, { name: `${base}.ass` });
      const campaign = project.campaignId ? store.getCampaign(project.campaignId) : undefined;
      archive.append(postingKit(project.title, clip, campaign), { name: `${base}.txt` });
    }
    archive.append(
      JSON.stringify(
        clips.map(({ clip, project }) => ({
          id: clip.id,
          project: project.title,
          title: clip.title,
          hook: clip.hook,
          caption: clip.caption,
          hashtags: clip.hashtags,
          start: clip.start,
          end: clip.end,
          score: clip.score,
        })),
        null,
        2,
      ),
      { name: 'library.json' },
    );
    await archive.finalize();
  });

  app.get('/api/library/:clipId/download', async (request, reply) => {
    const { clipId } = request.params as { clipId: string };
    const found = await findClipAsync(clipId);
    if (!found) throw new HttpError(404, 'Clip not found.');
    const abs = existingFile(found.clip.files.final);
    if (!abs) throw new HttpError(404, 'This clip has not finished rendering.');
    return mediaResponse(reply, abs, `${slugify(found.clip.title)}.mp4`, 'video/mp4');
  });
  app.get('/api/library/:clipId/kit', async (request) => {
    const { clipId } = request.params as { clipId: string };
    const found = await findClipAsync(clipId);
    if (!found) throw new HttpError(404, 'Clip not found.');
    const project = await store.getProject(found.projectId);
    const campaign = project?.campaignId ? store.getCampaign(project.campaignId) : undefined;
    return { kit: postingKit(project?.title || 'TeraClip', found.clip, campaign) };
  });
  app.delete('/api/library/:clipId', async (request) => {
    const { clipId } = request.params as { clipId: string };
    const found = await findClipAsync(clipId);
    if (!found) throw new HttpError(404, 'Clip not found.');
    await deleteClip(found.projectId, clipId);
    return { ok: true };
  });

  app.get('/api/campaigns', async () => ({
    campaigns: store.listCampaigns(),
    submissions: store.listSubmissions(),
  }));
  app.post('/api/campaigns', async (request, reply) => {
    const body = (request.body || {}) as Partial<Campaign>;
    if (!body.name || !body.brand) throw new HttpError(400, 'Campaign name and brand are required.');
    const campaign = await store.saveCampaign(body as Partial<Campaign> & { name: string; brand: string });
    reply.code(201);
    return campaign;
  });
  app.patch('/api/campaigns/:id', async (request) => {
    const { id } = request.params as { id: string };
    const existing = store.getCampaign(id);
    if (!existing) throw new HttpError(404, 'Campaign not found.');
    const body = (request.body || {}) as Partial<Campaign>;
    return store.saveCampaign({
      ...existing,
      ...body,
      id,
      name: body.name || existing.name,
      brand: body.brand || existing.brand,
    });
  });
  app.delete('/api/campaigns/:id', async (request) => {
    const { id } = request.params as { id: string };
    await store.deleteCampaign(id);
    return { ok: true };
  });

  app.get('/api/submissions', async (request) => {
    const { campaignId } = request.query as { campaignId?: string };
    return store.listSubmissions(campaignId);
  });
  app.post('/api/submissions', async (request, reply) => {
    const body = (request.body || {}) as Partial<Submission>;
    if (!body.clipId || !body.projectId || !body.campaignId || !body.platform || !body.url) {
      throw new HttpError(400, 'Clip, campaign, platform and post URL are required.');
    }
    const submission = await store.saveSubmission(
      body as Partial<Submission> & { clipId: string; projectId: string; campaignId: string; platform: string; url: string },
    );
    reply.code(201);
    return submission;
  });
  app.patch('/api/submissions/:id', async (request) => {
    const { id } = request.params as { id: string };
    const existing = store.listSubmissions().find((submission) => submission.id === id);
    if (!existing) throw new HttpError(404, 'Submission not found.');
    const body = (request.body || {}) as Partial<Submission>;
    return store.saveSubmission({ ...existing, ...body, id });
  });
  app.delete('/api/submissions/:id', async (request) => {
    const { id } = request.params as { id: string };
    await store.deleteSubmission(id);
    return { ok: true };
  });

  app.get('/api/creators', async () => ({ creators: await creatorsWithStatus(false) }));
  app.post('/api/creators/refresh', async () => ({ creators: await creatorsWithStatus(true) }));
  app.post('/api/creators', async (request, reply) => {
    const body = (request.body || {}) as Record<string, unknown>;
    const creators = await asHttp(() => addCreator(body.platform, body.handle, body.name));
    reply.code(201);
    return { creators };
  });
  app.delete('/api/creators/:id', async (request) => {
    const { id } = request.params as { id: string };
    return { creators: await removeCreator(id) };
  });
  app.post('/api/creators/:id/record', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = (request.body || {}) as Record<string, unknown>;
    const session = await asHttp(() => recordCreator(id, body.autoClip !== false));
    reply.code(201);
    return session;
  });

  app.get('/api/live', async () => ({
    sessions: store.listLiveSessions().map((session) => ({
      ...session,
      recordingAvailable: Boolean(recordingPath(session)),
      busy: liveBusy(session.id),
    })),
    active: activeLiveSession(),
    autoClipDefault: store.getSettings().liveAutoClip,
  }));
  app.post('/api/live/resolve', async (request) => {
    const url = normalizeUrl((request.body as { url?: unknown })?.url);
    return asHttp(() => resolveLive(url));
  });
  app.post('/api/live', async (request, reply) => {
    const body = (request.body || {}) as Record<string, unknown>;
    const url = normalizeUrl(body.url);
    const session = await asHttp(() =>
      startLive({
        url,
        title: typeof body.title === 'string' ? body.title : undefined,
        autoClip: typeof body.autoClip === 'boolean' ? body.autoClip : undefined,
      }),
    );
    reply.code(201);
    return session;
  });
  app.patch('/api/live/:id', async (request) => {
    const { id } = request.params as { id: string };
    const body = (request.body || {}) as Record<string, unknown>;
    const autoClip = body.autoClip;
    if (typeof autoClip !== 'boolean') throw new HttpError(400, 'Send autoClip as true or false.');
    return asHttp(() => setLiveAutoClip(id, autoClip));
  });
  app.post('/api/live/:id/stop', async (request) => {
    const { id } = request.params as { id: string };
    return asHttp(() => stopLive(id));
  });
  app.post('/api/live/:id/clips', async (request) => {
    const { id } = request.params as { id: string };
    const settings = cleanSettings((request.body as { settings?: unknown } | undefined)?.settings);
    return asHttp(() => createClipsFromLive(id, settings));
  });
  app.delete('/api/live/:id', async (request) => {
    const { id } = request.params as { id: string };
    await deleteLive(id);
    return { ok: true };
  });
  app.get('/api/live/:id/recording', async (request, reply) => {
    const { id } = request.params as { id: string };
    const session = store.getLiveSession(id);
    if (!session) throw new HttpError(404, 'Live session not found.');
    if (!recordingPath(session)) throw new HttpError(404, 'This session has no finished recording.');
    const relative = recordingPath(session)!;
    const dataRelative = path.relative(CONFIG.dataDir, relative).split(path.sep).join('/');
    return reply.redirect(`/media/${dataRelative}`);
  });
}

async function main(): Promise<void> {
  await store.init();
  markInterruptedLive();
  await recoverInterruptedProjects();
  await inspectTools();

  const app = Fastify({
    logger: false,
    bodyLimit: 4 * 1024 * 1024,
    trustProxy: false,
  });

  await app.register(multipart, {
    limits: { fileSize: CONFIG.maxUploadBytes, files: 1, fields: 20 },
  });

  await app.register(fastifyStatic, {
    root: CONFIG.dataDir,
    prefix: '/media/',
    decorateReply: false,
    index: false,
    maxAge: '30m',
    setHeaders: (res) => {
      res.setHeader('Accept-Ranges', 'bytes');
    },
  });

  registerSse(app);
  registerRoutes(app);

  const webIndex = path.join(CONFIG.webDist, 'index.html');
  if (fs.existsSync(webIndex)) {
    app.get('/', async (_request, reply) => reply.type('text/html').send(fs.createReadStream(webIndex)));
    app.get('/*', async (request, reply) => {
      const route = (request.params as { '*': string })['*'] || '';
      if (route.startsWith('api/') || route.startsWith('media/')) throw new HttpError(404, 'Not found.');
      const candidate = path.resolve(CONFIG.webDist, route);
      if (candidate.startsWith(CONFIG.webDist) && fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        const ext = path.extname(candidate).toLowerCase();
        const types: Record<string, string> = {
          '.js': 'text/javascript',
          '.css': 'text/css',
          '.svg': 'image/svg+xml',
          '.png': 'image/png',
          '.ico': 'image/x-icon',
          '.woff2': 'font/woff2',
          '.json': 'application/json',
          '.webp': 'image/webp',
        };
        return reply.type(types[ext] || 'application/octet-stream').send(fs.createReadStream(candidate));
      }
      return reply.type('text/html').send(fs.createReadStream(webIndex));
    });
  } else {
    app.get('/', async () => ({
      name: 'TeraClip Studio API',
      message: 'The UI has not been built yet. Run npm run dev for the Vite app, or npm run build for production.',
      version: CONFIG.version,
    }));
  }

  app.setErrorHandler((error, _request, reply) => {
    const statusCode = (error as { statusCode?: number }).statusCode || 500;
    if (statusCode >= 500) log.error('request failed', error);
    const message =
      statusCode === 413
        ? 'That upload is too large.'
        : (error as Error).message?.includes('FST_REQ_FILE_TOO_LARGE')
          ? 'That file is larger than the 6 GB upload limit.'
          : (error as Error).message || 'Something went wrong.';
    reply.code(statusCode).send({ error: message });
  });

  app.addHook('onClose', async () => {
    cancelAllProjects();
    const active = activeLiveSession();
    if (active) await stopLive(active.id).catch(() => undefined);
  });

  await app.listen({ host: CONFIG.host, port: CONFIG.port });
  log.info(`TeraClip Studio ${CONFIG.version} listening on http://${CONFIG.host}:${CONFIG.port}`);
  console.log(`\n  TeraClip Studio → http://${CONFIG.host}:${CONFIG.port}\n`);

  void ensureAll(false).catch((error) => log.warn('tool bootstrap failed', error));

  const shutdown = async (signal: string) => {
    log.info(`${signal} received, shutting down`);
    await app.close().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((error) => {
  console.error('TeraClip failed to start:', error);
  process.exit(1);
});
