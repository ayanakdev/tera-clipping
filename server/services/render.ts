import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type {
  AspectRatio,
  ClipFiles,
  ClipRecord,
  FaceSample,
  LayoutNotice,
  PipRect,
  QualityMode,
  RenderAcceleration,
  Word,
} from '../../shared/types';
import { ASPECT_SIZES } from '../../shared/presets';
import { PATHS, fromData, toData } from '../config';
import { log } from '../lib/logger';
import { parseFfmpegProgress, runProcess } from '../lib/process';
import { writeCaptionFiles } from './captions';
import { renderHookPng } from './hook';
import { planReframe, cropExpressionForSamples, splitExpressionForSamples, safeInsets, panelHeights, SPLIT_CAM_TOP_RATIO } from './reframe';

const QUALITY: Record<QualityMode, { preset: string; crf: number }> = {
  fast: { preset: 'veryfast', crf: 23 },
  balanced: { preset: 'faster', crf: 21 },
  high: { preset: 'medium', crf: 19 },
};

const HARDWARE_CQ: Record<QualityMode, number> = {
  fast: 24,
  balanced: 22,
  high: 19,
};

type HardwareEncoder = 'h264_qsv' | 'h264_nvenc' | 'h264_amf';
let hardwareProbe: Promise<HardwareEncoder | null> | null = null;
let hardwareDisabled = false;

/**
 * ffmpeg may list hardware encoders that this machine cannot actually open
 * (no driver, no GPU, wrong vendor). Probe once with a tiny frame, then keep
 * the answer for the life of the process.
 */
async function probeHardwareEncoder(): Promise<HardwareEncoder | null> {
  if (hardwareDisabled) return null;
  if (hardwareProbe) return hardwareProbe;
  hardwareProbe = (async () => {
    for (const encoder of ['h264_qsv', 'h264_nvenc', 'h264_amf'] as HardwareEncoder[]) {
      try {
        const result = await runProcess(
          PATHS.ffmpeg,
          [
            '-hide_banner',
            '-loglevel',
            'error',
            '-f',
            'lavfi',
            '-i',
            'color=c=black:s=256x256:d=0.2',
            '-frames:v',
            '1',
            '-c:v',
            encoder,
            '-f',
            'null',
            '-',
          ],
          { throwOnError: false, timeoutMs: 15_000, maxBuffer: 256 * 1024, label: `probe ${encoder}` },
        );
        if (result.code === 0) {
          log.info(`render acceleration enabled: ${encoder}`);
          return encoder;
        }
      } catch {
        // Try the next vendor.
      }
    }
    log.info('render acceleration: CPU only');
    return null;
  })();
  return hardwareProbe;
}

function encoderArgs(encoder: HardwareEncoder | null, quality: QualityMode): string[] {
  if (!encoder) {
    const cpu = QUALITY[quality];
    return ['-c:v', 'libx264', '-preset', cpu.preset, '-crf', String(cpu.crf), '-pix_fmt', 'yuv420p'];
  }
  const cq = HARDWARE_CQ[quality];
  if (encoder === 'h264_qsv') {
    const preset = quality === 'high' ? 'medium' : quality === 'fast' ? 'veryfast' : 'faster';
    return ['-c:v', 'h264_qsv', '-preset', preset, '-global_quality', String(cq)];
  }
  if (encoder === 'h264_nvenc') {
    return ['-c:v', 'h264_nvenc', '-preset', 'p5', '-rc', 'vbr', '-cq', String(cq), '-b:v', '0'];
  }
  return ['-c:v', 'h264_amf', '-quality', 'balanced', '-rc', 'cqp', '-qp_i', String(cq), '-qp_p', String(cq)];
}

function disableHardware(encoder: HardwareEncoder): void {
  hardwareDisabled = true;
  hardwareProbe = Promise.resolve(null);
  log.warn(`render acceleration disabled after ${encoder} failed`);
}

/** Escape a native path for use inside an ffmpeg filter option. */
export function ffmpegFilterPath(nativePath: string): string {
  const forward = nativePath.replace(/\\/g, '/');
  return `'${forward.replace(/:/g, '\\:').replace(/'/g, "\\'")}'`;
}

interface LoudnessMeasurement {
  input_i: string;
  input_tp: string;
  input_lra: string;
  input_thresh: string;
  target_offset: string;
}

