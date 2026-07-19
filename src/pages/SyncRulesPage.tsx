import { useState, useEffect, useCallback } from 'react';
import { useConfigRepo } from '../context/ConfigRepoContext';
import type { SyncRule, SyncRulesMeta } from 'zen-fs-config';
import { ConflictStrategy, SyncDirection } from 'zen-fs-sync';

export default function SyncRulesPage() {
  const { repo } = useConfigRepo();
  const [rules, setRules] = useState<SyncRule[]>([]);
  const [editing, setEditing] = useState<SyncRule | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [form, setForm] = useState<Partial<SyncRule>>({});
  const [backendIds, setBackendIds] = useState<string[]>([]);

  const loadData = useCallback(async () => {
    if (!repo) return;
    try {
      const [rulesMeta, backendsMeta] = await Promise.all([
        repo.getSyncRules(),
        repo.getBackends(),
      ]);
      setRules(rulesMeta?.rules ?? []);
      setBackendIds(backendsMeta?.backends.map(b => b.id) ?? []);
    } catch { /* files don't exist */ }
  }, [repo]);

  useEffect(() => { loadData(); }, [loadData]);

  const handleEdit = (r: SyncRule) => { setEditing(r); setIsNew(false); setForm({ ...r }); };
  const handleNew = () => { setEditing(null); setIsNew(true); setForm({ prefix: '', direction: SyncDirection.OneWay, conflictStrategy: ConflictStrategy.SourceWins, replicas: [] }); };

  const handleSave = async () => {
    if (!repo || !form.prefix) return;
    const newRule: SyncRule = { prefix: form.prefix, direction: form.direction!, conflictStrategy: form.conflictStrategy, replicas: form.replicas };
    let updated: SyncRule[];
    if (isNew) { updated = [...rules, newRule]; } else { updated = rules.map(r => r.prefix === newRule.prefix ? newRule : r); }
    const meta: SyncRulesMeta = { version: 1, rules: updated };
    await repo.updateSyncRules(meta);
    setEditing(null); setIsNew(false);
    await loadData();
  };

  const handleDelete = async (prefix: string) => {
    if (!repo) return;
    const updated = rules.filter(r => r.prefix !== prefix);
    const meta: SyncRulesMeta = { version: 1, rules: updated };
    await repo.updateSyncRules(meta);
    await loadData();
  };

  const toggleReplica = (id: string) => {
    const current = form.replicas ?? [];
    const next = current.includes(id) ? current.filter(r => r !== id) : [...current, id];
    setForm({ ...form, replicas: next });
  };

  if (!repo) return <div className="loading">No repo connected</div>;

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">Sync Rules</h1>
        <button className="btn btn-primary" onClick={handleNew}>+ Add Rule</button>
      </div>

      <div className="table-wrapper">
        <table>
          <thead>
            <tr><th>Prefix</th><th>Direction</th><th>Conflict Strategy</th><th>Replicas</th><th>Actions</th></tr>
          </thead>
          <tbody>
            {rules.map(r => (
              <tr key={r.prefix}>
                <td style={{ fontFamily: 'var(--font-mono)' }}>{r.prefix}</td>
                <td><span className={`badge ${r.direction === 'none' ? 'badge-warning' : r.direction === 'bi-directional' ? 'badge-primary' : 'badge-success'}`}>{r.direction}</span></td>
                <td>{r.conflictStrategy ?? '-'}</td>
                <td style={{ fontSize: 12 }}>{r.replicas?.join(', ') ?? '-'}</td>
                <td>
                  <button className="btn btn-sm btn-secondary" onClick={() => handleEdit(r)}>Edit</button>
                  <button className="btn btn-sm btn-danger" onClick={() => handleDelete(r.prefix)} style={{ marginLeft: 4 }}>Delete</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {(editing !== null || isNew) && (
        <div className="modal-overlay" onClick={() => { setEditing(null); setIsNew(false); }}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-title">{isNew ? 'Add Rule' : `Edit: ${editing?.prefix}`}</div>
            <div className="form-group">
              <label className="form-label">Prefix</label>
              <input className="form-input" value={form.prefix ?? ''} onChange={e => setForm({ ...form, prefix: e.target.value })} placeholder="/my-app/" disabled={!isNew} />
            </div>
            <div className="form-group">
              <label className="form-label">Direction</label>
              <select className="form-input" value={form.direction ?? SyncDirection.OneWay} onChange={e => setForm({ ...form, direction: e.target.value as any })}>
                <option value={SyncDirection.OneWay}>one-way</option>
                <option value={SyncDirection.BiDirectional}>bi-directional</option>
                <option value="none">none</option>
              </select>
            </div>
            {String(form.direction) !== 'none' && (
              <>
                <div className="form-group">
                  <label className="form-label">Conflict Strategy</label>
                  <select className="form-input" value={form.conflictStrategy ?? ConflictStrategy.SourceWins} onChange={e => setForm({ ...form, conflictStrategy: e.target.value as any })}>
                    <option value={ConflictStrategy.SourceWins}>source-wins</option>
                    <option value={ConflictStrategy.TargetWins}>target-wins</option>
                    <option value={ConflictStrategy.Merge}>merge</option>
                  </select>
                </div>
                <div className="form-group">
                  <label className="form-label">Replicas</label>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                    {backendIds.map(id => (
                      <label key={id} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 13, cursor: 'pointer' }}>
                        <input
                          type="checkbox"
                          checked={(form.replicas ?? []).includes(id)}
                          onChange={() => toggleReplica(id)}
                        />
                        {id}
                      </label>
                    ))}
                  </div>
                </div>
              </>
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