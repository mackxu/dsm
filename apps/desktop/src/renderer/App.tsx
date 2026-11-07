import { useEffect, useRef, useState } from 'react';

import type { TaskSnapshot, TokenStatus } from '@dsm/core';
import type { BootstrapData } from '../shared.ts';
import { errorMessage, unwrap } from './api.ts';
import { LogsPage } from './LogsPage.tsx';
import { SettingsPage } from './SettingsPage.tsx';
import { TaskDialog } from './TaskDialog.tsx';
import { UploadPage } from './UploadPage.tsx';

export type Page = 'upload' | 'settings' | 'logs';

type SubPage = Exclude<Page, 'upload'>;

const PAGE_TITLES: Record<SubPage, string> = {
  settings: '设置',
  logs: '运行日志',
};

const ACTIVE_STATUSES: ReadonlySet<TaskSnapshot['status']> = new Set([
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

export function App(): React.JSX.Element {
  const [page, setPage] = useState<Page>('upload');
  const [bootstrap, setBootstrap] = useState<BootstrapData | null>(null);
  const [task, setTask] = useState<TaskSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);
  const [settingsDirty, setSettingsDirty] = useState(false);
  const workspaceRef = useRef<HTMLElement>(null);

  useEffect(() => {
    let active = true;
    void unwrap(window.dsm.bootstrap())
      .then((data) => {
        if (!active) return;
        setBootstrap(data);
        setTask(data.currentTask);
      })
      .catch((error: unknown) => {
        if (active) setNotice(errorMessage(error));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    const unsubscribe = window.dsm.onTaskUpdate((snapshot) => {
      if (active) setTask(snapshot);
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    workspaceRef.current?.scrollTo(0, 0);
  }, [page]);

  async function handleSaved(
    data: BootstrapData,
    tokenSubmitted: boolean,
  ): Promise<void> {
    setBootstrap(data);
    setTask(data.currentTask);
    setSettingsDirty(false);

    const current = data.currentTask;
    if (
      tokenSubmitted &&
      data.token.configured &&
      current?.recoveryActions.includes('CONFIGURE_TOKEN')
    ) {
      try {
        setTask(
          await unwrap(
            window.dsm.recoverTask(current.taskId, 'CONFIGURE_TOKEN'),
          ),
        );
      } catch (error) {
        setNotice(errorMessage(error));
      }
    }
  }

  function handleTokenChanged(status: TokenStatus): void {
    setBootstrap((current) =>
      current ? { ...current, token: status } : current,
    );
  }

  function goBack(): void {
    if (settingsDirty && !window.confirm('设置尚未保存，确定返回吗？')) {
      return;
    }
    setPage('upload');
  }

  if (loading) {
    return (
      <main className="boot-screen">
        <div className="brand-mark small">DSM</div>
        <p>正在读取本地配置…</p>
      </main>
    );
  }

  if (!bootstrap) {
    return (
      <main className="boot-screen">
        <div className="brand-mark small">DSM</div>
        <h1>无法启动应用</h1>
        <p className="error-text">{notice ?? '未知错误'}</p>
      </main>
    );
  }

  const active = Boolean(task && ACTIVE_STATUSES.has(task.status));
  const logsMode = page === 'logs';

  return (
    <div className="app-shell">
      <header className="app-bar drag-region">
        {page === 'upload' ? (
          <div className="brand">
            <div className="brand-mark">DSM</div>
            <div>
              <strong>文件同步助手</strong>
              <span>GitLab → 本地归档</span>
            </div>
          </div>
        ) : (
          <div className="app-bar-leading">
            <button type="button" className="back-button" onClick={goBack}>
              ← 返回
            </button>
            <h1 className="app-bar-title">{PAGE_TITLES[page]}</h1>
          </div>
        )}

        <div className="app-bar-actions">
          <div className="header-status">
            <span className={active ? 'pulse active' : 'pulse'} />
            {active ? '任务运行中' : '准备就绪'}
          </div>
          {page === 'upload' && (
            <>
              <button
                type="button"
                className="bar-button"
                onClick={() => setPage('logs')}
              >
                日志
              </button>
              <button
                type="button"
                className="bar-button"
                onClick={() => setPage('settings')}
              >
                设置
              </button>
            </>
          )}
        </div>
      </header>

      <main
        className={logsMode ? 'workspace logs-mode' : 'workspace'}
        ref={workspaceRef}
      >
        <div className={logsMode ? 'page-content logs-mode' : 'page-content'}>
          {notice && (
            <div className="notice" role="status">
              <span>{notice}</span>
              <button type="button" onClick={() => setNotice(null)}>
                关闭
              </button>
            </div>
          )}

          <section hidden={page !== 'upload'}>
            <UploadPage
              bootstrap={bootstrap}
              task={task}
              active={active}
              onTask={setTask}
              onOpenSettings={() => setPage('settings')}
              onNotice={setNotice}
            />
          </section>

          {page === 'settings' && (
            <SettingsPage
              bootstrap={bootstrap}
              locked={active}
              onSaved={(data, tokenSubmitted) => {
                void handleSaved(data, tokenSubmitted);
              }}
              onTokenChanged={handleTokenChanged}
              onDirtyChange={setSettingsDirty}
              onNotice={setNotice}
            />
          )}

          {page === 'logs' && <LogsPage onNotice={setNotice} />}
        </div>
      </main>

      {task && (
        <TaskDialog
          task={task}
          onTask={setTask}
          onOpenSettings={() => setPage('settings')}
          onNotice={setNotice}
        />
      )}
    </div>
  );
}
