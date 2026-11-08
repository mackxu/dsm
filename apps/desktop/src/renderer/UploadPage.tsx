import { useState, type DragEvent } from 'react';

import type { TaskSnapshot } from '@dsm/core';
import type { BootstrapData, LocalFileInfo } from '../shared.ts';
import { errorMessage, formatBytes, unwrap } from './api.ts';

interface UploadPageProps {
  bootstrap: BootstrapData;
  task: TaskSnapshot | null;
  recentTasks: TaskSnapshot[];
  active: boolean;
  onTask: (task: TaskSnapshot) => void;
  onOpenSettings: () => void;
  onNotice: (message: string | null) => void;
}

export function UploadPage({
  bootstrap,
  task,
  recentTasks,
  active,
  onTask,
  onOpenSettings,
  onNotice,
}: UploadPageProps): React.JSX.Element {
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

  async function start(): Promise<void> {
    if (!file) return;
    setBusy(true);
    try {
      const snapshot = await unwrap(window.dsm.startTask(file.path));
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
      await unwrap(
        window.dsm.openDirectory(
          task?.resultDirectory ?? bootstrap.resolvedSaveDirectory,
        ),
      );
    } catch (error) {
      onNotice(errorMessage(error));
    }
  }

  return (
    <div className="upload-layout">
      <div className="primary-column">
        <div className="section-heading">
          <div>
            <h2>选择文件，开始同步</h2>
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
              : `单个文件最大 ${formatBytes(bootstrap.config.maxUploadBytes)}`}
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
            disabled={!file || !bootstrap.token.configured || active || busy}
            onClick={() => void start()}
          >
            {busy ? '检查中…' : active ? '任务运行中' : '开始同步'}
          </button>
          {!bootstrap.token.configured && (
            <button
              type="button"
              className="text-button"
              onClick={onOpenSettings}
            >
              配置访问令牌
            </button>
          )}
        </div>
        {!bootstrap.token.configured && (
          <p className="helper-text">配置访问令牌后即可开始同步。</p>
        )}
      </div>

      <aside className="info-panel task-summary">
        <div className="task-summary-head">
          <span className="eyebrow">最近任务</span>
          <button
            type="button"
            className="text-button task-summary-link"
            onClick={() => void openResults()}
          >
            打开保存位置
          </button>
        </div>
        {recentTasks.length > 0 ? (
          <ul className="recent-task-list">
            {recentTasks.map((item) => (
              <li key={item.taskId} className="recent-task-item">
                <strong title={item.fileName ?? undefined}>
                  {item.fileName ?? '任务'}
                </strong>
                <span>{statusText(item)}</span>
                <time dateTime={item.updatedAt}>
                  {new Date(item.updatedAt).toLocaleString()}
                </time>
              </li>
            ))}
          </ul>
        ) : (
          <>
            <h3>还没有任务</h3>
            <p>第一次同步后会在这里显示最近状态。</p>
          </>
        )}
      </aside>
    </div>
  );
}

function statusText(task: TaskSnapshot): string {
  const labels: Record<TaskSnapshot['status'], string> = {
    IDLE: '空闲',
    CHECKING: '正在检查文件状态',
    WAITING_FOR_TOKEN: '等待访问令牌',
    WAITING_FOR_OVERWRITE_CONFIRMATION: '等待确认覆盖',
    UPLOADING: '正在上传',
    UPLOADED: '正在确认本次提交',
    DOWNLOADING: '正在下载压缩包',
    EXTRACTING: '正在解压文件',
    CLEANING: '正在清理临时文件',
    SUCCESS: '同步完成',
    SUCCESS_WITH_WARNING: '同步完成，有提示',
    FAILED: task.failure?.message ?? '同步失败',
  };
  return labels[task.status];
}
