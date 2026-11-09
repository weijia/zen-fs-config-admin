import { useEffect, useState } from 'react';
import { progressSteps, type OpenPairProgress, type OpenProgress } from '../open-progress';

/**
 * 打开同步组时的阶段进度。
 *
 * 只展示真实信号：阶段来自打开流程，计数来自 repo 的同步对状态；
 * 拿不到计数的环节（如组激活期间的逐文件进度）只显示阶段与已用时。
 */
export default function OpenStageList({ progress }: { progress: OpenProgress | null }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  if (!progress) return null;
  const steps = progressSteps(progress);
  const seconds = Math.max(0, Math.round((now - progress.startedAt) / 1000));

  return (
    <div className="open-progress">
      <div className="open-progress-head">
        <span className="open-progress-spinner" aria-hidden />
        <span>正在打开同步组…</span>
        <span className="open-progress-elapsed">已用时 {seconds}s</span>
      </div>
      <ol className="open-progress-steps">
        {steps.map(step => (
          <li key={step.stage} className={`open-progress-step ${step.status}`}>
            <span className="open-progress-mark" aria-hidden>
              {step.status === 'done' ? '✓' : step.status === 'active' ? '●' : '○'}
            </span>
            <span className="open-progress-label">{step.label}</span>
            {step.detail && <span className="open-progress-detail">{step.detail}</span>}
          </li>
        ))}
      </ol>
      {progress.stage === 'sync' && progress.pairs.length > 0 && (
        <ul className="open-progress-pairs">
          {progress.pairs.map(pair => (
            <li key={pair.pairId} className={pair.completed ? 'done' : undefined}>
              <span className="open-progress-pair-name">{pair.name}</span>
              <span className="open-progress-pair-state">{pairStateText(pair)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function pairStateText(pair: OpenPairProgress): string {
  if (pair.state === 'syncing') return '同步中';
  if (pair.completed) return '已完成';
  if (pair.state === 'watching') return '监听中';
  return '等待中';
}
