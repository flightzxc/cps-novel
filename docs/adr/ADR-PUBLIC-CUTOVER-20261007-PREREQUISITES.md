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


## Owner 追加裁决：限流复测设计更正（2026-10-07）

Owner指出全站页面key=$server_name，PAGE_CONN=10、PAGE_RATE=12r/s、PAGE_BURST=30 nodelay；原30次/并发10组全200符合设计，不能把错误的测试预算写成限流失效或“429未验证”遗留。追加只跑一次100次/并发20，经指定代理访问 /ko/browse，必须有429且零5xx/502；紧接只读记录一次uptime/docker stats。失败则维护停止，不改参数。本次实际63次200、37次429、无5xx，PASS。

新sitemap包含adventure分类404另属真实业务范围矛盾：分类页最近240本与sitemap完整候选范围不同。已有源码V1上限说明不替代此次Owner裁决；本轮不改功能，按停止边界维护ON，等待明确接受缺陷继续或另定处置。GSC及外部三探针Owner回复“待做吧，不急”，只记待做。


## Owner追加裁决：接受已知分类404缺陷B-38并开放（2026-10-07）

Owner接受sitemap里部分分类页404这一V1既有缺陷，继续开放，不回退。分类页getPublicCategoryPage先取该语种最新PUBLIC_LIST_CAP=240本再筛分类，0本即notFound，而sitemap按全部书目生成分类，是既有范围差异，并非此次切换引入。Owner已登记B-38，随v0.5.10修复；本次仅记录“已知缺陷B-38，Owner接受开放”，不改代码或移除URL。不得全量扫描分类页，需要时仅少量抽查；此次最终验收只查首页/en小说/章节，不新增分类请求。最终维护OFF、原匿名live及三公开页200复验PASS，对外开放确认19:39:17 JST。后台应用登录/2FA待Owner完成后只读核对，GSC/三监控待做。

补充（2026-10-07）：书封作分享图时的卡片类型（summary 小图卡片、不声明尺寸）见 ADR-B37-COVER-HOSTING-20261007.md。
