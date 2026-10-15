# PlotNovel 剧场开通运维记录（2026-10-15 操作编号）

## 当前状态：甲阶段及乙1/乙2 PASS；停乙3等Owner提交领码金丝雀

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

## 乙1：条件授权后的原脚本改挂与读回 PASS

- 12:09Z执行前再次用正式backup reason预演，counts全部字段与甲4完全一致、所有blockers0、publishedArticles0；备份SHA再次核验一致。按条件批准执行原 `rehome-plotnovel-source-items.ts --apply --confirm REHOME_PLOTNOVEL_SOURCE_ITEMS --expected-source-items 3845 --expected-promo-links 2641`，operator codex、request-id仍plotnovel-rehome-20261015。
- 单事务结果：书目3845、推广2641、推广幂等键2641、副作用意图2638、标签关联7914、新标签3、映射边11；审计825156，书目ID集合SHA256 `eb38ec0ba7cb99282152db9150a3daf63e0acb8363ec2c252d1beb540a4400ee`。
- 后续原预演noop=true、sourceItems0/sourceItemsAlreadyAtTarget3845/blockers全0；机构1351全在plotnovel，3845/2641。三条站内码摘要与fetched状态逐项相同；2638条意图ID/状态逐项匹配、全部归属PlotNovel，状态差异0、错误属主0。
- 读回证据先写服务器受保护b1-readback.json，马上进入乙2，没有插入治理等待；改挂完成到active间隔2.563754秒。

## 乙2：启用与标签对账 PASS

- 原登记工具先预演再apply，request-id plotnovel-activate-20261015、operator codex；12:09:25.424640Z剧场置active，审计825157，商店链接与MoboReader配置未改。
- claimPromo原工具先预演再apply，CHANNEL_CAPABILITY_OPERATOR=codex，reason含plotnovel-claim-enable-20261015、evidence为服务器b1-readback.json；12:09:27.084326Z enabled，审计825158。该工具原CLI不接受request-id、审计requestId由工具生成，未伪造参数或改代码。
- 原 `effective-tag-projection.ts check → reconcile --apply --confirm RECONCILE-EFFECTIVE-TAGS → check` 全执行；初次0/0/0，原reconcile inserted0/updated0/deleted0，最终0/0/0。
- 12:09:41.203312Z最终读回：PlotNovel active/code/1351，claimPromo enabled；getlistpc/getbydataid/getchapterinfo仍registered_disabled。MoboReader active/link/3366。全局FEATURE_PROMO_LINK_CLAIM及PROMO_LINK_CLAIM_ALLOW_WRITE只读确认均true。
- 所有容器ID不变，env SHA仍359c11323c7f837402dfea2755abd6456569188ef8c202b307600d86525db832；未重建容器、未改试读白名单、未新增公开文章（PlotNovel publishedArticles0）。完整B1/B2由一次受保护脱离SSH的运维进程串行执行，所有生产业务命令仍为容器内原脚本、无-i、stdin=/dev/null；无数据修正或手动SQL写入。

## 当前乙3交接与待验收基线

**到乙3停手，等待Owner在后台提交领码金丝雀。** 原有fetched2032、pending609；manual_review_required已有609条，2638条意图状态前后逐项一致，故没有新增。原手册约590排队仅为参考，当前609条全部需要人工核对，不当作可直接重领的队列，不自动释放、重复领码或换账号绕过。

12:12:09Z只读补核：PlotNovel书目全部linked，共3845；已纳入/无fetched/无人工复核标记的英语候选1204。请Owner在 `/catalog-sync` 选PlotNovel、英语、已纳入、推广“未领取”，选择20本，并选择与MoboReader相同账号，提交一次后回传父批次任务ID。甲2没有暂停旧MoboReader批次，故无需恢复；本会话尚未代提交任何批次。

本批验收口径19/20成功、最多1普通失败、人工复核相对609基线无新增；凭据/权限/账号级故障立即停止。金丝雀读回完成后仍须Owner明确“继续阶段丙”，本次条件授权不含阶段丙。外部请求仍1/30，无新增HTTP。

