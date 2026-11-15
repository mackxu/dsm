# 新建本地直写 app（DSM UNLOCK），替代 GitLab 上传与归档下载

## Context

现有 `apps/desktop` 的同步链路是：白名单 Node/Python 读取 DSM 透明加密文件明文 → 上传 GitLab 任务分支 → 下载分支归档 → 安全解压出单个文件。GitLab 往返对一个“本机文件落到保存目录”的需求来说链路长、依赖网络与服务端状态，失败恢复点也多。

本次新建一个独立 Electron 应用（`apps/local-unlock`，产品名「DSM UNLOCK」），把这条链路替换为本地直写：

```text
白名单 Node/Python stdout（明文）
  → 主进程管道（限流 + SHA-256）
  → PowerShell stdin
  → .NET FileStream 写入目标目录临时文件
  → Node 校验字节数/哈希后原子 rename 到最终文件
```

读取语义完全沿用现有实现；旧 `apps/desktop` 保留 GitLab 模式，两者独立打包、并存。

已确认的产品决策：

1. 新 app 是 `apps/` 下的独立 Electron 桌面应用。
2. 新旧并存，旧 desktop 的 GitLab 上传/归档下载不删除、不改变行为。
3. 输出布局沿用现有结果结构：`保存目录/<UTC+8 时间戳>-<任务ID前6位>/<原文件名>`。
4. 明文端到端流式传输：读取器 stdout → 主进程 → PowerShell stdin → .NET FileStream，不落临时明文文件。
5. PowerShell 负责写入；读取仍走既有白名单读取器链（显式配置失败不回退，仅自动探测失败才回退）。

## 架构

```text
Renderer (React)
  └─ preload contextBridge
       └─ IPC (main)
            ├─ CopyController（@dsm/core，纯 Node，无 Electron）
            │    ├─ FileStreamReader ── WhitelistedFileReader.openStream
            │    └─ FileStreamWriter ── PowerShellFileWriter（powershell.exe + dsm-file-writer.ps1）
            ├─ CopyConfigStore / Logger
            └─ 启动依赖检查（读取器 + PowerShell）
```

关键复用：

- 读取器解析链、helper 协议、启动探测、日志、窗口尺寸从 `apps/desktop/src/main/*` 抽取为共享包 `@dsm/desktop-runtime`，旧 app 改 import，行为不变。
- 时间戳复用 `packages/core/src/timestamp.ts` 的 `createUtc8Timestamp`。
- 保存目录解析复用/泛化 `packages/core/src/config.ts` 的 `resolveSaveDirectory`。
- 旧 app 读取器测试、启动探测测试迁移 import 后继续覆盖共享逻辑。

## 文件改动

### 1. 新共享包 `packages/desktop-runtime`（`@dsm/desktop-runtime`）

从 `apps/desktop/src/main/` 移入（内容基本原样）：

- `logger.ts`
- `reader-executable.ts`（含 `minimalEnvironment`、`normalizeCommand`）
- `node-path.ts`
- `python-path.ts`
- `reader-chain.ts`
- `whitelisted-file-reader.ts`（新增流式 API，见下）
- `startup-reader-check.ts`
- `window-size.ts`

新增：

- `package.json`：`"exports": { ".": "./src/index.ts" }`，`dependencies: { "@dsm/core": "workspace:*" }`，`typecheck` 脚本。
- `tsconfig.json`：沿用 `packages/core/tsconfig.json` 的配置。
- `src/index.ts`：导出以上模块。
- `src/powershell-writer.ts`：PowerShell 写入器（见下）。

`whitelisted-file-reader.ts` 的调整：

- `ReaderProbeResult` / `ReaderCheckResult` 改从 `@dsm/core` 导入（这两个纯类型下沉到 core）。
- 新增：

```ts
interface FileReadStream {
  stream: Readable;              // helper stdout，经限流 Transform
  completed: Promise<number>;    // 退出码 0 时返回总字节数
  abort(): void;                 // 杀 helper 进程
}

openStream(filePath, { maxBytes, timeoutMs }): Promise<FileReadStream>
```

语义与 `read()` 一致：`resolveReaderChain` → `ensureHelper` → 相同参数与最小环境 spawn。流式实现需处理：

