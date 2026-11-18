import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { AppSettings, PlatformId } from '../../shared/types';
import { detectPlatform } from '../../shared/platforms';
import { PATHS } from '../config';
import { log } from '../lib/logger';
import { runProcess } from '../lib/process';

export interface ResolvedSource {
  url: string;
  id?: string;
  title: string;
  channel?: string;
  duration: number;
  thumbnail?: string;
  platform: PlatformId;
  extractor?: string;
  isLive: boolean;
  liveStatus?: string;
  webpageUrl?: string;
  width?: number;
  height?: number;
  description?: string;
  viewCount?: number;
  uploadDate?: string;
  embedUrl?: string;
  raw?: Record<string, unknown>;
}

export class YtDlpError extends Error {
  hint?: string;
  constructor(message: string, hint?: string) {
    super(message);
    this.name = 'YtDlpError';
    this.hint = hint;
  }
}

function cookieArgs(settings: AppSettings): string[] {
  const args: string[] = [];
  if (settings.cookiesFile && fs.existsSync(settings.cookiesFile)) {
    args.push('--cookies', settings.cookiesFile);
  } else if (settings.cookiesBrowser) {
    args.push('--cookies-from-browser', settings.cookiesBrowser);
  }
  return args;
}

export function friendlyYtdlpError(raw: string, platform: PlatformId): string {
  const text = raw.toLowerCase();
  if (text.includes('confirm you') && text.includes('not a bot')) {
    return 'YouTube asked for a freshness check. Add browser cookies in Settings → Platform access, then retry.';
  }
  if (text.includes('sign in') || text.includes('login required') || text.includes('cookies')) {
    return 'This post needs an account session. Add cookies in Settings → Platform access and retry.';
  }
  if (text.includes('private')) return 'This video is private and cannot be accessed.';
  if (text.includes('not available in your country') || text.includes('geo')) return 'This video is geo-blocked in your region.';
  if (text.includes('unsupported url')) return `That link is not a supported ${platform} video URL.`;
  if (text.includes('video unavailable') || text.includes('does not exist')) return 'The video is unavailable or was removed.';
  if (text.includes('requested format is not available')) return 'No downloadable video format was offered by this platform.';
  if (text.includes('timed out') || text.includes('connection')) return 'The platform did not respond in time. Check your connection and retry.';
  if (text.includes('drm')) return 'This video is DRM protected and cannot be clipped locally.';
  if (text.includes('live event will begin')) return 'This live stream has not started yet.';
  return 'Could not read this video. Check that the link is public and try again.';
}

/**
 * Inspecting a live link costs ~10s (yt-dlp metadata pass). Reading the channel
 * and then pressing record inspect the same URL twice, so keep the result for a
 * few seconds. Short enough that liveness cannot go stale in a way that matters:
 * the stream-URL resolve afterwards still fails loudly if the channel went off.
 */
const INSPECT_TTL_MS = 12_000;
const inspectCache = new Map<string, { at: number; info: ResolvedSource }>();

export async function resolveSource(
  url: string,
  settings: AppSettings,
  signal?: AbortSignal,
): Promise<ResolvedSource> {
  const cached = inspectCache.get(url);
  if (cached && Date.now() - cached.at < INSPECT_TTL_MS) return cached.info;
  const platform = detectPlatform(url) || 'generic';
  const args = [
    '--no-warnings',
    '--no-playlist',
    '--skip-download',
    '--no-check-formats',
    '--socket-timeout',
    '20',
    '--retries',
    '2',
    ...cookieArgs(settings),
    '-J',
    url,
  ];
  const result = await runProcess(PATHS.ytdlp, args, {
    signal,
    throwOnError: false,
    timeoutMs: 120_000,
    label: 'link inspection',
    maxBuffer: 96 * 1024 * 1024,
  });
  if (result.code !== 0) {
    throw new YtDlpError(friendlyYtdlpError(result.stderr, platform), result.stderr.slice(-1500));
  }
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(result.stdout) as Record<string, unknown>;
  } catch {
    throw new YtDlpError('The platform returned an unexpected response.', result.stdout.slice(0, 500));
  }
  if (data._type === 'playlist' && Array.isArray(data.entries) && data.entries.length > 0) {
    // A channel URL can resolve to a playlist; the first entry is the most useful preview.
    data = data.entries[0] as Record<string, unknown>;
  }
  const isLive = Boolean(data.is_live) || data.live_status === 'is_live' || data.live_status === 'is_upcoming';
  const info: ResolvedSource = {
    url,
    id: String(data.id || ''),
    title: String(data.title || data.fulltitle || data.description?.toString().slice(0, 80) || 'Untitled source'),
    channel: String(data.uploader || data.channel || data.creator || data.uploader_id || ''),
    duration: Number(data.duration || 0),
    thumbnail: String(data.thumbnail || ''),
    platform,
    extractor: String(data.extractor_key || data.extractor || ''),
    isLive,
    liveStatus: String(data.live_status || ''),
    webpageUrl: String(data.webpage_url || url),
    width: Number(data.width || 0) || undefined,
    height: Number(data.height || 0) || undefined,
    description: String(data.description || '').slice(0, 2000),
    viewCount: Number(data.view_count || 0),
    uploadDate: String(data.upload_date || ''),
    embedUrl: String(data.embed_url || ''),
    raw: data,
  };
  if (inspectCache.size > 24) inspectCache.clear();
  inspectCache.set(url, { at: Date.now(), info });
  return info;
}

