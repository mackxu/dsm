# DSM 文件同步助手（apps/desktop）

`apps/desktop` 是 GitLab 单文件同步的 Electron 桌面应用，产品名「DSM 文件同步助手」。
它把本机单个文件上传到 GitLab 的独立任务分支，再按该分支下载归档并安全解压到本地。
产品行为、分支规则与故障排查见[根 README](../../README.md)。

## 技术栈

- Electron 40 + Electron Forge 8（Vite 插件）
- React 19 + TypeScript
- `@dsm/core`（任务编排、配置、GitLab 客户端、安全解压）
- `@dsm/desktop-runtime`（DSM 读取器、日志、窗口尺寸）

## 目录结构

```text
src/main.ts                  Electron Main 入口：生命周期、窗口、依赖装配
src/main/                    主进程模块（IPC、存储、平台适配）
src/preload.ts               contextBridge 暴露 DesktopApi
src/shared.ts                Main 与 Renderer 共享的 IPC 类型
src/renderer.tsx             React 入口
src/renderer/                页面与组件
forge.config.mts             打包、Maker 与 Fuses 配置
vite.*.config.mts            Main / Preload / Renderer 的 Vite 配置
```

### 主进程模块

| 路径                                     | 职责                                                                                        |
| ---------------------------------------- | ------------------------------------------------------------------------------------------- |
| `src/main.ts`                            | 创建窗口、注册 IPC、装配 `TaskController` 与 `WhitelistedFileReader`，启动 3 秒后探测读取器 |
| `src/main/ipc.ts`                        | 注册 `dsm:*` 通道：选择/检查文件、设置与连接测试、Token、任务与恢复、日志、打开目录         |
| `src/main/config-store.ts`               | 读写 `userData/settings.json`，首次启动与预置值合并                                         |
| `src/main/preset-store.ts`               | 读取安装包资源目录中的 `preset.json`                                                        |
| `src/main/token-store.ts`                | 读写 `userData/token.json`（macOS `0600`）与 Token 状态                                     |
| `src/main/task-history-store.ts`         | 持久化最近任务快照（最多 2 条）                                                             |
| `src/main/client-identity.ts`            | 用系统用户名与主机名生成本机分支命名空间                                                    |
| `src/main/logging-http-transport.ts`     | 装饰 `HttpTransport`，记录请求摘要，不记录 Token                                            |
| `src/main/platform/electron-platform.ts` | `PlatformAdapter` 与 `HttpTransport` 的 Electron 实现                                       |

### 渲染进程

| 路径                                      | 职责                                                |
| ----------------------------------------- | --------------------------------------------------- |
| `src/renderer/App.tsx`                    | 页面切换（上传 / 设置 / 日志）、全局状态与任务订阅  |
| `src/renderer/UploadPage.tsx`             | 选择或拖放文件、启动任务、展示进度与最近任务        |
| `src/renderer/SettingsPage.tsx`           | GitLab 连接、Token、保存目录、读取器与连接/文件测试 |
| `src/renderer/LogsPage.tsx`               | 分页查询、筛选与清空运行日志                        |
| `src/renderer/TaskDialog.tsx`             | 覆盖确认、失败原因与恢复操作                        |
| `src/renderer/ReaderDependencyDialog.tsx` | 读取器不可用提示、重新检测与安装页入口              |
| `src/renderer/api.ts`                     | 解包 `ApiResult`、格式化错误与字节数                |

## 安全边界

窗口开启 `contextIsolation`、`sandbox`，关闭 `nodeIntegration`，并禁止新窗口与外部
导航。Renderer 不能读取 Token、访问通用文件系统或执行命令；preload 只暴露
`src/shared.ts` 中声明的 `DesktopApi`，所有敏感操作都经 IPC 在 Main 执行。Main
通过 `WhitelistedFileReader` 读取待上传文件，避免在 DSM 环境下直接 `fs.readFile`
拿到密文。

## 打包资源

`forge.config.mts` 将仓库根 `resources/` 中的以下文件作为 `extraResource` 复制到应用
资源目录（不进入 asar）：

- `preset.json` — 构建期预置配置，根目录的 `package` / `make` 命令会先执行
  `pnpm run check:preset` 校验；
- `dsm-file-reader.cjs` / `dsm-file-reader.py` — DSM 白名单读取 helper；
- `icon.png`。

应用启用 Electron Fuses：禁用 `RunAsNode`、`NODE_OPTIONS` 与 `--inspect`，启用
cookie 加密、asar 完整性校验，并只从 asar 加载应用代码。

## 命令

在仓库根目录执行：

| 命令                                      | 说明                                            |
| ----------------------------------------- | ----------------------------------------------- |
| `pnpm start`                              | 启动开发版应用（`pnpm --filter desktop start`） |
| `pnpm --filter desktop typecheck`         | TypeScript 检查                                 |
| `pnpm --filter desktop lint` / `lint:fix` | oxlint 与 oxfmt 检查 / 修复                     |
| `pnpm run package` / `make`               | 当前平台的未安装应用 / 安装产物                 |
| `pnpm run package:mac` / `make:mac`       | macOS arm64 DMG 与 ZIP                          |
| `pnpm run package:win` / `make:win`       | Windows x64 NSIS 安装包与 ZIP                   |

产物位于 `apps/desktop/out/`。`.vite/` 与 `out/` 是构建结果，不要直接修改；请编辑
`src/` 下的源码。
