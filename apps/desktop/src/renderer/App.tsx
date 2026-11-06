import { useEffect, useState } from 'react';

import type { TaskSnapshot } from '@dsm/core';
import type { BootstrapData } from '../shared.ts';
import { errorMessage, unwrap } from './api.ts';
import { LogsPage } from './LogsPage.tsx';
import { SettingsPage } from './SettingsPage.tsx';
import { TaskDialog } from './TaskDialog.tsx';
import { TokenSetupPage } from './TokenSetupPage.tsx';
import { UploadPage } from './UploadPage.tsx';

export type Page = 'upload' | 'settings' | 'token' | 'logs';

const PAGE_TITLES: Record<Page, string> = {
  upload: '文件同步',
  settings: '连接设置',
  token: '访问令牌',
  logs: '运行日志',
};

export function App(): React.JSX.Element {
  const [page, setPage] = useState<Page>('upload');
  const [bootstrap, setBootstrap] = useState<BootstrapData | null>(null);
  const [task, setTask] = useState<TaskSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);

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

  async function refreshBootstrap(): Promise<BootstrapData> {
    const data = await unwrap(window.dsm.bootstrap());
    setBootstrap(data);
    setTask(data.currentTask);
    return data;
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

  const active = Boolean(
    task &&
    !['SUCCESS', 'SUCCESS_WITH_WARNING', 'FAILED'].includes(task.status),
  );

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="drag-region">
          <div className="brand">
            <div className="brand-mark">DSM</div>
            <div>
              <strong>文件同步助手</strong>
              <span>GitLab → 本地归档</span>
            </div>
          </div>
        </div>

        <nav className="nav-list" aria-label="主导航">
          {(
            [
              ['upload', '同步文件', '01'],
              ['settings', '连接设置', '02'],
              ['token', '访问令牌', '03'],
              ['logs', '运行日志', '04'],
            ] as Array<[Page, string, string]>
          ).map(([key, label, number]) => (
            <button
              key={key}
              type="button"
              className={page === key ? 'nav-item active' : 'nav-item'}
              onClick={() => setPage(key)}
            >
              <span>{number}</span>
              {label}
            </button>
          ))}
        </nav>

        <div className="connection-card">
          <span
            className={
              bootstrap.token.configured
                ? 'connection-dot online'
                : 'connection-dot'
            }
          />
          <div>
            <strong>
              {bootstrap.token.configured ? 'Token 已配置' : 'Token 未配置'}
            </strong>
            <span>{sourceLabel(bootstrap.token.source)}</span>
          </div>
        </div>
        <p className="version">
          v{bootstrap.appVersion} · {bootstrap.platformLabel}
        </p>
      </aside>

      <main className="workspace">
        <header className="page-header drag-region">
          <div>
            <span className="eyebrow">DSM WORKSPACE</span>
            <h1>{PAGE_TITLES[page]}</h1>
          </div>
          <div className="header-status">
            <span className={active ? 'pulse active' : 'pulse'} />
            {active ? '任务运行中' : '准备就绪'}
          </div>
        </header>

        {notice && (
          <div className="notice" role="status">
            <span>{notice}</span>
            <button type="button" onClick={() => setNotice(null)}>
              关闭
            </button>
          </div>
        )}

        <section className="page-content">
          {page === 'upload' && (
            <UploadPage
              bootstrap={bootstrap}
              task={task}
              active={active}
              onTask={setTask}
              onOpenSettings={() => setPage('settings')}
              onOpenToken={() => setPage('token')}
              onNotice={setNotice}
            />
          )}
          {page === 'settings' && (
            <SettingsPage
              bootstrap={bootstrap}
              locked={active}
              onSaved={(data) => {
                setBootstrap(data);
                setNotice('设置已保存');
              }}
              onNotice={setNotice}
            />
          )}
          {page === 'token' && (
            <TokenSetupPage
              bootstrap={bootstrap}
              onChanged={async () => {
                const data = await refreshBootstrap();
                if (
                  data.currentTask?.recoveryActions.includes('CONFIGURE_TOKEN')
                ) {
                  const resumed = await unwrap(
                    window.dsm.recoverTask(
                      data.currentTask.taskId,
                      'CONFIGURE_TOKEN',
                    ),
                  );
                  setTask(resumed);
                }
              }}
              onSkip={() => setPage('upload')}
              onNotice={setNotice}
            />
          )}
          {page === 'logs' && <LogsPage onNotice={setNotice} />}
        </section>
      </main>

      {task && (
        <TaskDialog
          task={task}
          onTask={setTask}
          onOpenToken={() => setPage('token')}
          onNotice={setNotice}
        />
      )}
    </div>
  );
}

function sourceLabel(source: BootstrapData['token']['source']): string {
  if (source === 'preset') return '来自安装包预置';
  if (source === 'user') return '来自用户配置';
  return '本地功能仍可使用';
}
