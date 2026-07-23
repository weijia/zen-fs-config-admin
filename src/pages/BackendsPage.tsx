import { useState, useEffect, useCallback } from 'react';
import { useConfigRepo } from '../context/ConfigRepoContext';
import type { BackendDescriptor, BackendsMeta } from 'zen-fs-config';
import { BACKEND_TYPES, getBackendTypeDef } from '../backend-types';
import { serializeBackend, deserializeBackend } from '../backend-config-string';

export default function BackendsPage() {
  const { repo, reconnect, primaryBackendId } = useConfigRepo();
  const [backends, setBackends] = useState<BackendDescriptor[]>([]);
  const [editing, setEditing] = useState<BackendDescriptor | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [formState, setFormState] = useState<Partial<BackendDescriptor> & { type: string }>({ type: 'InMemory' });
  const [message, setMessage] = useState('');
  const [importStr, setImportStr] = useState('');
  const [importError, setImportError] = useState('');

  const loadBackends = useCallback(async () => {
    if (!repo) return;
    try {
      const meta = await repo.getBackends();
      setBackends(meta?.backends ?? []);
    } catch { /* file doesn't exist */ }
  }, [repo]);

  useEffect(() => { loadBackends(); }, [loadBackends]);

  const handleEdit = (b: BackendDescriptor) => {
    setEditing(b);
    setIsNew(false);
    setFormState({ ...b, type: b.type });
  };

  const handleNew = () => {
    setEditing(null);
    setIsNew(true);
    setImportStr('');
    setImportError('');
    const def = getBackendTypeDef('IndexedDB')!;
    const autoId = `${def.type.toLowerCase()}-${Date.now()}`;
    setFormState({ id: autoId, type: 'IndexedDB', options: { ...def.defaultOptions }, description: '' });
  };

  const changeType = (type: string) => {
    const def = getBackendTypeDef(type);
    const autoId = isNew ? `${type.toLowerCase()}-${Date.now()}` : (formState.id ?? '');
    setFormState({
      ...formState,
      id: autoId,
      type,
      options: def ? { ...def.defaultOptions } : {},
    });
  };

  const updateOption = (key: string, value: string) => {
    setFormState({
      ...formState,
      options: { ...(formState.options ?? {}), [key]: value },
    });
  };

  const handleImport = () => {
    setImportError('');
    const parsed = deserializeBackend(importStr.trim());
    if (!parsed || !parsed.type || !parsed.id) {
      setImportError('Invalid format. Expected: type:id:key=value,key=value');
      return;
    }
    const def = getBackendTypeDef(parsed.type);
    if (!def) {
      setImportError(`Unknown backend type: ${parsed.type}`);
      return;
    }
    setFormState({
      type: parsed.type,
      id: parsed.id,
      options: parsed.options ?? { ...def.defaultOptions },
      description: parsed.description ?? '',
    });
    setImportStr('');
    setMessage('Imported from string');
    setTimeout(() => setMessage(''), 2000);
  };

  const handleCopy = async (b: BackendDescriptor) => {
    const str = serializeBackend(b);
    try {
      await navigator.clipboard.writeText(str);
      setMessage(`Copied: ${str}`);
      setTimeout(() => setMessage(''), 3000);
    } catch {
      setMessage(`Config: ${str}`);
      setTimeout(() => setMessage(''), 5000);
    }
  };

  const handleToggleEnabled = async (b: BackendDescriptor) => {
    if (!repo || b.id === primaryBackendId) return;
    const enabled = (b as any).enabled === false;
    const updated = backends.map(x => x.id === b.id ? { ...x, enabled } : x);
    await repo.updateBackends({ version: 1, backends: updated });
    await repo.syncMetaToReplicas();
    setMessage(`${b.id} ${enabled ? 'enabled' : 'disabled'}`);
    setTimeout(() => setMessage(''), 2000);
    await loadBackends();
    await reconnect();
  };

  const handleSave = async () => {
    if (!repo || !formState.id || !formState.type) return;
    const newBackend: BackendDescriptor = {
      id: formState.id,
      type: formState.type,
      options: formState.options ?? {},
      description: formState.description,
      enabled: true,
    } as any;
    let updated: BackendDescriptor[];
    if (isNew) {
      if (backends.some(b => b.id === newBackend.id)) {
        setMessage('Backend ID already exists');
        return;
      }
      updated = [...backends, newBackend];
    } else {
      updated = backends.map(b => b.id === newBackend.id ? newBackend : b);
    }
    const meta: BackendsMeta = { version: 1, backends: updated };
    await repo.updateBackends(meta);

    // Immediately sync .meta/ to all replicas so topology propagates
    await repo.syncMetaToReplicas();

    setEditing(null); setMessage('Saved, reconnecting...'); setTimeout(() => setMessage(''), 2000);
    await loadBackends();
    await reconnect();
  };

  const handleRemove = async (id: string) => {
    if (!repo) return;
    const updated = backends.filter(b => b.id !== id);
    await repo.updateBackends({ version: 1, backends: updated });

    // Immediately sync .meta/ to all replicas
    await repo.syncMetaToReplicas();

    await loadBackends();
    await reconnect();
  };

  if (!repo) return <div className="loading">No repo connected</div>;

  const def = getBackendTypeDef(formState.type);

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">Backends</h1>
        <button className="btn btn-primary" onClick={handleNew}>+ Add Backend</button>
      </div>
      {message && <div style={{ marginBottom: 16, color: 'var(--success)', fontSize: 13 }}>{message}</div>}
      <div className="table-wrapper">
        <table>
          <thead><tr><th>ID</th><th>Type</th><th>Description</th><th>Config</th><th>Status</th><th>Actions</th></tr></thead>
          <tbody>
            {backends.map(b => {
              const bdef = getBackendTypeDef(b.type);
              const isPrimary = b.id === primaryBackendId;
              const isEnabled = isPrimary || (b as any).enabled !== false;
              return (
                <tr key={b.id} style={{ opacity: isEnabled ? 1 : 0.5 }}>
                  <td style={{ fontFamily: 'var(--font-mono)' }}>
                    {b.id} {isPrimary && <span className="badge badge-primary" style={{ marginLeft: 4 }}>primary</span>}
                  </td>
                  <td><span style={{ marginRight: 6 }}>{bdef?.icon ?? '?'}</span>{bdef?.label ?? b.type}</td>
                  <td style={{ color: 'var(--text-secondary)' }}>{b.description || '-'}</td>
                  <td style={{ maxWidth: 300, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-muted)' }} title={serializeBackend(b)}>
                    {serializeBackend(b)}
                  </td>
                  <td>
                    {isPrimary ? (
                      <span style={{ fontSize: 12, color: 'var(--success)' }}>always on</span>
                    ) : (
                      <label style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4, fontSize: 12 }}>
                        <input
                          type="checkbox"
                          checked={isEnabled}
                          onChange={() => handleToggleEnabled(b)}
                        />
                        {isEnabled ? 'enabled' : 'disabled'}
                      </label>
                    )}
                  </td>
                  <td>
                    <button className="btn btn-sm btn-secondary" onClick={() => handleCopy(b)} title="Copy config">📋</button>
                    <button className="btn btn-sm btn-secondary" onClick={() => handleEdit(b)} style={{ marginLeft: 4 }}>Edit</button>
                    {!isPrimary && (
                      <button className="btn btn-sm btn-danger" onClick={() => handleRemove(b.id)} style={{ marginLeft: 4 }}>Remove</button>
                    )}
                  </td>
                </tr>
              );
            })}
            {backends.length === 0 && <tr><td colSpan={6} style={{ textAlign: 'center', color: 'var(--text-muted)' }}>No backends configured</td></tr>}
          </tbody>
        </table>
      </div>
      {(editing !== null || isNew) && (
        <div className="modal-overlay" onClick={() => { setEditing(null); setIsNew(false); }}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-title">{isNew ? 'Add Backend' : `Edit: ${editing?.id}`}</div>

            <div className="form-group">
              <label className="form-label">Type</label>
              <select className="form-input" value={formState.type} onChange={e => changeType(e.target.value)} disabled={!isNew}>
                {BACKEND_TYPES.map(bt => <option key={bt.type} value={bt.type}>{bt.icon} {bt.label}</option>)}
              </select>
            </div>

            <div className="form-group">
              <label className="form-label">ID</label>
              <input className="form-input" value={formState.id ?? ''} onChange={e => setFormState({ ...formState, id: e.target.value })} disabled={!isNew} style={{ fontFamily: 'var(--font-mono)', fontSize: 13 }} />
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              {def?.fields.map(field => (
                <div key={field.key} className="form-group" style={{ margin: 0 }}>
                  <label className="form-label">{field.label} {field.required && <span style={{ color: 'var(--danger)' }}>*</span>}</label>
                  {field.type === 'select' ? (
                    <select
                      className="form-input"
                      value={(formState.options as any)?.[field.key] ?? ''}
                      onChange={e => updateOption(field.key, e.target.value)}
                    >
                      {field.options?.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </select>
                  ) : (
                    <input
                      className="form-input"
                      type={field.type}
                      value={(formState.options as any)?.[field.key] ?? ''}
                      onChange={e => updateOption(field.key, e.target.value)}
                      placeholder={field.placeholder}
                    />
                  )}
                </div>
              ))}
            </div>

            <div className="form-group">
              <label className="form-label">Description</label>
              <input className="form-input" value={formState.description ?? ''} onChange={e => setFormState({ ...formState, description: e.target.value })} />
            </div>

            {isNew && (
              <div className="form-group">
                <label className="form-label">Import from config string</label>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input
                    className="form-input"
                    value={importStr}
                    onChange={e => setImportStr(e.target.value)}
                    placeholder="type:id:key=value,key=value"
                    style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}
                  />
                  <button className="btn btn-sm btn-secondary" onClick={handleImport}>Import</button>
                </div>
                <p className="form-hint">Format: type:id:key=value,key=value (e.g. GitHub:my-repo:owner=weijia,repo=zen-fs-config)</p>
                {importError && <div style={{ color: 'var(--danger)', fontSize: 12, marginTop: 4 }}>{importError}</div>}
              </div>
            )}

            <div className="modal-actions">
              <button className="btn btn-secondary" onClick={() => { setEditing(null); setIsNew(false); }}>Cancel</button>
              <button className="btn btn-primary" onClick={handleSave}>Save</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
