# DSM 文件同步助手技术与实施计划

> 文档日期：2026-11-05  
> 首版平台：macOS Apple Silicon  
> 后续平台：Windows x64  
> 首版形态：GitLab 单文件上传、指定 Commit 归档下载与安全解压桌面工具

## 1. 项目结论

当前项目是命令工具，流程为上传单个文件、下载 GitLab 分支归档并解压到时间戳目录。产品化首版使用 Electron + React + TypeScript，通过 Electron Forge、Vite、`create-electron-app` 和 pnpm 构建 macOS 应用，业务核心保持跨平台。

已确认的产品决策：

- 安装包允许预置真实 GitLab Token。
- Token 使用明文持久化，不使用 `safeStorage`、Keychain、DPAPI 或客户端加密。
- Token 是非必填配置；没有 Token 时仍可启动应用和使用本地功能。
- GitLab 地址允许 HTTP 或 HTTPS，不作协议强制。
- 上传后按本次任务的独立分支下载归档；任务分支唯一且创建后不再写入，分支 tip 即本次上传版本。Commit ID 仍用于展示与失败恢复。
- 首版只检查目标文件中是否存在于指定 Commit 的解压结果，不提供内容完整性验证。

首版边界：

- macOS 只发布 Apple Silicon `arm64`，不构建 Intel 或 Universal Binary。
- Windows x64 在 macOS MVP 稳定后适配，不属于首版发布范围。
- GitLab、上传、下载、解压、配置和日志模块不直接依赖 Electron 或 macOS。

## 2. MVP 范围

### 2.1 首版保留

- 安装包预置 GitLab 地址、项目 ID 和 Token，用户可替换或清除。
- Token 可选输入、验证和明文持久化。
- GitLab 地址、项目、保存目录、超时和归档保留配置。
- 单文件选择或拖入，默认上限 50 MiB。
- 创建远端文件，或经确认后覆盖同名文件。
- 每次任务从固定基础分支 `main` 自动创建 `系统用户名-主机名/时间戳` 任务分支；基础分支不存在时明确失败。
- 上传后识别本任务 Commit ID，并下载该 Commit 的归档。
- 归档安全解压到独立时间戳目录，并检查上传文件是否存在。
- 上传、下载、解压和清理阶段状态及失败恢复。
- 配置页、日志页、任务弹窗和 macOS 安装包。
- 按配置保留或删除成功任务的原始 ZIP。

### 2.2 首版不实现

- 文件夹批量上传、增量同步和远端文件清单。
- 定时任务、实时监听、系统托盘、开机启动和自动更新。
- 多设备冲突合并、文件预览、分享和在线编辑。
- 产品后台、账号系统和数据库。
- SHA-256、文件大小或字节内容一致性校验。
- Intel Mac、Universal Binary 和 Windows 正式发布。
- Token 加密、系统安全存储、自定义 CA 和企业代理管理界面。

## 3. 用户与运行流程

### 3.1 首次使用

```text
启动应用
  -> 加载 settings.json；不存在时使用构建时预置配置
  -> 读取 userData/token.json
  -> 无用户覆盖时导入安装包预置 Token
  -> 有 Token 时验证；没有 Token 时进入未连接状态
  -> 进入文件上传页
  -> 发起 GitLab 操作时提示配置 Token
```

Token 缺失不阻止应用启动、修改非敏感设置或选择本地文件，只阻止测试连接、远端检查和上传下载。Token 可在设置页的 Token 区块跳过或稍后配置。

安装包允许通过 Forge `extraResource` 预置 GitLab 地址、项目 ID 和真实 Token（`resources/preset.json`）。尚未保存 `settings.json` 时，预置连接配置作为首次启动的初始值；用户保存设置后以用户配置为准，新安装包不会覆盖。首次启动将预置 Token 复制到 `userData/token.json` 明文保存。用户修改后使用用户版本；用户清除后写入空值并标记为用户覆盖，不再次恢复预置值。客户端分支由系统身份自动生成，不进入预置配置。

该设计明确接受以下风险：

- 任何取得安装包的人都能从资源目录提取预置连接配置和 Token。
- 任何能读取当前系统用户目录的人都能直接查看 `token.json`。
- 同一安装包的用户默认共享相同 GitLab 身份。

预置 Token 必须专用、可撤销、尽量短期有效，并限制安装包分发范围。

### 3.2 单次任务

```text
选择文件
  -> 校验本地文件、大小、保存目录和配置
  -> 缺少 Token 时等待用户配置
  -> 查询项目、基础分支 main 和远端同名文件
  -> 必要时确认覆盖
  -> 上传一次
  -> 通过唯一任务标记查询本任务 Commit ID
  -> 按 Commit ID 下载归档到 .part 文件
  -> 校验归档类型、大小并原子重命名为 ZIP
  -> 安全解压到任务临时目录
  -> 原子重命名为正式时间戳目录
  -> 检查上传文件是否存在并清理临时文件
  -> 写日志并展示结果
```