阶段甲已单独提交e69b71c8；本停点提交乙1/乙2及交接证据，未宣称阶段乙金丝雀已验收或完整开通完成。Notion单条运维记录已同步并回读PASS（2026-10-14T12:18:26.807Z），原历史逐字保留；来源治理4a3fcfa83a36e60ef8183b1496649223214fbaca已推送回读。收据见 [notion-readback-b3.json](evidence/plotnovel-opening-2026-10-15/notion-readback-b3.json)。结果见 [checkpoint-b3.json](evidence/plotnovel-opening-2026-10-15/checkpoint-b3.json) 与 [Owner交接](evidence/plotnovel-opening-2026-10-15/owner-canary-handoff.md)。

## 乙3：Owner提供任务后的只读核查与门禁失败停手

Owner提供父任务 `932851c3-1205-4fde-88f3-0e78355540d9`（后台 `/tasks/932851c3-1205-4fde-88f3-0e78355540d9`）。2026-10-14T13:52:51Z仅连接haiyue-vps只读核查，Final、env SHA、health及metadataConsistency通过；没有提交、重试或修改任务，没有新增主动HTTP请求。

实际父批次为promo_claim / explicit_ids，共133本，分为MoboReader100本与PlotNovel33本，偏离约定的20本PlotNovel金丝雀。两个分片均终态completed、使用同一渠道账号UUID（也与既有MoboReader推广记录账号一致）：

| 剧场 | 分片任务ID | 任务成功/失败/跳过 | 业务读回 |
| --- | --- | --- | --- |
| MoboReader | 3d639a78-a71b-4dfa-ba04-8c2e7597e89d | 100/0/0 | 本批意图confirmed100 |
| PlotNovel | 4ebb8788-d716-4ab4-8916-1c29e6da8b83 | 33/0/0 | fetched/confirmed7，pending/manual_review_required26 |

PlotNovel33本全部英语、linked、机构1351；推广口令存在标记仅7条为true，未读取口令值。业务确认比例为7/33（21.21%）；manual_review_required从历史609增至635，新增26条的创建时间均在本批内。原worker对需要人工复核的结果返回任务success，因此33/33任务成功不能作为领码业务验收通过；具体人工复核原因未继续调查，不能据此断言凭据/账号故障或上游成功/失败。

**门禁FAIL，立即停手。** 不将133本混合批次或33本PlotNovel分片冒充20本验收；不进入阶段丙、不放量、不自动重复getcode、不换账号、不重置意图或推广数据、不自行回关claimPromo或剧场。任务已经全部终态，没有本批在途任务可暂停；若另有领取批次，Owner可按原手册选择批次级暂停。是否进一步只读排查或执行回关由Owner明确裁决；数据恢复/旧镜像回退仍停在Owner审批点，兼容标志要求不变。

发现门禁失败后未再执行手册步骤5两条汇总SQL，也未继续生产查询；现有一次只读事务完整保存本批推广/意图状态及全局人工复核计数。首条检查脚本的errorPresent仅为JSON是否非空诊断，不作为失败判据（JSON null可能使该布尔值为true）；任务失败计数及errorCode均为0/空，业务判断依据fetched和confirmed。

本轮只更新脱敏记录、证据与Notion停手状态；阶段乙未验收通过、完整开通未完成。证据见 [canary-stop-result.json](evidence/plotnovel-opening-2026-10-15/canary-stop-result.json)；原始受控结论为CANARY_INSPECT_READONLY=PASS，业务门禁为STOP_B3_MANUAL_REVIEW_GATE_FAILED。外部请求仍1/30，白名单/公开页面未操作。

