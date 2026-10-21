### 2026-10-20 19:26 - codex（GPT-6，正式发版执行；JST / +0800为18:26；重领于2026-10-21完成）

**变更类型**：海阅 v0.6.5 **PATCH** 正式站部署，仅haiyue-vps，Owner明确批准部署及剩余48本；原RELEASE=PASS/EXIT=0，技术及53本恢复核对PASS。Final `b378910a8ec4b78029e71ad1bac92c742efb9f5b`，tree `0bb390152c2f4e87cb69338e96e4e4722f6f5f05`，后续治理与annotated v0.6.5均不改变工件身份。

**背景**：短书名按getlistpc搜索的目标可能落在第1页100条以外，回读被判不完整而领不到码；MINE曾返回228条。Owner冻结PATCH基线，三处回读照CPS改用getvideoinfo按编号精确点查，getcode请求/错误分类/意图状态机及绝不重复调用规则不变。

**变更内容**：领码前确认、领码后核对和异常恢复使用精确身份回读。上线后53本恢复按Owner分阶段授权执行：MINE由主控只读查实的目录扫描84a47861解决、不重提；4本金丝雀及剩余48本分别原生web_app薄脚本提交一次，52本均already_available，有码有网址，失败0。53 = 1 + 4 + 48，未生成新getcode意图、没有失败重试；不能将已有链接回收表述为新生成52个码。

**影响范围**：零新增迁移，29条/60表、字典1401/active1331/drift0；grants、环境变量集合、compose、nginx、后台路由及任务白名单不变。部署env只改两版本行，其余cmp PASS；无sudo，公开网址冻结。ops独立分支不合入镜像，主控审核94dec9dd，账户校验原文20行保持一致。原MINE定位、已有带码停点及自写包装器修正证据保留，不用放宽前提绕过。

**验证方式**：第一阶段全量11639通过、零失败/Unhandled，37原运行器、严格1750探针、100动态/2静态路由、nginx三模式/27变异、audit和归档端到端PASS。第二阶段维护48.476629秒，在线备份/list/checksum、29迁移/60表、health0.6.5/Final、六服务、投影0/0/0、IndexNow、依赖/写闸/白名单/备份/nginx均PASS，外部9/10次。ops初次及还原后37/37、5组守卫变异红并恢复、无42501；生产核对全程web_app/READ ONLY。金丝雀窗16:43:06.640–16:47:02.480 JST，getcode总调用0/getvideoinfo4；48窗2026-10-21T16:59:28.822+09:00–2026-10-21T17:03:42.242+09:00，getcode0/getvideoinfo48。两个窗口各自新增意图0，与getcode事件总数相等；按意图记录推定的每本getcode上限最终53本均0，MINE0。两端无其它领码或扫描在途，未决/转人工/429/熔断0，六服务error/permission denied0，635条PlotNovel摘要最终不变。

**后续待办**：本次53本恢复已完成，不再提交、补领或自动重试。annotated tag/原生成器CHANGELOG/台账/发布与重领记录及本唯一日志已补齐并推送回读PASS；Notion四处同步回读PASS（收据记录2026-10-21 08:14:01 UTC），原历史3910行保持，可见未知块0。公开网址继续冻结；回滚须Owner另行明确批准schema兼容声明，本次没有回滚。完整[发布记录](releases/v0.6.5-preproduction.md)及[最终恢复证据](releases/evidence/v065-release/remaining48-94dec9dd/README.md)。
