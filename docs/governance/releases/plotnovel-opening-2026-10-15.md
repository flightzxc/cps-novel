# PlotNovel 剧场开通运维记录（2026-10-15 操作编号）

## 当前状态：阶段甲PASS，条件批准改挂已满足，乙1/乙2待执行

Owner授权执行计划；本轮仅完成甲0、甲1、甲2首次预演及完整任务清单。**PlotNovel已登记，尚未改挂、激活或开通业务。** 工作树release/v0.6.0-2026-10-14；线上v0.6.0 / Final `493eb23b034b0410780228535b3e293e4ee91f9a`，tag不移动，无业务代码/schema/nginx/版本身份改动。操作编号按Owner指定20261015，实际执行时间以原始UTC时间戳为准，本检查点于2026-10-14执行。

## 授权与验收纪律

操作人codex；登记request-id `plotnovel-register-20261015`，reason为Owner给定“v0.6.0 登记 PlotNovel 剧场（Owner 10-15 提供商店链接）”；改挂只读预演request-id `plotnovel-rehome-20261015` / reason“预演”。所有docker exec不带-i，stdin为/dev/null；特权只读SQL通过容器内heredoc输入psql，PGOPTIONS强制只读事务。仅连接haiyue-vps，任何异常读回停止，不自行修数据。

30次上限仅统计主动验收HTTP，逐条记账；业务领码/试读/IndexNow调用另按任务统计。领码金丝雀默认20本、≥19成功/≤1普通失败，manual_review_required无新增；凭据/权限/账号级故障立即停止。试读成功率须≥80%。公开网址冻结，只允许新增页面，禁止改变或撤回既有页面。

## 甲0：只读前置 PASS

2026-10-14T10:43:14Z health0.6.0/Final，metadataConsistency passed；步骤0第0～5条原文SQL：27迁移，授权f/f/f/t/f/f/t/t，函数属主migration_owner/secdef=t/search_path=pg_catalog, public，运行角色EXECUTE仅web_app，触发器O，回填0/0/0。机构1351全在moboreader，书目3,845/推广2,641。env SHA256 `359c11323c7f837402dfea2755abd6456569188ef8c202b307600d86525db832` 全程未变；前置PlotNovel app数0。

MoboReader /go仅请求1次，指定7899代理，不跟随：302，Location SHA256 `cd3e05e05efaaf1b87106c931bc37d8852f5881773ac88cad333b7723acbb2e5`。Location明文未保存；请求明细见证据JSONL。

## 甲1：登记预演、apply与读回 PASS

原 `register-plotnovel-theater.ts` 先预演，再以完全相同参数加--apply。预演仅新增source_app、channel_app及四条能力，给MoboReader补link/3366，并写两个Owner指定商店链接，无激活操作。两个链接固定为Apple id6749878264与Google Play com.plot.novel_app；读回仅保存存在/匹配布尔值。

登记时刻2026-10-14T10:46:26Z；审计825070、825071、825072。PlotNovel channel_app.id为 `00de5521-d075-4472-87eb-cc5d1732f4d0`，registered_disabled/code/agencyIds1351/codeModeLocales en/appDisplayName PlotNovel；四条能力均registered_disabled。MoboReader active/link/agencyIds3366。两个商店链接均存在且与Owner值一致。

## 甲2：改挂预演与完整任务清单

| counts字段 | 读回 |
| --- | --- |
| sourceItems | 3845 |
| sourceItemsAlreadyAtTarget | 0 |
| promoLinks | 2641 |
| promoLinksByStatus | fetched=2032，pending=609 |
| sideEffectIntents | 2638 |
| labelLinks | 7914 |
| sourceLabelsToCreate | 3 |
| mappingEdgesToCopy | 11 |

pendingGenericTaskItems、pendingSyncTaskItems、activeCatalogScans、uniqueKeyConflicts、promoKeyConflicts、publishedArticles、itemsUnderOtherApps、promoLinksNotAtSourceApp全部0，blocked=false，noop=false，applied=null，原脚本exit0。

