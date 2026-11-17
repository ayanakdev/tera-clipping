import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { Readable } from 'node:stream';
import AdmZip from 'adm-zip';
import type { AsrModelId, BinStatus } from '../../shared/types';
import { CONFIG, PATHS } from '../config';
import { bus } from '../lib/events';
import { log } from '../lib/logger';
import { runProcess } from '../lib/process';

const require = createRequire(import.meta.url);

export const MODEL_FILES: Record<AsrModelId, string> = {
  'base.en': 'ggml-base.en-q5_1.bin',
  base: 'ggml-base-q5_1.bin',
  'small.en': 'ggml-small.en-q5_1.bin',
  'tiny.en': 'ggml-tiny.en-q5_1.bin',
};

export interface BinaryInfo {
  status: BinStatus;
  path?: string;
  version?: string;
  message?: string;
}

const statuses: Record<string, BinaryInfo> = {
  ffmpeg: { status: 'missing' },
  ffprobe: { status: 'missing' },
  ytdlp: { status: 'missing' },
  whisper: { status: 'missing' },
  whisperModel: { status: 'missing' },
  yunet: { status: 'missing' },
  fonts: { status: 'missing' },
};

let setupPromise: Promise<boolean> | null = null;
const versionCache = new Map<string, string>();

function emit(tool: string, received: number, total: number, message: string): void {
  bus.emit('setup.progress', { tool, received, total, message });
}

function resolveStaticPaths(): void {
  if (!PATHS.ffmpeg) {
    try {
      const ffmpeg = require('ffmpeg-static') as string;
      if (ffmpeg) PATHS.ffmpeg = ffmpeg;
    } catch {
      /* handled below */
    }
  }
  if (!PATHS.ffprobe) {
    try {
      const ffprobe = require('ffprobe-static') as { path?: string } | string;
      PATHS.ffprobe = typeof ffprobe === 'string' ? ffprobe : ffprobe.path || '';
    } catch {
      /* handled below */
    }
  }
}

resolveStaticPaths();

function exists(file?: string): boolean {
  return Boolean(file && fs.existsSync(file));
}

async function download(url: string, dest: string, label: string): Promise<void> {
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  const part = `${dest}.part`;
  log.info(`downloading ${label}`, { url });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10 * 60 * 1000);
  try {
    const response = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'User-Agent': 'TeraClip-Studio/1.0' },
    });
    if (!response.ok || !response.body) throw new Error(`HTTP ${response.status} for ${url}`);
    const total = Number(response.headers.get('content-length') || 0);
    const stream = Readable.fromWeb(response.body as never);
    const file = fs.createWriteStream(part);
    let received = 0;
    let lastEmit = 0;
    for await (const chunk of stream) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      received += buf.length;
      if (!file.write(buf)) await new Promise<void>((resolve) => file.once('drain', () => resolve()));
      const now = Date.now();
      if (now - lastEmit > 300) {
        lastEmit = now;
        const mb = (received / 1024 / 1024).toFixed(1);
        emit(label, received, total, total ? `${mb} / ${(total / 1048576).toFixed(1)} MB` : `${mb} MB`);
      }
    }
    await new Promise<void>((resolve, reject) => {
      file.end(() => resolve());
      file.on('error', reject);
    });
    if (received < 1000) throw new Error(`Downloaded file is suspiciously small (${received} bytes)`);
    await fsp.rm(dest, { force: true });
    await fsp.rename(part, dest);
    emit(label, received, total || received, 'Downloaded');
  } finally {
    clearTimeout(timeout);
    await fsp.rm(part, { force: true }).catch(() => undefined);
  }
}

async function fileSize(file: string): Promise<number> {
  try {
    return (await fsp.stat(file)).size;
  } catch {
    return 0;
  }
}

async function toolVersion(kind: 'ffmpeg' | 'ffprobe' | 'ytdlp', file: string): Promise<string | undefined> {
  if (versionCache.has(file)) return versionCache.get(file);
  try {
    const args = kind === 'ytdlp' ? ['--version'] : ['-version'];
    const result = await runProcess(file, args, { throwOnError: false, timeoutMs: 20_000 });
    const line = (result.stdout || result.stderr).split('\n')[0]?.trim();
    if (line) versionCache.set(file, line);
    return line;
  } catch {
    return undefined;
  }
}

export function getBinaries() {
  return {
    ffmpeg: { ...statuses.ffmpeg, path: PATHS.ffmpeg },
    ffprobe: { ...statuses.ffprobe, path: PATHS.ffprobe },
    ytdlp: { ...statuses.ytdlp, path: PATHS.ytdlp },
    whisper: { ...statuses.whisper, path: PATHS.whisperCli },
    whisperModel: {
      ...statuses.whisperModel,
      path: path.join(PATHS.models, MODEL_FILES['base.en']),
    },
    yunet: { ...statuses.yunet, path: PATHS.yunet },
    fonts: { ...statuses.fonts, path: PATHS.fonts },
  };
}

