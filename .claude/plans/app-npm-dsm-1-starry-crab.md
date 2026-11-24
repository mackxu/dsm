# 新增 `jsdsm` CLI：DSM 加密文件读取 + PowerShell 直写

## Context

现有 `apps/local-unlock`（DSM UNLOCK）是 Electron 桌面应用，链路为：

```text
DSM 白名单 Node/Python 读取明文
  → Node 主进程管道（限流 + SHA-256）
  → DSM 白名单 PowerShell（dsm-file-writer.ps1）写目标目录 .part
  → Node 校验字节数与 SHA-256 后 rename 为最终文件
```

仓库中不存在密码学解密或密钥管理：所谓“解密”完全依赖 DSM 透明加密驱动对白名单
进程返回明文；写入同理，必须借 PowerShell 完成，否则内容可能被重新加密或被拦截。

本次新增一个独立、可发布到公共 npm 的 CLI 包 `jsdsm`：

```bash
npx @pxsemic/jsdsm "<文件路径>"             # 输出到源文件所在目录
npx @pxsemic/jsdsm "<文件路径>" "<输出目录>"   # 输出到指定目录
```

已确认的产品决策：

- 仅支持单个文件（MVP 不做目录批量）。
- **读取**：当前 Node 进程直接 `fs` 读取。
- **写入**：按现有 local-unlock 方案，明文经 stdin 交给 PowerShell 写临时文件。
- 默认输出目录 = 源文件所在目录；目录不存在时递归创建。
- 同名目标自动改名（`a.txt` → `a (1).txt`），绝不覆盖。
- 不做“是否真正解出明文”的校验（用户明确选择）。
- 公共 npm 包，包名 `@pxsemic/jsdsm`（命令名 `jsdsm`），MIT，`engines.node >= 18`。
- 不读取/不存储任何密钥。

## 关键取舍

- **复用现有 PowerShell 写入协议与 helper 脚本**：原样打包
  `resources/dsm-file-writer.ps1`，沿用 `COPY_TARGET_DIR` / `COPY_FILE_NAME` /
  `COPY_TEMP_NAME` 环境变量、stdin 原始字节、stdout `{"bytes":N,"sha256":"..."}`、
  stderr `{"code":"WRITE_FAILED","messageBase64":"..."}` 协议。
- **不复用 `PowerShellWriter` 类与 `@dsm/core` / `@dsm/desktop-runtime`**：两包均为
  `private`，`PowerShellWriter` 还依赖 Logger、DsmError 等；发布包直接打包这些源码
  会带入无关模块。CLI 实现一个精简的 PowerShell 启动/解析层（约 200 行），行为与
  `powershell-writer.ts` 对齐：配置 → `JSDSM_WRITER_PATH` → 自动探测；不可用时明确报错。
- 构建用 esbuild 打单文件 ESM；仓库已锁定 esbuild **0.28.2**，`allowBuilds` 已放行。
- 版本从 `0.1.0` 开始；首次发布不建 CHANGELOG。

## 目录结构（新增 `apps/jsdsm`）

```text
apps/jsdsm/
├── package.json          # name=@pxsemic/jsdsm, bin, files(仅 dist), MIT, engines>=18
├── tsconfig.json         # noEmit typecheck；ES2022 + types node
├── .gitignore            # dist/、*.tgz、node_modules/
├── .oxlintrc.json        # 与现有 app 一致
├── .oxfmtrc.json         # 与现有 app 一致
├── LICENSE               # MIT，Copyright (c) 2026 DSM Tool
├── README.md             # 用法、写入前提、风险、Windows 示例
├── scripts/build.mjs     # esbuild 打包 + 复制 writer helper + chmod 755
├── dist/resources/       # 构建时从仓库根 resources/ 复制，不提交
│   └── dsm-file-writer.ps1
└── src/
    ├── bin.ts            # 可执行入口：信号处理、调用 runCli、设置 exitCode
    ├── cli.ts            # runCli(argv, io)：帮助/版本/错误输出/退出码
    ├── args.ts           # parseArgs + resolvePaths
    ├── naming.ts         # candidateName、MAX_NAME_ATTEMPTS
    ├── writer.ts         # PowerShell 解析、spawn、协议解析、超时、取消
    ├── copy.ts           # Node 读流 → meter/hash → PowerShell stdin → 校验 → rename
    ├── errors.ts         # JsdsmError + errno / writer 错误 → 中文消息
    ├── help.ts           # 帮助文本
    ├── version.ts        # 构建时注入版本号，测试环境回退 0.1.0-dev
    └── index.ts          # 仅供根测试导入的 barrel
```

