# 启动时延迟探测解释器，失败弹窗引导安装前置依赖

## Context

应用当前**启动时完全不探测** Node/Python 解释器：只有用户首次读取文件或点设置页「选择文件测试」时才会探测。若目标机器未安装解释器（或已配置路径失效），用户要到任务失败时才会看到 `READER_UNAVAILABLE` 错误，且没有安装引导。

本次改动：应用每次打开时延迟 3 秒自动探测**整条读取器链**（设置中的优先读取器 → 备用读取器）。若整条链不可用（包括已显式配置但路径失效），在应用内弹出提示窗：

- 文案简短，说明需要安装 Node/Python 前置依赖；
- **直接展示安装页面地址**，地址可点击（调用系统默认浏览器打开）且文字可选中复制；
- 提示 Node 安装包也可从 OneStep 软件库下载；
- 按钮为「重新检测」「稍后」（不再保留「打开安装页面」按钮）；
- 用户安装后点「重新检测」，成功则关闭弹窗并提示已就绪，失败则在弹窗内显示最新错误，可继续重试；
- 每次启动最多自动提示一次；点「稍后」后本次会话不再自动出现。

> 由于 Electron 原生 `dialog.showMessageBox` 无法提供可点击/可复制的链接，也无法在弹窗关闭后执行「重新检测」，弹窗改为渲染进程内的应用内弹窗（复用现有 `TaskDialog` 的遮罩与卡片样式）。

## 文件改动

### 1. `apps/desktop/src/main/whitelisted-file-reader.ts`

导入 `type ReaderChainResult`，在 `read()` 与 `probe()` 之间新增：

```ts
/**
 * 启动/复检时探测整条读取器链，只验证解释器可执行，不读取文件。
 * 探测前清空自动探测缓存；失败后再清空一次，避免把本次不可用
 * 缓存成后续 read() 的永久结果，用户安装后无需重启即可重试任务。
 */
async checkAvailability(): Promise<ReaderChainResult> {
  this.resetAutoDetection();
  try {
    const selection = await this.options.getReaderSelection();
    return await resolveReaderChain(selection, this.resolvers);
  } catch (error) {
    this.resetAutoDetection();
    throw error;
  }
}
```

- 不调用 `ensureHelper()`：本次只检查解释器；helper 缺失属于安装包缺陷，仍由任务阶段报 `FILE_READ_FAILED`。
- 不修改 `read()` / `probe()` / `reset()` 的现有语义。

### 2. `apps/desktop/src/shared.ts`

新增共享常量与类型（主进程、preload、渲染进程共用）：

```ts
export const READER_INSTALL_PAGE_URL =
  'https://nas.pxsemic.local:5001/sharing/6592pf9xj';

export interface ReaderCheckFailure {
  message: string;
}

export interface ReaderCheckResult {
  readerKind: ReaderKind;
  readerPath: string;
  readerVersion: string;
  readerSource: ReaderSource;
  fallbackUsed: boolean;
}
```

`DesktopApi` 增加：

```ts
onReaderCheckFailure(callback: (failure: ReaderCheckFailure) => void): () => void;
recheckReader(): Promise<ApiResult<ReaderCheckResult>>;
openReaderInstallPage(): Promise<ApiResult<void>>;
```

### 3. 新建 `apps/desktop/src/main/startup-reader-check.ts`

可单测的调度模块，**不 import electron**：

```ts
export const STARTUP_READER_CHECK_DELAY_MS = 3_000;

export interface StartupReaderCheckDependencies {
  checkAvailability: () => Promise<ReaderChainResult>;
  isWindowAvailable: () => boolean;
  notifyFailure: (failure: ReaderCheckFailure) => void;
  log: (level: LogLevel, stage: string, message: string,
        options?: { details?: Record<string, unknown> }) => Promise<void> | void;
  delayMs?: number; // 仅测试注入，默认 3000
}

export interface StartupReaderCheckHandle {
  start(): void;  // 幂等
  cancel(): void;
}

export function createStartupReaderCheck(
  deps: StartupReaderCheckDependencies,
): StartupReaderCheckHandle;
export async function runStartupReaderCheck(
  deps: StartupReaderCheckDependencies,
): Promise<void>; // 内部吞掉所有异常，不 reject
```

流程：
1. `isWindowAvailable()` 为 false → DEBUG 日志后返回。
2. `await checkAvailability()`：成功 → INFO 日志（读取器类型/路径/版本/来源/是否回退）。
3. 失败 → WARN 日志；窗口仍可用时 `notifyFailure({ message })`。
4. 日志写入用 `safeLog()` 包裹，写盘失败不影响流程。

`createStartupReaderCheck`：`setTimeout(delayMs ?? 3000)` 后 `void runStartupReaderCheck(deps).catch(() => {})`；`start()` 有幂等标志；`cancel()` 清定时器。

