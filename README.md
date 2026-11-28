# panel

xw7 的面板，部署在 [panel.lucius7.dev](https://panel.lucius7.dev/)：刷题、题解、Mac 此刻的状态、健康和记账放在一处，附带统一的只读接口和给 AI 用的 MCP。文章在[博客](https://blog.lucius7.cn/)。

[面板](https://panel.lucius7.dev/) · [博客](https://blog.lucius7.cn/) · [接口说明](https://panel.lucius7.dev/about/) · [组织](https://github.com/xw7qwq)

## 栏目

| 路径 | 内容 | 谁能看 |
| --- | --- | --- |
| `/` | 首页：刷题、此刻、健康摘要、博客最新文章 | 所有人 |
| `/oj/` | 累计曲线、刷题日历、每日记录、比赛完成情况 | 所有人 |
| `/oj/code/` | 题解搜索和源码阅读 | 所有人 |
| `/now/` | Mac 在不在线、正在听的歌；登录后多出前台应用、电量和负载 | 所有人 |
| `/health/` | 截至昨天的 7 天平均睡眠和步数 | 所有人 |
| `/me/` | 本月收支、健康指标、MCP 连接和授权管理、通行密钥 | 仅自己 |
| `/me/health/` | 健康指标卡、趋势图、最近的睡眠 | 仅自己 |
| `/me/ledger/` | 收支、净资产、支出构成、余额、交易 | 仅自己 |
| `/about/` | 公开范围、数据来源、接口和 MCP 工具列表 | 所有人 |

## 架构

页面是 Astro 生成的静态文件，交互部分是 Svelte 5 组件，样式和图表来自 [ui](https://github.com/xw7qwq/ui)。整个站点是一个 Cloudflare Worker：静态文件由 Workers Static Assets 直接返回，`/api/*`、`/mcp`、OAuth、登录和 `/me/*` 先进 Worker。

数据从哪来：

| 栏目 | 来源 | 进面板的方式 |
| --- | --- | --- |
| 刷题 | [oj](https://github.com/xw7qwq/oj) 每天生成的 `summary.json` 和 `dashboard.json`（GitHub Pages） | Worker 转发，汇总接口只解析 20 KB 的 `summary.json` |
| 题解 | [solutions](https://github.com/xw7qwq/solutions) 的 `site-data.json` 和源码 | 精简成索引后在边缘缓存一小时 |
| 此刻 | [macflare](https://github.com/xw7qwq/macflare) | Service Binding，同账户 Worker 之间直接调用 |
| 健康 | 服务器上的 [health](https://github.com/xw7qwq/health) | 服务器定时推送快照到 `/api/v1/ingest/health`，存在 KV |
| 记账 | 服务器上的 beancount 账本（[ledger](https://github.com/xw7qwq/ledger)） | 服务器定时推送汇总到 `/api/v1/ingest/ledger`，存在 KV |

面板从不直接连自己的服务器；服务器只往外推，推送内容没变时不写 KV。Workers 免费版每次请求只有 10 ms CPU，所以 5 MB 的刷题明细只转发不解析，在浏览器里算。

## 接口

公开接口在 `/api/v1`，只支持 GET，允许跨域读取。成功时返回 `{ data, updated_at, source }`，出错时返回 `{ error: { code, message } }`。完整列表见 [/about/](https://panel.lucius7.dev/about/) 或 `GET /api/v1`。

```sh
curl -s https://panel.lucius7.dev/api/v1/summary
```

`/api/v1/me/*` 需要登录，从不缓存，也不带 CORS 头。

## MCP

地址是 `https://panel.lucius7.dev/mcp`（Streamable HTTP，无状态，只返回 JSON）。在 Claude 等应用里添加自定义连接器，第一次连接会跳到面板登录，确认后授权 30 天。13 个工具全部只读：总览、刷题统计和每日题数、最近通过、题解搜索和源码、Mac 状态、健康指标和序列、收支概况、按月收支、余额、交易。授权可以在 `/me/` 页面撤销。

OAuth 由 [`@cloudflare/workers-oauth-provider`](https://github.com/cloudflare/workers-oauth-provider) 处理，支持动态注册和客户端元数据文档（CIMD），令牌只存哈希。

## 登录

有两种方式，通过后都发同一张 HMAC 签名的 `__Host-` Cookie，30 天有效；换掉 `SESSION_SECRET` 会让所有设备立即退出。登录按 IP 限速，每分钟 5 次。

- **通行密钥（passkey）**：在 `/me/` 添加。之后在登录页点「使用通行密钥登录」，或者在口令框的自动填充里选它，用指纹、面容或设备密码确认。通行密钥绑定 `PASSKEY_RP_ID`（`lucius7.dev`），所以面板以后换到根域名，现在添加的通行密钥照样能用。
- **口令**（`OWNER_PASSPHRASE`）：第一次添加通行密钥要先用它登录，之后留作备用。只想用通行密钥时运行 `npx wrangler secret delete OWNER_PASSPHRASE`；通行密钥全丢了，再用 `npx wrangler secret put OWNER_PASSPHRASE` 设回来。

添加或删除通行密钥要求最近 15 分钟内登录过，否则先到 `/login/?reauth=1` 重新验证一次；口令关闭时，最后一把通行密钥不能删。

服务端只存公钥（`PANEL_KV` 的 `auth:passkeys`），一次性的 challenge 放在签名的短期 Cookie 里，登录页的接口不写 KV。校验按 WebAuthn 规范写在 `worker/webauthn.js`：只认本站 origin 和 `PASSKEY_RP_ID`，要求用户验证，支持 ES256、Ed25519 和 RS256，不验证证明（attestation）。没有用现成的服务端库，因为它连带几百 KB 的 ASN.1/X.509 代码，冷启动就超过免费版每次请求 10 ms 的 CPU 限额；浏览器端用 [`@simplewebauthn/browser`](https://simplewebauthn.dev/)。

## 部署

面板的地址是 `https://panel.lucius7.dev`。它写在两处：`wrangler.jsonc` 的 `SITE_ORIGIN`（Worker 用它签发 OAuth、校验通行密钥，其他域名进来的请求一律跳到这个地址）和 `astro.config.mjs` 的 `site`（页面的 canonical 和接口说明里的地址）。两个 KV 已在 `wrangler.jsonc` 中绑定。登录口令由所有者在 Mac 的仓库目录自行运行 `npx wrangler secret put OWNER_PASSPHRASE` 输入，不进入代码或交接记录。

根域名 `lucius7.dev` 目前跳转到博客，这条跳转规则在 Cloudflare 里。要把面板换到根域名：

1. 在 Cloudflare 删掉根域名到博客的跳转规则。
2. 把 `SITE_ORIGIN` 和 `site` 改为 `https://lucius7.dev`，在 `routes` 里加上 `lucius7.dev`，并把 `assets.run_worker_first` 改为 `true`。`panel.lucius7.dev` 留在 `routes` 里：Worker 会把它的请求跳到新地址，旧链接不会失效。`run_worker_first` 不改的话，旧域名上的静态页面不经过 Worker，页面还留在旧域名，接口请求却被跳到新域名，会被浏览器拦下。
3. 部署，然后把服务器上 health 和 ledger 的推送地址改到新域名（推送是 POST，不能靠跳转）。
4. 把 [ui](https://github.com/xw7qwq/ui) 的 `SITES.panel` 改成新地址并发版。

换地址后 MCP 连接器要重新授权一次。Fava 的 Access 策略不受影响。

第一次部署：

```sh
pnpm install
npx wrangler kv namespace create panel        # 把 id 填进 wrangler.jsonc 的 PANEL_KV
npx wrangler kv namespace create panel-oauth  # 填进 OAUTH_KV
npx wrangler secret put OWNER_PASSPHRASE
npx wrangler secret put SESSION_SECRET
npx wrangler secret put HEALTH_INGEST_TOKEN
npx wrangler secret put LEDGER_INGEST_TOKEN
pnpm run deploy
```

两个推送令牌也要写进服务器上 health 和 ledger 的配置。之后每次改动只需要 `pnpm run deploy`。

## 开发

```sh
pnpm install
pnpm check      # Worker 单元测试 + 构建
pnpm dev        # 只看页面，接口不可用
pnpm preview    # 构建后用 wrangler dev 跑完整的 Worker
```

`pnpm preview` 需要在仓库根目录放一个 `.dev.vars`（已被 git 忽略），写上四个 secret 的本地值。本地试通行密钥时再加上 `SITE_ORIGIN=http://localhost:8787` 和 `PASSKEY_RP_ID=localhost`。

`pnpm preview` 给 `wrangler dev` 加了 `--local-upstream localhost:8787`。不加的话，本地 Worker 看到的请求域名是 `routes` 里的 `panel.lucius7.dev`、协议却是 http，和 `SITE_ORIGIN` 对不上，所有接口都会跳转到自己，页面读不到数据。

## Notion 中转站

[Notion relay 工作流](.github/workflows/notion.yml)每 6 小时把 xw7qwq 组织的每个仓库同步到 Notion「xw7qwq 项目中转站」里的「仓库」数据库，给自己和 AI 读。脚本在 `scripts/notion-sync.mjs`，只用 Node 自带的 `fetch`，不装依赖。

| 设置 | GitHub Actions 里的位置 | 说明 |
| --- | --- | --- |
| `NOTION_TOKEN` | 仓库 secret | Notion 内部集成的密钥，需要读取、更新、插入内容的权限。没有它时工作流什么也不做 |
| `NOTION_DATABASE_ID` | 仓库变量，可不设 | 「仓库」数据库的 ID，默认是现在那一个 |

设置步骤：

1. 在 [notion.so/profile/integrations](https://www.notion.so/profile/integrations) 新建一个内部集成，把密钥存为 `NOTION_TOKEN`。
2. 在 Notion 打开「xw7qwq 项目中转站」页面，**⋯ → 连接**里加上这个集成（子页面和数据库会一起授权）。
3. 在 Actions 里手动运行一次 **Notion relay**。第一次会给每个仓库建文档子页面，几分钟；之后只在仓库有新提交时重建。

同步规则：

- 按「同步 ID」（`owner/repo`）认行。只改写「最近推送」「最近提交」「开放 PR」「同步时间」，仓库归档时把「状态」改成停用；其余列归你。组织里新出现的仓库会自动加一行。
- 行页面正文里，只改写「仓库文档（自动同步）」和「我的笔记」两个标题之间的状态说明，其余正文不动。
- 文档全文放在行页面下标题以「文档 · 」开头的子页面里，默认分支有新提交时整页重建（先建新的再归档旧的）。镜像哪些文件写在 `scripts/notion/sync.mjs` 的 `DOCS` 里，没列出的仓库只镜像 README。
- 私有仓库只同步元数据，从不读文件内容。从不删除行。
- 运行时带上 `force` 会重建全部文档页，带上 `dry_run` 只打印要做的事。

## 目录结构

```text
src/
  pages/        每个栏目一个页面
  components/   栏目视图（Svelte）
  layouts/      页面外壳：顶栏、页脚、主题
  lib/          浏览器端的数据读取和计算
worker/
  index.js      入口：OAuth 和静态文件分流
  app.js        登录、同意页、/me/ 页面和授权管理
  api.js        /api/v1 路由
  mcp.js        MCP 协议处理
  tools.js      MCP 工具
  auth.js       口令登录和会话
  passkey.js    通行密钥的登录和管理接口
  webauthn.js   WebAuthn 校验
  consent.js  ingest.js  sources.js
  health.js  ledger.js  oj.js  http.js
scripts/        Notion 中转站的同步脚本
test/           Worker 和同步脚本的单元测试（node --test）
public/         favicon、robots.txt、安全响应头
```

## 许可证

[MIT](LICENSE)