### 3.3 任务状态

```text
IDLE
CHECKING
WAITING_FOR_TOKEN
WAITING_FOR_OVERWRITE_CONFIRMATION
WAITING_FOR_BRANCH_CONFIRMATION
UPLOADING
UPLOADED
DOWNLOADING
EXTRACTING
CLEANING
SUCCESS
SUCCESS_WITH_WARNING
FAILED
```

`FAILED` 同时记录 `failedStage`、错误码和恢复信息。上传成功但下载、解压或清理失败时，保留 Commit ID 和任务 ID，提供无需重新上传的恢复操作。

首版使用 `app.requestSingleInstanceLock()`，只允许一个应用实例和一个活动任务。关闭应用时提示等待或退出；下次启动只清理应用命名的 `.dsm-*.part`、`.dsm-extract-*` 临时项。

## 4. 界面结构

### 4.1 Token 设置页

- 可输入、替换或清除 Token，页面可跳过。
- 显示 Token 来源：安装包预置、用户配置或未配置。
- 有 Token 时验证并显示所属用户。
- 不读取或回填已有 Token 明文到输入框。
- 清除后写入空字符串并标记为用户覆盖，阻止安装包值再次生效。
- 验证失败时显示可操作错误，不展示认证请求头。

### 4.2 文件上传页

- 显示保存目录、连接状态、Token 来源和最近任务。
- 通过 Main 的文件选择框选择文件；拖入时由 Preload 使用 `webUtils.getPathForFile` 取得路径。
- 没有 Token 时允许选择和本地检查文件，但禁用上传按钮并显示“配置 Token”。
- 提供“打开结果目录”。

### 4.3 配置页

| 配置项 | 说明 | 默认值或行为 |
| --- | --- | --- |
| GitLab 地址 | 服务根地址，不含 `/api/v4` | 可由安装包预置 |
| 项目 ID | 数字 ID 或 `group/project` | 可由安装包预置 |
| 客户端分支命名空间 | 系统用户名 + 主机名，例如 `zhangsan-pc01` | 只读展示；每次任务在其下创建带东八区时间戳的分支 |
| 保存目录 | 解压结果根目录 | 用户文档目录下的 `DSM` |
| API 超时 | 普通请求超时 | 30 秒 |
| 下载超时 | 归档请求超时 | 120 秒 |
| 最大上传大小 | 本地文件上限 | 50 MiB |
| 保留 ZIP | 成功后是否保留归档 | 关闭 |
| Token 状态 | 来源、有效性和所属用户 | 非必填，不回显原值 |
| 测试连接 | 验证 Token、项目和基础分支 main | 有 Token 时可执行 |

保存流程：

1. 校验地址、项目 ID 和保存目录。
2. 创建并检查保存目录可写。
3. 有 Token 时验证 Token、项目和基础分支 main；没有 Token 时只保存本地配置并标记未连接。
4. 验证失败保留旧配置；验证成功或仅保存本地配置时原子替换 `settings.json`。

配置保存到 `userData/settings.json`，Token 单独保存到 `userData/token.json`。任务活动期间禁止修改连接相关配置。

### 4.4 日志页

- 按时间倒序显示级别、阶段和消息。
- 支持刷新、复制和二次确认清空。
- 日志持久化，按日期轮转。
- 同时满足最近 7 天和总计不超过 5 MiB 的保留限制。

### 4.5 任务弹窗

显示阶段、文件名、运行时间、错误原因、Commit ID 和可用恢复动作。下载错误区分可重试网络错误和需要用户处理的认证、权限或内容错误。

## 5. 技术架构

### 5.1 总体结构

```text
React Renderer
  Token、上传、配置、日志、任务状态
          |
          | Typed IPC
          v
Electron Main
  ConfigStore
  TokenStore（明文文件）
  TaskController
  GitLabClient
  ArchiveService
  ExtractionService
  Logger
          |
          | HttpTransport / HTTP(S)
          v
GitLab API
```

业务核心不依赖 Electron、操作系统路径或具体网络实现。Main 注入文件系统、Token 文件存储、网络传输和平台能力，Renderer 只调用白名单 IPC。

### 5.2 推荐目录

```text
apps/
  desktop/
    index.html
    package.json
    tsconfig.json
    .oxlintrc.json
    forge.config.mts
    vite.main.config.mts
    vite.preload.config.mts
    vite.renderer.config.mts
    src/
      declarations.d.ts
      main.ts
      preload.ts
      renderer.tsx
      main/
        ipc.ts
        task-controller.ts
        config-store.ts
        token-store.ts
        preset-store.ts
        logger.ts
        platform/
          electron-platform.ts
      renderer/
        App.tsx
        UploadPage.tsx
        SettingsPage.tsx
        LogsPage.tsx
        TaskDialog.tsx
packages/
  core/
    package.json
    tsconfig.json
    src/
      index.ts
      config.ts
      task-state.ts
      errors.ts
      timestamp.ts
      gitlab/
        client.ts
        auth.ts
        project.ts
        client-branch.ts
        repository-file.ts
        archive.ts
      archive/
        safe-extract.ts
        path-policy.ts
      ports/
        http.ts
        platform.ts
resources/
  preset.json            # 构建生成，包含预置连接配置和 Token，不提交 Git
tests/
  unit/
  integration/
  fixtures/
    gitlab/
    archives/
package.json
pnpm-workspace.yaml
pnpm-lock.yaml
```