/**
 * Measure the clip's audio first so loudnorm can run in linear mode. Single-pass
 * loudnorm adapts on the fly and undershoots on short clips; linear mode applies
 * one constant gain, which preserves the streamer's voice and hits -14 LUFS.
 */
async function measureLoudness(
  sourcePath: string,
  start: number,
  duration: number,
  signal?: AbortSignal,
): Promise<LoudnessMeasurement | null> {
  try {
    const result = await runProcess(
      PATHS.ffmpeg,
      [
        '-hide_banner',
        '-nostats',
        '-ss',
        start.toFixed(3),
        '-t',
        duration.toFixed(3),
        '-i',
        sourcePath,
        '-vn',
        '-af',
        'highpass=f=35,loudnorm=I=-14:TP=-1.5:LRA=11:print_format=json',
        '-f',
        'null',
        '-',
      ],
      {
        signal,
        throwOnError: false,
        timeoutMs: 60_000,
        maxBuffer: 1024 * 1024,
        label: 'loudness measure',
      },
    );
    if (result.code !== 0) return null;
    const blocks = [...result.stderr.matchAll(/\{[\s\S]*?\}/g)];
    const raw = blocks[blocks.length - 1]?.[0];
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<LoudnessMeasurement> & { input_i?: string };
    if (
      !parsed.input_i ||
      !parsed.input_tp ||
      !parsed.input_lra ||
      !parsed.input_thresh ||
      !parsed.target_offset ||
      parsed.input_i.includes('inf')
    ) {
      return null;
    }
    return parsed as LoudnessMeasurement;
  } catch {
    return null;
  }
}

function enhanceAudio(enabled: boolean, measured: LoudnessMeasurement | null): string[] {
  if (!enabled) return [];
  // Keep this deliberately gentle. Stream audio is usually already compressed
  // and EQ'd by OBS, so a second compressor + makeup gain flattens the voice.
  // This only removes sub-bass rumble and matches loudness; it does not colour
  // or squash the voice.
  if (!measured) {
    return ['-af', 'highpass=f=35,loudnorm=I=-14:TP=-1.5:LRA=11,aresample=48000'];
  }
  const loudnorm = [
    'loudnorm=I=-14:TP=-1.5:LRA=11',
    `measured_I=${measured.input_i}`,
    `measured_TP=${measured.input_tp}`,
    `measured_LRA=${measured.input_lra}`,
    `measured_thresh=${measured.input_thresh}`,
    `offset=${measured.target_offset}`,
    'linear=true',
  ].join(':');
  return ['-af', `highpass=f=35,${loudnorm},aresample=48000`];
}

export function wordsForClip(words: Word[], start: number, end: number): Word[] {
  const out: Word[] = [];
  for (const word of words) {
    if (word.end <= start + 0.01 || word.start >= end - 0.01) continue;
    const from = Math.max(start, word.start);
    const to = Math.min(end, word.end);
    if (to - from <= 0.01) continue;
    out.push({ ...word, start: from - start, end: to - start });
  }
  return out;
}

export interface RenderClipOptions {
  clip: ClipRecord;
  sourcePath: string;
  projectDir: string;
  words: Word[];
  aspect: AspectRatio;
  quality: QualityMode;
  audioEnhance: boolean;
  watermark: boolean;
  brandHandle?: string;
  sourceWidth: number;
  sourceHeight: number;
  fps?: number;
  /** Auto tries a hardware H.264 encoder before falling back to CPU. */
  acceleration?: RenderAcceleration;
  /** Skip face analysis and reuse clip.faceSamples (edit re-renders). */
  reuseFraming?: boolean;
  signal?: AbortSignal;
  onProgress?: (progress: number, stage: string) => void;
}

export interface RenderClipResult {
  files: ClipFiles;
  faceSamples?: FaceSample[];
  /** Present when `auto` framing inspected the source. */
  notice?: LayoutNotice;
  /** Webcam overlay masked out of the game panel. */
  pipRect?: PipRect;
  duration: number;
  renderMs: number;
}

