import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { Readable } from 'node:stream';
import { PATHS } from '../config';
import { runProcess, killTree } from '../lib/process';
import { log } from '../lib/logger';

export interface MediaProbe {
  duration: number;
  width: number;
  height: number;
  fps: number;
  hasVideo: boolean;
  hasAudio: boolean;
  videoCodec?: string;
  audioCodec?: string;
  bitrate?: number;
  rotation: number;
  displayWidth: number;
  displayHeight: number;
}

interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  avg_frame_rate?: string;
  r_frame_rate?: string;
  duration?: string;
  bit_rate?: string;
  tags?: Record<string, string>;
  side_data_list?: Array<{ rotation?: number }>;
}

interface FfprobeFormat {
  duration?: string;
  bit_rate?: string;
}

export async function ffprobeJson(file: string): Promise<{ streams: FfprobeStream[]; format?: FfprobeFormat }> {
  if (!PATHS.ffprobe) throw new Error('ffprobe is not available. Run npm install.');
  const result = await runProcess(
    PATHS.ffprobe,
    ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file],
    { throwOnError: false, timeoutMs: 60_000 },
  );
  if (result.code !== 0) throw new Error(`Could not read media: ${result.stderr.slice(-400)}`);
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error('ffprobe returned invalid JSON');
  }
}

function parseRate(rate?: string): number {
  if (!rate) return 0;
  const [a, b] = rate.split('/').map(Number);
  if (!b) return Number(a) || 0;
  return (Number(a) || 0) / b;
}

export async function probeMedia(file: string): Promise<MediaProbe> {
  const json = await ffprobeJson(file);
  const video = json.streams.find((s) => s.codec_type === 'video');
  const audio = json.streams.find((s) => s.codec_type === 'audio');
  const duration = Number(json.format?.duration || video?.duration || 0);
  let width = video?.width || 0;
  let height = video?.height || 0;
  let rotation = 0;
  const side = video?.side_data_list?.find((s) => typeof s.rotation === 'number');
  if (side?.rotation) rotation = Number(side.rotation);
  else if (video?.tags?.rotate) rotation = Number(video.tags.rotate);
  const swapped = Math.abs(rotation) % 180 === 90;
  const displayWidth = swapped ? height : width;
  const displayHeight = swapped ? width : height;
  return {
    duration: Number.isFinite(duration) ? duration : 0,
    width,
    height,
    displayWidth,
    displayHeight,
    fps: parseRate(video?.avg_frame_rate || video?.r_frame_rate) || 30,
    hasVideo: Boolean(video),
    hasAudio: Boolean(audio),
    videoCodec: video?.codec_name,
    audioCodec: audio?.codec_name,
    bitrate: Number(json.format?.bit_rate || 0),
    rotation,
  };
}

export async function extractAudioWav(source: string, out: string, duration: number, signal?: AbortSignal): Promise<void> {
  await fsp.mkdir(path.dirname(out), { recursive: true });
  await runProcess(
    PATHS.ffmpeg,
    [
      '-y',
      '-hide_banner',
      '-loglevel',
      'error',
      '-progress',
      'pipe:1',
      '-nostats',
      '-i',
      source,
      '-vn',
      '-af',
      'highpass=f=70',
      '-ac',
      '1',
      '-ar',
      '16000',
      '-c:a',
      'pcm_s16le',
      out,
    ],
    {
      signal,
      throwOnError: true,
      label: 'audio extraction',
      maxBuffer: 2 * 1024 * 1024,
      onStdoutLine: () => undefined,
    },
  );
  if (!fs.existsSync(out) || (await fsp.stat(out)).size < 1000) throw new Error('Audio extraction produced an empty file');
  void duration;
}

export async function extractFrame(
  source: string,
  at: number,
  out: string,
  width = 720,
  signal?: AbortSignal,
): Promise<void> {
  await fsp.mkdir(path.dirname(out), { recursive: true });
  const safeAt = Math.max(0, at);
  await runProcess(
    PATHS.ffmpeg,
    [
      '-y',
      '-hide_banner',
      '-loglevel',
      'error',
      '-ss',
      safeAt.toFixed(3),
      '-i',
      source,
      '-frames:v',
      '1',
      '-vf',
      `scale=${width}:-2:flags=lanczos`,
      '-q:v',
      '3',
      out,
    ],
    { signal, throwOnError: true, timeoutMs: 90_000, label: 'thumbnail' },
  );
}

