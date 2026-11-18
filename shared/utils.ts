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

/**
 * Whisper and other ASR engines often emit stage directions such as
 * `(gunfire)`, `[Music]`, `*laughs*` or `♪`. They are useful metadata, but
 * they look broken when burned into a caption or reused in a hook. Strip them
 * everywhere text is read, including cached transcripts.
 */
const SOUND_TAG_WORDS =
  /\b(music|musical|instrumental|song|singing|sings|applause|applauding|cheering|cheers|crowd|laughter|laughs|laughing|laugh|giggle|giggles|gunfire|gunshot|gunshots|shooting|explosion|explosions|silence|silent|inaudible|unintelligible|noise|static|censor|censored|bleep|beep|beeping|ringing|ringtone|phone|typing|keyboard|clicking|door|footsteps|breathing|sigh|sighs|sighing|cough|coughs|coughing|sneeze|sniff|screaming|screams|yelling|yells|shouting|shouts|speaking|foreign|indistinct|background|ambient|sfx|sound|sounds|audio|video|advertisement|commercial|intro|outro|transition|upbeat|dramatic|tense|soft|piano|guitar|drums|bass|synth|beat|beats)\b/i;

function isSoundTag(inner: string): boolean {
  const clean = inner.replace(/[_*]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!clean) return false;
  // [MUSIC], [BLANK_AUDIO], [NOISE] and similar all-caps annotations.
  if (/^(?=.*[A-Z])[A-Z0-9 _'-]{2,40}$/.test(clean)) return true;
  return SOUND_TAG_WORDS.test(clean);
}

/** True when a token still contains something a viewer can read. */
export function isSpeakableToken(text: string): boolean {
  return /[\p{L}\p{N}]/u.test(text);
}

/**
 * Display text (hooks, captions) can keep emoji; transcript words should not.
 * Emoji are not "speakable", so they need their own check here.
 */
function isDisplayToken(text: string): boolean {
  return isSpeakableToken(text) || /[\p{Extended_Pictographic}\p{Regional_Indicator}]/u.test(text);
}

export function stripSoundTags(text: string): string {
  if (!text) return '';
  let out = String(text)
    // Parenthesised and bracketed stage directions, but keep real asides
    // such as "(2024)" when they are not a sound annotation.
    .replace(/[\(\[]\s*([^)\]]{0,80}?)\s*[\)\]]/g, (match, inner: string) =>
      isSoundTag(inner) ? ' ' : match,
    )
    // *laughs*, **music**, _applause_
    .replace(/\*{1,2}\s*([^*\n]{1,60}?)\s*\*{1,2}/g, (match, inner: string) =>
      isSoundTag(inner) || !/[.!?]/.test(inner) ? ' ' : match,
    )
    // Music notes on their own, including the emoji forms.
    .replace(/[♪♫♬♩\u266A\u266B\u{1F3B5}\u{1F3B6}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // Remove any annotation that survived (unbalanced brackets, stray tags).
  out = out
    .split(/\s+/)
    .filter((token) => {
      if (!isDisplayToken(token)) return false;
      if (/^[\(\[]/.test(token) && /[\)\]]$/.test(token) && isSoundTag(token.slice(1, -1))) return false;
      if (/^\*.*\*$/.test(token) && isSoundTag(token.replace(/\*/g, ''))) return false;
      return true;
    })
    .join(' ');
  return out.trim();
}

/** Clean a sentence without losing its spoken words. */
export function cleanSpokenText(text: string): string {
  return stripSoundTags(text)
    .replace(/\s+([,.;:!?%])/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/**
 * Split clip words into readable subtitle lines. The renderer has its own
 * pixel-perfect grouping, but this keeps the editor's cue rows familiar and
 * gives the user a stable set of lines to edit.
 */
export function cuesFromWords(
  words: Array<{ start: number; end: number; text: string }>,
  duration: number,
): Array<{ start: number; end: number; text: string }> {
  const cues: Array<{ start: number; end: number; text: string }> = [];
  let bucket: Array<{ start: number; end: number; text: string }> = [];
  const flush = () => {
    if (!bucket.length) return;
    const start = Math.max(0, Math.round(bucket[0]!.start * 100) / 100);
    const end = Math.min(duration, Math.round(bucket[bucket.length - 1]!.end * 100) / 100);
    const text = bucket.map((word) => word.text).join(' ').trim();
    if (text && end > start) cues.push({ start, end, text });
    bucket = [];
  };
  for (const word of words) {
    const text = stripSoundTags(String(word.text || '')).trim();
    if (!text || !isSpeakableToken(text)) continue;
    if (bucket.length) {
      const gap = word.start - bucket[bucket.length - 1]!.end;
      const span = word.end - bucket[0]!.start;
      if (gap > 0.8 || span > 3.6 || bucket.length >= 6) flush();
    }
    bucket.push({ start: word.start, end: word.end, text });
    if (/[.!?]["')\]]?$/.test(text) && bucket.length >= 3) flush();
    if (bucket.length >= 6) flush();
  }
  flush();
  return cues;
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
