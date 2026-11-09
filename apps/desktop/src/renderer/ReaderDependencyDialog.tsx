import { useState } from 'react';

import { READER_INSTALL_PAGE_URL } from '../shared.ts';
import { errorMessage, unwrap } from './api.ts';

interface ReaderDependencyDialogProps {
  onDismiss: () => void;
  onResolved: () => void;
  onNotice: (message: string) => void;
}

export function ReaderDependencyDialog({
  onDismiss,
  onResolved,
  onNotice,
}: ReaderDependencyDialogProps): React.JSX.Element {
  const [busy, setBusy] = useState(false);
  const [recheckFailed, setRecheckFailed] = useState(false);

  async function recheck(): Promise<void> {
    setBusy(true);
    setRecheckFailed(false);
    try {
      await unwrap(window.dsm.recheckReader());
      onResolved();
      onNotice('前置依赖已就绪，可以开始同步任务。');
    } catch {
      setRecheckFailed(true);
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
          <span>缺少前置依赖</span>
        </div>

        <h2 id="dependency-title">未检测到可用的前置依赖</h2>
        <p className="task-message">安装前置依赖后，请点击「重新检测」。</p>
        <p className="task-message">
          前置依赖安装包也可从 OneStep 软件库下载。
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

        {recheckFailed && (
          <p className="dependency-error">
            仍未检测到可用的前置依赖，请完成安装后重试。
          </p>
        )}

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