### 4. `apps/desktop/src/main/ipc.ts`

- electron 导入增加 `shell`；导入 `readerLabel` 与共享类型。
- 新增两个通道（复用现有 `handle` 包装，自动做 `assertTrustedSender` 和 `ApiResult` 转换）：

```ts
handle<ReaderCheckResult>('dsm:recheck-reader', async () => {
  const { reader, fallbackUsed } = await services.fileReader.checkAvailability();
  await services.logger.log('INFO', 'APP', `读取器复检通过：${readerLabel(reader.kind)}`, {
    details: { readerKind: reader.kind, readerPath: reader.command,
               readerVersion: reader.version, readerSource: reader.source, fallbackUsed },
  });
  return { readerKind: reader.kind, readerPath: reader.command,
           readerVersion: reader.version, readerSource: reader.source, fallbackUsed };
});

// 只允许打开硬编码的 https 常量，不接受渲染进程传入的 URL
handle('dsm:open-reader-install-page', async () => {
  const url = new URL(READER_INSTALL_PAGE_URL);
  if (url.protocol !== 'https:') {
    throw new DsmError('INVALID_REQUEST', '安装页面地址不安全', 'CHECK');
  }
  await shell.openExternal(READER_INSTALL_PAGE_URL);
  await services.logger.log('INFO', 'APP', '已打开读取器安装页面', {
    details: { url: READER_INSTALL_PAGE_URL },
  });
});
```

### 5. `apps/desktop/src/preload.ts`

按现有 `ipcRenderer.invoke` / `ipcRenderer.on` 模式增加：

```ts
recheckReader: () => ipcRenderer.invoke('dsm:recheck-reader'),
openReaderInstallPage: () => ipcRenderer.invoke('dsm:open-reader-install-page'),
onReaderCheckFailure: (callback) => {
  const listener = (_event, failure: ReaderCheckFailure) => callback(failure);
  ipcRenderer.on('dsm:reader-check-failed', listener);
  return () => ipcRenderer.removeListener('dsm:reader-check-failed', listener);
},
```

### 6. `apps/desktop/src/main.ts`

- 导入 `createStartupReaderCheck` 与 `ReaderCheckFailure`。
- 模块级新增 `let isQuitting = false;`、`let startupReaderCheck: StartupReaderCheckHandle | null = null;`。
- `whenReady` 中 `mainWindow = createWindow()` 与 `setupIpc(...)` 之后，在 `hasSingleInstanceLock` 守卫下创建并 `start()`：

```ts
startupReaderCheck = createStartupReaderCheck({
  checkAvailability: () => fileReader.checkAvailability(),
  isWindowAvailable: () => !isQuitting && getLiveMainWindow() !== null,
  notifyFailure: (failure) => sendReaderCheckFailure(failure),
  log: (level, stage, message, options) => logger.log(level, stage, message, options),
});
startupReaderCheck.start();
```

- 新增 `sendReaderCheckFailure`：窗口还在加载时等 `did-finish-load` 再 `webContents.send('dsm:reader-check-failed', failure)`，否则立即发送；窗口已销毁则忽略。
- `before-quit` 中新增 `isQuitting = true; startupReaderCheck?.cancel();`。
- `second-instance` 保持原样，不重新调度。

### 7. 渲染进程

**新建 `apps/desktop/src/renderer/ReaderDependencyDialog.tsx`**：

- Props：`failure`、`onDismiss`、`onResolved`、`onNotice`。
- 状态：`busy`、`error`（初始为 `failure.message`）。
- 点击「重新检测」：`const result = await unwrap(window.dsm.recheckReader())`；成功 → `onResolved()` + `onNotice('读取器已就绪，可以开始同步任务。')`；失败 → `setError(errorMessage(error))`，弹窗保持打开。
- 点击链接：`event.preventDefault()` 后 `await unwrap(window.dsm.openReaderInstallPage())`；失败通过 `onNotice` 提示。
- 点击「稍后」：`onDismiss()`。

弹窗文案（保持简短）：

- 顶栏：`缺少读取器依赖`
- 标题：`未检测到可用的 Node 或 Python`
- 正文：`应用读取 DSM 加密文件需要 Node 或 Python。安装前置依赖后，请点击「重新检测」。`
- 正文：`Node 安装包也可从 OneStep 软件库下载。已在设置中填写读取程序路径时，请确认路径有效。`
- 链接行：`安装页面：` + 可点击、可选中复制的 `READER_INSTALL_PAGE_URL`
- 错误行：小字显示最近一次探测失败的原因（`failure.message` / 复检错误）
- 按钮：`重新检测`（primary，检测中显示「检测中…」并禁用）、`稍后`（text button）
- 结构复用 `.dialog-backdrop` + `.task-dialog`，`role="dialog"`、`aria-modal="true"`；「重新检测」按钮 `autoFocus`。

