/**
 * 顶栏全局「同步组选择器」。
 *
 * 只有两层，都是组：
 *   · 配置同步组：一行，代表 admin 连接的那个远端配置仓（带自身后端与同步状态）。
 *   · 数据同步组：平铺列出，每条是独立组（组名 / 后端数量 / 打开状态 / 同步健康），
 *     可直接点开改文件；描述符损坏的条目也会列出但标红不可打开。
 *     组属于哪个 appId 只作为行尾灰色小字与 tooltip 的次要信息，不做层级、不做选择项。
 *
 * 选中即后台打开，打开失败时停留在失败项，由 Layout 的错误条提供重试 / 切回 admin。
 * 实例管理（AppInstanceManager）固定为 admin 级入口，放在面板底部。
 */
import { useState, useEffect, useRef } from 'react';
import { useSyncTarget } from '../context/SyncTargetContext';
import { targetKindLabel } from '../sync-target';
import { OPEN_STAGE_LABELS } from '../open-progress';
import AppInstanceManager from './AppInstanceManager';

function stateDotClass(state: string): string {
  if (state === 'open') return 'open';
  if (state === 'opening') return 'opening';
  if (state === 'failed' || state === 'invalid') return 'failed';
  return 'closed';
}

export default function SyncGroupSelector() {
  const {
    configTargets,
    dataTargets,
    selected,
    selectedKey,
    selectedOption,
    opening,
    openProgress,
    error,
    openedAppIds,
    maxInstances,
    selectTarget,
    ready,
    deleteDescriptor,
  } = useSyncTarget();
  const [open, setOpen] = useState(false);
  const [managerAppId, setManagerAppId] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  /** 待确认删除的无效描述符（`data:<appId>:<groupId>`）。 */
  const [pendingDelete, setPendingDelete] = useState<{ appId: string; groupId: string; label: string } | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const handleConfirmDelete = async () => {
    if (!pendingDelete) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await deleteDescriptor(pendingDelete.appId, pendingDelete.groupId);
      setPendingDelete(null);
    } catch (err: any) {
      setDeleteError(err?.message ?? String(err));
    } finally {
      setDeleting(false);
    }
  };

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const configSelected = selected.kind === 'config';
  const state = opening ? 'opening' : error ? 'failed' : ready ? 'open' : (selectedOption?.openState ?? 'closed');
  const triggerLabel = configSelected
    ? (selectedOption?.label ?? '配置同步组')
    : (selectedOption?.label ?? `${selected.appId} / ${selected.groupId}`);

  const invalidCount = dataTargets.filter(t => t.openState === 'invalid').length;
  const openableCount = dataTargets.length - invalidCount;

  const rowClass = (isCurrent: boolean, invalid = false) =>
    `sync-target-row${isCurrent ? ' active' : ''}${invalid ? ' invalid' : ''}`;

  const renderConfigRow = (option: (typeof configTargets)[number]) => {
    const isCurrent = configSelected && option.key === selectedKey;
    return (
      <div
        key={option.key}
        className={rowClass(isCurrent)}
        onClick={() => selectTarget(option.key)}
        title={option.error ?? option.detail}
      >
        <span className={`sync-target-dot ${isCurrent && opening ? 'opening' : stateDotClass(option.openState)}`} />
        <span style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 1, minWidth: 0 }}>
          <span className="badge" style={{ fontSize: 10, padding: '1px 6px', background: 'var(--bg-tertiary)', color: 'var(--accent)' }}>
            {targetKindLabel(option.ref)}
          </span>
          <span className="sync-target-name">{option.label}</span>
        </span>
        <span className="sync-target-detail">{isCurrent && opening ? '正在打开…' : option.detail}</span>
      </div>
    );
  };

  const renderDataRow = (option: (typeof dataTargets)[number]) => {
    const isCurrent = !configSelected && option.key === selectedKey;
    const isOpening = isCurrent && opening;
    const invalid = option.openState === 'invalid';
    return (
      <div
        key={option.key}
        className={rowClass(isCurrent, invalid)}
        onClick={() => {
          if (invalid) return;
          selectTarget(option.key);
          setOpen(false);
        }}
        title={`${invalid ? option.error : option.detail}${option.ref.appId ? ` · appId: ${option.ref.appId}` : ''}`}
        aria-disabled={invalid}
      >
        <span className={`sync-target-dot ${isOpening ? 'opening' : stateDotClass(option.openState)}`} />
        <span style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 1, minWidth: 0 }}>
          <span className="badge" style={{ fontSize: 10, padding: '1px 6px', background: 'var(--bg-tertiary)', color: invalid ? 'var(--danger)' : 'var(--success)' }}>
            {targetKindLabel(option.ref)}
          </span>
          <span className="sync-target-name">{option.label}</span>
          <span className="sync-target-appid">{option.ref.appId}</span>
        </span>
        <span className="sync-target-detail">
          {isOpening ? '正在打开…（首次同步可能需要几十秒）' : option.detail}
        </span>
        {invalid && (
          <button
            className="btn btn-sm btn-danger"
            style={{ fontSize: 11, padding: '2px 8px', flex: '0 0 auto' }}
            onClick={e => {
              e.stopPropagation();
              setDeleteError(null);
              setOpen(false);
              setPendingDelete({
                appId: option.ref.appId,
                groupId: option.ref.groupId ?? option.label,
                label: option.label,
              });
            }}
            title="删除这条损坏的组登记（不删除组内数据文件）"
          >
            删除
          </button>
        )}
      </div>
    );
  };

  return (
    <div className="sync-target-selector" ref={rootRef}>
      <button
        className="sync-target-trigger"
        onClick={() => setOpen(v => !v)}
        title="切换当前同步组"
      >
        <span className={`sync-target-dot ${stateDotClass(state)}`} />
        <span className="badge" style={{ fontSize: 10, padding: '1px 6px', background: 'var(--bg-tertiary)', color: configSelected ? 'var(--accent)' : 'var(--success)' }}>
          {targetKindLabel(selected)}
        </span>
        {!configSelected && <span className="sync-target-appid">{selected.appId}</span>}
        <span className="sync-target-trigger-label">{triggerLabel}</span>
        {opening && (
          <span style={{ fontSize: 11, color: 'var(--warning)' }}>
            {openProgress ? `${OPEN_STAGE_LABELS[openProgress.stage]}…` : '打开中…'}
          </span>
        )}
        {error && <span style={{ fontSize: 11, color: 'var(--danger)' }}>失败</span>}
        <span style={{ marginLeft: 4, color: 'var(--text-muted)' }}>▾</span>
      </button>

      {open && (
        <div className="sync-target-panel">
          <div className="sync-target-section-title">配置同步组</div>
          {configTargets.map(renderConfigRow)}
          {configTargets.length === 0 && <div className="sync-target-empty">暂无配置组</div>}

          <div className="sync-target-section-title" style={{ marginTop: 8 }}>
            数据同步组
            <span className="sync-target-section-hint">
              {openableCount} 个组可打开{invalidCount > 0 ? ` · ${invalidCount} 个描述符损坏（标红不可打开）` : ''}
            </span>
          </div>
          {dataTargets.map(renderDataRow)}
          {dataTargets.length === 0 && <div className="sync-target-empty">暂无数据组描述符</div>}

          <div className="sync-target-footer">
            <span>
              已打开实例 {openedAppIds.length}/{maxInstances}（按 appId 计）
              <span style={{ color: 'var(--text-muted)' }}> · admin 常驻不计入</span>
            </span>
            <span style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
              {openedAppIds.map(appId => (
                <button
                  key={appId}
                  className="btn btn-sm btn-secondary"
                  style={{ fontSize: 10, padding: '1px 6px' }}
                  onClick={e => { e.stopPropagation(); setManagerAppId(appId); setOpen(false); }}
                >
                  {appId} 管理
                </button>
              ))}
            </span>
          </div>
        </div>
      )}

      {managerAppId && (
        <AppInstanceManager appId={managerAppId} onClose={() => setManagerAppId(null)} />
      )}

      {pendingDelete && (
        <div
          className="modal-overlay"
          onClick={() => { if (!deleting) setPendingDelete(null); }}
        >
          <div className="modal" style={{ maxWidth: 520 }} onClick={e => e.stopPropagation()}>
            <div className="modal-title">删除无效数据组描述符</div>

            <p style={{ fontSize: 13, marginBottom: 8 }}>
              将删除组登记：
              <span className="badge" style={{ fontSize: 10, margin: '0 6px', background: 'var(--bg-tertiary)', color: 'var(--success)' }}>
                data-sync
              </span>
              <strong>{pendingDelete.label}</strong>
              <span style={{ color: 'var(--text-muted)' }}> · appId: {pendingDelete.appId}</span>
            </p>

            <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.7 }}>
              <p style={{ marginBottom: 6 }}>会清理配置仓里的两份描述符副本：</p>
              <ul style={{ margin: '0 0 8px 18px', fontFamily: 'var(--font-mono)', fontSize: 11 }}>
                <li>.config/app-data-groups/{pendingDelete.appId}/{pendingDelete.groupId}.json</li>
                <li>.meta/app-data-groups/{pendingDelete.appId}/{pendingDelete.groupId}.json</li>
              </ul>
              <p style={{ marginBottom: 6 }}>
                只删组登记 / 描述符，<strong>不会删除该数据组内的用户数据文件</strong>；
                {' '}组内数据（含组自己的远端仓库）保持原样。
              </p>
              <p style={{ marginBottom: 6 }}>
                删除会写入墓碑并立即 flush 同步到远端配置仓，远端这份坏 JSON
                也会被删除，下一轮同步不会把它拉回来。
              </p>
            </div>

            {deleteError && (
              <p style={{ color: 'var(--danger)', fontSize: 12, marginTop: 8 }}>{deleteError}</p>
            )}

            <div className="modal-actions">
              <button className="btn btn-secondary" onClick={() => setPendingDelete(null)} disabled={deleting}>
                取消
              </button>
              <button className="btn btn-danger" onClick={handleConfirmDelete} disabled={deleting}>
                {deleting ? '删除中…' : '删除描述符'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
