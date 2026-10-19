# 架构

Release Watch 是部署在单个 Cloudflare Worker 上的版本雷达：一个 Hono 应用同时承担静态资源分发、管理 API、Telegram Webhook 与 Cron 任务，状态全部存放在一个 D1 数据库里。

![Release Watch 系统架构图](diagrams/system-overview.svg)

> 上图展示浏览器、Telegram、GitHub、DeepSeek、Worker 与 D1 之间的数据流。可交互版本是 `diagrams/system-overview.html`：GitHub 只会显示它的源码预览，请下载后用浏览器打开；`system-overview.png` 供离线查看，`system-overview.json` 是图数据。下文用文字逐条说明，图与代码不一致时以代码为准。

## 从版本发现到图文通知

![版本检查、中文摘要与可恢复图文通知时序图](diagrams/notification-flow.svg)

这张图按五个阶段展开：触发与项目认领、GitHub 条件拉取与原子入队、投递认领与可选摘要、图片与分段进度、失败重试。绿色箭头表示主路径调用，紫色箭头表示恢复分支；基线、租约、长度限制与失败条件写在相应步骤旁。

两张图均由 [Archify](https://github.com/tt-a1i/archify) 生成，并固定引用源码提交 `d4027abf7b955597145fb550c624338784a9c529`。交互版支持节点定位、源码跳转、主题切换和连线动效，可下载 [系统总览 HTML](diagrams/system-overview.html) 与 [通知时序 HTML](diagrams/notification-flow.html) 后本地打开。PNG 适合离线阅读，JSON 用于后续重新生成。

## 组成

| 位置 | 职责 |
| --- | --- |
| `src/web/` | React 19 + Vite 单页应用。公开浏览面板与需要口令的管理控制台在同一份产物里，构建后输出到 `dist/`。 |
| `src/server/index.ts` | Worker 入口：`fetch` 处理 HTTP，`scheduled` 处理每分钟一次的 Cron。挂载 `/api/*` 鉴权、请求体上限与错误处理。 |
| `src/server/poller.ts` | 版本检查：租约认领项目、拉取 GitHub Release 分页、写入 releases 与待投递记录。 |
| `src/server/deliveries.ts` | 通知投递：认领待发送记录、组装文本、发封面与分段消息、记录进度与重试。 |
| `src/server/telegram.ts` / `telegram-client.ts` | Webhook 校验与命令处理；Bot API 调用、错误分级（可重试 / 永久失败）。 |
| `src/server/changelog.ts` | 可选的中文摘要，失败时静默回退原文。 |
| `src/server/subscriptions.ts` / `queries.ts` / `public.ts` | 订阅增删改查、控制台数据、公开只读面板。 |
| `src/server/settings.ts` | DeepSeek 密钥与启用状态。读取顺序为 `settings` 表 > 环境变量；在管理界面保存的密钥以**明文**存于 D1，接口与日志只回显布尔与来源。 |
| `src/shared/` | 前后端共享类型与内置封面映射。 |
| `migrations/` | D1 迁移，`wrangler d1 migrations apply` 按序号执行。 |
| `scripts/` | 本地初始化、开发编排、密钥上传、部署、Webhook 注册。 |

`wrangler.jsonc` 把 `dist/` 绑定为 `ASSETS`，`/api/*` 与 `/telegram/webhook` 先进入 Worker（`run_worker_first`），其余路径交给静态资源；未命中的路径按 SPA 回退到 `index.html`。Cron 表达式为每分钟一次，`vars` 里只有 `POLL_BATCH_SIZE`、`DELIVERY_BATCH_SIZE` 两个数量上限；密钥默认走 `wrangler secret`，唯一例外是可在管理界面保存的 DeepSeek 密钥（明文落在 D1，见下文）。

## 信任边界

系统有六条跨越信任边界的数据流，每条都按“不可信输入”处理：

| # | 边界 | 守卫 |
| --- | --- | --- |
| 1 | 匿名浏览器 → 公开面板 `GET /api/public/dashboard` | 无鉴权，只输出 `projects.is_public = 1` 且 `visibility_checked_at` 落在“最近 24 小时以内、且不晚于当前时间”的记录。私有仓库、或最近 24 小时内未能再次确认可见性的项目自动退出公开集合（若本轮可见性请求失败，项目会被立刻置为不公开）。响应不包含 `chat_id` 与投递状态，错误只以“检查暂时异常，请稍后查看”这类固定文案出现。 |
| 2 | 管理员浏览器 → `/api/*` | `Authorization: Bearer <ADMIN_TOKEN>`，比较使用常量时间实现。`ADMIN_TOKEN` 缺失或短于 24 位时整个 `/api/*` 返回 503（失败关闭），只有 `GET /api/health` 与 `GET /api/public/dashboard` 例外。所有响应带 `Cache-Control: no-store`、`nosniff`、`no-referrer`，请求体上限 16 KB。 |
| 3 | Telegram → `/telegram/webhook` | 只接受 `POST`；`X-Telegram-Bot-Api-Secret-Token` 与 `TELEGRAM_WEBHOOK_SECRET` 常量时间比对，未配置密钥返回 503，不匹配返回 401。`TELEGRAM_ALLOWED_USER_ID` 必须是正整数，否则 503。更新体上限 64 KiB 并流式计数，`update_id` 必须是安全整数。消息必须来自该白名单用户本人、`chat.type === 'private'`、`chat.id === from.id`、无 `sender_chat`、非机器人、文本长度 ≤ 4096。任何不满足条件的更新返回 200 但无副作用。 |
| 4 | Worker → GitHub API | 固定请求 `https://api.github.com`，`redirect: 'manual'`，超时 10 秒，`User-Agent` 固定。仓库名先经 `normalizeRepo` 归一化（只允许 `owner/repo` 或 `github.com` 链接，拒绝端口、凭据、查询串、`..`、百分号与反斜杠）。**从不使用 API 返回的链接**：展示地址一律重建为 `https://github.com/{repo}/releases/tag/{tag}`。未配置 `GITHUB_TOKEN` 时直接报错，不带凭据请求。 |
| 5 | Worker → Telegram Bot API | 同样 `redirect: 'manual'` + 10 秒超时；机器人 Token 只出现在请求 URL 中，不写日志。内置封面（`/covers/*.png`）从 `ASSETS` 读出后以 multipart 上传，避免 Telegram 访问不到本地或内网地址；外部封面只做**格式**校验，URL 原样交给 Telegram 由它下载（Worker 不请求该地址）；图片不可用时降级为纯文本。 |
| 6 | Worker → DeepSeek（可选） | 仅当密钥已配置且启用时才外发内容，超时 8 秒；系统提示明确把 Release 正文当作待处理资料，忽略其中的指令，降低提示注入风险。 |

补充约束：

- **封面地址**：只接受内置 `/covers/<name>.png` 或规范 HTTPS URL；拒绝空白与控制字符、内嵌凭据、端口、片段、`localhost` 与无点主机名，长度上限 500。
- **Cron 入口**不对外暴露，只由平台触发；它与 Webhook、管理接口共用同一套租约，因此三者可以并发运行而不重复发送。
- **错误文本**：只回显自有文案。上游响应体、异常消息与密钥不会进入响应或日志，日志仅记录事件名与错误类型（例如 `request_failed`、`scheduled_delivery_failed`）。

## 数据库表

迁移 `0001_initial.sql` 建表，`0002_public_visibility.sql` 加公开可见性字段，`0003_cover_and_settings.sql` 加封面、摘要缓存与分段通知字段。

| 表 | 作用 | 关键约束 |
| --- | --- | --- |
| `settings` | 键值设置：`default_chat_id`、`last_cron_at`、`last_delivery_at`、`deepseek_api_key`、`deepseek_enabled` | `key` 主键；`deepseek_api_key` 为界面保存的明文密钥，需按敏感数据对待 |
| `projects` | 被订阅的仓库及其检查状态 | `repo` 唯一（`NOCASE`）；`initialized` 表示基线已建立；`scan_page` 是旧页扫描游标；`sweep_generation` 记录完成整轮旧页扫描的次数（目前只累加、不参与判定）；`etag` 用于条件请求；`last_checked_at`、`last_success_at`、`next_check_at`、`error`、`error_count`；租约列 `lease_token` / `lease_until`；迁移新增 `is_public`、`visibility_checked_at`、`cover_url` |
| `subscriptions` | 一个项目在某个聊天里的订阅 | 唯一索引 `(project_id, COALESCE(chat_id, ''))`；`interval_minutes` 限定 15/30/60/360；`paused`；`notify_after` 记录开始接收通知的时间点；`promotion_generation` 预留列 |
| `releases` | 已发现的版本 | 主键为 GitHub Release ID；`notify_at` 为可通知时间，预发布转正式时会被刷新；`first_seen_token` 用于统计本轮新增；`changelog_zh` 缓存摘要，正文或标签变化时清空 |
| `subscription_release_skips` | 暂停期间升级为正式版的版本 | 复合主键 `(subscription_id, release_id)`，让恢复订阅后不补发暂停期间的变化 |
| `deliveries` | 待发/已发通知（出站队列） | `UNIQUE(chat_id, release_id)`；`status` ∈ `pending`/`sending`/`sent`/`failed`；`attempts`、`next_attempt_at`、租约列；新增 `notification_text`、`photo_message_id`、`text_offset` |
| `chat_delivery_locks` | 每个聊天一个发送锁 | `chat_id` 主键；`next_send_at` 控制最小发送间隔（1 秒），避免 Webhook 回复与版本通知撞车 |
| `telegram_updates` | Webhook 更新去重 | `update_id` 主键；`status` ∈ `processing`/`completed`；租约 120 秒，过期后可被重投的同一更新重新认领 |

`projects_due`、`subscriptions_project`、`releases_project`、`deliveries_due` 四个索引支撑“到期项目”“某聊天的订阅”“版本倒序”“到期投递”这几条热查询。

## 版本检查流程

`cron: "* * * * *"` 触发 `scheduled`，先写 `settings.last_cron_at`，再依次执行 `runChecks` 与 `deliverPending`；两者分别包裹 `try/catch`，因此检查失败不会拖垮投递，反之亦然。

1. **挑项目**：`next_check_at <= now AND lease_until <= now`，并且至少有一个未暂停订阅；按到期时间排序，取 `POLL_BATCH_SIZE` 条（未设置时为 3，取值被夹在 1–3），最多两个并发协程消费。
2. **认领**：`UPDATE projects SET lease_token=?, lease_until=now+90s ... RETURNING ...`，条件不满足则本次跳过该项目的检查（说明另一个执行者持有租约）。之后的每条写库语句都以 `lease_token` + `lease_until` 作为条件（`savePage` 里用 `EXISTS(... lease_token=? AND lease_until>?)`），租约过期就放弃写入。
3. **可见性**：请求 `/repos/{repo}` 读取 `private` 字段，写回 `is_public` 与 `visibility_checked_at`。这一步失败则本轮不改变公开状态，并在收尾时把 `is_public` 置 0。
4. **拉第一页**：`/repos/{repo}/releases?per_page=15&page=1`，带 `If-None-Match`。`304` 表示无变化，同时确认了已持久化的基线。
5. **落库**：每页固定 4 条 SQL 组成一个 `batch`（3 条写数据 + 1 条推进游标），语句数不随版本条数和订阅数量增长——为“暂停期间由预发布转为正式版”的记录写 skip 行；`INSERT ... ON CONFLICT(id) DO UPDATE` 写 releases（正文与标签未变时保留摘要缓存，预发布转正式时刷新 `notify_at`）；按订阅为符合条件的新版本插入 `deliveries`（`notify_at >= notify_after`、预发布偏好匹配、未 skip）；更新项目分页游标与 sweep 标记。只有 `first_seen_token` 与本页令牌相同的新行计入“本轮新增”。
6. **翻旧页**：第 1 页还有下一页，或第 1 页返回 304 时，继续抓 `scan_page`（初始为 2，逐页推进，最后一页后回到 2）。旧页游标每次前进一页、到末页后回到 2，因此深度较远的"预发布转正式"会在后续几轮扫描中被发现（只盯第 1 页则会漏掉），代价是延迟而非立即感知。
7. **收尾**：成功则 `last_success_at=now`、清空 `error`、`error_count`，`next_check_at = now + MIN(未暂停订阅的 interval)`，释放租约。失败则写入用户可见的简短错误、`error_count + 1`，`next_check_at = now + retryDelay(error_count + 1)`（`60s × 2^(n-1)`，上限 24 小时），若本轮没拿到可见性结果则把项目移出公开集合。

首次订阅不会补发历史：`subscriptions.notify_after` 取创建时间，第 1 页只建立基线；第 1 页成功写入（含 304 确认基线、空仓库无版本）后标记 `initialized=1`。暂停再恢复时 `notify_after` 重置为恢复时间，暂停期间升级为正式版的版本通过 `subscription_release_skips` 排除。

## 通知投递与恢复

投递是**出站队列 + 租约**模型，任何一步中断都能从库里接着做：

1. **清理**：删除所有 `status != 'sent'` 且已不再符合条件的记录（订阅被删除、暂停、预发布偏好改变、处于 `notify_after` 之前或被 skip）。
2. **回收僵死任务**：`status='sending'` 且租约过期、`attempts >= 8` 的记录标记为 `failed`。
3. **取候选**：`pending` 且 `next_attempt_at <= now`，或 `sending` 且租约已过期；同时要求该聊天没有生效中的发送锁；每次最多 `DELIVERY_BATCH_SIZE` 条（该值被夹在 1–1，即每次调用只处理一条）。
4. **认领**：先 `INSERT ... ON CONFLICT DO UPDATE chat_delivery_locks`（`next_send_at=now+1s`、租约 60 秒），再条件更新 `deliveries` 到 `sending`、`attempts+1`，并 `RETURNING` 认领行。两条语句在同一 batch 内、且第二条要求锁令牌匹配，所以两个执行者不会同时拿到同一条通知。
5. **组装文本**：`notification_text` 为空时才生成（正文可能很长，也避免重复调用摘要接口）。随后**重新校验订阅资格**并写入 `notification_text`；如果摘要调用期间订阅被暂停或删除，这次投递直接丢弃，不会发出外部请求。
6. **发送**：有封面且尚未发过图片时先发图片（caption 截断到 1024 字符，按 UTF-16 代理对边界回退），失败若属于 `TelegramPhotoError`（图片不可用）则降级为文字；否则发文字，单条截断到 4000 字符。
7. **记账**：`message_id`、`photo_message_id`、`text_offset` 与 `status` 一并写回；未发完时状态回到 `pending` 且 `next_attempt_at = now + 1s`，下一次 Cron 从已持久化的 `text_offset` 继续，因此**已成功落库的段落和封面不会被重发**。若 Telegram 已收下消息但本地写库失败或请求超时，这一段会在下次重发——这是去重的边界。`attempts` 在成功一段后归零；完成时写 `sent`、`sent_at`，并把 `last_delivery_at` 记入 settings。每次调用只处理一个聊天的一条投递，借此降低并发与限速风险。
8. **失败**：`retryDelay(attempts)` 与 `Retry-After` 取较大值作为下次时间；凭据无效（401）、目标不可用（403、文字消息的 400）这类永久错误或 `attempts >= 8` 直接置 `failed`；封面图返回 400 只按“图片不可用”降级，不计为失败。管理界面的“重试”按钮调用 `POST /api/deliveries/retry`，把 `failed` 全部重置为 `pending`、`attempts=0`。

`chat_delivery_locks` 是跨来源的发送闸门：Cron 投递与 Telegram Webhook 的命令回复共享同一把锁并保持 1 秒最小间隔，Webhook 侧拿到锁冲突时返回 503 让 Telegram 稍后重投。**同一时刻**不会向同一聊天并发发送，但多段通知按批推进，期间可能插入其他版本的通知或命令回复，不保证"一个版本的所有分段连续到达"。

## Telegram Webhook

1. 校验方法与密钥（见信任边界 3），读取并解析更新，仅接受白名单用户的文本。私聊须匹配发送者 ID；群组和超级群只接受显式指定机器人的命令，并用 `getMe` 校验目标用户名；忽略普通群聊、其他成员、匿名管理员和频道消息。
2. 认领 `telegram_updates`：仅在记录不存在，或处于 `processing` 且租约过期时可写入，租约 120 秒。已 `completed` 的重复投递直接返回 200，正在处理中的返回 503 并提示稍后重试。
3. 执行命令（`/start`、`/sub`、`/unsub`、`/list`、`/status`、`/news`、`/help`）。命令直接调用 `subscriptions.ts`、`queries.ts`、`news.ts` 等模块读写 D1，**不经过自己的 HTTP API**，因此与网页端共享同一套约束而无需二次鉴权；随后续租更新租约、抢一次聊天发送锁，再回复。
4. 命令返回“需要重试”语义时（GitHub 限流、上游 5xx 等），回 503 并把租约截止时间设到 `Retry-After`，Telegram 重投后即可续上；`finally` 里无论成功失败都会释放聊天锁，并把更新租约置为可重试时间，异常退出也不会永久卡住。

`/start` 调用 `bindDefaultChat`：把 `settings.default_chat_id` 写入该聊天，把 `chat_id IS NULL` 的订阅接管过来（同一项目的重复空订阅被删除），并为"创建后、绑定时"之间已发现、且满足 `notify_at >= notify_after` 的版本补建投递。更早的历史版本不会补发。

群内绑定同时保存 `release_group_chat_id` 与 `release_group_notify_after`。投递前从所有活跃订阅中筛选满足原有预发布、恢复基线与跳过规则的新版本，为群组额外建一份持久化投递；`UNIQUE(chat_id, release_id)` 保证多个来源订阅不会在同一群重复。原目标投递不变，群组副本使用同一套租约、分段进度和失败重试。绑定时刻之前的更新不补发，重复绑定不移动基线，私聊重新绑定不清除群组同步设置。

## 可选摘要的失败路径

中文摘要是**纯增益**路径，任何环节失败都只是少了摘要：

- 未启用、未配置密钥、密钥格式非法（长度不在 20–200 或含非可见 ASCII）→ 直接使用原文。非法密钥只在日志记录 `deepseek_key_invalid` 与来源，不记录内容。
- Release 正文为空、`changelog_zh` 已有缓存 → 不发请求 / 直接用缓存。
- 网络错误、8 秒超时、HTTP 非 2xx、响应结构异常、`finish_reason` 不是 `stop`、内容为空或超过 6000 字符 → 一律返回原文。
- 成功时把 `中文更新摘要（DeepSeek）` 前缀的结果写入 `releases.changelog_zh`，但更新条件是 `id`、`body`、`tag` 三者同时匹配；请求期间 GitHub 改动了正文，摘要就不会落库，避免缓存错配。
- 密钥解析顺序为 `settings` 表 > 环境变量 `DEEPSEEK_API_KEY`，仅当确实存在可用密钥时才允许启用；`apiKey: ""` 表示删除库中密钥并回退到环境变量。接口只返回 `configured`、`enabled`、`model`、`source` 四个字段。
- **停用不等于抹除历史**：关闭开关或清除密钥后不再发起新请求，但此前写入 `deliveries.notification_text` 的摘要文本仍会随该条通知发出；需要彻底清理请手工删除这些行。

## 关键不变量

- 只有持有有效租约的执行者才能写入该项目的 releases、deliveries 与游标。
- 一个 `(chat_id, release_id)` 最多一条投递记录；`sent` 之后不会再发。
- 公开面板只反映**最近一次确认过的**可见性，且超过 24 小时未复查的项目自动下线。
- **GitHub 相关的展示链接**（仓库、Release 页面）由本地数据重建，不使用 API 返回的 URL；封面是唯一的例外——自定义封面地址会原样交给 Telegram 与浏览器加载。
- 摘要失败、封面图不可用（`sendPhoto` 返回 400 或读取内置资源失败）都只降级：拿不到摘要就发原文，发不出图片就发文字。Telegram 的其他错误（限流、5xx、网络）仍按退避重试，不会静默丢弃。
