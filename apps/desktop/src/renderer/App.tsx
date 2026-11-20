import { useCallback, useEffect, useRef, useState } from 'react';

import type { TaskSnapshot, TokenStatus } from '@dsm/core';
import type { BootstrapData } from '../shared.ts';
import { errorMessage, unwrap } from './api.ts';
import { LogsPage } from './LogsPage.tsx';
import { ReaderDependencyDialog } from './ReaderDependencyDialog.tsx';
import { SettingsPage } from './SettingsPage.tsx';
import { TaskDialog } from './TaskDialog.tsx';
import { Toast } from './Toast.tsx';
import { UploadPage } from './UploadPage.tsx';

export type Page = 'upload' | 'settings' | 'logs';

type SubPage = Exclude<Page, 'upload'>;

interface ToastMessage {
  id: number;
  text: string;
}

const PAGE_TITLES: Record<SubPage, string> = {
  settings: '设置',
  logs: '运行日志',
};

const ACTIVE_STATUSES: ReadonlySet<TaskSnapshot['status']> = new Set([
  'CHECKING',
  'WAITING_FOR_TOKEN',
  'WAITING_FOR_OVERWRITE_CONFIRMATION',
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
  const [recentTasks, setRecentTasks] = useState<TaskSnapshot[]>([]);
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState<ToastMessage | null>(null);
  const [readerFailure, setReaderFailure] = useState(false);
  const [settingsDirty, setSettingsDirty] = useState(false);
  const toastSeq = useRef(0);
  const workspaceRef = useRef<HTMLElement>(null);

  const showNotice = useCallback((message: string | null): void => {
    if (message === null) {
      setToast(null);
      return;
    }
    toastSeq.current += 1;
    setToast({ id: toastSeq.current, text: message });
  }, []);

  const dismissToast = useCallback((): void => setToast(null), []);

  useEffect(() => {
    let active = true;
    void unwrap(window.dsm.bootstrap())
      .then((data) => {
        if (!active) return;
        setBootstrap(data);
        setTask(data.currentTask);
        setRecentTasks(mergeRecentTasks(data.currentTask, data.recentTasks));
      })
      .catch((error: unknown) => {
        if (active) showNotice(errorMessage(error));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    const unsubscribe = window.dsm.onTaskUpdate((snapshot) => {
      if (active) applyTask(snapshot);
    });
    const unsubscribeReaderCheck = window.dsm.onReaderCheckFailure(() => {
      if (active) setReaderFailure(true);
    });
    return () => {
      active = false;
      unsubscribe();
      unsubscribeReaderCheck();
    };
  }, [showNotice]);

  useEffect(() => {
    workspaceRef.current?.scrollTo(0, 0);
  }, [page]);

  async function handleSaved(
    data: BootstrapData,
    tokenSubmitted: boolean,
  ): Promise<void> {
    setBootstrap(data);
    setTask(data.currentTask);
    setRecentTasks((current) => mergeRecentTasks(data.currentTask, current));
    setSettingsDirty(false);

    const current = data.currentTask;
    if (
      tokenSubmitted &&
      data.token.configured &&
      current?.recoveryActions.includes('CONFIGURE_TOKEN')
    ) {
      try {
        applyTask(
          await unwrap(
            window.dsm.recoverTask(current.taskId, 'CONFIGURE_TOKEN'),
          ),
        );
      } catch (error) {
        showNotice(errorMessage(error));
      }
    }
  }

  function applyTask(snapshot: TaskSnapshot): void {
    setTask(snapshot);
    setRecentTasks((current) =>
      [
        snapshot,
        ...current.filter((item) => item.taskId !== snapshot.taskId),
      ].slice(0, 2),
    );
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
        <p>正在启动…</p>
      </main>
    );
  }

  if (!bootstrap) {
    return (
      <main className="boot-screen">
        <div className="brand-mark small">DSM</div>
        <h1>无法启动应用</h1>
        <p className="error-text">{toast?.text ?? '未知错误'}</p>
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
            <button
              type="button"
              className="brand-mark brand-mark-button"
              title="打开设置"
              onClick={() => setPage('settings')}
            >
              DSM
            </button>
            <strong>文件同步助手</strong>
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
          {page === 'upload' && (
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
          <section className="upload-page" hidden={page !== 'upload'}>
            <UploadPage
              bootstrap={bootstrap}
              task={task}
              recentTasks={recentTasks}
              active={active}
              onTask={applyTask}
              onOpenSettings={() => setPage('settings')}
              onNotice={showNotice}
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
              onNotice={showNotice}
            />
          )}

          {page === 'logs' && <LogsPage onNotice={showNotice} />}
        </div>
      </main>

      {task && (
        <TaskDialog
          task={task}
          onTask={applyTask}
          onOpenSettings={() => setPage('settings')}
          onNotice={showNotice}
        />
      )}

      {readerFailure && (
        <ReaderDependencyDialog
          onDismiss={() => setReaderFailure(false)}
          onResolved={() => setReaderFailure(false)}
          onNotice={showNotice}
        />
      )}

      {toast && (
        <Toast key={toast.id} message={toast.text} onDismiss={dismissToast} />
      )}
    </div>
  );
}

function mergeRecentTasks(
  current: TaskSnapshot | null,
  recent: TaskSnapshot[],
): TaskSnapshot[] {
  const seen = new Set<string>();
  return [...(current ? [current] : []), ...recent]
    .filter((task) => {
      if (seen.has(task.taskId)) return false;
      seen.add(task.taskId);
      return true;
    })
    .slice(0, 2);
}
