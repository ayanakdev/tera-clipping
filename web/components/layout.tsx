import { useEffect, useState } from 'react';
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom';
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  Film,
  Info,
  LayoutDashboard,
  Menu,
  Plus,
  Radio,
  Settings2,
  Sparkles,
  Target,
  X,
  type LucideIcon,
} from 'lucide-react';
import { useApp } from '@web/state/AppContext';
import { cx, IconButton } from './ui';

interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  end?: boolean;
}

const STUDIO_NAV: NavItem[] = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard, end: true },
  { to: '/new', label: 'New clips', icon: Sparkles },
  { to: '/library', label: 'Library', icon: Film },
];

const GROW_NAV: NavItem[] = [
  { to: '/live', label: 'Live recorder', icon: Radio },
  { to: '/campaigns', label: 'Campaigns', icon: Target },
];

function isActive(path: string, to: string, end?: boolean): boolean {
  if (to === '/') return path === '/';
  return end ? path === to : path === to || path.startsWith(`${to}/`);
}

function Sidebar({ open, onClose }: { open: boolean; onClose: () => void }) {
  const location = useLocation();
  const { system, connected, bootstrap } = useApp();
  const activeLive = bootstrap?.live;
  const gemini = system?.gemini;
  const used = gemini?.usage.requests ?? 0;
  const limit = gemini?.dailyLimit || 40;
  const storage = system?.storage;
  const freeRatio = storage && storage.totalBytes > 0 ? storage.freeBytes / storage.totalBytes : 0;
  const tools = system?.binaries;
  const readyCount = tools
    ? [tools.ffmpeg, tools.ffprobe, tools.ytdlp, tools.whisper, tools.whisperModel, tools.yunet, tools.fonts].filter(
        (tool) => tool.status === 'ready',
      ).length
    : 0;
  const toolsReady = readyCount === 7;

  return (
    <>
      <aside className={cx('sidebar', open && 'is-open')}>
        <Link to="/" className="brand" onClick={onClose} aria-label="TeraClip Studio home">
          <img className="brand-mark" src="/brand/mark.png" alt="" width={38} height={38} />
          <span className="brand-copy">
            <span className="brand-word">
              tera<em>clip</em>
            </span>
            <span className="brand-studio">Studio</span>
          </span>
        </Link>

        <nav className="nav" aria-label="Main">
          <div className="nav-group">
            <p className="nav-label">Studio</p>
            {STUDIO_NAV.map((item) => {
              const Icon = item.icon;
              const active = isActive(location.pathname, item.to, item.end);
              return (
                <NavLink key={item.to} to={item.to} className={cx('nav-item', active && 'is-active')} onClick={onClose}>
                  <Icon size={17} strokeWidth={2.1} />
                  <span>{item.label}</span>
                </NavLink>
              );
            })}
          </div>
          <div className="nav-group">
            <p className="nav-label">Grow</p>
            {GROW_NAV.map((item) => {
              const Icon = item.icon;
              const active = isActive(location.pathname, item.to, item.end);
              return (
                <NavLink key={item.to} to={item.to} className={cx('nav-item', active && 'is-active')} onClick={onClose}>
                  <Icon size={17} strokeWidth={2.1} />
                  <span>{item.label}</span>
                  {item.to === '/live' && activeLive ? <span className="nav-live-dot" title="Recording in progress" /> : null}
                </NavLink>
              );
            })}
          </div>
        </nav>

        <div className="sidebar-foot">
          <div className="local-card">
            <div className="local-card-top">
              <span className={cx('local-dot', !connected && 'is-offline')} />
              {connected ? 'Local engine online' : 'Reconnecting'}
            </div>
            <p className="local-meta">
              {toolsReady ? (
                <>
                  {readyCount}/7 tools ready · {gemini?.configured ? 'Gemini linked' : 'Gemini key missing'}
                </>
              ) : (
                <>
                  {readyCount}/7 tools ready ·{' '}
                  <Link to="/settings" onClick={onClose} style={{ color: 'var(--violet-700)', fontWeight: 600 }}>
                    finish setup
                  </Link>
                </>
              )}
            </p>
            <div className="local-bar" title={`${used} of ${limit} Gemini requests used today`}>
              <span style={{ width: `${Math.max(2, Math.min(100, (used / Math.max(1, limit)) * 100))}%` }} />
            </div>
            <p className="local-meta">
              Gemini {used}/{limit} today · {storage ? `${Math.round(freeRatio * 100)}% disk free` : 'checking disk'}
            </p>
          </div>
          <div className="sidebar-actions">
            <Link to="/settings" className="sidebar-mini-link" onClick={onClose}>
              <Settings2 size={13} />
              Settings
            </Link>
            <a
              className="sidebar-mini-link"
              href="https://github.com/yt-dlp/yt-dlp"
              target="_blank"
              rel="noreferrer"
              title="TeraClip runs locally. No account, no cloud storage."
            >
              <Info size={13} />
              Privacy
            </a>
          </div>
        </div>
      </aside>
      <div className={cx('mobile-scrim', open && 'is-open')} onClick={onClose} aria-hidden />
    </>
  );
}

