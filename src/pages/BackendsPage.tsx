import { useState, useEffect, useCallback } from 'react';
import { useConfigRepo } from '../context/ConfigRepoContext';
import { useSyncTarget } from '../context/SyncTargetContext';
import type { BackendDescriptor, BackendSyncState } from 'zen-fs-config';
import { getBackendTypeDef, getBackendTypes } from '../backend-types';
import { serializeBackend, deserializeBackend } from '../backend-config-string';
import {
  backendConnectionText,
  collectDeclaredBackends,
  describeBackendConnection,
  describeBackendScope,
  scopeCapabilities,
  type DeclaredBackendRow,
} from '../backend-scope';
import { createLogger } from '@richard432/localstorage-logger';

const log = createLogger('admin:backends');

function ConnectionBadge({ row }: { row: Pick<DeclaredBackendRow, 'connection' | 'errorMessage'> }) {
  const color = row.connection === 'connected'
    ? 'var(--success)'
    : row.connection === 'failed'
      ? 'var(--danger)'
      : 'var(--text-muted)';
  return (
    <span title={row.errorMessage} style={{ fontSize: 12, color }}>
      {backendConnectionText(row)}
    </span>
  );
}

export default function BackendsPage() {
  const { repo, reconnect, primaryBackendId } = useConfigRepo();
  const {
    selected,
    selectedOption,
    handle: targetHandle,
    ready: targetReady,
    opening: targetOpening,
    error: targetError,
  } = useSyncTarget();
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
    const def = getBackendTypeDef('Gitee')!;
    const autoId = `${def.type.toLowerCase()}-${Date.now()}`;
    setFormState({ id: autoId, type: 'Gitee', options: { ...def.defaultOptions }, description: '' });
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

    // Close modal immediately
    setEditing(null);
    setIsNew(false);

    if (isNew) {
      if (backends.some(b => b.id === formState.id)) {
        setMessage('Backend ID already exists');
        return;
      }
      // Use the new addBackend API — creates sync pair immediately
      try {
        await repo.addBackend(
          formState.id,
          formState.type,
          formState.options ?? {},
          formState.description,
        );
        setMessage('Replica added, syncing...');
        setTimeout(() => setMessage(''), 3000);
      } catch (err: any) {
        setMessage(`Failed to add: ${err?.message}`);
        setTimeout(() => setMessage(''), 5000);
      }
    } else {
      // Editing existing — use updateBackends + reconnect
      const newBackend: BackendDescriptor = {
        id: formState.id,
        type: formState.type,
        options: formState.options ?? {},
        description: formState.description,
      } as any;
      const updated = backends.map(b => b.id === newBackend.id ? newBackend : b);
      await repo.updateBackends({ version: 1, backends: updated });
      setMessage('Saved, reconnecting...');
      setTimeout(() => setMessage(''), 3000);
      try { await repo.syncMetaToReplicas(); } catch (err: any) {
        log.warn('[BackendsPage] syncMetaToReplicas failed:', err?.message);
      }
      try { await reconnect(); } catch (err: any) {
        log.warn('[BackendsPage] reconnect failed:', err?.message);
      }
    }
    await loadBackends();
  };

  const handleRemove = async (id: string) => {
    if (!repo) return;
    // Use the new removeBackend API — cleans up sync pair automatically
    try {
      await repo.removeBackend(id);
      setMessage(`Removed ${id}`);
      setTimeout(() => setMessage(''), 3000);
    } catch (err: any) {
      // Fallback to old method if removeBackend fails
      log.warn('[BackendsPage] removeBackend failed, using fallback:', err?.message);
      const updated = backends.filter(b => b.id !== id);
      await repo.updateBackends({ version: 1, backends: updated });
      await repo.syncMetaToReplicas();
      await reconnect();
    }
    await loadBackends();
  };

  if (!repo) return <div className="loading">No repo connected</div>;

  const def = getBackendTypeDef(formState.type);
  const scope = describeBackendScope(selected);
  const caps = scopeCapabilities(selected.kind);
  const isDataScope = selected.kind === 'data';
  const scopedRows = isDataScope ? collectDeclaredBackends(targetHandle) : [];
  const configStates: Map<string, BackendSyncState> = repo.getBackendSyncStates();

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title">Backends</h1>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 4 }}>
            当前同步组：<strong>{selectedOption?.label ?? scope.title}</strong>
            {isDataScope && <span className="badge" style={{ marginLeft: 6 }}>只读</span>}
          </div>
        </div>
      </div>
      {message && <div style={{ marginBottom: 16, color: 'var(--success)', fontSize: 13 }}>{message}</div>}

      {isDataScope && (
        <section style={{ marginBottom: 32 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, marginBottom: 6 }}>
            <div>
              <div style={{ fontSize: 15, fontWeight: 600 }}>{scope.title}</div>
              <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{scope.subtitle}</div>
            </div>
            <span className="badge">只读</span>
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 10 }}>
            {scope.sourceNote}
          </div>
          {!targetReady ? (
            <div style={{ fontSize: 13, color: targetError ? 'var(--danger)' : 'var(--text-muted)', padding: '12px 0' }}>
              {targetOpening
                ? '正在打开当前数据组…'
                : targetError
                  ? `打开失败：${targetError}`
                  : '当前数据组尚未打开'}
            </div>
          ) : scopedRows.length === 0 ? (
            <div style={{ fontSize: 13, color: 'var(--text-muted)', padding: '12px 0' }}>
              该组没有声明的后端
            </div>
          ) : (
            <div className="table-wrapper">
              <table>
                <thead><tr><th>ID</th><th>Type</th><th>Description</th><th>Config</th><th>连接状态</th></tr></thead>
                <tbody>
                  {scopedRows.map(b => {
                    const bdef = getBackendTypeDef(b.type);
                    return (
                      <tr key={b.id}>
                        <td style={{ fontFamily: 'var(--font-mono)' }}>{b.id}</td>
                        <td><span style={{ marginRight: 6 }}>{bdef?.icon ?? '?'}</span>{bdef?.label ?? b.type}</td>
                        <td style={{ color: 'var(--text-secondary)' }}>{b.description || '-'}</td>
                        <td style={{ maxWidth: 300, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-muted)' }} title={serializeBackend(b)}>
                          {serializeBackend(b)}
                        </td>
                        <td><ConnectionBadge row={b} /></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      <section>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, marginBottom: 6 }}>
          <div>
            <div style={{ fontSize: 15, fontWeight: 600 }}>
              {isDataScope ? '配置同步组（admin）后端（仓库级）' : '配置同步组（admin）后端'}
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
              {isDataScope ? '与上方数据组无关，仅影响 admin 配置仓' : scope.subtitle}
            </div>
          </div>
          {caps.canAdd && <button className="btn btn-primary" onClick={handleNew}>+ Add Backend</button>}
        </div>
        {!isDataScope && (
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 10 }}>
            {scope.sourceNote}
          </div>
        )}
        <div className="table-wrapper">
          <table>
            <thead><tr><th>ID</th><th>Type</th><th>Description</th><th>Config</th><th>Status</th><th>连接状态</th><th>Actions</th></tr></thead>
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
                      {isPrimary ? (
                        <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>本地主存储</span>
                      ) : (
                        <ConnectionBadge row={describeBackendConnection(configStates.get(b.id))} />
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
              {backends.length === 0 && <tr><td colSpan={7} style={{ textAlign: 'center', color: 'var(--text-muted)' }}>No backends configured</td></tr>}
            </tbody>
          </table>
        </div>
      </section>
      {(editing !== null || isNew) && (
        <div className="modal-overlay" onClick={() => { setEditing(null); setIsNew(false); }}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-title">{isNew ? 'Add Backend' : `Edit: ${editing?.id}`}</div>

            <div className="form-group">
              <label className="form-label">Type</label>
              <select className="form-input" value={formState.type} onChange={e => changeType(e.target.value)} disabled={!isNew}>
                {getBackendTypes().map(bt => <option key={bt.type} value={bt.type}>{bt.icon} {bt.label}</option>)}
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
