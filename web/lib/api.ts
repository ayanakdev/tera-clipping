import type {
  AiMode,
  AppSettings,
  AspectRatio,
  AsrModelId,
  Campaign,
  CaptionPresetId,
  ClipPresetVisual,
  ClipRecord,
  ClipSettings,
  CreatorEntry,
  HookStyleId,
  LibraryClip,
  LiveSession,
  PlatformId,
  PlatformInfo,
  PacingMode,
  Project,
  ProjectSummary,
  QualityMode,
  ReframeMode,
  Submission,
  StudioStats,
  SystemStatus,
  ToastEvent,
} from '@shared/types';
import type { ASPECT_SIZES, HOOK_STYLES } from '@shared/presets';

export interface Bootstrap {
  version: string;
  settings: AppSettings;
  defaults: AppSettings;
  presets: ClipPresetVisual[];
  hooks: typeof HOOK_STYLES;
  platforms: PlatformInfo[];
  aspects: typeof ASPECT_SIZES;
  geminiConfigured: boolean;
  live: LiveSession | null;
}

export interface ResolvedImport {
  url: string;
  id: string;
  title: string;
  channel: string;
  duration: number;
  thumbnail: string;
  platform: PlatformId;
  isLive: boolean;
  liveStatus: string;
  width?: number;
  height?: number;
  description: string;
  kind: string;
  sourceKind: string;
  previewUrl?: string;
}

export interface LiveListItem extends LiveSession {
  recordingAvailable: boolean;
  busy: boolean;
}

export interface LiveOverview {
  sessions: LiveListItem[];
  active: LiveSession | null;
  autoClipDefault: boolean;
}

export interface LiveResolution {
  title: string;
  channel: string;
  platform: PlatformId;
  thumbnail?: string;
  isLive: boolean;
  liveStatus?: string;
  duration: number;
  width?: number;
  height?: number;
}

export interface CreatorsOverview {
  creators: CreatorEntry[];
}

export interface ClipPatch {
  title?: string;
  hook?: string;
  hookStyle?: HookStyleId;
  captionPreset?: CaptionPresetId;
  captionScale?: number;
  caption?: string;
  hashtags?: string[];
  framing?: ReframeMode;
  start?: number;
  end?: number;
  starred?: boolean;
}

export interface UploadInput {
  file: File;
  title?: string;
  platform?: PlatformId;
  campaignId?: string;
  settings?: Partial<ClipSettings>;
  onProgress?: (percent: number) => void;
  signal?: AbortSignal;
}

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      headers: {
        ...(init?.body && !(init.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
        ...(init?.headers || {}),
      },
    });
  } catch {
    throw new ApiError('The local server is not responding. Is TeraClip running?', 0);
  }
  const text = await response.text();
  let payload: unknown = undefined;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = text;
    }
  }
  if (!response.ok) {
    const message =
      payload && typeof payload === 'object' && 'error' in payload
        ? String((payload as { error: unknown }).error)
        : typeof payload === 'string' && payload
          ? payload
          : `Request failed (${response.status}).`;
    throw new ApiError(message, response.status);
  }
  return payload as T;
}

function json(body: unknown): RequestInit {
  return { method: 'POST', body: JSON.stringify(body) };
}

function patch(body: unknown): RequestInit {
  return { method: 'PATCH', body: JSON.stringify(body) };
}

export function mediaUrl(relative?: string | null): string | undefined {
  if (!relative) return undefined;
  return `/media/${relative.replace(/\\/g, '/').replace(/^\/+/, '')}`;
}

