## v0.6.5 正式发版手账（已部署，技术及53本恢复核对PASS）

### 不可变身份与范围

- 版本PATCH，Final `b378910a8ec4b78029e71ad1bac92c742efb9f5b`，tree `0bb390152c2f4e87cb69338e96e4e4722f6f5f05`，集成基线`58cdb94da40e3103ddc4ebba7c267ce0c23b905e`。annotated `v0.6.5`固定Final，后续治理不改变工件。
- 镜像`cps-novel:0.6.5-b378910` / linux/amd64，归档253139535字节，SHA256 `187158e6a80b6ee02939e0e38154945993bd39aa50dd66b28e1eeb95cb43fb9b`；OCI target/platform `sha256:3a3a276aefa10d4aa9339290d0eb1f5ded040be05abbdb80e3e06b31cfada87a`，config `sha256:4a56e99cae81d9f043c7bbc6339d185c5ab5a3e4c1a5b40044d070bc910c9843`。原归档构建器和原消费端--load已独立校验。
- 三处回读改为getvideoinfo精确身份点查；getcode请求/错误分类/意图状态机及不重复调用不变。零新增迁移，29条/60表，依赖、grants、环境变量集合、compose、nginx、后台路由、任务白名单及公开网址保持，无sudo。

### 门禁与部署实测

第一阶段全量11639通过、零失败/Unhandled，37原运行器、1750严格代理探针、100动态/2静态路由、nginx三模式/27变异、B21/运行依赖/品牌镜像/compose/audit及最终镜像端到端PASS；字典1401/active1331/drift0。生产audit零critical、指定4项high，未执行audit fix。

Owner批准后仅haiyue-vps部署，<date start="2026-10-20" start-time="19:26" time-zone="Asia/Tokyo"/>，RELEASE=PASS/EXIT0；维护48.476629秒。在线逻辑备份/list/checksum通过，env只改两版本行且其余cmp相同；29finished/60表，健康0.6.5/Final/metadata passed、六服务healthy、postgres身份不变，投影0/0/0、IndexNow无熔断/429等待/积压、Next16.3.8且无测试依赖、写闸/白名单/备份/nginx保持，外部9/10次。原始部署及停点证据保留，不按后续成功覆盖历史记录。

### 53本恢复：按Owner逐阶段授权执行

MINE原严格书名匹配停点由主控裁定为尾空格/en/完整ID定位规则问题，修正并审核；随后发现MINE已有带码链接再次停手，主控只读查明来源为目录扫描84a47861（10-21 10:27:05 JST开始，11:06完成），不是重领，未调用getcode。MINE固定完整ID `c838c281-c9ba-482a-aa80-05792e8fdc4a`，单列`resolved_by_catalog_scan`，未重提。

主控审核ops@94dec9dd，脚本SHA256 `26304f9e8435bddbd702d758fae0c997e17ce23a9a69a32f7e5351fb5c826d9d`；原生web uid1001/web_app运行，核对事务READ ONLY，不读raw_payload或推广码原值、不换角色/改grants。原账户校验20行逐字复用、enqueueCatalogBatch/双enabled闸/临期审计与按钮一致；tsc0/lint0error，真实库37/37两轮、5组守卫删除变异红并恢复diffquiet，无42501。baseline SHA256 `244a096fa262f46a2b21d305e5de5829e21b1f8eabcc5ce881bb79cbdb16e99d`、48ID SHA256 `19231defb2d3488135d80e3ff6a61baf02e6438e72f916ac9b1c464605e917d6` 始终不改。

