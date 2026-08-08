import { useState } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { useConfigRepo } from '../context/ConfigRepoContext';
import { versionDisplay, buildTimeDisplay } from '../version';
import '../styles/global.css';

const navItems = [
  { to: '/dashboard', label: 'Dashboard', icon: '\u25C8' },
  { to: '/files', label: 'Files', icon: '\u25A3' },
  { to: '/backends', label: 'Backends', icon: '\u25C6' },
  { to: '/conflicts', label: 'Conflicts', icon: '\u26A0' },
  { to: '/nodes', label: 'Nodes', icon: '\u25C9' },
];

export default function Layout() {
  const { repo, connected, reconnect, reconnecting } = useConfigRepo();
  const [vConsoleLoaded, setVConsoleLoaded] = useState(false);

  const statuses = repo ? repo.getSyncStatuses() : new Map();
  const anyWatching = Array.from(statuses.values()).some(s => s.watching);

  const toggleVConsole = async () => {
    if (!vConsoleLoaded) {
      const VConsole = (await import('vconsole')).default;
      new VConsole({ theme: 'dark' });
      setVConsoleLoaded(true);
    } else {
      const el = document.getElementById('__vconsole');
      if (el) {
        el.style.display = el.style.display === 'none' ? '' : 'none';
      }
    }
  };

  return (
    <div className="app-layout">
      <div className="topbar">
        <div className="topbar-left">
          <span>zen-fs-config-admin</span>
          {connected && repo && (
            <span className="badge badge-primary">{repo.appId}</span>
          )}
        </div>
        <div className="topbar-right">
          {connected && repo && (
            <>
              <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                node: {repo.nodeId.slice(0, 16)}
              </span>
              <button
                className="btn btn-sm btn-secondary"
                onClick={reconnect}
                disabled={reconnecting}
              >
                {reconnecting ? 'Reconnecting...' : 'Reconnect'}
              </button>
            </>
          )}
        </div>
      </div>

      <div className="sidebar">
        <nav>
          {navItems.map(item => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) => isActive ? 'active' : ''}
            >
              <span className="icon">{item.icon}</span>
              {item.label}
            </NavLink>
          ))}
        </nav>
      </div>

      <div className="main-content">
        <Outlet />
      </div>

      <div className="statusbar">
        <span>
          <span className={`status-dot ${connected ? (anyWatching ? 'syncing' : 'connected') : 'disconnected'}`} />
          {' '}{connected ? (anyWatching ? 'Syncing' : 'Connected') : 'Disconnected'}
        </span>
        {connected && repo && (
          <>
            <span>Sync pairs: {statuses.size}</span>
            <span>App: {repo.appId}</span>
          </>
        )}
        <span style={{ marginLeft: 'auto' }}>{versionDisplay} | {buildTimeDisplay}</span>
        <button
          className="btn btn-sm btn-secondary"
          onClick={toggleVConsole}
          style={{ marginLeft: 8 }}
        >
          Console
        </button>
      </div>
    </div>
  );
}