export const api = {
  bootstrap: () => request<Bootstrap>('/api/bootstrap'),

  settings: () => request<AppSettings>('/api/settings'),
  saveSettings: (settings: Record<string, unknown>) =>
    request<AppSettings>('/api/settings', patch({ patch: settings })),

  system: () => request<SystemStatus>('/api/system'),
  studio: () => request<{ stats: StudioStats; dataDir: string }>('/api/studio'),
  setupTools: (force = false) => request<{ ready: boolean }>('/api/system/setup', json({ force })),
  updateYtdlp: () => request<{ ok: boolean; version?: string }>('/api/system/ytdlp-update', json({})),
  cleanup: () => request<{ freedBytes: number; removed: string[] }>('/api/system/cleanup', json({})),

  resolveImport: (url: string) => request<ResolvedImport>('/api/import/resolve', json({ url })),
  projects: () => request<ProjectSummary[]>('/api/projects'),
  project: (id: string) => request<Project>(`/api/projects/${id}`),
  createProject: (input: {
    url: string;
    title?: string;
    platform?: PlatformId;
    campaignId?: string;
    settings?: Partial<ClipSettings>;
  }) => request<Project>('/api/projects', json(input)),
  deleteProject: (id: string) => request<{ ok: boolean }>(`/api/projects/${id}`, { method: 'DELETE' }),
  retryProject: (id: string) => request<{ ok: boolean }>(`/api/projects/${id}/retry`, json({})),
  cancelProject: (id: string) => request<{ cancelled: boolean }>(`/api/projects/${id}/cancel`, json({})),
  replanProject: (id: string, settings?: Partial<ClipSettings>) =>
    request<Project>(`/api/projects/${id}/replan`, json({ settings })),

  updateClip: (projectId: string, clipId: string, body: ClipPatch) =>
    request<ClipRecord>(`/api/projects/${projectId}/clips/${clipId}`, patch(body)),
  renderClip: (projectId: string, clipId: string) =>
    request<ClipRecord>(`/api/projects/${projectId}/clips/${clipId}/render`, json({})),
  deleteClip: (projectId: string, clipId: string) =>
    request<{ ok: boolean }>(`/api/projects/${projectId}/clips/${clipId}`, { method: 'DELETE' }),
  clipDownloadUrl: (projectId: string, clipId: string) =>
    `/api/projects/${projectId}/clips/${clipId}/download`,
  exportUrl: (projectId: string) => `/api/projects/${projectId}/export`,

  library: (params?: { q?: string; platform?: string; starred?: boolean; campaign?: string }) => {
    const query = new URLSearchParams();
    if (params?.q) query.set('q', params.q);
    if (params?.platform) query.set('platform', params.platform);
    if (params?.starred) query.set('starred', '1');
    if (params?.campaign) query.set('campaign', params.campaign);
    const suffix = query.toString();
    return request<LibraryClip[]>(`/api/library${suffix ? `?${suffix}` : ''}`);
  },
  libraryDownloadUrl: (clipId: string) => `/api/library/${clipId}/download`,
  libraryKit: (clipId: string) => request<{ kit: string }>(`/api/library/${clipId}/kit`),
  deleteLibraryClip: (clipId: string) => request<{ ok: boolean }>(`/api/library/${clipId}`, { method: 'DELETE' }),

  campaigns: () => request<{ campaigns: Campaign[]; submissions: Submission[] }>('/api/campaigns'),
  createCampaign: (body: Partial<Campaign> & { name: string; brand: string }) =>
    request<Campaign>('/api/campaigns', json(body)),
  updateCampaign: (id: string, body: Partial<Campaign> & { name: string; brand: string }) =>
    request<Campaign>(`/api/campaigns/${id}`, patch(body)),
  deleteCampaign: (id: string) => request<{ ok: boolean }>(`/api/campaigns/${id}`, { method: 'DELETE' }),

  submissions: (campaignId?: string) =>
    request<Submission[]>(`/api/submissions${campaignId ? `?campaignId=${encodeURIComponent(campaignId)}` : ''}`),
  createSubmission: (body: {
    clipId: string;
    projectId: string;
    campaignId: string;
    platform: string;
    url: string;
    views?: number;
    earnings?: number;
    status?: Submission['status'];
  }) => request<Submission>('/api/submissions', json(body)),
  updateSubmission: (id: string, body: Partial<Submission>) =>
    request<Submission>(`/api/submissions/${id}`, patch(body)),
  deleteSubmission: (id: string) => request<{ ok: boolean }>(`/api/submissions/${id}`, { method: 'DELETE' }),

  live: () => request<LiveOverview>('/api/live'),
  creators: () => request<CreatorsOverview>('/api/creators'),
  refreshCreators: () => request<CreatorsOverview>('/api/creators/refresh', json({})),
  addCreator: (body: { platform: PlatformId; handle: string; name?: string }) =>
    request<CreatorsOverview>('/api/creators', json(body)),
  removeCreator: (id: string) =>
    request<CreatorsOverview>(`/api/creators/${id}`, { method: 'DELETE' }),
  recordCreator: (id: string, autoClip = true) =>
    request<LiveSession>(`/api/creators/${id}/record`, json({ autoClip })),
  resolveLive: (url: string) => request<LiveResolution>('/api/live/resolve', json({ url })),
  startLive: (body: { url: string; title?: string; autoClip?: boolean }) =>
    request<LiveSession>('/api/live', json(body)),
  stopLive: (id: string) => request<LiveSession>(`/api/live/${id}/stop`, json({})),
  toggleLiveAutoClip: (id: string, autoClip: boolean) =>
    request<LiveSession>(`/api/live/${id}`, patch({ autoClip })),
  createLiveClips: (id: string, settings?: Partial<ClipSettings>) =>
    request<{ projectId: string; rawRecordingKept: boolean }>(`/api/live/${id}/clips`, json({ settings })),
  deleteLive: (id: string) => request<{ ok: boolean }>(`/api/live/${id}`, { method: 'DELETE' }),
  liveRecordingUrl: (id: string) => `/api/live/${id}/recording`,

  uploadProject(input: UploadInput): Promise<Project> {
    const form = new FormData();
    form.append('file', input.file);
    if (input.title) form.append('title', input.title);
    if (input.platform) form.append('platform', input.platform);
    if (input.campaignId) form.append('campaignId', input.campaignId);
    if (input.settings) form.append('settings', JSON.stringify(input.settings));

    return new Promise<Project>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/projects/upload');
      xhr.upload.onprogress = (event) => {
        if (!event.lengthComputable) return;
        input.onProgress?.(Math.round((event.loaded / event.total) * 100));
      };
      xhr.onerror = () => reject(new ApiError('The upload could not reach the local server.', 0));
      xhr.onabort = () => reject(new DOMException('Upload cancelled', 'AbortError'));
      xhr.onload = () => {
        let payload: unknown;
        try {
          payload = JSON.parse(xhr.responseText);
        } catch {
          payload = undefined;
        }
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve(payload as Project);
          return;
        }
        const message =
          payload && typeof payload === 'object' && 'error' in payload
            ? String((payload as { error: unknown }).error)
            : `Upload failed (${xhr.status}).`;
        reject(new ApiError(message, xhr.status));
      };
      input.signal?.addEventListener('abort', () => xhr.abort(), { once: true });
      xhr.send(form);
    });
  },
};

export type {
  AiMode,
  AppSettings,
  AspectRatio,
  AsrModelId,
  Campaign,
  CaptionPresetId,
  ClipRecord,
  ClipSettings,
  CreatorEntry,
  HookStyleId,
  LibraryClip,
  LiveSession,
  PacingMode,
  PlatformId,
  Project,
  ProjectSummary,
  QualityMode,
  Submission,
  SystemStatus,
  ToastEvent,
};