停手检查点文档提交efbac3ce已推送并回读。Notion既有单条开通运维记录更新为乙3门禁FAIL并于2026-10-14T13:57:23.669Z回读PASS，历史正文逐字一致、没有重复条目；首次检查误比较fetch包装层的as-of时间戳产生FAIL，保留首次收据，改为原生content精确比较后PASS，没有额外写入Notion。收据见 [notion-readback-canary-stop.json](evidence/plotnovel-opening-2026-10-15/notion-readback-canary-stop.json)。

## Owner授权只读排查与领取防护（2026-10-14T14:48Z～14:53Z）

Owner进一步授权数据库只读事务、容器日志、仓库代码排查，并明确授权一项防护写入：PlotNovel claimPromo回关registered_disabled。禁止getcode、重领、修改业务数据及记录回关；任何上游只读接口调用均需另行批准。阶段丙继续暂停。本轮没有调用任何上游接口，也没有新建扫描任务。

**批次事实更正**：Owner说明133本由主控提供的后台步骤缺陷造成：默认排序勾选的100本MoboReader在改排序后保留，继而带入33本PlotNovel；不是Owner操作失误。仓库证据吻合：页面CatalogSyncClient的key只取canonicalFilter，后者排除sort；选中集合由组件状态保留。MoboReader100本全部confirmed，无需处理；排查对象为PlotNovel33本（7确认、26人工复核）。先前20本口径差异保留为历史记录，不作为此次事故责任判断。

**防护已完成**：手册步骤8原set-channel-capability-status.ts先dry-run再apply；operator codex，reason原文“排查领码人工复核期间暂停”，审计825591。14:48:21Z读回，仅PlotNovel claimPromo由enabled改为registered_disabled；剧场仍active、其它三能力仍disabled、MoboReader全部状态与能力逐项不变。14:53Z再次读回disabled。Final/env未改，不回退镜像、不重建容器，不修改推广/意图/公开页面。

### 解析与回读结论

领码解析契约（src/lib/adapters/promo-link-claim.ts:223）：顶层必须是对象；status必须为boolean true、code必须为number 200；data必须是对象；data.kocCode必须为去掉首尾空白后非空的string。publicUrl/homeLink是可选string，缺失/空/非string均归为null，并不会导致malformed_payload。

新增26条意图只记录failureCategory=malformed_payload、readbackStatus=promo_missing、readbackConfirmed=false；没有upstreamEnvelopeStatus/Code诊断键。这排除了已被该版本诊断记录的非成功status/code分支，但仍不能区分：非JSON正文、顶层非对象、data非对象、kocCode缺失/null/空串/非string。**不能以现有证据断言具体缺项或原始类型**。worker观测日志只记录HTTP/耗时，不记录响应正文或字段形状；133本rawPayload中的kocCode/publicUrl/homeLink全部为脱敏标记，不能当作原始响应证据或重建真实推广。

精确回读先按agencyId/seriesId/language/projectType唯一匹配。promo_missing只会在已匹配到唯一目标行、该行kocCode不是非空string时返回；不要求publicUrl/homeLink，因此不是“网址缺失造成回读不匹配”。目前只能确认当时回读未见合格口令字段，不能区分上游延迟、持续空值或字段类型/命名差异。

运行策略为3次只读回读、间隔2000ms。只读取既有worker日志：MoboReader窗口getcode100/getlistpc200；PlotNovel窗口getcode33/getlistpc118；451条全部HTTP200/outcome ok，无429/5xx/传输错误，worker-light该窗口无观测。PlotNovel118次与7本常规前后回读、26本前读及3次恢复回读数量一致；观测无书目关联ID，不把时间窗口归组冒充逐请求的书目标注。没有新增上游调用。

### 原有609条人工复核签名

| 分组 | 数量 | failureCategory | readbackStatus | readbackConfirmed |
| --- | --- | --- | --- | --- |
| 改挂前历史 | 608 | malformed_payload | promo_missing | false |
| 改挂前历史 | 1 | readback_unconfirmed | promo_missing | false |
| 本批新增 | 26 | malformed_payload | promo_missing | false |

