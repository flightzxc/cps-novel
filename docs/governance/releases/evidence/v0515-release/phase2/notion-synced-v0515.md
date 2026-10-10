<callout icon="✅" color="green_bg">
	**v0.5.15 已部署正式站；首页导航默认全部勾选，外观不变；存量回填尚未执行。** <mention-date start="2026-10-11" startTime="02:07" timeZone="Asia/Tokyo"/>（JST 02:07:56 / 2026-10-10 17:07:56Z）。Owner授权Final，haiyue-vps低流量窗口原 RELEASE=PASS / EXIT=0，维护OFF；A–E / F.1 PASS。F.2待Owner/运营首次发布1～3篇后补核，不阻断收官，首发100篇限制尚未解除。
	Final `db623505539c3ca55f55b1270aab829b8db102d7`；tree `c8252747d2115d4cc36b2f85add9b985341f2adc`；annotated `v0.5.15`；镜像 `cps-novel:0.5.15-db62350`，linux/amd64。治理来源提交 `176529ac4d7b6964c1ea064521bfb988caf20c5b`；GitHub分支与tag推送已完成，回读收据见仓库；镜像Final与后续文档提交分开。
	两组合入：导航运营勾选/权限/2FA/审计/冲突检测及阿语ICU plural，来源 `feat/home-nav-curation-v0515@44b7509` / merge `40e1850`；B-41 IndexNow批量/熔断/429等待/拒绝批次拆半定位/游标工具，来源 `fix/b41-indexnow-cps-parity-v0515@c420485` / merge `be3c9c8`。26迁移/58表；导航123全true，web UPDATE=t、投影0/0/0。
	第一阶段11181passed/0failed/无Unhandled、36运行器、字典1343/active1273/drift0，IndexNow20+20、投影44、proxy1742/0，B21/矩阵/完整变异/品牌镜像/归档E2E/Compose全PASS。服务器SHA/原--load/OCI/Final/tree均PASS。
	维护17:06:45.909804Z–17:07:55.279041Z，69.369237秒；新迁移16.301ms。五应用+postgres healthy，postgres CID不变；四应用无vitest/tinypool、Next16.3.8；六服务error/permissiondenied0、写闸及白名单不变、backup-timer RUNNING；env只改版本两行且真实cmp PASS，其他字节不变。
	IndexNow四开关保持true，只推新发布；breaker关闭、无429等待/死信/积压、keyValidation verified；历史accepted urls3/httpRequests3/delivery taskItems3，legacy skipped0、历史旧格式success3对应accepted；分钟sweep连续。未把旧样本当作本版批量验收；F.2待补核。
	首页前后100个slug逐项一致、首项adventure，外部2/10全代理。搜索保持关闭；未修改nginx/证书/DNS/业务开关/公开网址，未保存导航或执行回填。Owner10-10决定及34本诊断详见新手账和唯一日志镜像。
</callout>

<tr color="green_bg">
<td>**v0.5.15**</td>
<td><mention-date start="2026-10-11" startTime="01:07" timeZone="Asia/Shanghai"/>（JST 02:07:56 / 17:07:56Z）</td>
<td>PATCH</td>
<td>首页导航运营勾选、阿语ICU plural、B-41 IndexNow批量；26迁移/58表；导航默认全勾选，存量回填未执行</td>
<td>Final `db623505539c3ca55f55b1270aab829b8db102d7`；annotated `v0.5.15`；image `cps-novel:0.5.15-db62350`；治理 `176529ac4d7b6964c1ea064521bfb988caf20c5b`</td>
<td>已部署正式站；A–E/F.1 PASS；F.2待首次发布后补核，首发100限制未解除；搜索关闭</td>
</tr>

