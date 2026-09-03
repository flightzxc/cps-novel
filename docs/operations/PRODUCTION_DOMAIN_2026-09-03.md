# 生产域名冻结（RC-8）

**生产域名 = `https://pulsenovels.com`。冻结日期 2026-09-03，Owner 已购买并裁定为
cps-novel 唯一生产主域名。** 与 CPS 短剧站域名无关联、无共享 DNS/证书。

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

## X8 本地 UAT 边界（不受本次影响）

X8 固定使用 `https://novel.test`，由 `scripts/lib/x8-production-like-env.sh` 的
`X8_LOCAL_DOMAIN=novel.test` 导出；nginx 模板 `__X8_DOMAIN__` 占位符由
`scripts/x8-production-like.sh` `sed` 替换，与根 `.env.example`/本文档定义的生产域名
无关。`X8_LEVEL=uat` 与 `X8_LEVEL=r` 下 `SITE_URL`/`ADMIN_CANONICAL_ORIGIN` 恒为 `https://novel.test`。

## 留给 Codex 的部署项

- DNS：`pulsenovels.com` A/AAAA 指向生产 VPS。
- TLS：生产证书签发（非 X8 mkcert 自签）。
- 生产 env：`SITE_URL=https://pulsenovels.com`、
  `ADMIN_CANONICAL_ORIGIN=https://pulsenovels.com`（或专用 admin 子域，Owner 未另裁则同域）。
- 生产 nginx `server_name pulsenovels.com;`（本轮未新建生产 nginx 配置文件，不复用 X8
  `__X8_DOMAIN__` 机制）。
- `/indexnow-key.txt` 落地 key 文件，经后台 `site-settings` 写入并核对 host。
- UptimeRobot 三条 Keyword 监控：`https://pulsenovels.com/api/health{,/backup,/worker}`
  （见 `ALERTS_RUNBOOK_2026-09-03.md` §1.2）。
- `/backups` 挂载：web 要与 backup 容器指向同一目录，否则 `/api/health/backup` 恒 `unconfigured`。
