export function clock(seconds: number | undefined, padHours = false): string {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0 || padHours) return `${String(h).padStart(padHours ? 2 : 1, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function duration(seconds: number | undefined): string {
  const value = Number(seconds) || 0;
  if (value < 60) return `${value.toFixed(value < 10 ? 1 : 0)}s`;
  return clock(value);
}

export function bytes(value: number | undefined): string {
  const size = Number(value) || 0;
  if (size <= 0) return '0 MB';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(units.length - 1, Math.floor(Math.log(size) / Math.log(1024)));
  const amount = size / 1024 ** index;
  return `${amount.toFixed(amount >= 100 || index <= 1 ? 0 : 1)} ${units[index]}`;
}

export function bigNumber(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}K`;
  return String(value);
}

export function timeAgo(iso: string | undefined): string {
  if (!iso) return 'just now';
  const time = new Date(iso).getTime();
  if (!Number.isFinite(time)) return 'just now';
  const diff = Math.max(0, Date.now() - time);
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function dateLabel(iso?: string): string {
  const date = iso ? new Date(iso) : new Date();
  return date.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
}

export function shortDate(iso?: string): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return '—';
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function greeting(): string {
  const hour = new Date().getHours();
  if (hour < 5) return 'Late shift';
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

export function titleCase(value: string): string {
  return value.replace(/\b\w/g, (character) => character.toUpperCase());
}

export function initials(value: string): string {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() || '')
    .join('');
}

export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

export function percent(value: number | undefined): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.min(100, parsed));
}

export function estimateRenderSeconds(settings: { clipCount: number; quality: string; duration?: number }): number {
  const perClip = settings.quality === 'fast' ? 5 : settings.quality === 'high' ? 22 : 11;
  return Math.round(settings.clipCount * perClip + 12);
}

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function hostOf(url: string): string {
  try {
    return new URL(url.startsWith('http') ? url : `https://${url}`).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

export function stripHash(tag: string): string {
  return tag.replace(/^#+/, '');
}
