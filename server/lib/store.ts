import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { nanoid } from 'nanoid';
import type {
  AppSettings,
  Campaign,
  CreatorProfile,
  GeminiUsage,
  LibraryClip,
  LiveSession,
  PlatformId,
  Project,
  ProjectSummary,
  StudioStats,
  Submission,
} from '../../shared/types';
import { DEFAULT_SETTINGS } from '../../shared/presets';
import { SEED_CREATORS } from '../../shared/creators';
import { CONFIG, PATHS } from '../config';
import { log } from './logger';

interface IndexFile {
  version: number;
  createdAt: string;
  settings: AppSettings;
  projects: ProjectSummary[];
  campaigns: Campaign[];
  submissions: Submission[];
  live: LiveSession[];
  usage: Record<string, GeminiUsage>;
  studio: StudioStats;
  creators: CreatorProfile[];
}

const EMPTY_STUDIO = (): StudioStats => ({
  projectsCreated: 0,
  clipsPlanned: 0,
  rendersCompleted: 0,
  secondsRendered: 0,
  liveSecondsCaptured: 0,
  updatedAt: new Date().toISOString(),
});

function seedCreatorProfiles(): CreatorProfile[] {
  const addedAt = new Date().toISOString();
  return SEED_CREATORS.map((seed) => ({
    id: `cr_${seed.platform}_${seed.handle.toLowerCase().replace(/[^a-z0-9]+/g, '')}`,
    platform: seed.platform,
    handle: seed.handle,
    name: seed.name,
    source: 'seed' as const,
    addedAt,
  }));
}

const EMPTY_INDEX = (): IndexFile => ({
  version: 1,
  createdAt: new Date().toISOString(),
  settings: { ...DEFAULT_SETTINGS },
  projects: [],
  campaigns: [],
  submissions: [],
  live: [],
  usage: {},
  studio: EMPTY_STUDIO(),
  creators: seedCreatorProfiles(),
});

function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

async function writeJsonAtomic(file: string, data: unknown): Promise<void> {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
  try {
    await fsp.rename(tmp, file);
  } catch {
    await fsp.rm(file, { force: true }).catch(() => undefined);
    await fsp.rename(tmp, file);
  }
}

class Store {
  private index: IndexFile = EMPTY_INDEX();
  private loaded = false;
  private indexQueue: Promise<void> = Promise.resolve();
  private projectCache = new Map<string, Project>();
  private projectQueues = new Map<string, Promise<void>>();
  private storageCache: { at: number; usedBytes: number } | null = null;