`dist/`（含 `dist/resources/`）为构建产物，不提交。

## 实现要点

### 1. 包配置与构建

`apps/jsdsm/package.json` 关键字段：

```json
{
  "name": "jsdsm",
  "version": "0.1.0",
  "description": "从 DSM 透明加密目录读取文件明文，并通过 PowerShell 保存到本地目录",
  "type": "module",
  "bin": { "jsdsm": "dist/cli.js" },
  "exports": { "./package.json": "./package.json" },
  "files": ["dist", "README.md", "LICENSE"],
  "engines": { "node": ">=18" },
  "license": "MIT",
  "repository": { "type": "git", "url": "git+https://github.com/mackxu/dsm.git", "directory": "apps/jsdsm" },
  "publishConfig": { "access": "public" },
  "scripts": {
    "build": "node scripts/build.mjs",
    "typecheck": "tsc --noEmit",
    "lint": "oxlint && oxfmt --check",
    "lint:fix": "oxlint --fix && oxfmt --write",
    "prepack": "node scripts/build.mjs"
  },
  "devDependencies": {
    "@types/node": "^26.6.6",
    "esbuild": "0.28.2",
    "oxfmt": "^0.41.0",
    "oxlint": "^1.0.0",
    "typescript": "6.0.3"
  }
}
```

`scripts/build.mjs`：

1. 清空 `dist/`；
2. 复制仓库根 `../../resources/dsm-file-writer.ps1` 到
   `apps/jsdsm/dist/resources/`；
3. esbuild：`entryPoints: src/bin.ts`、`bundle`、`platform: 'node'`、`format: 'esm'`、
   `target: 'node18'`、`charset: 'utf8'`、`banner` 注入 shebang
   （源码不写 shebang）、`define` 注入 `globalThis.__JSDSM_VERSION__`；
4. `chmod dist/cli.js 0o755`。

- 无 `dependencies`，dist 只引用 `node:*`；PowerShell helper 作为资源随包发布。
- `files` 包含构建生成的 `dist/resources/`；npm-packlist 在有 `files` 时优先于
  `.gitignore`，因此不提交也能进 tarball。
- `tsconfig.json`：`target ES2022`、`module ESNext`、`moduleResolution Bundler`、
  `strict`、`noEmit`、`types: ["node"]`、`include: ["src/**/*.ts"]`。

### 2. 参数解析（`src/args.ts`）

```text
jsdsm <文件路径> [输出目录]
jsdsm <文件路径> -o <目录> | --out <目录> | --out=<目录>
jsdsm <文件路径> --writer-path <写入组件路径>
jsdsm <文件路径> --timeout <秒>
jsdsm --help|-h | --version|-v
```

- `-h/--help`、`-v/--version` 遇到即返回，优先于其他参数。
- 输出目录只能指定一次：`-o` 重复、`-o` 与第二个位置参数同时出现 → 用法错误。
- `--writer-path` 与 `--timeout` 可重复时后者覆盖或报错（建议报错，保持可预期）。
- 第三个位置参数、未知选项（`-` 单字符除外）→ 用法错误；`--` 之后全部按位置参数。
- **不做 `~` 展开、不自行加/去引号**；路径只做 `path.resolve(cwd, arg)`。
- `--timeout` 默认 600 秒，允许 1–86400；`0` 可表示不超时（可选）。
- 退出码：`0` 成功、`1` 运行失败、`2` 用法错误；帮助/版本写 stdout，错误写 stderr。

### 3. PowerShell 写入器（`src/writer.ts`）

解析顺序（与 `powershell-writer.ts` 对齐）：

1. `--writer-path`；
2. 环境变量 `JSDSM_WRITER_PATH`；
3. 自动探测：
   - Windows：`%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`，
     PATH 中的 `powershell.exe` / `pwsh.exe`；
   - macOS/Linux：PATH 中的 `pwsh`、`/opt/homebrew/bin/pwsh`、`/usr/local/bin/pwsh`。

