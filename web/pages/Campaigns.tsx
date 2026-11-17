import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArrowUpRight,
  BadgeDollarSign,
  Check,
  Eye,
  Megaphone,
  Pause,
  Pencil,
  Play,
  Plus,
  Target,
  Trash2,
  Users,
  Wallet,
} from 'lucide-react';
import type { AspectRatio, Campaign, LibraryClip, PlatformId, Submission } from '@shared/types';
import { PLATFORMS, PLATFORM_BY_ID } from '@shared/platforms';
import { api } from '@web/lib/api';
import { bigNumber, initials, plural, shortDate } from '@web/lib/format';
import { useAsyncData } from '@web/lib/hooks';
import { useApp } from '@web/state/AppContext';
import {
  Badge,
  Button,
  EmptyState,
  Field,
  IconButton,
  Input,
  Modal,
  Panel,
  Segmented,
  Select,
  Skeleton,
  cx,
} from '@web/components/ui';

const CAMPAIGN_COLORS = ['#7c3aed', '#6d28d9', '#db2777', '#ea580c', '#0d9488', '#2563eb', '#111827', '#84cc16'];

const STATUS_LABEL: Record<Campaign['status'], string> = {
  active: 'Active',
  paused: 'Paused',
  ended: 'Ended',
};

const SUBMISSION_STATUS: Submission['status'][] = ['posted', 'approved', 'rejected', 'paid'];

interface CampaignForm {
  name: string;
  brand: string;
  platform: PlatformId;
  status: Campaign['status'];
  link: string;
  color: string;
  payoutPer1k: number;
  minDuration: number;
  maxDuration: number;
  aspect: AspectRatio;
  requiredTags: string;
  mentions: string;
  cta: string;
  notes: string;
}

const EMPTY_CAMPAIGN: CampaignForm = {
  name: '',
  brand: '',
  platform: 'youtube',
  status: 'active',
  link: '',
  color: CAMPAIGN_COLORS[0],
  payoutPer1k: 2,
  minDuration: 20,
  maxDuration: 60,
  aspect: '9:16',
  requiredTags: '',
  mentions: '',
  cta: '',
  notes: '',
};

interface SubmissionForm {
  clipId: string;
  platform: string;
  url: string;
  views: number;
  earnings: number;
  status: Submission['status'];
  postedAt: string;
}

function toLocalInput(iso?: string): string {
  const date = iso ? new Date(iso) : new Date();
  if (!Number.isFinite(date.getTime())) return '';
  const offset = date.getTimezoneOffset();
  return new Date(date.getTime() - offset * 60_000).toISOString().slice(0, 16);
}

function emptySubmission(campaign: Campaign | undefined): SubmissionForm {
  return {
    clipId: '',
    platform: campaign?.platform ?? 'youtube',
    url: '',
    views: 0,
    earnings: 0,
    status: 'posted',
    postedAt: toLocalInput(),
  };
}

function formFromCampaign(campaign: Campaign): CampaignForm {
  return {
    name: campaign.name,
    brand: campaign.brand,
    platform: campaign.platform,
    status: campaign.status,
    link: campaign.link ?? '',
    color: campaign.color,
    payoutPer1k: campaign.payoutPer1k ?? 0,
    minDuration: campaign.rules.minDuration,
    maxDuration: campaign.rules.maxDuration,
    aspect: campaign.rules.aspect,
    requiredTags: campaign.rules.requiredTags.join(', '),
    mentions: campaign.rules.mentions.join(', '),
    cta: campaign.rules.cta,
    notes: campaign.rules.notes,
  };
}

function splitList(value: string): string[] {
  return value
    .split(/[,\n]/)
    .map((part) => part.trim())
    .filter(Boolean)
    .slice(0, 12);
}

