import { useEffect, useRef, useState } from 'react';

import type { AppConfig, TokenStatus } from '@dsm/core';
import type {
  BootstrapData,
  ConnectionResult,
  ReaderProbeResult,
} from '../shared.ts';
import { errorMessage, formatBytes, unwrap } from './api.ts';

const READER_LABELS: Record<'node' | 'python', string> = {
  node: 'Node',
  python: 'Python',
};

const READER_SOURCE_LABELS: Record<'config' | 'environment' | 'auto', string> =
  {
    config: '设置路径',
    environment: '环境变量',
    auto: '自动探测',
  };

interface SettingsPageProps {
  bootstrap: BootstrapData;
  locked: boolean;
  onSaved: (data: BootstrapData, tokenSubmitted: boolean) => void;
  onTokenChanged: (status: TokenStatus) => void;
  onDirtyChange: (dirty: boolean) => void;
  onNotice: (message: string | null) => void;
}

export function SettingsPage({
  bootstrap,
  locked,
  onSaved,
  onTokenChanged,
  onDirtyChange,
  onNotice,
}: SettingsPageProps): React.JSX.Element {
  const [form, setForm] = useState<AppConfig>(bootstrap.config);
  const [token, setToken] = useState('');
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [probing, setProbing] = useState(false);
  const [connection, setConnection] = useState<ConnectionResult | null>(null);
  const [probeResult, setProbeResult] = useState<ReaderProbeResult | null>(
    null,
  );
  const moreRef = useRef<HTMLDetailsElement>(null);

  useEffect(() => {
    setForm(bootstrap.config);
  }, [bootstrap.config]);

  useEffect(() => {
    if (locked) setForm(bootstrap.config);
  }, [locked, bootstrap.config]);

  const dirty =
    Boolean(token.trim()) ||
    JSON.stringify(form) !== JSON.stringify(bootstrap.config);

  useEffect(() => {
    onDirtyChange(dirty);
  }, [dirty, onDirtyChange]);

  useEffect(() => {
    return () => onDirtyChange(false);
  }, [onDirtyChange]);

  function update<K extends keyof AppConfig>(
    key: K,
    value: AppConfig[K],
  ): void {
    setForm((current) => ({ ...current, [key]: value }));
  }

  async function chooseDirectory(): Promise<void> {
    try {
      const selected = await unwrap(window.dsm.chooseDirectory());
      if (selected) update('saveDirectory', selected);
    } catch (error) {
      onNotice(errorMessage(error));
    }
  }

  async function save(): Promise<void> {
    const submittedToken = token.trim();
    setSaving(true);
    try {
      const result = await unwrap(
        window.dsm.saveSettings(
          locked ? bootstrap.config : form,
          submittedToken || undefined,
        ),
      );
      setToken('');
      setForm(result.bootstrap.config);
      setConnection(result.connection);
      onSaved(result.bootstrap, Boolean(submittedToken));
      onNotice(submittedToken ? '设置与 Token 已保存' : '设置已保存');
    } catch (error) {
      if (moreRef.current) moreRef.current.open = true;
      onNotice(errorMessage(error));
    } finally {
      setSaving(false);
    }
  }

  async function test(): Promise<void> {
    setTesting(true);
    try {
      const result = await unwrap(window.dsm.testConnection());
      setConnection(result);
      onNotice(`连接成功：${result.projectPath}`);
    } catch (error) {
      onNotice(errorMessage(error));
    } finally {
      setTesting(false);
    }
  }

  async function clearToken(): Promise<void> {
    if (!window.confirm('确定清除当前 Token？预置 Token 不会自动恢复。')) {
      return;
    }
    setClearing(true);
    try {
      const status = await unwrap(window.dsm.clearToken());
      setToken('');
      setConnection(null);
      onTokenChanged(status);
      onNotice('Token 已清除');
    } catch (error) {
      onNotice(errorMessage(error));
    } finally {
      setClearing(false);
    }
  }

  async function probe(): Promise<void> {
    setProbing(true);
    try {
      const result = await unwrap(
        window.dsm.testFileReader({
          preferredReader: form.preferredReader,
          nodeReaderPath: form.nodeReaderPath,
          pythonReaderPath: form.pythonReaderPath,
        }),
      );
      setProbeResult(result);
      const prefix = result.fallbackUsed
        ? `优先读取器 ${READER_LABELS[result.preferredReader]} 不可用，已使用 ${READER_LABELS[result.usedReader]}。`
        : '';
      onNotice(
        result.identical
          ? `${prefix}两种读取方式内容一致，请确认该文件是否受 DSM 加密`
          : `${prefix}${READER_LABELS[result.usedReader]} 读取内容与主进程不同，通常说明已解密`,
      );
    } catch (error) {
      onNotice(errorMessage(error));
    } finally {
      setProbing(false);
    }
  }

  return (
    <form
      className="settings-page"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <section className="settings-section">
        <div className="section-heading">
          <div>
            <span className="eyebrow">BASIC</span>
            <h2>基础设置</h2>
          </div>
          {locked && <span className="locked-chip">任务期间配置已锁定</span>}
        </div>

        <div className="token-block">
          <div className="token-block-head">
            <span className="token-label">访问令牌</span>
            <span
              className={`token-chip ${bootstrap.token.configured ? 'ready' : ''}`}
            >
              {bootstrap.token.configured ? '已配置' : '未配置'}
            </span>
            <span className="token-meta">
              来源：{tokenSourceLabel(bootstrap.token)}
            </span>
            {bootstrap.token.configured && (
              <button
                type="button"
                className="text-button danger-text token-clear"
                disabled={clearing}
                onClick={() => void clearToken()}
              >
                {clearing ? '清除中…' : '清除 Token'}
              </button>
            )}
          </div>
          <label className="field">
            <span>新 Token</span>
            <input
              type="password"
              value={token}
              autoComplete="off"
              spellCheck={false}
              placeholder="glpat-…（留空表示不修改）"
              onChange={(event) => setToken(event.target.value)}
            />
          </label>
          <small className="token-hint">
            Token 仅在 Main 进程使用，不会回填或写入日志；需要
            <code>api</code> 权限。
          </small>
          {connection && (
            <div className="connection-result">
              <dl>
                <div>
                  <dt>项目</dt>
                  <dd>{connection.projectPath}</dd>
                </div>
                <div>
                  <dt>用户</dt>
                  <dd>
                    {connection.username} ({connection.userId})
                  </dd>
                </div>
                <div>
                  <dt>默认分支</dt>
                  <dd>{connection.defaultBranch ?? '空仓库'}</dd>
                </div>
                <div>
                  <dt>目标分支</dt>
                  <dd>{connection.branchExists ? '已存在' : '需要创建确认'}</dd>
                </div>
              </dl>
              <small>连接成功不代表目标分支允许写入。</small>
            </div>
          )}
        </div>

        <fieldset className="settings-config-fieldset" disabled={locked}>
          <div className="field-grid">
            <label className="field wide">
              <span>保存目录</span>
              <div className="input-action">
                <input
                  value={form.saveDirectory ?? ''}
                  placeholder={bootstrap.resolvedSaveDirectory}
                  onChange={(event) =>
                    update('saveDirectory', event.target.value || null)
                  }
                />
                <button type="button" onClick={() => void chooseDirectory()}>
                  选择…
                </button>
              </div>
              <small>留空时使用文档目录下的 DSM。</small>
            </label>
          </div>
        </fieldset>
      </section>

      <details className="settings-section more-section" ref={moreRef}>
        <summary>
          <div>
            <span className="eyebrow">MORE</span>
            <h2>更多设置</h2>
          </div>
          <span className="more-hint">连接信息 · 超时 · 读取器 · 归档</span>
          <span className="more-chevron" aria-hidden="true">
            ›
          </span>
        </summary>

        <fieldset
          className="settings-config-fieldset more-content"
          disabled={locked}
        >
          <div className="field-grid">
            <label className="field wide">
              <span>GitLab 地址</span>
              <input
                value={form.gitlabUrl}
                placeholder="https://gitlab.example.com"
                onChange={(event) => update('gitlabUrl', event.target.value)}
              />
              <small>填写服务根地址，不包含 /api/v4。</small>
            </label>
            <label className="field">
              <span>项目 ID</span>
              <input
                value={form.projectId}
                placeholder="123 或 group/project"
                onChange={(event) => update('projectId', event.target.value)}
              />
            </label>
            <label className="field">
              <span>目标分支</span>
              <input
                value={form.branch}
                onChange={(event) => update('branch', event.target.value)}
              />
            </label>
          </div>

          <div className="field-grid three more-grid">
            <label className="field">
              <span>API 超时（秒）</span>
              <input
                type="number"
                min={1}
                value={form.apiTimeoutMs / 1000}
                onChange={(event) =>
                  update('apiTimeoutMs', Number(event.target.value) * 1000)
                }
              />
            </label>
            <label className="field">
              <span>下载超时（秒）</span>
              <input
                type="number"
                min={1}
                value={form.downloadTimeoutMs / 1000}
                onChange={(event) =>
                  update('downloadTimeoutMs', Number(event.target.value) * 1000)
                }
              />
            </label>
            <label className="field">
              <span>最大上传（MiB）</span>
              <input
                type="number"
                min={1}
                max={50}
                value={form.maxUploadBytes / (1024 * 1024)}
                onChange={(event) =>
                  update(
                    'maxUploadBytes',
                    Math.min(50, Number(event.target.value)) * 1024 * 1024,
                  )
                }
              />
            </label>
          </div>

          <div className="field-grid more-grid">
            <div className="field wide">
              <span>优先读取器</span>
              <div className="reader-choice">
                <label>
                  <input
                    type="radio"
                    name="preferredReader"
                    checked={form.preferredReader === 'node'}
                    onChange={() => update('preferredReader', 'node')}
                  />
                  Node
                </label>
                <label>
                  <input
                    type="radio"
                    name="preferredReader"
                    checked={form.preferredReader === 'python'}
                    onChange={() => update('preferredReader', 'python')}
                  />
                  Python
                </label>
              </div>
              <small>
                优先使用选中的读取器；只有它的自动探测完全找不到时，才会回退到另一个。
                显式填写的路径不可执行会直接失败。
              </small>
            </div>

            {form.preferredReader === 'node' ? (
              <label className="field wide">
                <span>DSM 读取 Node 路径</span>
                <div className="input-action">
                  <input
                    value={form.nodeReaderPath ?? ''}
                    placeholder="留空自动探测，例如 C:\Program Files\nodejs\node.exe"
                    onChange={(event) =>
                      update('nodeReaderPath', event.target.value || null)
                    }
                  />
                  <button
                    type="button"
                    disabled={probing}
                    onClick={() => void probe()}
                  >
                    {probing ? '测试中…' : '选择文件测试'}
                  </button>
                </div>
                <small>
                  填写 DSM 进程白名单中的 node
                  绝对路径。留空时自动探测，找不到则尝试另一个读取器；显式填写但不可执行会直接失败。
                </small>
              </label>
            ) : (
              <label className="field wide">
                <span>DSM 读取 Python 路径</span>
                <div className="input-action">
                  <input
                    value={form.pythonReaderPath ?? ''}
                    placeholder="留空自动探测，例如 C:\Program Files\Python312\python.exe"
                    onChange={(event) =>
                      update('pythonReaderPath', event.target.value || null)
                    }
                  />
                  <button
                    type="button"
                    disabled={probing}
                    onClick={() => void probe()}
                  >
                    {probing ? '测试中…' : '选择文件测试'}
                  </button>
                </div>
                <small>
                  填写 DSM 进程白名单中的 python 绝对路径，不建议使用 py.exe 或
                  Microsoft Store
                  别名。留空时自动探测，找不到则尝试另一个读取器；显式填写但不可执行会直接失败。
                </small>
              </label>
            )}

            <label className="toggle-field wide">
              <input
                type="checkbox"
                checked={form.keepArchive}
                onChange={(event) =>
                  update('keepArchive', event.target.checked)
                }
              />
              <span>
                <strong>成功后保留 ZIP</strong>
                <small>默认在解压成功后删除归档文件。</small>
              </span>
            </label>
          </div>

          {probeResult && (
            <div className="probe-result">
              <div className="probe-result-head">
                <strong>{probeResult.fileName}</strong>
                <span
                  className={
                    probeResult.identical
                      ? 'probe-verdict same'
                      : 'probe-verdict different'
                  }
                >
                  {probeResult.identical ? '内容一致' : '内容不同'}
                </span>
              </div>
              <dl>
                <div>
                  <dt>优先读取器</dt>
                  <dd>
                    {READER_LABELS[probeResult.preferredReader]}
                    {probeResult.fallbackUsed ? '（自动探测失败，已回退）' : ''}
                  </dd>
                </div>
                <div>
                  <dt>实际读取器</dt>
                  <dd className="reader-path">
                    {READER_LABELS[probeResult.usedReader]}{' '}
                    {probeResult.readerVersion} · {probeResult.readerPath}
                  </dd>
                </div>
                <div>
                  <dt>解析来源</dt>
                  <dd>{READER_SOURCE_LABELS[probeResult.readerSource]}</dd>
                </div>
                <div>
                  <dt>主进程读取</dt>
                  <dd>
                    {formatBytes(probeResult.directSize)} ·{' '}
                    {probeResult.directHead}
                  </dd>
                </div>
                <div>
                  <dt>{READER_LABELS[probeResult.usedReader]} 读取</dt>
                  <dd>
                    {formatBytes(probeResult.readerSize)} ·{' '}
                    {probeResult.readerHead}
                  </dd>
                </div>
              </dl>
              <p>
                {probeResult.identical
                  ? '两者一致：文件可能未受 DSM 管控，或该读取器未被 DSM 解密。'
                  : `两者不同：${READER_LABELS[probeResult.usedReader]} 读取到了不同内容，通常说明已解密；请确认文件可正常打开。`}
              </p>
            </div>
          )}
        </fieldset>
      </details>

      <div className="settings-actions">
        <button
          type="submit"
          className="primary-button"
          disabled={saving || (locked && !token.trim())}
        >
          {saving ? '保存中…' : locked ? '保存 Token' : '保存设置'}
        </button>
        <button
          type="button"
          className="secondary-button"
          disabled={locked || testing || dirty || !bootstrap.token.configured}
          onClick={() => void test()}
        >
          {testing ? '测试中…' : '测试连接'}
        </button>
        <span className="helper-text settings-lock-hint">
          {locked
            ? '任务运行期间仅可更新 Token，配置字段已锁定。'
            : dirty
              ? '测试连接使用已保存的设置，请先保存当前修改。'
              : ''}
        </span>
      </div>

      <p className="settings-footer">
        v{bootstrap.appVersion} · {bootstrap.platformLabel}
      </p>
    </form>
  );
}

function tokenSourceLabel(status: BootstrapData['token']): string {
  if (status.source === 'preset') return '安装包预置';
  if (status.source === 'user') {
    return status.configured ? '用户配置' : '用户已清除';
  }
  return '未配置';
}