- 字节超限：限流 Transform 报 `FILE_TOO_LARGE` 并 kill helper。
- 超时：kill 并 reject `FILE_READ_FAILED`（recoverable）。
- helper stderr JSON / 非零退出码：复用 `parseHelperError`。
- 空输出：`FILE_READ_FAILED`。
- `abort()` / 消费端提前断开：避免未处理的 stream error，`completed` 以取消错误结束。
- 保持 `read()`、`probe()`、`checkAvailability()`、`reset()` 现有行为不变；`read()` 可继续走原缓冲路径，不改动旧语义。

### 2. 新增 PowerShell 写入脚本 `resources/dsm-file-writer.ps1`

协议与现有读取 helper 对齐，作为 `extraResource` 打包到 asar 外：

- 入参全部通过环境变量：`COPY_TARGET_DIR`、`COPY_FILE_NAME`、`COPY_TEMP_NAME`。脚本内容固定，不拼接用户路径。
- stdin：原始明文字节。
- 处理：
  1. `$ErrorActionPreference = 'Stop'`，`[Console]::OutputEncoding = UTF8`（无 BOM）。
  2. `[System.IO.File]::Open(tempPath, CreateNew, Write, None, 65536, SequentialScan)` 打开目标目录下的临时文件名（Node 传入 `.dsm-copy-<taskId>.part`）。
  3. 循环 `[Console]::OpenStandardInput().Read(buffer, 0, 65536)`，写 FileStream；结束时 `Flush($true)`。
  4. 用 .NET `SHA256` 对临时文件计算哈希（不依赖 PowerShell 版本差异）。
  5. stdout 输出纯 ASCII JSON：`{"bytes":N,"sha256":"hex"}`。
  6. 失败：尽力删除临时文件，stderr 输出 `{"code":"WRITE_FAILED","messageBase64":"..."}`，退出码 1。
- **脚本不负责移动文件**；Node 校验成功后再 `fs.rename` 到最终文件名，失败时由 Node 删除临时文件。

PowerShell 5.1 兼容性要点：使用 `-File` 调用而非 `-EncodedCommand`；stdout 只用 ASCII JSON；stderr 消息用 UTF-8 Base64，避免 5.1 控制台编码差异。

### 3. Core 新增本地复制能力

`packages/core/src/errors.ts`：

- `TaskStage` 增加 `'COPY' | 'VERIFY'`。
- `DsmErrorCode` 增加 `'WRITER_UNAVAILABLE' | 'WRITE_FAILED' | 'WRITE_VERIFY_FAILED'`。

`packages/core/src/reader.ts`（新）：

- 从 `apps/desktop/src/shared.ts` 下沉 `ReaderProbeResult`、`ReaderCheckResult`。

`packages/core/src/copy/copy-config.ts`（新）：

```ts
interface CopyConfig {
  schemaVersion: 1;
  saveDirectory: string | null;
  preferredReader: 'node' | 'python';
  nodeReaderPath: string | null;
  pythonReaderPath: string | null;
  powershellPath: string | null;   // 空 = 自动探测
  maxCopyBytes: number;            // 默认 1 GiB，上限 8 GiB
  copyTimeoutMs: number;           // 默认 10 分钟，上限 60 分钟
}
```

- 复用 `normalizeReaderSelection`；新增 `validateCopyConfig`。
- 将 `resolveSaveDirectory` 参数泛化为 `{ saveDirectory: string | null }`，新旧配置共用。

`packages/core/src/copy/copy-state.ts`（新）：

- `CopyStatus`: `IDLE | CHECKING | COPYING | VERIFYING | SUCCESS | FAILED`
- `CopyStage`: `CHECK | COPY | VERIFY | CLEANUP`
- `CopySnapshot`: `taskId`、`status`、`stage`、`fileName`、`sourcePath`、`targetDirectory`、`targetPath`、`bytesProcessed`、`bytesRead`、`bytesWritten`、`startedAt`、`updatedAt`、`failure`、`recoveryActions`。
- `ACTIVE_COPY_STATUSES`、`createCopySnapshot`、`transitionCopy`。
- 恢复动作仅 `RETRY_COPY`；读取器/PowerShell 不可用时 UI 另提供「打开设置」。

`packages/core/src/ports/copy-stream.ts`（新）：

```ts
interface FileStreamReader {
  (filePath: string, options: { maxBytes: number; timeoutMs: number }):
    Promise<FileReadStream>;
}
interface FileWriteSession {
  stdin: Writable;
  completed: Promise<{ bytesWritten: number; sha256: string; tempPath: string }>;
  abort(): void;
}
interface FileStreamWriter {
  (targetDirectory: string, fileName: string, tempName: string,
   options: { timeoutMs: number }): Promise<FileWriteSession>;
}
```

