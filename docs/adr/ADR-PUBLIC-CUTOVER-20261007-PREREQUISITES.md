# ADR：2026-10-07 正式切换前置条件与 rehearsal TLS 口径

状态：accepted。Owner 在本次计划确认中分别选择“延续暂缓与豁免”和“接受现状并分阶段验收”，随后明确要求执行完整计划。

## 决定

- 正式切换当天延续异地完整恢复演练 DEFERRED、X8 凭据到期排重 WAIVED；这不是实测 PASS。异地副本完整可恢复性仍未经演练，不访问 NAS 或 X8，不还原生产数据库。
- rehearsal 默认 TLS 拒绝块使用旧域名证书。新域名严格 curl 返回 exit 60，与该配置一致；历史 `-k` 取得的 404 不充当 TLS 证据。切换前通过合法旧域名 SNI、回环 resolve 和新 Host 检查 HTTP 拒绝；安装 public 后新域名必须正常验证证书，全程不使用 `-k`。
- 公开候选中的 `auth_basic off;` 视为明确关闭认证，禁止开启认证或出现认证文件配置；不修改 renderer、模板或限流参数。

## 不变的门禁

运行 Final、22 条迁移、暂停 SQL、后台发布任务清空、备份三件及校验、nginx 候选/安装哈希、同镜像发布、外部业务验收和当天 sitemap 刷新均必须真实通过。IndexNow 保持关闭；第 3 步失败按明确要求恢复 nginx/env，其它回退档位由 Owner 决定。

来源：[切换手册](../operations/PUBLIC_CUTOVER_RUNBOOK.md)、[第二段最终证据与切换当天记录](../operations/PUBLIC_CUTOVER_EVIDENCE.md)、本次 Owner 确认。


## Owner 追加裁决：分享图口径更正（2026-10-07）

Owner 明确接受现有上游 HTTPS 封面，并指出主控提示词“og:image 全部正式域名”写错，属于验收标准错误，不是线上缺陷；本次不改代码、不回退。现有 resolveOgImage 有书封时优先书封，无书封时使用站点默认图。更正口径：canonical/hreflang/og:url 全部 https://pulsenovels.com；og:image 必须 HTTPS，且无 bangbangji、enpulsedrama、localhost 或预生产域名；首页/browse/分类等无书封取样使用正式默认图，图200/image/png；一个书封经指定代理仅HEAD一次验证200图片。逐页类型记录实际值。依裁决关闭维护、原匿名live复验后继续第5～9步，其余要求不变。
