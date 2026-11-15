import { useState } from 'react';

import type { DependencyFailure } from '../shared.ts';
import { READER_INSTALL_PAGE_URL } from '../shared.ts';
import { errorMessage, unwrap } from './api.ts';

interface DependencyDialogProps {
  failure: DependencyFailure;
  onDismiss: () => void;
  onResolved: () => void;
  onNotice: (message: string) => void;
}

export function DependencyDialog({
  failure,
  onDismiss,
  onResolved,
  onNotice,
}: DependencyDialogProps): React.JSX.Element {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(failure.message || null);

  async function recheck(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await unwrap(window.dsm.recheckDependencies());
      onResolved();
      onNotice('读取器与 PowerShell 已就绪，可以开始解锁。');
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  }

  async function openInstallPage(): Promise<void> {
    try {
      await unwrap(window.dsm.openReaderInstallPage());
    } catch (reason) {
      onNotice(errorMessage(reason));
    }
  }

  return (
    <div className="dialog-backdrop" role="presentation">
      <section
        className="task-dialog dependency-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="dependency-title"
      >
        <div className="dialog-topline">
          <span className="pulse" />
          <span>缺少运行依赖</span>
        </div>

        <h2 id="dependency-title">未检测到可用的运行依赖</h2>

        {failure.reader && (
          <>
            <p className="task-message">
              读取器：未检测到可用的 Node 或 Python，无法读取 DSM 加密文件。
            </p>
            <p className="task-message dependency-link-line">
              安装页面：
              <a
                className="dependency-link"
                href={READER_INSTALL_PAGE_URL}
                title="在默认浏览器中打开安装页面"
                onClick={(event) => {
                  event.preventDefault();
                  void openInstallPage();
                }}
              >
                {READER_INSTALL_PAGE_URL}
              </a>
            </p>
            <p className="task-message">
              读取器安装包也可从 OneStep 软件库下载。
            </p>
          </>
        )}

        {failure.writer && (
          <p className="task-message">
            写入器：未检测到可用的 PowerShell。请安装 PowerShell，或在设置中填写
            powershell.exe 的完整路径；该程序需要加入 DSM 白名单。
          </p>
        )}

        {error && <p className="dependency-error">{error}</p>}

        <div className="dialog-actions">
          <button
            type="button"
            className="primary-button"
            disabled={busy}
            autoFocus
            onClick={() => void recheck()}
          >
            {busy ? '检测中…' : '重新检测'}
          </button>
          <button
            type="button"
            className="text-button"
            disabled={busy}
            onClick={onDismiss}
          >
            稍后
          </button>
        </div>
      </section>
    </div>
  );
}
