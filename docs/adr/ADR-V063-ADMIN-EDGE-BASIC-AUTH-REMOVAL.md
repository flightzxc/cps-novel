# ADR：v0.6.3 后台子域名去掉 nginx Basic Auth（健康检查接口保留）

- 状态：Owner 已拍板，代码已在功能分支准备；生产安装随 v0.6.3 发版执行（见[上线运维手册](../operations/ADMIN_EDGE_GATE_REMOVAL_RUNBOOK_2026-10-18.md)）。
- 决策来源：Owner 于 2026-10-18 在 v0.6.3 开发会话里明确拍板。
- 适用范围：后台子域名 `zbcwf.pulsenovels.com` 的 nginx 配置（模板 `infra/preproduction/nginx/cps-novel-public.conf.template` 的后台 server 块），以及守着它的安装前检查、docker 矩阵和发版核验。公开站不在范围内。

## 背景

预生产阶段，两个域名的所有页面前面都有一层 nginx Basic Auth（共享账号密码）。2026-10-07 切换正式站时，公开站撤掉了这层，后台子域名保守地留着。运营反馈：每次进后台都要先输一组共享账号密码，换个浏览器就被卡住。

后台自己的登录这一关已经有四道防护：Cloudflare Turnstile 人机验证、nginx 登录页每个 IP 每秒 2 次的限速、应用层同用户名或同 IP 失败 5 次锁 15 分钟、强制两步验证。Owner 认为这一关就够了。

## 决定

1. 后台的登录页（`= /login`）、后台页面（dashboard、novels……two-factor 那条正则）、后台接口（`^~ /api/admin/` 与 `= /api/admin`）、静态资源（`^~ /_next/static/`）**不再挂 nginx Basic Auth**。
2. 三个健康检查接口 `/api/health`、`/api/health/worker`、`/api/health/backup`（即 `= /api/health` 与 `~ ^/api/health/(?:worker|backup)$` 两个 location）**保留 Basic Auth**。它们不给人用，外部监控（UptimeRobot）本来就带口令访问；去掉口令只会让任何人都能看到 worker 和备份状态，不会给运营省事。
3. 其余一律不动：各 location 的限速、`cps-novel-edge-admin-security.conf`（noindex 等安全头，后台照样不让搜索引擎收录）、维护页、ACME、兜底 `location / { return 404; }`、证书、公开站全部路径。口令文件 `nginx-preprod.htpasswd` 与发版核验用的 `preprod-curl.conf` 继续保留，健康检查和监控还在用。
4. 守卫换成新口径，不是放宽：
   - 安装前的候选检查（`verify-nginx-candidate.mjs`）原来只要求后台块里"出现过" Administration 口令域。现在改为**按请求路径逐条核对**：按 nginx 自己的选路规则找出每个路径真正落到的 location，三个健康检查路径必须带口令域和口令文件（检查码 `admin_health_auth`），登录页、后台页面、后台接口、静态资源必须直达应用且不带任何 `auth_basic`，server 级也不能有（检查码 `admin_console_open`）。原有的"后台块里不得出现 `auth_basic off;`"保留。
   - docker 矩阵、发版核验（`verify-release.sh`）同步改为新口径：public 模式下后台登录页匿名 200；后台健康检查接口仍是 401、带口令 200。
   - 两个方向都钉死：健康检查丢了口令要变红，后台页面又加回口令也要变红（不符合 Owner 决定的配置不许装上去）。

## 为什么按路径核对，而不是只看那几个 location 块

只看块内容，挡不住"新加一个 location 抢走了路径"这种改法。例如在后台块里加一个不带口令的 `location ^~ /api/` ：nginx 遇到 `^~` 前缀命中就不再看正则，`/api/health/worker` 会落进这个新块，健康检查实际上没了口令，而原来那个带口令的正则块一个字没变。按路径选路就能抓住它（这一条有专门的用例和变异）。

## 后果与约束

- **先装 nginx，再发应用。** v0.6.3 的 `verify-release.sh` 在关维护后按新口径期望后台登录页匿名 200。如果先跑 `release.sh deploy`、后装 nginx，这一步会看到旧门禁的 401，把站点重新关进维护并报 `anonymous_status`。所以生产上必须先用 v0.6.3 的 release 目录跑安装器，再发应用。
- **回滚成对。** 应用回滚到 v0.6.2 之前要先把 nginx 恢复到装前备份：v0.6.2 的 `verify-release.sh` 期望后台登录页 401。只回 nginx、应用留在 v0.6.3 是可以的，但此后 v0.6.3 的发版核验会因后台登录 401 失败，下一次发版前要先把 nginx 装回新口径。
- rehearsal 模式与 public 共用同一个模板，后台块也一起去掉了口令。切换正式站之后 rehearsal 已不是受支持的运行模式，不为它单独保留后台口令。
- 冻结的预生产模板 `cps-novel-preprod.conf.template` 及其 snippet 不动（`public-cutover-edge.test.ts` 按 `02f9996` 逐字节钉死），预生产模式的发版核验仍期望后台登录 401。
- 这次重装会顺带让 PN-15 站内搜索的 nginx location 生效：它 10-09 合入模板，按 [ADR-PN15](ADR-PN15-SITE-SEARCH.md) 约定"由发布方用既有安装器装到生产"，此前一直没装。HSTS 提级不在本决定范围内，默认保持 86400。
