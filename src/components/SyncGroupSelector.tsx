/**
 * 顶栏全局「同步组选择器」。
 *
 * 一个下拉面板列出所有 target：配置组 / 数据组分组展示，未打开的组也
 * 可选中（行内提示首次选择会建立实例并同步）。选中即后台打开，打开
 * 失败时停留在失败项，由 Layout 的错误条提供重试 / 切回 admin。
 *
 * 实例管理（AppInstanceManager）固定为 admin 级入口，放在面板底部。
 */
import { useState, useEffect, useRef } from 'react';
import { useSyncTarget } from '../context/SyncTargetContext';
import { targetKindLabel } from '../sync-target';
import AppInstanceManager from './AppInstanceManager';

function stateDotClass(state: string): string {
  if (state === 'open') return 'open';
  if (state === 'opening') return 'opening';
  if (state === 'failed') return 'failed';
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
    error,
    openedAppIds,
    maxInstances,
    selectTarget,
    ready,
  } = useSyncTarget();
  const [open, setOpen] = useState(false);
  const [managerAppId, setManagerAppId] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

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

  const state = opening ? 'opening' : error ? 'failed' : ready ? 'open' : (selectedOption?.openState ?? 'closed');
  const triggerLabel = selectedOption?.label
    ?? (selected.kind === 'config' ? `${selected.appId} 配置组` : `${selected.appId} / ${selected.groupId}`);

  const renderRow = (option: (typeof configTargets)[number]) => {
    const isOpening = option.key === selectedKey && opening;
    return (
    <div
      key={option.key}
      className={`sync-target-row${option.key === selectedKey ? ' active' : ''}`}
      onClick={() => {
        selectTarget(option.key);
        setOpen(false);
      }}
      title={option.error ?? option.detail}
    >
      <span className={`sync-target-dot ${isOpening ? 'opening' : stateDotClass(option.openState)}`} />
      <span style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 1, minWidth: 0 }}>
        <span className="badge" style={{ fontSize: 10, padding: '1px 6px', background: 'var(--bg-tertiary)', color: option.ref.kind === 'config' ? 'var(--accent)' : 'var(--success)' }}>
          {targetKindLabel(option.ref)}
        </span>
        <span className="sync-target-appid">{option.ref.appId}</span>
        <span className="sync-target-name">{option.label}</span>
      </span>
      <span className="sync-target-detail">
        {isOpening ? '正在打开…（首次同步可能需要几十秒）' : option.detail}
      </span>
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
        <span className="badge" style={{ fontSize: 10, padding: '1px 6px', background: 'var(--bg-tertiary)', color: selected.kind === 'config' ? 'var(--accent)' : 'var(--success)' }}>
          {targetKindLabel(selected)}
        </span>
        <span className="sync-target-appid">{selected.appId}</span>
        <span className="sync-target-trigger-label">{triggerLabel}</span>
        {opening && <span style={{ fontSize: 11, color: 'var(--warning)' }}>打开中…</span>}
        {error && <span style={{ fontSize: 11, color: 'var(--danger)' }}>失败</span>}
        <span style={{ marginLeft: 4, color: 'var(--text-muted)' }}>▾</span>
      </button>

      {open && (
        <div className="sync-target-panel">
          <div className="sync-target-section-title">Config groups</div>
          {configTargets.map(renderRow)}
          {configTargets.length === 0 && <div className="sync-target-empty">暂无配置组</div>}

          <div className="sync-target-section-title" style={{ marginTop: 8 }}>Data groups</div>
          {dataTargets.map(renderRow)}
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
    </div>
  );
}
