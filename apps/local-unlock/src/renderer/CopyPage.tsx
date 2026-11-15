import { useState, type DragEvent } from 'react';

import type { CopySnapshot } from '@dsm/core';

import type { BootstrapData, LocalFileInfo } from '../shared.ts';
import { errorMessage, formatBytes, unwrap } from './api.ts';

interface CopyPageProps {
  bootstrap: BootstrapData;
  task: CopySnapshot | null;
  active: boolean;
  onTask: (task: CopySnapshot) => void;
  onOpenSettings: () => void;
  onNotice: (message: string | null) => void;
}

const STATUS_LABELS: Record<CopySnapshot['status'], string> = {
  IDLE: '空闲',
  CHECKING: '检查文件状态',
  COPYING: '正在读取并写入',
  VERIFYING: '正在校验',
  SUCCESS: '解锁完成',
  FAILED: '解锁失败',
};

const STAGES: CopySnapshot['status'][] = ['CHECKING', 'COPYING', 'VERIFYING'];

export function CopyPage({
  bootstrap,
  task,
  active,
  onTask,
  onOpenSettings,
  onNotice,
}: CopyPageProps): React.JSX.Element {
  const [file, setFile] = useState<LocalFileInfo | null>(null);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);

  async function chooseFile(): Promise<void> {
    try {
      const selected = await unwrap(window.dsm.chooseFile());
      if (selected) setFile(selected);
    } catch (error) {
      onNotice(errorMessage(error));
    }
  }

  async function dropFile(event: DragEvent<HTMLDivElement>): Promise<void> {
    event.preventDefault();
    setDragging(false);
    const dropped = event.dataTransfer.files[0];
    if (!dropped) return;
    try {
      const filePath = window.dsm.getPathForFile(dropped);
      if (!filePath) throw new Error('无法读取拖入文件的本地路径');
      setFile(await unwrap(window.dsm.inspectFile(filePath)));
    } catch (error) {
      onNotice(errorMessage(error));
    }
  }

  async function start(filePath: string): Promise<void> {
    setBusy(true);
    try {
      const snapshot = await unwrap(window.dsm.startCopy(filePath));
      onTask(snapshot);
      onNotice(null);
    } catch (error) {
      onNotice(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function openResults(): Promise<void> {
    try {
      const directory =
        task?.status === 'SUCCESS' && task.targetDirectory
          ? task.targetDirectory
          : bootstrap.resolvedSaveDirectory;
      await unwrap(window.dsm.openDirectory(directory));
    } catch (error) {
      onNotice(errorMessage(error));
    }
  }

  async function revealResult(): Promise<void> {
    if (!task?.targetPath) return;
    try {
      await unwrap(window.dsm.revealPath(task.targetPath));
    } catch (error) {
      onNotice(errorMessage(error));
    }
  }

  return (
    <div className="upload-layout">
      <div className="primary-column">
        <div className="section-heading">
          <div>
            <h2>选择文件，本地解锁</h2>
          </div>
        </div>

        <div
          className={dragging ? 'drop-zone dragging' : 'drop-zone'}
          onDragOver={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => void dropFile(event)}
        >
          <span className="drop-index">+</span>
          <h3>{file ? file.name : '拖入文件，或从本地选择'}</h3>
          <p>
            {file
              ? `${formatBytes(file.size)} · 修改于 ${new Date(file.modifiedAt).toLocaleString()}`
              : `单个文件最大 ${formatBytes(bootstrap.config.maxCopyBytes)}`}
          </p>
          <button
            type="button"
            className="secondary-button"
            onClick={() => void chooseFile()}
          >
            {file ? '更换文件' : '浏览文件'}
          </button>
        </div>

        <div className="action-row">
          <button
            type="button"
            className="primary-button"
            disabled={!file || active || busy}
            onClick={() => {
              if (file) void start(file.path);
            }}
          >
            {busy ? '检查中…' : active ? '任务运行中' : '开始解锁'}
          </button>
        </div>
        <p className="helper-text">
          文件将直接保存到本机，不上传网络；保存位置可在设置中修改。
        </p>
      </div>

      <aside className="info-panel task-summary">
        <div className="task-summary-head">
          <span className="eyebrow">当前任务</span>
          <button
            type="button"
            className="text-button task-summary-link"
            onClick={() => void openResults()}
          >
            打开保存位置
          </button>
        </div>
        {task ? (
          <div className="current-task">
            <strong title={task.fileName ?? undefined}>
              {task.fileName ?? '解锁任务'}
            </strong>
            <span
              className={
                task.status === 'FAILED'
                  ? 'probe-verdict different'
                  : task.status === 'SUCCESS'
                    ? 'probe-verdict same'
                    : 'probe-verdict'
              }
            >
              {STATUS_LABELS[task.status]}
            </span>

            <div className="task-progress">
              {STAGES.map((stage) => (
                <span
                  key={stage}
                  className={stageClass(task.status, stage)}
                  title={STATUS_LABELS[stage]}
                />
              ))}
            </div>

            {task.status === 'COPYING' && (
              <p className="helper-text">
                已处理 {formatBytes(task.bytesProcessed)}
              </p>
            )}

            <dl className="task-meta">
              <div className="task-meta-wide">
                <dt>保存位置</dt>
                <dd
                  title={task.targetPath ?? task.targetDirectory ?? undefined}
                >
                  {task.targetPath ?? task.targetDirectory ?? '—'}
                </dd>
              </div>
            </dl>

            {task.status === 'SUCCESS' && (
              <p className="task-message">
                解锁完成，文件已保存到本地，并已校验字节数与 SHA-256。
              </p>
            )}
            {task.status === 'FAILED' && (
              <p className="error-text">
                {task.failure?.message ?? '解锁失败'}
              </p>
            )}

            <div className="action-row compact-row">
              {task.status === 'FAILED' &&
                task.recoveryActions.includes('RETRY_COPY') &&
                task.sourcePath && (
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={active || busy}
                    onClick={() => {
                      if (task.sourcePath) void start(task.sourcePath);
                    }}
                  >
                    重试
                  </button>
                )}
              {task.status === 'FAILED' && (
                <button
                  type="button"
                  className="text-button"
                  onClick={onOpenSettings}
                >
                  打开设置
                </button>
              )}
              {task.targetPath && !active && (
                <button
                  type="button"
                  className="text-button"
                  onClick={() => void revealResult()}
                >
                  在文件夹中显示
                </button>
              )}
            </div>
          </div>
        ) : (
          <>
            <h3>还没有任务</h3>
            <p>选择文件后开始解锁，结果会显示在这里。</p>
          </>
        )}
      </aside>
    </div>
  );
}

function stageClass(
  status: CopySnapshot['status'],
  stage: CopySnapshot['status'],
): string {
  const currentIndex = STAGES.indexOf(status);
  const stageIndex = STAGES.indexOf(stage);
  if (status === 'SUCCESS') return 'done';
  if (currentIndex === -1) return '';
  return stageIndex < currentIndex
    ? 'done'
    : stageIndex === currentIndex
      ? 'current'
      : '';
}