`create-electron-app` 8.0.1 的 Vite TypeScript 模板实际生成 `index.html`、三个 `vite.*.config.mts`、`forge.config.mts`、`tsconfig.json`、`.oxlintrc.json`、`src/main.ts`、`src/preload.ts`、`src/renderer.ts` 和 `src/declarations.d.ts`。接入 React 时将 Renderer 改为 `src/renderer.tsx` 并同步修改 `index.html`；`src/declarations.d.ts` 不可误删。

根目录只保留一个 pnpm workspace 和 `pnpm-lock.yaml`。脚手架可能在 `apps/desktop` 内生成重复 workspace 或锁文件，合并后删除。

MVP 将共享代码收敛为一个 `@dsm/core` 包。GitLab、归档和任务逻辑在包内按目录拆分，不单独建立 `gitlab-client`、`archive` 或 `platform` workspace 包；Electron 相关的 `PlatformAdapter` 实现在 `apps/desktop/src/main/platform`，由 Main 注入 `@dsm/core`。后续只有在 CLI、其他应用或独立服务需要复用某个模块时，再按实际依赖边界拆包。

包约束：

- `packages/core/package.json` 使用名称 `@dsm/core`，设为 private。
- 对外入口只有 `packages/core/src/index.ts`，内部文件不直接从应用跨路径导入。
- `apps/desktop/package.json` 通过 `"@dsm/core": "workspace:*"` 依赖该包。
- `@dsm/core` 不依赖 Electron、React、Forge、具体操作系统路径或 Token 存储。
- HTTP、文件系统和平台能力通过 `ports/` 接口注入。
- MVP 不为该包单独维护发布版本或 `dist/`；Vite、TypeScript 和测试直接从源码构建。

`tests/` 是后续目标结构，当前仓库尚未创建。MVP 只保留 `unit`、`integration` 和 `fixtures`：单元测试覆盖纯逻辑和边界，集成测试通过 fake HTTP 与临时目录跑完整任务，fixtures 保存 mock 响应和恶意/正常 ZIP。自动化 Electron E2E 推迟到 MVP 稳定后，当前使用手工 UI 和安装冒烟测试。

### 5.3 核心接口

```ts
export interface PlatformPaths {
  userData: string;
  logs: string;
  documents: string;
  downloads: string;
  temporary: string;
}

export interface PlatformAdapter {
  paths(): PlatformPaths;
  revealInFileManager(path: string): Promise<void>;
}

export interface HttpTransport {
  request(url: string, options?: RequestInit): Promise<Response>;
}

export interface TokenRecord {
  schemaVersion: 1;
  token: string;
  source: "preset" | "user";
  updatedAt: string;
}
```

主进程使用 Node 原生 `fetch` 发送请求，GET 请求通过 `RequestInit.mode = 'same-origin'` 让 undici 生成 `Sec-Fetch-Mode: same-origin`，以兼容 GitLab hotlink 防护（直接设置同名 Header 会被忽略）；不依赖 Chromium 网络栈、系统代理或系统证书。core 测试使用 mock transport。路径通过 `app.getPath()` 注入，业务模块不出现 `/Users/...` 或 `C:\...`。

### 5.4 Electron 安全边界

- 开启 `contextIsolation` 和 `sandbox`，关闭 `nodeIntegration`。
- Renderer 只加载本地资源，并设置限制性 CSP。
- 禁止任意页面跳转、非预期 `window.open` 和外部协议。
- Preload 只通过 `contextBridge` 暴露固定、带类型和参数校验的 API。
- IPC 校验发送方和参数，不暴露通用文件系统、Shell 或命令执行能力。
- Token 文件读取、GitLab 请求和文件操作只在 Main 执行。
- Token 输入只在 Renderer 短暂存在，提交后立即清空，Main 不回传已有 Token。

## 6. Token 与配置

### 6.1 预置配置、Token 和明文保存

安装包预置文件 `resources/preset.json` 同时承载连接配置和 Token，所有字段均可省略：

```json
{
  "gitlabUrl": "http://gitlab.example.com",
  "projectId": "123",
  "token": "glpat-example-token"
}
```

连接配置读取顺序：

1. `userData/settings.json` 存在且有效时，以用户配置为准，忽略预置连接字段。
2. 文件不存在或解析失败（备份为 `settings.json.bad`）时，用预置的 `gitlabUrl`、`projectId` 作为首次启动配置；缺失字段使用产品默认值。
3. 首次启动不写入 `settings.json`；用户保存设置后才形成用户配置，此后新安装包不会覆盖。

