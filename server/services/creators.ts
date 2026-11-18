import type { CreatorEntry, CreatorProfile, CreatorStatus, LiveSession, PlatformId } from '../../shared/types';
import { creatorChannelUrl, creatorLiveUrl } from '../../shared/creators';
import { store } from '../lib/store';
import { startLive } from './live';

const CACHE_TTL = 45_000;
const CHECK_TIMEOUT = 9_000;
const TWITCH_CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko';
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

interface CacheItem {
  status: CreatorStatus;
  at: number;
}

const cache = new Map<string, CacheItem>();
const inflight = new Map<string, Promise<CreatorStatus>>();
let lastFullRefresh = 0;

const TWITCH_QUERY = `query($login:String!) {
  user(login: $login) {
    displayName
    profileImageURL(width: 300)
    stream {
      viewersCount
      title
      createdAt
      previewImageURL(width: 640, height: 360)
      game { name }
    }
  }
}`;

function stamp(): string {
  return new Date().toISOString();
}

function cacheKey(creator: Pick<CreatorProfile, 'platform' | 'handle'>): string {
  return `${creator.platform}:${creator.handle.toLowerCase()}`;
}

function decodeEntities(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#0?39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCharCode(parseInt(code, 16)));
}

function cleanTitle(raw: string): string {
  return decodeEntities(raw).replace(/\s*-\s*YouTube\s*$/i, '').trim();
}

function parseViewers(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const match = raw.replace(/,/g, '').match(/([\d.]+)\s*([KMB])?/i);
  if (!match) return undefined;
  const base = Number(match[1]);
  if (!Number.isFinite(base)) return undefined;
  const suffix = (match[2] || '').toUpperCase();
  const factor = suffix === 'B' ? 1e9 : suffix === 'M' ? 1e6 : suffix === 'K' ? 1e3 : 1;
  return Math.round(base * factor);
}

/**
 * Some APIs return preview URLs as templates, e.g. Twitch GQL was returning
 * `...-640x{height}.jpg` when only width was requested. Fill any placeholders so
 * the browser always receives a real image URL.
 */
function thumbnailUrl(raw: string | undefined, width = 640, height = 360): string | undefined {
  if (!raw) return undefined;
  const cleaned = raw
    .replace(/%?\{width\}/gi, String(width))
    .replace(/%?\{height\}/gi, String(height));
  return cleaned || undefined;
}

async function checkTwitch(creator: CreatorProfile, checkedAt: string): Promise<CreatorStatus> {
  const response = await fetch('https://gql.twitch.tv/gql', {
    method: 'POST',
    headers: {
      'Client-ID': TWITCH_CLIENT_ID,
      'Content-Type': 'application/json',
      'User-Agent': USER_AGENT,
    },
    body: JSON.stringify({
      query: TWITCH_QUERY,
      variables: { login: creator.handle.toLowerCase() },
    }),
    signal: AbortSignal.timeout(CHECK_TIMEOUT),
  });
  if (!response.ok) throw new Error(`Twitch returned ${response.status}.`);
  const payload = (await response.json()) as {
    data?: {
      user?: {
        displayName?: string;
        profileImageURL?: string;
        stream?: {
          viewersCount?: number;
          title?: string;
          createdAt?: string;
          previewImageURL?: string;
          game?: { name?: string } | null;
        } | null;
      } | null;
    };
  };
  const user = payload.data?.user;
  if (!user) {
    return { live: false, checkedAt, error: 'Channel not found on Twitch.' };
  }
  const stream = user.stream;
  return {
    live: Boolean(stream),
    displayName: user.displayName,
    avatarUrl: user.profileImageURL,
    viewers: stream?.viewersCount,
    title: stream?.title,
    game: stream?.game?.name,
    thumbnailUrl: thumbnailUrl(stream?.previewImageURL),
    startedAt: stream?.createdAt,
    checkedAt,
  };
}

