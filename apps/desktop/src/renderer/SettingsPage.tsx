import { useEffect, useRef, useState } from 'react';

import type { AppConfig, TokenStatus } from '@dsm/core';
import type { BootstrapData, ReaderProbeResult } from '../shared.ts';
import { errorMessage, formatBytes, unwrap } from './api.ts';

const READER_LABELS: Record<'node' | 'python', string> = {
  node: 'Node.js',
  python: 'Python',
};

const READER_SOURCE_LABELS: Record<'config' | 'environment' | 'auto', string> =
  {
    config: '手动填写',
    environment: '系统环境',
    auto: '自动查找',
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
      onSaved(result.bootstrap, Boolean(submittedToken));
      onNotice(submittedToken ? '设置与访问令牌已保存' : '设置已保存');
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
      await unwrap(window.dsm.testConnection());
      onNotice('连接成功');
    } catch (error) {
      onNotice(errorMessage(error));
    } finally {
      setTesting(false);
    }
  }

  async function clearToken(): Promise<void> {
    if (!window.confirm('确定清除当前访问令牌？预置令牌不会自动恢复。')) {
      return;
    }
    setClearing(true);
    try {
      const status = await unwrap(window.dsm.clearToken());
      setToken('');
      onTokenChanged(status);
      onNotice('访问令牌已清除');
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
        ? `默认读取方式 ${READER_LABELS[result.preferredReader]} 不可用，已改用 ${READER_LABELS[result.usedReader]}。`
        : '';
      onNotice(
        result.identical
          ? `${prefix}两次读取结果一致，文件可能未加密`
          : `${prefix}两次读取结果不同，通常说明已成功解密`,
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
            <span className="eyebrow">基础</span>
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
                {clearing ? '清除中…' : '清除令牌'}
              </button>
            )}
          </div>
          <label className="field">
            <span>更新访问令牌</span>
            <input
              type="password"
              value={token}
              autoComplete="off"
              spellCheck={false}
              placeholder="粘贴新的访问令牌，留空则不修改"
              onChange={(event) => setToken(event.target.value)}
            />
          </label>
          <small className="token-hint">
            访问令牌仅用于连接同步服务，不会显示在界面或写入日志。
          </small>
        </div>

        <fieldset className="settings-config-fieldset" disabled={locked}>
          <div className="field-grid">
            <label className="field wide">
              <span>保存位置</span>
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
              <small>留空时保存到文档目录下的 DSM 文件夹。</small>
            </label>
          </div>
        </fieldset>
      </section>

      <details className="settings-section more-section" ref={moreRef}>
        <summary>
          <div>
            <span className="eyebrow">更多</span>
            <h2>更多配置</h2>
          </div>
          <span className="more-hint">连接 · 超时 · 文件读取 · 压缩包</span>
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
              <span>服务地址</span>
              <input
                value={form.gitlabUrl}
                placeholder="https://example.com"
                onChange={(event) => update('gitlabUrl', event.target.value)}
              />
              <small>填写同步服务的访问地址即可。</small>
            </label>
            <label className="field">
              <span>项目</span>
              <input
                value={form.projectId}
                placeholder="编号或路径"
                onChange={(event) => update('projectId', event.target.value)}
              />
            </label>
            <label className="field">
              <span>目标分支</span>
              <input
                value={form.branch}
                onChange={(event) => update('branch', event.target.value)}
              />
              <small>同步的文件会提交到这个分支。</small>
            </label>
          </div>

          <div className="field-grid three more-grid">
            <label className="field">
              <span>连接超时（秒）</span>
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
              <span>上传上限（MB）</span>
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
              <span>默认读取方式</span>
              <div className="reader-choice">
                <label>
                  <input
                    type="radio"
                    name="preferredReader"
                    checked={form.preferredReader === 'node'}
                    onChange={() => update('preferredReader', 'node')}
                  />
                  Node.js
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
                仅在文件被 DSM
                加密、应用无法直接读取时使用。一般保持默认即可，应用会自动查找可用的程序。
              </small>
            </div>

            {form.preferredReader === 'node' ? (
              <label className="field wide">
                <span>Node.js 路径</span>
                <div className="input-action">
                  <input
                    value={form.nodeReaderPath ?? ''}
                    placeholder="留空自动查找，例如 C:\Program Files\nodejs\node.exe"
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
                  一般留空。只有在自动查找失败时，才填写 DSM 允许读取文件的
                  Node.js 完整路径。
                </small>
              </label>
            ) : (
              <label className="field wide">
                <span>Python 路径</span>
                <div className="input-action">
                  <input
                    value={form.pythonReaderPath ?? ''}
                    placeholder="留空自动查找，例如 C:\Program Files\Python312\python.exe"
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
                  一般留空。只有在自动查找失败时，才填写 DSM 允许读取文件的
                  Python 完整路径。
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
                <strong>同步后保留压缩包</strong>
                <small>默认在解压完成后删除下载的压缩包。</small>
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
                  {probeResult.identical ? '结果相同' : '结果不同'}
                </span>
              </div>
              <dl>
                <div>
                  <dt>默认方式</dt>
                  <dd>
                    {READER_LABELS[probeResult.preferredReader]}
                    {probeResult.fallbackUsed
                      ? '（自动查找失败，已改用另一种）'
                      : ''}
                  </dd>
                </div>
                <div>
                  <dt>实际使用</dt>
                  <dd className="reader-path">
                    {READER_LABELS[probeResult.usedReader]}{' '}
                    {probeResult.readerVersion} · {probeResult.readerPath}
                  </dd>
                </div>
                <div>
                  <dt>来源</dt>
                  <dd>{READER_SOURCE_LABELS[probeResult.readerSource]}</dd>
                </div>
                <div>
                  <dt>直接读取</dt>
                  <dd>
                    {formatBytes(probeResult.directSize)} ·{' '}
                    {probeResult.directHead}
                  </dd>
                </div>
                <div>
                  <dt>经读取程序</dt>
                  <dd>
                    {formatBytes(probeResult.readerSize)} ·{' '}
                    {probeResult.readerHead}
                  </dd>
                </div>
              </dl>
              <p>
                {probeResult.identical
                  ? '两次读取结果相同：文件可能未加密，或读取程序不在 DSM 允许列表中。'
                  : '两次读取结果不同：通常说明已成功读取解密后的内容，请确认文件可以正常打开。'}
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
          {saving ? '保存中…' : locked ? '保存令牌' : '保存设置'}
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
            ? '任务运行期间仅可更新访问令牌，其他设置暂时锁定。'
            : dirty
              ? '请先保存修改，再测试连接。'
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
  if (status.source === 'preset') return '随安装包预置';
  if (status.source === 'user') {
    return status.configured ? '手动设置' : '已清除';
  }
  return '未设置';
}