Token 保存格式：

```json
{
  "schemaVersion": 1,
  "token": "glpat-example-token",
  "source": "preset",
  "updatedAt": "2026-11-05T12:00:00.000Z"
}
```

Token 读取顺序：

1. 读取 `userData/token.json`。`source: "user"` 时直接使用，空字符串表示用户主动清除。
2. `source: "preset"` 时检查安装包预置文件的 `token`。非空则覆盖为新的预置 Token；为空或文件不存在则保留现有预置 Token。
3. 用户文件不存在时检查预置文件；`token` 非空则写入 `token.json` 并设置 `source: "preset"`。
4. 没有用户 Token 或可用预置 Token 时进入未连接状态。

保存规则：

- `token.json` 中的 `token` 字段是明文，不使用任何系统或客户端加密。
- 文件位于 `userData/token.json`，写临时文件后原子替换。
- macOS 设置 `0600`；Windows 使用当前用户目录的默认 ACL。
- 用户修改 Token 并验证成功后写入 `source: "user"`。
- 用户清除 Token 时写入 `token: ""` 和 `source: "user"`，阻止预置值再次恢复。
- 解析失败时将文件备份为 `token.json.bad`，再按无用户文件处理。
- 收到 401 时写入空 Token 并标记为用户覆盖；收到 403 时保留 Token。
- Token 不进入普通配置、URL、任务结果、错误消息或日志，也不返回 Renderer。

构建规则：

- 开发者在打包前手工编辑 `resources/preset.json`，格式参考仓库中的 `resources/preset.example.json`；文件权限 `0600`。
- 打包脚本只校验不生成：检查 JSON 格式、地址协议、`/api/v4` 后缀和项目 ID 格式；非法值终止打包。
- 文件不存在时创建空 `{}`，不覆盖已手工填写的内容。
- Forge `extraResource` 将该文件放入安装包资源目录。
- 生产包从 `process.resourcesPath/preset.json` 读取；开发环境从仓库根目录 `resources/preset.json` 读取。
- 资源文件加入 `.gitignore`，构建日志不得输出 Token。

Token 使用 GitLab `api` scope，因为上传需要 File API 写能力。管理员应使用专用、可撤销、短期有效的 Token。

### 6.2 配置文件

```json
{
  "schemaVersion": 1,
  "gitlabUrl": "http://gitlab.example.com",
  "projectId": "123",
  "saveDirectory": null,
  "preferredReader": "node",
  "nodeReaderPath": null,
  "pythonReaderPath": null,
  "apiTimeoutMs": 30000,
  "downloadTimeoutMs": 120000,
  "maxUploadBytes": 52428800,
  "keepArchive": false,
  "archiveLimits": {
    "maxBytes": 536870912,
    "maxExtractedBytes": 1073741824,
    "maxEntries": 50000
  }
}
```

规则：

- `gitlabUrl` 是服务根地址，不含 `/api/v4`；HTTP 和 HTTPS 均允许。
- `projectId` 支持数字 ID 或未编码的 `group/project`，请求时再编码。
- `saveDirectory: null` 表示 `app.getPath("documents")/DSM`。
- 配置通过 JSON Schema 校验，`schemaVersion` 变化时执行迁移。
- 配置临时文件与正式文件同目录，写入后原子替换。
- 损坏配置备份后进入重新配置流程。
- 上传和归档限制取产品硬上限与配置值的较小值。

## 7. 上传、下载与解压

### 7.1 上传前检查

- 文件存在、可读、大小大于 0，且不超过 50 MiB 硬上限。
- 记录文件大小和修改时间，上传读取前再次 stat；等待确认期间文件变化时要求重新确认。
- 保存目录可创建、可写。
- 联网任务必须已有 Token、GitLab 地址和其他连接配置。
- 查询项目和任务分支；任务分支不存在时，校验固定基础分支 `main` 是否存在。
- 使用 `HEAD /projects/:projectId/repository/files/:path?ref=:taskBranch` 获取文件是否存在及 `X-Gitlab-Last-Commit-Id`。

同名文件存在时（任务分支继承了 `main` 的模板文件），提示“将覆盖远端同名文件”，必须得到用户确认。任务分支本身自动创建，不需要额外确认。

GitLab 不要求客户端在上传前检查远端文件是否被修改。如果不传并发前置条件，`PUT` 仍可提交成功并覆盖确认后的新修改；本方案使用 `last_commit_id` 降低该风险。

### 7.2 上传与 Commit ID

- 远端文件不存在时使用 `POST /projects/:projectId/repository/files/:path`。
- 远端文件存在时使用 `PUT /projects/:projectId/repository/files/:path`。
- 更新时传入预检取得的 `last_commit_id`。
- 上传到仓库根目录，文件名为本地文件名，内容按 File API 要求使用 Base64。
- 读取、编码和上传处于同一单任务锁内，禁止重复提交。

