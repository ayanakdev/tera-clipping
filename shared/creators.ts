import type { PlatformId } from './types';

export interface CreatorSeed {
  platform: Extract<PlatformId, 'twitch' | 'kick' | 'youtube'>;
  handle: string;
  name: string;
}

/**
 * A starter watchlist of creators who stream often. The list is seeded once
 * into data/index.json; after that it belongs to the user, so removals stick.
 */
export const SEED_CREATORS: CreatorSeed[] = [
  { platform: 'twitch', handle: 'xqc', name: 'xQc' },
  { platform: 'twitch', handle: 'kaicenat', name: 'Kai Cenat' },
  { platform: 'twitch', handle: 'pokimane', name: 'Pokimane' },
  { platform: 'twitch', handle: 'hasanabi', name: 'HasanAbi' },
  { platform: 'twitch', handle: 'jynxzi', name: 'Jynxzi' },
  { platform: 'twitch', handle: 'caseoh_', name: 'caseoh_' },
  { platform: 'twitch', handle: 'agent00', name: 'Agent00' },
  { platform: 'twitch', handle: 'plaqueboymax', name: 'PlaqueBoyMax' },
  { platform: 'twitch', handle: 'extraemily', name: 'ExtraEmily' },
  { platform: 'twitch', handle: 'tfue', name: 'Tfue' },
  { platform: 'twitch', handle: 'nickmercs', name: 'NICKMERCS' },
  { platform: 'twitch', handle: 'ninja', name: 'Ninja' },
  { platform: 'twitch', handle: 'summit1g', name: 'summit1g' },
  { platform: 'kick', handle: 'adinross', name: 'Adin Ross' },
  { platform: 'kick', handle: 'trainwreckstv', name: 'Trainwreckstv' },
  { platform: 'kick', handle: 'n3on', name: 'N3on' },
  { platform: 'kick', handle: 'yourrage', name: 'YourRAGE' },
  { platform: 'kick', handle: 'lacy', name: 'Lacy' },
  { platform: 'kick', handle: 'roshtein', name: 'ROSHTEIN' },
  { platform: 'youtube', handle: 'IShowSpeed', name: 'IShowSpeed' },
  { platform: 'youtube', handle: 'DrDisrespect', name: 'Dr Disrespect' },
  { platform: 'youtube', handle: 'Ludwig', name: 'Ludwig' },
  { platform: 'youtube', handle: 'Valkyrae', name: 'Valkyrae' },
  { platform: 'youtube', handle: 'CouRageJD', name: 'CouRage' },
];

export function creatorChannelUrl(platform: PlatformId, handle: string): string {
  const clean = handle.replace(/^@+/, '').trim();
  if (platform === 'twitch') return `https://www.twitch.tv/${encodeURIComponent(clean)}`;
  if (platform === 'kick') return `https://kick.com/${encodeURIComponent(clean)}`;
  if (platform === 'youtube') return `https://www.youtube.com/@${encodeURIComponent(clean)}`;
  return `https://${platform}.com/${encodeURIComponent(clean)}`;
}

/** The `/live` suffix matters for YouTube — a plain channel URL can resolve to a VOD. */
export function creatorLiveUrl(platform: PlatformId, handle: string): string {
  const channel = creatorChannelUrl(platform, handle);
  return platform === 'youtube' ? `${channel}/live` : channel;
}

export function creatorInitials(name: string): string {
  const words = name
    .replace(/[^a-zA-Z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  const initials = words.slice(0, 2).map((word) => word[0]?.toUpperCase() || '');
  return initials.join('') || '?';
}