`packages/core/src/copy/copy-controller.ts`（新）：

`CopyController` 注入 `getConfig`、`getDocumentsDirectory`、`openReadStream`、`openWriteSession`、`onUpdate`、`now`、`createId`。流程：

1. 忙碌检查（已有活动任务则 `TASK_BUSY`）。
2. 校验配置、解析并 `mkdir` 保存目录、检查可写。
3. `stat` 源文件：普通文件、非空、`size <= maxCopyBytes`；记录 size/mtime 基线。
4. 生成 `dirName = <UTC8 时间戳>-<taskId 前 6 位>`，`mkdir` 目标目录。
5. `COPYING`：打开读取流与写入会话；`pipeline(reader.stream, hash+meter Transform, writer.stdin)`；用 `Promise.allSettled([reader.completed, writer.completed, pipelineDone])` 等待并收集错误。
6. 校验：`readerBytes === writer.bytesWritten === 处理字节数` 且 Node 增量 SHA-256 === PowerShell 报告哈希；重新 `stat` 源文件确认 size/mtime 未变。
7. `VERIFYING`：`stat` 临时文件大小；确认最终路径不存在；`fs.rename(temp, final)`；`stat` 最终文件大小。
8. 成功写 `SUCCESS`；失败统一 `FAILED`，清理临时文件与空任务目录。
9. 进度：Transform 每 1 MiB 或 ~200ms 更新 `bytesProcessed`，避免 IPC 风暴。
- 失败清理：`reader.abort()`、`writer.abort()`、删除 `.part`、目标目录为空则 `rmdir`。
- 不覆盖已有文件：rename 前检查最终路径，存在则 `WRITE_FAILED`。

`packages/core/src/index.ts`：导出新增模块。

### 4. 新 app `apps/local-unlock`

目录与配置：

- `package.json`：包名 `local-unlock`，产品名「DSM UNLOCK」，依赖 `@dsm/core`、`@dsm/desktop-runtime`、`react`、`react-dom`；devDeps 沿用 desktop 的 Electron Forge/Vite/TS 版本。
- `forge.config.mts`：`extraResource` 增加 `resources/dsm-file-reader.cjs`、`dsm-file-reader.py`、`dsm-file-writer.ps1`、`icon.png`；`appBundleId: com.dsm-tool.local-unlock`；NSIS 产物名 `DSM-UNLOCK-${version}-${arch}-Setup.${ext}`，快捷方式/卸载显示名「DSM UNLOCK」；MakerZIP + MakerNSIS。
- `vite.main.config.mts`、`vite.preload.config.mts`、`vite.renderer.config.mts`、`tsconfig.json`、`index.html`（复用旧 CSP 与安全设置）。
- `src/main.ts`：单实例锁、窗口安全（`contextIsolation`/`sandbox`/`nodeIntegration:false`、导航拦截、权限拒绝同旧 app）、资源路径解析、logger、`CopyConfigStore`、`WhitelistedFileReader`、`PowerShellFileWriter`、`CopyController`、IPC、启动依赖检查、启动时清理保存目录下遗留 `.dsm-copy-*.part`。
- `src/main/copy-config-store.ts`：`userData/settings.json` 原子写入、`0600`、损坏文件改名 `.bad`（照搬旧 `ConfigStore` 模式，换 `CopyConfig`）。
- `src/main/ipc.ts`：复用旧 `handle` 包装（`assertTrustedSender` + `ApiResult`）与参数校验；目录打开/定位仅允许保存目录或当前任务目标目录。
- `src/preload.ts`、`src/shared.ts`：`window.dsm` 类型化 API。
- `src/renderer.tsx`、`src/renderer/App.tsx`、`CopyPage.tsx`、`SettingsPage.tsx`、`LogsPage.tsx`、`DependencyDialog.tsx`、`api.ts`（`unwrap`/`formatBytes`）、`src/index.css`（基于旧样式裁剪）。
- `src/main/startup-dependency-check.ts`：仿 `startup-reader-check.ts` 的 3 秒延迟/幂等/可取消模式，同时检查读取器链与 PowerShell；失败事件带 `{ reader: boolean; writer: boolean; message }`。

`PowerShellFileWriter`（`@dsm/desktop-runtime`）：

