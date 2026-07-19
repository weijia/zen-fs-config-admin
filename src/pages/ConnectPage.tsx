import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useConfigRepo } from '../context/ConfigRepoContext';

export default function ConnectPage() {
  const { connect, connecting, error } = useConfigRepo();
  const navigate = useNavigate();
  const [appId, setAppId] = useState('admin');
  const [backendType, setBackendType] = useState('InMemory');
  const [optionsJson, setOptionsJson] = useState(JSON.stringify({ label: 'admin' }, null, 2));
  const [cacheTtl, setCacheTtl] = useState('60000');
  const [localError, setLocalError] = useState('');

  const handleConnect = async () => {
    setLocalError('');
    if (!appId.trim()) { setLocalError('App ID is required'); return; }

    let parsedOptions: Record<string, unknown>;
    try {
      parsedOptions = JSON.parse(optionsJson);
    } catch {
      setLocalError('Invalid JSON in backend options');
      return;
    }

    try {
      await connect(appId.trim(), {
        primaryBackendId: 'admin-primary',
        backendInfo: { type: backendType, options: parsedOptions },
        cache: { storeType: 'MemoryCacheStore', ttlMs: parseInt(cacheTtl) || 60000 },
      });
      navigate('/dashboard');
    } catch {
      // error is set in context
    }
  };

  return (
    <div className="connect-page">
      <div className="connect-card">
        <h1>zen-fs-config-admin</h1>
        <p className="subtitle">Connect to a config repository</p>

        <div className="form-group">
          <label className="form-label">App ID</label>
          <input
            className="form-input"
            value={appId}
            onChange={e => setAppId(e.target.value)}
            placeholder="admin"
          />
        </div>

        <div className="form-group">
          <label className="form-label">Backend Type</label>
          <select className="form-input" value={backendType} onChange={e => setBackendType(e.target.value)}>
            <option value="InMemory">InMemory</option>
          </select>
          <p className="form-hint">InMemory: data lives in browser memory, lost on refresh</p>
        </div>

        <div className="form-group">
          <label className="form-label">Backend Options (JSON)</label>
          <textarea
            className="form-input"
            rows={4}
            value={optionsJson}
            onChange={e => setOptionsJson(e.target.value)}
            style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}
          />
        </div>

        <div className="form-group">
          <label className="form-label">Cache TTL (ms)</label>
          <input
            className="form-input"
            type="number"
            value={cacheTtl}
            onChange={e => setCacheTtl(e.target.value)}
          />
          <p className="form-hint">0 = always revalidate, 60000 = 60s cache</p>
        </div>

        {(localError || error) && (
          <div className="form-error" style={{ marginBottom: 16, padding: '8px 12px', background: 'var(--danger-bg)', borderRadius: 'var(--radius)' }}>
            {localError || error}
          </div>
        )}

        <button
          className="btn btn-primary"
          style={{ width: '100%', justifyContent: 'center', padding: '10px' }}
          disabled={connecting}
          onClick={handleConnect}
        >
          {connecting ? 'Connecting...' : 'Connect'}
        </button>
      </div>
    </div>
  );
}