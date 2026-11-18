import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { nanoid } from 'nanoid';
import WebSocket from 'ws';
import type { ClipSettings, HeatPoint, LiveMoment, LiveSession, PlatformId } from '../../shared/types';
import { PATHS, fromData, toData } from '../config';
import { bus } from '../lib/events';
import { log } from '../lib/logger';
import { killTree } from '../lib/process';
import { store } from '../lib/store';
import { probeMedia, remuxTsSegments } from './media';
import { createProject, projectBusy } from './pipeline';
import { resolveLiveStream, resolveSource } from './ytdlp';

const SEGMENT_SECONDS = 6;
const TICK_MS = 5_000;
const MAX_HEAT_POINTS = 720; // one hour at 5s resolution
const BASELINE_WINDOW = 48; // 4 minutes

interface Runtime {
  session: LiveSession;
  dir: string;
  segmentsDir: string;
  process: ChildProcess | null;
  stopping: boolean;
  attempts: number;
  lastStableAt: number;
  nextSegmentNumber: number;
  baseDuration: number;
  duration: number;
  analyzedSegment: number;
  chatSocket: WebSocket | null;
  heat: HeatPoint[];
  timers: NodeJS.Timeout[];
  pendingChat: number;
  segmentQueue: Promise<void>;
  lastAutoClipAt: number;
  lastAutoProjectId: string;
  momentTask: Promise<void> | null;
}

const runtimes = new Map<string, Runtime>();

export function activeLiveSession(): LiveSession | null {
  for (const runtime of runtimes.values()) {
    if (['preparing', 'recording', 'reconnecting', 'stopping'].includes(runtime.session.status)) return runtime.session;
  }
  return null;
}

export function liveBusy(id: string): boolean {
  return runtimes.has(id);
}

export async function setLiveAutoClip(id: string, autoClip: boolean): Promise<LiveSession> {
  const runtime = runtimes.get(id);
  if (runtime) {
    runtime.session.autoClip = autoClip;
    logTo(
      runtime,
      'info',
      autoClip
        ? `Auto-clip armed at ${store.getSettings().liveAutoClipThreshold}+ heat.`
        : 'Auto-clip disarmed.',
    );
    publish(runtime, true);
    return runtime.session;
  }
  const session = store.getLiveSession(id);
  if (!session) throw new Error('Live session not found.');
  session.autoClip = autoClip;
  session.updatedAt = stamp();
  await store.saveLiveSession(session);
  bus.emit('live.updated', session);
  return session;
}

function stamp(): string {
  return new Date().toISOString();
}

function logTo(runtime: Runtime, level: 'info' | 'warn' | 'error', message: string): void {
  runtime.session.log.push({ t: stamp(), level, message });
  runtime.session.log = runtime.session.log.slice(-150);
  if (level === 'error') log.error(`[live] ${message}`);
  else if (level === 'warn') log.warn(`[live] ${message}`);
  else log.info(`[live] ${message}`);
}

function publish(runtime: Runtime, save = false): void {
  runtime.session.updatedAt = stamp();
  runtime.session.duration = Math.round(runtime.duration * 10) / 10;
  mirrorHeat(runtime);
  bus.emit('live.updated', { ...runtime.session });
  if (save) void store.saveLiveSession(runtime.session).catch((error) => log.warn('live save failed', error));
}

export function formatClock(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rest = s % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(rest).padStart(2, '0')}` : `${m}:${String(rest).padStart(2, '0')}`;
}

function channelSlug(url: string): string {
  try {
    const parsed = new URL(url.startsWith('http') ? url : `https://${url}`);
    const parts = parsed.pathname.split('/').filter(Boolean);
    if (parsed.hostname.includes('twitch.tv') || parsed.hostname.includes('kick.com')) return (parts[0] || '').toLowerCase();
    if (parsed.hostname.includes('youtube.com')) return parts[parts.length - 1] || '';
  } catch {
    /* ignore */
  }
  return '';
}

function segmentFiles(runtime: Runtime): string[] {
  try {
    return fs
      .readdirSync(runtime.segmentsDir)
      .filter((name) => /^seg-\d+\.ts$/.test(name))
      .sort()
      .map((name) => path.join(runtime.segmentsDir, name));
  } catch {
    return [];
  }
}

function segmentIndex(file: string): number {
  const match = path.basename(file).match(/(\d+)\.ts$/);
  return match ? Number(match[1]) : 0;
}

