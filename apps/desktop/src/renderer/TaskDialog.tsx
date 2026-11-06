import { useEffect, useState } from 'react';

import type { RecoveryAction, TaskSnapshot } from '@dsm/core';
import { errorMessage, unwrap } from './api.ts';

interface TaskDialogProps {
  task: TaskSnapshot;
  onTask: (task: TaskSnapshot) => void;
  onOpenToken: () => void;
  onNotice: (message: string | null) => void;
}

const STATUS_LABELS: Record<TaskSnapshot['status'], string> = {
  IDLE: '空闲',
  CHECKING: '检查远端状态',
  WAITING_FOR_TOKEN: '等待 Token',
  WAITING_FOR_OVERWRITE_CONFIRMATION: '等待覆盖确认',
  WAITING_FOR_BRANCH_CONFIRMATION: '等待分支确认',
  UPLOADING: '上传文件',
  UPLOADED: '定位本次 Commit',
  DOWNLOADING: '下载指定 Commit 归档',
  EXTRACTING: '安全解压',
  CLEANING: '清理临时文件',
  SUCCESS: '任务完成',
  SUCCESS_WITH_WARNING: '完成，有清理警告',
  FAILED: '任务失败',
};

const ACTIVE_STATUSES = new Set<TaskSnapshot['status']>([
  'CHECKING',
  'WAITING_FOR_TOKEN',
  'WAITING_FOR_OVERWRITE_CONFIRMATION',
  'WAITING_FOR_BRANCH_CONFIRMATION',
  'UPLOADING',
  'UPLOADED',
  'DOWNLOADING',
  'EXTRACTING',
  'CLEANING',
]);