分支处理：

- 每次任务创建一个新分支，名称为 `系统用户名-主机名/东八区时间戳-taskId前6位`。
- 新分支从固定基础分支 `main` 创建（`POST /repository/branches`，`ref=main`）；`main` 必须是只含少量占位文件的空模板。
- 任务分支自动创建，不需要用户确认；若其继承的 `main` 模板中存在同名文件，仍要求覆盖确认。
- 空仓库中可通过一次初始 Commit 创建任务分支。
- 分支创建后上传失败时不自动删除分支，界面明确显示“分支已创建、文件未上传”。

Commit 定位：

- 创建/更新文件接口只保证返回 `branch` 和 `file_path`，不能假设响应包含 `commit_id`。
- Commit message 包含唯一、非敏感任务标记。
- 上传成功后调用提交历史接口，按分支、文件路径和任务标记定位 Commit ID。

```text
GET /projects/:projectId/repository/commits?ref_name=:branch&path=:path&per_page=20
```

只接受包含本任务唯一标记的 Commit。找不到或多次读取失败时，任务进入“上传结果未知”。

上传不使用自动重试。网络超时后先按任务标记查询是否已经产生 Commit：

- 找到：恢复 Commit ID 并继续下载。
- 找不到：结果未知，由用户选择查询远端状态，不直接重复上传。

GitLab 对提交失败通常返回非具体原因的 `400`。收到后重新读取文件元数据和提交历史：

- `last_commit_id` 已变化：提示远端文件被修改，重新确认后才能覆盖。
- 文件未变化但没有确认产生 Commit：可能因内容相同形成空提交，也可能是其他拒绝原因；不能宣称成功。
- 分支、路径或保护规则变化：显示对应的权限或配置处理入口。

50 MiB 文件在 Main 中至少产生原文件 Buffer、Base64 字符串和 JSON 请求体三份数据，需要在目标机器实测峰值内存。

### 7.3 下载归档

```text
GET /projects/:projectId/repository/archive.zip?sha=:taskBranch
```

- 优先使用本次任务分支名；任务分支唯一且创建后不再写入，分支 tip 即本次上传提交。
- 定位 Commit ID 后校验分支 tip；不一致或分支查询失败时回退为 `sha=:commitId`，保证版本一致。
- 先写入 `.dsm-<taskId>.zip.part`，完整写入后原子重命名为 ZIP。
- 检查 `Content-Type`、`Content-Length`（存在时）、实际字节和空响应。
- 归档默认上限 512 MiB。
- 只对连接失败、超时、408、429 和 5xx 自动重试一次。
- 401、403、404、内容类型错误和大小超限不重试。
- 任务成功前不删除 ZIP；成功后按 `keepArchive` 保留或清理。

### 7.4 安全解压

- 拒绝绝对路径、Windows 盘符、`..` 和空字符。
- 只允许普通文件和目录，拒绝符号链接、设备文件和未知类型。
- 拒绝重复目标路径，使用排他写入。
- 最多处理 50,000 个条目。
- 解压总量最多 1 GiB，按实际写出字节累计，不信任 ZIP 头声明。
- Windows 上拒绝保留名称和非法字符，并验证长路径。
- 所有目标路径必须位于任务临时目录内。
- 上传单文件场景只写出本次上传的目标文件；其余条目只做路径、类型和重复校验，
  不写入结果目录，最终目录只保留该文件及其所在目录。

先写入 `.dsm-extract-<timestamp>-*` 临时目录，成功后同一保存目录内原子重命名为正式时间戳目录。失败时清理临时目录。

```text
用户选择的保存目录/
  20261105-193000-123/
    <本次上传的文件>
  20261105-200000-456/
    <本次上传的文件>
```

时间戳使用系统本地时间并包含毫秒或随机后缀，不写死时区。

### 7.5 结果和恢复

首版只检查指定 Commit 的归档是否成功解压，以及目标文件名是否存在；结果目录只
保留本次上传的文件。不比较大小、SHA-256 或字节内容，成功文案使用“上传并从目标
Commit 解压完成”，不使用“完整性已验证”。

| 失败阶段 | 提示 | 恢复动作 |
| --- | --- | --- |
| 上传结果未知 | 可能已经产生 Commit | 查询任务标记，不直接重传 |
| 下载失败 | 文件已上传，归档下载失败 | 按原 Commit ID 重试下载 |
| 解压失败 | 文件已上传，归档解压失败 | 优先复用 ZIP，缺失时重新下载 |
| 清理失败 | 主流程完成，临时文件未清理 | 显示 `SUCCESS_WITH_WARNING` 并重试清理 |

## 8. 日志设计

日志由 Main 统一生成。内部使用结构化对象，持久化文件使用逐行纯文本：

