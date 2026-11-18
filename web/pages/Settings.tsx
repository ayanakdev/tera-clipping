import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Captions,
  Check,
  Cookie,
  Cpu,
  Gauge,
  HardDrive,
  KeyRound,
  MessageSquare,
  Mic2,
  Radio,
  RefreshCw,
  Save,
  Server,
  ShieldCheck,
  Sparkles,
  Trash2,
  Undo2,
  Wand2,
  Wrench,
  Zap,
} from 'lucide-react';
import type { AppSettings, AsrModelId, CaptionPresetId, HookStyleId, PlatformId } from '@shared/types';
import { CAPTION_BY_ID, CAPTION_PRESETS, HOOK_STYLES } from '@shared/presets';
import { PLATFORMS } from '@shared/platforms';
import { api } from '@web/lib/api';
import { bytes, plural } from '@web/lib/format';
import { useApp } from '@web/state/AppContext';
import {
  Badge,
  Button,
  Field,
  Input,
  Panel,
  Range,
  Segmented,
  Select,
  Skeleton,
  Toggle,
  cx,
} from '@web/components/ui';
import { ClipStagePreview, HookCard } from '@web/components/media';

const COOKIE_BROWSERS = [
  { value: '', label: 'No browser cookies' },
  { value: 'chrome', label: 'Chrome' },
  { value: 'edge', label: 'Edge' },
  { value: 'firefox', label: 'Firefox' },
  { value: 'brave', label: 'Brave' },
  { value: 'chromium', label: 'Chromium' },
  { value: 'opera', label: 'Opera' },
  { value: 'vivaldi', label: 'Vivaldi' },
];

const ASR_OPTIONS: Array<{ value: AsrModelId; label: string }> = [
  { value: 'base.en', label: 'Base English · fast, accurate' },
  { value: 'small.en', label: 'Small English · slower, sharper' },
  { value: 'base', label: 'Base multilingual' },
  { value: 'tiny.en', label: 'Tiny English · quickest' },
];

const HOOK_PREVIEW: Record<HookStyleId, string> = {
  white: 'Wait for the end 😳',
  black: 'This has to be fake 😳',
  purple: 'He never saw it coming 😳',
  none: '',
};

/** Rough disk cost of a stream copy, useful on an 8 GB laptop. */
function captureRate(quality: AppSettings['recordQuality']): string {
  if (quality === '720p') return '≈ 1.5 GB per hour';
  if (quality === '1080p') return '≈ 3 GB per hour';
  return '≈ 3–5 GB per hour';
}

function statusClass(status: string): string {
  if (status === 'ready') return '';
  if (status === 'downloading') return 'is-warning';
  return 'is-missing';
}