async function decodeRms(file: string): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(
      PATHS.ffmpeg,
      ['-v', 'error', '-i', file, '-vn', '-ac', '1', '-ar', '8000', '-f', 's16le', 'pipe:1'],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const chunks: Buffer[] = [];
    let bytes = 0;
    child.stdout?.on('data', (chunk: Buffer) => {
      if (bytes > 8_000_000) return;
      chunks.push(chunk);
      bytes += chunk.length;
    });
    child.on('error', () => resolve(0));
    child.on('close', () => {
      const buffer = Buffer.concat(chunks);
      if (buffer.length < 3200) return resolve(0);
      let sum = 0;
      let count = 0;
      for (let i = 0; i + 1 < buffer.length; i += 2) {
        const sample = buffer.readInt16LE(i) / 32768;
        sum += sample * sample;
        count += 1;
      }
      const rms = Math.sqrt(sum / Math.max(1, count));
      const db = 20 * Math.log10(rms + 1e-7);
      resolve(Math.max(0, Math.min(1, (db + 55) / 55)));
    });
  });
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

/** One heat point per tick; audio and chat share the same timebase. */
function pushHeat(runtime: Runtime, t: number, patch: Partial<HeatPoint>): HeatPoint {
  let point: HeatPoint | undefined;
  for (let i = runtime.heat.length - 1; i >= 0 && i >= runtime.heat.length - 5; i--) {
    const candidate = runtime.heat[i]!;
    if (Math.abs(candidate.t - t) <= 3) {
      point = candidate;
      break;
    }
  }
  if (!point) {
    point = { t: Math.round(t * 10) / 10 };
    runtime.heat.push(point);
    runtime.heat = runtime.heat.slice(-MAX_HEAT_POINTS);
  }
  Object.assign(point, patch);
  point.heat = Math.round(clamp01((point.audio ?? 0.2) * 0.55 + Math.min(1, (point.chat ?? 0) / 12) * 0.45) * 100) / 100;
  return point;
}

function mirrorHeat(runtime: Runtime): void {
  runtime.session.audioHeat = runtime.heat.map((point) => ({ t: point.t, audio: point.audio, heat: point.heat }));
  runtime.session.chatHeat = runtime.heat.map((point) => ({ t: point.t, chat: point.chat, heat: point.heat }));
}

function stats(values: number[]): { mean: number; sd: number; p90: number } {
  const clean = values.filter((value) => Number.isFinite(value));
  if (!clean.length) return { mean: 0, sd: 0, p90: 0 };
  const mean = clean.reduce((sum, value) => sum + value, 0) / clean.length;
  const variance = clean.reduce((sum, value) => sum + (value - mean) ** 2, 0) / clean.length;
  const sorted = [...clean].sort((a, b) => a - b);
  return {
    mean,
    sd: Math.sqrt(variance),
    p90: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.9))] ?? mean,
  };
}

/**
 * Rolling z-score instead of fixed thresholds. Chat activity and stream audio
 * both vary hugely between channels, so "6 messages" is a hype moment for one
 * streamer and dead chat for another. A spike must now stand out from the last
 * few minutes of that specific stream.
 */
