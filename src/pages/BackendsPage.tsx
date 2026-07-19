import { useState, useEffect, useCallback } from 'react';
import { useConfigRepo } from '../context/ConfigRepoContext';
import type { BackendDescriptor, BackendsMeta } from 'zen-fs-config';

export default function BackendsPage() {
  const { repo } = useConfigRepo();
  const [backends, setBackends] = useState<BackendDescriptor[]>([]);
  const [editing, setEditing] = useState<BackendDescriptor | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [formState, setFormState] = useState<Partial<BackendDescriptor>>({});
  const [message, setMessage] = useState('');

  const loadBackends = useCallback(async () => {
    if (!repo) return;
    try {
      const raw = await repo.fs.promises.readFile('/.meta/backends.json', 'utf-8');
      const meta: BackendsMeta = JSON.parse(raw);
      setBackends(meta.backends);
    } catch { /* file doesn't exist */ }
  }, [repo]);

  useEffect(() => { loadBackends(); }, [loadBackends]);

  const handleEdit = (b: BackendDescriptor) => { setEditing(b); setIsNew(false); setFormState({ ...b }); };
  const handleNew = () => { setEditing(null); setIsNew(true); setFormState({ id: '', type: 'InMemory', options: { label: '' }, description: '' }); };

  const handleSave = async () => {
    if (!repo || !formState.id || !formState.type) return;
    const newBackend: BackendDescriptor = { id: formState.id, type: formState.type, options: formState.options ?? {}, description: formState.description };
    let updated: BackendDescriptor[];
    if (isNew) {
      if (backends.some(b => b.id === newBackend.id)) { setMessage('Backend ID already exists'); return; }
      updated = [...backends, newBackend];
    } else {
      updated = backends.map(b => b.id === newBackend.id ? newBackend : b);
    }
    const meta: BackendsMeta = { version: 1, backends: updated };
    await repo.fs.promises.writeFile('/.meta/backends.json', JSON.stringify(meta, null, 2));
    setEditing(null); setMessage('Saved'); setTimeout(() => setMessage(''), 2000);
    await loadBackends();
  };

  const handleRemove = async (id: string) => {
    if (!repo) return;
    const updated = backends.filter(b => b.id !== id);
    await repo.fs.promises.writeFile('/.meta/backends.json', JSON.stringify({ version: 1, backends: updated }, null, 2));
    await loadBackends();
  };

  if (!repo) return <div className="loading">No repo connected</div>;

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">Backends</h1>
        <button className="btn btn-primary" onClick={handleNew}>+ Add Backend</button>
      </div>
      {message && <div style={{ marginBottom: 16, color: 'var(--success)', fontSize: 13 }}>{message}</div>}
      <div className="table-wrapper">
        <table>
          <thead><tr><th>ID</th><th>Type</th><th>Description</th><th>Options</th><th>Actions</th></tr></thead>
          <tbody>
            {backends.map(b => (
              <tr key={b.id}>
                <td style={{ fontFamily: 'var(--font-mono)' }}>{b.id}</td>
                <td>{b.type}</td>
                <td style={{ color: 'var(--text-secondary)' }}>{b.description || '-'}</td>
                <td style={{ fontFamily: 'var(--font-mono)', fontSize: 12, maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{JSON.stringify(b.options)}</td>
                <td>
                  <button className="btn btn-sm btn-secondary" onClick={() => handleEdit(b)}>Edit</button>
                  <button className="btn btn-sm btn-danger" onClick={() => handleRemove(b.id)} style={{ marginLeft: 4 }}>Remove</button>
                </td>
              </tr>
            ))}
            {backends.length === 0 && <tr><td colSpan={5} style={{ textAlign: 'center', color: 'var(--text-muted)' }}>No backends configured</td></tr>}
          </tbody>
        </table>
      </div>
      {(editing !== null || isNew) && (
        <div className="modal-overlay" onClick={() => { setEditing(null); setIsNew(false); }}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-title">{isNew ? 'Add Backend' : `Edit: ${editing?.id}`}</div>
            <div className="form-group"><label className="form-label">ID</label><input className="form-input" value={formState.id ?? ''} onChange={e => setFormState({ ...formState, id: e.target.value })} disabled={!isNew} /></div>
            <div className="form-group"><label className="form-label">Type</label><input className="form-input" value={formState.type ?? ''} onChange={e => setFormState({ ...formState, type: e.target.value })} /></div>
            <div className="form-group"><label className="form-label">Options (JSON)</label><textarea className="form-input" rows={5} value={JSON.stringify(formState.options ?? {}, null, 2)} onChange={e => { try { setFormState({ ...formState, options: JSON.parse(e.target.value) }); } catch { /* ignore */ } }} style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }} /></div>
            <div className="form-group"><label className="form-label">Description</label><input className="form-input" value={formState.description ?? ''} onChange={e => setFormState({ ...formState, description: e.target.value })} /></div>
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