export default function Settings() {
  const { settings, system, bootstrap, notify, confirm, saveSettings, refreshSystem } = useApp();

  const [form, setForm] = useState<AppSettings | null>(null);
  const [baseline, setBaseline] = useState<AppSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [toolBusy, setToolBusy] = useState<'setup' | 'ytdlp' | 'cleanup' | null>(null);

  useEffect(() => {
    if (!settings) return;
    if (!form || !baseline) {
      setForm(settings);
      setBaseline(settings);
    }
  }, [settings, form, baseline]);

  const set = useCallback(<K extends keyof AppSettings>(key: K, value: AppSettings[K]) => {
    setForm((current) => (current ? { ...current, [key]: value } : current));
  }, []);

  const dirty = useMemo(
    () => Boolean(form && baseline && JSON.stringify(form) !== JSON.stringify(baseline)),
    [form, baseline],
  );

  const preset = form ? CAPTION_BY_ID[form.defaultCaptionPreset] ?? CAPTION_PRESETS[0] : CAPTION_PRESETS[0];
  const aspectCss = form ? form.defaultAspect.replace(':', ' / ') : '9 / 16';
  const usage = system?.gemini.usage;
  const geminiLimit = system ? system.gemini.dailyLimit : form?.geminiDailyLimit ?? 40;
  const geminiPct = usage && geminiLimit > 0 ? Math.min(100, (usage.requests / geminiLimit) * 100) : 0;
  const diskPct =
    system && system.storage.totalBytes > 0
      ? Math.min(100, ((system.storage.totalBytes - system.storage.freeBytes) / system.storage.totalBytes) * 100)
      : 0;

  const missingTools = useMemo(() => {
    if (!system) return [];
    const bins = system.binaries;
    const checks: Array<[string, { status: string }]> = [
      ['ffmpeg', bins.ffmpeg],
      ['ffprobe', bins.ffprobe],
      ['yt-dlp', bins.ytdlp],
      ['whisper.cpp', bins.whisper],
      ['speech model', bins.whisperModel],
      ['face tracker', bins.yunet],
      ['caption fonts', bins.fonts],
    ];
    return checks.filter(([, bin]) => bin.status !== 'ready').map(([name]) => name);
  }, [system]);

  const save = async () => {
    if (!form || !dirty || saving) return;
    setSaving(true);
    try {
      const saved = await saveSettings({
        clipCount: form.defaultClipCount,
        minDuration: form.defaultMinDuration,
        maxDuration: form.defaultMaxDuration,
        aspect: form.defaultAspect,
        captionPreset: form.defaultCaptionPreset,
        captionScale: form.defaultCaptionScale,
        hookStyle: form.defaultHookStyle,
        pacing: form.defaultPacing,
        quality: form.defaultQuality,
        renderAcceleration: form.renderAcceleration,
        reframe: form.defaultReframe,
        aiMode: form.defaultAiMode,
        asrModel: form.defaultAsrModel,
        language: form.asrLanguage,
        watermark: form.watermark,
        asrThreads: form.asrThreads,
        geminiModel: form.geminiModel,
        geminiDailyLimit: form.geminiDailyLimit,
        cookiesBrowser: form.cookiesBrowser,
        cookiesFile: form.cookiesFile,
        brandHandle: form.brandHandle,
        autoDeleteBasesDays: form.autoDeleteBasesDays,
        recordQuality: form.recordQuality,
        liveLookback: form.liveLookback,
        liveChatLag: form.liveChatLag,
        liveAutoClip: form.liveAutoClip,
        liveAutoClipThreshold: form.liveAutoClipThreshold,
        liveKeepRecording: form.liveKeepRecording,
        liveMomentOnly: form.liveMomentOnly,
      });
      setForm(saved);
      setBaseline(saved);
      notify({ tone: 'success', title: 'Settings saved', message: 'New projects will use these defaults.' });
      void refreshSystem();
    } catch (error) {
      notify({ tone: 'error', title: 'Could not save settings', message: (error as Error).message });
    } finally {
      setSaving(false);
    }
  };

  const discard = () => {
    if (!baseline) return;
    setForm(baseline);
    notify({ tone: 'info', title: 'Changes discarded' });
  };

  const runSetup = async () => {
    if (toolBusy) return;
    setToolBusy('setup');
    try {
      const result = await api.setupTools(true);
      notify({
        tone: result.ready ? 'success' : 'error',
        title: result.ready ? 'Toolkit ready' : 'Some tools are still missing',
        message: result.ready
          ? 'ffmpeg, yt-dlp, whisper and the face tracker are installed locally.'
          : 'Check the tool list for details, then run repair again.',
      });
      await refreshSystem();
    } catch (error) {
      notify({ tone: 'error', title: 'Tool setup failed', message: (error as Error).message });
    } finally {
      setToolBusy(null);
    }
  };

  const runYtdlpUpdate = async () => {
    if (toolBusy) return;
    setToolBusy('ytdlp');
    try {
      const result = await api.updateYtdlp();
      notify({
        tone: 'success',
        title: 'yt-dlp updated',
        message: result.version ? `Now on ${result.version}.` : 'Extractor is current.',
      });
      await refreshSystem();
    } catch (error) {
      notify({ tone: 'error', title: 'Could not update yt-dlp', message: (error as Error).message });
    } finally {
      setToolBusy(null);
    }
  };

  const runCleanup = async () => {
    if (toolBusy) return;
    const ok = await confirm({
      title: 'Clean temporary files?',
      body: 'Scratch renders and old downloaded sources are removed. Finished clips, thumbnails and posting kits are kept.',
      confirmLabel: 'Clean storage',
    });
    if (!ok) return;
    setToolBusy('cleanup');
    try {
      const result = await api.cleanup();
      notify({
        tone: 'success',
        title: 'Storage cleaned',
        message: `${bytes(result.freedBytes)} freed${result.removed.length ? ` · ${plural(result.removed.length, 'item')}` : ''}.`,
      });
      await refreshSystem();
    } catch (error) {
      notify({ tone: 'error', title: 'Cleanup failed', message: (error as Error).message });
    } finally {
      setToolBusy(null);
    }
  };

  if (!form) {
    return (
      <>
        <div className="page-head">
          <div>
            <Skeleton style={{ width: 110, height: 12 }} />
            <Skeleton style={{ width: 300, height: 32, marginTop: 12 }} />
            <Skeleton style={{ width: 520, maxWidth: '100%', height: 14, marginTop: 10 }} />
          </div>
        </div>
        <div className="settings-grid">
          <div className="settings-main">
            <Skeleton style={{ height: 260, borderRadius: 14 }} />
            <Skeleton style={{ height: 220, borderRadius: 14 }} />
          </div>
          <div className="settings-side">
            <Skeleton style={{ height: 300, borderRadius: 14 }} />
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <div className="page-head">
        <div className="page-head-copy">
          <p className="page-kicker">
            <Gauge size={13} /> Studio settings
          </p>
          <h1 className="page-title">Tune the cutting room</h1>
          <p className="page-sub">
            Defaults for every new clip set, the live recorder, local speech recognition and the cloud leash. Saved to
            this laptop only.
          </p>
        </div>
        <div className="head-actions">
          <Badge tone={dirty ? 'violet' : 'green'} dot={dirty}>
            {dirty ? 'Unsaved changes' : 'Everything saved'}
          </Badge>
        </div>
      </div>

      <div className="settings-grid">
        <div className="settings-main">
          {missingTools.length ? (
            <div className="project-alert" style={{ marginTop: 0 }}>
              <AlertTriangle size={16} />
              <div>
                <strong>Some local tools are not ready</strong>
                Missing: {missingTools.join(', ')}. Run the repair action in the toolbox to download them without an
                account.
              </div>
            </div>
          ) : null}

          <Panel
            eyebrow="New clip sets"
            title={
              <span className="settings-subhead" style={{ marginBottom: 0 }}>
                <span className="settings-subhead-icon">
                  <Wand2 size={15} />
                </span>
                <span>
                  Clip defaults
                  <p>Every “New clips” run starts here. You can still override each set.</p>
                </span>
              </span>
            }
            action={<Badge tone="neutral">{form.defaultClipCount} clips · {form.defaultAspect}</Badge>}
          >
            <div className="settings-defaults">
              <Field label="Clips per project">
                <Select
                  value={String(form.defaultClipCount)}
                  onChange={(value) => set('defaultClipCount', Number(value))}
                >
                  {Array.from({ length: 10 }, (_, index) => index + 1).map((count) => (
                    <option key={count} value={count}>
                      {count} clip{count === 1 ? '' : 's'}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Aspect ratio">
                <Segmented
                  className="segmented-wide"
                  value={form.defaultAspect}
                  onChange={(value) => set('defaultAspect', value)}
                  options={[
                    { value: '9:16', label: '9:16' },
                    { value: '1:1', label: '1:1' },
                    { value: '16:9', label: '16:9' },
                  ]}
                />
              </Field>
              <Field label="Default caption look">
                <Select
                  value={form.defaultCaptionPreset}
                  onChange={(value) => set('defaultCaptionPreset', value as CaptionPresetId)}
                >
                  {CAPTION_PRESETS.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <div className="settings-field-wide">
                <Range
                  label="Caption size"
                  value={Math.round(form.defaultCaptionScale * 100)}
                  min={60}
                  max={160}
                  step={5}
                  suffix="%"
                  onChange={(value) => set('defaultCaptionScale', value / 100)}
                  hint="100% is the preset default. The same slider is available on every clip in the editor."
                />
              </div>
              <Field label="Default hook card">
                <Select
                  value={form.defaultHookStyle}
                  onChange={(value) => set('defaultHookStyle', value as HookStyleId)}
                >
                  {HOOK_STYLES.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Shortest clip" hint={`${form.defaultMinDuration}s`}>
                <Input
                  type="number"
                  min={5}
                  max={120}
                  value={form.defaultMinDuration}
                  onChange={(event) =>
                    set('defaultMinDuration', Math.max(5, Math.min(120, Number(event.target.value) || 5)))
                  }
                />
              </Field>
              <Field label="Longest clip" hint={`${form.defaultMaxDuration}s`}>
                <Input
                  type="number"
                  min={10}
                  max={240}
                  value={form.defaultMaxDuration}
                  onChange={(event) =>
                    set('defaultMaxDuration', Math.max(10, Math.min(240, Number(event.target.value) || 10)))
                  }
                />
              </Field>
              <Field label="Cutting pace">
                <Select
                  value={form.defaultPacing}
                  onChange={(value) => set('defaultPacing', value as AppSettings['defaultPacing'])}
                >
                  <option value="original">Natural</option>
                  <option value="balanced">Balanced</option>
                  <option value="tight">Tight</option>
                </Select>
              </Field>
              <Field label="Render quality">
                <Select
                  value={form.defaultQuality}
                  onChange={(value) => set('defaultQuality', value as AppSettings['defaultQuality'])}
                >
                  <option value="fast">Fast · 720p-friendly</option>
                  <option value="balanced">Balanced · 1080p</option>
                  <option value="high">High · crisp, slower</option>
                </Select>
              </Field>
              <Field label="Render speed" hint="auto = GPU if usable">
                <Select
                  value={form.renderAcceleration}
                  onChange={(value) =>
                    set('renderAcceleration', value as AppSettings['renderAcceleration'])
                  }
                >
                  <option value="auto">Auto · use Quick Sync / NVENC / AMF</option>
                  <option value="cpu">CPU only · libx264</option>
                </Select>
              </Field>
              <Field label="Smart framing">
                <Select
                  value={form.defaultReframe}
                  onChange={(value) => set('defaultReframe', value as AppSettings['defaultReframe'])}
                >
                  <option value="smart">Smart · tracks faces</option>
                  <option value="split">Gameplay + cam · stacked</option>
                  <option value="center">Center crop</option>
                  <option value="blur">Blur fill</option>
                </Select>
              </Field>
              <Field label="Editorial AI">
                <Select
                  value={form.defaultAiMode}
                  onChange={(value) => set('defaultAiMode', value as AppSettings['defaultAiMode'])}
                >
                  <option value="smart">Smart · Gemini names the winners</option>
                  <option value="full">Full review · more requests</option>
                  <option value="off">Local only · no cloud</option>
                </Select>
              </Field>
              <Field label="Speech model" className="settings-field-wide">
                <Select
                  value={form.defaultAsrModel}
                  onChange={(value) => set('defaultAsrModel', value as AsrModelId)}
                >
                  {ASR_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
          </Panel>

          <Panel
            eyebrow="Live recorder"
            title={
              <span className="settings-subhead" style={{ marginBottom: 0 }}>
                <span className="settings-subhead-icon">
                  <Radio size={15} />
                </span>
                <span>
                  Capture &amp; heat
                  <p>A clean stream copy, chat heat and local moment detection. No frame capture.</p>
                </span>
              </span>
            }
            action={<Badge tone="neutral">{form.recordQuality} quality</Badge>}
          >
            <div className="settings-form-grid">
              <Field label="Capture quality">
                <Select
                  value={form.recordQuality}
                  onChange={(value) => set('recordQuality', value as AppSettings['recordQuality'])}
                >
                  <option value="best">Best available</option>
                  <option value="1080p">1080p maximum</option>
                  <option value="720p">720p maximum</option>
                </Select>
              </Field>
              <Field label="Clip lookback" hint={`${form.liveLookback}s before the spike`}>
                <Input
                  type="number"
                  min={20}
                  max={300}
                  value={form.liveLookback}
                  onChange={(event) =>
                    set('liveLookback', Math.max(20, Math.min(300, Number(event.target.value) || 90)))
                  }
                />
              </Field>
              <Field label="Chat reaction lag" hint={`Rewind ${form.liveChatLag}s when chat surges`}>
                <Input
                  type="number"
                  min={0}
                  max={45}
                  value={form.liveChatLag}
                  onChange={(event) =>
                    set('liveChatLag', Math.max(0, Math.min(45, Number(event.target.value) || 0)))
                  }
                />
              </Field>
            </div>
            <p className="settings-note">
              <MessageSquare size={12} /> Chat is always a few seconds behind the action. On a chat surge the engine
              rewinds this far, then snaps to the strongest audio beat nearby — usually that is the real highlight.
            </p>
            <p className="settings-note">
              <HardDrive size={12} /> A stream copy writes roughly{' '}
              <strong>{captureRate(form.recordQuality)}</strong> while live. Segments are folded into one file when you
              stop, and that file is handed to the clip project. 720p is the lightest option for an 8 GB laptop.
            </p>
            <div className="settings-divider" />
            <Toggle
              checked={form.liveKeepRecording}
              onChange={(value) => set('liveKeepRecording', value)}
              label="Keep the raw live recording after clipping"
              hint="Off by default. The project shares the same file when the disk supports it, so keeping the session path costs no extra space."
            />
            <div className="settings-divider" />
            <Toggle
              checked={form.liveAutoClip}
              onChange={(value) => set('liveAutoClip', value)}
              label="Cut clips automatically while recording"
              hint="Off by default. Moments are scored from audio energy and chat rate, without any AI call."
            />
            <div style={{ marginTop: 14, maxWidth: 420 }}>
              <Range
                value={form.liveAutoClipThreshold}
                min={40}
                max={95}
                step={1}
                suffix=" heat"
                onChange={(value) => set('liveAutoClipThreshold', value)}
                label="Auto-clip threshold"
                hint="Higher means fewer, hotter moments are cut."
              />
            </div>
            <div className="settings-divider" />
            <Toggle
              checked={form.liveMomentOnly}
              onChange={(value) => set('liveMomentOnly', value)}
              label="Moment buffer only"
              hint="Keeps roughly the last 5 minutes and deletes older video. Requires auto-clip; you cannot re-cut the full stream afterwards."
            />
            <div className="settings-divider" />
            <div className="settings-form-grid">
              <Field label="Watermark clips" hint="Burns a handle in the corner">
                <div style={{ paddingTop: 5 }}>
                  <Toggle
                    checked={form.watermark}
                    onChange={(value) => set('watermark', value)}
                    label="Add brand handle"
                    hint="Applies to new renders only."
                  />
                </div>
              </Field>
              <Field label="Brand handle" hint="No @ needed">
                <Input
                  value={form.brandHandle}
                  onChange={(event) => set('brandHandle', event.target.value.replace(/^@/, ''))}
                  placeholder="teraclip"
                  maxLength={40}
                />
              </Field>
            </div>
            <p className="settings-note">
              <ShieldCheck size={12} /> Cloud AI never runs while recording. Auto-clip cuts locally from the saved
              segments and can be edited afterwards.
            </p>
          </Panel>

          <Panel
            eyebrow="Speech, cookies and shared defaults"
            title={
              <span className="settings-subhead" style={{ marginBottom: 0 }}>
                <span className="settings-subhead-icon">
                  <Mic2 size={15} />
                </span>
                <span>
                  Local speech &amp; access
                  <p>Whisper.cpp runs on this CPU. Cookies help with private or age-gated sources.</p>
                </span>
              </span>
            }
            action={
              <Badge tone="neutral">
                {form.asrThreads > 0 ? `${form.asrThreads} CPU threads` : 'Auto CPU threads'}
              </Badge>
            }
          >
            <div className="settings-form-grid">
              <Field label="Speech model">
                <Select
                  value={form.defaultAsrModel}
                  onChange={(value) => set('defaultAsrModel', value as AsrModelId)}
                >
                  {ASR_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Recognition threads" hint="0 = auto · 1–16">
                <Input
                  type="number"
                  min={0}
                  max={16}
                  value={form.asrThreads}
                  onChange={(event) =>
                    set('asrThreads', Math.max(0, Math.min(16, Math.round(Number(event.target.value) || 0))))
                  }
                />
              </Field>
              <Field label="Source language" hint="ISO code">
                <Input
                  value={form.asrLanguage}
                  onChange={(event) => set('asrLanguage', event.target.value.slice(0, 12))}
                  placeholder="en"
                  maxLength={12}
                />
              </Field>
              <Field label="Cookie browser" hint="Shown only if a source asks for sign-in">
                <Select value={form.cookiesBrowser} onChange={(value) => set('cookiesBrowser', value)}>
                  {COOKIE_BROWSERS.map((option) => (
                    <option key={option.value || 'none'} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Cookies file" hint="Optional · Netscape format" className="settings-field-wide">
                <Input
                  value={form.cookiesFile}
                  onChange={(event) => set('cookiesFile', event.target.value)}
                  placeholder="C:\\Users\\you\\cookies.txt"
                  spellCheck={false}
                />
              </Field>
            </div>
            <p className="settings-note">
              <Cookie size={12} /> Cookies stay on this laptop and are passed only to yt-dlp. Public videos need none.
            </p>
          </Panel>

          <Panel
            eyebrow="Gemini editorial pass"
            title={
              <span className="settings-subhead" style={{ marginBottom: 0 }}>
                <span className="settings-subhead-icon">
                  <Sparkles size={15} />
                </span>
                <span>
                  Cloud AI, on a leash
                  <p>Only the final moment names and hooks use Gemini. Local scoring does the heavy lifting.</p>
                </span>
              </span>
            }
            action={
              <Badge tone={bootstrap?.geminiConfigured ? 'green' : 'amber'} dot>
                {bootstrap?.geminiConfigured ? 'key detected' : 'local only'}
              </Badge>
            }
          >
            <div className="settings-form-grid">
              <Field label="Gemini model">
                <Input
                  value={form.geminiModel}
                  onChange={(event) => set('geminiModel', event.target.value)}
                  placeholder="gemini-2.5-flash"
                  spellCheck={false}
                />
              </Field>
              <Field label="Daily request cap" hint="0 disables cloud calls">
                <Input
                  type="number"
                  min={0}
                  max={500}
                  value={form.geminiDailyLimit}
                  onChange={(event) =>
                    set('geminiDailyLimit', Math.max(0, Math.min(500, Number(event.target.value) || 0)))
                  }
                />
              </Field>
            </div>
            <div className="gemini-meter" style={{ marginTop: 16 }}>
              <div className="gemini-values">
                <strong>
                  {usage?.requests ?? 0}
                  <span> {geminiLimit > 0 ? `/ ${geminiLimit} requests today` : 'requests · cloud disabled'}</span>
                </strong>
                <span>{geminiLimit > 0 ? `${Math.round(geminiPct)}% of the leash` : 'local only'}</span>
              </div>
              <div className="gemini-bar">
                <span style={{ width: `${geminiPct}%` }} />
              </div>
              <div className="gemini-meta">
                <span>{usage?.cachedHits ?? 0} cache hits</span>
                <i />
                <span>{usage?.failures ?? 0} failures</span>
                <i />
                <span>{((usage?.tokensIn ?? 0) + (usage?.tokensOut ?? 0)).toLocaleString()} tokens</span>
              </div>
            </div>
            <p className="settings-note">
              <KeyRound size={12} /> The key lives in <code>.env.local</code> as <code>GEMINI_API</code>. It is read by
              the server only and never reaches the browser. With no key, the whole pipeline still works locally.
            </p>
          </Panel>

          <Panel
            eyebrow="Housekeeping"
            title={
              <span className="settings-subhead" style={{ marginBottom: 0 }}>
                <span className="settings-subhead-icon">
                  <HardDrive size={15} />
                </span>
                <span>
                  Keep the laptop light
                  <p>Long streams take space. TeraClip can drop scratch files and old source videos.</p>
                </span>
              </span>
            }
          >
            <div className="settings-row">
              <div className="settings-row-copy">
                <p className="settings-row-label">Delete old downloaded sources</p>
                <p className="settings-row-hint">
                  Finished clips always stay. Sources older than this many days are removed during cleanup.
                </p>
              </div>
              <div className="settings-row-control is-narrow">
                <Select
                  value={String(form.autoDeleteBasesDays)}
                  onChange={(value) => set('autoDeleteBasesDays', Number(value))}
                >
                  <option value="0">Never</option>
                  <option value="3">After 3 days</option>
                  <option value="7">After 7 days</option>
                  <option value="14">After 14 days</option>
                  <option value="30">After 30 days</option>
                  <option value="90">After 90 days</option>
                </Select>
              </div>
            </div>
            <div className="settings-row">
              <div className="settings-row-copy">
                <p className="settings-row-label">Scratch space</p>
                <p className="settings-row-hint">
                  Temporary audio, work folders and abandoned downloads. Safe to clear at any time.
                </p>
              </div>
              <div className="settings-row-control is-narrow">
                <Button
                  variant="secondary"
                  size="sm"
                  icon={Trash2}
                  loading={toolBusy === 'cleanup'}
                  onClick={() => void runCleanup()}
                  style={{ width: '100%' }}
                >
                  Clean now
                </Button>
              </div>
            </div>
            <p className="settings-note">
              <Check size={12} /> Clip files, thumbnails, caption files and posting kits are never touched by cleanup.
            </p>
          </Panel>

          <div className={cx('settings-save-bar', dirty && 'is-dirty')}>
            <div className={cx('settings-save-note', dirty && 'is-dirty')}>
              {dirty ? <Sparkles size={12} /> : <ShieldCheck size={12} />}
              {dirty ? 'You have unsaved changes.' : 'All settings are stored in data/settings.json.'}
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              <Button variant="ghost" size="sm" icon={Undo2} disabled={!dirty || saving} onClick={discard}>
                Discard
              </Button>
              <Button size="sm" icon={Save} loading={saving} disabled={!dirty} onClick={() => void save()}>
                Save settings
              </Button>
            </div>
          </div>
        </div>

        <aside className="settings-side">
          <div className="system-card">
            <div className="system-card-title">
              System health
              <Badge tone={missingTools.length ? 'red' : 'green'} dot>
                {missingTools.length ? `${missingTools.length} missing` : 'all local'}
              </Badge>
            </div>
            {system ? (
              <div className="bin-list">
                {[
                  { name: 'ffmpeg', bin: system.binaries.ffmpeg, meta: system.binaries.ffmpeg.version },
                  { name: 'ffprobe', bin: system.binaries.ffprobe, meta: system.binaries.ffprobe.version },
                  { name: 'yt-dlp', bin: system.binaries.ytdlp, meta: system.binaries.ytdlp.version },
                  { name: 'whisper.cpp', bin: system.binaries.whisper, meta: system.binaries.whisper.version },
                  {
                    name: 'Speech model',
                    bin: system.binaries.whisperModel,
                    meta: system.binaries.whisperModel.name,
                  },
                  { name: 'Face tracker', bin: system.binaries.yunet, meta: system.binaries.yunet.path?.split(/[\\/]/).pop() },
                  {
                    name: 'Caption fonts',
                    bin: system.binaries.fonts,
                    meta: `${system.binaries.fonts.count} faces`,
                  },
                ].map(({ name, bin, meta }) => (
                  <div key={name} className="bin-row">
                    <span className={cx('bin-dot', statusClass(bin.status))} />
                    <div className="bin-copy">
                      <div className="bin-name">{name}</div>
                      <div className="bin-meta">{bin.status === 'ready' ? 'ready' : bin.status}</div>
                    </div>
                    <span className="bin-version">{meta ?? '—'}</span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="field-help">Reading the local toolkit…</p>
            )}
            <div className="system-actions">
              <Button
                variant="secondary"
                size="sm"
                icon={Wrench}
                loading={toolBusy === 'setup'}
                disabled={Boolean(toolBusy)}
                onClick={() => void runSetup()}
              >
                {toolBusy === 'setup' ? 'Installing tools…' : 'Repair / install toolkit'}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                icon={Zap}
                loading={toolBusy === 'ytdlp'}
                disabled={Boolean(toolBusy)}
                onClick={() => void runYtdlpUpdate()}
              >
                Update yt-dlp
              </Button>
              <Button
                variant="ghost"
                size="sm"
                icon={RefreshCw}
                disabled={Boolean(toolBusy)}
                onClick={() => void refreshSystem()}
              >
                Refresh status
              </Button>
            </div>
            <p className="settings-note">
              <Server size={12} /> Everything runs on 127.0.0.1. No login, no database and no telemetry.
            </p>
          </div>

          <div className="system-card">
            <div className="system-card-title">
              Default look
              <Badge tone="lilac">{preset.name}</Badge>
            </div>
            <div className="preview-stage-inner" style={{ padding: 0, borderRadius: 10 }}>
              <ClipStagePreview
                preset={preset}
                hook={HOOK_PREVIEW[form.defaultHookStyle] || ''}
                hookStyle={form.defaultHookStyle}
                aspect={aspectCss}
                captionScale={form.defaultCaptionScale}
              />
            </div>
            <div className="preview-caption-meta" style={{ marginTop: 8 }}>
              <span>
                <Captions size={11} /> {form.defaultHookStyle === 'none' ? 'no hook' : `${form.defaultHookStyle} hook`}
              </span>
              <span>{form.defaultAspect} · {form.defaultAsrModel}</span>
            </div>
            <div style={{ marginTop: 10 }}>
              <HookCard text={HOOK_PREVIEW[form.defaultHookStyle] || 'Hook off'} style={form.defaultHookStyle} scale="sm" />
            </div>
          </div>

          <div className="system-card">
            <div className="system-card-title">
              Storage
              <Badge tone="neutral">{system ? plural(system.storage.projects, 'project') : '—'}</Badge>
            </div>
            {system ? (
              <>
                <div className="storage-figure">
                  <div className="storage-value">
                    {bytes(system.storage.usedBytes)} <span>in the studio</span>
                  </div>
                  <span className="storage-capacity">{bytes(system.storage.freeBytes)} free</span>
                </div>
                <div className="storage-bar">
                  <span style={{ width: `${Math.max(2, diskPct)}%` }} />
                </div>
                <div className="storage-rows">
                  <div className="storage-row">
                    <span>Data directory</span>
                    <strong title={system.storage.dataDir} style={{ maxWidth: 170, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {system.storage.dataDir}
                    </strong>
                  </div>
                  <div className="storage-row">
                    <span>Drive used</span>
                    <strong>{Math.round(diskPct)}%</strong>
                  </div>
                  <div className="storage-row">
                    <span>Drive capacity</span>
                    <strong>{bytes(system.storage.totalBytes)}</strong>
                  </div>
                </div>
              </>
            ) : (
              <p className="field-help">Measuring disk…</p>
            )}
          </div>

          <div className="system-card">
            <div className="system-card-title">
              This machine
              <Badge tone="neutral">{system ? `${system.cpu.cores} cores` : '—'}</Badge>
            </div>
            <div className="bin-list">
              <div className="bin-row">
                <span className="bin-dot" />
                <div className="bin-copy">
                  <div className="bin-name">CPU</div>
                  <div className="bin-meta" title={system?.cpu.model}>
                    {system?.cpu.model ?? '—'}
                  </div>
                </div>
              </div>
              <div className="bin-row">
                <span className="bin-dot" />
                <div className="bin-copy">
                  <div className="bin-name">Local server</div>
                  <div className="bin-meta">127.0.0.1 · Fastify</div>
                </div>
                <span className="bin-version">v{system?.app.version ?? bootstrap?.version ?? '—'}</span>
              </div>
              <div className="bin-row">
                <span className="bin-dot" />
                <div className="bin-copy">
                  <div className="bin-name">Uptime</div>
                  <div className="bin-meta">Since the last start</div>
                </div>
                <span className="bin-version">{system ? `${Math.floor(system.app.uptime / 60)}m` : '—'}</span>
              </div>
            </div>
            <p className="settings-note">
              <Cpu size={12} /> Built for a modest laptop: whisper on{' '}
              {form.asrThreads > 0 ? `${form.asrThreads} threads` : 'auto threads'} and one render at a time.
            </p>
          </div>
        </aside>
      </div>
    </>
  );
}
