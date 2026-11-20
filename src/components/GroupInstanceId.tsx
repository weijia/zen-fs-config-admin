/**
 * 同步组实例身份（`instanceId`，UUID）展示。
 *
 * 这个值来自各组自己的 `.meta/group.json`，是**同步边界**：连接远端前比对对方
 * `.meta/group.json` 的 `instanceId`，不一致就不建同步对。它不是组 id（
 * `.config/app-data-groups/{appId}/{id}.json` 的文件名），也不是 node id。
 *
 * 显示为前 8 位（够肉眼比对），点击复制完整值；拿不到时显示 `—` 并说明原因。
 */
import { useState, type MouseEvent } from 'react';

/** 取短形式：前 8 位（UUID 前缀即可区分同页的多个组）。 */
export function shortInstanceId(id: string | null | undefined): string {
  if (!id) return '';
  return id.length <= 8 ? id : id.slice(0, 8);
}

export interface GroupInstanceIdProps {
  id?: string | null;
  /** 前缀标签，默认「组 ID」。 */
  label?: string;
  /** 放在同一行最前面的内容（例如分隔符）。 */
  prefix?: string;
  /** 值缺失时的说明（tooltip）。 */
  missingHint?: string;
}

export default function GroupInstanceId({
  id,
  label = '实例 ID',
  prefix,
  missingHint = '该组尚未写入 .meta/group.json（首次激活时生成）',
}: GroupInstanceIdProps) {
  const [copied, setCopied] = useState(false);

  if (!id) {
    return (
      <span
        title={missingHint}
        style={{ fontSize: 11, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}
      >
        {prefix}{label}: —
      </span>
    );
  }

  const handleCopy = (e: MouseEvent) => {
    e.stopPropagation();
    try {
      navigator.clipboard.writeText(id).then(
        () => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        },
        () => { /* 剪贴板不可用时保持原样，值仍在 tooltip 里 */ },
      );
    } catch {
      /* ignore */
    }
  };

  return (
    <span
      style={{
        fontSize: 11,
        color: 'var(--text-muted)',
        whiteSpace: 'nowrap',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
      }}
    >
      {prefix}{label}:
      <code
        onClick={handleCopy}
        title={`${id}（点击复制完整值）`}
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 11,
          cursor: 'pointer',
          padding: '0 2px',
          borderRadius: 3,
          background: 'var(--bg-tertiary)',
        }}
      >
        {shortInstanceId(id)}
      </code>
      {copied && <span style={{ color: 'var(--success)' }}>已复制</span>}
    </span>
  );
}
