import { useState } from 'react';

import type { BootstrapData } from '../shared.ts';
import { errorMessage, unwrap } from './api.ts';

interface TokenSetupPageProps {
  bootstrap: BootstrapData;
  onChanged: () => Promise<void>;
  onSkip: () => void;
  onNotice: (message: string | null) => void;
}

export function TokenSetupPage({
  bootstrap,
  onChanged,
  onSkip,
  onNotice,
}: TokenSetupPageProps): React.JSX.Element {
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);

  async function save(): Promise<void> {
    const submitted = token;
    setToken('');
    setBusy(true);
    try {
      await unwrap(window.dsm.saveToken(submitted));
      await onChanged();
      onNotice('Token 已验证并保存');
    } catch (error) {
      onNotice(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function clear(): Promise<void> {
    if (!window.confirm('确定清除当前 Token？预置 Token 不会自动恢复。'))
      return;
    setBusy(true);
    try {
      await unwrap(window.dsm.clearToken());
      await onChanged();
      onNotice('Token 已清除');
    } catch (error) {
      onNotice(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="form-layout">
      <section className="form-card">
        <div className="section-heading">
          <div>
            <span className="eyebrow">ACCESS</span>
            <h2>GitLab 访问令牌</h2>
          </div>
          <span
            className={`token-chip ${bootstrap.token.configured ? 'ready' : ''}`}
          >
            {bootstrap.token.configured ? '已配置' : '未配置'}
          </span>
        </div>
        <p className="lead">
          Token 仅在 Main 进程使用，不会回填到输入框或写入日志。需要
          <code>api</code> 权限以完成文件上传。
        </p>

        <label className="field">
          <span>新 Token</span>
          <input
            type="password"
            value={token}
            autoComplete="off"
            spellCheck={false}
            placeholder="glpat-…"
            onChange={(event) => setToken(event.target.value)}
          />
        </label>
        <div className="action-row">
          <button
            type="button"
            className="primary-button"
            disabled={!token.trim() || busy}
            onClick={() => void save()}
          >
            {busy ? '验证中…' : '验证并保存'}
          </button>
          {bootstrap.token.configured && (
            <button
              type="button"
              className="danger-button"
              disabled={busy}
              onClick={() => void clear()}
            >
              清除 Token
            </button>
          )}
          <button type="button" className="text-button" onClick={onSkip}>
            稍后设置
          </button>
        </div>
      </section>

      <aside className="info-panel token-status-panel">
        <span className="eyebrow">CURRENT SOURCE</span>
        <h3>
          {bootstrap.token.source === 'preset'
            ? '安装包预置'
            : bootstrap.token.source === 'user'
              ? '用户配置'
              : '未配置'}
        </h3>
        <p>
          {bootstrap.token.configured
            ? '当前已有可用 Token。重新输入并验证后会覆盖现有值。'
            : '应用仍可启动、修改本地设置和执行文件本地检查。'}
        </p>
        <div className="security-callout">
          <strong>明文存储说明</strong>
          <p>
            Token 按产品要求保存在用户数据目录的 <code>token.json</code>
            ，文件权限为 0600。同一系统用户仍可直接读取该文件。
          </p>
        </div>
      </aside>
    </div>
  );
}
