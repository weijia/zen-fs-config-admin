import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useConfigRepo } from '../context/ConfigRepoContext';
import type { ConfigRepoOptions, BackendDescriptor, SyncRule } from 'zen-fs-config';
import { BACKEND_TYPES, getBackendTypeDef } from '../backend-types';
import { versionDisplay, buildTimeDisplay } from '../version';

interface BackendEntry {
  id: string;
  type: string;
  options: Record<string, string>;
  isPrimary: boolean;
}

export default function ConnectPage() {
  const { connect, connecting, error } = useConfigRepo();
  const navigate = useNavigate();

  const [appId, setAppId] = useState('admin');
  const [cacheTtl, setCacheTtl] = useState('60000');
  const [localError, setLocalError] = useState('');
  const [backends, setBackends] = useState<BackendEntry[]>([
    { id: 'admin-primary', type: 'IndexedDB', options: { storeName: 'zen-fs-config' }, isPrimary: true },
  ]);

  const addBackend = () => {
    const id = `backend-${Date.now()}`;
    setBackends([...backends, {
      id,
      type: 'IndexedDB',
      options: { ...getBackendTypeDef('IndexedDB')!.defaultOptions },
      isPrimary: false,
    }]);
  };

  const updateBackend = (index: number, updates: Partial<BackendEntry>) => {
    const next = [...backends];
    if (updates.type && updates.type !== next[index].type) {
      const def = getBackendTypeDef(updates.type);
      next[index] = { ...next[index], type: updates.type, options: { ...(def?.defaultOptions ?? {}) } };
    } else {
      next[index] = { ...next[index], ...updates };
    }
    // Handle set primary flag from options
    if ((next[index].options as any)?._setPrimary === 'true') {
      next.forEach((b, i) => { b.isPrimary = i === index; });
      delete (next[index].options as any)._setPrimary;
    }
    setBackends(next);
  };

  const removeBackend = (index: number) => {
    const next = backends.filter((_, i) => i !== index);
    if (next.length > 0 && !next.some(b => b.isPrimary)) {
      next[0].isPrimary = true;
    }
    setBackends(next);
  };

  const handleConnect = async () => {
    setLocalError('');
    if (!appId.trim()) { setLocalError('App ID is required'); return; }

    const primary = backends.find(b => b.isPrimary) ?? backends[0];
    const def = getBackendTypeDef(primary.type);
    const primaryRequired = def?.fields.filter(f => f.required).map(f => f.key) ?? [];
    for (const key of primaryRequired) {
      if (!primary.options[key]?.trim()) {
        setLocalError(`Primary backend missing required field: ${key}`);
        return;
      }
    }

    try {
      const backendDescriptors: Omit<BackendDescriptor, 'description'>[] = backends.map(b => ({
        id: b.id,
        type: b.type,
        options: { ...b.options },
      }));

      const syncRules: SyncRule[] = [
        {
          prefix: `/${appId.trim()}/`,
          direction: 'one-way' as any,
          conflictStrategy: 'source-wins' as any,
          replicas: backends.filter(b => !b.isPrimary).map(b => b.id),
        },
        {
          prefix: '/shared/',
          direction: 'bi-directional' as any,
          conflictStrategy: 'merge' as any,
          replicas: backends.filter(b => !b.isPrimary).map(b => b.id),
        },
        { prefix: '/nodes/', direction: 'none' as any },
        { prefix: '/.meta/', direction: 'none' as any },
      ];


      const options: ConfigRepoOptions = {
        primaryBackendId: primary.id,
        backendInfo: {
          type: primary.type,
          options: { ...primary.options },
        },
        cache: { storeType: 'MemoryCacheStore', ttlMs: parseInt(cacheTtl) || 60000 },
        bootstrap: {
          backends: backendDescriptors,
          syncRules,
        },
      };

      await connect(appId.trim(), options);
      navigate('/dashboard');
    } catch (err: any) {
      setLocalError(err.message || String(err));
    }
  };

  return (
    <div className="connect-page">
      <div className="connect-card" style={{ maxWidth: 640 }}>
        <h1>zen-fs-config-admin</h1>
        <p className="subtitle">Configure backends and connect</p>

        <div className="form-group">
          <label className="form-label">App ID</label>
          <input className="form-input" value={appId} onChange={e => setAppId(e.target.value)} placeholder="admin" />
        </div>

        <div className="form-group">
          <label className="form-label">Cache TTL (ms)</label>
          <input className="form-input" type="number" value={cacheTtl} onChange={e => setCacheTtl(e.target.value)} />
          <p className="form-hint">0 = always revalidate, 60000 = 60s cache</p>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
          <label className="form-label" style={{ margin: 0 }}>Backends</label>
          <button className="btn btn-sm btn-secondary" onClick={addBackend}>+ Add Backend</button>
        </div>

        {backends.map((entry, index) => {
          const def = getBackendTypeDef(entry.type);
          return (
            <div key={entry.id} style={{ background: 'var(--bg-tertiary)', borderRadius: 'var(--radius)', padding: 16, marginBottom: 12, border: entry.isPrimary ? '1px solid var(--accent)' : '1px solid var(--border)' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 20 }}>{def?.icon ?? '?'}</span>
                  <span style={{ fontWeight: 600 }}>{def?.label ?? entry.type}</span>
                  {entry.isPrimary && <span className="badge badge-primary">Primary</span>}
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  {!entry.isPrimary && (
                    <button className="btn btn-sm btn-secondary" onClick={() => updateBackend(index, { isPrimary: true })}>Set Primary</button>
                  )}
                  {backends.length > 1 && <button className="btn btn-sm btn-danger" onClick={() => removeBackend(index)}>Remove</button>}
                </div>
              </div>

              <div style={{ marginBottom: 8, display: 'flex', alignItems: 'center', gap: 8 }}>
                <label className="form-label" style={{ margin: 0, whiteSpace: 'nowrap' }}>Type</label>
                <select className="form-input" value={entry.type} onChange={e => updateBackend(index, { type: e.target.value })} style={{ flex: 1 }}>
                  {BACKEND_TYPES.map(bt => <option key={bt.type} value={bt.type}>{bt.icon} {bt.label}</option>)}
                </select>
                <label className="form-label" style={{ margin: 0, whiteSpace: 'nowrap' }}>ID</label>
                <input className="form-input" value={entry.id} onChange={e => { const next = [...backends]; next[index] = { ...next[index], id: e.target.value }; setBackends(next); }} style={{ flex: 1, fontFamily: 'var(--font-mono)', fontSize: 12 }} />
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                {def?.fields.map(field => (
                  <div key={field.key} className="form-group" style={{ margin: 0 }}>
                    <label className="form-label">{field.label} {field.required && <span style={{ color: 'var(--danger)' }}>*</span>}</label>
                    <input
                      className="form-input"
                      type={field.type}
                      value={entry.options[field.key] ?? ''}
                      onChange={e => updateBackend(index, { options: { ...entry.options, [field.key]: e.target.value } })}
                      placeholder={field.placeholder}
                    />
                  </div>
                ))}
              </div>
            </div>
          );
        })}

        {(localError || error) && (
          <div style={{ margin: '16px 0', padding: '8px 12px', background: 'var(--danger-bg)', borderRadius: 'var(--radius)', color: 'var(--danger)', fontSize: 13 }}>
            {localError || error}
          </div>
        )}

        <button className="btn btn-primary" style={{ width: '100%', justifyContent: 'center', padding: '10px', marginTop: 8 }} disabled={connecting} onClick={handleConnect}>
          {connecting ? 'Connecting...' : 'Connect'}
        </button>
        <div style={{ marginTop: 12, textAlign: 'center', fontSize: 12, color: 'var(--text-muted)' }}>
          {versionDisplay} | {buildTimeDisplay}
        </div>
      </div>
    </div>
  );
}