```text
2026-11-05T11:30:04.880Z [INFO] [HTTP] 请求 #8d3f2a1c GET /api/v4/user | {"taskId":"..."}
2026-11-05T11:30:04.960Z [INFO] [HTTP] 响应 #8d3f2a1c 200 OK GET /api/v4/user (78 ms) · {"id":3,"username":"test-api"}
2026-11-05T11:30:05.120Z [INFO] [UPLOAD] 上传完成 | {"commitId":"abc123"}
```

允许记录时间、级别、任务 ID、阶段、HTTP 方法、脱敏 URL、状态码、耗时、文件大小、文件名、项目路径、分支、Commit ID、返回结果摘要、错误码和用户消息。返回 JSON 只记录截断和脱敏后的摘要。

禁止记录 Token、认证请求头、文件内容、Base64 内容、完整上传请求体和敏感 URL 参数。日志写入 `userData/logs`，按日期轮转，同时执行 7 天与 5 MiB 限制。日志页面支持分页和大小写不敏感的全文搜索。

## 9. 安全边界

- Token 预置和明文保存是已确认的产品决策，不得在实现时替换为系统安全存储。
- 明文 Token 文件采用最小文件权限和原子写入，但不提供机密性保护。
- Renderer 不读取已有 Token，不拥有 Node/Python、任意文件系统或命令执行能力。
- 上传和覆盖需要用户确认；任务分支按固定规则自动创建。
- GitLab 地址允许 HTTP 和 HTTPS，不强制协议。
- 上传不自动重试；读取和下载只做有限、可识别错误的重试。
- ZIP 必须执行路径、类型、条目数和解压总量检查，解压结果不执行。
- 正式发布需要 macOS 签名和公证；Windows 后续需要 Authenticode。
- 首版不提供哈希、客户端加密、端到端加密、防篡改审计、自动更新和自定义 CA 管理。

## 10. Electron 工程和打包

### 10.1 技术基线

- Node.js 22.13 或更高。
- 根 `package.json` 固定 `packageManager`，根目录和 `apps/desktop` 声明 `engines.node`。
- 根目录使用 pnpm workspace，只提交一个 `pnpm-lock.yaml`。
- Electron、Forge、Vite、TypeScript 和 `create-electron-app` 版本固定。

### 10.2 创建项目

```bash
pnpm dlx create-electron-app@8.0.1 apps/desktop \
  --template vite \
  --typescript \
  --package-manager pnpm \
  --skip-git
```

完成脚手架后，将 `apps/desktop` 纳入根 workspace，合并并删除子目录重复锁文件或 workspace 配置。

```bash
pnpm add -Dw vitest
cd apps/desktop
pnpm add react react-dom
pnpm add -D @types/react @types/react-dom @vitejs/plugin-react @electron-forge/maker-dmg
pnpm start
```

在 `vite.renderer.config.mts` 启用 React 插件，在 `tsconfig.json` 启用 `jsx: "react-jsx"`。工作区包使用 `workspace:*` 和统一的 TypeScript 路径别名。

### 10.3 Forge 配置

```ts
packagerConfig: {
  asar: true,
  extraResource: ["resources/preset.json"],
}

makers: [
  new MakerDMG({ format: "ULFO" }),
  new MakerNSIS({}),
  new MakerZIP({}, ["darwin", "win32"]),
]
```

- Forge 只调用当前构建平台支持的 Maker。
- DMG 在 macOS 构建机生成，NSIS 在 Windows 构建机生成。
- 不在 Forge 配置中用 `process.platform` 手工复制平台分支。
- 预置文件必须存在；不存在时由校验脚本生成空 `{}`，不覆盖已手工填写的内容。
- 构建完成后检查 `preset.json` 确实位于安装包资源目录。

常用命令：

| 命令 | 用途 | 产物 |
| --- | --- | --- |
| `pnpm start` | 开发运行 | 无发布物 |
| `pnpm run typecheck` | 类型检查 | 检查结果 |
| `pnpm run test` | Vitest 单元和集成测试 | 测试报告 |
| `pnpm run package` | 未安装应用 | `out/` |
| `pnpm run make` | 当前平台安装包 | `out/make/` |

`pnpm run test` 在仓库根目录执行；其余 Electron 命令在 `apps/desktop` 目录执行。

首版不使用 `pnpm run release`，避免未配置发布渠道时误上传产物。

## 11. 跨平台发布

### 11.1 平台矩阵

| 项目 | macOS MVP | Windows 后续 |
| --- | --- | --- |
| 架构 | Apple Silicon `arm64` | x64 |
| 系统 | 以所用 Electron 支持范围为准 | Windows 10/11 |
| 安装包 | DMG + ZIP | NSIS `Setup.exe` + ZIP |
| Token | `token.json` 明文 | `token.json` 明文 |
| 预置配置和 Token | `extraResource` 明文文件 | `extraResource` 明文文件 |
| 签名 | Apple Developer 签名和公证 | Authenticode |

安装器必须在目标平台构建，macOS 交叉构建 Windows 安装包不作为正式发布方案。

