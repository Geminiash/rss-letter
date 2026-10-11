# rss-letter

自托管的「RSS → 每周摘要邮件」服务。把你关注的订阅源聚合成一封按时间排好的周报，
经双重确认的订阅者每周收到一封，随时一键退订。

无框架、零重依赖：Hono + node:sqlite + nodemailer，单进程即可长期运行。

## 特性

- **双重确认订阅**：提交邮箱 → 收确认邮件 → 点击确认链接才入列，杜绝替人订阅
- **一键退订**：每封信页脚带退订链接，点击即退，无需登录
- **每周摘要**：聚合过去 N 天的条目，按链接去重、新到旧排序、截断上限，无新内容不发信
- **双语模板**：zh / en 两套内置模板（确认信 / 欢迎信 / 摘要），按订阅者语言发送
- **模板可覆盖**：在 `templates/` 放同名文件即可覆盖内置模板，支持 frontmatter 主题与 `{{vars}}`
- **隐私克制**：数据库只存邮箱、语言、状态与时间；默认剥离邮件里的脚本标签并转义链接
- **运维友好**：`/api/health` 健康检查、管理令牌手动触发摘要、固定窗口限流、Docker 一键部署

## 快速开始

```bash
pnpm install
cp .env.example .env   # 填 RSS_SOURCES 与 SMTP 准据
pnpm dev               # 开发模式
# 或
pnpm start             # 直接运行
```

访问 `http://localhost:3000`：

| 端点 | 说明 |
|---|---|
| `GET /` | 订阅页（输入邮箱 → 发确认信） |
| `GET /confirm/:token` | 确认订阅 |
| `GET /unsubscribe/:token` | 一键退订 |
| `POST /api/digest/run` | 手动触发摘要（`x-admin-token` 或 `Authorization: Bearer`） |
| `GET /api/subscribers/count` | 订阅统计（同上鉴权） |
| `GET /api/health` | 健康检查 |

## 每周自动发送

摘要由 cron / 定时任务触发：

```bash
# 方式一：直接跑 CLI（读取同一份 .env）
pnpm digest

# 方式二：调管理端点
curl -X POST https://your-host/api/digest/run -H "x-admin-token: $RSS_LETTER_ADMIN_TOKEN"
```

crontab 示例（每周日 08:00）：

```cron
0 8 * * 0 cd /opt/rss-letter && /usr/bin/env pnpm digest >> logs/digest.log 2>&1
```

## Docker 部署

```bash
docker compose up -d
```

`docker-compose.yml` 已带数据卷挂载与环境变量注入；SMTP 未配置时订阅接口返回 503，
摘要无法发送，其余功能不受影响。

## 配置

全部经环境变量（见 `.env.example`），要点：

| 变量 | 说明 |
|---|---|
| `RSS_SOURCES` | 逗号分隔的 RSS/Atom 源列表 |
| `RSS_LETTER_ADMIN_TOKEN` | 管理端点令牌，务必用随机长串 |
| `DIGEST_DAYS` / `DIGEST_MAX_ITEMS` | 摘要时间窗（默认 7 天）/ 单封上限（默认 20 条） |
| `API_URL` | 对外可达基础地址，确认/退订链接用它；未填回退 `SITE_URL` |
| `SMTP_*` / `SENDER_*` | 发信准据；不配置则订阅返回 503 |

## 模板覆盖

内置模板在源码里（`src/mail.ts`），仓库 `templates/` 下附同名默认文件便于起步。
要自定义时把 `TEMPLATES_DIR` 指向你的目录，放同名文件即可覆盖：

```html
<!-- templates/digest.zh.html -->
---
subject: '{{siteName}} 本周精选（{{count}} 篇）'
---
<p>过去一周共有 {{count}} 篇新内容：</p>
<!-- 正文支持全部摘要变量 -->
```

缺 `subject` 时回退内置主题；`templates/` 目录本身未配置时直接用内置模板。

## 本地开发

```bash
pnpm test          # vitest：db / rss / digest / mail / server 共 46 例
pnpm build         # tsc 产出 dist/
```

## 设计说明

- 解析器零依赖：正则提取 RSS 2.0（item/pubDate/description/CDATA）与 Atom（entry/link href/published/summary）
- 转换管线：XML 实体解码 → 剥 HTML 标签 → 残留实体二次解码，标题转义、链接仅 http/https 放行
- 订阅状态机：`pending → confirmed → unsubscribed`；已确认者重复订阅只同步语言不重置状态

## License

[MIT](LICENSE)