- 用 `-NoProfile -NonInteractive -Command "$PSVersionTable.PSVersion.ToString()"`
  做 5 秒可用性/版本探测并缓存；显式路径不可执行时报 `WRITER_UNAVAILABLE`，不回退。
- 启动参数固定：`-NoProfile -NonInteractive -ExecutionPolicy Bypass -File <helper>`，
  `spawn` 使用 `shell: false`、`windowsHide: true`、最小环境变量 + 三个
  `COPY_*` 变量。
- helper 路径由 `dist/cli.js` 相对定位：
  `fileURLToPath(new URL('./resources/dsm-file-writer.ps1', import.meta.url))`；
  启动前校验文件存在。
- 返回会话 `{ stdin, completed, abort }`：
  - `completed` 解析 stdout JSON，校验 `bytes` 为非负安全整数、`sha256` 为 64 位 hex，
    返回 `{ bytesWritten, sha256, tempPath }`；
  - 非零退出时解析 stderr 的 `messageBase64`，映射为中文 `WRITE_FAILED`；
  - 超时（默认 600 秒，可由 `--timeout` 覆盖）杀死进程并清理；
  - `stdout/stderr` 各自限制 64 KiB，避免恶意/异常输出撑爆内存。

### 4. 复制流程（`src/copy.ts`）

```text
VALIDATE_SOURCE
  → stat 存在、isFile、可读；记录 before.size/mtimeMs
  → 目录/特殊文件/不存在 → JsdsmError（中文）
PREPARE_OUTPUT
  → mkdir(outputDir, { recursive: true }) → access(W_OK)
OPEN_POWERSHELL
  → 解析 PowerShell；校验 helper 存在
  → 生成 tempName = .jsdsm-<pid>-<uuid>.part
  → writer.open(outputDir, baseName, tempName)   // helper 以 CreateNew 写 .part
PIPE_AND_HASH
  → pipeline(nodeReadStream, meter(字节数+SHA-256), writer.stdin)
  → await Promise.all([pipeDone, writer.completed])
VERIFY
  → Node 计数/哈希 === writer 返回 bytesWritten/sha256 === stat(temp).size
  → 源文件 after.size/mtimeMs 与 before 一致（只做前后自洽比较）
RESERVE_NAME（写入完成后才占位，缩小空文件窗口）
  → 从原文件名起，fs.open(candidate, 'wx') 占位
  → EEXIST/EISDIR 时尝试 `name (1).ext`、`name (2).ext`…最多 10000 次
PUBLISH
  → rename(temp, reservedPath)（覆盖自己刚创建的 0 字节占位）
  → 失败：删除占位 + 临时文件，中文错误
```

创建职责（与现有 local-unlock 一致，已确认）：

- **输出目录**：Node/CLI `fs.mkdir(outputDir, { recursive: true })`。
- **临时 `.part`**：PowerShell helper 用 `FileMode::CreateNew` 创建并写入；
  Node 只写其 stdin。
- **最终文件占位与 rename**：Node 用 `open(candidate, 'wx')` 创建 0 字节占位，
  再用 `fs.rename` 覆盖自己的占位；helper 不创建最终文件。

关键点：

- PowerShell helper 已经负责写 `.part`；最终 rename 由 Node 完成，与现有
  `CopyController` 一致（rename 不影响文件内容，不会重新加密）。
- **不把 `stat.size` 当作明文字节数期望值**：DSM 下明文长度可能与磁盘 stat 不同；
  只做 Node meter、PowerShell 返回、临时文件 size 三方一致，以及源文件前后 stat
  自洽。
- 临时文件由 PowerShell 以 `CreateNew` 创建，Node 不直接写文件内容。
- 目标已存在时用 `O_EXCL` 占位，绝不直接 rename 到已有文件（POSIX rename 会静默
  覆盖）。
- 点文件 `.bashrc` → `.bashrc (1)`；`.env.local` → `.env (1).local`；
  `archive.tar.gz` → `archive.tar (1).gz`。
- 输出不保留源文件 mode/mtime/ACL；空文件允许复制。
- `bin.ts` 注册 `SIGINT`/`SIGTERM`：abort PowerShell 子进程与读流，`finally` 清理
  `.part` 与占位文件；退出码 130/143，第二次信号强制退出。
- 运行过程中向 stderr 输出读取、PowerShell 写入、字节进度与校验提示；stdout 只输出
  最终路径与字节数。

