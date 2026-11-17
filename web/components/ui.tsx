import {
  useEffect,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ComponentPropsWithRef,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import {
  AlertTriangle,
  Check,
  ChevronDown,
  Copy,
  Loader2,
  X,
  type LucideIcon,
} from 'lucide-react';
import type { PlatformId } from '@shared/types';
import { PLATFORM_BY_ID } from '@shared/platforms';

export function cx(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(' ');
}

export function Spinner({ size = 16, className }: { size?: number; className?: string }) {
  return <Loader2 size={size} className={cx('spin', className)} strokeWidth={2.4} />;
}

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'soft' | 'danger' | 'ink';
type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  icon?: LucideIcon;
  trailing?: LucideIcon;
}

export function Button({
  variant = 'primary',
  size = 'md',
  loading,
  icon: Icon,
  trailing: Trailing,
  className,
  children,
  disabled,
  ...rest
}: ButtonProps) {
  return (
    <button
      className={cx('btn', `btn-${variant}`, `btn-${size}`, className)}
      disabled={disabled || loading}
      {...rest}
    >
      {loading ? <Spinner size={size === 'sm' ? 14 : 16} /> : Icon ? <Icon size={size === 'sm' ? 15 : 17} strokeWidth={2.3} /> : null}
      {children ? <span>{children}</span> : null}
      {Trailing ? <Trailing size={size === 'sm' ? 14 : 16} strokeWidth={2.3} /> : null}
    </button>
  );
}