function scoreMoment(runtime: Runtime, point: HeatPoint): void {
  const windowSeconds = BASELINE_WINDOW * (TICK_MS / 1000);
  const recent = runtime.heat.filter((item) => item.t >= point.t - windowSeconds && item.t < point.t - 1);
  // Warm up before trusting the baseline; otherwise the first chat message
  // after going live looks like a once-in-a-stream surge.
  if (recent.length < 10) return;

  const audioStats = stats(recent.map((item) => item.audio ?? 0));
  const chatStats = stats(recent.map((item) => item.chat ?? 0));
  const audio = point.audio ?? 0;
  const chat = point.chat ?? 0;
  const audioZ = audioStats.sd > 0.012 ? (audio - audioStats.mean) / audioStats.sd : audio >= 0.55 ? 1.2 : 0;
  const chatZ = chatStats.sd > 0.08 ? (chat - chatStats.mean) / chatStats.sd : chat >= Math.max(4, chatStats.mean * 2.2) ? 1.6 : 0;
  const audioSpike = audioZ >= 1.25 && audio >= 0.4;
  const chatSpike = chatZ >= 1.7 && chat >= 4;
  if (!audioSpike && !chatSpike) return;

  const combined =
    Math.max(audioZ * 0.62, chatZ * 0.55) +
    Math.max(0, audioZ) * 0.18 +
    Math.max(0, chatZ) * 0.12;
  const score = Math.round(clamp01(0.42 + combined * 0.34) * 100);
  if (score < 30) return;

  // Chat reacts after the moment. Rewind a configurable amount, then snap to
  // the strongest nearby audio beat so the clip lands on the actual payoff.
  const settings = store.getSettings();
  const chatLag = chatSpike ? Math.max(0, Math.min(45, settings.liveChatLag ?? 14)) : 0;
  let anchor = point.t;
  if (chatLag > 0) {
    anchor = Math.max(0, point.t - chatLag);
    let bestAudio = 0;
    let bestT = anchor;
    for (const candidate of runtime.heat) {
      if (candidate.t < anchor - 8 || candidate.t > anchor + 6) continue;
      if ((candidate.audio ?? 0) > bestAudio) {
        bestAudio = candidate.audio ?? 0;
        bestT = candidate.t;
      }
    }
    if (bestAudio >= 0.45) anchor = bestT;
  }

  const reason =
    [
      audioSpike ? `audio spike (${audioZ.toFixed(1)}σ)` : null,
      chatSpike
        ? `chat surge (${chat} msgs · ${chatZ.toFixed(1)}σ · rewound ${Math.round(Math.max(0, point.t - anchor))}s)`
        : null,
    ]
      .filter(Boolean)
      .join(' + ') || 'combined heat peak';

  // 45s dedupe window: chat and audio can both fire for the same beat, and a
  // single hype moment should not create five near-identical projects.
  const last = runtime.session.moments[runtime.session.moments.length - 1];
  if (last && Math.abs(anchor - last.t) < 45) {
    if (score > last.score) {
      last.t = Math.round(anchor * 10) / 10;
      last.score = score;
      last.reason = reason;
      publish(runtime);
    }
    return;
  }

  const moment: LiveMoment = { id: `mom_${nanoid(7)}`, t: Math.round(anchor * 10) / 10, score, reason };
  runtime.session.moments.push(moment);
  runtime.session.moments = runtime.session.moments.slice(-80);
  logTo(runtime, 'info', `Moment at ${formatClock(moment.t)} — ${reason} (${moment.score})`);
  publish(runtime, true);
  startAutoClip(runtime, moment);
}

function startAutoClip(runtime: Runtime, moment: LiveMoment): void {
  if (runtime.momentTask) return;
  runtime.momentTask = maybeAutoClip(runtime, moment)
    .catch((error) => logTo(runtime, 'warn', `Auto clip failed: ${(error as Error).message}`))
    .finally(() => {
      runtime.momentTask = null;
    });
}

async function maybeAutoClip(runtime: Runtime, moment: LiveMoment): Promise<void> {
  const settings = store.getSettings();
  if (!runtime.session.autoClip || runtime.stopping) return;
  if (moment.score < (settings.liveAutoClipThreshold || 68)) return;
  if (runtime.duration - runtime.lastAutoClipAt < 75) return;
  if (runtime.lastAutoProjectId) {
    const previous = await store.getProject(runtime.lastAutoProjectId);
    if (previous && projectBusy(previous.id)) return;
  }
  runtime.lastAutoClipAt = runtime.duration;

  const lookback = Math.max(20, Math.min(180, settings.liveLookback || 90));
  // Give the moment a short tail, then take the lookback window behind it.
  // This keeps the rewind correction while still ending after the reaction.
  const endTarget = Math.min(runtime.duration, Math.max(SEGMENT_SECONDS * 2, moment.t + 18));
  const complete = segmentFiles(runtime).filter((file) => {
    const start = segmentIndex(file) * SEGMENT_SECONDS;
    return start >= endTarget - lookback && start <= endTarget;
  });
  if (complete.length < 2) return;
  const startTime = segmentIndex(complete[0]!) * SEGMENT_SECONDS;
  const endTime = (segmentIndex(complete[complete.length - 1]!) + 1) * SEGMENT_SECONDS;
  const dir = path.join(runtime.dir, 'moments');
  await fsp.mkdir(dir, { recursive: true });
  const out = path.join(dir, `moment-${moment.id}.mp4`);
  try {
    await remuxTsSegments(complete, path.join(dir, `moment-${moment.id}.txt`), out);
    const chatHeat = runtime.heat
      .filter((point) => point.t >= startTime - 2 && point.t <= endTime + 2)
      .map((point) => ({ t: Math.max(0, point.t - startTime), chat: point.chat, heat: point.heat }));
    const project = await createProject({
      title: `${runtime.session.title} · auto clip`,
      channel: runtime.session.channel,
      platform: runtime.session.platform,
      sourceKind: 'live',
      filePath: out,
      sourceUrl: runtime.session.url,
      duration: endTime - startTime,
      chatHeat,
      settings: {
        // Auto clips are small windows, so keeping Gemini in "smart" mode is
        // cheap and gives the editor a human-quality pick. Users who turn AI
        // off globally still get a fully local pipeline.
        aiMode: settings.defaultAiMode === 'off' ? 'off' : 'smart',
        reframe: 'split',
        clipCount: Math.max(1, Math.min(3, settings.defaultClipCount)),
      },
    });
    runtime.lastAutoProjectId = project.id;
    moment.projectId = project.id;
    runtime.session.projectId = project.id;
    logTo(runtime, 'info', `Auto clip queued from ${formatClock(startTime)} → ${formatClock(endTime)}.`);
    publish(runtime, true);
    // createProject moved the moment into the project. Drop the concat list so
    // the session folder does not accumulate one file per auto clip.
    await fsp.rm(out, { force: true }).catch(() => undefined);
    await fsp.rm(path.join(dir, `moment-${moment.id}.txt`), { force: true }).catch(() => undefined);
  } catch (error) {
    logTo(runtime, 'warn', `Auto clip failed: ${(error as Error).message}`);
  }
}

