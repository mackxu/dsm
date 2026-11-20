# DSM UNLOCK（apps/local-unlock）

`apps/local-unlock` 是独立于 GitLab 模式的本地直写应用，产品名「DSM UNLOCK」。它把
DSM 透明加密环境中的文件解密后，直接写入用户选择的本地目录，不使用 GitLab 上传与
归档下载。完整行为与故障排查见[根 README](../../README.md)。

## 技术栈

- Electron 40 + Electron Forge 8（Vite 插件）
- React 19 + TypeScript
- `@dsm/core`（`CopyController`、配置与状态机）
- `@dsm/desktop-runtime`（`WhitelistedFileReader`、`PowerShellWriter`、日志、窗口尺寸）

## 工作流程

```text
DSM 白名单 Node / Python（dsm-file-reader.cjs / .py）
        │ stdout（明文，不落盘）
        ▼
Electron Main（CopyController：限流、进度、SHA-256）
        │ stdin
        ▼
DSM 白名单 PowerShell（dsm-file-writer.ps1：.NET FileStream）
        │
        ▼
保存目录/<UTC+8 时间戳>-<任务ID前6位>/<原文件名>
```

1. `WhitelistedFileReader` 由白名单进程读取明文；
2. `CopyController` 边转发边计算 SHA-256，并限制单文件大小与超时；
3. `PowerShellWriter` 将 stdin 写入目标目录下的临时 `.part` 文件；
4. 主进程校验字节数与哈希后原子 rename 为最终文件，失败时清理临时文件。

明文只存在于进程管道与内存中，不写临时明文文件。

## 目录结构

```text
src/main.ts                       Electron Main 入口：生命周期、窗口、依赖装配
src/main/copy-config-store.ts     直写配置读写
src/main/ipc.ts                   local:* IPC 通道
src/main/startup-dependency-check.ts  启动 3 秒后的读取器与写入器检查
src/preload.ts                    contextBridge 暴露 DesktopApi
src/shared.ts                     Main 与 Renderer 共享的 IPC 类型
src/renderer.tsx                  React 入口
src/renderer/                     页面与组件
forge.config.mts                  打包、Maker 与 Fuses 配置
```

### 主进程模块

| 路径                                   | 职责                                                                                       |
| -------------------------------------- | ------------------------------------------------------------------------------------------ |
| `src/main.ts`                          | 创建窗口、装配 `CopyController`、`WhitelistedFileReader` 与 `PowerShellWriter`             |
| `src/main/ipc.ts`                      | 注册 `local:*` 通道：选择文件/目录、保存设置、测试读取器与写入器、启动复制、日志、打开目录 |
| `src/main/copy-config-store.ts`        | 读写 `userData/` 中的直写配置：保存目录、读取器、PowerShell、单文件上限、超时              |
| `src/main/startup-dependency-check.ts` | 启动后同时检查读取器链与 PowerShell，失败时通知界面并支持重新检测                          |

### 渲染进程

| 路径                                | 职责                                                           |
| ----------------------------------- | -------------------------------------------------------------- |
| `src/renderer/CopyPage.tsx`         | 选择或拖放文件、启动本地直写、展示进度                         |
| `src/renderer/SettingsPage.tsx`     | 保存目录、单文件上限、复制超时、读取器与 PowerShell 路径、测试 |
| `src/renderer/LogsPage.tsx`         | 分页查询、筛选与清空运行日志                                   |
| `src/renderer/DependencyDialog.tsx` | 读取器 / PowerShell 缺失提示、重新检测与安装页入口             |
| `src/renderer/api.ts`               | 解包 `ApiResult`、格式化错误与字节数                           |

## 安全边界

窗口开启 `contextIsolation`、`sandbox`，关闭 `nodeIntegration`，并禁止新窗口与外部
导航。Renderer 不能访问通用文件系统或执行命令；preload 只暴露 `src/shared.ts` 中
声明的 `DesktopApi`，读取、写入与配置操作全部经 IPC 在 Main 执行。

## 打包资源

`forge.config.mts` 将仓库根 `resources/` 中的以下文件作为 `extraResource` 复制到应用
资源目录（不进入 asar），供外部解释器直接执行：

- `dsm-file-reader.cjs` / `dsm-file-reader.py` — 读取 helper；
- `dsm-file-writer.ps1` — 写入 helper，必须保存为 UTF-8 with BOM；
- `icon.png`。

## 命令

在仓库根目录执行：

| 命令                                            | 说明                                                 |
| ----------------------------------------------- | ---------------------------------------------------- |
| `pnpm start:local`                              | 启动开发版应用（`pnpm --filter local-unlock start`） |
| `pnpm --filter local-unlock typecheck`          | TypeScript 检查                                      |
| `pnpm --filter local-unlock lint` / `lint:fix`  | oxlint 与 oxfmt 检查 / 修复                          |
| `pnpm run package:local` / `make:local`         | 当前平台的未安装应用 / 安装产物                      |
| `pnpm run package:local:mac` / `make:local:mac` | macOS arm64 DMG 与 ZIP                               |
| `pnpm run package:local:win` / `make:local:win` | Windows x64 NSIS 安装包与 ZIP                        |

产物位于 `apps/local-unlock/out/`。`.vite/` 与 `out/` 是构建结果，不要直接修改。

## 部署注意

- 正式目标是 Windows x64；macOS 仅用于开发调试，需要安装 `pwsh`。
- DSM 环境中 `powershell.exe` 必须在进程白名单内。
- 设置页「测试写入」会在保存目录写入 1 MB 随机数据，校验字节数与 SHA-256 后删除，
  可用于区分「PowerShell 写入链路」与「DSM 读取」问题。
- PowerShell 的解析顺序：设置中的路径 → `POWERSHELL_PATH` → Windows 自带的
  `powershell.exe` → PATH 中的 `pwsh`。
