/**
 * 单个 appId 实例的组管理面板。
 *
 * 只做「组管理」：改名、改后端参数、增删后端、复制/导入配置串、删除组。
 * 组内文件浏览仍走 Files 页的只读总览（不在此处挂 fs）。
 */
import { useState, useEffect, useCallback } from 'react';
import type { BackendDescriptor, AppDataBackendDescriptor } from 'zen-fs-config';
import { useRepoInstances } from '../context/RepoInstancesContext';
import { getBackendTypeDef, getBackendTypes } from '../backend-types';
import { serializeBackend, deserializeBackend } from '../backend-config-string';

/** 编辑后端时的表单草稿。 */
interface BackendDraft {
  id: string;
  type: string;
  options: Record<string, string>;
  description: string;
  accountBackendId: string;
}

interface EditorState {
  mode: 'add' | 'edit';
  groupId: string;
  /** 编辑模式下不可变的后端 id。 */
  backendId: string;
  draft: BackendDraft;
}

function emptyDraft(): BackendDraft {
  const def = getBackendTypeDef('RemoteStorage') ?? getBackendTypes()[0];
  const type = def?.type ?? 'RemoteStorage';
  return {
    id: `${type.toLowerCase()}-${Date.now().toString(36)}`,
    type,
    options: { ...(def?.defaultOptions ?? {}) } as Record<string, string>,
    description: '',
    accountBackendId: '',
  };
}

function draftFromDescriptor(b: AppDataBackendDescriptor): BackendDraft {
  const def = getBackendTypeDef(b.type);
  const options: Record<string, string> = { ...(def?.defaultOptions ?? {}) } as Record<string, string>;
  for (const [k, v] of Object.entries(b.options ?? {})) options[k] = String(v);
  return {
    id: b.id,
    type: b.type,
    options,
    description: b.description ?? '',
    accountBackendId: b.accountBackendId ?? '',
  };
}

function draftFromString(str: string): BackendDraft | null {
  const parsed = deserializeBackend(str.trim());
  if (!parsed) return null;
  const def = getBackendTypeDef(parsed.type);
  const options: Record<string, string> = { ...(def?.defaultOptions ?? {}) } as Record<string, string>;
  for (const [k, v] of Object.entries(parsed.options ?? {})) options[k] = v;
  return {
    id: parsed.id,
    type: parsed.type,
    options,
    description: parsed.description ?? '',
    accountBackendId: parsed.accountBackendId ?? '',
  };
}

/** 从引用的配置同步后端复制账号字段（token / owner / …）。 */
function mergeAccountOptions(
  draft: BackendDraft,
  accountBackends: BackendDescriptor[],
): Record<string, unknown> {
  const options: Record<string, unknown> = { ...draft.options };
  if (!draft.accountBackendId) return options;
  const source = accountBackends.find(b => b.id === draft.accountBackendId);
  if (!source) return options;
  const fields = getBackendTypeDef(draft.type)?.accountFields ?? [];
  for (const field of fields) {
    if (source.options?.[field] !== undefined && options[field] === undefined) {
      options[field] = source.options[field];
    }
  }
  return options;
}

