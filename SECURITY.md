# 安全策略

## 报告漏洞

请**不要**通过公开 Issue 或 PR 披露未修复的安全问题。

- 首选：[GitHub 私密漏洞报告](https://github.com/Hanserwei/release-watch/security/advisories/new)
- 如果无法使用该入口，请通过仓库所有者公开资料中的联系方式私下联系，并在标题里注明 "security"。

报告中请包含：受影响的提交、复现步骤、实际影响、你已尝试的缓解方式。**不要附带真实凭据、生产数据库内容或他人的聊天记录**；如需证明影响，请用自建实例与你自己的测试数据。

我们会尽力确认并修复，但这是个人维护的项目，不承诺响应时限或修复期限。修复发布前请避免公开细节。

## 支持范围

项目只有 `main` 一个活跃分支，没有发布版本标签，修复只针对最新提交。

## 威胁模型

Release Watch 是单租户工具：一个管理员、一个 Telegram 机器人、一个 D1 数据库，没有多用户账号体系，也不做租户隔离。关注的边界如下。

| 威胁 | 现有措施 |
| --- | --- |
| 未授权调用管理接口 | `ADMIN_TOKEN` 至少 24 位，Bearer 校验使用常量时间比较。口令缺失或过短时**管理接口**返回 503（失败关闭）；`GET /api/health` 与 `GET /api/public/dashboard` 不需口令，不受影响。 |
| 伪造 Telegram 回调 | 校验 `X-Telegram-Bot-Api-Secret-Token` 与 `TELEGRAM_WEBHOOK_SECRET`（常量时间比较）；未配置密钥返回 503，不匹配返回 401。发送者必须等于 `TELEGRAM_ALLOWED_USER_ID`、非机器人、无 `sender_chat`。私聊要求 `chat.id == from.id`；普通群与超级群要求负数会话 ID、命令显式指定机器人，并通过 `getMe` 核对机器人用户名。其他群成员、匿名发送者和频道消息均忽略。 |
| 请求体轰炸 | 管理接口 16 KB 上限；Webhook 以 64 KiB 流式截断，消息文本上限 4096 字符。 |
| 恶意仓库名 / URL 注入 | `normalizeRepo` 只接受 `owner/repo` 或 `github.com` 链接，拒绝端口、凭据、查询串、hash、`..`、百分号与反斜杠。展示链接一律由本地数据重建，不使用 GitHub 返回的 URL。 |
| 上游重定向劫持 | 对 GitHub、Telegram、DeepSeek 的请求均使用 `redirect: 'manual'`，并设超时：GitHub 与 Telegram 10 秒、DeepSeek 8 秒。 |
| 提示注入（Release 正文驱动模型） | 中文摘要的系统提示把正文当作资料处理、忽略其中指令；摘要结果只作为通知文本，不触发工具调用。失败或结构异常时回退原文。 |
| 凭据进入响应或日志 | 接口只返回自有中文文案；日志只记录事件名与错误类型（如 `request_failed`、`scheduled_delivery_failed`、`deepseek_key_invalid` 及来源）。DeepSeek 配置接口只返回 `configured`、`enabled`、`model`、`source`。 |
| 公开面板泄漏私有仓库 | 只展示 `is_public = 1` 且最近 24 小时内复查过可见性的项目；本轮可见性请求失败时项目立即移出公开集合。公开响应不含 `chat_id` 与投递状态。 |
| 重复通知 / 消息乱序 | `deliveries` 上 `UNIQUE(chat_id, release_id)`，`chat_delivery_locks` 让同一聊天的发送串行化，租约超时后可被回收。 |
| Telegram 更新被重放 | `telegram_updates.update_id` 主键去重：已完成返回 200，处理中返回 503 让 Telegram 稍后重投。 |

明确的非目标：

- Cloudflare 平台、账号权限、D1 静态加密与备份。
- Telegram、GitHub、DeepSeek 三个上游的可用性与数据处理策略。
- 匿名访问者本就能看到的**公开**仓库信息——这是功能的预期行为。

## 封面与外部资源

封面地址只做**格式**校验，不做可达性探测：内置 `/covers/<name>.png` 从 Worker 的 `ASSETS` 读取后上传，外部 HTTPS 图片由 **Telegram 服务器**下载、或由**浏览器**直接加载，Worker 不会主动请求这些地址。因此 Worker 端不存在以封面为入口的服务端请求伪造面；但填入的域名会暴露给 Telegram 与访问者，请不要指向内部或敏感地址。

## 密钥存放

| 密钥 | 位置 |
| --- | --- |
| `ADMIN_TOKEN`、`GITHUB_TOKEN`、`TELEGRAM_BOT_TOKEN`、`TELEGRAM_WEBHOOK_SECRET`、`TELEGRAM_ALLOWED_USER_ID`、`TELEGRAM_CHAT_ID`、可选的 `DEEPSEEK_API_KEY` | Worker Secret（`wrangler secret` / `pnpm secrets:upload`），不写入 `wrangler.jsonc`。 |
| DeepSeek 密钥（若在管理界面保存） | **明文存于 D1 的 `settings.deepseek_api_key`**，同样不写入任何响应或日志。 |

**停用摘要不等于删除历史数据**：关闭开关或清除密钥后不会再发起新的摘要请求，但已生成的 `deliveries.notification_text` 仍可能包含此前的摘要文本，随通知发出。需要彻底移除时请手工清理这些行。

## 部署加固清单

1. **口令强度**：`ADMIN_TOKEN` 至少 24 位，建议用密码管理器单独生成。`setup:local` 生成的值可用于本地开发。
2. **最小权限令牌**：`GITHUB_TOKEN` 只授予需要的仓库；公开仓库只读即可，私有仓库仅授该仓库的 `Contents: Read`，并定期轮换。
3. **Webhook 密钥独立**：`TELEGRAM_WEBHOOK_SECRET` 须为 24–256 位 `[A-Za-z0-9_-]`，与 `setWebhook` 的 `secret_token` 完全一致。脚本只校验格式，**不复用 `ADMIN_TOKEN` 需要你自己保证**。
4. **白名单账号**：`TELEGRAM_ALLOWED_USER_ID` 填自己的数字 ID，避免陌生人向机器人发命令。改完 `.dev.vars` 后重新执行 `pnpm secrets:upload` 生效。
5. **不要提交本地配置**：`.dev.vars*` 已在 `.gitignore` 中，`.dev.vars.example` 允许入库但必须保持空值。
6. **摘要密钥的取舍**：不需要中文摘要就不要配置；需要时优先用 Secret（而不是界面保存），避免密钥明文进入数据库。
7. **公开面板**：公开集合由仓库可见性自动决定，**没有单项目隐藏开关**。关闭 `workers_dev` 或使用自定义域本身只是改变入口，**不构成访问控制**；要真正限制访问，请在前置层（如 Cloudflare Access）加认证，或不要订阅不希望公开的仓库。
8. **响应头**：`public/_headers` 设置了 CSP（`img-src 'self' https:` 用于自定义封面，其余指令限制为 `'self'`）、`X-Frame-Options: DENY`、`X-Content-Type-Options: nosniff`、`Referrer-Policy`。新增外部资源时按需放宽对应指令。
9. **管理口令的存放**：前端只放在 `sessionStorage`，关闭标签页即清除；这是**浏览器侧的清理，不是服务端撤销**——口令本身不变，泄露后仍然有效，只能通过更换 `ADMIN_TOKEN` 使其失效。
10. **部署前置检查**：`pnpm run deploy` 会先确认 `database_id` 不是占位值，再应用远端迁移并部署；迁移请先在测试库验证。

## 已知取舍

- 公开可见性依赖 GitHub 的 `private` 字段，并以 24 小时为复查窗口；仓库在此期间转为私有、而尚未复查时，旧记录仍可能短暂可见。
- 通知保留 Release 原文与其中的链接；Telegram 消息默认关闭链接预览，但链接本身可点击。
- 分段投递在"消息已送达但本地写库失败"等情况下仍可能重复发送，见 README 的[已知限制](README.md#已知限制)。
