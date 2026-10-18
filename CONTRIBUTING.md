# 贡献指南

感谢关注 Release Watch。本文说明如何在本地运行、改代码、加迁移，以及提 PR 前需要自己跑的命令。

## 环境

| 依赖 | 版本 |
| --- | --- |
| Node.js | ≥ 22（`package.json` 的 `engines`；CI 用 Node 24） |
| npm | 随 Node 附带，提交 `package-lock.json` |
| Wrangler | 已作为 devDependency 安装，通过 `npm run` 调用即可，无需全局安装 |

首次克隆后：

```bash
git clone https://github.com/Hanserwei/release-watch.git
cd release-watch
npm ci
npm run setup:local
```

`setup:local` 会：

1. 若 `.dev.vars` 不存在，从 `.dev.vars.example` 复制一份（文件权限 `600`），并填入随机的 `ADMIN_TOKEN`；
2. 若 `TELEGRAM_WEBHOOK_SECRET` 为空，生成一个随机值；
3. 补齐后续新增的可选键（`DEEPSEEK_API_KEY`、`TELEGRAM_CHAT_ID`）——旧配置缺键时补空行，不会被当成未定义；
4. 对本地 D1 执行 `wrangler d1 migrations apply DB --local`。

`.dev.vars` 已被 `.gitignore` 忽略（`.dev.vars.*` 也在忽略范围内，仅 `.dev.vars.example` 例外）。**永远不要把真实 Token 写进 `.dev.vars.example`、示例代码、测试夹具或提交说明。**

本地想接真实 GitHub 数据时，编辑 `.dev.vars` 填入 `GITHUB_TOKEN`；公开仓库只需要只读权限。

## 开发循环

```bash
npm run dev
```

该脚本会：

- 若 `dist/index.html` 不存在，先跑一次 `vite build`；
- 启动 `wrangler dev --port 8787 --test-scheduled`（Worker，含 `/cdn-cgi/local/scheduled` 测试入口）；
- 启动 `vite --host 127.0.0.1`（默认 5173，代理 `/api` 与 `/telegram` 到 8787）；
- 每 60 秒（并在启动 3 秒后）请求一次本地定时入口，等价于线上每分钟的 Cron；
- 任一子进程退出即整体退出，`Ctrl+C` 会一并终止两者。

前端改动由 Vite HMR 直接生效；改动 `src/server/**` 时 Wrangler 会重新加载 Worker。改了 `wrangler.jsonc`、迁移或 `src/shared/**` 的类型后，建议重启一次 `npm run dev`。

## 目录结构

```
src/
├── server/          Worker 端
│   ├── index.ts     Hono 应用：鉴权、路由、错误处理、scheduled 入口
│   ├── poller.ts    版本检查（租约认领、分页落库、退避）
│   ├── deliveries.ts 通知投递（发送锁、分段、重试）
│   ├── github.ts    GitHub API 客户端与仓库名校验
│   ├── telegram.ts  Webhook 校验与命令处理
│   ├── telegram-client.ts Bot API 调用与错误分级
│   ├── changelog.ts 可选 DeepSeek 中文摘要
│   ├── subscriptions.ts / queries.ts / public.ts / settings.ts / db.ts / env.ts / security.ts
├── shared/          前后端共享的类型与内置封面映射
└── web/             React 控制台与公开浏览面板
migrations/          D1 迁移（按序号执行）
scripts/             初始化、开发编排、密钥、部署、Webhook 注册
tests/               Vitest 测试（workers 运行时）
```

完整数据流见 [docs/architecture.md](docs/architecture.md)。

## 代码约定

- **TypeScript 严格模式**，无 `any` 逃逸；两套 `tsconfig` 分别覆盖 `src/web` + `src/shared` 与 `src/server` + `src/shared` + `tests`。
- **服务端不用 ORM**：SQL 写在 `D1PreparedStatement` 里，多语句一致性用 `env.DB.batch([...])` 保证；任何跨语句的“先查后写”都要在 SQL 条件里再校验一次（现有代码里的租约守卫和 `ON CONFLICT ... WHERE` 就是范例）。
- **新增对外行为要先想失败路径**：上游超时、租约过期、重复投递、并发写入都要有确定的降级结果，而不是抛到路由层。
- **错误文案**：面向用户的错误用中文短句，由 `AppError` 携带状态码；上游响应体、异常消息和密钥一律不进响应与日志。日志只写 `{ event, name }` 这类结构化字段。
- **前端**：组件内不做 token 持久化（现有实现只用 `sessionStorage` 保存当前标签页的口令），所有请求都走 `src/web/api.ts`，新增接口时同步补 `src/shared/types.ts` 的类型。
- **正则与校验**：仓库名、封面地址、Telegram ID 都有现成的归一化函数（`normalizeRepo`、`normalizeCoverUrl`），新增入口请复用，不要另写一套宽松校验。