## v0.5.15 正式发版手账（第二阶段 A–F）
部署时间 <mention-date start="2026-10-11" startTime="02:07" timeZone="Asia/Tokyo"/>；批准Final `db623505539c3ca55f55b1270aab829b8db102d7`，原 `RELEASE=PASS / EXIT=0`，仅haiyue-vps。两组改动已在正式站生效，导航默认全部勾选且外观零变化，存量回填尚未执行。
A：env 原SHA256 `95c3020a42459af6850fe67a87b2fced886ac25be888f5d555f5cf910412bae7` 匹配，备份 `/opt/cps-novel/shared/env/preprod.env.bak-v0515-20261010T170620Z`；仅两个版本行改0.5.15/v0.5.15，实际cmp PASS；新SHA `823adaf178fa543fd3b964038af043d97eb05af4ec2cfee0fe64a49f8773c603`。四个IndexNow true开关、写闸登记和两白名单逐字保留。
B：两次postgres只读事务PUBLIC_CUTOVER_PAUSE_GATE PASS，publish/generate在途0，25旧迁移名称/checksum匹配，新增迁移此前未执行；accepted3、delivery success3、无pending/processing，10分钟sweep10。初始公开TCP观测1/1/1、最后0/0/0；nginx日志不可读，未擅自提权，不声称请求速率。原在线备份 `/opt/cps-novel/shared/backups/logical/cps-novel-v0515-20261010T170346Z.dump` 716586016字节，SHA `20a1761508ef3c6bb17d9c3fbd98df9572dbe2ae71d88180af231c7f530e1f7f`，pg_dump/restore16.14，完整pg_restore --list/sha256 PASS；before首页仅1次。
C：原Final发布脚本带APPROVED_GIT_COMMIT=Final及PREPROD_APPROVED_MIGRATION=YES，只部署一次。维护17:06:45.909804Z–17:07:55.279041Z（JST02:06:45.909804–02:07:55.279041），69.369237秒；新增迁移16.301ms，维护OFF后anonymous-only --expect-live PASS。
D/E：26迁移全finished/0rolled_back/checksum匹配、58表，canonical_tag123全true、web新列UPDATE=t，标签投影missing0/extra0/changed0；五应用+postgres healthy、postgres CID `691f4c3e43d7a8dd7acee843a62156c858b783fa8712d5ed366283dd236f525e` 不变。四应用生产依赖门禁PASS dev522/无vitest/tinypool、Next16.3.8，web nanoid3.3.18。写闸、通道白名单保持，backup-timer RUNNING；六服务error/permissiondenied0。IndexNow `breaker.open=false`、`rateLimit.waiting=false`、`deadLetters=[]`、dueUrls0、keyValidation verified；accepted urls3/requests3（200 2/2，202 1/1），delivery taskItems success3、scan success665，无在途批次；legacy skipped0，旧格式历史success3对应accepted。10分钟sweep10，scheduled_for连续每分钟enqueued（含维护补调度）。
F：after首页仅1次，100slug有序列表逐项相同、adventure首项；外部2/10全部代理。**F.2待首次发布后补核**，已请Owner/运营发布1～3篇，尚未收到安排；我未代发或把旧3条accepted当作新批量样本。依交接本项不阻断收官，批量首发100篇限制未解除。后续核1～2分钟accepted、batch_size\>=1、request_batch_id非空、1taskItem/1request。
归档252833661字节、SHA `54f38dbc8d49e815db22c452825898f438af70c6ca320145aabfd4694a74d8c6`；OCI target/platform manifest `sha256:b753a3b7c0a650d75db8167d925ffce3d835efc4e1c3d8b7cc7934345006e935`、config `sha256:dd7b6cbe849ec74cf5368acea04243aac1bab1f113fa544094f030d1cf1f0bef`；服务器原消费端--load身份通过。未改nginx/证书/DNS/业务开关/公开网址，未后台保存导航、存量回填、手工SQL写入或回滚；没有功能开发。
annotated v0.5.15固定Final，CHANGELOG原生成器core.abbrev=7；台账、唯一发版日志、发布记录和原始证据已提交 `176529ac4d7b6964c1ea064521bfb988caf20c5b` 并推送。Notion四处同步并回读PASS（2026-10-10T17:16:08.662Z），当前快照/版本表/详细手账/唯一日志镜像一致；移除本次新增内容后原历史规则、模板与正文逐字保留。
[完整发布记录与原始证据](https://github.com/flightzxc/cps-novel/blob/release/v0.5.15-2026-10-10/docs/governance/releases/v0.5.15-preproduction.md)；[脱敏IndexNow完整输出](https://github.com/flightzxc/cps-novel/blob/release/v0.5.15-2026-10-10/docs/governance/releases/evidence/v0515-release/phase2/indexnow-status.json)。
## v0.5.15 唯一开发日志镜像
### 2026-10-11 02:07 - codex（GPT-6，正式发版执行；JST）
**变更类型**：海阅 v0.5.15 PATCH 正式站部署，仅 haiyue-vps。Owner 明确授权 Final `db623505539c3ca55f55b1270aab829b8db102d7`；2026-10-10 17:07:56Z 原 RELEASE=PASS / EXIT=0、维护 OFF。A–E / F.1 PASS，F.2待首次发布后补核、不阻断收官，首发100篇限制未解除。
**背景与 Owner 10-10 决定**：本版两组范围；首页导航“全部按推荐”；B-41“8项按推荐，加主控筛选过的GPT评审补充”；回填分两次单独放行；露骨简介推到下一版；本版交Codex发布。34本试读诊断：21本上游章节列表为null，13本空正文，后者登记B-42。IndexNow已于10-10开闸，仅推新发布。低流量依据为两轮连接观测1→0与发布/生成在途0，没有擅自提权读取nginx流量日志。
**变更内容（两组与来源）**：首页题材导航运营勾选/后台权限、2FA、审计、冲突检测，阿语字数提示ICU plural及语种注释更正（`feat/home-nav-curation-v0515@44b7509` / merge `40e1850`）；B-41 IndexNow批量投递、熔断/429等待、拒绝批次拆半定位、游标回填及只读status/resume工具（`fix/b41-indexnow-cps-parity-v0515@c420485` / merge `be3c9c8`）。本轮无功能开发，沿用六文件升版范围；迁移新增 `20261010160000_canonical_tag_homepage_visible`。
**影响范围**：两组改动在正式站生效；导航默认全部勾选，外观零变化；存量回填尚未执行。搜索保持关闭。env仅版本两行、其他字节cmp一致，IndexNow四true开关、登记和两白名单保留。26迁移/58表，未改nginx、证书、DNS、业务开关或公开网址，未后台保存导航、生成或代发文章、手工SQL写入、回滚或擅设兼容批准。
**验证方式**：第一阶段11181passed/0failed/无Unhandled，36运行器全部通过，26迁移、字典1343/active1273/drift0，IndexNow20+20、投影44、strict proxy1742/0，B21/矩阵/完整变异/品牌镜像/Compose/归档镜像E2E全部PASS。服务器SHA/Final/tree/原--load/OCI PASS；两次只读暂停门禁和旧25checksum一致；在线备份716586016bytes/SHA20a17615…530e1f7f/restore-list PASS。维护69.369237秒（17:06:45.909804Z–17:07:55.279041Z），迁移16.301ms；26finished/0rolledback/全部checksum匹配，导航123全true/webUPDATE=t、投影0/0/0、五应用+postgreshealthy/旧CID；四容器无vitest/tinypool、Next16.3.8，六服务error/permissiondenied0，写闸相同、backup-timerRUNNING。IndexNowbreakerclosed/无429等待/无死信/积压0/keyValidationverified，历史accepted urls3/requests3/taskItems3，legacy skipped0、旧格式success3对应accepted，分钟sweep连续；首页100slug前后逐项相同、adventure首项，外部2/10全代理。包装器提前拉完成文件、容器白名单变量名、即席语法及远端rg不可用均修正登记，原门禁与部署未重跑。
**后续待办与治理**：F.2已请Owner/运营发布1～3篇，待核约1～2分钟accepted、batch_size\>=1/非空request_batch_id/一条目一请求；未完成前首发100篇限制保持。存量回填分两次另行授权、B-42空正文、露骨简介下一版、nginx搜索location/HSTS另行安排。annotated v0.5.15固定Final、原生成器七位SHA CHANGELOG、本台账/唯一日志/发布记录及证据已完成；GitHub和Notion同步回读另附收官补记。完整证据见 [v0.5.15 发布记录](https://github.com/flightzxc/cps-novel/blob/release/v0.5.15-2026-10-10/docs/governance/releases/v0.5.15-preproduction.md)。回滚须Owner另批SCHEMA_COMPATIBLE_WITH_PREVIOUS=YES且先确认无积压或关闭交接推送四项，不下迁移、不改nginx。
