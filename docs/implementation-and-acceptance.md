# DSM 文件同步助手实施步骤与验收方法

> 依据：[产品技术方案](product-technical-plan.md)  
> 目标：交付 macOS Apple Silicon MVP，并为 Windows x64 保留清晰迁移路径。

## 1. 实施原则

- 先完成可测试的业务核心，再接 Electron UI。
- 每个阶段必须有可执行命令和明确退出条件。
- 上传只提交一次；下载必须绑定本次上传产生的 Commit ID。
- Token 预置、明文保存和非必填是已确认需求。
- 自动化测试不连接生产 GitLab；真实 GitLab 冒烟只使用专用测试项目。
- MVP 不引入 Playwright、Windows 测试或签名自动化。

## 2. 实施步骤

### 阶段 0：修复当前基线

工作：

- 检查根 `package.json`、`pnpm-lock.yaml` 和 `node_modules` 是否一致。
- 修复当前 TypeScript 检查失败，确保现有 `src/` 可构建。
- 清理旧的 `npx` 启动方式、个人绝对路径和个人 PDF 默认值。
- 确认 Node.js 22.13+、pnpm 和 GitLab 测试项目可用。

完成门槛：

```bash
pnpm install --frozen-lockfile
pnpm run check
```

验收结果：

- 安装无报错。
- TypeScript 检查通过。
- 仓库不存在会被提交的真实 Token。
- 现有 CLI 只作为迁移参考，不继续扩展。

### 阶段 1：建立 Electron workspace

工作：

- 使用 `create-electron-app` 创建 `apps/desktop`。
- 建立根 pnpm workspace 和唯一的 `pnpm-lock.yaml`。
- 接入 React、Vite React 插件和 Forge Maker。
- 创建单个共享包 `packages/core`。
- 配置根目录 Vitest。
- 调整根 `check` 脚本，使类型检查同时覆盖现有 CLI、`packages/core` 和 `apps/desktop`，不能只检查根 `src/`。

命令：

```bash
pnpm add -Dw vitest
pnpm dlx create-electron-app@8.0.1 apps/desktop \
  --template vite \
  --typescript \
  --package-manager pnpm \
  --skip-git
cd apps/desktop
pnpm add react react-dom
pnpm add -D @types/react @types/react-dom @vitejs/plugin-react @electron-forge/maker-dmg
pnpm start
```

完成门槛：

- Electron 空窗口可启动。
- Renderer 使用 React。
- `forge.config.mts` 可生成未安装应用。
- 根 workspace 能解析 `@dsm/core`。
- 修改 `packages/core` 或桌面应用的类型错误会导致根 `pnpm run check` 失败。

建议先实现的目录：

```text
packages/core/src/
  index.ts
  config.ts
  task-state.ts
  errors.ts
  gitlab/
  archive/
  ports/
apps/desktop/src/main/
  ipc.ts
  token-store.ts
  preset-store.ts
  task-controller.ts
  logger.ts
  platform/electron-platform.ts
apps/desktop/src/renderer/
  App.tsx
  TokenSetupPage.tsx
  UploadPage.tsx
  SettingsPage.tsx
  LogsPage.tsx
  TaskDialog.tsx
```

### 阶段 2：实现配置、Token 和平台端口

工作：

- 定义 `HttpTransport`、`PlatformAdapter`、`ConfigStore`、`TokenStore` 和任务状态接口。
- 实现安装包 Token 读取、`token.json` 明文写入、用户覆盖和用户清空。
- 实现配置校验、默认保存目录和原子写入。
- 实现 Token 可选状态与未连接状态。
- 实现日志脱敏入口。

完成门槛：

- 单元测试覆盖 Token 预置优先级、用户清空、损坏文件和 401/403。
- 单元测试覆盖配置解析、路径校验和状态转换。
- 不启动 Electron 也能运行这些测试。

### 阶段 3：迁移 GitLab 客户端

工作：

- 抽取现有 `gitlab-api.ts` 的端点、请求字段和错误映射。
- 通过构造参数注入 `HttpTransport` 和配置。
- 实现用户、项目、分支和文件元数据查询。
- 使用 `HEAD` 获取 `X-Gitlab-Last-Commit-Id`。
- 实现创建/更新文件请求。
- 实现任务标记 Commit 查询。
- 对上传、读取和下载分别定义重试策略。

完成门槛：

- fake HTTP 覆盖成功、400、401、403、404、429、超时和 5xx。
- 更新请求包含预检的 `last_commit_id`。
- 不依赖创建/更新响应中的 `commit_id`。
- 上传请求绝不会自动重试。