- 解析顺序：配置 `powershellPath` → 环境变量 `POWERSHELL_PATH` → Windows 自带 `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe` → PATH 中 `powershell.exe` → `pwsh.exe`；非 Windows 开发环境只探测 `pwsh`。
- `checkAvailability()`：校验 helper 脚本存在 + 可执行文件可运行 + 版本探测（`-NoProfile -NonInteractive -Command "$PSVersionTable.PSVersion.ToString()"`，5 秒超时），缓存结果，`reset()` 清缓存。
- `open(targetDirectory, fileName, tempName, { timeoutMs })`：
  - spawn `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File <dsm-file-writer.ps1>`。
  - `stdio: ['pipe','pipe','pipe']`、`windowsHide: true`、`shell: false`、最小环境 + 三个 `COPY_*` 变量。
  - 返回 `{ stdin, completed, abort }`；`completed` 解析 stdout JSON，非零退出/超时/spawn 失败映射为 `WRITER_UNAVAILABLE` / `WRITE_FAILED`；stderr 消息做 Base64 解码。
  - stdout/stderr 各限 64 KiB；默认超时取 `copyTimeoutMs`。

IPC 通道（新 app，`local:` 前缀）：

- `local:bootstrap` → `{ config, resolvedSaveDirectory, appVersion, platformLabel, currentTask }`
- `local:choose-file`、`local:inspect-file`、`local:choose-directory`
- `local:save-settings`
- `local:test-reader`（复用 `fileReader.probe`，展示直读 vs 白名单读取的大小/SHA-256/文件头）
- `local:test-writer`（用 PowerShell 写入 1 MiB 随机数据到临时目录，校验字节数与哈希后删除）
- `local:start-copy`、`local:current-task`
- `local:open-directory`、`local:reveal-path`
- `local:logs`、`local:clear-logs`
- `local:recheck-dependencies`、`local:open-reader-install-page`
- 事件：`local:task-update`、`local:dependency-check-failed`

界面：

- 主页：选择/拖入文件、文件信息、「开始保存」、当前任务卡片（状态、已处理字节、目标路径、失败原因、重试、打开目录）。
- 设置：保存目录；优先读取器与路径、「选择文件测试」；PowerShell 路径（留空自动）与「测试写入」。
- 日志页：沿用旧分页/搜索模式。
- 依赖弹窗：区分读取器缺失与 PowerShell 缺失；读取器保留安装页地址 `https://nas.pxsemic.local:5001/sharing/6592pf9xj`，PowerShell 提示检查路径/白名单；「重新检测」「稍后」。

### 5. 旧 app 的适配改动（行为不变）

- `apps/desktop/src/main.ts`、`apps/desktop/src/main/ipc.ts`：改从 `@dsm/desktop-runtime` 导入 `Logger`、`WhitelistedFileReader`、`readerLabel`、`createStartupReaderCheck`、`fitWindowToWorkArea` 等。
- `apps/desktop/src/shared.ts`：`ReaderProbeResult` / `ReaderCheckResult` 改为从 `@dsm/core` 导入并 re-export。
- 删除 `apps/desktop/src/main/` 下已迁移的 8 个文件。
- `apps/desktop/package.json` 增加 `"@dsm/desktop-runtime": "workspace:*"`。
- 不修改 GitLab 任务、配置、Token、渲染层行为。

### 6. 根配置、测试与文档

- 根 `package.json`：
  - `check` 增加 `pnpm --filter @dsm/desktop-runtime typecheck` 与 `pnpm --filter local-unlock typecheck`。
  - 新增 `start:local`、`package:local`、`make:local`、`package:local:win`、`make:local:win`（`--filter local-unlock`）。
- `vitest.config.ts`：增加 `@dsm/desktop-runtime` alias 指向 `packages/desktop-runtime/src/index.ts`。
- `tests/tsconfig.json`：`paths` 增加 runtime 别名，`include` 增加 `../packages/desktop-runtime/src/**/*.ts`。
- 更新既有测试 import：
  - `tests/unit/file-reader.test.ts`、`startup-reader-check.test.ts`、`logger.test.ts`、`window-size.test.ts`、`python-path.test.ts`。