async function analyzeAudioSegment(runtime: Runtime, file: string): Promise<void> {
  const index = segmentIndex(file);
  if (index <= runtime.analyzedSegment) return;
  runtime.analyzedSegment = index;
  const t = index * SEGMENT_SECONDS + SEGMENT_SECONDS / 2;
  const audio = await decodeRms(file);
  if (runtime.stopping) return;
  const point = pushHeat(runtime, t, { audio });
  scoreMoment(runtime, point);
}

/**
 * Moment-only mode keeps a rolling window instead of the whole stream. It is
 * deliberately conservative: only runs while auto-clip is armed, never touches
 * the segment ffmpeg is writing or one that has not been scored yet, and pauses
 * while a moment is being remuxed.
 */
function pruneRollingBuffer(runtime: Runtime): void {
  if (runtime.stopping || runtime.momentTask) return;
  const settings = store.getSettings();
  if (!settings.liveMomentOnly || !runtime.session.autoClip) return;
  const lookback = Math.max(20, Math.min(180, settings.liveLookback || 90));
  const keepSeconds = lookback + 180;
  const floor = runtime.duration - keepSeconds;
  if (floor <= 0) return;
  const files = segmentFiles(runtime);
  for (const file of files.slice(0, -1)) {
    const index = segmentIndex(file);
    if (index >= runtime.analyzedSegment - 1) continue;
    if ((index + 1) * SEGMENT_SECONDS <= floor) {
      try {
        fs.rmSync(file, { force: true });
      } catch {
        /* ignore */
      }
    }
  }
}

function watchSegments(runtime: Runtime): void {
  runtime.timers.push(
    setInterval(() => {
      pruneRollingBuffer(runtime);
      const files = segmentFiles(runtime);
      runtime.session.segments = files.length;
      let bytes = 0;
      for (const file of files) {
        try {
          bytes += fs.statSync(file).size;
        } catch {
          /* ignore */
        }
      }
      runtime.session.bytes = bytes;
      if (runtime.session.status === 'recording' && Date.now() - runtime.lastStableAt > 20_000) runtime.session.health = 'good';
      publish(runtime);
      const latest = files[files.length - 1];
      if (latest && segmentIndex(latest) > runtime.analyzedSegment) {
        runtime.segmentQueue = runtime.segmentQueue.then(() => analyzeAudioSegment(runtime, latest)).catch(() => undefined);
      }
    }, TICK_MS),
  );

  runtime.timers.push(
    setInterval(() => {
      publish(runtime);
    }, 10_000),
  );

  runtime.timers.push(
    setInterval(() => {
      void store.saveLiveSession(runtime.session).catch(() => undefined);
    }, 15_000),
  );

  runtime.timers.push(
    setInterval(() => {
      if (runtime.stopping) return;
      const count = runtime.pendingChat;
      runtime.pendingChat = 0;
      const point = pushHeat(runtime, runtime.duration, { chat: count });
      scoreMoment(runtime, point);
    }, TICK_MS),
  );
}