608条与新增26条的完整response_shape SHA256完全一致。历史1条代表getcode响应曾通过解析，但其后口令回读未确认；其余634条是同签名，不代表已证明同一种上游根因。当前635条对应read类型推广均pending/upstream_code_present=false，没有自动补齐。

### 目录补码与人工收口

现行v0.6.0已实现code模式目录同步只要求非空kocCode、不要求网址；书目已linked/novelId非空即可upsert推广为fetched、清错误并绑定文章。目录与领码均用同剧场/书目/账号/offerType=read幂等键，故同账号扫描取得合格码时可更新现有pending记录。MoboReader合法目录任务仍可按机构1351分流到active的PlotNovel；claimPromo关闭不取消此目录补码路径。但本轮没有发起扫描或开启PlotNovel getlistpc，未来上游是否返回码未知，因此“能补”是条件能力，不能承诺自动补齐。

目录补码不会修改side_effect_intent；人工核对是worker终态，确认函数只允许prepared/claim_retry_blocked，数据库B15亦保护人工出边。依原X9后台人工裁决，Owner取得精确目标/同账号有效证据后选effect_confirmed并写reason，才将意图改为confirmed；此操作只更新意图和审计，automaticReconciliation=false，不自动补推广或文章。建议先获授权做只读证据核查、再经授权目录重扫补业务行、最后人工裁决。未见码的条目继续保留人工复核，不能凭一次未见码裁定no_effect_confirmed，也不能批量改635条或重复getcode。

### 为什么7本成功、后续建议

7本的task result.decision均claimed（不是已有码跳过或回读恢复），response_shape均confirmedFrom=prepared/hasWebUrl=false/hasAppUrl=false；对照MoboReader100本均claimed、confirmedFrom=prepared、两个网址标记true。prepared是getcode前已提交的本地意图状态，confirmedFrom记录本地状态迁移来源，表示本次领码解析成功且独立精确回读找到了相同码，随后在围栏事务中确认；它不是上游返回字段，也不表示领取前已经有码。7本同时证明无网址路径实际可成功。

当前根因边界：解析不满足严格领码契约，恢复回读未见合格码，进入保护性人工复核；具体上游缺项/类型及延迟原因尚无证据。优先代码建议是补充只记录解析分支/字段名/类型/是否空白的诊断（body_not_json、envelope_not_object、data_not_object、koc_code_missing/null/blank/type），不记录口令/正文/网址，不放宽成功判定或重试getcode。只有取得真实字段契约差异证据后再决定适配器改动；不能把取消网址要求当修复，因为当前已不要求网址，也不能盲目增加等待时间宣称修复。

进一步判断当前是否已可见，需要Owner另行授权精确目标的上游只读getlistpc探针；它可判断当前可见性，不能补证已经丢失的历史getcode字段形状。本轮到此停手，保持claimPromo disabled、阶段丙暂停。只读证据及唯一授权防护详见 [investigation-result.json](evidence/plotnovel-opening-2026-10-15/investigation-result.json)。辅助17查询未通过task_item_id/promo_link_id找到账户分组，因为原prepare不填写这两项；18按原request_summary书目ID/剧场/本批时间及幂等键修正查询，保留首次结果，没有改数据。

只读排查与防护记录990a2eae已推送回读。Notion原单条运维记录已更新防护状态、608/1/26分组、证据局限及主控步骤说明，并于2026-10-14T14:58:01.446Z回读PASS，原历史正文完整保留。见 [notion-readback-investigation.json](evidence/plotnovel-opening-2026-10-15/notion-readback-investigation.json)。

## 后续代码改动建议：领码响应字段类型诊断（Owner 2026-10-15要求，仅登记）

建议在parseClaimResponse及非JSON处理点增加独立、明确的解析分支标识：body_not_json、envelope_not_object、envelope_status_invalid、envelope_code_invalid、data_not_object、koc_code_missing、koc_code_null、koc_code_blank、koc_code_type_invalid。只记录受控字段名/路径、是否存在、原始类型、解析分支；不记录字段实际值、完整响应、口令码、网址、message、标题或凭据。诊断日志与response_shape共用同一白名单边界，使malformed_payload可按明确分支分组，不再需要由缺少诊断键推断。