const PAGE_TITLES: Array<[string, string]> = [
  ['/new', 'New clips'],
  ['/library', 'Library'],
  ['/live', 'Live recorder'],
  ['/campaigns', 'Campaigns'],
  ['/settings', 'Settings'],
  ['/project/', 'Project'],
];

function Topbar({ onMenu }: { onMenu: () => void }) {
  const location = useLocation();
  const { bootstrap, connected, system } = useApp();
  const activeLive = bootstrap?.live;
  const title = PAGE_TITLES.find(([prefix]) => (prefix === '/' ? location.pathname === '/' : location.pathname.startsWith(prefix)))?.[1] || 'Dashboard';
  const setupBusy = system ? Object.values(system.binaries).some((tool) => tool.status === 'downloading') : false;

  return (
    <header className="topbar">
      <div className="topbar-left">
        <IconButton icon={Menu} label="Open navigation" className="menu-toggle" onClick={onMenu} />
        <div className="topbar-crumb">
          <span>Studio</span>
          <ChevronRight size={12} />
          <strong>{title}</strong>
        </div>
      </div>
      <div className="topbar-right">
        {setupBusy ? (
          <span className="status-pill">
            <span className="local-dot" style={{ background: 'var(--amber)' }} />
            Preparing tools
          </span>
        ) : null}
        {activeLive ? (
          <Link to="/live" className={cx('status-pill', 'is-recording')}>
            <span className="local-dot" />
            Recording live
          </Link>
        ) : null}
        <span className="status-pill" title={connected ? 'Connected to the local engine' : 'Waiting for the local engine'}>
          <span className={cx('local-dot', !connected && 'is-offline')} />
          {connected ? 'On this device' : 'Offline'}
        </span>
        <Link to="/new" className="btn btn-primary btn-sm">
          <Plus size={15} strokeWidth={2.4} />
          New clips
        </Link>
      </div>
    </header>
  );
}

export function ToastViewport() {
  const { toasts, dismissToast } = useApp();
  return (
    <div className="toast-viewport" role="status" aria-live="polite">
      {toasts.map((toast) => {
        const Icon = toast.tone === 'success' ? CheckCircle2 : toast.tone === 'error' ? AlertTriangle : Info;
        return (
          <div key={toast.id} className={cx('toast', `is-${toast.tone}`, toast.leaving && 'is-leaving')}>
            <span className="toast-icon">
              <Icon size={15} strokeWidth={2.2} />
            </span>
            <div className="toast-copy">
              <p className="toast-title">{toast.title}</p>
              {toast.message ? <p className="toast-message">{toast.message}</p> : null}
            </div>
            <button className="toast-dismiss" onClick={() => dismissToast(toast.id)} aria-label="Dismiss notification" type="button">
              <X size={14} />
            </button>
          </div>
        );
      })}
    </div>
  );
}

export function AppShell() {
  const [navOpen, setNavOpen] = useState(false);
  const location = useLocation();

  useEffect(() => {
    setNavOpen(false);
    window.scrollTo({ top: 0, behavior: 'auto' });
  }, [location.pathname]);

  return (
    <div className="app-shell">
      <Sidebar open={navOpen} onClose={() => setNavOpen(false)} />
      <div className="app-main">
        <Topbar onMenu={() => setNavOpen(true)} />
        <main className="page">
          <Outlet />
        </main>
      </div>
      <ToastViewport />
    </div>
  );
}

export function BootScreen({ error, onRetry }: { error?: string | null; onRetry?: () => void }) {
  return (
    <div className="boot-screen">
      <div className="boot-mark-wrap">
        <img src="/brand/mark.png" alt="" className="boot-mark" />
      </div>
      {error ? (
        <>
          <h1>Can’t reach the local engine</h1>
          <p>{error}</p>
          <div className="boot-actions">
            <button className="btn btn-primary" onClick={onRetry} type="button">
              Try again
            </button>
            <span className="boot-hint">Run <code>npm run dev</code> in the project folder, then retry.</span>
          </div>
        </>
      ) : (
        <>
          <h1>Opening your studio</h1>
          <p>Starting the local clipping engine…</p>
          <div className="boot-bar">
            <span />
          </div>
        </>
      )}
      <div className="boot-foot">
        <Activity size={13} /> Everything runs on this laptop
      </div>
    </div>
  );
}

export function NotFound() {
  return (
    <div className="empty-state" style={{ marginTop: 40, padding: '70px 30px' }}>
      <span className="empty-icon">
        <Film size={22} />
      </span>
      <h3>That page does not exist</h3>
      <p>The clip you are looking for may have been deleted, or the link is wrong.</p>
      <div className="empty-action">
        <Link to="/" className="btn btn-primary btn-sm">
          Back to dashboard
        </Link>
      </div>
    </div>
  );
}
