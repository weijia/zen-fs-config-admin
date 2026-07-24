import { useState, useMemo, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useConfigRepo } from '../context/ConfigRepoContext';
import type { ConfigRepoOptions } from 'zen-fs-config';
import { getBackendTypeDef, getBackendTypes } from '../backend-types';
import { deserializeBackend } from '../backend-config-string';
import { versionDisplay, buildTimeDisplay } from '../version';

/**
 * ConnectPage — simplified for the new architecture.
 *
 * IndexedDB is always the primary backend (created automatically).
 * This page only lets users optionally add remote replica backends.
 */

export default function ConnectPage() {
  const { connect, connecting, error } = useConfigRepo();
  const navigate = useNavigate();

  const [appId, setAppId] = useState('admin');
  const [cacheTtl, setCacheTtl] = useState('60000');
  const [localError, setLocalError] = useState('');
  const [configString, setConfigString] = useState('');

  // Replica backends (not including the primary IndexedDB which is automatic)
  const [replicas, setReplicas] = useState<{ id: string; type: string; options: Record<string, string> }[]>([]);

  // Real-time parse of config string — adds a replica
  const parsedResult = useMemo(() => {
    const parsed = deserializeBackend(configString);
    if (!parsed) return null;
    return parsed;
  }, [configString]);

  const parseError = useMemo(() => {
    if (!configString.trim()) return '';
    if (!parsedResult) return 'Invalid format. Expected: type:id:key=value,key=value';
    return '';
  }, [configString, parsedResult]);

  // Apply parsed config: add as a replica or update the first replica
  useEffect(() => {
    if (!parsedResult) return;
    setReplicas(prev => {
      if (prev.length === 0) {
        // No replicas yet — add one from the parsed config
        return [{
          id: parsedResult.id,
          type: parsedResult.type,
          options: { ...(parsedResult.options ?? {}) },
        }];
      }
      // Update the first replica
      return prev.map((r, i) => i === 0 ? {
        ...r,
        type: parsedResult.type,
        id: parsedResult.id,
        options: { ...(parsedResult.options ?? {}) },
      } : r);
    });
  }, [parsedResult]);

  const addReplica = () => {
    const id = `backend-${Date.now()}`;
    setReplicas([...replicas, {
      id,
      type: 'Gitee',
      options: { ...getBackendTypeDef('Gitee')!.defaultOptions },
    }]);
  };

  const updateReplica = (index: number, updates: Partial<{ id: string; type: string; options: Record<string, string> }>) => {
    const next = [...replicas];
    if (updates.type && updates.type !== next[index].type) {
      const def = getBackendTypeDef(updates.type);
      next[index] = { ...next[index], type: updates.type, options: { ...(def?.defaultOptions ?? {}) } };
    } else {
      next[index] = { ...next[index], ...updates };
    }
    setReplicas(next);
  };

  const removeReplica = (index: number) => {
    setReplicas(replicas.filter((_, i) => i !== index));
  };

  const handleConnect = async () => {
    setLocalError('');
    if (!appId.trim()) { setLocalError('App ID is required'); return; }

    try {
      // Build options — backendInfo is optional (only if replicas exist)
      const options: ConfigRepoOptions = {
        cache: { storeType: 'MemoryCacheStore', ttlMs: parseInt(cacheTtl) || 60000 },
      };

      // If user added a replica, use the first one as backendInfo
      // (additional replicas can be added later via the Backends page)
      if (replicas.length > 0) {
        const first = replicas[0];
        const def = getBackendTypeDef(first.type);
        const required = def?.fields.filter(f => f.required).map(f => f.key) ?? [];
        for (const key of required) {
          if (!first.options[key]?.trim()) {
            setLocalError(`Replica backend missing required field: ${key}`);
            return;
          }
        }
        options.primaryBackendId = first.id;
        options.backendInfo = {
          type: first.type,
          options: { ...first.options },
        };
      }

      await connect(appId.trim(), options);
      navigate('/dashboard');
    } catch (err: any) {
      setLocalError(err.message || String(err));
    }
  };

  return (
    <div className="connect-page">
      <div className="connect-card" style={{ maxWidth: 680 }}>
        <h1>zen-fs-config-admin</h1>
        <p className="subtitle">Local IndexedDB is always the primary backend. Add remote replicas below.</p>

        {/* Config string input — real-time parse */}
        <div className="form-group">
          <label className="form-label">Config String (optional)</label>
          <input
            className="form-input"
            value={configString}
            onChange={e => setConfigString(e.target.value)}
            placeholder="type:id:key=value,key=value"
            style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}
          />
          <p className="form-hint">
            Paste a config string to auto-fill a replica backend. Format: <code>type:id:key=value,key=value</code>
            <br />Example: <code>Gitee:my-gitee:owner=weijia,repo=zen-fs-config,branch=master</code>
          </p>
          {parseError && (
            <div style={{ color: 'var(--danger)', fontSize: 12, marginTop: 4 }}>{parseError}</div>
          )}
          {parsedResult && (
            <div style={{ color: 'var(--success)', fontSize: 12, marginTop: 4 }}>
              Parsed: {parsedResult.type} / {parsedResult.id}
            </div>
          )}
        </div>

        <div style={{ borderTop: '1px solid var(--border)', margin: '16px 0' }} />

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
          <label className="form-label" style={{ margin: 0 }}>Remote Replicas (optional)</label>
          <button className="btn btn-sm btn-secondary" onClick={addReplica}>+ Add Replica</button>
        </div>

        {/* Primary IndexedDB info */}
        <div style={{ background: 'var(--bg-tertiary)', borderRadius: 'var(--radius)', padding: 16, marginBottom: 12, border: '1px solid var(--accent)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 20 }}>{'\u{1F4BE}'}</span>
            <span style={{ fontWeight: 600 }}>IndexedDB</span>
            <span className="badge badge-primary">Primary (automatic)</span>
          </div>
          <p className="form-hint" style={{ margin: '8px 0 0' }}>
            Local IndexedDB is always the primary backend for fast access. All config operations read/write locally first, then sync to replicas.
          </p>
        </div>

        {replicas.map((entry, index) => {
          const def = getBackendTypeDef(entry.type);
          return (
            <div key={entry.id} style={{ background: 'var(--bg-tertiary)', borderRadius: 'var(--radius)', padding: 16, marginBottom: 12, border: '1px solid var(--border)' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 20 }}>{def?.icon ?? '?'}</span>
                  <span style={{ fontWeight: 600 }}>{def?.label ?? entry.type}</span>
                  <span className="badge">Replica</span>
                </div>
                <button className="btn btn-sm btn-danger" onClick={() => removeReplica(index)}>Remove</button>
              </div>

              <div style={{ marginBottom: 8, display: 'flex', alignItems: 'center', gap: 8 }}>
                <label className="form-label" style={{ margin: 0, whiteSpace: 'nowrap' }}>Type</label>
                <select className="form-input" value={entry.type} onChange={e => updateReplica(index, { type: e.target.value })} style={{ flex: 1 }}>
                  {getBackendTypes().map(bt => <option key={bt.type} value={bt.type}>{bt.icon} {bt.label}</option>)}
                </select>
                <label className="form-label" style={{ margin: 0, whiteSpace: 'nowrap' }}>ID</label>
                <input className="form-input" value={entry.id} onChange={e => updateReplica(index, { id: e.target.value })} style={{ flex: 1, fontFamily: 'var(--font-mono)', fontSize: 12 }} />
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                {def?.fields.map(field => (
                  <div key={field.key} className="form-group" style={{ margin: 0 }}>
                    <label className="form-label">{field.label} {field.required && <span style={{ color: 'var(--danger)' }}>*</span>}</label>
                    {field.type === 'select' ? (
                      <select
                        className="form-input"
                        value={entry.options[field.key] ?? ''}
                        onChange={e => updateReplica(index, { options: { ...entry.options, [field.key]: e.target.value } })}
                      >
                        {field.options?.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                      </select>
                    ) : (
                      <input
                        className="form-input"
                        type={field.type}
                        value={entry.options[field.key] ?? ''}
                        onChange={e => updateReplica(index, { options: { ...entry.options, [field.key]: e.target.value } })}
                        placeholder={field.placeholder}
                      />
                    )}
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

        <div className="form-group">
          <label className="form-label">App ID</label>
          <input className="form-input" value={appId} onChange={e => setAppId(e.target.value)} placeholder="admin" />
        </div>

        <div className="form-group">
          <label className="form-label">Cache TTL (ms)</label>
          <input className="form-input" type="number" value={cacheTtl} onChange={e => setCacheTtl(e.target.value)} />
          <p className="form-hint">0 = always revalidate, 60000 = 60s cache</p>
        </div>

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