  async init(): Promise<void> {
    if (this.loaded) return;
    await fsp.mkdir(PATHS.projects, { recursive: true });
    try {
      const raw = await fsp.readFile(PATHS.index, 'utf8');
      const parsed = JSON.parse(raw) as Partial<IndexFile>;
      this.index = {
        ...EMPTY_INDEX(),
        ...parsed,
        settings: { ...DEFAULT_SETTINGS, ...(parsed.settings || {}) },
        projects: parsed.projects || [],
        campaigns: parsed.campaigns || [],
        submissions: parsed.submissions || [],
        live: parsed.live || [],
        usage: parsed.usage || {},
        studio: { ...EMPTY_STUDIO(), ...(parsed.studio || {}) },
        creators: Array.isArray(parsed.creators) ? parsed.creators : seedCreatorProfiles(),
      };
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        log.error('index.json is unreadable; starting with a fresh index', error);
        try {
          await fsp.rename(PATHS.index, `${PATHS.index}.broken-${Date.now()}`);
        } catch {
          /* ignore */
        }
      }
      this.index = EMPTY_INDEX();
    }
    await this.recoverProjects();
    if (this.index.studio.projectsCreated === 0 && this.index.projects.length > 0) {
      await this.backfillStudio();
    }
    this.loaded = true;
    await this.persistIndex();
    log.info(`store ready with ${this.index.projects.length} project(s)`);
  }

  /**
   * Counters added after the first projects existed. If an index has projects
   * but no lifetime ledger, seed it from what is already on disk once.
   */
  private async backfillStudio(): Promise<void> {
    let planned = 0;
    let renders = 0;
    let seconds = 0;
    for (const summary of this.index.projects) {
      const project = await this.getProject(summary.id);
      if (!project) continue;
      planned += project.clips.length;
      for (const clip of project.clips) {
        if (clip.status !== 'ready') continue;
        renders += 1;
        seconds += clip.duration || 0;
      }
    }
    const liveSeconds = this.index.live.reduce(
      (sum, session) => sum + (session.status === 'ready' ? session.duration || 0 : 0),
      0,
    );
    this.index.studio = {
      projectsCreated: this.index.projects.length,
      clipsPlanned: planned,
      rendersCompleted: renders,
      secondsRendered: Math.round(seconds * 10) / 10,
      liveSecondsCaptured: Math.round(liveSeconds * 10) / 10,
      updatedAt: new Date().toISOString(),
    };
    log.info(`backfilled lifetime ledger from ${this.index.projects.length} existing project(s)`);
  }

  private async recoverProjects(): Promise<void> {
    let dirs: string[] = [];
    try {
      dirs = await fsp.readdir(PATHS.projects);
    } catch {
      return;
    }
    const known = new Set(this.index.projects.map((p) => p.id));
    for (const dir of dirs) {
      if (known.has(dir)) continue;
      const file = path.join(PATHS.projects, dir, 'project.json');
      try {
        const project = JSON.parse(await fsp.readFile(file, 'utf8')) as Project;
        if (!project?.id) continue;
        this.projectCache.set(project.id, project);
        this.index.projects.push(this.summarize(project));
      } catch {
        /* ignore incomplete folders */
      }
    }
    // Drop summaries whose project file disappeared.
    this.index.projects = this.index.projects.filter((summary) => {
      const file = path.join(PATHS.projects, summary.id, 'project.json');
      return fs.existsSync(file);
    });
  }

  private persistIndex(): Promise<void> {
    const snapshot = JSON.parse(JSON.stringify(this.index)) as IndexFile;
    this.indexQueue = this.indexQueue
      .then(() => writeJsonAtomic(PATHS.index, snapshot))
      .catch((error) => log.error('failed to persist index', error));
    return this.indexQueue;
  }

  summarize(project: Project): ProjectSummary {
    return {
      id: project.id,
      title: project.title,
      channel: project.channel,
      platform: project.platform,
      sourceKind: project.sourceKind,
      sourceUrl: project.sourceUrl,
      thumbnailPath: project.thumbnailPath,
      duration: project.duration,
      campaignId: project.campaignId,
      status: project.status,
      stage: project.stage,
      progress: project.progress,
      message: project.message,
      error: project.error,
      clipCount: project.clips.length,
      readyClips: project.clips.filter((c) => c.status === 'ready').length,
      settings: {
        aspect: project.settings.aspect,
        captionPreset: project.settings.captionPreset,
        hookStyle: project.settings.hookStyle,
        quality: project.settings.quality,
      },
      stats: project.stats,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
    };
  }

  getSettings(): AppSettings {
    const settings = { ...DEFAULT_SETTINGS, ...this.index.settings };
    if (CONFIG.cookiesBrowser) settings.cookiesBrowser = CONFIG.cookiesBrowser;
    if (CONFIG.cookiesFile) settings.cookiesFile = CONFIG.cookiesFile;
    return settings;
  }

  getStudioStats(): StudioStats {
    return { ...this.index.studio };
  }

  /** Lifetime counters survive clip/project deletion because they live in index.json. */
  async recordStudio(delta: Partial<Omit<StudioStats, 'updatedAt'>>): Promise<StudioStats> {
    const next = { ...this.index.studio };
    const keys: Array<keyof Omit<StudioStats, 'updatedAt'>> = [
      'projectsCreated',
      'clipsPlanned',
      'rendersCompleted',
      'secondsRendered',
      'liveSecondsCaptured',
    ];
    for (const key of keys) {
      const add = delta[key];
      if (!add) continue;
      next[key] = Math.round((next[key] + add) * 10) / 10;
    }
    next.updatedAt = new Date().toISOString();
    this.index.studio = next;
    await this.persistIndex();
    return { ...next };
  }

  async updateSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
    this.index.settings = { ...this.getSettings(), ...patch };
    await this.persistIndex();
    return this.getSettings();
  }

  // ---------- creator radar ----------
  listCreators(): CreatorProfile[] {
    return [...this.index.creators];
  }

  async addCreator(input: {
    platform: PlatformId;
    handle: string;
    name: string;
    source?: CreatorProfile['source'];
  }): Promise<CreatorProfile> {
    const handle = input.handle.trim();
    if (!handle) throw new Error('Add a channel handle first.');
    const duplicate = this.index.creators.some(
      (creator) =>
        creator.platform === input.platform && creator.handle.toLowerCase() === handle.toLowerCase(),
    );
    if (duplicate) throw new Error(`${handle} is already on your creator radar.`);
    if (this.index.creators.length >= 60) throw new Error('The radar is full. Remove a creator first.');
    const creator: CreatorProfile = {
      id: `cr_${nanoid(9)}`,
      platform: input.platform,
      handle,
      name: input.name.trim() || handle,
      source: input.source || 'custom',
      addedAt: new Date().toISOString(),
    };
    this.index.creators.push(creator);
    await this.persistIndex();
    return creator;
  }

  async removeCreator(id: string): Promise<boolean> {
    const before = this.index.creators.length;
    this.index.creators = this.index.creators.filter((creator) => creator.id !== id);
    if (this.index.creators.length === before) return false;
    await this.persistIndex();
    return true;
  }

  listProjects(): ProjectSummary[] {
    return [...this.index.projects].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  getProjectSummary(id: string): ProjectSummary | undefined {
    return this.index.projects.find((p) => p.id === id);
  }

  async getProject(id: string): Promise<Project | undefined> {
    if (this.projectCache.has(id)) return this.projectCache.get(id);
    try {
      const raw = await fsp.readFile(path.join(PATHS.projects, id, 'project.json'), 'utf8');
      const project = JSON.parse(raw) as Project;
      this.projectCache.set(id, project);
      return project;
    } catch {
      return undefined;
    }
  }

  async saveProject(project: Project): Promise<void> {
    project.updatedAt = new Date().toISOString();
    project.logs = project.logs.slice(-250);
    this.projectCache.set(project.id, project);
    const summary = this.summarize(project);
    const idx = this.index.projects.findIndex((p) => p.id === project.id);
    if (idx >= 0) this.index.projects[idx] = summary;
    else this.index.projects.push(summary);
    // Snapshot for the queued write. Never replace the live arrays in place:
    // the pipeline and the clip editor hold references to clip objects across
    // awaits, and swapping them out would silently orphan their updates.
    const snapshot = structuredClone(project);
    const previous = this.projectQueues.get(project.id) || Promise.resolve();
    const next = previous
      .then(() => writeJsonAtomic(path.join(PATHS.projects, project.id, 'project.json'), snapshot))
      .catch((error) => log.error(`failed to save project ${project.id}`, error));
    this.projectQueues.set(project.id, next);
    await Promise.all([next, this.persistIndex()]);
  }

  async deleteProject(id: string): Promise<void> {
    this.index.projects = this.index.projects.filter((p) => p.id !== id);
    this.index.submissions = this.index.submissions.filter((s) => s.projectId !== id);
    this.projectCache.delete(id);
    this.projectQueues.delete(id);
    await fsp.rm(path.join(PATHS.projects, id), { recursive: true, force: true });
    await this.persistIndex();
  }

  async listClips(): Promise<LibraryClip[]> {
    const result: LibraryClip[] = [];
    for (const summary of this.index.projects) {
      const project = await this.getProject(summary.id);
      if (!project) continue;
      for (const clip of project.clips) {
        if (clip.status !== 'ready' && clip.status !== 'planned') continue;
        result.push({
          clip,
          project: {
            id: project.id,
            title: project.title,
            platform: project.platform,
            sourceUrl: project.sourceUrl,
            campaignId: project.campaignId,
            createdAt: project.createdAt,
          },
        });
      }
    }
    return result.sort((a, b) => b.clip.createdAt.localeCompare(a.clip.createdAt));
  }

  // ---------- campaigns ----------
  listCampaigns(): Campaign[] {
    return [...this.index.campaigns].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  getCampaign(id: string): Campaign | undefined {
    return this.index.campaigns.find((c) => c.id === id);
  }

  async saveCampaign(input: Partial<Campaign> & { name: string; brand: string }): Promise<Campaign> {
    const now = new Date().toISOString();
    const existing = input.id ? this.getCampaign(input.id) : undefined;
    const campaign: Campaign = {
      id: existing?.id || `cmp_${nanoid(8)}`,
      name: input.name,
      brand: input.brand,
      platform: input.platform || 'twitch',
      status: input.status || 'active',
      link: input.link || '',
      color: input.color || '#7C3AED',
      payoutPer1k: input.payoutPer1k ?? 0,
      rules: {
        minDuration: input.rules?.minDuration ?? 15,
        maxDuration: input.rules?.maxDuration ?? 60,
        aspect: input.rules?.aspect || '9:16',
        requiredTags: input.rules?.requiredTags || [],
        mentions: input.rules?.mentions || [],
        cta: input.rules?.cta || '',
        notes: input.rules?.notes || '',
      },
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    };
    const idx = this.index.campaigns.findIndex((c) => c.id === campaign.id);
    if (idx >= 0) this.index.campaigns[idx] = campaign;
    else this.index.campaigns.push(campaign);
    await this.persistIndex();
    return campaign;
  }

  async deleteCampaign(id: string): Promise<void> {
    this.index.campaigns = this.index.campaigns.filter((c) => c.id !== id);
    this.index.submissions = this.index.submissions.filter((s) => s.campaignId !== id);
    await this.persistIndex();
  }

  listSubmissions(campaignId?: string): Submission[] {
    return this.index.submissions
      .filter((s) => !campaignId || s.campaignId === campaignId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async saveSubmission(input: Partial<Submission> & { clipId: string; projectId: string; campaignId: string; platform: string; url: string }): Promise<Submission> {
    const now = new Date().toISOString();
    const existing = input.id ? this.index.submissions.find((s) => s.id === input.id) : undefined;
    const submission: Submission = {
      id: existing?.id || `sub_${nanoid(8)}`,
      clipId: input.clipId,
      projectId: input.projectId,
      campaignId: input.campaignId,
      platform: input.platform,
      url: input.url,
      views: input.views ?? existing?.views ?? 0,
      earnings: input.earnings ?? existing?.earnings ?? 0,
      status: input.status || existing?.status || 'posted',
      postedAt: input.postedAt || existing?.postedAt || now,
      createdAt: existing?.createdAt || now,
    };
    const idx = this.index.submissions.findIndex((s) => s.id === submission.id);
    if (idx >= 0) this.index.submissions[idx] = submission;
    else this.index.submissions.push(submission);
    await this.persistIndex();
    return submission;
  }

  async deleteSubmission(id: string): Promise<void> {
    this.index.submissions = this.index.submissions.filter((s) => s.id !== id);
    await this.persistIndex();
  }

  // ---------- live ----------
  listLiveSessions(): LiveSession[] {
    return [...this.index.live].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  getLiveSession(id: string): LiveSession | undefined {
    return this.index.live.find((s) => s.id === id);
  }

  async saveLiveSession(session: LiveSession): Promise<void> {
    session.updatedAt = new Date().toISOString();
    session.log = session.log.slice(-150);
    const idx = this.index.live.findIndex((s) => s.id === session.id);
    if (idx >= 0) this.index.live[idx] = session;
    else this.index.live.unshift(session);
    this.index.live = this.index.live.slice(0, 50);
    await this.persistIndex();
  }

  async deleteLiveSession(id: string): Promise<void> {
    this.index.live = this.index.live.filter((s) => s.id !== id);
    await this.persistIndex();
    await fsp.rm(path.join(PATHS.live, id), { recursive: true, force: true }).catch(() => undefined);
  }

  // ---------- Gemini budget ----------
  getUsage(): GeminiUsage {
    const key = today();
    const usage = this.index.usage[key];
    if (!usage) {
      this.index.usage[key] = { date: key, requests: 0, cachedHits: 0, tokensIn: 0, tokensOut: 0, failures: 0 };
      void this.persistIndex();
      return this.index.usage[key]!;
    }
    return usage;
  }

  async recordUsage(patch: Partial<Omit<GeminiUsage, 'date'>>): Promise<void> {
    const usage = this.getUsage();
    if (patch.requests) usage.requests += patch.requests;
    if (patch.cachedHits) usage.cachedHits += patch.cachedHits;
    if (patch.tokensIn) usage.tokensIn += patch.tokensIn;
    if (patch.tokensOut) usage.tokensOut += patch.tokensOut;
    if (patch.failures) usage.failures += patch.failures;
    // prune older usage history, keeping a month
    const keys = Object.keys(this.index.usage).sort();
    while (keys.length > 45) {
      const key = keys.shift();
      if (key) delete this.index.usage[key];
    }
    await this.persistIndex();
  }

  // ---------- storage ----------
  async storageUsed(force = false): Promise<number> {
    if (!force && this.storageCache && Date.now() - this.storageCache.at < 20_000) return this.storageCache.usedBytes;
    let total = 0;
    const walk = async (dir: string): Promise<void> => {
      let entries: fs.Dirent[] = [];
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) await walk(full);
        else if (entry.isFile()) {
          try {
            total += (await fsp.stat(full)).size;
          } catch {
            /* ignore */
          }
        }
      }
    };
    await walk(CONFIG.dataDir);
    this.storageCache = { at: Date.now(), usedBytes: total };
    return total;
  }

  invalidateStorage(): void {
    this.storageCache = null;
  }
}

export const store = new Store();