必须保持诊断异常不改变业务判定，不增加getcode重试、不放宽非空string与精确身份匹配，不自动处理manual_review_required。实施时补充仅码无网址、缺失/null/空串/错误类型、非JSON/对象异常、诊断回调异常及敏感值不进入日志的回归验证。这是后续代码建议，不是本轮代码施工或上线授权；当前业务代码与v0.6.0 Final保持一致。

## Owner批准43次精确只读getlistpc回读（客户端2026-10-15）

范围严格固定：指定父批次26本人审、7本成功对照，加历史608条按created_at/id排序等分抽10本（排名1/68/136/203/271/338/406/473/541/608）。共43个不同书目，同一渠道账号；每本只请求一次，不重试、不翻页、不调用getcode。历史样本包括2026-09-23最早至2026-10-14最晚记录。本次不补码、不结束人工复核、不改解析代码，阶段丙暂停。

在worker容器运行受限一次性只读探针，复用原claim适配器readPromoAfterClaim和实际生产rateGate；当前getlistpc间隔1500ms、host gap250ms、remaining floor8，未修改限速/网络配置。transport严格只允许POST getlistpc原坐标name/orderType1/pageIndex1/pageSize100/projectType1，最多43次，拒绝其它路径；43次串行单次全部成功，无429或传输错误。数据库查询均事务只读并验证worker_app/transaction_read_only=on。独占start标记防止意外重跑，原响应及口令只在容器内临时内存，捕获输出仅字段名/类型/boolean及码存在性/长度，不保存正文。

完成时间2026-10-14T17:59:07.126Z（UTC，Asia/Tokyo为2026-10-15）；getlistpc43/getcode0/retries0。

| 分组 | 找到唯一目标 | 现在有码 | kocCode类型及长度 |
| --- | ---: | ---: | --- |
| 本批人工复核26本 | 26/26 | 0/26 | 全部字段存在、null，长度0 |
| 成功对照7本 | 7/7 | 7/7 | 全部非空string，长度6 |
| 历史抽样10本 | 10/10 | 0/10 | 全部字段存在、null，长度0 |

在允许比较的存在性/类型/boolean范围内，有码7本与无码36本的系统性差异仅三项：kocCode、promoCreateTime、promotionalText（有码均string，无码均null）。其它字段类型一致；publicUrl/homeLink均null；onlyTikTok/hasTikTokPromoLink/isRelease均boolean false；payEpisFrom均number，未比较数值。不能把这些共同boolean标记当作领取资格差异。

结论：这26本现在仍没有合格码，并非本地适配器因网址缺失漏读；历史10样本同样如此。本批距领取已数小时仍无码，结果不支持仅短时几秒延迟即可恢复的解释；10样本不能替代608全量，也不能由当前getlistpc字段倒推历史getcode具体缺项或确定上游业务原因。当前没有可补的有效码证据，不建议补码或批量裁决“未发生”；保持人工复核待后续Owner裁决。

前后只读快照相同：635条人工复核、claimPromo disabled；43个样本意图状态/确认时间及推广状态/存在标记/updatedAt逐项一致，没有业务数据写入或回关人工记录。Final/env保持原值，未改任何解析代码或公开页面。诊断补强建议已按Owner第5条登记，不施工。

逐本结果与全字段类型见 [readback-43-per-book.md](evidence/plotnovel-opening-2026-10-15/readback-43-per-book.md)，每本独立fields数组见 [readback-43-result.json](evidence/plotnovel-opening-2026-10-15/readback-43-result.json)，抽样与汇总亦在同一证据目录。请求43次按本次上游只读授权单独记账，前台验收HTTP仍1/30。后续补码、人工收口及代码修改均等待另行授权。