## 数据库迁移

- 迁移文件放在 `migrations/`，命名 `NNNN_描述.sql`，序号递增，**已提交的迁移不要再改**。
- 线上由 `wrangler d1 migrations apply` 按文件记录执行状态，一个迁移只跑一次；测试侧 `tests/schema.ts` 会模拟这件事：先执行 `0001`（把 `CREATE TABLE` / `CREATE INDEX` 改写成 `IF NOT EXISTS` 以便重复建库），再按列是否存在决定是否补 `0002`、`0003`。**新增迁移后请同步更新 `tests/schema.ts`**，否则测试库会缺少新列。
- 加列用 `ALTER TABLE ... ADD COLUMN`；SQLite 一条 `ALTER TABLE` 只能加一列，多列请拆成多条语句。
- 加列时给默认值（或允许 `NULL`）并同步处理已有行，避免旧数据读出意外值；新增 `CHECK` 约束要与既有枚举保持一致。
- 本地重放迁移：

  ```bash
  npm run db:local
  ```

  需要从空库重建本地数据时，删除 `.wrangler/state/v3/d1` 后再执行上面的命令（本地数据不是权威副本，可安全重建）。

## 测试

```bash
npm test
```

- Vitest + `@cloudflare/vitest-plugin`，测试跑在真实的 workers 运行时（`cloudflare:workers` 提供的 `env`），D1 是本地 Miniflare 实例。
- `vitest.config.ts` 通过 `miniflare.bindings` 注入测试用凭据（`ADMIN_TOKEN`、`GITHUB_TOKEN`、`TELEGRAM_BOT_TOKEN` 等），**这些是假值，不要换成真实凭据**。
- 每个测试文件用 `tests/schema.ts` 的 `initializeTestSchema` 建表，并在 `beforeEach` 清表；写新用例时沿用这个模式，保证彼此独立。
- 外部 HTTP 调用请用 `vi.spyOn(globalThis, 'fetch')` 或 `vi.stubGlobal('fetch', ...)` 打桩：测试不应依赖 GitHub、Telegram 或 DeepSeek 的真实响应，也不应把任何凭据发到公网。

覆盖面参考：`tests/api.test.ts`（鉴权与公开边界）、`tests/core.test.ts`（检查、订阅、分页与并发）、`tests/notifications.test.ts`（分段投递、摘要回退、重试）、`tests/telegram.test.ts`（Webhook 校验、命令、去重与锁）、`tests/public.test.ts`（公开可见性）、`tests/settings.test.ts`（DeepSeek 密钥）、`tests/covers.test.ts`（封面校验与默认值）。

## 提交前

```bash
npm run check
```

它依次执行 `typecheck`、`test`、`build`，也是 CI（`.github/workflows/ci.yml`，Node 24 + `npm ci`）的唯一校验步骤。

- 只改文档时无需跑测试，但请确认新增的相对链接和引用的文件真实存在（可用 `ls` 或编辑器跳转验证），并保持命令与 `package.json` 的 `scripts` 一致。
- 不要提交 `dist/`、`.wrangler/`、`.dev.vars`；它们都在 `.gitignore` 里，`git add -A` 前请确认 `git status` 干净。
- 与改动相关的测试要同时更新，不要为了通过而放宽断言。

## 提交与 PR

- 提交信息用祈使句、单一主题，例如 `feat: retry failed deliveries on demand`、`docs: document trust boundaries`。
- PR 描述里写清：改了什么、为什么、如何验证（命令与观察结果）、对现有部署的影响（是否需迁移、是否需要补密钥）。
- 涉及安全相关的改动（鉴权、校验、日志、密钥处理）请同时参考 [SECURITY.md](SECURITY.md)；未修复的漏洞请走私密报告渠道，不要开公开 Issue。