### 阶段 4：实现任务主流程

工作：

- 实现本地文件检查及确认后变化检测。
- 实现远端文件存在检查、覆盖确认和分支创建确认。
- 实现上传、Commit 定位、指定 Commit 归档下载。
- 实现 `.part` 临时文件和原子重命名。
- 实现 ZIP 路径、类型、条目数和解压总量防护。
- 实现解压临时目录、正式时间戳目录和失败恢复。
- 实现 `SUCCESS_WITH_WARNING` 清理告警。

完成门槛：

- 集成测试可从头完成一次“上传到新文件”的任务。
- 使用 fake GitLab 覆盖新文件、覆盖、创建分支、上传结果未知、下载失败和解压失败。
- 任意失败都不会生成完整的“成功”目录。
- 重新下载仍使用原 Commit ID。

### 阶段 5：完成 Electron IPC 和 UI

工作：

- Preload 暴露固定、带类型的 IPC API。
- 接入文件选择和拖入路径。
- 实现 Token 页面、上传页、配置页、日志页和任务弹窗。
- 无 Token 时保留本地操作并禁用上传。
- 任务期间锁定关键配置。
- Renderer 不读取已有 Token。

完成门槛：

- `pnpm start` 可完成手工主流程。
- 无 Token、有效 Token、用户清空三种状态均可进入对应页面。
- Renderer 无法通过 IPC 读取 Token 原文或执行任意路径操作。

### 阶段 6：日志、生命周期和清理

工作：

- 结构化日志转换为逐行纯文本写入 `userData/logs`。
- 记录脱敏的 HTTP 请求、响应状态、耗时和返回结果摘要。
- 实现 7 天/5 MiB 双限制、日志页面分页和全文搜索。
- 使用单实例锁限制应用实例。
- 任务运行时关闭应用给出提示。
- 下次启动清理应用命名的 `.dsm-*.part` 和 `.dsm-extract-*`。

完成门槛：

- 日志中找不到 Token 和认证请求头。
- 强制退出后再次启动可以清理残留临时项，不删除正式目录。
- 日志轮转测试通过。

### 阶段 7：预置配置、预置 Token 和安装包

工作：

- 打包前手工编辑 `resources/preset.json`，格式参考 `resources/preset.example.json`。
- 打包脚本只校验不覆盖：检查 JSON 格式、地址、项目 ID 和分支；非法值终止打包，日志不输出 Token。
- 文件不存在时生成空 `{}`。
- Forge 通过 `extraResource` 将文件放入安装包。
- 尚无 `settings.json` 时，预置连接配置作为首启配置；用户保存后以用户配置为准。
- 首次启动复制 Token 到 `userData/token.json`，`source` 标记为 `preset`。
- 用户清空后写入空 Token 和 `source: "user"`。

构建：

```bash
# 在仓库根目录执行；先填写 resources/preset.json
cp resources/preset.example.json resources/preset.json   # 首次使用时
# 编辑 resources/preset.json 后执行
pnpm run make:mac
```

完成门槛：

- 安装包资源目录中存在 `preset.json`。
- 首次启动后设置页显示预置的 GitLab 地址、项目 ID 和分支。
- 保存设置后修改预置文件并重启，用户配置不被覆盖。
- 首次启动后 `token.json` 可直接读取并包含预置 Token。
- 用户覆盖和清空后重新启动，预置 Token 不会错误恢复。
- 构建日志和产物日志不输出 Token。
- DMG 只包含 `arm64` 应用。

### 阶段 8：真实 GitLab 冒烟与发布检查

准备：

- 专用 GitLab 测试项目。
- 专用测试分支。
- 可撤销的 `api` scope Token。
- 一份小体积测试文件，不使用生产敏感文件。

流程：

1. 启动应用并验证 Token 所属用户。
2. 上传测试文件到新分支或专用分支。
3. 记录任务显示的 Commit ID。
4. 在 GitLab 中确认文件属于该 Commit。
5. 完成归档下载和安全解压。
6. 确认解压结果存在原文件名，且结果目录只包含该文件。
7. 构造下载或解压失败，执行恢复操作。

完成门槛：

- 一次完整上传、下载、解压成功。
- 至少一次下载失败可恢复。
- 至少一次解压失败可恢复。
- 分支后续提交不影响原任务归档版本。

## 3. 验收方法

### 3.1 自动化验收

每次提交运行：

```bash
pnpm install --frozen-lockfile
pnpm run check
pnpm run test
```

自动化验收范围：