export default function AppInstanceManager({ appId, onClose }: { appId: string; onClose: () => void }) {
  const {
    errors,
    getInstance,
    getStatus,
    renameGroup,
    replaceBackend,
    addBackend,
    removeBackend,
    removeGroup,
    flushInstance,
    releaseInstance,
  } = useRepoInstances();

  const instance = getInstance(appId);
  const status = getStatus(appId);

  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [accountBackends, setAccountBackends] = useState<BackendDescriptor[]>([]);
  const [rename, setRename] = useState<{ groupId: string; value: string } | null>(null);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [importStr, setImportStr] = useState('');
  const [importError, setImportError] = useState('');
  const [confirmBackend, setConfirmBackend] = useState<string | null>(null);
  const [confirmGroup, setConfirmGroup] = useState<string | null>(null);
  const [confirmRelease, setConfirmRelease] = useState(false);

  useEffect(() => {
    if (!instance) return;
    instance.repo.listAccountBackends()
      .then(list => setAccountBackends(list))
      .catch(() => setAccountBackends([]));
  }, [instance]);

  const notify = useCallback((msg: string) => {
    setMessage(msg);
    setTimeout(() => setMessage(''), 4000);
  }, []);

  const run = useCallback(async (fn: () => Promise<void>, okText: string): Promise<boolean> => {
    setBusy(true);
    setMessage('');
    try {
      await fn();
      notify(okText);
      return true;
    } catch (err: any) {
      // context 已把具体原因写入 errors[appId]，这里只兜底提示
      setMessage(err?.message ?? String(err));
      return false;
    } finally {
      setBusy(false);
    }
  }, [notify]);

  if (!instance) {
    return (
      <div className="modal-overlay" onClick={onClose}>
        <div className="modal" onClick={e => e.stopPropagation()}>
          <div className="modal-title">实例 {appId}</div>
          <p style={{ color: 'var(--text-muted)', fontSize: 13 }}>实例不存在或已被释放。</p>
          <div className="modal-actions">
            <button className="btn btn-secondary" onClick={onClose}>关闭</button>
          </div>
        </div>
      </div>
    );
  }

  const handleRename = (groupId: string) => {
    if (!rename || rename.groupId !== groupId) return;
    const value = rename.value.trim();
    if (!value) { notify('组名不能为空'); return; }
    void run(() => renameGroup(appId, groupId, value), '改名已保存')
      .then(ok => { if (ok) setRename(null); });
  };

  const handleRemoveGroup = (groupId: string) => {
    if (confirmGroup !== groupId) {
      setConfirmGroup(groupId);
      setTimeout(() => setConfirmGroup(null), 3000);
      return;
    }
    setConfirmGroup(null);
    void run(() => removeGroup(appId, groupId), `数据组「${groupId}」已删除`);
  };

  const handleRemoveBackend = (groupId: string, backendId: string) => {
    const key = `${groupId}/${backendId}`;
    if (confirmBackend !== key) {
      setConfirmBackend(key);
      setTimeout(() => setConfirmBackend(null), 3000);
      return;
    }
    setConfirmBackend(null);
    void run(() => removeBackend(appId, groupId, backendId), `后端「${backendId}」已移除`);
  };

  const openAdd = (groupId: string) => {
    setImportStr('');
    setImportError('');
    setEditor({ mode: 'add', groupId, backendId: '', draft: emptyDraft() });
  };

  const openEdit = (groupId: string, backend: AppDataBackendDescriptor) => {
    setImportStr('');
    setImportError('');
    setEditor({ mode: 'edit', groupId, backendId: backend.id, draft: draftFromDescriptor(backend) });
  };

  const applyImport = () => {
    const draft = draftFromString(importStr);
    if (!draft) {
      setImportError('格式无效，应为 type:id:key=value,key=value,desc=...,accountBackendId=...');
      return;
    }
    setEditor(prev => prev ? { ...prev, draft: { ...draft, id: prev.mode === 'edit' ? prev.backendId : draft.id } } : prev);
    setImportError('');
    setImportStr('');
  };

  const handleEditorSave = () => {
    if (!editor) return;
    const { mode, groupId, backendId, draft } = editor;
    const options = mergeAccountOptions(draft, accountBackends);
    const description = draft.description || undefined;
    const save = mode === 'add'
      ? () => addBackend(appId, groupId, draft.id.trim(), draft.type, options, description)
      : () => replaceBackend(appId, groupId, backendId, draft.type, options, description);
    if (mode === 'add' && !draft.id.trim()) {
      notify('Backend ID 不能为空');
      return;
    }
    void run(save, mode === 'add' ? `后端「${draft.id}」已添加` : `后端「${backendId}」参数已更新`)
      .then(ok => { if (ok) setEditor(null); });
  };

  const handleCopy = (backend: AppDataBackendDescriptor) => {
    const str = serializeBackend(backend);
    try {
      navigator.clipboard.writeText(str).then(
        () => notify(`已复制：${str}`),
        () => notify(`配置串：${str}`),
      );
    } catch {
      notify(`配置串：${str}`);
    }
  };

  const handleFlush = () => {
    void run(() => flushInstance(appId), '已 flush');
  };

  const handleRelease = () => {
    if (!confirmRelease) {
      setConfirmRelease(true);
      setTimeout(() => setConfirmRelease(false), 3000);
      return;
    }
    setBusy(true);
    releaseInstance(appId)
      .then(() => onClose())
      .catch((err: any) => setMessage(err?.message ?? String(err)))
      .finally(() => setBusy(false));
  };

  const error = errors[appId];

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal"
        style={{ maxWidth: 780, width: '92%', maxHeight: '86vh', overflowY: 'auto' }}
        onClick={e => e.stopPropagation()}
      >
        <div className="modal-title">实例管理 · {appId}</div>

        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--text-secondary)', marginBottom: 12 }}>
          <span className="badge badge-primary">{appId}</span>
          <span>远端后端：{instance.backendId}</span>
          <span>已加载组：{status?.groupCount ?? 0}（激活 {status?.activeGroupCount ?? 0}）</span>
          <span>同步对：{status?.pairCount ?? 0} · {status?.watchingCount ? '同步中' : '未在同步'}</span>
          <span style={{ color: 'var(--text-muted)' }}>使用独立实例，可释放</span>
        </div>

        {error && (
          <div style={{ marginBottom: 12, padding: '8px 10px', borderRadius: 6, background: 'var(--bg-tertiary)', color: 'var(--danger)', fontSize: 12 }}>
            {error}
          </div>
        )}
        {message && (
          <div style={{ marginBottom: 12, color: message.includes('失败') ? 'var(--danger)' : 'var(--success)', fontSize: 12 }}>
            {message}
          </div>
        )}

        <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
          <button className="btn btn-sm btn-secondary" onClick={handleFlush} disabled={busy}>Flush</button>
          <button className="btn btn-sm btn-danger" onClick={handleRelease} disabled={busy}>
            {confirmRelease ? '确认释放？' : '释放实例'}
          </button>
        </div>

        {(status?.groupCount ?? 0) === 0 && (
          <p style={{ color: 'var(--text-muted)', fontSize: 13 }}>
            该 appId 下没有已同步的数据组。请在目标应用中创建数据组后等待同步。
          </p>
        )}

        {instance.groups.map(group => (
          <div
            key={group.id}
            style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 12, marginBottom: 12 }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <strong style={{ fontSize: 13 }}>{group.id}</strong>
              {group.name && <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{group.name}</span>}
              {group.error && <span className="badge badge-danger">激活失败</span>}
              <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{(group.backends ?? []).length} 个后端</span>
              {rename?.groupId === group.id ? (
                <div style={{ display: 'flex', gap: 4, marginLeft: 'auto' }}>
                  <input
                    className="form-input"
                    style={{ height: 26, width: 160, fontSize: 12 }}
                    value={rename.value}
                    onChange={e => setRename({ groupId: group.id, value: e.target.value })}
                    placeholder="新的显示名"
                  />
                  <button className="btn btn-sm btn-primary" onClick={() => handleRename(group.id)} disabled={busy}>保存</button>
                  <button className="btn btn-sm btn-secondary" onClick={() => setRename(null)}>取消</button>
                </div>
              ) : (
                <div style={{ display: 'flex', gap: 4, marginLeft: 'auto' }}>
                  <button
                    className="btn btn-sm btn-secondary"
                    onClick={() => setRename({ groupId: group.id, value: group.name ?? '' })}
                    disabled={busy || !!group.error}
                  >
                    改名
                  </button>
                  <button className="btn btn-sm btn-secondary" onClick={() => openAdd(group.id)} disabled={busy || !!group.error}>
                    + 后端
                  </button>
                  <button
                    className="btn btn-sm btn-danger"
                    onClick={() => handleRemoveGroup(group.id)}
                    disabled={busy}
                  >
                    {confirmGroup === group.id ? '确认删除？' : '删除组'}
                  </button>
                </div>
              )}
            </div>

            {group.error && (
              <p style={{ color: 'var(--danger)', fontSize: 12, marginTop: 8 }}>{group.error}</p>
            )}

            <div style={{ marginTop: 10 }}>
              {(group.backends ?? []).length === 0 && (
                <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>暂无后端</span>
              )}
              {(group.backends ?? []).map(backend => {
                const def = getBackendTypeDef(backend.type);
                const key = `${group.id}/${backend.id}`;
                const state = (group.backendStates ?? []).find(s => s.backendId === backend.id);
                return (
                  <div key={backend.id} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6, fontSize: 12 }}>
                    <span style={{ fontFamily: 'var(--font-mono)' }}>{backend.id}</span>
                    <span style={{ color: 'var(--text-secondary)' }}>{def?.icon ?? '?'} {def?.label ?? backend.type}</span>
                    {backend.accountBackendId && (
                      <span className="badge" style={{ fontSize: 10, padding: '1px 6px' }}>账号复用：{backend.accountBackendId}</span>
                    )}
                    {!state?.pairId && (
                      <span
                        className="badge badge-danger"
                        style={{ fontSize: 10, padding: '1px 6px' }}
                        title={state?.error?.message ?? '未建立同步对'}
                      >
                        未连接
                      </span>
                    )}
                    <button className="btn btn-sm btn-secondary" onClick={() => handleCopy(backend)} title="复制配置串">⧉</button>
                    <button className="btn btn-sm btn-secondary" onClick={() => openEdit(group.id, backend)} disabled={busy}>改参数</button>
                    <button className="btn btn-sm btn-danger" onClick={() => handleRemoveBackend(group.id, backend.id)} disabled={busy}>
                      {confirmBackend === key ? '确认？' : '✕'}
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        ))}

        {editor && (
          <div
            className="modal-overlay"
            style={{ position: 'fixed', zIndex: 20 }}
            onClick={e => { e.stopPropagation(); setEditor(null); }}
          >
            <div className="modal" style={{ maxWidth: 640, width: '90%', maxHeight: '84vh', overflowY: 'auto' }} onClick={e => e.stopPropagation()}>
              <div className="modal-title">
                {editor.mode === 'add' ? `向「${editor.groupId}」添加后端` : `修改后端「${editor.backendId}」参数`}
              </div>

              <div className="form-group">
                <label className="form-label">Backend Type</label>
                <select
                  className="form-input"
                  value={editor.draft.type}
                  onChange={e => {
                    const type = e.target.value;
                    const def = getBackendTypeDef(type);
                    setEditor(prev => prev ? {
                      ...prev,
                      draft: {
                        ...prev.draft,
                        type,
                        id: prev.mode === 'edit' ? prev.backendId : `${type.toLowerCase()}-${Date.now().toString(36)}`,
                        options: { ...(def?.defaultOptions ?? {}) } as Record<string, string>,
                      },
                    } : prev);
                  }}
                >
                  {getBackendTypes().map(bt => <option key={bt.type} value={bt.type}>{bt.icon} {bt.label}</option>)}
                </select>
              </div>

              <div className="form-group">
                <label className="form-label">Backend ID</label>
                <input
                  className="form-input"
                  value={editor.draft.id}
                  disabled={editor.mode === 'edit'}
                  onChange={e => setEditor(prev => prev ? { ...prev, draft: { ...prev.draft, id: e.target.value } } : prev)}
                  style={{ fontFamily: 'var(--font-mono)', fontSize: 13 }}
                />
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                {getBackendTypeDef(editor.draft.type)?.fields.map(field => (
                  <div key={field.key} className="form-group" style={{ margin: 0 }}>
                    <label className="form-label">
                      {field.label} {field.required && <span style={{ color: 'var(--danger)' }}>*</span>}
                    </label>
                    {field.type === 'select' ? (
                      <select
                        className="form-input"
                        value={editor.draft.options[field.key] ?? ''}
                        onChange={e => setEditor(prev => prev ? {
                          ...prev,
                          draft: { ...prev.draft, options: { ...prev.draft.options, [field.key]: e.target.value } },
                        } : prev)}
                      >
                        {field.options?.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                      </select>
                    ) : (
                      <input
                        className="form-input"
                        type={field.type}
                        value={editor.draft.options[field.key] ?? ''}
                        onChange={e => setEditor(prev => prev ? {
                          ...prev,
                          draft: { ...prev.draft, options: { ...prev.draft.options, [field.key]: e.target.value } },
                        } : prev)}
                        placeholder={field.placeholder}
                      />
                    )}
                  </div>
                ))}
              </div>

              {accountBackends.length > 0 && (
                <div className="form-group">
                  <label className="form-label">复用配置同步后端的账号字段（可选）</label>
                  <select
                    className="form-input"
                    value={editor.draft.accountBackendId}
                    onChange={e => setEditor(prev => prev ? { ...prev, draft: { ...prev.draft, accountBackendId: e.target.value } } : prev)}
                  >
                    <option value="">— 无 —</option>
                    {accountBackends.map(b => <option key={b.id} value={b.id}>{b.id} ({b.type})</option>)}
                  </select>
                </div>
              )}

              <div className="form-group">
                <label className="form-label">描述</label>
                <input
                  className="form-input"
                  value={editor.draft.description}
                  onChange={e => setEditor(prev => prev ? { ...prev, draft: { ...prev.draft, description: e.target.value } } : prev)}
                />
              </div>

              <div className="form-group">
                <label className="form-label">从配置串导入（覆盖当前表单）</label>
                <textarea
                  className="form-input"
                  rows={2}
                  value={importStr}
                  onChange={e => setImportStr(e.target.value)}
                  placeholder="type:id:key=value,key=value,desc=...,accountBackendId=..."
                />
                <button className="btn btn-sm btn-secondary" onClick={applyImport}>应用</button>
                {importError && <p className="form-hint" style={{ color: 'var(--danger)' }}>{importError}</p>}
              </div>

              <div className="modal-actions">
                <button className="btn btn-secondary" onClick={() => setEditor(null)}>取消</button>
                <button className="btn btn-primary" onClick={handleEditorSave} disabled={busy}>保存</button>
              </div>
            </div>
          </div>
        )}

        <div className="modal-actions">
          <button className="btn btn-secondary" onClick={onClose}>关闭</button>
        </div>
      </div>
    </div>
  );
}
