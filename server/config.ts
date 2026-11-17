import 'dotenv/config';
import dotenv from 'dotenv';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import ffmpegStatic from 'ffmpeg-static';
import ffprobeStatic from 'ffprobe-static';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..');

// .env.local has priority over .env
dotenv.config({ path: path.join(ROOT, '.env.local') });
dotenv.config({ path: path.join(ROOT, '.env') });

const env = process.env;

const bundledFfmpeg = typeof ffmpegStatic === 'string' ? ffmpegStatic : '';
const bundledFfprobe = (ffprobeStatic as unknown as { path?: string } | undefined)?.path ?? '';

export const CONFIG = {
  version: '1.0.0',
  isProd: env.NODE_ENV === 'production',
  host: env.HOST || '127.0.0.1',
  port: Number(env.PORT || 8484),
  root: ROOT,
  dataDir: path.resolve(ROOT, env.DATA_DIR || 'data'),
  toolsDir: path.resolve(ROOT, env.TOOLS_DIR || 'tools'),
  webDist: path.join(ROOT, 'web', 'dist'),
  geminiKey: (env.GEMINI_API_KEY || env.GEMINI_API || '').trim(),
  geminiModel: env.GEMINI_MODEL || 'gemini-2.5-flash',
  geminiDailyLimit: Number(env.GEMINI_DAILY_LIMIT || 40),
  asrThreads: Number(env.ASR_THREADS || 0),
  cookiesBrowser: env.YTDLP_COOKIES_BROWSER || '',
  cookiesFile: env.YTDLP_COOKIES_FILE || '',
  maxUploadBytes: Number(env.MAX_UPLOAD_BYTES || 6 * 1024 * 1024 * 1024),
  whisperRelease: env.WHISPER_RELEASE || 'b5454',
  ytdlpUrl: env.YTDLP_URL || 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe',
  useCuda: env.WHISPER_CUDA === '1',
};

export const PATHS = {
  index: path.join(CONFIG.dataDir, 'index.json'),
  projects: path.join(CONFIG.dataDir, 'projects'),
  uploads: path.join(CONFIG.dataDir, 'uploads'),
  live: path.join(CONFIG.dataDir, 'live'),
  cache: path.join(CONFIG.dataDir, 'cache'),
  geminiCache: path.join(CONFIG.dataDir, 'cache', 'gemini'),
  tmp: path.join(CONFIG.dataDir, 'tmp'),
  logs: path.join(CONFIG.dataDir, 'logs'),
  models: path.join(CONFIG.toolsDir, 'models'),
  fonts: path.join(CONFIG.toolsDir, 'fonts'),
  whisper: path.join(CONFIG.toolsDir, 'whisper'),
  ytdlp: path.resolve(ROOT, env.YTDLP_PATH || path.join(CONFIG.toolsDir, 'yt-dlp.exe')),
  whisperCli: path.resolve(
    ROOT,
    env.WHISPER_PATH ||
      path.join(CONFIG.toolsDir, 'whisper', 'Release', process.platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli'),
  ),
  ffmpeg: env.FFMPEG_PATH ? path.resolve(ROOT, env.FFMPEG_PATH) : bundledFfmpeg,
  ffprobe: env.FFPROBE_PATH ? path.resolve(ROOT, env.FFPROBE_PATH) : bundledFfprobe,
  yunet: path.join(CONFIG.toolsDir, 'models', 'face_detection_yunet_2023mar.onnx'),
  fontsManifest: path.join(CONFIG.toolsDir, 'fonts', 'fonts.json'),
};

export const DIRS = [
  CONFIG.dataDir,
  PATHS.projects,
  PATHS.uploads,
  PATHS.live,
  PATHS.cache,
  PATHS.geminiCache,
  PATHS.tmp,
  PATHS.logs,
  CONFIG.toolsDir,
  PATHS.models,
  PATHS.fonts,
];

export function ensureDirs(): void {
  for (const dir of DIRS) fs.mkdirSync(dir, { recursive: true });
}

export function fromData(relativePath: string): string {
  if (!relativePath) return relativePath;
  if (path.isAbsolute(relativePath)) return relativePath;
  const resolved = path.resolve(CONFIG.dataDir, relativePath);
  if (!resolved.startsWith(CONFIG.dataDir)) throw new Error('Invalid data path');
  return resolved;
}

export function toData(absPath: string): string {
  const relative = path.relative(CONFIG.dataDir, path.resolve(absPath));
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Path is outside data directory');
  return relative.split(path.sep).join('/');
}

export function mediaUrl(relativePath?: string): string | undefined {
  if (!relativePath) return undefined;
  return `/media/${relativePath.split(path.sep).join('/')}`;
}

export function assertDataDir(): void {
  ensureDirs();
}

ensureDirs();