### 5. 错误映射（中文）

- 源：`ENOENT`、`EACCES/EPERM`、`ELOOP`、非普通文件。
- 输出目录：`EACCES/EPERM`、`ENOTDIR`、`EROFS`、`ENOSPC/EDQUOT`。
- PowerShell：`WRITER_UNAVAILABLE`（未安装/路径不可执行/helper 缺失）、
  `WRITE_FAILED`（脚本错误/超时/被占用/写入被拦截）、`WRITE_VERIFY_FAILED`
  （字节数或 SHA-256 不一致）。
- 发布：`NAME_EXHAUSTED`、rename 的 `EBUSY/EPERM/ENOENT/EXDEV`。
- 所有面向用户的文本为中文，保留原始 errno/code 便于排查。

### 6. README 必须显著写明

1. 确认 `npx` 实际使用的 Node（`which node` / `where node`）；nvm/Volta/asdf
   可能切换 Node 路径。
2. 写入组件解析顺序、`--writer-path` / `JSDSM_WRITER_PATH` 用法；
   Windows 自带 `powershell.exe`，macOS 需安装 `pwsh`。
3. **默认写回源目录的风险**：建议显式指定受控范围之外的输出目录。
4. 不覆盖同名文件，自动改名；输出目录自动创建；不支持目录批量与 stdin。
5. 写入流程：明文只经过 Node 管道与 PowerShell stdin，不落临时明文文件；
   失败时清理 `.part`；SIGKILL/断电可能残留 `.jsdsm-*.part`。
6. 退出码、Node >= 18、无运行时第三方依赖、无网络、不读取密钥、不做明文内容校验。
7. Windows 引号/反斜杠/中文路径示例；旧 `cmd.exe` 建议 `chcp 65001`。

## 根仓库集成

1. 根 `package.json`：
   - `check` 追加 `&& pnpm --filter jsdsm typecheck`。
   - 新增 `build:jsdsm`、`pack:jsdsm`、`publish:jsdsm`。
2. `vitest.config.ts`：alias 增加 `jsdsm → ./apps/jsdsm/src/index.ts`。
3. `tests/tsconfig.json`：`paths` 增加 `jsdsm`，`include` 增加
   `../apps/jsdsm/src/**/*.ts`。
4. 根 `README.md`：目录说明增加 `apps/jsdsm`；新增简短用法章节并链接
   `apps/jsdsm/README.md`。
5. `pnpm install` 更新 lockfile importer（不新增依赖版本）。
6. 当前 `feat/local-unlock` 已合并到 `main`；从 `main` 新建 `feat/jsdsm-cli` 分支，
   避免混入当前未提交改动。

## 测试计划（根 `tests/unit/`）

- `jsdsm-args.test.ts`：位置参数、`-o/--out/--out=`、`--writer-path`、
  `--timeout`、冲突、重复、缺值、未知选项、三个位置参数、空值、`--` 语义、
  help/version 优先级、中文/空格路径原样保留。
- `jsdsm-naming.test.ts`：普通/无扩展名/点文件/多扩展名/中文空格改名；attempt=0；
  最大尝试上限。
- `jsdsm-writer.test.ts`：PowerShell 解析优先级（显式/env/自动，注入候选与版本
  探测）；stdout JSON 解析（合法/非法/超大）；stderr `messageBase64` 解码；
  超时与 abort；spawn 失败错误映射。使用注入的 `spawn`，不依赖真实 PowerShell。
- `jsdsm-copy.test.ts`：注入 fake writer session，验证：
  - 内容字节与 SHA-256 从 Node 流正确传给 writer.stdin；
  - 默认源目录生成 `a (1).txt`；显式目录递归创建；`(1)` 已存在时 `(2)`；
  - 已有目标内容不变；成功后 `.part` 与占位文件消失；
  - writer 返回字节/哈希不一致 → `WRITE_VERIFY_FAILED` 且清理；
  - writer 失败/读流失败/预中止 signal → 无残留；
  - 源不存在/是目录/输出路径是文件。
- `jsdsm-cli.test.ts`：`--help` 退出 0；`--version`；未知选项/缺参数退出 2；
  运行期错误退出 1；成功 stdout 含最终路径与字节数；默认输出目录的 stderr 提示。