function spawnRecorder(runtime: Runtime, streamUrl: string): void {
  const args = [
    '-hide_banner',
    '-loglevel',
    'warning',
    '-progress',
    'pipe:1',
    '-nostats',
    '-y',
    '-reconnect',
    '1',
    '-reconnect_streamed',
    '1',
    '-reconnect_delay_max',
    '8',
    '-i',
    streamUrl,
    '-map',
    '0:v:0',
    '-map',
    '0:a:0?',
    '-c',
    'copy',
    '-f',
    'segment',
    '-segment_time',
    String(SEGMENT_SECONDS),
    '-segment_start_number',
    String(runtime.nextSegmentNumber),
    '-reset_timestamps',
    '1',
    '-segment_format',
    'mpegts',
    '-segment_format_options',
    'mpegts_flags=+resend_headers',
    path.join(runtime.segmentsDir, 'seg-%05d.ts'),
  ];
  const child = spawn(PATHS.ffmpeg, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  runtime.process = child;
  logTo(runtime, 'info', `Recorder online (segment ${runtime.nextSegmentNumber}).`);

  let stderr = '';
  let lastTime = -1;
  const receiveTime = (seconds: number) => {
    if (!Number.isFinite(seconds) || seconds <= lastTime) return;
    lastTime = seconds;
    runtime.duration = runtime.baseDuration + seconds;
    runtime.lastStableAt = Date.now();
  };
  // ffmpeg's -progress stream is machine-readable and works even at warning log level.
  child.stdout?.on('data', (chunk: Buffer) => {
    for (const line of chunk.toString().split('\n')) {
      const match = line.match(/^out_time_(?:us|ms)=(\d+)/);
      if (match) receiveTime(Number(match[1]) / 1_000_000);
    }
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-4000);
    const matches = [...stderr.matchAll(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/g)];
    const last = matches[matches.length - 1];
    if (last) {
      receiveTime(Number(last[1]) * 3600 + Number(last[2]) * 60 + Number(last[3]));
    }
  });

  child.on('error', (error) => {
    logTo(runtime, 'error', `Recorder process error: ${error.message}`);
  });

  child.on('close', (code) => {
    runtime.process = null;
    const files = segmentFiles(runtime);
    runtime.nextSegmentNumber = files.length ? segmentIndex(files[files.length - 1]!) + 1 : runtime.nextSegmentNumber;
    if (runtime.stopping) return;
    runtime.baseDuration = runtime.duration;
    logTo(runtime, 'warn', `Recorder stopped unexpectedly (code ${code}). Reconnecting…`);
    void supervise(runtime).catch((error) => {
      logTo(runtime, 'error', `Reconnect failed: ${(error as Error).message}`);
      runtime.session.status = 'failed';
      runtime.session.health = 'offline';
      runtime.session.error = (error as Error).message;
      publish(runtime, true);
    });
  });
}

async function supervise(runtime: Runtime): Promise<void> {
  if (runtime.stopping) return;
  runtime.attempts += 1;
  runtime.session.status = 'reconnecting';
  runtime.session.health = 'reconnecting';
  publish(runtime, true);
  const wait = Math.min(20_000, 1_500 * 2 ** Math.min(4, runtime.attempts));
  if (runtime.attempts <= 2) logTo(runtime, 'info', `Reconnecting in ${Math.round(wait / 1000)}s…`);
  await new Promise((resolve) => setTimeout(resolve, wait));
  if (runtime.stopping) return;
  const settings = store.getSettings();
  const maxHeight = settings.recordQuality === '720p' ? 720 : settings.recordQuality === '1080p' ? 1080 : undefined;
  const { streamUrl } = await resolveLiveStream(runtime.session.url, settings, undefined, maxHeight);
  runtime.session.status = 'recording';
  runtime.session.health = 'unstable';
  runtime.lastStableAt = Date.now();
  runtime.attempts = 0;
  spawnRecorder(runtime, streamUrl);
  publish(runtime, true);
}

// ---------- chat capture ----------

function connectTwitchChat(runtime: Runtime, slug: string): void {
  if (!slug) return;
  const socket = new WebSocket('wss://irc-ws.chat.twitch.tv:443');
  runtime.chatSocket = socket;
  const nick = `justinfan${Math.floor(10000 + Math.random() * 80000)}`;
  socket.on('open', () => {
    socket.send('CAP REQ :twitch.tv/tags twitch.tv/commands');
    socket.send('PASS SCHMOOPIIE');
    socket.send(`NICK ${nick}`);
    socket.send(`JOIN #${slug}`);
  });
  socket.on('message', (data) => {
    const text = data.toString();
    for (const line of text.split('\r\n')) {
      if (line.startsWith('PING')) {
        socket.send('PONG :tmi.twitch.tv');
        continue;
      }
      if (line.includes('PRIVMSG')) {
        runtime.pendingChat += 1;
        runtime.session.chatMessages += 1;
        if (!runtime.session.chatConnected) {
          runtime.session.chatConnected = true;
          logTo(runtime, 'info', `Chat connected to #${slug}.`);
          publish(runtime);
        }
      }
    }
  });
  socket.on('close', () => {
    runtime.session.chatConnected = false;
    publish(runtime);
    if (runtime.stopping) return;
    runtime.timers.push(setTimeout(() => connectTwitchChat(runtime, slug), 5_000));
  });
  socket.on('error', () => {
    runtime.session.chatConnected = false;
    try {
      socket.close();
    } catch {
      /* ignore */
    }
  });
}

