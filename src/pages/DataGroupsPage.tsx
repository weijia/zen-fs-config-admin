import { useState, useEffect, useCallback } from 'react';
import { useConfigRepo } from '../context/ConfigRepoContext';
import type { AppDataBackendDescriptor } from 'zen-fs-config';
import { getBackendTypeDef, getBackendTypes } from '../backend-types';
import { createLogger } from '@richard432/localstorage-logger';

const log = createLogger('admin:data-groups');

/** 创建 / 添加后端表单中的一条后端记录。 */
interface BackendDraft {
  id: string;
  type: string;
  options: Record<string, string>;
  description: string;
  accountBackendId: string;
}

function emptyDraft(index: number): BackendDraft {
  const def = getBackendTypeDef('RemoteStorage') ?? getBackendTypes()[0];
  const type = def?.type ?? 'RemoteStorage';
  return {
    id: `${type.toLowerCase()}-${Date.now()}-${index}`,
    type,
    options: { ...(def?.defaultOptions ?? {}) } as Record<string, string>,
    description: '',
    accountBackendId: '',
  };
}

export default function DataGroupsPage() {
  const { repo, dataGroups, dataGroupsLoading, dataGroupsError, refreshDataGroups } = useConfigRepo();

  const [message, setMessage] = useState('');
  const [creating, setCreating] = useState(false);
  const [newGroupId, setNewGroupId] = useState('');
  const [drafts, setDrafts] = useState<BackendDraft[]>([emptyDraft(0)]);

  // 组内加后端
  const [addFor, setAddFor] = useState<string | null>(null);
  const [addDraft, setAddDraft] = useState<BackendDraft | null>(null);

  const [accountBackends, setAccountBackends] = useState<{ id: string; type: string }[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!repo) return;
    repo.listAccountBackends().then(list => {
      setAccountBackends(list.map(b => ({ id: b.id, type: b.type })));
    }).catch(() => setAccountBackends([]));
  }, [repo]);

  const notify = useCallback((msg: string, isError = false) => {
    setMessage(msg);
    if (isError) log.warn(`[DataGroupsPage] ${msg}`);
    setTimeout(() => setMessage(''), 4000);
  }, []);

  // -------------------------------------------------------------------------
  // 创建数据组
  // -------------------------------------------------------------------------

  const openCreate = () => {
    setNewGroupId(`data-${Date.now().toString(36)}`);
    setDrafts([emptyDraft(0)]);
    setCreating(true);
  };

  const updateDraft = (index: number, patch: Partial<BackendDraft>) => {
    setDrafts(prev => prev.map((d, i) => (i === index ? { ...d, ...patch } : d)));
  };

  const changeDraftType = (index: number, type: string) => {
    const def = getBackendTypeDef(type);
    setDrafts(prev => prev.map((d, i) => i === index ? {
      ...d,
      type,
      id: `${type.toLowerCase()}-${Date.now()}-${index}`,
      options: { ...(def?.defaultOptions ?? {}) } as Record<string, string>,
    } : d));
  };

  const toDescriptor = (d: BackendDraft): AppDataBackendDescriptor => {
    const options: Record<string, unknown> = { ...d.options };
    const desc: AppDataBackendDescriptor = {
      id: d.id,
      type: d.type,
      options,
      createdAt: Date.now(),
    };
    if (d.description) desc.description = d.description;
    if (d.accountBackendId) desc.accountBackendId = d.accountBackendId;
    return desc;
  };

  const handleCreate = async () => {
    if (!repo) return;
    const id = newGroupId.trim();
    if (!id) { notify('Group id is required', true); return; }
    if (!drafts.length) { notify('At least one backend is required', true); return; }

    setBusy(true);
    setCreating(false);
    try {
      await repo.createAppDataGroup(id, drafts.map(toDescriptor));
      notify(`Data group "${id}" created`);
      await refreshDataGroups();
    } catch (err: any) {
      notify(`Failed to create: ${err?.message ?? err}`, true);
    } finally {
      setBusy(false);
    }
  };

  // -------------------------------------------------------------------------
  // 删除数据组
  // -------------------------------------------------------------------------

  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);

  const handleRemoveGroup = async (id: string) => {
    if (!repo) return;
    if (confirmRemove !== id) {
      setConfirmRemove(id);
      setTimeout(() => setConfirmRemove(null), 3000);
      return;
    }
    setBusy(true);
    setConfirmRemove(null);
    try {
      await repo.removeAppDataGroup(id);
      notify(`Data group "${id}" removed`);
      await refreshDataGroups();
    } catch (err: any) {
      notify(`Failed to remove: ${err?.message ?? err}`, true);
    } finally {
      setBusy(false);
    }
  };

  // -------------------------------------------------------------------------
  // 组内增删后端
  // -------------------------------------------------------------------------

  const openAddBackend = (groupId: string) => {
    setAddFor(groupId);
    setAddDraft(emptyDraft(0));
  };

  const handleAddBackend = async () => {
    const info = dataGroups.find(g => g.id === addFor);
    if (!info?.group || !addDraft) return;
    setBusy(true);
    const groupId = addFor!;
    setAddFor(null);
    setAddDraft(null);
    try {
      await info.group.addBackend(
        addDraft.id,
        addDraft.type,
        { ...addDraft.options },
        addDraft.description || undefined,
      );
      notify(`Backend "${addDraft.id}" added to "${groupId}"`);
      await refreshDataGroups();
    } catch (err: any) {
      notify(`Failed to add backend: ${err?.message ?? err}`, true);
    } finally {
      setBusy(false);
    }
  };

  const handleRemoveBackend = async (groupId: string, backendId: string) => {
    const info = dataGroups.find(g => g.id === groupId);
    if (!info?.group) return;
    setBusy(true);
    try {
      await info.group.removeBackend(backendId);
      notify(`Backend "${backendId}" removed from "${groupId}"`);
      await refreshDataGroups();
    } catch (err: any) {
      notify(`Failed to remove backend: ${err?.message ?? err}`, true);
    } finally {
      setBusy(false);
    }
  };

  const handleFlush = async (groupId: string) => {
    const info = dataGroups.find(g => g.id === groupId);
    if (!info?.group) return;
    setBusy(true);
    try {
      await info.group.flush();
      notify(`Flushed "${groupId}"`);
    } catch (err: any) {
      notify(`Flush failed: ${err?.message ?? err}`, true);
    } finally {
      setBusy(false);
    }
  };

  if (!repo) return <div className="loading">No repo connected</div>;

  // ---------------------------------------------------------------------------
  // 后端表单（创建组 / 组内加后端共用）
  // ---------------------------------------------------------------------------

  const renderBackendFields = (
    draft: BackendDraft,
    onChange: (patch: Partial<BackendDraft>) => void,
    onTypeChange: (type: string) => void,
    keyPrefix: string,
  ) => {
    const def = getBackendTypeDef(draft.type);
    return (
      <>
        <div className="form-group">
          <label className="form-label">Backend Type</label>
          <select className="form-input" value={draft.type} onChange={e => onTypeChange(e.target.value)}>
            {getBackendTypes().map(bt => <option key={bt.type} value={bt.type}>{bt.icon} {bt.label}</option>)}
          </select>
        </div>

        <div className="form-group">
          <label className="form-label">Backend ID</label>
          <input
            className="form-input"
            value={draft.id}
            onChange={e => onChange({ id: e.target.value })}
            style={{ fontFamily: 'var(--font-mono)', fontSize: 13 }}
          />
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          {def?.fields.map(field => (
            <div key={`${keyPrefix}-${field.key}`} className="form-group" style={{ margin: 0 }}>
              <label className="form-label">{field.label} {field.required && <span style={{ color: 'var(--danger)' }}>*</span>}</label>
              {field.type === 'select' ? (
                <select
                  className="form-input"
                  value={draft.options[field.key] ?? ''}
                  onChange={e => onChange({ options: { ...draft.options, [field.key]: e.target.value } })}
                >
                  {field.options?.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              ) : (
                <input
                  className="form-input"
                  type={field.type}
                  value={draft.options[field.key] ?? ''}
                  onChange={e => onChange({ options: { ...draft.options, [field.key]: e.target.value } })}
                  placeholder={field.placeholder}
                />
              )}
            </div>
          ))}
        </div>

        <div className="form-group">
          <label className="form-label">Description</label>
          <input className="form-input" value={draft.description} onChange={e => onChange({ description: e.target.value })} />
        </div>

        {accountBackends.length > 0 && (
          <div className="form-group">
            <label className="form-label">Reuse account from config-sync backend (optional)</label>
            <select
              className="form-input"
              value={draft.accountBackendId}
              onChange={e => onChange({ accountBackendId: e.target.value })}
            >
              <option value="">— none —</option>
              {accountBackends.map(b => <option key={b.id} value={b.id}>{b.id} ({b.type})</option>)}
            </select>
            <p className="form-hint">
              Copies this backend type&apos;s account fields (token / owner / …) from the selected
              config-sync backend, so you only fill in the storage-location fields.
            </p>
          </div>
        )}
      </>
    );
  };

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">Data Groups</h1>
        <button className="btn btn-primary" onClick={openCreate} disabled={busy}>+ New Data Group</button>
      </div>

      {message && <div style={{ marginBottom: 16, color: message.includes('Failed') ? 'var(--danger)' : 'var(--success)', fontSize: 13 }}>{message}</div>}
      {dataGroupsLoading && <div style={{ marginBottom: 16, color: 'var(--text-muted)', fontSize: 13 }}>Activating data groups...</div>}
      {dataGroupsError && <div style={{ marginBottom: 16, color: 'var(--danger)', fontSize: 13 }}>{dataGroupsError}</div>}

      <div className="table-wrapper">
        <table>
          <thead>
            <tr><th>Group ID</th><th>Backends</th><th>Sync</th><th>Actions</th></tr>
          </thead>
          <tbody>
            {dataGroups.map(g => {
              const statuses = g.group ? Array.from(g.group.getSyncStatuses().values()) : [];
              const watching = statuses.filter(s => s.watching).length;
              const backends = g.backends ?? [];
              return (
                <tr key={g.id}>
                  <td style={{ fontFamily: 'var(--font-mono)' }}>
                    {g.id}
                    {g.error && <span className="badge badge-danger" style={{ marginLeft: 6 }}>error</span>}
                  </td>
                  <td>
                    {backends.length === 0 && <span style={{ color: 'var(--text-muted)' }}>—</span>}
                    {backends.map(b => {
                      const bdef = getBackendTypeDef(b.type);
                      return (
                        <div key={b.id} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>{b.id}</span>
                          <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                            {bdef?.icon ?? '?'} {bdef?.label ?? b.type}
                          </span>
                          <button
                            className="btn btn-sm btn-danger"
                            onClick={() => handleRemoveBackend(g.id, b.id)}
                            disabled={busy}
                            title="Remove backend from group"
                          >
                            ✕
                          </button>
                        </div>
                      );
                    })}
                  </td>
                  <td style={{ fontSize: 12 }}>
                    {g.error
                      ? <span style={{ color: 'var(--danger)' }}>{g.error}</span>
                      : <>pairs: {statuses.length} · watching: {watching}</>}
                  </td>
                  <td>
                    <button className="btn btn-sm btn-secondary" onClick={() => openAddBackend(g.id)} disabled={busy || !!g.error}>+ Backend</button>
                    <button className="btn btn-sm btn-secondary" onClick={() => handleFlush(g.id)} disabled={busy || !!g.error} style={{ marginLeft: 4 }}>Flush</button>
                    <button className="btn btn-sm btn-danger" onClick={() => handleRemoveGroup(g.id)} disabled={busy} style={{ marginLeft: 4 }}>
                      {confirmRemove === g.id ? 'Confirm?' : 'Remove'}
                    </button>
                  </td>
                </tr>
              );
            })}
            {dataGroups.length === 0 && (
              <tr><td colSpan={4} style={{ textAlign: 'center', color: 'var(--text-muted)' }}>
                No data groups. Create one to sync app data between its backends.
              </td></tr>
            )}
          </tbody>
        </table>
      </div>

      {/* 创建数据组 */}
      {creating && (
        <div className="modal-overlay" onClick={() => setCreating(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-title">New Data Group</div>

            <div className="form-group">
              <label className="form-label">Group ID <span style={{ color: 'var(--danger)' }}>*</span></label>
              <input
                className="form-input"
                value={newGroupId}
                onChange={e => setNewGroupId(e.target.value)}
                style={{ fontFamily: 'var(--font-mono)', fontSize: 13 }}
              />
              <p className="form-hint">Stored as <code>.meta/app-data-groups/admin/{'{id}'}.json</code></p>
            </div>

            {drafts.map((d, i) => (
              <div key={i} style={{ borderTop: i > 0 ? '1px solid var(--border)' : undefined, paddingTop: i > 0 ? 12 : 0, marginTop: i > 0 ? 12 : 0 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                  <strong style={{ fontSize: 13 }}>Backend {i + 1}</strong>
                  {drafts.length > 1 && (
                    <button className="btn btn-sm btn-danger" onClick={() => setDrafts(prev => prev.filter((_, idx) => idx !== i))}>Remove</button>
                  )}
                </div>
                {renderBackendFields(d, patch => updateDraft(i, patch), type => changeDraftType(i, type), `new-${i}`)}
              </div>
            ))}

            <button className="btn btn-sm btn-secondary" onClick={() => setDrafts(prev => [...prev, emptyDraft(prev.length)])}>
              + Another backend
            </button>

            <div className="modal-actions">
              <button className="btn btn-secondary" onClick={() => setCreating(false)}>Cancel</button>
              <button className="btn btn-primary" onClick={handleCreate} disabled={busy}>Create</button>
            </div>
          </div>
        </div>
      )}

      {/* 组内添加后端 */}
      {addFor && addDraft && (
        <div className="modal-overlay" onClick={() => { setAddFor(null); setAddDraft(null); }}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-title">Add backend to “{addFor}”</div>
            {renderBackendFields(
              addDraft,
              patch => setAddDraft(prev => prev ? { ...prev, ...patch } : prev),
              type => {
                const def = getBackendTypeDef(type);
                setAddDraft(prev => prev ? {
                  ...prev,
                  type,
                  id: `${type.toLowerCase()}-${Date.now()}`,
                  options: { ...(def?.defaultOptions ?? {}) } as Record<string, string>,
                } : prev);
              },
              'add',
            )}
            <div className="modal-actions">
              <button className="btn btn-secondary" onClick={() => { setAddFor(null); setAddDraft(null); }}>Cancel</button>
              <button className="btn btn-primary" onClick={handleAddBackend} disabled={busy}>Add</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