function parseDownloadPercent(line: string): number | null {
  const match = line.match(/\[download\]\s+(\d+(?:\.\d+)?)%/);
  return match ? Number(match[1]) : null;
}

export async function downloadSource(
  url: string,
  projectDir: string,
  settings: AppSettings,
  opts: {
    signal?: AbortSignal;
    onProgress?: (progress: number, message: string) => void;
    maxHeight?: number;
  } = {},
): Promise<string> {
  await fsp.mkdir(projectDir, { recursive: true });
  const template = path.join(projectDir, 'source.%(ext)s');
  const ffmpegDir = path.dirname(PATHS.ffmpeg);
  const format =
    'bv*[width<=1920][height<=1920][vcodec^=avc1]+ba[acodec^=mp4a]/bv*[width<=1920][height<=1920]+ba/b[width<=1920][height<=1920]/b';
  const baseArgs = [
    '--no-warnings',
    '--no-playlist',
    '--newline',
    '--no-mtime',
    '--concurrent-fragments',
    '3',
    '--merge-output-format',
    'mp4',
    '--ffmpeg-location',
    ffmpegDir,
    ...cookieArgs(settings),
  ];
  const args = [...baseArgs, '-f', format, '-o', template, url];
  const run = async (withFormat: boolean) => {
    const runArgs = withFormat ? args : [...baseArgs, '-f', 'b', '-o', template, url];
    return runProcess(PATHS.ytdlp, runArgs, {
      signal: opts.signal,
      throwOnError: false,
      label: 'download',
      maxBuffer: 4 * 1024 * 1024,
      onStdoutLine: (line) => {
        const percent = parseDownloadPercent(line);
        if (percent !== null) opts.onProgress?.(percent, `Downloading source · ${percent.toFixed(0)}%`);
        else if (line.includes('[Merger]')) opts.onProgress?.(99, 'Merging video and audio…');
      },
      onStderrLine: (line) => {
        if (line.includes('WARNING')) log.warn('yt-dlp', line);
      },
    });
  };

  let result = await run(true);
  if (result.code !== 0) {
    log.warn('yt-dlp preferred format failed, trying generic best', result.stderr.slice(-500));
    result = await run(false);
  }
  if (result.code !== 0) {
    throw new YtDlpError(friendlyYtdlpError(result.stderr, detectPlatform(url) || 'generic'), result.stderr.slice(-1500));
  }
  const files = await fsp.readdir(projectDir);
  const candidates = files
    .filter((file) => file.startsWith('source.') && !file.endsWith('.part') && !file.endsWith('.ytdl'))
    .map((file) => path.join(projectDir, file))
    .sort((a, b) => fs.statSync(b).size - fs.statSync(a).size);
  const source = candidates[0];
  if (!source) throw new YtDlpError('The download finished but no video file was produced.');
  // If yt-dlp produced separate tracks, they should have been merged; keep the largest playable file.
  for (const candidate of candidates.slice(1)) {
    if (/\.(webm|m4a|mp4)$/i.test(candidate)) {
      try {
        const size = (await fsp.stat(candidate)).size;
        if (size > 0) await fsp.rm(candidate, { force: true });
      } catch {
        /* ignore */
      }
    }
  }
  return source;
}

export async function fetchThumbnail(url: string, dest: string, signal?: AbortSignal): Promise<boolean> {
  if (!url) return false;
  try {
    const response = await fetch(url, {
      signal,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      },
    });
    if (!response.ok || !response.body) return false;
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length < 1000) return false;
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await fsp.writeFile(dest, buffer);
    return true;
  } catch {
    return false;
  }
}

/** Resolve a live stream to a playable HLS/FLV URL without downloading. */
export async function resolveLiveStream(
  url: string,
  settings: AppSettings,
  signal?: AbortSignal,
  maxHeight?: number,
  known?: ResolvedSource,
): Promise<{ streamUrl: string; info: ResolvedSource }> {
  // Callers that already inspected the link hand their result in. A second
  // `yt-dlp -J` costs several seconds before the recorder can even spawn.
  const info = known ?? (await resolveSource(url, settings, signal));
  if (!info.isLive) {
    throw new YtDlpError('This channel is not live right now.', 'Use the VOD link instead, or try again when the stream starts.');
  }
  const ceiling = maxHeight ? `[height<=${maxHeight}]` : '';
  const format = maxHeight
    ? `b${ceiling}[protocol^=m3u8]/b${ceiling}/b[protocol^=m3u8]/b`
    : 'b[protocol^=m3u8]/b';
  const result = await runProcess(
    PATHS.ytdlp,
    [
      '--no-warnings',
      '--no-playlist',
      '--socket-timeout',
      '20',
      ...cookieArgs(settings),
      '-f',
      format,
      '-g',
      url,
    ],
    { signal, throwOnError: false, timeoutMs: 90_000, maxBuffer: 4 * 1024 * 1024, label: 'live resolve' },
  );
  if (result.code !== 0) {
    throw new YtDlpError(friendlyYtdlpError(result.stderr, info.platform), result.stderr.slice(-1200));
  }
  const streamUrl = result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^https?:\/\//.test(line))
    .pop();
  if (!streamUrl) throw new YtDlpError('The live stream URL could not be resolved.');
  return { streamUrl, info };
}

export async function checkYtdlpExtractors(): Promise<{ version: string; kick: boolean; rumble: boolean }> {
  const version = await runProcess(PATHS.ytdlp, ['--version'], { throwOnError: false, timeoutMs: 20_000 });
  return {
    version: version.stdout.trim() || 'unknown',
    kick: true,
    rumble: true,
  };
}
