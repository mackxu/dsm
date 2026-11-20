# @dsm/core

DSM 工具的领域核心包，包含与界面、Electron 无关的业务逻辑：

- GitLab 单文件同步任务：校验配置、创建任务分支、上传文件、定位 Commit、下载归档、安全解压；
- DSM UNLOCK 本地直写任务：白名单读取器流 → 哈希/限流管道 → 白名单写入器流 → 校验后原子改名；
- 配置、安装包预置值、Token 记录与校验规则；
- 客户端分支命名、UTC+8 时间戳、任务与复制任务状态机；
- 归档路径策略与带资源限制的安全解压。

网络请求、用户目录与明文的读取/写入均通过构造参数注入，包本身不依赖 Electron，可在
Node 与 Vitest 中直接运行。

## 在仓库中的位置

```text
apps/desktop ─────────────┐
                          ├──► @dsm/core
apps/local-unlock ────────┤
                          │
@dsm/desktop-runtime ─────┘
```

两个应用同时依赖 `@dsm/core` 与 `@dsm/desktop-runtime`；`@dsm/desktop-runtime` 依赖
`@dsm/core`，并提供 core 所需端口的子进程实现。包以 TypeScript 源码形式被消费：
`package.json` 的 `exports` 指向 `src/index.ts`，没有独立构建步骤，由使用方的
Vite/tsx/tsc 转译。

## 模块地图

| 路径                          | 职责                                                                        |
| ----------------------------- | --------------------------------------------------------------------------- |
| `src/config.ts`               | `AppConfig`、`ReaderSelection`、归档限制、保存目录解析与校验                |
| `src/preset.ts`               | 安装包 `preset.json` 预置配置的解析与合并                                   |
| `src/token.ts`                | Token 记录格式、来源（preset/user）、状态与鉴权失败处理                     |
| `src/client-branch.ts`        | 客户端分支命名空间与任务分支名，基础分支固定为 `main`                       |
| `src/timestamp.ts`            | 固定 UTC+8 的任务时间戳，格式 `YYYYMMDD-HHmmss-SSS`                         |
| `src/errors.ts`               | `DsmError`、错误码与任务阶段                                                |
| `src/gitlab/client.ts`        | GitLab REST 客户端：连接测试、文件元数据、上传、分支、Commit 定位、归档下载 |
| `src/task-controller.ts`      | GitLab 同步任务编排，对外提供 `start` / `confirm` / `recover`               |
| `src/task-state.ts`           | 任务快照、状态迁移与恢复动作                                                |
| `src/archive/path-policy.ts`  | 归档条目路径规范化与越界拒绝                                                |
| `src/archive/safe-extract.ts` | 带条目数/大小限制的安全解压，可只保留本次上传的文件                         |
| `src/copy/copy-config.ts`     | 本地直写配置、文件大小与超时上限                                            |
| `src/copy/copy-controller.ts` | 本地直写任务编排：读取流 → 校验 → 写入流 → 原子改名                         |
| `src/copy/copy-state.ts`      | 本地直写任务状态机                                                          |
| `src/ports/http.ts`           | `HttpTransport`、`PlatformAdapter` 端口                                     |
| `src/ports/file-content.ts`   | `FileContentReader` 端口（一次性读取明文）                                  |
| `src/ports/copy-stream.ts`    | `FileStreamReader` / `FileStreamWriter` 端口（流式读写）                    |

## 设计约定

- 平台能力通过端口注入：`HttpTransport`、`FileContentReader`、`FileStreamReader`、
  `FileStreamWriter`、`PlatformAdapter`。包内不导入 Electron API，用户目录由调用方提供。
- 错误统一为 `DsmError`（`code` + `stage` + `recoverable`），调用方按错误码分支，
  不依赖错误消息文本。
- 任务与复制任务都使用显式状态机，只允许合法迁移；快照不可变，变更通过 `onUpdate`
  回调推送。
- 时间戳固定按 UTC+8 生成，不依赖系统时区。
- 解压拒绝绝对路径、`..`、Windows 绝对路径/保留名/非法字符；只写入
  `onlyRelativePath` 指定的文件，保证结果目录只含本次上传内容。
- 明文只出现在流管道与内存中，不写临时明文文件。
- Token 的持久化由应用层负责，core 只定义记录格式与解析、校验规则。

## 开发

```bash
# 在仓库根目录
pnpm --filter @dsm/core typecheck
pnpm test
```

单元与集成测试位于仓库根 `tests/unit`、`tests/integration`，通过注入假 transport、
假读取器/写入器覆盖任务流程。完整产品行为见[根 README](../../README.md)。