### 11.2 macOS

- `pnpm run package` 验证应用目录。
- `pnpm run make -- --arch=arm64` 生成 DMG 和 ZIP。
- 不构建 `x64` 或 Universal Binary，构建机必须确认自身为 `arm64`。
- 未签名或未公证包只用于内部测试。

### 11.3 Windows

- `pnpm run make:win` 生成 NSIS `Setup.exe`、blockmap 和 ZIP。
- Windows 安装格式统一使用 NSIS，不再生成 Squirrel `RELEASES` 或 `.nupkg`。
- 验证反斜杠、盘符、中文目录、长路径、保留名称、非法文件名和文件占用。
- 验证同名覆盖、ZIP 解压、安装、覆盖升级和卸载。

### 11.4 CI

```text
pnpm install --frozen-lockfile
  -> 类型检查、单元测试和跨平台集成测试
  -> macOS arm64：make --arch=arm64
  -> Windows x64：make --arch=x64
  -> 签名/公证
  -> 上传 out/make 安装包
```

预置文件由打包者手工填写，或在 CI 中从 Secret 写入。签名凭据与 Token 均为 CI Secret，不进入仓库或日志。CI 成功不能替代目标平台真机验收。

## 12. 现有代码迁移

| 现有代码 | 处理方式 | 原因 |
| --- | --- | --- |
| `gitlab-api.ts` | 抽取并重构 | 保留端点、请求字段和错误映射；增加 transport、并发前置条件和 Commit 查询 |
| `archive.ts` | 保留核心并加固 | 保留路径防护和顶层目录处理；增加条目数、解压量、重复路径和平台限制 |
| `gitlab-sync.ts` | 只复用流程 | 改为 `TaskController`，删除 CLI 输出和硬编码时区 |
| `config.ts` | 替换 | 删除个人路径和 PDF 默认值，改用 `ConfigStore` 与 schema |

迁移必须修正：

- 当前代码从创建/更新响应读取 `commit_id`，但该接口不保证返回此字段；改为任务标记查询。
- 当前代码按分支名下载归档；改为按任务分支名下载，并校验分支 tip 后回退 Commit ID。
- 当前同名文件检查只判断 200/404；增加 `last_commit_id` 并发保护。
- 当前下载失败可能遗留部分 ZIP；改用 `.part` 并在最终失败时清理。
- 当前上传没有自动重试问题以外的结果恢复；保持上传不自动重试并增加结果查询。
- 当前时间戳写死 `Asia/Shanghai`；改为系统本地时间。
- 当前 `.env` Token 和固定个人路径不得带入桌面应用。
- 当前 README 的旧启动命令和个人路径不得作为安装包默认值。

## 13. 测试计划

MVP 统一使用 Vitest 运行单元测试和集成测试，`tests/` 和根 `pnpm run test` 脚本放在仓库根目录，不引入第二套测试框架。自动化测试只覆盖高风险、可重复的逻辑；真实 GitLab、UI 和安装包使用少量手工冒烟测试。

### 13.1 单元测试

`tests/unit/` 测试不启动 Electron、不访问网络，也不读写真实用户目录：

- 配置校验、URL 处理和配置迁移。
- Token 预置优先级、用户清空覆盖、明文文件恢复和 401/403 行为。
- 任务状态、失败阶段、重启恢复动作和上传不自动重试。
- 本地文件在确认后变化时停止上传。
- `last_commit_id` 冲突、无 `commit_id` 响应和内容未变化时的处理。
- ZIP 绝对路径、`..`、链接、重复路径、条目数和解压总量。
- 日志脱敏及 7 天/5 MiB 清理。

### 13.2 集成测试

`tests/integration/` 使用 fake `HttpTransport` 和系统临时目录，验证完整流程，不连接生产 GitLab：

- 新文件上传、覆盖、每次任务自动创建分支和 Commit 定位。
- 按任务分支下载归档，分支 tip 不一致时回退 Commit ID。
- 上传成功、下载失败、解压失败和清理失败的状态转换。
- `.part`、解压临时目录和正式时间戳目录的创建、重命名与清理。

`tests/fixtures/` 只保存 mock GitLab 响应、示例配置和 ZIP：

```text
tests/fixtures/
  gitlab/
    file-found.json
    file-not-found.json
    upload-conflict.json
  archives/
    valid.zip
    path-traversal.zip
    duplicate-entry.zip
```

MVP 保留一次针对专用 GitLab 测试项目的受控手工冒烟测试，不使用自动化测试访问生产项目。

### 13.3 MVP 暂不自动化

- Playwright Electron E2E：MVP 使用手工启动、配置和完整任务冒烟，稳定后再补自动化。
- macOS 签名、公证和 Gatekeeper：作为发布检查执行，不放进每次提交的测试。
- Windows 兼容性测试：Windows 阶段再增加。
- 全量错误组合和 UI 像素测试：只测试会影响提交、归档版本或文件安全的关键路径。

