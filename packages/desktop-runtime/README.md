# @dsm/desktop-runtime

两个 Electron 应用共享的主进程运行时模块，封装 DSM 环境下的外部依赖与通用能力：

- DSM 白名单读取器（Node / Python）的探测、解析与调用；
- 启动时的读取器链检查；
- 通过白名单 PowerShell 流式写入的写入代理与「测试写入」；
- 运行日志的写入、分页查询、脱敏与轮转清理；
- 主窗口尺寸适配。

包本身不导入 `electron`，只依赖 Node 内置模块与 `@dsm/core`，可被两个应用的 Main
进程复用，也可在 Vitest 中直接测试。

## 在仓库中的位置

```text
apps/desktop ─────────────┐
                          ├──► @dsm/desktop-runtime ───► @dsm/core
apps/local-unlock ────────┘
```

`@dsm/core` 定义端口与业务规则，本包提供这些端口在桌面环境下的实现（读取器、写入器）、
以及日志等主进程基础设施。

## 模块地图

| 路径                             | 职责                                                                                                                          |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `src/logger.ts`                  | 按日期写入 `dsm-YYYY-MM-DD.log`，`list` 分页查询，`redactString` / `redactValue` 脱敏；只保留 7 天内的文件，日志总量上限 5 MB |
| `src/reader-executable.ts`       | 读取器解析公共骨架：显式配置 → 环境变量 → 候选路径，版本探测与最小环境变量                                                    |
| `src/node-path.ts`               | Node 候选路径：PATH、常见安装目录、nvm / fnm / Volta                                                                          |
| `src/python-path.ts`             | Python 候选路径：PATH、pyenv / conda 等，最低 3.8                                                                             |
| `src/reader-chain.ts`            | 优先读取器 → 备用读取器的解析链                                                                                               |
| `src/whitelisted-file-reader.ts` | `read` / `openStream` / `checkAvailability` / `probe`，调用外部 helper 读取明文                                               |
| `src/powershell-writer.ts`       | `open` 建立写入会话、`checkAvailability`、`testWrite`；解析并校验 PowerShell                                                  |
| `src/startup-reader-check.ts`    | 启动 3 秒后探测读取器链，失败时只提示一次                                                                                     |
| `src/window-size.ts`             | 按屏幕工作区计算窗口尺寸（400×540 至 480×680）                                                                                |

## 设计约定

- 解析顺序统一为：设置中的路径 → 环境变量（`DSM_NODE_PATH` / `DSM_PYTHON_PATH` /
  `POWERSHELL_PATH`）→ 自动探测。显式配置不可执行时直接失败，不回退；只有优先读取器
  未显式配置且自动探测完全失败，才尝试另一个读取器。
- 外部 helper 路径由应用注入，运行时来自安装包资源目录的 `extraResource`
  （`dsm-file-reader.cjs`、`dsm-file-reader.py`、`dsm-file-writer.ps1`），不进入 asar。
- Python 读取固定使用 `-I -S -B -u`，避免加载用户环境和字节码缓存；子进程使用最小
  环境变量。
- 写入代理只创建目标目录下的临时 `.part` 文件，最终 rename 与失败清理由 `@dsm/core`
  的 `CopyController` 负责。
- 日志写入前对 Token 等敏感字段脱敏，文件内容不会进入日志。
- 明文只经过子进程的 stdout / stdin 管道与主进程内存，不落盘。

## 开发

```bash
# 在仓库根目录
pnpm --filter @dsm/desktop-runtime typecheck
pnpm test
```

单元测试位于仓库根 `tests/unit`（如 `node-path`、`python-path`、`powershell-writer`、
`startup-reader-check`、`logger`）。完整行为见[根 README](../../README.md)。