export async function extractThumbnailSmart(
  source: string,
  at: number,
  out: string,
  width = 540,
  height = 960,
  signal?: AbortSignal,
): Promise<void> {
  await fsp.mkdir(path.dirname(out), { recursive: true });
  await runProcess(
    PATHS.ffmpeg,
    [
      '-y',
      '-hide_banner',
      '-loglevel',
      'error',
      '-ss',
      Math.max(0, at).toFixed(3),
      '-i',
      source,
      '-frames:v',
      '1',
      '-vf',
      `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},setsar=1`,
      '-q:v',
      '3',
      out,
    ],
    { signal, throwOnError: true, timeoutMs: 90_000, label: 'clip thumbnail' },
  );
}

export interface RgbFrame {
  index: number;
  t: number;
  rgb: Buffer;
  width: number;
  height: number;
  scale: number;
  padX: number;
  padY: number;
  sourceWidth: number;
  sourceHeight: number;
}

/**
 * Decode frames as 640x640 letterboxed RGB24 into a callback.
 * Frames are paused while the callback runs so a slow CPU never builds a memory queue.
 */
export function decodeRgbFrames(
  source: string,
  opts: {
    start: number;
    duration: number;
    fps?: number;
    sourceWidth: number;
    sourceHeight: number;
    signal?: AbortSignal;
    onFrame: (frame: RgbFrame) => Promise<void> | void;
  },
): Promise<void> {
  const size = 640;
  const fps = opts.fps ?? 2;
  const frameBytes = size * size * 3;
  const sourceAspect = opts.sourceWidth / opts.sourceHeight;
  let scaledW = size;
  let scaledH = size;
  if (sourceAspect > 1) scaledH = Math.round(size / sourceAspect);
  else scaledW = Math.round(size * sourceAspect);
  const padX = Math.round((size - scaledW) / 2);
  const padY = Math.round((size - scaledH) / 2);

  return new Promise((resolve, reject) => {
    const args = [
      '-hide_banner',
      '-loglevel',
      'error',
      '-ss',
      Math.max(0, opts.start).toFixed(3),
      '-t',
      Math.max(0.1, opts.duration).toFixed(3),
      '-i',
      source,
      '-an',
      '-vf',
      `fps=${fps},scale=${scaledW}:${scaledH}:flags=bilinear,pad=${size}:${size}:${padX}:${padY}:black`,
      '-f',
      'rawvideo',
      '-pix_fmt',
      'rgb24',
      '-threads',
      '2',
      'pipe:1',
    ];
    const child = spawn(PATHS.ffmpeg, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = child.stdout as Readable;
    let pending = Buffer.alloc(0);
    let index = 0;
    let chain = Promise.resolve();
    let stderr = '';

    const signalHandler = () => killTree(child.pid);
    opts.signal?.addEventListener('abort', signalHandler, { once: true });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
      if (stderr.length > 20_000) stderr = stderr.slice(-10_000);
    });

    stdout.on('data', (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);
      while (pending.length >= frameBytes) {
        const rgb = pending.subarray(0, frameBytes);
        pending = pending.subarray(frameBytes);
        const t = opts.start + index / fps;
        const frame: RgbFrame = {
          index,
          t,
          rgb,
          width: size,
          height: size,
          scale: scaledW,
          padX,
          padY,
          sourceWidth: opts.sourceWidth,
          sourceHeight: opts.sourceHeight,
        };
        index += 1;
        stdout.pause();
        chain = chain
          .then(() => opts.onFrame(frame))
          .then(() => {
            stdout.resume();
          })
          .catch((error) => {
            killTree(child.pid);
            reject(error);
          });
      }
    });

    child.on('error', reject);
    child.on('close', (code) => {
      opts.signal?.removeEventListener('abort', signalHandler);
      chain
        .then(() => {
          if (opts.signal?.aborted) reject(new DOMException('Frame decode aborted', 'AbortError'));
          else if (code !== 0 && index === 0) reject(new Error(`Frame decode failed: ${stderr.slice(-400)}`));
          else resolve();
        })
        .catch(reject);
    });
  });
}

export async function remuxTsSegments(segments: string[], listFile: string, out: string, signal?: AbortSignal): Promise<void> {
  await fsp.writeFile(
    listFile,
    segments
      .map((segment) => `file '${segment.replace(/'/g, "'\\''")}'`)
      .join('\n'),
    'utf8',
  );
  await runProcess(
    PATHS.ffmpeg,
    [
      '-y',
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'concat',
      '-safe',
      '0',
      '-i',
      listFile,
      '-fflags',
      '+genpts',
      '-c',
      'copy',
      '-movflags',
      '+faststart',
      out,
    ],
    { signal, throwOnError: true, timeoutMs: 15 * 60_000, label: 'live remux' },
  );
  log.info(`remuxed ${segments.length} live segments to ${out}`);
}

export async function safeDuration(file: string): Promise<number> {
  try {
    const probe = await probeMedia(file);
    return probe.duration;
  } catch {
    return 0;
  }
}