## 14. MVP 验收标准

- Apple Silicon Mac 可安装并启动应用。
- 没有 Token 时仍可启动、修改非敏感配置和选择本地文件。
- 安装包可预置 GitLab 地址、项目 ID 和 Token；首次启动使用预置配置并写入明文 `token.json`，用户保存设置后以用户配置为准。
- 用户可替换或清除 Token；清除后预置值不会自动恢复。
- Token 不返回 Renderer，不出现在配置、任务结果或日志中。
- 可上传单个合法文件，并在覆盖前确认；任务分支自动创建。
- 上传只提交一次；超时后不自动产生重复 Commit。
- 上传后通过任务标记定位 Commit ID，并下载该 Commit 的归档。
- 任务分支创建后不再写入；分支 tip 变化时回退 Commit ID，保证归档与重试的一致性。
- 上传成功但下载、解压或清理失败时显示明确阶段和恢复动作。
- 下载失败不遗留应用 `.part`，解压失败不生成看似成功的正式目录。
- 恶意或超限 ZIP 无法写出目标目录或绕过资源限制。
- 重复任务生成新时间戳目录，不覆盖历史结果。
- 日志具备脱敏和 7 天/5 MiB 限制。
- 不执行 SHA-256、大小或内容比较，界面不宣称完整性已验证。
- macOS 构建固定 `arm64`，不产出 Intel 或 Universal 包。

## 15. 关键风险

| 风险 | 影响 | 应对 |
| --- | --- | --- |
| 安装包或明文 Token 文件泄露 | 拿到安装包或用户目录访问权即可获得 Token | 已接受；使用专用、短期、可撤销 Token，限制分发并及时轮换 |
| 完整归档下载 | 项目增大后速度慢且磁盘占用高 | 每次任务从空模板 `main` 创建独立分支，归档只含 `main` 模板 + 本次文件；保留下载和解压上限 |
| Base64 上传内存 | Main 可能瞬时占用约三份文件大小的内存 | 50 MiB 硬上限并在目标环境实测 |
| GitLab 请求体或代理限制 | 目标实例可能提前拒绝上传 | 在 GitLab、反向代理和 WAF 上验证上限 |
| 上传结果未知 | 超时可能已提交 | 禁止自动重试，通过任务标记查询 |
| 读写权限判断不充分 | 读取成功仍可能被保护分支拒绝 | 明确提示 403，不把读取检查表述为写权限证明 |
| ZIP 炸弹和恶意路径 | 磁盘耗尽或文件写出目标目录 | 类型白名单、路径校验、条目数和实际解压量 |
| 缺少哈希校验 | 无法证明内容一致 | 使用准确文案，不承诺完整性验证 |
| 企业代理和证书差异 | 私有 GitLab 请求失败 | 验证 Electron 网络栈，提供受控代理策略，不忽略 TLS |
| 签名和公证 | Gatekeeper 或 SmartScreen 阻止正式分发 | 内部包和正式包分离，发布前补齐签名 |
| Windows 文件语义 | 长路径、保留名和占用导致失败 | Windows 真机专项测试并提供明确错误 |

## 16. 实施顺序与排期

详细的分阶段实现、测试命令、验收用例和发布门槛见 [实施步骤与验收清单](implementation-and-acceptance.md)。

1. 修复当前依赖基线，确保 `pnpm install --frozen-lockfile` 和 `pnpm run check` 通过。
2. 固定 Node.js、pnpm、Electron、Forge、Vite 和 `create-electron-app` 版本，建立根 workspace。
3. 实现 `HttpTransport`、`PlatformAdapter`、`ConfigStore`、`TokenStore`、预置 Token 加载、`Logger` 和任务状态。
4. 完成精确 Commit 上传/归档、安全解压和失败恢复测试。
5. 实现 Token 非必填交互、四个页面和任务弹窗。
6. 生成带预置 Token 的测试构建，验证安装包资源位置和首次启动导入。
7. 完成 Apple Silicon 安装、真实 GitLab 冒烟和完整异常流程验收。
8. macOS MVP 稳定后再进行 Windows x64 适配。

| 阶段 | 时间 | 交付物 |
| --- | ---: | --- |
| Forge 工程、workspace 和迁移骨架 | 3–4 天 | 可启动应用、共享包、配置与接口 |
| Token、配置和网络层 | 2–3 天 | 预置导入、明文保存、连接验证 |
| 上传、下载、解压和恢复 | 4–5 天 | 精确 Commit、并发保护、安全 ZIP |
| Renderer、日志和任务状态 | 3–4 天 | 页面、弹窗和脱敏日志 |
| 打包和 macOS 完整验收 | 2–3 天 | arm64 DMG、预置 Token 和真实流程 |

macOS MVP 约 14–19 个工作日。Windows 基础适配、安装和兼容性验收预计增加 5–7 个工作日。该估算不包含签名账号申请、公证审核和发布审批。