43次回读治理提交ff6ba90c已推送并回读。Notion既有单条开通记录同步汇总、边界及诊断建议，并于2026-10-14T18:03:18.007Z回读PASS，原历史保留。见 [notion-readback-43.json](evidence/plotnovel-opening-2026-10-15/notion-readback-43.json)。

## Owner确认上游问题后继续丙1，停丙2（客户端2026-10-15）

Owner确认这批书在畅读后台点击领取也无反应，认定上游问题并等待上游答复；明确保持claimPromo关闭、635条人工复核不动，授权已有口令码的书继续阶段丙，先5～10本试读金丝雀，再到丙2停下等Owner后台生成发布20～50篇。该决定解除此前领码门禁失败后的阶段丙暂停，但不批准重领、推广修复或人工收口；本会话没有重复getcode或上游后台领取验证。

丙1预检18:35:35Z：Final/health/metadata/env原摘要通过，四能力仍disabled、人工复核635、PlotNovel已发布0。英语/已有fetched口令/linked/无有效试读/无withdrawn/无在途预览候选2034，固定选10本。已有效试读仅5本，创建于10-14T01:44Z，均3章；这五个source ID逐项排除并在丙1结束再次读回仍各3章。未从635本人审中挑选金丝雀。

### env与原镜像重建

- 18:37:33Z改前SHA为359c11323c7f837402dfea2755abd6456569188ef8c202b307600d86525db832；备份 `/opt/cps-novel/shared/env/preprod.env.bak-plotnovel-preview-20261014T183733Z`，0600，仅服务器留存。
- 只改/新增MOBOREADER_PREVIEW_SOURCE_APP_CODES=moboreader,plotnovel；安全diff只含该行，剔除此行后cmp逐字一致。改后SHA **f37561c7710c886d547e9add4377ca4009e63381e0eb10a74a154984e1221369**，后续common核查使用此新摘要，旧证据helper保持原样。
- 原Compose渲染确认向web/worker/worker-light透传。原preflight PASS，读取已批准Final manifest并核验不可变镜像；18:38:42.800Z～18:38:52.570Z仅原preprod_compose_app_up --force-recreate web worker worker-light（内含--no-deps及不拉取/构建门禁），健康等待通过，原container identity对web/worker/worker-light/scheduler全PASS。
- 三容器CID改变、镜像ID及引用不变，除白名单外Config.Env逐项相同；postgres/scheduler/backup-timer CID不变。health仍0.6.0/Final、metadataConsistency passed；没有release/deploy、migration或nginx动作。

### 能力与原试读金丝雀

getbydataid/getchapterinfo各用原set-channel-capability-status.ts先预演后enabled，operator codex，reason含plotnovel-preview-<能力>-enable-20261015，evidence指向服务器c-runtime.json；审计825823/825825。claimPromo/getlistpc仍registered_disabled，剧场仍active。没有恢复领码或改全局领码开关。

原preview-backfill-recovery.ts以明确10个source IDs、--limit10/--batch-size10、request-id plotnovel-preview-canary-20261015先survey，再--apply --confirm APPLY_PREVIEW_BACKFILL；凭据预检usable，候选10/truncated=false。原工具actor为preview-backfill-recovery（没有operator参数，未改原接口）。单任务 **51854b9b-6cb4-452c-89b6-d30976c03647**，requestToken preview_backfill:plotnovel-preview-canary-20261015:0，eligible10/skipReasons空。

任务18:40:08.732Z开始，18:40:26.354Z终态completed；success10/failed0/skipped0，成功率100%达到80%门槛。逐本attempt1，上游返回3～5章，按原策略物化各3章，全部30章body非空且displayAuthorized=true。原五本各3章保持不变。任务窗口观测getbydataid10/getchapterinfo10，均HTTP200/outcome ok；getcode0、preview_read_failed0。首次辅助日志计数误用事件名preview_read_failure，28只读复查使用原sink的preview_read_failed并留证；没有任务重试或门禁削弱。