async function checkKick(creator: CreatorProfile, checkedAt: string): Promise<CreatorStatus> {
  const response = await fetch(`https://kick.com/api/v2/channels/${encodeURIComponent(creator.handle)}`, {
    headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(CHECK_TIMEOUT),
  });
  if (response.status === 404) {
    return { live: false, checkedAt, error: 'Channel not found on Kick.' };
  }
  if (!response.ok) throw new Error(`Kick returned ${response.status}.`);
  const payload = (await response.json()) as {
    user?: { username?: string; profile_pic?: string };
    slug?: string;
    livestream?: {
      viewer_count?: number | string;
      session_title?: string;
      start_time?: string;
      thumbnail?: { url?: string } | string;
      categories?: Array<{ name?: string }>;
      category?: { name?: string } | null;
    } | null;
  };
  const live = payload.livestream;
  const thumbnail =
    typeof live?.thumbnail === 'string' ? live.thumbnail : live?.thumbnail?.url || undefined;
  const game = live?.categories?.[0]?.name || live?.category?.name || undefined;
  return {
    live: Boolean(live),
    displayName: payload.user?.username || payload.slug || creator.name,
    avatarUrl: payload.user?.profile_pic,
    viewers: live?.viewer_count !== undefined ? Number(live.viewer_count) : undefined,
    title: live?.session_title,
    game,
    thumbnailUrl: thumbnailUrl(thumbnail),
    startedAt: live?.start_time,
    checkedAt,
  };
}

async function checkYouTube(creator: CreatorProfile, checkedAt: string): Promise<CreatorStatus> {
  const response = await fetch(creatorLiveUrl('youtube', creator.handle), {
    headers: { 'Accept-Language': 'en-US,en;q=0.9', 'User-Agent': USER_AGENT },
    redirect: 'follow',
    signal: AbortSignal.timeout(CHECK_TIMEOUT + 3_000),
  });
  if (response.status === 404) {
    return { live: false, checkedAt, error: 'Channel not found on YouTube.' };
  }
  if (!response.ok) throw new Error(`YouTube returned ${response.status}.`);
  const html = await response.text();
  // `isLive` is also present on ended live VODs; only `isLiveNow` means on air.
  if (!/"isLiveNow"\s*:\s*true/.test(html)) {
    const channelName = html.match(/"ownerChannelName":"([^"]+)"/)?.[1];
    return {
      live: false,
      displayName: channelName ? decodeEntities(channelName) : undefined,
      checkedAt,
    };
  }
  const rawTitle =
    html.match(/<meta\s+name="title"\s+content="([^"]*)"/i)?.[1] ||
    html.match(/<meta\s+property="og:title"\s+content="([^"]*)"/i)?.[1] ||
    html.match(/<title>([^<]*)<\/title>/i)?.[1] ||
    '';
  const videoId = html.match(/"videoId":"([\w-]{11})"/)?.[1];
  const owner = html.match(/"ownerChannelName":"([^"]+)"/)?.[1];
  const viewersRaw =
    html.match(/"viewCount":\{"simpleText":"([^"]+)"/)?.[1] ||
    html.match(/"concurrentViewers":"([\d,]+)"/)?.[1] ||
    html.match(/"viewCount":"(\d+)"/)?.[1];
  const game = html.match(/"category":"([^"]+)"/)?.[1];
  const thumbnail =
    html.match(/<meta\s+property="og:image"\s+content="([^"]*)"/i)?.[1] ||
    (videoId ? `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg` : undefined);
  return {
    live: true,
    displayName: owner ? decodeEntities(owner) : creator.name,
    viewers: parseViewers(viewersRaw),
    title: rawTitle ? cleanTitle(rawTitle) : undefined,
    game: game ? decodeEntities(game) : undefined,
    thumbnailUrl: thumbnailUrl(thumbnail ? decodeEntities(thumbnail) : undefined),
    checkedAt,
  };
}

async function checkCreator(creator: CreatorProfile, force = false): Promise<CreatorStatus> {
  const key = cacheKey(creator);
  const cached = cache.get(key);
  if (!force && cached && Date.now() - cached.at < CACHE_TTL) return cached.status;
  const running = inflight.get(key);
  if (running) return running;

  const task = (async (): Promise<CreatorStatus> => {
    const checkedAt = stamp();
    try {
      if (creator.platform === 'twitch') return await checkTwitch(creator, checkedAt);
      if (creator.platform === 'kick') return await checkKick(creator, checkedAt);
      if (creator.platform === 'youtube') return await checkYouTube(creator, checkedAt);
      return { live: false, checkedAt, error: `Live checks support Twitch, Kick and YouTube.` };
    } catch (error) {
      const timedOut =
        error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
      const message = timedOut
        ? `The ${creator.platform} check timed out.`
        : `Could not reach ${creator.platform} right now.`;
      return { live: false, checkedAt: stamp(), error: message };
    }
  })()
    .then((status) => {
      cache.set(key, { status, at: Date.now() });
      return status;
    })
    .finally(() => {
      inflight.delete(key);
    });

  inflight.set(key, task);
  return task;
}

