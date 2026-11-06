# DSM 文件同步助手

面向 macOS Apple Silicon 与 Windows 10/11 x64 的 GitLab 单文件同步桌面应用。
应用将文件上传到指定分支，通过唯一任务标记定位本次 Commit，只下载该 Commit
的归档并安全解压到独立时间戳目录；结果目录只保留本次上传的文件，归档中的
其他文件不会写入。

产品边界和技术细节见 [技术方案](docs/product-technical-plan.md) 与
[实施及验收清单](docs/implementation-and-acceptance.md)。

## 本地要求

- Node.js 22.13 或更高版本
- pnpm 11.5.2
- macOS Apple Silicon，或 Windows 10/11 x64

## 安装与运行

```bash
pnpm install --frozen-lockfile
pnpm run check
pnpm run test
pnpm start
```

根目录命令：

| 命令 | 用途 |
| --- | --- |
| `pnpm run check` | 检查 `@dsm/core`、桌面应用、测试与冒烟脚本源码 |
| `pnpm run test` | 运行 Vitest 单元和集成测试 |
| `pnpm start` | 启动 Electron 应用 |
| `pnpm run package` | 为当前系统生成未安装应用 |
| `pnpm run make` | 为当前系统生成安装产物 |
| `pnpm run package:mac` | 生成 macOS arm64 未安装应用 |
| `pnpm run make:mac` | 生成 macOS arm64 DMG 与 ZIP |
| `pnpm run package:win` | 生成 Windows x64 未安装应用 |
| `pnpm run make:win` | 生成 Windows x64 NSIS 安装包与 ZIP |

Windows 安装产物位于 `apps/desktop/out/make`：

- `DSM-File-Sync-<version>-x64-Setup.exe`
- `DSM-File-Sync-<version>-x64-Setup.exe.blockmap`
- `zip/win32/x64/DSM 文件同步助手-win32-x64-<version>.zip`

正式 Windows 安装包建议在 Windows x64 构建机生成。Authenticode 证书可以通过
环境变量提供，密码不会写入项目文件：

```powershell
$env:CSC_LINK = "C:\certs\codesign.pfx"
$env:CSC_KEY_PASSWORD = $env:WINDOWS_CERT_PASSWORD
pnpm run make:win
```

也可以在 Windows 中一次完成安装、检查、测试和打包：

```powershell
pwsh -File scripts/build-windows.ps1
```

## 预置 Token

安装包可以带一个可撤销的专用 GitLab Token。构建时从环境变量生成资源文件，
不要把 Token 提交到仓库：

```bash
DSM_PRESET_TOKEN="$PRESET_TOKEN" pnpm run make:mac
```

Windows 构建机：

```powershell
$env:DSM_PRESET_TOKEN = $env:DSM_TOKEN
pnpm run make:win
```

没有预置需求时直接运行 `pnpm run prepare:preset-token` 会生成空文件。应用首次启动
时把非空预置值复制到 `userData/token.json`。用户在界面中清除 Token 后，会写入
空的用户 Token 记录，预置值不会再次恢复。

Token 按产品要求以明文保存在 `userData/token.json`，macOS 文件权限为 `0600`。
任何能读取当前用户目录的人仍可读取该值；请使用专用、短期、可撤销且限制分发范围
的 Token。

## DSM 加密文件读取

在部署了 DSM（数据防泄漏/透明加密）的机器上，Electron 主进程不在进程白名单中，
`fs.readFile` 只能读到密文。应用支持由白名单中的 Node 读取文件，再通过 stdout
管道把明文交给主进程上传，内容不落盘，避免被重新加密或留下明文临时文件。

读取 Node 的解析优先级：

1. 设置页「DSM 读取 Node 路径」；
2. 环境变量 `DSM_NODE_PATH`；
3. 自动探测系统 PATH、常见安装目录和 nvm 目录。

显式配置的路径不可执行时，任务会直接失败，不会静默上传密文。未配置且自动探测
失败时回退为主进程直读，并在日志中记录 WARN。

设置页的「选择文件测试」会分别用主进程和 Node 读取同一个文件，显示大小、
SHA-256 和文件头。两者内容不同通常说明 Node 已拿到明文；内容相同则说明文件
未受控，或该 Node 不在 DSM 白名单中。