人工复核635条id/status/response_shape摘要前后完全一致，推广id/status/upstream_code_present/updated_at摘要亦一致；没有补码、改意图、重领、生成或发布文章。所有容器running，四应用healthy，backup-timer running；PlotNovel已发布仍0。成功率通过，未触发试读失败回关。

### 丙2停点与治理

**丙1PASS，到丙2停手等待Owner后台操作。** 最新授权文章金丝雀为20～50篇（取代早期计划固定20篇）；Owner在生成页确认英语候选及同名阻挡提示，核对选中剧场/数量后生成发布一次，提供生成/发布任务ID及文章ID，不自动补发失败或阻挡文章。本会话不代提交、不提前做公开验收；主动前台HTTP仍1/30，试读上游20次按任务另计。

仍不宣称完整开通验收完成、不增加发版开发日志、不移动tag/Final。逐本成功/失败类别和章节数及后台入口见 [c1-canary-and-owner-handoff.md](evidence/plotnovel-opening-2026-10-15/c1-canary-and-owner-handoff.md)，机器状态见 [c1-result.json](evidence/plotnovel-opening-2026-10-15/c1-result.json)。env备份正文、口令、凭据和章节正文未进入证据。后续公开页面与IndexNow验收待Owner发布完成后继续。

丙1停丙2治理提交82d60ef3已推送并回读。Notion原单条开通记录更新试读PASS、env链及Owner后台交接，于2026-10-14T18:48:44.058Z回读PASS；原历史正文完整保留。收据见 [notion-readback-c1.json](evidence/plotnovel-opening-2026-10-15/notion-readback-c1.json)。

## 丙2：Owner后台发布50篇后，只读发现站点地图时序缺口而停手

Owner回传生成任务48eba852-5fd8-479b-a74a-0b850ff6af71，说明50篇已发布；重复点击159a24f6被准入拦截、0篇，无需处理。本轮未操作重复任务。数据库读回生成completed/50success/0failed/0skipped、50个不同article ID，全部PlotNovel英语published/fetched有码，文章正文站内go码与绑定推广一致；50本均3章有效试读。DB发布时间2026-10-15T04:59:59.005Z～05:00:00.248Z。IndexNow50/50 accepted、HTTP200，熔断关闭/无429等待/due0/deadLetter0/无在途投递批次，635人工复核及claimPromo关闭保持。

固定抽取按published_at/article_id排序第1、13、26、38、50篇。公开GET前只读定位去重站点地图分片时，发现当前静态图50书页齐全，但仅81/150相关章节URL，缺69。涉及5个English novelpage分片；没有换样。首个辅助包装器覆盖断言失败且未打印计数；31a先打印再核对，保留原失败证据；31b仅只读核对生成时点：最后sitemap task2cc950ef于05:00:43.975850Z完成，50本试读task60ad99a6于05:01:17.367472Z完成，之后未见后续sitemap任务，当前release仍2cc950ef。因而不是当前仍有试读/刷新任务在跑；时序符合刷新早于试读最终完成，尚未进一步审查代码根因。

依原“任何异常立即停手”，不手动刷新、不改数据/代码/env/能力、不撤回页面、不补码/人工收口。轮播serving快照PlotNovel0条，但首页HTML、五篇按钮/小字、章节、go/中间页、口令泄漏及外部sitemap验证尚未执行，均不宣称PASS；本轮公开HTTP0，累计仍1/30。没有输出口令码、原始正文或章节内容。

停手证据及待Owner批准的原CLI预演/刷新步骤见 [c2-sitemap-stop.md](evidence/plotnovel-opening-2026-10-15/c2-sitemap-stop.md)，机器结果见 [c2-stop-result.json](evidence/plotnovel-opening-2026-10-15/c2-stop-result.json)。原脚本必须在web_app身份的web容器运行，apply只入队，待现有worker完成后再核对覆盖并继续固定5篇验收；本轮未执行预演或apply。完整开通仍未验收，不登记最终已开通，不增加发版日志。
