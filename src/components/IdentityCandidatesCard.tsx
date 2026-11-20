import { useEffect, useMemo, useState } from 'react';
import type { IdentityCandidate, SyncGroupHandle } from 'zen-fs-config';

/**
 * 实例 ID 候选卡：把「本组身份到底该用哪个」摊给用户决定。
 *
 * 硬规则（与库层不变式一致）：
 *   · 只有去重后出现多个不同值、或库明确标记未裁决时才显示；
 *   · 每个不同值都列完整 UUID，绝不截断；
 *   · 只有用户点按钮才会写入，没有自动 adopt、没有静默改写。
 */

const SOURCE_LABEL: Record<IdentityCandidate['source'], string> = {
  local: '本机本地 .meta/group.json',
  bootstrap: '配置组引导副本',
  remote: '远端根',
};

interface CandidateGroup {
  instanceId: string;
  sources: string[];
  rootCount: number;
}

export function groupCandidates(candidates: IdentityCandidate[]): CandidateGroup[] {
  const map = new Map<string, CandidateGroup>();
  for (const c of candidates) {
    if (!c?.instanceId) continue;
    const label = c.source === 'remote'
      ? `${SOURCE_LABEL.remote} ${c.backendId ?? '?'}`
      : SOURCE_LABEL[c.source];
    const existing = map.get(c.instanceId);
    if (existing) {
      if (!existing.sources.includes(label)) existing.sources.push(label);
      existing.rootCount += c.rootCount ?? 1;
    } else {
      map.set(c.instanceId, {
        instanceId: c.instanceId,
        sources: [label],
        rootCount: c.rootCount ?? 1,
      });
    }
  }
  return Array.from(map.values());
}

export interface IdentityCandidatesCardProps {
  handle: SyncGroupHandle | null;
  /** 写入成功后让页面重新读取状态（数据组需要重新激活才会刷新）。 */
  onChanged?: () => void;
}

export default function IdentityCandidatesCard({ handle, onChanged }: IdentityCandidatesCardProps) {
  const [candidates, setCandidates] = useState<IdentityCandidate[]>([]);
  const [unsettled, setUnsettled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [readError, setReadError] = useState('');
  const [outcome, setOutcome] = useState('');

  const reload = useMemo(() => async () => {
    if (!handle) {
      setCandidates([]);
      setUnsettled(false);
      return;
    }
    try {
      // 优先用「现场回读」版本：同步 getter 只有缓存，本地已定身份时
      // 它就只返回本地一个值，界面上看不出与远端的分歧。
      const fresh = (handle as Partial<SyncGroupHandle>).getIdentityCandidatesAsync;
      const fn = (handle as Partial<SyncGroupHandle>).getIdentityCandidates;
      if (typeof fresh !== 'function' && typeof fn !== 'function') {
        setCandidates([]);
        setUnsettled(false);
        setReadError('');
        return;
      }
      const list = typeof fresh === 'function'
        ? await Promise.resolve(fresh.call(handle))
        : await Promise.resolve(fn!.call(handle));
      setCandidates(Array.isArray(list) ? list : []);
      const flag = (handle as Partial<SyncGroupHandle>).isIdentityUnsettled;
      setUnsettled(typeof flag === 'function' ? !!flag.call(handle) : false);
      setReadError('');
    } catch (err) {
      setCandidates([]);
      setUnsettled(false);
      setReadError(err instanceof Error ? err.message : String(err));
    }
  }, [handle]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const groups = useMemo(() => groupCandidates(candidates), [candidates]);
  const current = handle?.getGroupInstanceId?.();

  if (!handle) return null;
  if (readError) {
    return (
      <div className="badge" style={{ marginBottom: 16 }}>
        读取实例 ID 候选失败：{readError}
      </div>
    );
  }
  if (groups.length <= 1 && !unsettled) return null;

  const apply = async (instanceId: string, rewriteRoots: boolean) => {
    const scopeText = rewriteRoots
      ? `把本组实例 ID 设为 ${instanceId}，并把它所有 kind / id 相同的远端根一并写成该值。`
      : `把本组实例 ID 设为 ${instanceId}，只改本组，不动任何远端 group.json。`;
    if (!window.confirm(`${scopeText}\n\n这是不可自动撤销的身份决定，确认继续？`)) return;
    const fn = (handle as Partial<SyncGroupHandle>).setGroupInstanceId;
    if (typeof fn !== 'function') {
      setOutcome('当前库版本不支持写入实例 ID。');
      return;
    }
    setBusy(true);
    setOutcome('');
    try {
      const result = await fn.call(handle, instanceId, { rewriteRoots });
      const lines: string[] = [];
      lines.push(result.ok ? `已设为本组实例 ID：${result.instanceId ?? instanceId}` : `未写入：${result.reason ?? '原因未知'}`);
      for (const root of result.roots ?? []) {
        lines.push(root.ok
          ? `✔ 远端根 ${root.backendId}：${root.before ?? '（无）'} → ${instanceId}`
          : `✘ 远端根 ${root.backendId}：${root.reason ?? '失败'}`);
      }
      setOutcome(lines.join('\n'));
      await reload();
      onChanged?.();
    } catch (err) {
      setOutcome(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section style={{
      marginBottom: 24,
      border: '1px solid var(--warning, #b8860b)',
      borderRadius: 8,
      padding: '12px 14px',
      background: 'var(--bg-secondary, rgba(184,134,11,0.06))',
    }}>
      <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 8 }}>
        ⚠️ 实例 ID 不一致 · {groups.length} 个不同值，需要你决定
      </div>
      <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 10 }}>
        实例 ID 是同步边界：不同值的根不会被连成一对，也不会互相覆盖。请选一个值作为本组身份。
      </div>
      <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12, lineHeight: 1.9 }}>
        {groups.map(g => (
          <li key={g.instanceId} style={{ marginBottom: 8 }}>
            <div style={{ fontFamily: 'var(--font-mono)', wordBreak: 'break-all' }}>
              {g.instanceId}
              {g.instanceId === current && <span className="badge" style={{ marginLeft: 6 }}>← 本组当前使用</span>}
            </div>
            <div style={{ color: 'var(--text-muted)', fontSize: 11 }}>
              来源：{g.sources.join('、')}（共 {g.rootCount} 个根）
            </div>
            <div style={{ marginTop: 4 }}>
              <button
                className="btn btn-sm btn-secondary"
                disabled={busy}
                onClick={() => apply(g.instanceId, false)}
              >
                本组设为该值（不改远端）
              </button>
              <button
                className="btn btn-sm btn-primary"
                style={{ marginLeft: 6 }}
                disabled={busy}
                onClick={() => apply(g.instanceId, true)}
              >
                设为该值并统一本组所有根
              </button>
            </div>
          </li>
        ))}
      </ul>
      {outcome && (
        <div style={{
          marginTop: 10,
          fontSize: 12,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-all',
          color: 'var(--text-secondary)',
          fontFamily: 'var(--font-mono)',
        }}>
          {outcome}
        </div>
      )}
    </section>
  );
}
