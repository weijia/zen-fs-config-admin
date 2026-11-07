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
        {opening && <span style={{ fontSize: 11, color: 'var(--warning)' }}>打开中…</span>}
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
    </div>
  );
}
