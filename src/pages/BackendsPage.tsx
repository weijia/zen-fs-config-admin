import { useState, useEffect, useCallback } from 'react';
import { useConfigRepo } from '../context/ConfigRepoContext';
import type { BackendDescriptor, BackendsMeta } from 'zen-fs-config';
import { BACKEND_TYPES, getBackendTypeDef } from '../backend-types';

export default function BackendsPage() {
  const { repo } = useConfigRepo();
  const [backends, setBackends] = useState<BackendDescriptor[]>([]);
  const [editing, setEditing] = useState<BackendDescriptor | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [formState, setFormState] = useState<Partial<BackendDescriptor> & { type: string }>({ type: 'InMemory' });
  const [message, setMessage] = useState('');

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
    const def = getBackendTypeDef('IndexedDB')!;
    setFormState({ id: '', type: 'IndexedDB', options: { ...def.defaultOptions }, description: '' });
  };

  const changeType = (type: string) => {
    const def = getBackendTypeDef(type);
    setFormState({
      ...formState,
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

  const handleSave = async () => {
    if (!repo || !formState.id || !formState.type) return;
    const newBackend: BackendDescriptor = {
      id: formState.id,
      type: formState.type,
      options: formState.options ?? {},
      description: formState.description,
    };
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
    setEditing(null); setMessage('Saved'); setTimeout(() => setMessage(''), 2000);
    await loadBackends();
  };

  const handleRemove = async (id: string) => {
    if (!repo) return;
    const updated = backends.filter(b => b.id !== id);
    await repo.updateBackends({ version: 1, backends: updated });
    await loadBackends();
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
          <thead><tr><th>ID</th><th>Type</th><th>Description</th><th>Actions</th></tr></thead>
          <tbody>
            {backends.map(b => {
              const bdef = getBackendTypeDef(b.type);
              return (
                <tr key={b.id}>
                  <td style={{ fontFamily: 'var(--font-mono)' }}>{b.id}</td>
                  <td><span style={{ marginRight: 6 }}>{bdef?.icon ?? '?'}</span>{bdef?.label ?? b.type}</td>
                  <td style={{ color: 'var(--text-secondary)' }}>{b.description || '-'}</td>
                  <td>
                    <button className="btn btn-sm btn-secondary" onClick={() => handleEdit(b)}>Edit</button>
                    <button className="btn btn-sm btn-danger" onClick={() => handleRemove(b.id)} style={{ marginLeft: 4 }}>Remove</button>
                  </td>
                </tr>
              );
            })}
            {backends.length === 0 && <tr><td colSpan={4} style={{ textAlign: 'center', color: 'var(--text-muted)' }}>No backends configured</td></tr>}
          </tbody>
        </table>
      </div>
      {(editing !== null || isNew) && (
        <div className="modal-overlay" onClick={() => { setEditing(null); setIsNew(false); }}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-title">{isNew ? 'Add Backend' : `Edit: ${editing?.id}`}</div>

            <div className="form-group">
              <label className="form-label">ID</label>
              <input className="form-input" value={formState.id ?? ''} onChange={e => setFormState({ ...formState, id: e.target.value })} disabled={!isNew} />
            </div>

            <div className="form-group">
              <label className="form-label">Type</label>
              <select className="form-input" value={formState.type} onChange={e => changeType(e.target.value)} disabled={!isNew}>
                {BACKEND_TYPES.map(bt => <option key={bt.type} value={bt.type}>{bt.icon} {bt.label}</option>)}
              </select>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              {def?.fields.map(field => (
                <div key={field.key} className="form-group" style={{ margin: 0 }}>
                  <label className="form-label">{field.label} {field.required && <span style={{ color: 'var(--danger)' }}>*</span>}</label>
                  <input
                    className="form-input"
                    type={field.type}
                    value={(formState.options as any)?.[field.key] ?? ''}
                    onChange={e => updateOption(field.key, e.target.value)}
                    placeholder={field.placeholder}
                  />
                </div>
              ))}
            </div>

            <div className="form-group">
              <label className="form-label">Description</label>
              <input className="form-input" value={formState.description ?? ''} onChange={e => setFormState({ ...formState, description: e.target.value })} />
            </div>

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
