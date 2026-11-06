import { useState, type DragEvent } from 'react';

import type { TaskSnapshot } from '@dsm/core';
import type { BootstrapData, LocalFileInfo } from '../shared.ts';
import { errorMessage, formatBytes, unwrap } from './api.ts';

interface UploadPageProps {
  bootstrap: BootstrapData;
  task: TaskSnapshot | null;
  active: boolean;
  onTask: (task: TaskSnapshot) => void;
  onOpenSettings: () => void;
  onOpenToken: () => void;
  onNotice: (message: string | null) => void;
}

export function UploadPage({
  bootstrap,
  task,
  active,
  onTask,
  onOpenSettings,
  onOpenToken,
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
            <span className="eyebrow">SINGLE FILE</span>
            <h2>选择一份文件，构建独立归档</h2>
          </div>
          <span
            className={`token-chip ${bootstrap.token.configured ? 'ready' : ''}`}
          >
            {bootstrap.token.configured ? '连接已配置' : '需要 Token'}
          </span>
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
              : `单文件上限 ${formatBytes(bootstrap.config.maxUploadBytes)}`}
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
            <button type="button" className="text-button" onClick={onOpenToken}>
              配置 Token
            </button>
          )}
          <button
            type="button"
            className="text-button"
            onClick={() => void openResults()}
          >
            打开结果目录
          </button>
        </div>
        {!bootstrap.token.configured && (
          <p className="helper-text">
            没有 Token 仍可选择和检查本地文件；上传、下载会保持禁用。
          </p>
        )}
      </div>

      <aside className="side-column">
        <div className="info-panel">
          <span className="eyebrow">DESTINATION</span>
          <h3>{bootstrap.config.branch}</h3>
          <dl>
            <div>
              <dt>GitLab</dt>
              <dd>{bootstrap.config.gitlabUrl || '尚未配置'}</dd>
            </div>
            <div>
              <dt>项目</dt>
              <dd>{bootstrap.config.projectId || '尚未配置'}</dd>
            </div>
            <div>
              <dt>归档根目录</dt>
              <dd title={bootstrap.resolvedSaveDirectory}>
                {bootstrap.resolvedSaveDirectory}
              </dd>
            </div>
          </dl>
          <button
            type="button"
            className="text-button compact"
            onClick={onOpenSettings}
          >
            编辑连接设置
          </button>
        </div>

        <div className="info-panel task-summary">
          <span className="eyebrow">RECENT TASK</span>
          {task ? (
            <>
              <h3>{task.fileName ?? '任务'}</h3>
              <p>{statusText(task)}</p>
              {task.commitId && (
                <code className="commit-id">{task.commitId.slice(0, 12)}</code>
              )}
            </>
          ) : (
            <>
              <h3>还没有任务</h3>
              <p>第一次同步后会在这里显示最近状态。</p>
            </>
          )}
        </div>

        <div className="safety-note">
          <strong>归档版本已锁定</strong>
          <p>
            下载与重试使用本次上传产生的 Commit
            ID；后续分支提交不会改变本次结果。
          </p>
        </div>
      </aside>
    </div>
  );
}

function statusText(task: TaskSnapshot): string {
  const labels: Partial<Record<TaskSnapshot['status'], string>> = {
    CHECKING: '正在检查远端状态',
    WAITING_FOR_TOKEN: '等待 Token',
    WAITING_FOR_OVERWRITE_CONFIRMATION: '等待覆盖确认',
    WAITING_FOR_BRANCH_CONFIRMATION: '等待分支创建确认',
    UPLOADING: '正在上传',
    UPLOADED: '上传完成，正在定位 Commit',
    DOWNLOADING: '正在下载归档',
    EXTRACTING: '正在安全解压',
    CLEANING: '正在清理临时文件',
    SUCCESS: '上传并解压完成（仅保留本次文件）',
    SUCCESS_WITH_WARNING: '完成，但有清理警告',
    FAILED: task.failure?.message ?? '任务失败',
  };
  return labels[task.status] ?? task.status;
}