- 临时目录用 `fs.mkdtemp`；只读目录测试用 `it.skipIf(process.getuid?.() === 0)`，
  清理前恢复权限。测试通过 Vitest alias 直接跑 `src`，不依赖 `dist/` 构建。

## 验证方式

1. `pnpm install` → `pnpm run check` → `pnpm test`。
2. `pnpm run build:jsdsm`；检查 `dist/cli.js` 首行 shebang、可执行位，以及
   `dist/resources/dsm-file-writer.ps1` 已生成。
3. 本地冒烟（无 DSM；用 pwsh/powershell 验证写入链路）：
   ```bash
   tmp=$(mktemp -d); printf 'hello\n' > "$tmp/a.txt"
   node apps/jsdsm/dist/cli.js "$tmp/a.txt" "$tmp/out"
   node apps/jsdsm/dist/cli.js "$tmp/a.txt" "$tmp/out"   # 生成 a (1).txt
   cat "$tmp/out/a.txt" "$tmp/out/a (1).txt"
   node apps/jsdsm/dist/cli.js --help
   ```
4. `cd apps/jsdsm && npm pack --dry-run`：tarball 含 `dist/`（含
   `dist/resources/`）、`README.md`、`LICENSE`、`package.json`；`tar -tzvf` 确认
   `dist/cli.js` 可执行位与 `.ps1` 存在。
5. 以安装形态验证：`npx --yes --package ./jsdsm-0.1.0.tgz jsdsm --help`，或临时前缀
   `npm install --prefix "$tmp" ./jsdsm-0.1.0.tgz` 后运行 `node_modules/.bin/jsdsm`。
6. Node 18 冒烟：`npx --yes --package=node@18 node apps/jsdsm/dist/cli.js --help`。
7. 真实 DSM 验收（必须）：
   - 确认 PowerShell 写入链路在 DSM 环境中可用；
   - 解密已知文件，确认输出为明文；
   - 不传目录再执行一次，观察写回源目录是否被重新加密/拦截；
   - 用一个不可执行的 PowerShell 路径验证错误提示。

## 发布

```bash
npm whoami          # 当前 ENEEDAUTH，需先 npm adduser / npm login
npm view @pxsemic/jsdsm      # 发布前确认包名可用
cd apps/jsdsm && npm publish --access public
npm view @pxsemic/jsdsm version
npx --yes @pxsemic/jsdsm@0.1.0 --help
```

`prepack` 会自动构建；`publishConfig.access` 已设为 public。Git tag 建议
`jsdsm-v0.1.0`。

## 风险

- **运行环境不满足 DSM 读取/写入要求**：可能读到密文或写入被拦截；按用户选择不做
  内容校验，无法自动识别；真实 DSM 验收必须覆盖。
- **默认写回源目录**：可能被 DSM 重新加密/拦截；成功时 stderr 提示，README 警告。
- **PowerShell 依赖**：Windows 自带 5.1 可用；macOS/Linux 需 `pwsh`。脚本使用
  4 参数 `FileStream.Open` 以兼容 Windows PowerShell 5.1。
- **helper 漂移**：`apps/jsdsm/dist/resources/dsm-file-writer.ps1` 由构建从根
  `resources/` 复制；修改写入协议时必须同步更新，计划中已明确单一来源。
- **Windows rename**：依赖 `MoveFileEx(REPLACE_EXISTING)` 覆盖自建占位文件；杀毒/
  占用可能短暂 `EPERM/EBUSY`，映射中文错误并清理；发布前在 Windows 实测一次。
- **SIGKILL/断电**：可能残留 `.jsdsm-*.part` 或极短窗口的 0 字节占位文件。
- **包名抢注**：发布前再次 `npm view @pxsemic/jsdsm` 确认。

## 关键文件

- 新建：`apps/jsdsm/package.json`、
  `apps/jsdsm/src/{bin,cli,args,naming,writer,copy,errors}.ts`、
  `apps/jsdsm/scripts/build.mjs`、`apps/jsdsm/README.md`、`apps/jsdsm/LICENSE`
- 复用/打包：`resources/dsm-file-writer.ps1`（构建时复制到
  `apps/jsdsm/dist/resources/`）
- 修改：根 `package.json`、`vitest.config.ts`、`tests/tsconfig.json`、根 `README.md`
- 新增测试：`tests/unit/jsdsm-{args,naming,writer,copy,cli}.test.ts`