function money(value: number | undefined): string {
  const amount = Number(value) || 0;
  return `$${amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export default function Campaigns() {
  const { notify, confirm } = useApp();

  const load = useCallback(async () => {
    const data = await api.campaigns();
    return data;
  }, []);
  const { data, loading, reload } = useAsyncData(load, { events: ['project.updated'], delay: 900 });

  const campaigns = data?.campaigns ?? [];
  const submissions = data?.submissions ?? [];

  const [selectedId, setSelectedId] = useState<string>('');
  const [campaignModal, setCampaignModal] = useState<{ open: boolean; editing: Campaign | null }>({
    open: false,
    editing: null,
  });
  const [campaignForm, setCampaignForm] = useState<CampaignForm>(EMPTY_CAMPAIGN);
  const [savingCampaign, setSavingCampaign] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const [submissionModal, setSubmissionModal] = useState<{ open: boolean; editing: Submission | null }>({
    open: false,
    editing: null,
  });
  const [submissionForm, setSubmissionForm] = useState<SubmissionForm>(emptySubmission(undefined));
  const [savingSubmission, setSavingSubmission] = useState(false);

  const loadLibrary = useCallback(() => api.library(), []);
  const { data: libraryData } = useAsyncData(loadLibrary, { deps: [] });
  const library = libraryData ?? [];

  const selected = useMemo(
    () => campaigns.find((campaign) => campaign.id === selectedId) ?? campaigns[0] ?? null,
    [campaigns, selectedId],
  );

  useEffect(() => {
    if (!campaigns.length) {
      if (selectedId) setSelectedId('');
      return;
    }
    if (!campaigns.some((campaign) => campaign.id === selectedId)) setSelectedId(campaigns[0].id);
  }, [campaigns, selectedId]);

  const campaignSubs = useMemo(
    () => (selected ? submissions.filter((submission) => submission.campaignId === selected.id) : []),
    [submissions, selected],
  );

  const summary = useMemo(() => {
    const active = campaigns.filter((campaign) => campaign.status === 'active').length;
    const views = submissions.reduce((total, submission) => total + (submission.views || 0), 0);
    const earned = submissions.reduce((total, submission) => total + (submission.earnings || 0), 0);
    const estimated = campaigns.reduce((total, campaign) => {
      const campaignViews = submissions
        .filter((submission) => submission.campaignId === campaign.id)
        .reduce((sum, submission) => sum + (submission.views || 0), 0);
      return total + (campaignViews / 1000) * (campaign.payoutPer1k || 0);
    }, 0);
    return { active, views, earned, estimated };
  }, [campaigns, submissions]);

  const selectedViews = campaignSubs.reduce((total, submission) => total + (submission.views || 0), 0);
  const selectedEarned = campaignSubs.reduce((total, submission) => total + (submission.earnings || 0), 0);
  const selectedEstimate = selected ? (selectedViews / 1000) * (selected.payoutPer1k || 0) : 0;

  const clipById = useMemo(() => {
    const map = new Map<string, LibraryClip>();
    for (const entry of library) map.set(entry.clip.id, entry);
    return map;
  }, [library]);

  const openCreate = () => {
    setCampaignForm(EMPTY_CAMPAIGN);
    setCampaignModal({ open: true, editing: null });
  };

  const openEdit = (campaign: Campaign) => {
    setCampaignForm(formFromCampaign(campaign));
    setCampaignModal({ open: true, editing: campaign });
  };

  const saveCampaign = async () => {
    if (savingCampaign) return;
    const name = campaignForm.name.trim();
    const brand = campaignForm.brand.trim();
    if (!name || !brand) {
      notify({ tone: 'error', title: 'Name and brand are required' });
      return;
    }
    if (campaignForm.minDuration >= campaignForm.maxDuration) {
      notify({ tone: 'error', title: 'Duration rules overlap', message: 'The maximum must be longer than the minimum.' });
      return;
    }
    setSavingCampaign(true);
    const payload = {
      name,
      brand,
      platform: campaignForm.platform,
      status: campaignForm.status,
      link: campaignForm.link.trim(),
      color: campaignForm.color,
      payoutPer1k: Math.max(0, Number(campaignForm.payoutPer1k) || 0),
      rules: {
        minDuration: Math.max(3, Math.round(campaignForm.minDuration)),
        maxDuration: Math.max(5, Math.round(campaignForm.maxDuration)),
        aspect: campaignForm.aspect,
        requiredTags: splitList(campaignForm.requiredTags).map((tag) => (tag.startsWith('#') ? tag : `#${tag}`)),
        mentions: splitList(campaignForm.mentions).map((mention) => (mention.startsWith('@') ? mention : `@${mention}`)),
        cta: campaignForm.cta.trim(),
        notes: campaignForm.notes.trim(),
      },
    };
    try {
      const saved = campaignModal.editing
        ? await api.updateCampaign(campaignModal.editing.id, payload)
        : await api.createCampaign(payload);
      notify({
        tone: 'success',
        title: campaignModal.editing ? 'Campaign updated' : 'Campaign created',
        message: `${saved.name} · ${saved.brand}`,
      });
      setSelectedId(saved.id);
      setCampaignModal({ open: false, editing: null });
      void reload();
    } catch (error) {
      notify({ tone: 'error', title: 'Could not save the campaign', message: (error as Error).message });
    } finally {
      setSavingCampaign(false);
    }
  };

  const removeCampaign = async (campaign: Campaign) => {
    const ok = await confirm({
      title: `Delete “${campaign.name}”?`,
      body: 'The campaign and its submission log are removed. Clips already made stay in your library.',
      confirmLabel: 'Delete campaign',
    });
    if (!ok) return;
    setDeletingId(campaign.id);
    try {
      await api.deleteCampaign(campaign.id);
      notify({ tone: 'info', title: 'Campaign deleted' });
      if (selectedId === campaign.id) setSelectedId('');
      void reload();
    } catch (error) {
      notify({ tone: 'error', title: 'Could not delete the campaign', message: (error as Error).message });
    } finally {
      setDeletingId(null);
    }
  };

  const toggleStatus = async (campaign: Campaign) => {
    const next = campaign.status === 'active' ? 'paused' : 'active';
    try {
      await api.updateCampaign(campaign.id, {
        name: campaign.name,
        brand: campaign.brand,
        status: next,
      });
      notify({
        tone: 'success',
        title: next === 'active' ? 'Campaign resumed' : 'Campaign paused',
        message: campaign.name,
      });
      void reload();
    } catch (error) {
      notify({ tone: 'error', title: 'Could not change the campaign', message: (error as Error).message });
    }
  };

  const openSubmission = (editing: Submission | null = null) => {
    if (!selected) return;
    if (!editing) {
      setSubmissionForm(emptySubmission(selected));
    } else {
      setSubmissionForm({
        clipId: editing.clipId,
        platform: editing.platform,
        url: editing.url,
        views: editing.views || 0,
        earnings: editing.earnings || 0,
        status: editing.status,
        postedAt: toLocalInput(editing.postedAt),
      });
    }
    setSubmissionModal({ open: true, editing });
  };

  const saveSubmission = async () => {
    if (!selected || savingSubmission) return;
    const entry = library.find((item) => item.clip.id === submissionForm.clipId);
    const editing = submissionModal.editing;
    if (!editing && !entry) {
      notify({ tone: 'error', title: 'Pick a clip', message: 'Choose one of your finished clips to log.' });
      return;
    }
    if (!submissionForm.url.trim()) {
      notify({ tone: 'error', title: 'Paste the post URL' });
      return;
    }
    setSavingSubmission(true);
    try {
      const postedAt = submissionForm.postedAt ? new Date(submissionForm.postedAt).toISOString() : new Date().toISOString();
      if (editing) {
        await api.updateSubmission(editing.id, {
          platform: submissionForm.platform,
          url: submissionForm.url.trim(),
          views: Math.max(0, Math.round(Number(submissionForm.views) || 0)),
          earnings: Math.max(0, Number(submissionForm.earnings) || 0),
          status: submissionForm.status,
          postedAt,
        });
      } else if (entry) {
        await api.createSubmission({
          clipId: entry.clip.id,
          projectId: entry.clip.projectId,
          campaignId: selected.id,
          platform: submissionForm.platform,
          url: submissionForm.url.trim(),
          views: Math.max(0, Math.round(Number(submissionForm.views) || 0)),
          earnings: Math.max(0, Number(submissionForm.earnings) || 0),
          status: submissionForm.status,
        });
      }
      notify({
        tone: 'success',
        title: editing ? 'Submission updated' : 'Submission logged',
        message: selected.name,
      });
      setSubmissionModal({ open: false, editing: null });
      void reload();
    } catch (error) {
      notify({ tone: 'error', title: 'Could not save the submission', message: (error as Error).message });
    } finally {
      setSavingSubmission(false);
    }
  };

  const removeSubmission = async (submission: Submission) => {
    const ok = await confirm({
      title: 'Remove this submission?',
      body: 'The post log entry is deleted. The clip itself is untouched.',
      confirmLabel: 'Remove',
    });
    if (!ok) return;
    try {
      await api.deleteSubmission(submission.id);
      notify({ tone: 'info', title: 'Submission removed' });
      void reload();
    } catch (error) {
      notify({ tone: 'error', title: 'Could not remove the submission', message: (error as Error).message });
    }
  };

  const quickStatus = async (submission: Submission, status: Submission['status']) => {
    try {
      await api.updateSubmission(submission.id, { status });
      void reload();
    } catch (error) {
      notify({ tone: 'error', title: 'Could not update the status', message: (error as Error).message });
    }
  };

  if (loading && !data) {
    return (
      <>
        <div className="page-head">
          <div>
            <Skeleton style={{ width: 120, height: 12 }} />
            <Skeleton style={{ width: 320, height: 32, marginTop: 12 }} />
            <Skeleton style={{ width: 500, maxWidth: '100%', height: 14, marginTop: 10 }} />
          </div>
        </div>
        <div className="campaign-grid">
          {[0, 1, 2].map((index) => (
            <Skeleton key={index} style={{ height: 210, borderRadius: 14 }} />
          ))}
        </div>
      </>
    );
  }

  return (
    <>
      <div className="page-head">
        <div className="page-head-copy">
          <p className="page-kicker">
            <Megaphone size={13} /> Campaigns
          </p>
          <h1 className="page-title">Get paid for the clips you already make</h1>
          <p className="page-sub">
            Group clips under a brand, keep every submission rule in one place, and track views and payouts without a
            spreadsheet. Nothing leaves this laptop.
          </p>
        </div>
        <div className="head-actions">
          <Button icon={Plus} onClick={openCreate}>
            New campaign
          </Button>
        </div>
      </div>

      {!campaigns.length ? (
        <EmptyState
          icon={Megaphone}
          title="No campaigns yet"
          body="Add a clipping campaign with its payout and rules. Every new clip set can then be attached to it and logged in the submission tracker."
          action={
            <Button icon={Plus} onClick={openCreate}>
              Create your first campaign
            </Button>
          }
        />
      ) : (
        <>
          <div className="campaign-summary">
            <span className="campaign-summary-item">
              <Target size={12} /> <strong>{summary.active}</strong> active campaign
              {summary.active === 1 ? '' : 's'}
            </span>
            <span className="campaign-summary-item">
              <Users size={12} /> <strong>{plural(submissions.length, 'submission')}</strong> logged
            </span>
            <span className="campaign-summary-item">
              <Eye size={12} /> <strong>{bigNumber(summary.views)}</strong> views tracked
            </span>
            <span className="campaign-summary-item">
              <Wallet size={12} /> <strong>{money(summary.earned)}</strong> earned ·{' '}
              <strong>{money(summary.estimated)}</strong> estimated
            </span>
          </div>

          <div className="campaign-grid">
            {campaigns.map((campaign) => {
              const campaignSubmissions = submissions.filter((submission) => submission.campaignId === campaign.id);
              const views = campaignSubmissions.reduce((total, submission) => total + (submission.views || 0), 0);
              const estimate = (views / 1000) * (campaign.payoutPer1k || 0);
              const platform = PLATFORM_BY_ID[campaign.platform];
              return (
                <article
                  key={campaign.id}
                  className={cx('campaign-card', selected?.id === campaign.id && 'is-selected')}
                  style={{ ['--campaign-color' as string]: campaign.color }}
                  onClick={() => setSelectedId(campaign.id)}
                >
                  <div className="campaign-color" />
                  <div className="campaign-card-body">
                    <div className="campaign-card-head">
                      <span className="campaign-logo" style={{ background: campaign.color }}>
                        {initials(campaign.brand) || 'TC'}
                      </span>
                      <div className="campaign-name">
                        <h3>{campaign.name}</h3>
                        <p>
                          {campaign.brand} · {platform?.name ?? campaign.platform}
                        </p>
                      </div>
                      <span className={cx('campaign-status', `is-${campaign.status}`)}>
                        {campaign.status === 'active' ? <Play size={8} /> : campaign.status === 'paused' ? <Pause size={8} /> : null}
                        {STATUS_LABEL[campaign.status]}
                      </span>
                    </div>

                    <div className="campaign-rules">
                      <span className="campaign-rule">
                        <BadgeDollarSign size={10} /> ${(campaign.payoutPer1k || 0).toFixed(2)} / 1k
                      </span>
                      <span className="campaign-rule">
                        {campaign.rules.minDuration}–{campaign.rules.maxDuration}s
                      </span>
                      <span className="campaign-rule">{campaign.rules.aspect}</span>
                      {campaign.rules.requiredTags.length ? (
                        <span className="campaign-rule">#{campaign.rules.requiredTags.length} tags</span>
                      ) : null}
                      {campaign.rules.mentions.length ? (
                        <span className="campaign-rule">@{campaign.rules.mentions.length} mentions</span>
                      ) : null}
                    </div>

                    {campaign.rules.cta ? <p className="campaign-cta">{campaign.rules.cta}</p> : null}

                    <div className="campaign-foot">
                      <div className="campaign-payout">
                        {money(estimate)} <span>est. from {bigNumber(views)} views</span>
                      </div>
                      <div className="campaign-foot-actions" onClick={(event) => event.stopPropagation()}>
                        <Button
                          variant="ghost"
                          size="sm"
                          icon={campaign.status === 'active' ? Pause : Play}
                          onClick={() => void toggleStatus(campaign)}
                          title={campaign.status === 'active' ? 'Pause campaign' : 'Resume campaign'}
                        >
                          {campaign.status === 'active' ? 'Pause' : 'Resume'}
                        </Button>
                        <IconButton icon={Pencil} label="Edit campaign" onClick={() => openEdit(campaign)} />
                        <IconButton
                          icon={Trash2}
                          label="Delete campaign"
                          disabled={deletingId === campaign.id}
                          onClick={() => void removeCampaign(campaign)}
                        />
                      </div>
                    </div>
                  </div>
                </article>
              );
            })}
          </div>

          {selected ? (
            <Panel
              className="campaign-detail"
              eyebrow="Campaign desk"
              title={
                <span className="campaign-detail-title">
                  <span style={{ background: selected.color }}>{initials(selected.brand) || 'TC'}</span>
                  {selected.name}
                </span>
              }
              action={
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  <Button variant="secondary" size="sm" icon={Pencil} onClick={() => openEdit(selected)}>
                    Edit rules
                  </Button>
                  <Button size="sm" icon={Plus} onClick={() => openSubmission()}>
                    Log a submission
                  </Button>
                </div>
              }
            >
              <div className="campaign-summary" style={{ marginBottom: 14 }}>
                <span className="campaign-summary-item">
                  <Eye size={12} /> <strong>{bigNumber(selectedViews)}</strong> views
                </span>
                <span className="campaign-summary-item">
                  <Wallet size={12} /> <strong>{money(selectedEarned)}</strong> earned
                </span>
                <span className="campaign-summary-item">
                  <BadgeDollarSign size={12} /> <strong>{money(selectedEstimate)}</strong> estimated at{' '}
                  {money(selected.payoutPer1k || 0)} / 1k
                </span>
                <span className="campaign-summary-item">
                  <Users size={12} /> <strong>{plural(campaignSubs.length, 'submission')}</strong>
                </span>
              </div>

              <div className="campaign-rules-detail">
                <div className="campaign-rule-detail">
                  <span>Clip length</span>
                  <strong>
                    {selected.rules.minDuration}s – {selected.rules.maxDuration}s
                  </strong>
                </div>
                <div className="campaign-rule-detail">
                  <span>Aspect</span>
                  <strong>{selected.rules.aspect}</strong>
                </div>
                <div className="campaign-rule-detail">
                  <span>Required tags</span>
                  <strong>{selected.rules.requiredTags.length ? selected.rules.requiredTags.join(' ') : 'None'}</strong>
                </div>
                <div className="campaign-rule-detail">
                  <span>Mentions</span>
                  <strong>{selected.rules.mentions.length ? selected.rules.mentions.join(' ') : 'None'}</strong>
                </div>
              </div>

              {selected.rules.cta || selected.rules.notes ? (
                <div className="form-hint" style={{ marginBottom: 16 }}>
                  {selected.rules.cta ? (
                    <p>
                      <strong>Call to action:</strong> {selected.rules.cta}
                    </p>
                  ) : null}
                  {selected.rules.notes ? (
                    <p style={{ marginTop: 4 }}>
                      <strong>Notes:</strong> {selected.rules.notes}
                    </p>
                  ) : null}
                </div>
              ) : null}

              {campaignSubs.length ? (
                <div style={{ overflowX: 'auto' }}>
                  <div className="submission-table" style={{ minWidth: 660 }}>
                    <div className="submission-head">
                      <span>Clip</span>
                      <span>Platform</span>
                      <span>Views</span>
                      <span>Earnings</span>
                      <span>Status</span>
                      <span />
                    </div>
                    {campaignSubs.map((submission) => {
                      const entry = clipById.get(submission.clipId);
                      return (
                        <div key={submission.id} className="submission-row">
                          <div className="submission-clip">
                            <strong>{entry?.clip.title || `Clip ${submission.clipId.slice(-6)}`}</strong>
                            <a
                              href={submission.url}
                              target="_blank"
                              rel="noreferrer"
                              title={submission.url}
                            >
                              {shortDate(submission.postedAt)} · open post <ArrowUpRight size={9} />
                            </a>
                          </div>
                          <span style={{ color: 'var(--muted)' }}>
                            {PLATFORM_BY_ID[submission.platform as PlatformId]?.name ?? submission.platform}
                          </span>
                          <span className="submission-num">{bigNumber(submission.views || 0)}</span>
                          <span className="submission-num">{money(submission.earnings)}</span>
                          <div className="select-wrap" style={{ width: 110 }}>
                            <select
                              className={cx('submission-status', `is-${submission.status}`)}
                              value={submission.status}
                              onChange={(event) => void quickStatus(submission, event.target.value as Submission['status'])}
                              aria-label="Submission status"
                              style={{ border: 0, cursor: 'pointer', appearance: 'none', paddingRight: 6 }}
                            >
                              {SUBMISSION_STATUS.map((status) => (
                                <option key={status} value={status}>
                                  {status}
                                </option>
                              ))}
                            </select>
                          </div>
                          <div className="submission-actions">
                            <IconButton
                              icon={Pencil}
                              label="Edit submission"
                              onClick={() => openSubmission(submission)}
                            />
                            <IconButton
                              icon={Trash2}
                              label="Remove submission"
                              onClick={() => void removeSubmission(submission)}
                            />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ) : (
                <div className="campaign-empty">
                  <EmptyState
                    icon={Target}
                    title="No posts logged yet"
                    body={`Cut a clip set for ${selected.brand}, post it, then paste the link here to track views and payout.`}
                    action={
                      <Button size="sm" icon={Plus} onClick={() => openSubmission()}>
                        Log the first submission
                      </Button>
                    }
                  />
                </div>
              )}
            </Panel>
          ) : null}
        </>
      )}

      <Modal
        open={campaignModal.open}
        onClose={() => setCampaignModal({ open: false, editing: null })}
        size="lg"
        labelledBy="campaign-form-title"
      >
        <h2 id="campaign-form-title" className="modal-title">
          {campaignModal.editing ? 'Edit campaign' : 'New campaign'}
        </h2>
        <p className="modal-subtitle">
          Everything here is stored on this laptop. Rules are carried into the posting kit so captions, tags and
          mentions stay on brief.
        </p>

        <div style={{ marginTop: 18 }}>
          <div className="form-section">
            <p className="form-section-title">The basics</p>
            <div className="form-grid">
              <Field label="Campaign name">
                <Input
                  value={campaignForm.name}
                  onChange={(event) => setCampaignForm((current) => ({ ...current, name: event.target.value }))}
                  placeholder="Opus Clip partner program"
                  maxLength={90}
                />
              </Field>
              <Field label="Brand / client">
                <Input
                  value={campaignForm.brand}
                  onChange={(event) => setCampaignForm((current) => ({ ...current, brand: event.target.value }))}
                  placeholder="Hormozi"
                  maxLength={60}
                />
              </Field>
              <Field label="Platform">
                <Select
                  value={campaignForm.platform}
                  onChange={(value) =>
                    setCampaignForm((current) => ({ ...current, platform: value as PlatformId }))
                  }
                >
                  {PLATFORMS.filter((platform) => platform.id !== 'upload').map((platform) => (
                    <option key={platform.id} value={platform.id}>
                      {platform.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Status">
                <Segmented
                  className="segmented-wide"
                  value={campaignForm.status}
                  onChange={(value) => setCampaignForm((current) => ({ ...current, status: value }))}
                  options={[
                    { value: 'active', label: 'Active' },
                    { value: 'paused', label: 'Paused' },
                    { value: 'ended', label: 'Ended' },
                  ]}
                />
              </Field>
              <Field label="Campaign link" hint="Optional">
                <Input
                  value={campaignForm.link}
                  onChange={(event) => setCampaignForm((current) => ({ ...current, link: event.target.value }))}
                  placeholder="https://…"
                  spellCheck={false}
                />
              </Field>
              <Field label="Payout per 1k views" hint="Used for estimates only">
                <Input
                  type="number"
                  min={0}
                  step={0.25}
                  value={campaignForm.payoutPer1k}
                  onChange={(event) =>
                    setCampaignForm((current) => ({ ...current, payoutPer1k: Number(event.target.value) }))
                  }
                />
              </Field>
              <Field label="Campaign colour" className="span-2">
                <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap', paddingTop: 2 }}>
                  {CAMPAIGN_COLORS.map((color) => (
                    <button
                      key={color}
                      type="button"
                      aria-label={`Use ${color}`}
                      aria-pressed={campaignForm.color === color}
                      onClick={() => setCampaignForm((current) => ({ ...current, color }))}
                      style={{
                        width: 28,
                        height: 28,
                        borderRadius: 8,
                        background: color,
                        border: campaignForm.color === color ? '2px solid #fff' : '1px solid var(--line)',
                        boxShadow: campaignForm.color === color ? `0 0 0 2px ${color}` : 'none',
                        cursor: 'pointer',
                      }}
                    >
                      {campaignForm.color === color ? <Check size={12} style={{ color: '#fff' }} /> : null}
                    </button>
                  ))}
                </div>
              </Field>
            </div>
          </div>

          <div className="form-section">
            <p className="form-section-title">Clip rules</p>
            <div className="form-grid">
              <Field label="Shortest clip" hint={`${campaignForm.minDuration}s`}>
                <Input
                  type="number"
                  min={3}
                  max={600}
                  value={campaignForm.minDuration}
                  onChange={(event) =>
                    setCampaignForm((current) => ({
                      ...current,
                      minDuration: Math.max(3, Number(event.target.value) || 3),
                    }))
                  }
                />
              </Field>
              <Field label="Longest clip" hint={`${campaignForm.maxDuration}s`}>
                <Input
                  type="number"
                  min={5}
                  max={900}
                  value={campaignForm.maxDuration}
                  onChange={(event) =>
                    setCampaignForm((current) => ({
                      ...current,
                      maxDuration: Math.max(5, Number(event.target.value) || 5),
                    }))
                  }
                />
              </Field>
              <Field label="Aspect ratio">
                <Segmented
                  className="segmented-wide"
                  value={campaignForm.aspect}
                  onChange={(value) => setCampaignForm((current) => ({ ...current, aspect: value }))}
                  options={[
                    { value: '9:16', label: '9:16' },
                    { value: '1:1', label: '1:1' },
                    { value: '16:9', label: '16:9' },
                  ]}
                />
              </Field>
              <Field label="Required hashtags" hint="Comma separated">
                <Input
                  value={campaignForm.requiredTags}
                  onChange={(event) => setCampaignForm((current) => ({ ...current, requiredTags: event.target.value }))}
                  placeholder="#shorts, #clips"
                />
              </Field>
              <Field label="Mentions" hint="Comma separated">
                <Input
                  value={campaignForm.mentions}
                  onChange={(event) => setCampaignForm((current) => ({ ...current, mentions: event.target.value }))}
                  placeholder="@brand, @creator"
                />
              </Field>
              <Field label="Call to action" className="span-2">
                <Input
                  value={campaignForm.cta}
                  onChange={(event) => setCampaignForm((current) => ({ ...current, cta: event.target.value }))}
                  placeholder="Follow for part two"
                  maxLength={160}
                />
              </Field>
              <Field label="Notes" className="span-2">
                <textarea
                  className="input"
                  rows={3}
                  value={campaignForm.notes}
                  onChange={(event) => setCampaignForm((current) => ({ ...current, notes: event.target.value }))}
                  placeholder="Anything a clipper needs to know before posting."
                  maxLength={600}
                />
              </Field>
            </div>
            <p className="form-hint">
              Rule signals feed the posting kit, not the render. Clips can still be any length you like — this is the
              brief for submissions.
            </p>
          </div>
        </div>

        <div className="modal-actions">
          <Button variant="secondary" onClick={() => setCampaignModal({ open: false, editing: null })}>
            Cancel
          </Button>
          <Button icon={Check} loading={savingCampaign} onClick={() => void saveCampaign()}>
            {campaignModal.editing ? 'Save campaign' : 'Create campaign'}
          </Button>
        </div>
      </Modal>

      <Modal
        open={submissionModal.open}
        onClose={() => setSubmissionModal({ open: false, editing: null })}
        size="md"
        labelledBy="submission-form-title"
      >
        <h2 id="submission-form-title" className="modal-title">
          {submissionModal.editing ? 'Edit submission' : 'Log a submission'}
        </h2>
        <p className="modal-subtitle">
          {selected ? `${selected.name} · track the post and its payout.` : 'Track a post against this campaign.'}
        </p>

        <div style={{ display: 'grid', gap: 13, marginTop: 18 }}>
          {!submissionModal.editing ? (
            <Field label="Finished clip" hint={!libraryData ? 'Reading library…' : undefined}>
              <Select
                value={submissionForm.clipId}
                onChange={(value) => {
                  const entry = library.find((item) => item.clip.id === value);
                  setSubmissionForm((current) => ({
                    ...current,
                    clipId: value,
                    platform: entry?.project.platform ?? current.platform,
                  }));
                }}
              >
                <option value="">{!libraryData ? 'Loading clips…' : 'Choose a clip'}</option>
                {library.map((entry) => (
                  <option key={entry.clip.id} value={entry.clip.id}>
                    {entry.clip.title || 'Untitled clip'} · {entry.project.title}
                  </option>
                ))}
              </Select>
            </Field>
          ) : null}

          <div className="form-grid">
            <Field label="Platform">
              <Select
                value={submissionForm.platform}
                onChange={(value) => setSubmissionForm((current) => ({ ...current, platform: value }))}
              >
                {PLATFORMS.filter((platform) => platform.id !== 'upload').map((platform) => (
                  <option key={platform.id} value={platform.id}>
                    {platform.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Status">
              <Select
                value={submissionForm.status}
                onChange={(value) =>
                  setSubmissionForm((current) => ({ ...current, status: value as Submission['status'] }))
                }
              >
                {SUBMISSION_STATUS.map((status) => (
                  <option key={status} value={status}>
                    {status}
                  </option>
                ))}
              </Select>
            </Field>
          </div>

          <Field label="Post URL">
            <Input
              value={submissionForm.url}
              onChange={(event) => setSubmissionForm((current) => ({ ...current, url: event.target.value }))}
              placeholder="https://tiktok.com/@you/video/…"
              spellCheck={false}
            />
          </Field>

          <div className="form-grid">
            <Field label="Views">
              <Input
                type="number"
                min={0}
                value={submissionForm.views}
                onChange={(event) => setSubmissionForm((current) => ({ ...current, views: Number(event.target.value) }))}
              />
            </Field>
            <Field label="Earnings (USD)">
              <Input
                type="number"
                min={0}
                step={0.01}
                value={submissionForm.earnings}
                onChange={(event) =>
                  setSubmissionForm((current) => ({ ...current, earnings: Number(event.target.value) }))
                }
              />
            </Field>
          </div>

          {!submissionModal.editing ? (
            <Field label="Posted at">
              <Input
                type="datetime-local"
                value={submissionForm.postedAt}
                onChange={(event) => setSubmissionForm((current) => ({ ...current, postedAt: event.target.value }))}
              />
            </Field>
          ) : null}

          {submissionForm.clipId ? (
            <div className="tool-note">
              <BadgeDollarSign size={14} />
              <span>
                Estimated payout at {money(selected?.payoutPer1k || 0)} / 1k views:{' '}
                <strong>{money(((Number(submissionForm.views) || 0) / 1000) * (selected?.payoutPer1k || 0))}</strong>
              </span>
            </div>
          ) : null}
        </div>

        <div className="modal-actions">
          <Button variant="secondary" onClick={() => setSubmissionModal({ open: false, editing: null })}>
            Cancel
          </Button>
          <Button icon={Check} loading={savingSubmission} onClick={() => void saveSubmission()}>
            {savingSubmission ? 'Saving…' : submissionModal.editing ? 'Save changes' : 'Log submission'}
          </Button>
        </div>
      </Modal>
    </>
  );
}