export function toolsReady(): boolean {
  return (
    statuses.ffmpeg.status === 'ready' &&
    statuses.ffprobe.status === 'ready' &&
    statuses.ytdlp.status === 'ready' &&
    statuses.whisper.status === 'ready' &&
    statuses.yunet.status === 'ready' &&
    statuses.fonts.status === 'ready'
  );
}

export function emitSetupStatus(): void {
  const missing = Object.entries(statuses)
    .filter(([, value]) => value.status !== 'ready')
    .map(([key]) => key);
  bus.emit('setup.status', {
    ready: toolsReady(),
    missing,
    message: missing.length ? `Preparing ${missing.join(', ')}…` : 'All local tools are ready.',
  });
}

export async function inspectTools(): Promise<void> {
  if (exists(PATHS.ffmpeg)) {
    statuses.ffmpeg = { status: 'ready', path: PATHS.ffmpeg, version: await toolVersion('ffmpeg', PATHS.ffmpeg) };
  } else statuses.ffmpeg = { status: 'missing', message: 'ffmpeg-static binary not found' };

  if (exists(PATHS.ffprobe)) {
    statuses.ffprobe = { status: 'ready', path: PATHS.ffprobe, version: await toolVersion('ffprobe', PATHS.ffprobe) };
  } else statuses.ffprobe = { status: 'missing', message: 'ffprobe-static binary not found' };

  if (exists(PATHS.ytdlp)) {
    statuses.ytdlp = { status: 'ready', path: PATHS.ytdlp, version: await toolVersion('ytdlp', PATHS.ytdlp) };
  } else statuses.ytdlp = { status: 'missing', message: 'yt-dlp is not installed' };

  if (exists(PATHS.whisperCli)) {
    statuses.whisper = { status: 'ready', path: PATHS.whisperCli };
  } else {
    const alt = path.join(PATHS.whisper, process.platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli');
    if (exists(alt)) statuses.whisper = { status: 'ready', path: alt };
    else statuses.whisper = { status: 'missing', message: 'whisper.cpp is not installed' };
  }

  const model = path.join(PATHS.models, MODEL_FILES['base.en']);
  const modelSize = await fileSize(model);
  if (modelSize > 10_000_000) {
    statuses.whisperModel = { status: 'ready', path: model, message: `${(modelSize / 1048576).toFixed(0)} MB` };
  } else statuses.whisperModel = { status: 'missing', message: 'Base English ASR model is not downloaded' };

  if (exists(PATHS.yunet)) statuses.yunet = { status: 'ready', path: PATHS.yunet };
  else statuses.yunet = { status: 'missing', message: 'Face detector model is not downloaded' };

  const fontNames = ['Poppins-ExtraBold.ttf', 'Anton-Regular.ttf', 'BebasNeue-Regular.ttf'];
  const found = fontNames.filter((f) => exists(path.join(PATHS.fonts, f)));
  if (found.length === fontNames.length) statuses.fonts = { status: 'ready', path: PATHS.fonts };
  else statuses.fonts = { status: 'missing', message: `Missing ${fontNames.length - found.length} caption font(s)` };
}

export async function ensureWhisperModel(model: AsrModelId = 'base.en'): Promise<string> {
  const fileName = MODEL_FILES[model] || MODEL_FILES['base.en'];
  const dest = path.join(PATHS.models, fileName);
  if (await fileSize(dest)) {
    statuses.whisperModel = { status: 'ready', path: dest };
    return dest;
  }
  statuses.whisperModel = { status: 'downloading', path: dest };
  emitSetupStatus();
  await download(
    `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${fileName}`,
    dest,
    `Whisper model (${model})`,
  );
  statuses.whisperModel = { status: 'ready', path: dest };
  emitSetupStatus();
  return dest;
}

async function ensureWhisperBinary(force: boolean): Promise<void> {
  if (!force && exists(PATHS.whisperCli)) {
    statuses.whisper = { status: 'ready', path: PATHS.whisperCli };
    return;
  }
  const alt = path.join(PATHS.whisper, process.platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli');
  if (!force && exists(alt)) {
    statuses.whisper = { status: 'ready', path: alt };
    return;
  }
  if (process.platform !== 'win32') {
    statuses.whisper = {
      status: 'error',
      message: 'Automatic whisper.cpp install is currently Windows-only. Set WHISPER_PATH to a local build.',
    };
    return;
  }
  statuses.whisper = { status: 'downloading', path: PATHS.whisperCli };
  emitSetupStatus();
  const zip = path.join(PATHS.tmp, `whisper-${CONFIG.whisperRelease}.zip`);
  await download(
    `https://github.com/ggml-org/whisper.cpp/releases/download/${CONFIG.whisperRelease}/whisper-bin-x64.zip`,
    zip,
    'whisper.cpp',
  );
  await fsp.mkdir(PATHS.whisper, { recursive: true });
  new AdmZip(zip).extractAllTo(PATHS.whisper, true);
  await fsp.rm(zip, { force: true });
  const installed = [PATHS.whisperCli, alt].find((file) => exists(file));
  if (!installed) throw new Error('whisper.cpp archive did not contain whisper-cli.exe');
  PATHS.whisperCli = installed;
  statuses.whisper = { status: 'ready', path: installed };
  emitSetupStatus();
}

async function ensureFonts(force: boolean): Promise<void> {
  const fonts: Array<[string, string]> = [
    ['Poppins-ExtraBold.ttf', 'https://raw.githubusercontent.com/google/fonts/main/ofl/poppins/Poppins-ExtraBold.ttf'],
    ['Anton-Regular.ttf', 'https://raw.githubusercontent.com/google/fonts/main/ofl/anton/Anton-Regular.ttf'],
    ['BebasNeue-Regular.ttf', 'https://raw.githubusercontent.com/google/fonts/main/ofl/bebasneue/BebasNeue-Regular.ttf'],
  ];
  for (const [name, url] of fonts) {
    const dest = path.join(PATHS.fonts, name);
    if (!force && exists(dest)) continue;
    await download(url, dest, `Font ${name}`);
  }
  await fsp.writeFile(
    path.join(PATHS.fonts, 'LICENSES.md'),
    'Caption fonts are distributed under the SIL Open Font License 1.1.\n- Poppins: https://github.com/itfoundry/Poppins\n- Anton: https://github.com/googlefonts/AntonFont\n- Bebas Neue: https://github.com/dharmatype/Bebas-Neue\n',
  );
  statuses.fonts = { status: 'ready', path: PATHS.fonts };
}

async function ensureYunet(force: boolean): Promise<void> {
  if (!force && exists(PATHS.yunet)) {
    statuses.yunet = { status: 'ready', path: PATHS.yunet };
    return;
  }
  statuses.yunet = { status: 'downloading', path: PATHS.yunet };
  await download(
    'https://github.com/opencv/opencv_zoo/raw/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx',
    PATHS.yunet,
    'Face tracker model',
  );
  statuses.yunet = { status: 'ready', path: PATHS.yunet };
}

async function ensureYtdlp(force: boolean): Promise<void> {
  if (!force && exists(PATHS.ytdlp)) {
    statuses.ytdlp = { status: 'ready', path: PATHS.ytdlp, version: await toolVersion('ytdlp', PATHS.ytdlp) };
    return;
  }
  statuses.ytdlp = { status: 'downloading', path: PATHS.ytdlp };
  emitSetupStatus();
  await download(CONFIG.ytdlpUrl, PATHS.ytdlp, 'yt-dlp');
  statuses.ytdlp = { status: 'ready', path: PATHS.ytdlp, version: await toolVersion('ytdlp', PATHS.ytdlp) };
  emitSetupStatus();
}

async function checkStatic(force: boolean): Promise<void> {
  if (exists(PATHS.ffmpeg)) {
    statuses.ffmpeg = { status: 'ready', path: PATHS.ffmpeg, version: await toolVersion('ffmpeg', PATHS.ffmpeg) };
  } else {
    statuses.ffmpeg = { status: 'error', path: PATHS.ffmpeg, message: 'ffmpeg-static is missing. Run npm install.' };
  }
  if (exists(PATHS.ffprobe)) {
    statuses.ffprobe = { status: 'ready', path: PATHS.ffprobe, version: await toolVersion('ffprobe', PATHS.ffprobe) };
  } else {
    statuses.ffprobe = { status: 'error', path: PATHS.ffprobe, message: 'ffprobe-static is missing. Run npm install.' };
  }
  if (force) {
    versionCache.delete(PATHS.ffmpeg);
    versionCache.delete(PATHS.ffprobe);
  }
}

export async function ensureAll(force = false): Promise<boolean> {
  if (setupPromise) return setupPromise;
  setupPromise = (async () => {
    await fsp.mkdir(PATHS.models, { recursive: true });
    await fsp.mkdir(PATHS.fonts, { recursive: true });
    await fsp.mkdir(PATHS.tmp, { recursive: true });
    await checkStatic(force);
    await ensureYtdlp(force);
    await ensureWhisperBinary(force);
    if (force) {
      statuses.whisperModel = { status: 'missing' };
    }
    await ensureWhisperModel('base.en');
    await ensureYunet(force);
    await ensureFonts(force);
    await inspectTools();
    emitSetupStatus();
    const ready = toolsReady() && statuses.whisperModel.status === 'ready';
    log.info(`tool setup complete: ${ready ? 'ready' : 'incomplete'}`);
    return ready;
  })()
    .catch((error) => {
      log.error('tool setup failed', error);
      emitSetupStatus();
      return false;
    })
    .finally(() => {
      setupPromise = null;
    });
  return setupPromise;
}

export async function updateYtdlp(): Promise<void> {
  versionCache.delete(PATHS.ytdlp);
  await ensureYtdlp(true);
  await inspectTools();
}

export async function getToolVersions(): Promise<Record<string, string | undefined>> {
  return {
    ffmpeg: exists(PATHS.ffmpeg) ? await toolVersion('ffmpeg', PATHS.ffmpeg) : undefined,
    ffprobe: exists(PATHS.ffprobe) ? await toolVersion('ffprobe', PATHS.ffprobe) : undefined,
    ytdlp: exists(PATHS.ytdlp) ? await toolVersion('ytdlp', PATHS.ytdlp) : undefined,
  };
}