- 新增测试：
  - `tests/unit/copy-config.test.ts`：默认值、上限、读取器选择、非法保存目录/超时/大小。
  - `tests/unit/copy-state.test.ts`：状态流转、终止态、忙碌集合。
  - `tests/unit/copy-controller.test.ts`：注入假读取流与假写入会话；成功（字节/哈希/rename/内容）、读取失败、写入失败、哈希不一致、字节数不一致、源文件变化、目标已存在、忙碌、失败清理。
  - `tests/unit/powershell-writer.test.ts`：注入假 spawn/解析器；参数（`-NoProfile`、`-NonInteractive`、`-ExecutionPolicy Bypass`、`-File`）、环境变量、stdout/stderr JSON、Base64 消息、超时/abort、helper 缺失；不依赖真实 PowerShell。
  - 扩展 `tests/unit/file-reader.test.ts`：`openStream` 正常输出、超限杀进程、非零退出映射、abort。
- `README.md`：新增「DSM UNLOCK」一节：用途、与 GitLab 模式的区别、输出布局、命令、PowerShell 要求（DSM 白名单需包含 `powershell.exe`）、macOS 开发需安装 `pwsh`。

## 实施顺序

1. 抽取 `packages/desktop-runtime`，更新旧 app import 与测试；跑 `pnpm check && pnpm test` 确认无回归。
2. Core 新增类型、错误码、配置/状态/端口/`CopyController`。
3. 实现 `WhitelistedFileReader.openStream` 与 `resources/dsm-file-writer.ps1`、`PowerShellFileWriter`。
4. 搭建 `apps/local-unlock` 主进程、preload、IPC、配置与依赖检查。
5. 实现渲染层页面与样式。
6. 补齐新测试、根脚本、README。
7. 全量类型检查、测试与手工验证。

## 验证

自动：

- `pnpm install`（新 workspace 包链接）。
- `pnpm check`：core、runtime、desktop、local-unlock、tests 全部类型检查通过。
- `pnpm test`：既有 GitLab/读取器测试 + 新增复制/写入器测试全部通过。

macOS 开发环境（需 `pwsh`）：

- `pnpm start:local`：选择普通文件 → 开始保存 → 目标目录出现 `<时间戳>-<id>/<文件名>`；`shasum -a 256` 源文件与目标文件一致；日志出现读取器与 PowerShell 解析信息。
- 设置页「测试写入」返回字节数与 SHA-256；「选择文件测试」显示直读/读取器结果。
- 删除/改名 `pwsh` 或配置无效 PowerShell 路径 → 启动依赖弹窗提示；安装后「重新检测」成功。

Windows 实机（DSM 环境）：

- `pnpm make:local:win` 生成 `DSM-UNLOCK-*-Setup.exe`，安装后运行。
- 选择一个 DSM 透明加密文件：目标文件应为可正常打开的明文；主进程直读与目标文件内容不同（可用设置页测试或外部工具确认）。
- 确认目标目录无 `.dsm-copy-*.part` 残留，失败重试会清理空任务目录。
- 配置无效 Node/Python 路径 → 依赖弹窗；配置有效白名单 PowerShell 路径 → 正常写入。
- 旧 app `pnpm start` / `pnpm test` 仍正常，GitLab 流程未被改动。

## 风险与边界

- **命名**：新 app 新增的环境变量不使用 `DSM_` 前缀；旧读取器既有的 `DSM_NODE_PATH` / `DSM_PYTHON_PATH` 保持不变，避免影响旧 app 与既有部署。
- **PowerShell 5.1 的 stdin/编码**：使用 `-File` 固定脚本、stdin 原始字节、stdout 纯 ASCII JSON、stderr Base64 消息；脚本用 .NET `FileStream` 与 `SHA256`，不依赖 `Get-FileHash`。
- **写入进程被强杀**：可能留下 `.dsm-copy-*.part`；启动时递归清理保存目录下的该前缀文件。
- **模块迁移回归**：旧 app 所有 import 与测试同步更新，靠 `pnpm check` + `pnpm test` 兜底。
- **DSM 白名单**：PowerShell 若不在白名单，`WRITER_UNAVAILABLE`/`WRITE_FAILED` 会在设置「测试写入」或任务中明确暴露；产品文档提示选择白名单内的 `powershell.exe`。
- **流式错误传播**：读取器、PowerShell、pipeline 任一失败都要 abort 对端并清理临时文件；使用 `Promise.allSettled` 避免未处理 rejection。
- **默认限制**：`maxCopyBytes` 默认 1 GiB、`copyTimeoutMs` 默认 10 分钟，均可在设置/配置文件中调整；超限分别报 `FILE_TOO_LARGE` / `WRITE_FAILED`。
- **不覆盖已有文件**：时间戳目录天然避免冲突；rename 前仍检查最终路径，存在则失败。
