import type { ClipSettings } from './types';
import { DEFAULT_SETTINGS } from './presets';

export function makeClipSettings(overrides: Partial<ClipSettings> = {}): ClipSettings {
  return {
    clipCount: DEFAULT_SETTINGS.defaultClipCount,
    minDuration: DEFAULT_SETTINGS.defaultMinDuration,
    maxDuration: DEFAULT_SETTINGS.defaultMaxDuration,
    aspect: DEFAULT_SETTINGS.defaultAspect,
    captionPreset: DEFAULT_SETTINGS.defaultCaptionPreset,
    captionScale: DEFAULT_SETTINGS.defaultCaptionScale,
    hookStyle: DEFAULT_SETTINGS.defaultHookStyle,
    pacing: DEFAULT_SETTINGS.defaultPacing,
    reframe: DEFAULT_SETTINGS.defaultReframe,
    quality: DEFAULT_SETTINGS.defaultQuality,
    aiMode: DEFAULT_SETTINGS.defaultAiMode,
    asrModel: DEFAULT_SETTINGS.defaultAsrModel,
    language: DEFAULT_SETTINGS.asrLanguage,
    audioEnhance: false,
    watermark: DEFAULT_SETTINGS.watermark,
    ...overrides,
  };
}

export function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function formatDuration(seconds: number, short = false): string {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (short) {
    if (h) return `${h}h ${m}m`;
    if (m) return `${m}m ${sec}s`;
    return `${sec}s`;
  }
  if (h) return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  return `${m}:${String(sec).padStart(2, '0')}`;
}

export function formatBytes(bytes: number): string {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / 1024 ** i;
  return `${value.toFixed(value >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

export function timeAgo(iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return '';
  const diff = Math.max(0, Date.now() - then);
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}