构建时 `resources/dsm-file-reader.cjs` 会作为 `extraResource` 复制到应用资源
目录，不进入 asar，确保外部 Node 可以直接执行。

## 目录

```text
apps/desktop/    Electron Main、Preload 与 React Renderer
packages/core/   配置、Token 规则、GitLab、任务状态与安全解压
tests/           Vitest 单元/集成测试及 GitLab fixtures
scripts/         构建期预置 Token 生成脚本
```

Renderer 不能读取已有 Token、访问通用文件系统或执行命令。网络请求、Token 文件和
文件操作全部位于 Electron Main。

## 构建产物

构建产物由 Electron Forge 与 Vite 插件自动生成，均已在 `.gitignore` 中忽略，
可以随时删除后重新构建：

| 目录 | 生成方式 | 内容 |
| --- | --- | --- |
| `apps/desktop/.vite/build/` | `pnpm start`、`package`、`make` | 主进程 `main.cjs` 与预加载 `preload.cjs` |
| `apps/desktop/.vite/renderer/main_window/` | 同上 | 渲染进程 `index.html` 与 `assets/` |
| `apps/desktop/out/` | `pnpm run package`、`pnpm run make` | 未安装应用与安装产物 |

`.vite` 目录由 `@electron-forge/plugin-vite` 固定指定：主进程和预加载脚本输出到
`.vite/build`（对应 `forge.config.mts` 中的 `build` 条目），渲染进程输出到
`.vite/renderer/<name>`，其中 `<name>` 即 `forge.config.mts` 中的 `main_window`。
`package.json` 的 `main` 必须指向 `.vite/build/main.cjs`。这些文件是构建结果，
不要直接修改；请编辑 `apps/desktop/src/` 下的源码。

`out/` 目录由 `electron-forge` 生成，`package` 与 `make` 的产出不同：

| 命令 | 做什么 | 产物位置 | 用途 |
| --- | --- | --- | --- |
| `pnpm run package` | 把构建结果、依赖与 Electron 运行时组装成可执行应用目录，不生成安装包 | `out/DSM 文件同步助手-<platform>-<arch>/` | 本地验证打包结果，可直接运行 |
| `pnpm run make` | 先隐式执行一次 `package`，再调用各 Maker 生成安装/分发产物 | 上述应用目录，以及 `out/make/` | 交付用户安装或分发 |

`make` 自动包含 `package` 阶段，无需先手动执行 `package`；执行后未压缩的应用目录
仍会保留。Maker 按平台生效：macOS 生成 DMG 与 ZIP，Windows 生成 NSIS 安装包与
ZIP。`package:mac` / `make:mac` / `package:win` / `make:win` 只是固定了
`--platform` 与 `--arch`，其余行为与 `package` / `make` 一致。安装产物清单见
上文「安装与运行」。

## 使用 `.env` 做本地冒烟测试

冒烟脚本使用 `.env` 中的四个键：`GITLAB_URL`、`GIT_TOKEN`、`PROJECT_ID` 和
`BRANCH_NAME`。测试脚本不会输出 Token。

```bash
# 只读验证用户、项目和目标分支
./node_modules/.bin/tsx scripts/test-env-connection.ts

# 只读检查唯一测试文件名是否冲突
DSM_SMOKE_FILE_NAME=dsm-smoke-unique.txt \
  ./node_modules/.bin/tsx scripts/test-env-connection.ts

# 明确获准产生写入后，执行上传、Commit 定位、下载和解压
DSM_SMOKE_FILE_NAME=dsm-smoke-unique.txt \
  ./node_modules/.bin/tsx scripts/test-env-task.ts

# 不重新上传，按已有 Commit 重试下载和解压
DSM_SMOKE_COMMIT_ID=<commit-id> \
DSM_SMOKE_FILE_NAME=dsm-smoke-unique.txt \
  ./node_modules/.bin/tsx scripts/test-env-recover.ts
```

GitLab 会拒绝带 `Sec-Fetch-Mode: cors` 的仓库归档请求。桌面应用使用 Node 原生
`fetch`，对所有 GET 请求设置 `RequestInit.mode = 'same-origin'`，由 undici 生成
`Sec-Fetch-Mode: same-origin` 请求头（直接设置同名 Header 会被 undici 忽略），
以兼容 GitLab hotlink 防护；该请求不经过 Chromium 网络栈。