补充完整只读查询于2026-10-14T10:50:04.530924Z执行，覆盖全部1351目标书目/小说/关联文章、全部在途补采、全部进行中目录扫描，以及活跃/暂停/未放行领取分片与父批次，不受50条样本限制。通用阻挡条目0、补采条目0、扫描0，claimShards及claimParents均为空；Owner无需中止或暂停任何已发现任务。详见 [完整操作清单](evidence/plotnovel-opening-2026-10-15/owner-action-list.md)。

## 停手点与后续

**清单为空仍按提示词停手，等待Owner确认后继续甲3。** 没有执行备份、title_normalized回填、改挂apply、剧场激活、能力开通、白名单修改或后台金丝雀；Owner后台操作尚无记录。确认后先复查预演，完成备份/回填/正式预演，再在甲4单独等待“批准改挂”。此处确认不替代阶段乙授权。

## 治理与证据

本次仅甲2检查点，阶段甲尚未结束。记录与脱敏证据先提交、推送回读；不新增发版级开发日志、不登记“PlotNovel已开通”。CHANGELOG使用原生成器与core.abbrev=7。甲阶段结束时同步Notion运维记录并回读；本检查点未冒充Notion已同步或阶段甲已完成。

原命令包装器、手册SQL、stdout和退出码、完整预演与任务清单、env摘要、请求明细均见 [证据目录](evidence/plotnovel-opening-2026-10-15/)，机器状态见 [checkpoint-a2.json](evidence/plotnovel-opening-2026-10-15/checkpoint-a2.json)。证据扫描PASS，口令码未SELECT或输出，站点密钥模式0，实际临时密钥泄漏0。本次没有数据修正或手册步骤偏离；首次改挂预演未被阻挡，仍遵守空清单停点。

## 阶段甲续行与条件授权（本会话Owner确认）

Owner确认继续甲3/甲4，并授权：若甲4数量与甲2一致（或来自新扫描的小幅增加）、全部blockers0、publishedArticles0、备份编号与pg_restore --list核验通过，则视为批准改挂，直接继续乙1/乙2，到乙3停。此授权取代上一节“甲4再次等待批准”的历史说明；尚无Owner后台操作。

- 2026-10-14T11:59:30Z复查预演仍3845书目/2641推广，全部blockers0。
- 最近VERIFIED基础备份20261011T170922Z，验证时间10-11T17:14:17Z，备份manifest摘要匹配；实际周备周期604800秒、新鲜度691200秒，年龄240319秒通过。日备last-success10-14T07:52:35Z/exit0，年龄14821秒、门槛93600秒通过。WAL archive_mode=on、archive_timeout=15min、failed_count0、ready0，最新归档11:50:31Z，无未恢复归档失败。
- 六表受保护逻辑导出：备份编号 **plotnovel-pre-rehome-20261015-20261014T120132Z**；服务器文件 `/opt/cps-novel/shared/backups/logical/plotnovel-pre-rehome-20261015-20261014T120132Z.dump`，97,484,269字节，0600；SHA256 `49452fd35945bff68f5496b56b4c9e747bc781b2caacf410d2ff41729c25c3ba`；pg_restore --list覆盖六张TABLE DATA并PASS。备份正文不回传、不进入证据目录。
- title_normalized初始缺失0，原脚本--dry-run与正式空操作均scanned0/updated0，最终缺失0，没有业务行回填写入。
- 12:04:09Z甲4正式预演使用备份编号reason：数量仍3845/2641，没有使用小幅增加例外；counts全部字段与甲2一致，八类blockers全0、publishedArticles0、blocked=false。条件批准 **SATISFIED**。三条推广链接站内码摘要和fetched状态已保存，2638条副作用意图ID/状态基线仅保存在服务器受保护运维目录。
- 包装器跨行JSON解析错误已独立留证并修正；10c正式预演PASS。没有修改业务代码或削弱原门禁。

阶段甲证据见 [phase-a-result.json](evidence/plotnovel-opening-2026-10-15/phase-a-result.json)。按Owner条件批准继续乙1/乙2；改挂后立即启用和对账，中间不插入治理等待；乙3停下等待Owner提交20本领码金丝雀。