export function IconButton({
  icon: Icon,
  label,
  className,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { icon: LucideIcon; label: string }) {
  return (
    <button className={cx('icon-btn', className)} aria-label={label} title={label} {...rest}>
      <Icon size={17} strokeWidth={2.2} />
    </button>
  );
}

type BadgeTone = 'neutral' | 'violet' | 'green' | 'amber' | 'red' | 'ink' | 'lilac';

export function Badge({
  children,
  tone = 'neutral',
  dot,
  className,
  style,
}: {
  children: ReactNode;
  tone?: BadgeTone;
  dot?: boolean;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <span className={cx('badge', `badge-${tone}`, className)} style={style}>
      {dot ? <span className="badge-dot" /> : null}
      {children}
    </span>
  );
}

export function ScoreBadge({ score, compact }: { score: number; compact?: boolean }) {
  const rounded = Math.round(score);
  const tone = rounded >= 75 ? 'hot' : rounded >= 55 ? 'warm' : 'cool';
  return (
    <span className={cx('score-badge', `score-${tone}`, compact && 'score-compact')} title={`Viral score ${rounded}/100`}>
      <span className="score-flare" />
      {rounded}
      {compact ? null : <span className="score-suffix">/100</span>}
    </span>
  );
}

const PLATFORM_FALLBACK = {
  short: 'URL',
  color: '#7c3aed',
  soft: '#f4f0ff',
  name: 'Direct link',
};

export function PlatformMark({
  platform,
  size = 32,
  name,
  className,
}: {
  platform: PlatformId;
  size?: number;
  name?: boolean;
  className?: string;
}) {
  const info = PLATFORM_BY_ID[platform] || PLATFORM_FALLBACK;
  return (
    <span className={cx('platform-mark', className)}>
      <span
        className="platform-tile"
        style={{
          width: size,
          height: size,
          background: info.soft,
          color: info.color,
          borderColor: `${info.color}22`,
        }}
        aria-hidden
      >
        {info.short}
      </span>
      {name ? <span className="platform-name">{info.name}</span> : null}
    </span>
  );
}

export function Panel({
  title,
  eyebrow,
  action,
  children,
  className,
  bodyClassName,
  id,
}: {
  title?: ReactNode;
  eyebrow?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
  id?: string;
}) {
  return (
    <section className={cx('panel', className)} id={id}>
      {title || action || eyebrow ? (
        <header className="panel-head">
          <div>
            {eyebrow ? <p className="eyebrow">{eyebrow}</p> : null}
            {title ? <h2 className="panel-title">{title}</h2> : null}
          </div>
          {action ? <div className="panel-action">{action}</div> : null}
        </header>
      ) : null}
      <div className={cx('panel-body', bodyClassName)}>{children}</div>
    </section>
  );
}

export function Field({
  label,
  hint,
  htmlFor,
  children,
  inline,
  className,
}: {
  label: ReactNode;
  hint?: ReactNode;
  htmlFor?: string;
  children: ReactNode;
  inline?: boolean;
  className?: string;
}) {
  return (
    <div className={cx('field', inline && 'field-inline', className)}>
      <div className="field-label-row">
        <label className="field-label" htmlFor={htmlFor}>
          {label}
        </label>
        {hint ? <span className="field-hint">{hint}</span> : null}
      </div>
      {children}
    </div>
  );
}

export function Input({ className, ...rest }: ComponentPropsWithRef<'input'>) {
  return <input {...rest} className={cx('input', className)} />;
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  className,
  ariaLabel,
}: {
  value: T;
  options: Array<{ value: T; label: ReactNode; hint?: string; icon?: LucideIcon }>;
  onChange: (value: T) => void;
  className?: string;
  ariaLabel?: string;
}) {
  return (
    <div className={cx('segmented', className)} role="group" aria-label={ariaLabel}>
      {options.map((option) => {
        const Icon = option.icon;
        return (
          <button
            key={option.value}
            type="button"
            className={cx('segment', value === option.value && 'is-active')}
            aria-pressed={value === option.value}
            title={option.hint}
            onClick={() => onChange(option.value)}
          >
            {Icon ? <Icon size={14} strokeWidth={2.3} /> : null}
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

export function Toggle({
  checked,
  onChange,
  label,
  hint,
  id,
  disabled,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: ReactNode;
  hint?: ReactNode;
  id?: string;
  disabled?: boolean;
}) {
  const generated = useId();
  const target = id || generated;
  return (
    <div className={cx('toggle-row', disabled && 'is-disabled')}>
      <div className="toggle-copy">
        <label htmlFor={target} className="toggle-label">
          {label}
        </label>
        {hint ? <p className="toggle-hint">{hint}</p> : null}
      </div>
      <button
        id={target}
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={typeof label === 'string' ? label : 'Toggle'}
        className={cx('switch', checked && 'is-on')}
        onClick={() => onChange(!checked)}
        disabled={disabled}
      >
        <span className="switch-knob" />
      </button>
    </div>
  );
}

export function Range({
  value,
  min,
  max,
  step = 1,
  onChange,
  suffix,
  label,
  hint,
}: {
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (value: number) => void;
  suffix?: string;
  label?: ReactNode;
  hint?: ReactNode;
}) {
  const progress = max === min ? 0 : ((value - min) / (max - min)) * 100;
  return (
    <div className="range-field">
      {label ? (
        <div className="range-head">
          <span className="field-label">{label}</span>
          <span className="range-value">
            {value}
            {suffix ? <span>{suffix}</span> : null}
          </span>
        </div>
      ) : null}
      <input
        className="range"
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        style={{ ['--range-progress' as string]: `${progress}%` }}
      />
      {hint ? <p className="field-help">{hint}</p> : null}
    </div>
  );
}

export function Select({
  value,
  onChange,
  children,
  className,
  labels,
}: {
  value: string;
  onChange: (value: string) => void;
  children: ReactNode;
  className?: string;
  labels?: boolean;
}) {
  return (
    <div className={cx('select-wrap', labels && 'has-arrow', className)}>
      <select className="input select" value={value} onChange={(event) => onChange(event.target.value)}>
        {children}
      </select>
      <ChevronDown size={15} className="select-arrow" />
    </div>
  );
}

export function Modal({
  open,
  onClose,
  children,
  className,
  labelledBy,
  size = 'md',
  closeLabel = 'Close',
}: {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  className?: string;
  labelledBy?: string;
  size?: 'sm' | 'md' | 'lg' | 'xl';
  closeLabel?: string;
}) {
  const panelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', onKey);
    const timer = window.setTimeout(() => {
      const focusable = panelRef.current?.querySelector<HTMLElement>(
        'input:not([type="hidden"]), textarea, select, button:not([data-close]), [href], [tabindex]:not([tabindex="-1"])',
      );
      focusable?.focus();
    }, 40);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', onKey);
      window.clearTimeout(timer);
    };
  }, [open, onClose]);

  if (!open) return null;

  return createPortal(
    <div className="modal-root" role="presentation">
      <div className="modal-scrim" onClick={onClose} />
      <div
        ref={panelRef}
        className={cx('modal', `modal-${size}`, className)}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
      >
        <button className="modal-close" onClick={onClose} aria-label={closeLabel} data-close type="button">
          <X size={18} />
        </button>
        {children}
      </div>
    </div>,
    document.body,
  );
}

export function ConfirmDialog({
  title,
  body,
  confirmLabel = 'Delete',
  cancelLabel = 'Keep it',
  tone = 'danger',
  onConfirm,
  onCancel,
}: {
  title: string;
  body?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: 'danger' | 'default';
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const titleId = useId();
  return (
    <Modal open onClose={onCancel} size="sm" labelledBy={titleId}>
      <div className={cx('confirm-icon', tone === 'danger' && 'is-danger')}>
        <AlertTriangle size={22} />
      </div>
      <h2 id={titleId} className="modal-title">
        {title}
      </h2>
      {body ? <p className="modal-subtitle">{body}</p> : null}
      <div className="modal-actions">
        <Button variant="secondary" onClick={onCancel}>
          {cancelLabel}
        </Button>
        <Button variant={tone === 'danger' ? 'danger' : 'primary'} onClick={onConfirm}>
          {confirmLabel}
        </Button>
      </div>
    </Modal>
  );
}

export function ProgressBar({
  value,
  tone = 'violet',
  className,
  animated,
}: {
  value: number;
  tone?: 'violet' | 'green' | 'amber' | 'red';
  className?: string;
  animated?: boolean;
}) {
  return (
    <div className={cx('progress', `progress-${tone}`, className)}>
      <span className={cx('progress-fill', animated && 'is-animated')} style={{ width: `${Math.max(1, Math.min(100, value))}%` }} />
    </div>
  );
}

export function EmptyState({
  icon: Icon,
  title,
  body,
  action,
  className,
}: {
  icon?: LucideIcon;
  title: string;
  body?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cx('empty-state', className)}>
      {Icon ? (
        <span className="empty-icon">
          <Icon size={22} strokeWidth={1.9} />
        </span>
      ) : null}
      <h3>{title}</h3>
      {body ? <p>{body}</p> : null}
      {action ? <div className="empty-action">{action}</div> : null}
    </div>
  );
}

export function CopyButton({
  text,
  label = 'Copy',
  variant = 'secondary',
  size = 'sm',
  className,
  onCopied,
}: {
  text: string;
  label?: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
  className?: string;
  onCopied?: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (timer.current) window.clearTimeout(timer.current);
    },
    [],
  );
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const area = document.createElement('textarea');
      area.value = text;
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      document.execCommand('copy');
      area.remove();
    }
    setCopied(true);
    onCopied?.();
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setCopied(false), 1800);
  };
  return (
    <Button variant={variant} size={size} icon={copied ? Check : Copy} className={className} onClick={() => void copy()}>
      {copied ? 'Copied' : label}
    </Button>
  );
}

export function Skeleton({ className, style }: { className?: string; style?: CSSProperties }) {
  return <div className={cx('skeleton', className)} style={style} />;
}
