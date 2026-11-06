import { useEffect, useState } from 'react';

import type { AppConfig } from '@dsm/core';
import type {
  BootstrapData,
  ConnectionResult,
  ReaderProbeResult,
} from '../shared.ts';
import { errorMessage, formatBytes, unwrap } from './api.ts';

interface SettingsPageProps {
  bootstrap: BootstrapData;
  locked: boolean;
  onSaved: (data: BootstrapData) => void;
  onNotice: (message: string | null) => void;
}

export function SettingsPage({
  bootstrap,
  locked,
  onSaved,
  onNotice,
}: SettingsPageProps): React.JSX.Element {
  const [form, setForm] = useState<AppConfig>(bootstrap.config);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [probing, setProbing] = useState(false);
  const [connection, setConnection] = useState<ConnectionResult | null>(null);
  const [probeResult, setProbeResult] = useState<ReaderProbeResult | null>(
    null,
  );

  useEffect(() => {
    setForm(bootstrap.config);
  }, [bootstrap.config]);

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
    setSaving(true);
    try {
      const data = await unwrap(window.dsm.saveSettings(form));
      onSaved(data);
      setForm(data.config);
      if (data.token.configured) {
        setConnection(await unwrap(window.dsm.testConnection()));
      }
    } catch (error) {
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

  async function probe(): Promise<void> {
    setProbing(true);
    try {
      const result = await unwrap(
        window.dsm.testFileReader(form.nodeReaderPath),
      );
      setProbeResult(result);
      onNotice(
        result.identical
          ? '两种读取方式内容一致，请确认该文件是否受 DSM 加密'
          : 'Node 读取内容与主进程不同，通常说明已解密',
      );
    } catch (error) {
      onNotice(errorMessage(error));
    } finally {
      setProbing(false);
    }
  }

  return (
    <div className="settings-layout">
      <section className="form-card settings-form">
        <div className="section-heading">
          <div>
            <span className="eyebrow">CONNECTION</span>
            <h2>GitLab 与归档设置</h2>
          </div>
          {locked && <span className="locked-chip">任务期间已锁定</span>}
        </div>

        <fieldset disabled={locked}>
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
                绝对路径。留空时自动探测，找不到则回退主进程读取。
              </small>
            </label>
            <label className="toggle-field">
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
        </fieldset>

        <div className="action-row">
          <button
            type="button"
            className="primary-button"
            disabled={locked || saving}
            onClick={() => void save()}
          >
            {saving ? '保存并验证…' : '保存设置'}
          </button>
          <button
            type="button"
            className="secondary-button"
            disabled={locked || testing || !bootstrap.token.configured}
            onClick={() => void test()}
          >
            {testing ? '测试中…' : '测试连接'}
          </button>
        </div>
      </section>

      <aside className="side-column">
        <div className="info-panel">
          <span className="eyebrow">VALIDATION</span>
          {connection ? (
            <>
              <h3>{connection.projectPath}</h3>
              <dl>
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
            </>
          ) : (
            <>
              <h3>
                {bootstrap.token.configured ? '等待连接验证' : 'Token 未配置'}
              </h3>
              <p>
                {bootstrap.token.configured
                  ? '保存设置时可验证当前连接。'
                  : '没有 Token 仍可保存本地配置。'}
              </p>
            </>
          )}
        </div>
        {probeResult && (
          <div className="info-panel">
            <span className="eyebrow">READER TEST</span>
            <h3>{probeResult.fileName}</h3>
            <dl>
              <div>
                <dt>Node</dt>
                <dd>
                  {probeResult.nodeVersion} · {probeResult.nodePath}
                </dd>
              </div>
              <div>
                <dt>主进程读取</dt>
                <dd>
                  {formatBytes(probeResult.directSize)} ·{' '}
                  {probeResult.directHead}
                </dd>
              </div>
              <div>
                <dt>Node 读取</dt>
                <dd>
                  {formatBytes(probeResult.readerSize)} ·{' '}
                  {probeResult.readerHead}
                </dd>
              </div>
              <div>
                <dt>内容一致</dt>
                <dd>{probeResult.identical ? '是' : '否'}</dd>
              </div>
            </dl>
            <p>
              {probeResult.identical
                ? '两者一致：文件可能未受 DSM 管控，或该 Node 未被 DSM 解密。'
                : '两者不同：Node 读取到了不同内容，通常说明已解密；请确认文件可正常打开。'}
            </p>
          </div>
        )}
        <div className="safety-note">
          <strong>保存不是写权限证明</strong>
          <p>
            项目读取成功不代表目标分支允许写入；受保护分支权限会在实际上传时返回明确错误。
          </p>
        </div>
      </aside>
    </div>
  );
}