export function TaskDialog({
  task,
  onTask,
  onOpenToken,
  onNotice,
}: TaskDialogProps): React.JSX.Element {
  const [busy, setBusy] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const active = ACTIVE_STATUSES.has(task.status);

  useEffect(() => {
    if (active) setDismissed(false);
  }, [active, task.status, task.taskId]);

  if (dismissed) return <></>;

  async function confirm(
    allowOverwrite: boolean,
    allowCreateBranch: boolean,
  ): Promise<void> {
    setBusy(true);
    try {
      onTask(
        await unwrap(
          window.dsm.confirmTask(
            task.taskId,
            allowOverwrite,
            allowCreateBranch,
          ),
        ),
      );
    } catch (error) {
      onNotice(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function recover(action: RecoveryAction): Promise<void> {
    setBusy(true);
    try {
      onTask(await unwrap(window.dsm.recoverTask(task.taskId, action)));
    } catch (error) {
      onNotice(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function reveal(path: string): Promise<void> {
    try {
      await unwrap(window.dsm.revealPath(path));
    } catch (error) {
      onNotice(errorMessage(error));
    }
  }

  return (
    <div className="dialog-backdrop" role="presentation">
      <section
        className={`task-dialog status-${task.status.toLowerCase()}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="task-title"
      >
        <div className="dialog-topline">
          <span className={`pulse ${active ? 'active' : ''}`} />
          <span>{STATUS_LABELS[task.status]}</span>
          {!active && (
            <button
              type="button"
              className="dialog-close"
              aria-label="关闭任务窗口"
              onClick={() => setDismissed(true)}
            >
              ×
            </button>
          )}
        </div>

        <h2 id="task-title">{task.fileName ?? '同步任务'}</h2>
        <p className="task-message">{taskMessage(task)}</p>

        <div className="task-progress">
          {[
            'UPLOADING',
            'UPLOADED',
            'DOWNLOADING',
            'EXTRACTING',
            'CLEANING',
          ].map((stage) => (
            <span
              key={stage}
              className={stageClass(task.status, stage)}
              title={STATUS_LABELS[stage as TaskSnapshot['status']]}
            />
          ))}
        </div>

        <dl className="task-meta">
          <div>
            <dt>目标分支</dt>
            <dd>{task.branch ?? '—'}</dd>
          </div>
          <div>
            <dt>Commit</dt>
            <dd>{task.commitId ?? '尚未定位'}</dd>
          </div>
          {task.branchCreated && (
            <div>
              <dt>远端副作用</dt>
              <dd>{task.branch} 分支已创建</dd>
            </div>
          )}
          <div>
            <dt>结果目录</dt>
            <dd title={task.resultDirectory ?? undefined}>
              {task.resultDirectory ?? '—'}
            </dd>
          </div>
        </dl>

        {task.status === 'WAITING_FOR_OVERWRITE_CONFIRMATION' && (
          <div className="dialog-actions">
            <button
              type="button"
              className="primary-button"
              disabled={busy}
              onClick={() => void confirm(true, false)}
            >
              确认覆盖并上传
            </button>
            <button
              type="button"
              className="text-button"
              disabled={busy}
              onClick={() => void confirm(false, false)}
            >
              取消任务
            </button>
          </div>
        )}

        {task.status === 'WAITING_FOR_BRANCH_CONFIRMATION' && (
          <>
            <p className="helper-text">
              {task.sourceBranch
                ? `将从 ${task.sourceBranch} 创建分支 ${task.branch}。`
                : `项目为空仓库，将通过一次初始 Commit 创建分支 ${task.branch}。`}
            </p>
            <div className="dialog-actions">
              <button
                type="button"
                className="primary-button"
                disabled={busy}
                onClick={() => void confirm(false, true)}
              >
                确认创建分支
              </button>
              <button
                type="button"
                className="text-button"
                disabled={busy}
                onClick={() => void confirm(false, false)}
              >
                取消任务
              </button>
            </div>
          </>
        )}

        {task.status === 'WAITING_FOR_TOKEN' && (
          <div className="dialog-actions">
            <button
              type="button"
              className="primary-button"
              onClick={() => {
                setDismissed(true);
                onOpenToken();
              }}
            >
              配置 Token
            </button>
          </div>
        )}

        {task.failure?.recoverable && task.recoveryActions.length > 0 && (
          <div className="dialog-actions">
            {task.recoveryActions.map((action) => (
              <button
                key={action}
                type="button"
                className="primary-button"
                disabled={busy}
                onClick={() => void recover(action)}
              >
                {recoveryLabel(action)}
              </button>
            ))}
          </div>
        )}

        {task.status === 'SUCCESS_WITH_WARNING' &&
          task.recoveryActions.includes('RETRY_CLEANUP') && (
            <div className="dialog-actions">
              <button
                type="button"
                className="secondary-button"
                disabled={busy}
                onClick={() => void recover('RETRY_CLEANUP')}
              >
                重试清理
              </button>
            </div>
          )}

        {task.resultDirectory && !active && (
          <button
            type="button"
            className="text-button reveal-button"
            onClick={() => void reveal(task.resultDirectory as string)}
          >
            在文件管理器中显示结果
          </button>
        )}
      </section>
    </div>
  );
}

function taskMessage(task: TaskSnapshot): string {
  if (task.status === 'SUCCESS') {
    return '上传并从目标 Commit 解压完成。首版仅确认指定 Commit 的归档中存在目标文件，不执行内容完整性验证。';
  }
  if (task.status === 'SUCCESS_WITH_WARNING') {
    return `主流程已完成，但临时文件未完全清理。${task.warning ?? ''}`;
  }
  if (task.status === 'FAILED') {
    return task.failure?.message ?? '任务执行失败';
  }
  return STATUS_LABELS[task.status];
}

function stageClass(status: TaskSnapshot['status'], stage: string): string {
  const order = [
    'UPLOADING',
    'UPLOADED',
    'DOWNLOADING',
    'EXTRACTING',
    'CLEANING',
  ];
  const currentIndex = order.indexOf(status);
  const stageIndex = order.indexOf(stage);
  if (status === 'SUCCESS' || status === 'SUCCESS_WITH_WARNING') return 'done';
  if (currentIndex === -1) return '';
  return stageIndex < currentIndex
    ? 'done'
    : stageIndex === currentIndex
      ? 'current'
      : '';
}

function recoveryLabel(action: RecoveryAction): string {
  const labels: Record<RecoveryAction, string> = {
    CONFIGURE_TOKEN: '配置 Token',
    QUERY_COMMIT: '查询上传结果',
    RETRY_DOWNLOAD: '重试下载',
    RETRY_EXTRACTION: '重试解压',
    RETRY_CLEANUP: '重试清理',
  };
  return labels[action];
}