async function mapLimit<T, R>(items: T[], limit: number, task: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await task(items[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}

export async function creatorsWithStatus(force = false): Promise<CreatorEntry[]> {
  if (force) {
    const now = Date.now();
    // A double-click on Refresh should not hammer every platform.
    if (now - lastFullRefresh < 8_000) force = false;
    else lastFullRefresh = now;
  }
  const creators = store.listCreators();
  const entries = await mapLimit(creators, 5, async (creator) => ({
    ...creator,
    status: await checkCreator(creator, force),
  }));
  return entries.sort(
    (a, b) =>
      Number(b.status.live) - Number(a.status.live) ||
      (b.status.viewers || 0) - (a.status.viewers || 0) ||
      a.name.localeCompare(b.name),
  );
}

function normalizePlatform(value: unknown): 'twitch' | 'kick' | 'youtube' {
  if (value === 'twitch' || value === 'kick' || value === 'youtube') return value;
  throw new Error('The creator radar supports Twitch, Kick and YouTube.');
}

export function normalizeCreatorHandle(platform: PlatformId, raw: unknown): string {
  let value = String(raw || '').trim();
  if (!value) throw new Error('Paste a channel handle or URL.');
  if (/^https?:\/\//i.test(value) || value.includes('.')) {
    let url: URL;
    try {
      url = new URL(value.startsWith('http') ? value : `https://${value}`);
    } catch {
      throw new Error('That link could not be read.');
    }
    const parts = url.pathname.split('/').filter(Boolean);
    if (url.hostname.includes('youtube')) {
      const at = parts.find((part) => part.startsWith('@'));
      if (at) value = at;
      else if (parts[0] === 'channel' || parts[0] === 'c' || parts[0] === 'user') value = parts[1] || '';
      else value = parts[parts.length - 1] || '';
    } else {
      value = parts[0] || '';
    }
  }
  value = value.replace(/^@+/, '').replace(/\/+$/, '').trim();
  if (!value || !/^[a-zA-Z0-9._-]{2,60}$/.test(value)) {
    throw new Error('That does not look like a channel handle.');
  }
  return platform === 'youtube' ? value : value.toLowerCase();
}

function humanize(handle: string): string {
  return handle
    .replace(/[._-]+/g, ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
    .trim();
}

export async function addCreator(
  rawPlatform: unknown,
  rawHandle: unknown,
  rawName?: unknown,
): Promise<CreatorEntry[]> {
  const platform = normalizePlatform(rawPlatform);
  const handle = normalizeCreatorHandle(platform, rawHandle);
  const duplicate = store
    .listCreators()
    .find((creator) => creator.platform === platform && creator.handle.toLowerCase() === handle.toLowerCase());
  if (duplicate) throw new Error(`${duplicate.name} is already on your creator radar.`);

  const probe: CreatorProfile = {
    id: 'probe',
    platform,
    handle,
    name: typeof rawName === 'string' && rawName.trim() ? rawName.trim().slice(0, 60) : humanize(handle),
    source: 'custom',
    addedAt: stamp(),
  };
  const status = await checkCreator(probe, true);
  const name =
    (typeof rawName === 'string' && rawName.trim().slice(0, 60)) ||
    status.displayName?.trim() ||
    humanize(handle);
  await store.addCreator({ platform, handle, name, source: 'custom' });
  return creatorsWithStatus(false);
}

export async function removeCreator(id: string): Promise<CreatorEntry[]> {
  const removed = await store.removeCreator(id);
  if (!removed) throw new Error('Creator not found.');
  return creatorsWithStatus(false);
}

export async function recordCreator(id: string, autoClip = true): Promise<LiveSession> {
  const creator = store.listCreators().find((entry) => entry.id === id);
  if (!creator) throw new Error('Creator not found.');
  const status = await checkCreator(creator, true);
  if (!status.live) throw new Error(`${creator.name} is not live right now.`);
  const url = creatorLiveUrl(creator.platform, creator.handle);
  const title = status.title || `${creator.name} live`;
  return startLive({
    url,
    title,
    autoClip,
    // The live check above already proved the channel is on air; reuse it so
    // starting does not spend another yt-dlp metadata pass on the same link.
    info: {
      url,
      title,
      channel: status.displayName || creator.name,
      duration: 0,
      thumbnail: status.thumbnailUrl,
      platform: creator.platform,
      isLive: true,
      liveStatus: 'is_live',
    },
  });
}

export function creatorPageUrl(creator: Pick<CreatorProfile, 'platform' | 'handle'>): string {
  return creatorChannelUrl(creator.platform, creator.handle);
}