**修改 `apps/desktop/src/renderer/App.tsx`**：

- 新增 `const [readerFailure, setReaderFailure] = useState<ReaderCheckFailure | null>(null);`
- 启动 `useEffect` 内订阅 `window.dsm.onReaderCheckFailure(setReaderFailure)`，清理时取消订阅。
- 在 `TaskDialog` 之后渲染：

```tsx
{readerFailure && (
  <ReaderDependencyDialog
    failure={readerFailure}
    onDismiss={() => setReaderFailure(null)}
    onResolved={() => setReaderFailure(null)}
    onNotice={setNotice}
  />
)}
```

**修改 `apps/desktop/src/index.css`**：在 Task dialog 样式后新增少量样式：

- `.dependency-dialog .dependency-link`：主题色、`overflow-wrap: anywhere`、`word-break: break-all`、`user-select: text`；
- `.dependency-dialog .dependency-error`：浅色背景、小字、`overflow-wrap: anywhere`、`user-select: text`。

### 8. 测试

**新建 `tests/unit/startup-reader-check.test.ts`**（依赖注入 + `vi.fn()`，不加载 electron）：
- 成功：不调用 `notifyFailure`，记录 INFO。
- 失败：记录 WARN，`notifyFailure` 收到错误消息。
- 启动时窗口不可用：不探测、不通知。
- 探测期间窗口变为不可用：只记 WARN，不通知。
- `checkAvailability` reject 普通 Error：仍通知。
- fake timers：默认 3000ms 前不运行、到时运行一次；`start()` 两次只运行一次；`cancel()` 后不运行。

**扩展 `tests/unit/file-reader.test.ts`**（复用现有 `createReader` / `fakeResolver` / `missingResolver` / `resolvedReader`）：
- 优先可用：`fallbackUsed: false`，备用 resolver 未被调用。
- 优先缺失、备用可用：返回备用，`fallbackUsed: true`。
- 两者皆无：reject 且 `code === 'READER_UNAVAILABLE'`。
- 显式配置抛错：原样抛出，不尝试备用。
- 缓存契约：用带缓存的 fake resolver 先让检查失败，再标记可用后重试应成功（证明失败未缓存），并断言失败路径 `resetAutoDetection` 被调用两次。

### 9. 文档

在 `README.md` 的「DSM 加密文件读取」一节补充一段：应用每次启动 3 秒后自动探测读取器链；失败时弹出应用内提示，可点击安装页地址、从 OneStep 软件库下载 Node 安装包，并可直接「重新检测」。

## 验证

1. `pnpm test`：新增与现有测试全部通过。
2. `pnpm check`：主进程、`@core`、测试的 TypeScript 类型检查通过。
3. 手工验证：
   - 正常启动 `pnpm start`：3 秒后无弹窗，日志出现「启动读取器检查通过」INFO。
   - 模拟失败：`DSM_NODE_PATH=/tmp/fake-node DSM_PYTHON_PATH=/tmp/fake-python pnpm start`，3 秒后出现应用内弹窗；链接可点击并在默认浏览器打开指定 URL；地址文字可选中复制；「稍后」关闭；重启后再次提示。
   - 模拟复检成功：保持上面的启动方式，在弹窗出现后创建可执行文件 `/tmp/fake-node`（输出合法 Node 版本），点「重新检测」→ 弹窗关闭并出现「读取器已就绪」提示；日志记录 INFO。
   - 复检失败：直接点「重新检测」，弹窗内显示最新错误且不关闭。
   - 启动后 3 秒内退出应用：不弹窗。
   - 将设置中的读取器路径改为无效值重启：同样弹窗，文案提示检查设置路径。

## 风险与边界

- 每个候选解释器探测最多 5 秒；候选较多且存在会挂起的可执行文件时，弹窗可能晚于 3 秒。不给整体探测加超时，避免把仍可用的环境误判为失败。
- 启动探测失败后会清空自动探测缓存；但若用户在安装前又执行过一次失败任务，`read()` 仍会缓存 null，本会话需重启。此已知限制不在本次修改 `read()` 语义。
- 弹窗为全屏遮罩，打开期间会挡住设置页；用户可先点「稍后」去修改设置。设置保存后 `fileReader.reset()` 已会清缓存，直接重试任务即可生效。
- 渲染进程重载（开发热更新）会丢失本次弹窗状态；生产环境不涉及。
- `shell.openExternal` 只接收硬编码的 https 常量；macOS 内网/自签名证书由默认浏览器处理，不影响打开。
- 开发者模式每次启动也会检查；本机通常已有 Node，不会弹窗。不新增跳过开关。