- `tests/unit/`：纯逻辑、边界和状态转换。
- `tests/integration/`：fake HTTP、临时目录和完整任务。
- `tests/fixtures/`：mock GitLab JSON、正常 ZIP、恶意 ZIP。

MVP 不要求自动化覆盖：

- Electron 页面点击流程。
- DMG 安装、签名和公证。
- Windows 文件系统行为。

### 3.2 核心验收用例

| ID | 场景 | 方法 | 通过标准 |
| --- | --- | --- | --- |
| T01 | 无 Token 冷启动 | 手工 | 应用可启动，可编辑配置和选择文件，上传入口提示配置 Token |
| T02 | 预置配置和 Token 首启 | 安装包 + 手工 | 设置页初始值来自预置文件；`token.json` 为明文，`source` 为 `preset`，应用使用该 Token |
| T03 | 用户覆盖 Token | 手工 | 新 Token 写入后 `source` 为 `user`，重启后保持 |
| T04 | 用户清空 Token | 手工 | 写入空 Token 和 `source: "user"`，重启不恢复预置值 |
| T05 | 新文件上传 | 真实测试 GitLab | 远端文件出现，Commit ID 可定位，归档中使用该 Commit |
| T06 | 覆盖同名文件 | 手工 + 真实测试 GitLab | 先确认再提交；确认后远端变化时阻止静默覆盖 |
| T07 | 文件上传前变化 | 单元/集成 | 文件大小或修改时间变化后停止上传并要求重新确认 |
| T08 | 上传结果未知 | 集成测试 + 手工核对 | 不自动重传；通过任务标记查询是否已产生 Commit |
| T09 | 分支不存在 | 手工 | 未确认不创建；确认后才创建，失败时明确显示远端副作用 |
| T10 | 指定 Commit 下载 | 集成测试 | 上传后分支继续前进，归档仍属于原 Commit |
| T11 | 下载失败恢复 | 集成测试 + 手工 | 自动重试符合规则，最终失败保留 Commit ID |
| T12 | 恶意 ZIP | 自动测试 | 路径穿越、链接、重复条目和超限 ZIP 均被拒绝 |
| T13 | 解压失败清理 | 集成测试 | 不生成正式成功目录，不遗留可误用的临时目录 |
| T14 | 日志脱敏 | 自动测试 + 手工检查 | 日志无 Token、认证头和文件内容，轮转符合限制 |
| T15 | arm64 安装包 | 命令 + 手工 | DMG 安装启动成功，应用架构为 `arm64` |
| T16 | 预置配置打包 | 资源检查 + 安装启动 | 安装包资源存在预置文件，首启后配置已填充并可完成验证与上传 |

### 3.3 发布前人工验收

在干净的 Apple Silicon macOS 用户环境执行：

1. 安装 DMG，确认 Gatekeeper 行为符合预期。
2. 首次启动，确认预置连接配置已填充、预置 Token 被导入。
3. 清除 Token，重启，确认不会被预置值恢复。
4. 重新输入专用 Token，测试连接。
5. 选择一次测试文件，完成上传、下载、解压。
6. 检查任务目录、Commit ID、日志和 ZIP 保留策略。
7. 执行一次只重试下载/解压的失败恢复。
8. 检查应用版本、架构和安装包资源。

### 3.4 发布判定

可以发布时，以下条件必须全部满足：

- `pnpm run check` 和 `pnpm run test` 通过。
- T01–T16 全部通过，或未通过项有明确书面豁免。
- 真实 GitLab 冒烟测试通过，且不接触生产敏感文件。
- 安装包只包含 `arm64`，可安装、启动和完成任务。
- 预置配置、预置 Token 和明文 `token.json` 的行为符合已确认需求。
- 日志中不存在 Token 或认证请求头。
- 恶意 ZIP 无法写出目标目录或绕过解压限制。
- 上传超时不自动重试，结果未知时有可执行的恢复路径。

发布前应保存以下证据：

- 构建版本、Git 提交、Node/pnpm/Electron/Forge 版本。
- 自动化测试命令和结果。
- 安装包文件名、架构和校验和。
- T01–T16 的通过记录。
- 真实 GitLab 测试项目、分支和测试 Commit ID。
- 未通过项、风险接受人和后续处理计划。

## 4. Windows 后续实施

macOS MVP 稳定后再进行：

1. 在 Windows x64 构建机运行同一套单元和集成测试。
2. 验证路径、长路径、保留名称、文件名编码和文件占用。
3. 验证 `token.json` 明文保存、重启恢复和用户 ACL。
4. 生成 NSIS 安装包并完成安装、升级、卸载和业务流程验收。
5. 增加 Authenticode 后重新执行安装和启动检查。
