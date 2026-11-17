import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AsrModelId, ClipSettings, Transcript, TranscriptSegment, Word } from '../../shared/types';
import { PATHS } from '../config';
import { log } from '../lib/logger';
import { runProcess } from '../lib/process';
import { ensureWhisperModel } from './binaries';
import { probeMedia } from './media';

interface WhisperToken {
  text?: string;
  offsets?: { from?: number; to?: number };
  p?: number;
  id?: number;
}

interface WhisperItem {
  text?: string;
  offsets?: { from?: number; to?: number };
  tokens?: WhisperToken[];
}

interface WhisperJson {
  result?: { language?: string };
  transcription?: WhisperItem[];
}

const DTW_PRESETS: Record<AsrModelId, string | null> = {
  'base.en': 'base.en',
  base: 'base',
  'small.en': 'small.en',
  'tiny.en': 'tiny.en',
};

const CHUNK_SECONDS = 30 * 60;

function stripSpecial(text: string): string {
  return text
    .replace(/\[_[A-Z0-9_]+\]/g, '')
    .replace(/\[[A-Z]{2,}\]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function tidyWord(text: string): string {
  return stripSpecial(text).replace(/^[\s-]+/, '').trim();
}

function joinWords(words: string[]): string {
  return words
    .join(' ')
    .replace(/\s+([,.;:!?%])/g, '$1')
    .replace(/([{([“‘])\s+/g, '$1')
    .replace(/\s+([)\]”’])/g, '$1')
    .replace(/\s+'/g, "'")
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function parseWhisperJson(data: WhisperJson, offset: number, totalDuration: number): { words: Word[]; language: string } {
  const words: Word[] = [];
  for (const item of data.transcription || []) {
    const rawText = tidyWord(String(item.text || ''));
    if (!rawText) continue;
    const tokens = (item.tokens || []).filter((token) => token.text && !/\[_[A-Z0-9_]+\]/.test(token.text));
    const start = Number(item.offsets?.from ?? 0) / 1000 + offset;
    const end = Number(item.offsets?.to ?? item.offsets?.from ?? 0) / 1000 + offset;
    const probs = tokens.map((token) => Number(token.p ?? 1)).filter((n) => Number.isFinite(n));
    const confidence = probs.length ? probs.reduce((a, b) => a + b, 0) / probs.length : 1;

    // A word segment normally contains one word; if whisper emitted more, distribute the timing.
    const parts = rawText.split(/\s+/).filter(Boolean);
    const span = Math.max(0.06, end - start);
    if (parts.length === 1) {
      words.push({ text: parts[0]!, start, end: Math.max(start + 0.06, end), p: confidence });
    } else {
      const totalChars = parts.reduce((sum, part) => sum + part.length, 0) || 1;
      let cursor = start;
      for (const part of parts) {
        const partDuration = (part.length / totalChars) * span;
        words.push({
          text: part,
          start: cursor,
          end: Math.max(cursor + 0.06, cursor + partDuration),
          p: confidence,
        });
        cursor += partDuration;
      }
    }
  }

  // Repair overlapping / zero-length timings from quantised models.
  words.sort((a, b) => a.start - b.start);
  for (let i = 0; i < words.length; i++) {
    const word = words[i]!;
    const next = words[i + 1];
    if (word.end <= word.start) word.end = word.start + 0.12;
    if (next && word.end > next.start) word.end = Math.max(word.start + 0.05, next.start - 0.01);
    if (word.start > totalDuration) word.start = totalDuration;
    word.end = Math.min(totalDuration, Math.max(word.start + 0.05, word.end));
    word.start = Math.max(0, word.start);
  }
  return { words, language: data.result?.language || 'en' };
}

function buildSegments(words: Word[]): TranscriptSegment[] {
  const segments: TranscriptSegment[] = [];
  let bucket: Word[] = [];
  let start = 0;
  let lastEnd = 0;
  const flush = () => {
    if (!bucket.length) return;
    segments.push({
      start,
      end: Math.max(lastEnd, start + 0.1),
      text: joinWords(bucket.map((w) => w.text)),
      words: [...bucket],
    });
    bucket = [];
  };
  for (const word of words) {
    if (!bucket.length) {
      bucket = [word];
      start = word.start;
      lastEnd = word.end;
      continue;
    }
    const gap = word.start - lastEnd;
    const sentenceEnd = /[.!?]["')\]]?$/.test(bucket[bucket.length - 1]?.text || '');
    const tooLong = word.end - start > 9 || bucket.length > 32;
    if (gap > 0.9 || (sentenceEnd && gap > 0.18) || tooLong) {
      flush();
      bucket = [word];
      start = word.start;
      lastEnd = word.end;
    } else {
      bucket.push(word);
      lastEnd = word.end;
    }
  }
  flush();
  return segments;
}

async function splitWav(file: string, outDir: string, duration: number, signal?: AbortSignal): Promise<Array<{ path: string; offset: number; duration: number }>> {
  await fsp.mkdir(outDir, { recursive: true });
  await runProcess(
    PATHS.ffmpeg,
    [
      '-y',
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      file,
      '-f',
      'segment',
      '-segment_time',
      String(CHUNK_SECONDS),
      '-reset_timestamps',
      '1',
      '-c',
      'copy',
      path.join(outDir, 'chunk_%03d.wav'),
    ],
    { signal, throwOnError: true, timeoutMs: 5 * 60_000, label: 'audio chunking' },
  );
  const files = (await fsp.readdir(outDir)).filter((f) => f.endsWith('.wav')).sort();
  return files.map((name, index) => ({
    path: path.join(outDir, name),
    offset: index * CHUNK_SECONDS,
    duration: Math.min(CHUNK_SECONDS, Math.max(0, duration - index * CHUNK_SECONDS)),
  }));
}

function resolveThreads(configured: number): number {
  if (Number.isFinite(configured) && configured > 0) {
    return Math.max(1, Math.min(8, Math.round(configured)));
  }
  return Math.max(2, Math.min(8, os.cpus().length));
}

async function whisperPass(
  wav: string,
  outBase: string,
  settings: Pick<ClipSettings, 'asrModel' | 'language'>,
  threads: number,
  duration: number,
  onProgress: (progress: number, message: string) => void,
  signal?: AbortSignal,
  withDtw = true,
): Promise<WhisperJson> {
  const modelPath = await ensureWhisperModel(settings.asrModel);
  const modelName = path.basename(modelPath);
  const dtw = withDtw ? DTW_PRESETS[settings.asrModel] : null;
  const args = [
    '-m',
    modelPath,
    '-f',
    wav,
    '-t',
    String(Math.max(1, Math.min(8, threads))),
    '-ml',
    '1',
    '-sow',
    '-oj',
    '-of',
    outBase,
    '-np',
    '-pp',
    ...(modelName.includes('.en') ? ['-l', 'en'] : ['-l', settings.language || 'auto']),
    ...(dtw ? ['-dtw', dtw] : []),
  ];
  const label = `whisper ${dtw ? 'dtw' : 'plain'}`;
  const result = await runProcess(PATHS.whisperCli, args, {
    signal,
    throwOnError: false,
    label,
    maxBuffer: 8 * 1024 * 1024,
    onStderrLine: (line) => {
      const match = line.match(/progress\s*=\s*(\d+)%/i);
      if (match) onProgress(Number(match[1]) / 100, `Transcribing · ${match[1]}%`);
    },
    onStdoutLine: (line) => {
      const match = line.match(/progress\s*=\s*(\d+)%/i);
      if (match) onProgress(Number(match[1]) / 100, `Transcribing · ${match[1]}%`);
    },
  });
  const jsonPath = `${outBase}.json`;
  if (result.code !== 0 || !fs.existsSync(jsonPath)) {
    if (withDtw && /dtw|alignment|timestamp/i.test(result.stderr)) {
      log.warn('DTW alignment failed, retrying without DTW');
      return whisperPass(wav, outBase, settings, threads, duration, onProgress, signal, false);
    }
    throw new Error(`Transcription failed: ${result.stderr.trim().split('\n').slice(-6).join(' ')}`);
  }
  try {
    return JSON.parse(await fsp.readFile(jsonPath, 'utf8')) as WhisperJson;
  } catch {
    throw new Error('Transcription produced unreadable JSON.');
  }
}

export async function transcribeProject(
  options: {
    audioPath: string;
    duration: number;
    projectId: string;
    projectDir: string;
    settings: ClipSettings;
    threads: number;
    force?: boolean;
    signal?: AbortSignal;
    onProgress: (progress: number, message: string) => void;
  },
): Promise<{ transcript: Transcript; cached: boolean }> {
  const transcriptPath = path.join(options.projectDir, 'transcript.json');
  if (!options.force && fs.existsSync(transcriptPath)) {
    try {
      const existing = JSON.parse(await fsp.readFile(transcriptPath, 'utf8')) as Transcript;
      if (existing.words?.length && Math.abs(existing.duration - options.duration) < 2) {
        return { transcript: existing, cached: true };
      }
    } catch {
      /* re-transcribe */
    }
  }
  if (!fs.existsSync(PATHS.whisperCli)) throw new Error('whisper.cpp is not ready. Run npm run setup.');
  if (!fs.existsSync(options.audioPath)) throw new Error('Extracted audio is missing.');

  const probe = await probeMedia(options.audioPath).catch(() => null);
  const duration = options.duration || probe?.duration || 0;
  const isLong = duration > 45 * 60;
  const workDir = path.join(options.projectDir, 'work', 'transcribe');
  const threads = resolveThreads(options.threads);
  await fsp.mkdir(workDir, { recursive: true });

  let chunks: Array<{ path: string; offset: number; duration: number }>;
  if (isLong) {
    options.onProgress(0.02, 'Splitting long audio into safe chunks…');
    chunks = await splitWav(options.audioPath, workDir, duration, options.signal);
  } else {
    chunks = [{ path: options.audioPath, offset: 0, duration }];
  }

  const allWords: Word[] = [];
  let language = '';
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i]!;
    const base = path.join(workDir, `chunk-${String(i).padStart(3, '0')}`);
    const result = await whisperPass(
      chunk.path,
      base,
      options.settings,
      threads,
      chunk.duration,
      (progress, message) => {
        const overall = (i + progress) / chunks.length;
        options.onProgress(overall, chunks.length > 1 ? `${message} · part ${i + 1}/${chunks.length}` : message);
      },
      options.signal,
    );
    const parsed = parseWhisperJson(result, chunk.offset, duration);
    language = parsed.language || language;
    // Ignore overlapping words at chunk seams so they are not captioned twice.
    for (const word of parsed.words) {
      if (i > 0 && word.start < chunk.offset + 0.05) continue;
      if (i < chunks.length - 1 && word.start >= chunk.offset + chunk.duration - 0.05) continue;
      allWords.push(word);
    }
  }

  allWords.sort((a, b) => a.start - b.start);
  const segments = buildSegments(allWords);
  const transcript: Transcript = {
    language: language || (options.settings.asrModel.endsWith('.en') ? 'en' : options.settings.language || 'auto'),
    duration,
    words: allWords,
    segments,
    model: options.settings.asrModel,
    createdAt: new Date().toISOString(),
  };
  await fsp.writeFile(transcriptPath, JSON.stringify(transcript, null, 2), 'utf8');
  await fsp.rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  log.info(`transcribed ${duration.toFixed(1)}s → ${allWords.length} words in ${segments.length} segments`);
  return { transcript, cached: false };
}

export function wordsInRange(transcript: Transcript, start: number, end: number): Word[] {
  return transcript.words
    .filter((word) => word.end > start + 0.02 && word.start < end - 0.02)
    .map((word) => ({
      ...word,
      start: Math.max(start, word.start),
      end: Math.min(end, word.end),
    }));
}