- 4本金丝雀：requestId `promo-reclaim-53-2026-10-20-canary`，批次`0dcc1e9d-5900-4987-b686-3210b66f4602`，4本均already_available，有码有网址、失败0；窗口<date start="2026-10-21" start-time="16:43" end="2026-10-21" end-time="16:47" time-zone="Asia/Tokyo"/>，精确UTC07:43:06.640–07:47:02.480Z，窗口总调用数getcode0/getvideoinfo4，新增意图0。[金丝雀证据](https://github.com/flightzxc/cps-novel/blob/release/v0.6.5-2026-10-20/docs/governance/releases/evidence/v065-release/canary-four-94dec9dd/README.md)。
- Owner随后明确“批准剩下48本”：plan精确48本及四项前提通过，清单SHA256 `46537917902afee740455aa17c6c6bb9c4894ed926653f3c4fb1c5ab770bddff`。requestId `promo-reclaim-53-2026-10-20`，批次`4ab3f194-e194-47ba-b9a4-c0c4a55b181e`，只提交一次、duplicate=false，48本均already_available、有码有网址、失败0；窗口<date start="2026-10-21" start-time="16:59" end="2026-10-21" end-time="17:03" time-zone="Asia/Tokyo"/>，精确UTC07:59:28.822–08:03:42.242Z，窗口总调用数getcode0/getvideoinfo48（48次HTTP200），新增意图0。[48本及最终53本证据](https://github.com/flightzxc/cps-novel/blob/release/v0.6.5-2026-10-20/docs/governance/releases/evidence/v065-release/remaining48-94dec9dd/README.md)。

53 = 1（目录扫描已解决）+ 4（金丝雀）+ 48（本轮），最终53本有码有网址。**按意图记录推定的每本getcode上限**均0、MINE0；两窗各自getcode事件总数=新增全局/范围意图0，getvideoinfo仅报告窗口总数，不拆每本实际HTTP计数。52本为精确回读发现已有推广链接，不称为新生成52个码；本轮getcode写入分支未执行，写入/异常恢复代码门禁以第一阶段为准。

两个窗口起止均无其它领码或pending/processing目录扫描在途，窗口新增任务只含各自父子批次；没有未决/转人工/429/熔断，六服务error/permission denied0。635条PlotNovel人工复核最终摘要`f95469197e264588a1a9a99c298632d13a8b65882f64342770d29f225717b454`保持。没有重放、缩名单、失败重试或补领。最终global claim intents33559→33559，所有取证脱敏，不含推广码、口令、凭据或URL原值。

### 治理及后续

annotated v0.6.5、原生成器core.abbrev=7的CHANGELOG、台账、发布与重领记录、唯一发版级日志已补齐；本地治理提交`cdc5ca693e9864a0ae13a431a88177ebc17bbdef`、分支及tag推送回读PASS，提交后tsc0/lint0error。本页按先本地、再同步、再回读核对当前快照/版本登记/本正式手账/唯一日志镜像，收据以[发布记录](https://github.com/flightzxc/cps-novel/blob/release/v0.6.5-2026-10-20/docs/governance/releases/v0.6.5-preproduction.md)为准。生产执行结束，不再提交书目。

公开网址继续冻结，旧权限/定位/带码停点和自写包装器修正证据保留；回滚仍须Owner另行明确批准schema兼容声明，本次没有回滚，也不自行设置兼容标志。


## v0.6.5 唯一发版级开发日志镜像

### <date start="2026-10-20" start-time="19:26" time-zone="Asia/Tokyo"/> - codex（GPT-6，正式发版执行；JST / +0800为18:26；重领于2026-10-21完成）

**变更类型**：海阅 v0.6.5 **PATCH** 正式站部署，仅haiyue-vps，Owner明确批准部署及剩余48本；原RELEASE=PASS/EXIT=0，技术及53本恢复核对PASS。Final `b378910a8ec4b78029e71ad1bac92c742efb9f5b`，tree `0bb390152c2f4e87cb69338e96e4e4722f6f5f05`，后续治理与annotated v0.6.5均不改变工件身份。

**背景**：短书名按getlistpc搜索的目标可能落在第1页100条以外，回读被判不完整而领不到码；MINE曾返回228条。Owner冻结PATCH基线，三处回读照CPS改用getvideoinfo按编号精确点查，getcode请求/错误分类/意图状态机及绝不重复调用规则不变。

**变更内容**：领码前确认、领码后核对和异常恢复使用精确身份回读。上线后53本恢复按Owner分阶段授权执行：MINE由主控只读查实的目录扫描84a47861解决、不重提；4本金丝雀及剩余48本分别原生web_app薄脚本提交一次，52本均already_available，有码有网址，失败0。53 = 1 + 4 + 48，未生成新getcode意图、没有失败重试；不能将已有链接回收表述为新生成52个码。

**影响范围**：零新增迁移，29条/60表、字典1401/active1331/drift0；grants、环境变量集合、compose、nginx、后台路由及任务白名单不变。部署env只改两版本行，其余cmp PASS；无sudo，公开网址冻结。ops独立分支不合入镜像，主控审核94dec9dd，账户校验原文20行保持一致。原MINE定位、已有带码停点及自写包装器修正证据保留，不用放宽前提绕过。

**验证方式**：第一阶段全量11639通过、零失败/Unhandled，37原运行器、严格1750探针、100动态/2静态路由、nginx三模式/27变异、audit和归档端到端PASS。第二阶段维护48.476629秒，在线备份/list/checksum、29迁移/60表、health0.6.5/Final、六服务、投影0/0/0、IndexNow、依赖/写闸/白名单/备份/nginx均PASS，外部9/10次。ops初次及还原后37/37、5组守卫变异红并恢复、无42501；生产核对全程web_app/READ ONLY。金丝雀窗16:43:06.640–16:47:02.480 JST，getcode总调用0/getvideoinfo4；48窗2026-10-21T16:59:28.822+09:00–2026-10-21T17:03:42.242+09:00，getcode0/getvideoinfo48。两个窗口各自新增意图0，与getcode事件总数相等；按意图记录推定的每本getcode上限最终53本均0，MINE0。两端无其它领码或扫描在途，未决/转人工/429/熔断0，六服务error/permission denied0，635条PlotNovel摘要最终不变。

**后续待办**：本次53本恢复已完成，不再提交、补领或自动重试。annotated tag/原生成器CHANGELOG/台账/发布与重领记录及本唯一日志已补齐并推送回读PASS；Notion四处同步回读PASS（收据记录2026-10-21 08:14:01 UTC），原历史3910行保持，可见未知块0。公开网址继续冻结；回滚须Owner另行明确批准schema兼容声明，本次没有回滚。完整[发布记录](https://github.com/flightzxc/cps-novel/blob/release/v0.6.5-2026-10-20/docs/governance/releases/v0.6.5-preproduction.md)及[最终恢复证据](https://github.com/flightzxc/cps-novel/blob/release/v0.6.5-2026-10-20/docs/governance/releases/evidence/v065-release/remaining48-94dec9dd/README.md)。