async function resolveKickChatroom(slug: string): Promise<number | null> {
  if (!slug) return null;
  try {
    const response = await fetch(`https://kick.com/api/v2/channels/${encodeURIComponent(slug)}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 TeraClip/1.0', Accept: 'application/json' },
      signal: AbortSignal.timeout(12_000),
    });
    if (!response.ok) return null;
    const data = (await response.json()) as { chatroom?: { id?: number }; id?: number };
    return data.chatroom?.id ?? data.id ?? null;
  } catch {
    return null;
  }
}

async function connectKickChat(runtime: Runtime, slug: string): Promise<void> {
  const chatroomId = await resolveKickChatroom(slug);
  if (!chatroomId || runtime.stopping) return;
  const socket = new WebSocket('wss://ws-us2.pusher.com/app/32cbd69e4b950bf97679?protocol=7&client=js&version=8.4.0&flash=false');
  runtime.chatSocket = socket;
  socket.on('open', () => {
    socket.send(JSON.stringify({ event: 'pusher:subscribe', data: { auth: '', channel: `channel.${chatroomId}` } }));
  });
  socket.on('message', (data) => {
    try {
      const event = JSON.parse(data.toString()) as { event?: string };
      if (event.event && /ChatMessage/i.test(event.event)) {
        runtime.pendingChat += 1;
        runtime.session.chatMessages += 1;
        if (!runtime.session.chatConnected) {
          runtime.session.chatConnected = true;
          logTo(runtime, 'info', `Chat connected to ${slug}.`);
          publish(runtime);
        }
      }
    } catch {
      /* ignore */
    }
  });
  socket.on('close', () => {
    runtime.session.chatConnected = false;
    publish(runtime);
    if (runtime.stopping) return;
    runtime.timers.push(setTimeout(() => void connectKickChat(runtime, slug), 6_000));
  });
  socket.on('error', () => {
    runtime.session.chatConnected = false;
    try {
      socket.close();
    } catch {
      /* ignore */
    }
  });
}

function connectChat(runtime: Runtime, platform: PlatformId, url: string): void {
  const slug = channelSlug(url);
  if (!slug) return;
  if (platform === 'twitch') connectTwitchChat(runtime, slug);
  else if (platform === 'kick') void connectKickChat(runtime, slug);
  else logTo(runtime, 'info', 'Chat capture is available for Twitch and Kick; audio heat still records.');
}

// ---------- public API ----------

export async function resolveLive(url: string): Promise<{
  title: string;
  channel: string;
  platform: PlatformId;
  thumbnail?: string;
  isLive: boolean;
  liveStatus?: string;
  duration: number;
  width?: number;
  height?: number;
}> {
  const settings = store.getSettings();
  const info = await resolveSource(url, settings);
  return {
    title: info.title,
    channel: info.channel || '',
    platform: info.platform,
    thumbnail: info.thumbnail,
    isLive: info.isLive,
    liveStatus: info.liveStatus,
    duration: info.duration,
    width: info.width,
    height: info.height,
  };
}

export interface StartLiveInput {
  url: string;
  title?: string;
  autoClip?: boolean;
}

export async function startLive(input: StartLiveInput): Promise<LiveSession> {
  if (activeLiveSession()) throw new Error('A live recording is already running. Stop it before starting another.');
  const settings = store.getSettings();
  const info = await resolveSource(input.url, settings);
  if (!info.isLive) throw new Error('That link is not live right now. Paste the channel URL while the stream is on air.');
  const maxHeight = settings.recordQuality === '720p' ? 720 : settings.recordQuality === '1080p' ? 1080 : undefined;
  const { streamUrl } = await resolveLiveStream(input.url, settings, undefined, maxHeight);

  const id = `live_${nanoid(9)}`;
  const dir = path.join(PATHS.live, id);
  const segmentsDir = path.join(dir, 'segments');
  await fsp.mkdir(segmentsDir, { recursive: true });
  const session: LiveSession = {
    id,
    platform: info.platform,
    url: input.url,
    channel: info.channel || channelSlug(input.url),
    title: (input.title || info.title || 'Live session').slice(0, 140),
    thumbnailUrl: info.thumbnail,
    status: 'preparing',
    startedAt: stamp(),
    duration: 0,
    segments: 0,
    bytes: 0,
    health: 'good',
    chatConnected: false,
    chatMessages: 0,
    audioHeat: [],
    chatHeat: [],
    moments: [],
    autoClip: input.autoClip ?? settings.liveAutoClip,
    log: [],
    updatedAt: stamp(),
  };
  const runtime: Runtime = {
    session,
    dir,
    segmentsDir,
    process: null,
    stopping: false,
    attempts: 0,
    lastStableAt: Date.now(),
    nextSegmentNumber: 0,
    baseDuration: 0,
    duration: 0,
    analyzedSegment: -1,
    chatSocket: null,
    heat: [],
    timers: [],
    pendingChat: 0,
    segmentQueue: Promise.resolve(),
    lastAutoClipAt: -999,
    lastAutoProjectId: '',
    momentTask: null,
  };
  runtimes.set(id, runtime);
  await store.saveLiveSession(session);
  publish(runtime, true);
  logTo(runtime, 'info', `Recording ${info.platform} · ${info.title}`);
  session.status = 'recording';
  session.health = 'good';
  spawnRecorder(runtime, streamUrl);
  watchSegments(runtime);
  if (session.autoClip) logTo(runtime, 'info', `Auto-clip armed at ${settings.liveAutoClipThreshold}+ heat.`);
  connectChat(runtime, info.platform, input.url);
  publish(runtime, true);
  bus.emit('toast', { id: nanoid(8), tone: 'success', title: 'Live recording started', message: session.title });
  return session;
}

export async function stopLive(id: string): Promise<LiveSession> {
  const runtime = runtimes.get(id);
  const session = runtime?.session ?? store.getLiveSession(id);
  if (!session) throw new Error('Live session not found.');
  if (!runtime) {
    if (['recording', 'reconnecting', 'preparing', 'stopping'].includes(session.status)) {
      session.status = 'failed';
      session.error = 'This recording belonged to a previous server run.';
      session.health = 'offline';
      await store.saveLiveSession(session);
    }
    return session;
  }
  if (runtime.stopping) return runtime.session;
  runtime.stopping = true;
  session.status = 'stopping';
  publish(runtime, true);
  logTo(runtime, 'info', 'Stopping recorder and finalising segments…');

  for (const timer of runtime.timers) clearInterval(timer);
  runtime.timers = [];
  if (runtime.chatSocket) {
    try {
      runtime.chatSocket.close();
    } catch {
      /* ignore */
    }
  }

  const child = runtime.process;
  if (child) {
    const closed = new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 12_000);
      child.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    try {
      child.stdin?.write('q\n');
      child.stdin?.end();
    } catch {
      /* ignore */
    }
    await closed;
    killTree(child.pid);
  }
  runtime.process = null;

  await runtime.segmentQueue.catch(() => undefined);
  // A moment remux may still be reading segments. Let it finish before the
  // final pass touches the same files.
  if (runtime.momentTask) await runtime.momentTask.catch(() => undefined);
  const files = segmentFiles(runtime);
  const retainedStart = files.length ? segmentIndex(files[0]!) * SEGMENT_SECONDS : 0;
  session.segments = files.length;
  if (!files.length) {
    session.status = 'failed';
    session.error = 'No video segments were captured.';
    session.health = 'offline';
    logTo(runtime, 'error', session.error);
    publish(runtime, true);
    runtimes.delete(id);
    return session;
  }

  try {
    const recording = path.join(runtime.dir, 'recording.mp4');
    await remuxTsSegments(files, path.join(runtime.dir, 'concat.txt'), recording);
    const probe = await probeMedia(recording).catch(() => null);
    if (probe?.duration) runtime.duration = probe.duration;
    session.status = 'ready';
    session.health = 'offline';
    session.endedAt = stamp();
    session.segments = files.length;
    if (retainedStart > 0) {
      // Moment-only mode kept just the tail. Rebase heat and moments so they
      // line up with the trimmed recording instead of the full stream clock.
      const shift = <T extends { t: number }>(point: T): T => ({
        ...point,
        t: Math.round(Math.max(0, point.t - retainedStart) * 10) / 10,
      });
      session.chatHeat = session.chatHeat.filter((point) => point.t >= retainedStart).map(shift);
      session.audioHeat = session.audioHeat.filter((point) => point.t >= retainedStart).map(shift);
      session.moments = session.moments.filter((moment) => moment.t >= retainedStart).map(shift);
      logTo(runtime, 'info', `Moment buffer discarded the first ${formatClock(retainedStart)} of video.`);
    }
    (session as LiveSession & { recordingPath?: string }).recordingPath = toData(recording);
    session.bytes = await fsp.stat(recording).then((stat) => stat.size).catch(() => session.bytes);
    void store.recordStudio({ liveSecondsCaptured: runtime.duration });
    // recording.mp4 now contains every segment. Keeping the intermediate TS
    // chunks doubles the session footprint for no benefit.
    await fsp.rm(runtime.segmentsDir, { recursive: true, force: true }).catch(() => undefined);
    await fsp.rm(path.join(runtime.dir, 'concat.txt'), { force: true }).catch(() => undefined);
    logTo(runtime, 'info', `Recording ready — ${formatClock(runtime.duration)} across ${files.length} segments.`);
    bus.emit('toast', {
      id: nanoid(8),
      tone: 'success',
      title: 'Live recording saved',
      message: `${formatClock(runtime.duration)} · ${session.title}`,
    });
  } catch (error) {
    session.status = 'failed';
    session.error = (error as Error).message;
    logTo(runtime, 'error', `Finalising failed: ${(error as Error).message}`);
  }
  publish(runtime, true);
  runtimes.delete(id);
  return session;
}

export function recordingPath(session: LiveSession): string | undefined {
  const custom = (session as LiveSession & { recordingPath?: string }).recordingPath;
  const candidates = [custom ? fromData(custom) : '', path.join(PATHS.live, session.id, 'recording.mp4')];
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  return undefined;
}

export async function createClipsFromLive(
  id: string,
  settings?: Partial<ClipSettings>,
): Promise<{ projectId: string; rawRecordingKept: boolean }> {
  const session = store.getLiveSession(id);
  if (!session) throw new Error('Live session not found.');
  if (liveBusy(id)) throw new Error('Stop the recording before creating clips.');
  const source = recordingPath(session);
  if (!source) throw new Error('This session has no finished recording yet.');
  const keepRaw = store.getSettings().liveKeepRecording;
  // Stage a hard link rather than a copy. Both paths reference the same bytes,
  // so a 6 GB session never needs a second copy while the project is created.
  // If the volume does not support links, fall back to a real copy.
  const staged = path.join(PATHS.uploads, `live-${id}-${Date.now()}.mp4`);
  let filePath = source;
  try {
    await fsp.link(source, staged);
    filePath = staged;
  } catch {
    await fsp.copyFile(source, staged);
    filePath = staged;
  }
  let project: Awaited<ReturnType<typeof createProject>>;
  try {
    project = await createProject({
      title: session.title,
      channel: session.channel,
      platform: session.platform,
      sourceKind: 'live',
      filePath,
      sourceUrl: session.url,
      duration: session.duration,
      chatHeat: session.chatHeat,
      settings,
    });
  } catch (error) {
    // adoptSource normally renames the link away; if creation failed before
    // that, drop the staging link. The original recording is untouched.
    await fsp.rm(staged, { force: true }).catch(() => undefined);
    throw error;
  }
  session.projectId = project.id;
  if (!keepRaw) {
    // Deleting this link does not remove the bytes: the project source is the
    // same inode. Turn on liveKeepRecording to keep a separate, deletable copy.
    await fsp.rm(source, { force: true }).catch((error) => log.warn('live recording cleanup failed', error));
    delete (session as LiveSession & { recordingPath?: string }).recordingPath;
  }
  await store.saveLiveSession(session);
  bus.emit('live.updated', { ...session });
  return { projectId: project.id, rawRecordingKept: keepRaw };
}

export async function deleteLive(id: string): Promise<void> {
  if (liveBusy(id)) throw new Error('Stop the recording before deleting it.');
  await store.deleteLiveSession(id);
}

export function markInterruptedLive(): void {
  for (const session of store.listLiveSessions()) {
    if (['recording', 'reconnecting', 'preparing', 'stopping'].includes(session.status)) {
      session.status = 'failed';
      session.error = 'Recording was interrupted by a server restart.';
      session.health = 'offline';
      void store.saveLiveSession(session);
    }
  }
}
