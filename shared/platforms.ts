import type { PlatformId, PlatformInfo, SourceKind } from './types';

export const PLATFORMS: PlatformInfo[] = [
  {
    id: 'youtube',
    name: 'YouTube',
    short: 'YT',
    category: 'video',
    color: '#FF0033',
    soft: '#FFF0F3',
    hosts: ['youtube.com', 'youtu.be', 'm.youtube.com', 'music.youtube.com'],
    kinds: ['vod', 'clip', 'live'],
    placeholder: 'https://youtube.com/watch?v=…',
    note: 'Videos, Shorts and ended livestreams',
  },
  {
    id: 'twitch',
    name: 'Twitch',
    short: 'TW',
    category: 'streaming',
    color: '#9146FF',
    soft: '#F5F0FF',
    hosts: ['twitch.tv', 'clips.twitch.tv', 'm.twitch.tv'],
    kinds: ['vod', 'clip', 'live'],
    placeholder: 'https://twitch.tv/videos/… or clips.twitch.tv/…',
    note: 'VODs, clips and live channels',
  },
  {
    id: 'kick',
    name: 'Kick',
    short: 'KC',
    category: 'streaming',
    color: '#53FC18',
    soft: '#F1FFEA',
    hosts: ['kick.com', 'clips.kick.com'],
    kinds: ['vod', 'clip', 'live'],
    placeholder: 'https://kick.com/channel or kick.com/video/…',
    note: 'Kick VODs, clips and live channels',
  },
  {
    id: 'x',
    name: 'X',
    short: 'X',
    category: 'social',
    color: '#111111',
    soft: '#F3F3F4',
    hosts: ['x.com', 'twitter.com', 't.co'],
    kinds: ['vod', 'live'],
    placeholder: 'https://x.com/user/status/…',
    note: 'Public posts with native video',
  },
  {
    id: 'rumble',
    name: 'Rumble',
    short: 'RU',
    category: 'video',
    color: '#85C742',
    soft: '#F5FBEE',
    hosts: ['rumble.com'],
    kinds: ['vod', 'live'],
    placeholder: 'https://rumble.com/v…',
    note: 'Rumble videos and live streams',
  },
  {
    id: 'tiktok',
    name: 'TikTok',
    short: 'TT',
    category: 'social',
    color: '#010101',
    soft: '#F3F3F4',
    hosts: ['tiktok.com', 'vm.tiktok.com', 'vt.tiktok.com'],
    kinds: ['clip'],
    placeholder: 'https://tiktok.com/@user/video/…',
    note: 'Public TikToks as source material',
  },
  {
    id: 'instagram',
    name: 'Instagram',
    short: 'IG',
    category: 'social',
    color: '#E4405F',
    soft: '#FFF1F4',
    hosts: ['instagram.com'],
    kinds: ['clip'],
    placeholder: 'https://instagram.com/reel/…',
    note: 'Public Reels (cookies may be required)',
  },
  {
    id: 'vimeo',
    name: 'Vimeo',
    short: 'VM',
    category: 'video',
    color: '#1AB7EA',
    soft: '#EEFAFE',
    hosts: ['vimeo.com'],
    kinds: ['vod', 'live'],
    placeholder: 'https://vimeo.com/…',
    note: 'Vimeo videos and events',
  },
  {
    id: 'upload',
    name: 'Direct upload',
    short: 'UP',
    category: 'local',
    color: '#7C3AED',
    soft: '#F4F0FF',
    hosts: [],
    kinds: ['upload'],
    placeholder: 'Drop an MP4, MOV, MKV or WebM',
    note: 'Everything stays on this laptop',
  },
  {
    id: 'generic',
    name: 'Direct link',
    short: 'URL',
    category: 'local',
    color: '#7C3AED',
    soft: '#F4F0FF',
    hosts: [],
    kinds: ['url'],
    placeholder: 'https://…/video.mp4 or .m3u8',
    note: 'Any direct video or HLS link yt-dlp can read',
  },
];

export const PLATFORM_BY_ID = Object.fromEntries(PLATFORMS.map((p) => [p.id, p])) as Record<PlatformId, PlatformInfo>;

export const LIVE_PLATFORMS: PlatformId[] = ['twitch', 'kick', 'youtube'];

export function detectPlatform(url: string): PlatformId | null {
  let host = '';
  try {
    host = new URL(url.startsWith('http') ? url : `https://${url}`).hostname.toLowerCase();
  } catch {
    return null;
  }
  const found = PLATFORMS.find((p) => p.hosts.some((h) => host === h || host.endsWith(`.${h}`)));
  if (found) return found.id;
  if (/\.(mp4|mov|mkv|webm|m4v|m3u8)(\?|#|$)/i.test(url)) return 'generic';
  return null;
}

const CLIP_HINTS = ['/clip', 'clips.twitch.tv', 'clip=', 'clips.kick.com'];
const LIVE_HINTS = ['/live', 'watch?v=', 'kick.com/', 'twitch.tv/'];

export function guessSourceKind(url: string, platform: PlatformId | null): SourceKind {
  const lower = url.toLowerCase();
  if (platform === 'upload') return 'upload';
  if (CLIP_HINTS.some((h) => lower.includes(h))) return 'clip';
  if (platform === 'youtube' && lower.includes('/shorts/')) return 'clip';
  if (platform === 'youtube' && lower.includes('/channel/')) return 'vod';
  if (platform === 'twitch' && lower.includes('/videos/')) return 'vod';
  if (platform === 'kick' && lower.includes('/video/')) return 'vod';
  if (platform === 'tiktok' || platform === 'instagram') return 'clip';
  if (LIVE_HINTS.some((h) => lower.includes(h))) return 'live';
  return 'vod';
}

export function isLikelyLiveUrl(url: string): boolean {
  const lower = url.toLowerCase();
  try {
    const u = new URL(url.startsWith('http') ? url : `https://${url}`);
    if (u.hostname.includes('twitch.tv')) return !lower.includes('/videos/') && !lower.includes('clip');
    if (u.hostname.includes('kick.com')) return !lower.includes('/video/') && !lower.includes('clip');
    if (u.hostname.includes('youtube.com')) return lower.includes('/live') || lower.includes('/watch');
    if (u.hostname.includes('rumble.com')) return lower.includes('/live');
  } catch {
    return false;
  }
  return false;
}

export function platformHostHint(platform: PlatformId): string {
  const p = PLATFORM_BY_ID[platform];
  return p ? p.hosts[0] ?? '' : '';
}
