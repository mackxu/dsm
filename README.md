# GitLab file sync

`src/gitlab-sync.ts` uploads a file through the GitLab API, downloads the
branch archive as ZIP, and extracts it into a timestamped directory using
`unzipper`.

## Requirements

- Node.js 20 or later
- pnpm
- A GitLab token with `api`, `read_repository`, and `write_repository` scopes
- Push permission for the configured branch. An empty repository using the
  protected default branch usually requires Maintainer access.

## Install

```bash
pnpm install
```

## Run

```bash
npx tsx src/gitlab-sync.ts
```

Type-check the project:

```bash
pnpm run check
```

## Defaults

- Upload file: `/Users/duoduoxu/Downloads/居住证(卡)确认单.pdf`
- Extraction base: `/Users/duoduoxu/Downloads/gitlab-test`
- GitLab configuration: `./.env`

Each run creates `gitlab-test/<timestamp>/`. The ZIP is kept in the base
directory with the same timestamp, so later runs do not overwrite earlier
results.

Options:

```text
--file <path>
--extract-base <path>
--branch <name>
--project <id>
--env-file <path>
```

For example:

```bash
npx tsx src/gitlab-sync.ts \
  --file /Users/duoduoxu/Downloads/居住证\(卡\)确认单.pdf \
  --extract-base /Users/duoduoxu/Downloads/gitlab-test
```

## Project structure

```text
src/
├── archive.ts       ZIP 安全校验与流式解压
├── config.ts        CLI 参数和 .env 配置
├── gitlab-api.ts    GitLab API 请求、上传和归档下载
└── gitlab-sync.ts   程序入口
```