export async function renderClip(options: RenderClipOptions): Promise<RenderClipResult> {
  const started = Date.now();
  const { clip, aspect } = options;
  const duration = Math.max(0.5, clip.end - clip.start);
  const output = ASPECT_SIZES[aspect];
  const slug = `clip-${String(clip.index + 1).padStart(2, '0')}`;
  const clipsDir = path.join(options.projectDir, 'clips');
  await fsp.mkdir(clipsDir, { recursive: true });

  const finalAbs = path.join(clipsDir, `${slug}.mp4`);
  const assAbs = path.join(clipsDir, `${slug}.ass`);
  const srtAbs = path.join(clipsDir, `${slug}.srt`);
  const hookAbs = path.join(clipsDir, `${slug}-hook.png`);
  const thumbAbs = path.join(clipsDir, `${slug}.jpg`);

  options.onProgress?.(2, 'Cutting silent edges');
  const relativeWords = options.words
    .filter((word) => word.end > 0 && word.start < duration - 0.01)
    .map((word) => ({
      ...word,
      start: Math.max(0, Math.min(duration, word.start)),
      end: Math.max(0.01, Math.min(duration, word.end)),
    }));

  // `auto` resolved to a concrete layout on the first render; an edit re-render
  // must reuse that decision instead of inventing a different one.
  const effectiveFraming = clip.framing === 'auto' ? (clip.notice?.mode ?? 'smart') : clip.framing;
  let notice: LayoutNotice | undefined;
  options.onProgress?.(
    6,
    options.reuseFraming ? 'Reusing face framing' : clip.framing === 'auto' ? 'Noticing the layout' : 'Tracking faces',
  );
  let filter: string;
  let faceSamples: FaceSample[] | undefined;
  let pipRect: PipRect | undefined;
  if (options.reuseFraming && clip.faceSamples?.length) {
    faceSamples = clip.faceSamples;
    pipRect = clip.pipRect;
    if (clip.framing === 'auto') notice = clip.notice;
    filter =
      effectiveFraming === 'blur'
        ? await planBlurOnly(output.width, output.height)
        : effectiveFraming === 'center'
          ? cropExpressionForSamples(undefined, options.sourceWidth, options.sourceHeight, aspect, output.width, output.height, duration)
          : effectiveFraming === 'split'
            ? splitExpressionForSamples(faceSamples, options.sourceWidth, options.sourceHeight, output.width, output.height, duration)
            : effectiveFraming === 'split-cam-top'
              ? splitExpressionForSamples(faceSamples, options.sourceWidth, options.sourceHeight, output.width, output.height, duration, true, clip.pipRect)
              : cropExpressionForSamples(faceSamples, options.sourceWidth, options.sourceHeight, aspect, output.width, output.height, duration);
  } else {
    const plan = await planReframe({
      sourcePath: options.sourcePath,
      start: clip.start,
      duration,
      sourceWidth: options.sourceWidth,
      sourceHeight: options.sourceHeight,
      aspect,
      mode: clip.framing,
      outputWidth: output.width,
      outputHeight: output.height,
      signal: options.signal,
      onProgress: (ratio) => options.onProgress?.(6 + Math.round(ratio * 24), 'Tracking faces'),
    });
    filter = plan.filter;
    faceSamples = plan.faceSamples.length ? plan.faceSamples : undefined;
    notice = plan.notice;
    pipRect = plan.pipRect;
  }

  options.onProgress?.(32, 'Writing captions');
  const insets = safeInsets(output.width, output.height);
  const captionY =
    effectiveFraming === 'split-cam-top'
      ? Math.min(Math.round(output.height * 0.72), output.height - insets.bottom - 120)
      : undefined;
  await writeCaptionFiles(relativeWords, assAbs, srtAbs, {
    preset: clip.captionPreset,
    aspect,
    duration,
    scale: clip.captionScale ?? 1,
    subtitles: clip.subtitles,
    centerY: captionY,
  });

  options.onProgress?.(36, 'Building hook');
  const hasHook = await renderHookPng({
    text: clip.hook,
    style: clip.hookStyle,
    aspect,
    out: hookAbs,
    watermark: options.watermark,
    brandHandle: options.brandHandle,
    // Keep the hook off the facecam panel; place it just below the seam.
    top: effectiveFraming === 'split-cam-top'
      ? panelHeights(output.height, SPLIT_CAM_TOP_RATIO).topHeight + 16
      : undefined,
  });

  options.onProgress?.(40, 'Rendering clip');
  const captionFilter = `subtitles=filename=${ffmpegFilterPath(assAbs)}:fontsdir=${ffmpegFilterPath(PATHS.fonts)}`;
  const chains: string[] = [`[0:v]setpts=PTS-STARTPTS,${filter},${captionFilter}[base]`];
  if (hasHook) {
    chains.push('[base][1:v]overlay=0:0:format=auto[vout]');
  } else {
    chains.push('[base]null[vout]');
  }

  options.onProgress?.(39, 'Matching loudness');
  const loudness = options.audioEnhance
    ? await measureLoudness(options.sourcePath, clip.start, duration, options.signal)
    : null;

  const requestedEncoder = options.acceleration === 'cpu' ? null : await probeHardwareEncoder();
  const buildArgs = (encoder: HardwareEncoder | null): string[] => [
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    '-ss',
    clip.start.toFixed(3),
    '-t',
    duration.toFixed(3),
    '-i',
    options.sourcePath,
    ...(hasHook ? ['-i', hookAbs] : []),
    '-filter_complex',
    chains.join(';'),
    '-map',
    '[vout]',
    '-map',
    '0:a?',
    ...enhanceAudio(options.audioEnhance, loudness),
    ...encoderArgs(encoder, options.quality),
    '-c:a',
    'aac',
    '-b:a',
    '192k',
    '-ar',
    '48000',
    '-movflags',
    '+faststart',
    '-shortest',
    '-progress',
    'pipe:1',
    '-nostats',
    finalAbs,
  ];
  const runOptions = {
    signal: options.signal,
    throwOnError: false,
    timeoutMs: Math.max(6 * 60_000, duration * 45_000),
    maxBuffer: 4 * 1024 * 1024,
    label: 'clip render',
    onStdoutLine: (line: string) => {
      const value = parseFfmpegProgress(line, duration);
      if (value >= 0) options.onProgress?.(40 + Math.round((value / 100) * 56), 'Rendering clip');
    },
  };
  let encoderUsed = requestedEncoder;
  let result = await runProcess(PATHS.ffmpeg, buildArgs(encoderUsed), runOptions);
  if (result.code !== 0 && encoderUsed) {
    disableHardware(encoderUsed);
    encoderUsed = null;
    options.onProgress?.(40, 'Hardware encoder unavailable — using CPU');
    result = await runProcess(PATHS.ffmpeg, buildArgs(encoderUsed), runOptions);
  }
  if (result.code !== 0) {
    throw new Error(`Render failed: ${result.stderr.trim().split('\n').slice(-6).join(' ')}`);
  }

  options.onProgress?.(97, 'Making thumbnail');
  await runProcess(
    PATHS.ffmpeg,
    [
      '-y',
      '-hide_banner',
      '-loglevel',
      'error',
      '-ss',
      Math.min(1.2, duration / 3).toFixed(3),
      '-i',
      finalAbs,
      '-frames:v',
      '1',
      '-vf',
      'scale=540:-2:flags=lanczos',
      '-q:v',
      '3',
      thumbAbs,
    ],
    { signal: options.signal, throwOnError: true, timeoutMs: 60_000, label: 'thumbnail' },
  );

  const files: ClipFiles = {
    final: toData(finalAbs),
    ass: toData(assAbs),
    srt: toData(srtAbs),
    thumb: toData(thumbAbs),
    ...(hasHook ? { hookPng: toData(hookAbs) } : {}),
  };

  await fsp.rm(path.join(clipsDir, `${slug}.mp4.part`), { force: true }).catch(() => undefined);
  const renderMs = Date.now() - started;
  log.info(
    `rendered ${clip.id} (${duration.toFixed(1)}s) in ${(renderMs / 1000).toFixed(1)}s via ${encoderUsed ?? 'libx264'}`,
  );
  options.onProgress?.(100, 'Ready');
  return { files, faceSamples, notice, pipRect, duration, renderMs };
}

async function planBlurOnly(width: number, height: number): Promise<string> {
  return [
    'split=2[bg][fg]',
    `[bg]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},gblur=sigma=28,eq=brightness=-0.14[blurred]`,
    `[fg]scale=${width}:${height}:force_original_aspect_ratio=decrease[sharp]`,
    '[blurred][sharp]overlay=(W-w)/2:(H-h)/2,setsar=1',
  ].join(';');
}

/** Locate rendered media by clip record, even if its files were moved by hand. */
export function resolveClipFile(projectId: string, clip: ClipRecord, kind: keyof ClipFiles): string | undefined {
  const relative = clip.files[kind];
  if (!relative) return undefined;
  const abs = fromData(relative);
  return fs.existsSync(abs) ? abs : path.join(PATHS.projects, projectId, 'clips', path.basename(relative));
}
