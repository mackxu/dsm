import { useEffect, useRef, useState } from 'react';

import type { CopyConfig, ReaderKind, ReaderSource } from '@dsm/core';

import type { BootstrapData, ReaderProbeResult } from '../shared.ts';
import { errorMessage, formatBytes, unwrap } from './api.ts';

const READER_LABELS: Record<ReaderKind, string> = {
  node: 'Node.js',
  python: 'Python',
};

const READER_SOURCE_LABELS: Record<ReaderSource, string> = {
  config: '手动填写',
  environment: '系统环境',
  auto: '自动查找',
};

interface SettingsPageProps {
  bootstrap: BootstrapData;
  locked: boolean;
  onSaved: (data: BootstrapData) => void;
  onDirtyChange: (dirty: boolean) => void;
  onNotice: (message: string | null) => void;
}

export function SettingsPage({
  bootstrap,
  locked,
  onSaved,
  onDirtyChange,
  onNotice,
}: SettingsPageProps): React.JSX.Element {
  const [form, setForm] = useState<CopyConfig>(bootstrap.config);
  const [saving, setSaving] = useState(false);
  const [probing, setProbing] = useState(false);
  const [writing, setWriting] = useState(false);
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

  const dirty = JSON.stringify(form) !== JSON.stringify(bootstrap.config);

  useEffect(() => {
    onDirtyChange(dirty);
  }, [dirty, onDirtyChange]);

  useEffect(() => {
    return () => onDirtyChange(false);
  }, [onDirtyChange]);

  function update<K extends keyof CopyConfig>(
    key: K,
    value: CopyConfig[K],
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
    setSaving(true);
    try {
      const data = await unwrap(
        window.dsm.saveSettings(locked ? bootstrap.config : form),
      );
      setForm(data.config);
      onSaved(data);
      onNotice('设置已保存');
    } catch (error) {
      if (moreRef.current) moreRef.current.open = true;
      onNotice(errorMessage(error));
    } finally {
      setSaving(false);
    }
  }

  async function probe(): Promise<void> {
    setProbing(true);
    try {
      const result = await unwrap(
        window.dsm.testReader({
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

  async function testWriter(): Promise<void> {
    setWriting(true);
    try {
      const result = await unwrap(window.dsm.testWriter(form));
      onNotice(
        `PowerShell 写入正常：${formatBytes(result.bytes)}，SHA-256 ${result.sha256.slice(0, 12)}…`,
      );
    } catch (error) {
      onNotice(errorMessage(error));
    } finally {
      setWriting(false);
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
              <small>
                留空时保存到文档目录下的 DSM
                文件夹；每次任务创建独立时间戳目录。
              </small>
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
          <span className="more-hint">大小 · 超时 · 读取器 · PowerShell</span>
          <span className="more-chevron" aria-hidden="true">
            ›
          </span>
        </summary>

        <fieldset
          className="settings-config-fieldset more-content"
          disabled={locked}
        >
          <div className="field-grid">
            <label className="field">
              <span>单文件上限（MB）</span>
              <input
                type="number"
                min={1}
                max={8192}
                value={form.maxCopyBytes / (1024 * 1024)}
                onChange={(event) =>
                  update(
                    'maxCopyBytes',
                    Math.max(
                      1,
                      Math.min(8192, Number(event.target.value) || 1),
                    ) *
                      1024 *
                      1024,
                  )
                }
              />
            </label>
            <label className="field">
              <span>复制超时（秒）</span>
              <input
                type="number"
                min={1}
                max={3600}
                value={form.copyTimeoutMs / 1000}
                onChange={(event) =>
                  update(
                    'copyTimeoutMs',
                    Math.max(
                      1,
                      Math.min(3600, Number(event.target.value) || 1),
                    ) * 1000,
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

            <label className="field wide">
              <span>PowerShell 路径</span>
              <div className="input-action">
                <input
                  value={form.powershellPath ?? ''}
                  placeholder="留空自动查找，例如 C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe"
                  onChange={(event) =>
                    update('powershellPath', event.target.value || null)
                  }
                />
                <button
                  type="button"
                  disabled={writing}
                  onClick={() => void testWriter()}
                >
                  {writing ? '测试中…' : '测试写入'}
                </button>
              </div>
              <small>
                留空时自动查找系统 PowerShell。该程序需在 DSM
                白名单中；测试写入会在保存目录创建 1 MB 临时文件，校验字节数与
                SHA-256 后删除。
              </small>
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
          disabled={saving || locked}
        >
          {saving ? '保存中…' : '保存设置'}
        </button>
        <span className="helper-text settings-lock-hint">
          {locked
            ? '任务运行期间配置暂时锁定。'
            : dirty
              ? '有未保存的修改。'
              : ''}
        </span>
      </div>

      <p className="settings-footer">
        v{bootstrap.appVersion} · {bootstrap.platformLabel}
      </p>
    </form>
  );
}
