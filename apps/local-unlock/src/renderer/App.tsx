import { useEffect, useRef, useState } from 'react';

import type { CopySnapshot } from '@dsm/core';

import type { BootstrapData, DependencyFailure } from '../shared.ts';
import { errorMessage, unwrap } from './api.ts';
import { CopyPage } from './CopyPage.tsx';
import { DependencyDialog } from './DependencyDialog.tsx';
import { LogsPage } from './LogsPage.tsx';
import { SettingsPage } from './SettingsPage.tsx';

export type Page = 'copy' | 'settings' | 'logs';

type SubPage = Exclude<Page, 'copy'>;

const PAGE_TITLES: Record<SubPage, string> = {
  settings: '设置',
  logs: '运行日志',
};

// 渲染进程只保留纯类型导入，避免把 @dsm/core 的 Node 依赖打进浏览器包。
const ACTIVE_COPY_STATUSES: ReadonlySet<CopySnapshot['status']> = new Set([
  'CHECKING',
  'COPYING',
  'VERIFYING',
]);

export function App(): React.JSX.Element {
  const [page, setPage] = useState<Page>('copy');
  const [bootstrap, setBootstrap] = useState<BootstrapData | null>(null);
  const [task, setTask] = useState<CopySnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);
  const [dependencyFailure, setDependencyFailure] =
    useState<DependencyFailure | null>(null);
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
    const unsubscribeTask = window.dsm.onTaskUpdate((snapshot) => {
      if (active) setTask(snapshot);
    });
    const unsubscribeDependency = window.dsm.onDependencyCheckFailure(
      (failure) => {
        if (active) setDependencyFailure(failure);
      },
    );
    return () => {
      active = false;
      unsubscribeTask();
      unsubscribeDependency();
    };
  }, []);

  useEffect(() => {
    workspaceRef.current?.scrollTo(0, 0);
  }, [page]);

  function handleSaved(data: BootstrapData): void {
    setBootstrap(data);
    setTask(data.currentTask);
    setSettingsDirty(false);
  }

  function goBack(): void {
    if (settingsDirty && !window.confirm('设置尚未保存，确定返回吗？')) {
      return;
    }
    setPage('copy');
  }

  if (loading) {
    return (
      <main className="boot-screen">
        <div className="brand-mark small">DSM</div>
        <p>正在启动…</p>
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

  const active = Boolean(task && ACTIVE_COPY_STATUSES.has(task.status));
  const logsMode = page === 'logs';

  return (
    <div className="app-shell">
      <header className="app-bar drag-region">
        {page === 'copy' ? (
          <div className="brand">
            <button
              type="button"
              className="brand-mark brand-mark-button"
              title="打开设置"
              onClick={() => setPage('settings')}
            >
              DSM
            </button>
            <strong>DSM UNLOCK</strong>
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
          <div
            className="header-status"
            title={active ? '任务运行中' : '准备就绪'}
            aria-label={active ? '任务运行中' : '准备就绪'}
          >
            <span className={active ? 'pulse active' : 'pulse'} />
          </div>
          {page === 'copy' && (
            <button
              type="button"
              className="bar-button"
              onClick={() => setPage('logs')}
            >
              日志
            </button>
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

          <section className="upload-page" hidden={page !== 'copy'}>
            <CopyPage
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
              onSaved={handleSaved}
              onDirtyChange={setSettingsDirty}
              onNotice={setNotice}
            />
          )}

          {page === 'logs' && <LogsPage onNotice={setNotice} />}
        </div>
      </main>

      {dependencyFailure && (
        <DependencyDialog
          failure={dependencyFailure}
          onDismiss={() => setDependencyFailure(null)}
          onResolved={() => setDependencyFailure(null)}
          onNotice={setNotice}
        />
      )}
    </div>
  );
}
