# 生产域名冻结（RC-8）+ 后台主机隔离（RC-9）

**生产域名 = `https://pulsenovels.com`。冻结日期 2026-09-03，Owner 已购买并裁定为
cps-novel 唯一生产主域名。** 与 CPS 短剧站域名无关联、无共享 DNS/证书。

**后台主机隔离（RC-9，同日冻结）：生产后台 origin = `https://zbcwf.pulsenovels.com`**
（`zbcwf` 前缀沿用 CPS 既有后台子域约定）。Owner 同时指出 CPS 短剧站的已知缺陷——
其公开域名 `https://enpulsedrama.com/login` 也能打开后台登录页，后台路径没有按主机
收口。海阅要求：后台路径只在后台主机可达，公开主机上后台路径一律 404，后台主机不
服务公开页面；且两主机一旦被误配成相同值，后台路径必须恒 404（fail-closed），不得
重现该缺陷。实现落在应用层 `src/proxy.ts`（`isAdminPath` 单一来源见
`src/lib/site/admin-origin.ts`，从 `ADMIN_PAGE_ROOTS` 派生）与 X8 本地 nginx 的
第二道防线（`infra/production-like/nginx/full.conf.template` 的双 `server_name` 块）。

## 单一输入源

env 变量：`SITE_URL`（唯一）。解析函数：`getSiteUrl()`（`src/lib/seo/site-url.ts`，签名
`getSiteUrl(env = { SITE_URL: process.env.SITE_URL })`）。fail-fast：缺失、非 `http(s)`、带凭证或
path/query/fragment 一律抛 `SiteUrlConfigurationError`，**无默认值**，不得新增第二输入源
（如 `NEXT_PUBLIC_SITE_URL`），见 `tests/backend/seo/site-url-single-source.test.ts` 既有守卫。
生产部署设 `SITE_URL=https://pulsenovels.com`（`.env.example` 已加注释，值仍留空，遵循 fail-fast）。

## 消费方（均经 `getSiteUrl()` / `toAbsoluteUrl()`，无旁路）

`src/app/robots.ts`（sitemap 绝对地址）、`src/lib/seo/sitemap.ts`（`<loc>`）、`src/lib/seo/seo-utils.ts`
与 `seo-templates/_shared.ts`（canonical/breadcrumb 等 SEO 元数据 origin）、`src/lib/seo/novel-hreflang.ts`
（hreflang 兄弟链接绝对化）、`src/lib/indexnow/eligibility.ts`（`normalizeCanonicalUrl` 的提交 URL）、
`src/server/site-settings/service.ts`（校验 `indexNowHost` 必须等于 `SITE_URL` host，推导
`indexNowKeyLocation` 期望值）、`src/app/(admin)/settings/page.tsx` + `site-settings-client.tsx`（后台比对值）。

## X8 本地 UAT 边界（RC-9 起随后台主机隔离同步变化）

X8 固定使用 `https://novel.test`，由 `scripts/lib/x8-production-like-env.sh` 的
`X8_LOCAL_DOMAIN=novel.test` 导出；nginx 模板 `__X8_DOMAIN__` 占位符由
`scripts/x8-production-like.sh` `sed` 替换，与根 `.env.example`/本文档定义的生产域名
无关。**RC-9 起**：`ADMIN_CANONICAL_ORIGIN` 不再等于 `SITE_URL`——同一文件新增
`X8_ADMIN_DOMAIN=zbcwf.novel.test`（`__X8_ADMIN_DOMAIN__` 占位符），
`ADMIN_CANONICAL_ORIGIN=https://zbcwf.novel.test`，`SITE_URL` 仍恒为
`https://novel.test`；这是每个 `X8_LEVEL`（`0`/`uat`/`r`）都成立的安全不变量，不是
分级开关。`scripts/x8-production-like.sh` 的 `validate_rendered_topology()` 新增一条
硬门禁：`X8_ADMIN_DOMAIN` 一旦等于 `X8_LOCAL_DOMAIN` 立即 fail-fast 退出（不允许两台
X8 主机被误配成同一个域名）。

## 留给 Codex 的部署项

- DNS：`pulsenovels.com` A/AAAA 指向生产 VPS；**新增** `zbcwf.pulsenovels.com` A/AAAA
  同样指向生产 VPS（RC-9 后台主机隔离，同一台机器，不同 `server_name`）。
- TLS：生产证书签发（非 X8 mkcert 自签），证书需覆盖两个 SAN：`pulsenovels.com` 与
  `zbcwf.pulsenovels.com`（可一张证书两个 SAN，也可两张独立证书——两个生产 nginx
  `server` 块各自 `ssl_certificate` 指向即可，X8 本地用前者，见
  `ensure_local_certificate()`）。
- 生产 env：`SITE_URL=https://pulsenovels.com`、
  `ADMIN_CANONICAL_ORIGIN=https://zbcwf.pulsenovels.com`（**RC-9 冻结：必须是与
  `SITE_URL` 不同主机的专用 admin 子域，不再是"或同域"的开放项**——两者主机名相同时
  `src/proxy.ts` 在生产环境下对所有后台路径恒 404，参见 `.env.example` 里
  `ADMIN_CANONICAL_ORIGIN` 的行内文档）。
- 生产 nginx：**两个** `server` 块——`server_name pulsenovels.com;`（公开，默认代理，
  对后台路径列表 `return 404;`，第二道防线）与 `server_name
  zbcwf.pulsenovels.com;`（后台，默认 `return 404;`，只放行后台路径列表 + `/api/health`）。
  本轮未新建生产 nginx 配置文件，不复用 X8 `__X8_DOMAIN__`/`__X8_ADMIN_DOMAIN__` 机制，
  但 X8 的 `infra/production-like/nginx/full.conf.template` 双 `server_name` 块结构
  可直接参照改写为生产配置。
- `/indexnow-key.txt` 落地 key 文件，经后台 `site-settings` 写入并核对 host。
- UptimeRobot 三条 Keyword 监控：`https://pulsenovels.com/api/health{,/backup,/worker}`
  （见 `ALERTS_RUNBOOK_2026-09-03.md` §1.2）。
- `/backups` 挂载：web 要与 backup 容器指向同一目录，否则 `/api/health/backup` 恒 `unconfigured`。
