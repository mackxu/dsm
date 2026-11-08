# DSM 文件同步助手

面向 macOS Apple Silicon 与 Windows 10/11 x64 的 GitLab 单文件同步桌面应用。
每次同步都会从固定的基础分支 `main` 创建一个带东八区时间戳的独立分支
（`系统用户名-主机名/时间戳`），只把本次文件提交到该分支，并按该分支下载归档。
每个任务分支只包含 `main` 的少量模板文件 + 本次上传的文件，因此下载包大小与
仓库历史和其他客户端无关；结果目录只保留本次上传的文件。

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

## 打包预置

安装包可以预置 GitLab 连接配置和可撤销的专用 Token，免去用户安装后逐项填写。
预置值手工写在 `resources/preset.json`，该文件已加入 `.gitignore`，不会被提交：

```json
{
  "gitlabUrl": "https://gitlab.example.com",
  "projectId": "group/project",
  "token": "glpat-xxxxxxxxxxxxxxxxxxxx"
}
```

可以从 [resources/preset.example.json](resources/preset.example.json) 复制后修改。
字段说明：

| 字段 | 说明 |
| --- | --- |
| `gitlabUrl` | GitLab 根地址，不含 `/api/v4` |
| `projectId` | 项目 ID（数字或 `group/project`） |
| `token` | GitLab Token，明文 |

目标分支不再通过预置配置：客户端分支命名空间由系统用户名和主机名自动生成，
基础分支固定为 `main`。

填好后直接打包：

```bash
pnpm run make:mac    # 或 make:win
```

打包前会自动执行 `pnpm run check:preset`：校验地址、项目 ID 和 JSON 格式，
非法值终止打包，日志只输出设置了哪些字段，不输出 Token。文件不存在时生成空的
`{}`，不会覆盖已经手工填写的内容。

没有预置需求时保持 `{}` 即可。

预置值的行为：

- 尚未保存过设置时，`gitlabUrl`、`projectId` 作为首次启动的初始配置。
- 用户在设置页保存后，`userData/settings.json` 成为唯一来源，之后的新安装包不会
  覆盖已保存的配置；需要恢复预置值时删除该文件。
- 应用首次启动时把非空预置 Token 复制到 `userData/token.json`；用户在界面中清除
  Token 后，会写入空的用户 Token 记录，预置值不会再次恢复。

Token 按产品要求以明文保存在 `userData/token.json`，macOS 文件权限为 `0600`；
`resources/preset.json` 同样以 `0600` 生成。任何能读取安装包或当前用户目录的人
仍可读取这些值；请使用专用、短期、可撤销且限制分发范围的 Token。

## 客户端分支

- 分支命名空间由系统用户名和主机名自动生成，例如 `zhangsan-pc01`，在设置页只读展示。
- 每次同步在该命名空间下创建一个新分支，例如
  `zhangsan-pc01/20261108-153000-123-ab12cd`；时间戳固定使用东八区（UTC+8），
  并追加任务 ID 前 6 位。
- 任务分支从固定的基础分支 `main` 创建，上传成功后按该分支下载归档；任务分支
  创建后不再写入，因此分支 tip 就是本次上传的版本。
- 生产 GitLab 必须存在只含 README、`.gitkeep` 等少量占位文件的 `main` 分支。
  若 `main` 不存在，任务会以 `BRANCH_CREATE_FAILED` 失败，设置页的「测试连接」
  也会给出提示。
- 任务分支不会自动删除，可在 GitLab 中按需清理；分支数量不影响下载包大小。
- 设置页不提供分支编辑；`settings.json` / `preset.json` 中的 `branch` 字段不再读取。

## DSM 加密文件读取

在部署了 DSM（数据防泄漏/透明加密）的机器上，Electron 主进程不在进程白名单中，
`fs.readFile` 只能读到密文。应用支持由白名单中的 Node 或 Python 读取文件，再通过
stdout 管道把明文交给主进程上传，内容不落盘，避免被重新加密或留下明文临时文件。

设置页提供「Node」「Python」两个优先读取器选项，默认 Node。优先读取器的解析顺序：

1. 设置页中对应读取器的路径；
2. 环境变量 `DSM_NODE_PATH` / `DSM_PYTHON_PATH`；
3. 自动探测系统 PATH、常见安装目录和 nvm / pyenv / conda 目录。

只有优先读取器没有显式配置且自动探测完全找不到时，才会自动尝试另一个读取器，
并按 INFO 记录实际读取器、路径、版本和来源。显式配置的路径不可执行、helper
缺失、读取失败或超时都会直接失败，不会回退。

Python 读取使用：

```text
python -I -S -B -u dsm-file-reader.py <filePath> <maxBytes>
```

建议使用标准 CPython 3.8+，填写真实的 `python.exe` / `python3` 路径，不建议使用
`py.exe` 启动器或 Microsoft Store 的 WindowsApps 别名。

设置页的「选择文件测试」会分别用主进程和当前读取器读取同一个文件，显示大小、
SHA-256 和文件头。两者内容不同通常说明读取器已拿到明文；内容相同则说明文件
未受控，或该读取器不在 DSM 白名单中。

构建时 `resources/dsm-file-reader.cjs` 和 `resources/dsm-file-reader.py` 会作为
`extraResource` 复制到应用资源目录，不进入 asar，确保外部解释器可以直接执行。

## 目录

```text
apps/desktop/    Electron Main、Preload 与 React Renderer
packages/core/   配置、Token 规则、GitLab、任务状态与安全解压
tests/           Vitest 单元/集成测试及 GitLab fixtures
scripts/         构建期预置配置校验脚本
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

冒烟脚本使用 `.env` 中的 `GITLAB_URL`、`GIT_TOKEN`、`PROJECT_ID`；可选的
`DSM_CLIENT_BRANCH` 进程环境变量用于覆盖自动生成的本机分支命名空间。测试脚本不会输出 Token。
目标项目必须存在只含少量占位文件的 `main` 基础分支。

```bash
# 只读验证用户、项目和基础分支 main
./node_modules/.bin/tsx scripts/test-env-connection.ts

# 可选：用 DSM_CLIENT_BRANCH 覆盖自动生成的本机分支命名空间
DSM_CLIENT_BRANCH=zhangsan-pc01 \
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
