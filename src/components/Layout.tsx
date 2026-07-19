import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useConfigRepo } from '../context/ConfigRepoContext';
import '../styles/global.css';

const navItems = [
  { to: '/dashboard', label: 'Dashboard', icon: '◈' },
  { to: '/files', label: 'Files', icon: '▣' },
  { to: '/backends', label: 'Backends', icon: '◆' },
  { to: '/sync-rules', label: 'Sync Rules', icon: '⇄' },
  { to: '/conflicts', label: 'Conflicts', icon: '⚠' },
  { to: '/nodes', label: 'Nodes', icon: '◉' },
];

export default function Layout() {
  const { repo, connected, disconnect } = useConfigRepo();
  const navigate = useNavigate();

  const handleDisconnect = async () => {
    await disconnect();
    navigate('/connect');
  };

  const statuses = repo ? repo.getSyncStatuses() : new Map();
  const anyWatching = Array.from(statuses.values()).some(s => s.watching);

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
              <button className="btn btn-sm btn-secondary" onClick={handleDisconnect}>
                Disconnect
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
      </div>
    </div>
  );
}