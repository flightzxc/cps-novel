# 53 本 MoboReader 重领：独立 ops 脚本与执行约定

当前：Owner批准剩余48本后已提交并核对PASS，48本均already_available；先前4本及MINE最终只读复核不变。53 = 1 + 4 + 48，53本有码有网址、意图上限均0、失败0，生产执行及发版治理均完成。旧停点/等待批准段保留作历史。

发布Final固定为 `b378910a8ec4b78029e71ad1bac92c742efb9f5b`。ops分支 `ops/promo-reclaim-53-2026-10-20` 从Final切出，仅留档不合入集成/发布镜像。脚本源与门禁结果在完成后记录于本页。

## 复用与身份

`validatePromoAccountConfiguration`逐字抄自基线58cdb94d的 `src/app/(admin)/catalog-sync/_actions.ts:477-496`，有逐行对照。只保留原绑定检查、原 `resolveClaimCredentialAdmission` 调用和原临期提示；通过原 `enqueueCatalogBatch` 的事务钩子运行。enabled、临期审计与按钮一致。Owner明确授权用批准重领、确认短语、清单摘要和显式actor替代浏览器会话与两步验证。

所有命令只用web容器原生web_app连接，不接受连接覆盖参数；production必须cwd=/app、metadata版本0.6.5与Final一致。actor显式固定为10-15相同的 `71f0e655-0640-4f07-bcbb-041f027fa7cb`，并核对username=admin、role=super_admin、status=active。账户取近期同一管理员后台领码批次中MoboReader的账户，冻结入甲阶段快照、清单并输出核对；不猜选账户。权限不足立即停，不改grants或切换角色。

## 甲阶段与命令

先部署验收，再以证据中的phase-a-capture包装器执行只读快照。附录C历史查询限定MoboReader app `85c2fb3e-28f8-476a-83f2-9647e2206192`，53个前缀必须与附录B逐项一致。逐本检查linked/novel关联、无带码链接、无在途领码条目、无任何意图；Contract不在范围。冻结完整53 ID、金丝雀5 ID、剩余48 ID摘要、actor/账户以及635条PlotNovel人工复核记录摘要。

金丝雀固定为MINE(c838c281)、Fran(17f20eb7)、SOLD(49e254d4)、Obsession(4265a05f，语种6)、Heart(191da4c8)。运营须按完整ID核对，避免同名OBSESSION；如要更换，停下更新甲阶段基线并交Owner裁定。运营提交后Codex只读验收；MINE必须already_available、有码有网址、意图数0。其余成功书检查有码有网址，失败列原因；无未决意图/转人工。回报后停等“批准重领”。

三个命令均显式 `--actor-id <上述ID>`，生产在 `/app` 用容器自带 `tsx --tsconfig /app/tsconfig.json /tmp/promo-reclaim-53.ts` 执行：

- `plan --baseline <甲快照> --baseline-sha256 <甲快照字节sha> --output <新清单>`：只读数据库，保留53范围，排除冻结5本，验证其余48仍符合四条件及635摘要，清单0600且禁止覆盖；输出48 ID摘要与整文件sha。48 ID摘要必须与甲阶段一致。
- `submit --manifest <文件> --manifest-sha256 <整文件sha> --confirm PROMO_RECLAIM_48`：精确ID模式，一批48本，固定requestId `promo-reclaim-53-2026-10-20`。摘要/范围/确认失败均拒绝。重放始终提交原48输入，由原服务返回已有批次；不缩清单、不另建失败重试或补领批次。
- `status --manifest <文件>`：只读进度、分类和安全失败码，推广码和网址仅报告是否存在；意图仅输出数量/未决状态。处理中prepared可观察，终态仍未决/任何转人工立即停。

## 窗口取证与停手

金丝雀与48本各自设独立UTC起止窗口；请Owner和运营窗口期间不要提交任何其它领码批次。开始前和结束后各查一次，须无其它在途 `promo_link.claim.*` 和领码枚举批次；保存只读快照时间与ID。窗口结束以所有本轮条目终态为前提。

每本只报告“按意图记录推定的每本 getcode 上限”，取该书领码意图记录数，要求≤1，MINE=0；这不是实际HTTP次数。窗口内日志getcode事件总数必须与同期新增领码意图总数相等；新增意图必须全部属于该窗口固定书目。getvideoinfo只报告窗口总调用数。宿主机仅采集脱敏upstream_call事件并按相同半开时间区间计数，不推断并发事件逐本归属。window-counts包装器只在窗口闭合后交叉核对。

任一本意图>1、窗口getcode/新增意图不等、范围不符、429/熔断、permission denied、终态遗留意图或转人工立即停；不自行修复、不重试。每个窗口后核对635条PlotNovel人工复核ID/status/response_shape摘要不变；不输出response_shape内容。

## 门禁与待办

需要真实web_app冒烟plan→submit→status、原绑定/凭据错误码一致性、临期审计、精确范围/摘要/actor/确认守卫及重放。两组变异分别删除已有带码排除、删除绑定检查，必须变红后还原干净。完成后附ops HEAD、脚本sha、逐行对照、原始门禁结论。主控复核前禁止送生产执行。

## Owner权限裁定（2026-10-20）

保留permission-stop.json作为历史。薄脚本不读novel_source_item.raw_payload，不预检agencyId/seriesId/language；MINE只按MoboReader剧场、精确标题MINE、附录B前缀c838c281三项同时匹配且恰好1行。身份字段由原worker在调用上游前校验，缺失时claim_source_fields_missing。生产seriesId等额外核对从postgres容器psql，以PGOPTIONS默认只读并显式BEGIN READ ONLY单独取证，不进入清单或提交路径。side_effect_intent的所需列在当前grants已授权web_app；真实web_app冒烟验证，禁止扩大权限或换运行角色。

本地首次完整门禁：tsc0、lint0error/16既有warning、真实web_app CLI冒烟14/14通过，skipped0、无Unhandled、42501/permission_denied_stop0；54行书目payload形态断言通过。包含精确MINE定位、无raw_payload读取、外来根领码任务在重放/status时拒绝。两组变异与最终收据随后补齐。

## 第一阶段脚本交付

代码提交 `9e8e2ee7586adec48436ca30596f62f1e245f57e`，脚本SHA256 `64bff7823aca3229421aa01e9b5dd89d7aa30faffc2e28e5a6b157f90bbdfd3e`。原校验函数20行逐字一致；[逐行对照](evidence/promo-reclaim-53-2026-10-20/account-validation-lines.txt)。真实web_app冒烟14/14、无跳过/Unhandled/42501，54行payload形态断言通过。两组变异均行为变红后还原、git diff --quiet，最终完整冒烟再14/14通过。tsc0、lint0error/16既有warning；治理提交后再做提交后检查与GitHub回读。

[原始结论](evidence/promo-reclaim-53-2026-10-20/summary.txt)、[门禁收据](evidence/promo-reclaim-53-2026-10-20/gates.json)、[变异](evidence/promo-reclaim-53-2026-10-20/mutations.json)、[夹具修正](evidence/promo-reclaim-53-2026-10-20/fixture-repair.json)、[权限修正](evidence/promo-reclaim-53-2026-10-20/permission-repair.json)。历史权限停点原样保留；原始失败日志保存在本地.tmp/promo-reclaim-53，不混作当前结果。这是第一阶段交付时的历史状态；Owner随后确认主控已审核，生产甲阶段实际停点见下文。

最终ops分支HEAD `786ec4ae270c4a5e3585ebe2f376116e6f2d3981` 已推送GitHub并回读一致；提交后tsc/lint通过，脚本SHA仍 `64bff7823aca3229421aa01e9b5dd89d7aa30faffc2e28e5a6b157f90bbdfd3e`。最终归档镜像内原生tsx/模块加载验证通过（network=none、无数据库访问）；收据见本目录证据中的github-push.json、post-governance.json及image-entry.json。主控复核仍待完成。

## 甲阶段实际停点

2026-10-20 JST：审核过的脚本SHA256不变，以容器原生用户和web_app执行。复制包装器的0600文件权限错误自修为0644后，函数返回`mine_identity_mismatch`并退出64；原始记录保留。没有数据库42501，没有换角色/改grants，没有调用任何提交函数或上游。严格条件未放宽。生产53本/5本/48本、账户和635条摘要均未冻结，不可进行运营金丝雀；须Owner/主控裁定后继续只读诊断。详见[发布及停点证据](evidence/v065-release/phase2/phase2-result.json)。

## 甲阶段重新核对通过

主控复核通过ops@700e01cc，脚本SHA256 `08cc8d899f3103f772a07c0fa52c0c4137f3f3539efb5402ff6d2bf0d6404a15`；原生web_app只读captureBaseline通过53/53，附录B书名/语种一致，四项前提全部满足，Contract排除，MINE英语尾空格目标唯一。基线/48ID摘要、actor/运营账户及635条PlotNovel摘要均已冻结。详见[甲阶段交接](evidence/v065-release/phase-a-700e01cc/operator-canary-handoff.md)及[结果](evidence/v065-release/phase-a-700e01cc/phase-a-result.json)。当前停下交运营；不提交领码、不创建48本submit清单。原STOP段为历史，seriesId引用主控查实，不重查raw_payload。

## 2026-10-21 金丝雀提交前 STOP

Owner将5本改为Codex提交，主控复核ops@e991694a（tsc0、28/28、无42501）后要求执行。新鲜只读核对无其它领码在途，但MINE c838c281已存在带码链接，createdAt=2026-10-21T01:27:16.927Z、fetched/upstream_existing；与冻结甲阶段的无带码链接条件不同。其余4本前提通过。按原审核脚本不得绕过已有带码排除，因此没有调用submit-canary，没有拆4本，没有删除链接或改基线。canary requestId下task=null，5本均not_submitted；不能将现有链接记作本次already_available。

本轮只读观测UTC01:53:00.827–01:54:00.062，独占提交窗口未开启；5本意图上限均0、MINE0，635条摘要不变，web_app无42501。已有链接写入来源尚未查明。没有窗口HTTP总数或服务错误验收结论，不能登记金丝雀PASS。详见[停点证据](evidence/v065-release/canary-2026-10-21/README.md)与[结论行](evidence/v065-release/canary-2026-10-21/summary.txt)。等待Owner/主控裁定后再继续，余48另待“批准重领”。历史运营说明已由Owner改授权覆盖，旧证据保留。tag/生成CHANGELOG/唯一发版日志/Notion仍待重领结果明确后收官。

## 当前：四本金丝雀 PASS，等待48本另行批准（2026-10-21）

Owner转达主控复核ops@94dec9dd及SHA256通过后，本轮只提交其余4本一次。原baseline原字节与48范围不变。requestId=promo-reclaim-53-2026-10-20-canary，批次`0dcc1e9d-5900-4987-b686-3210b66f4602`；四本均already_available、有推广码及网址、意图上限0，MINE仍单列resolved_by_catalog_scan且未提交。53 = 1 + 4 + 48。

UTC窗口2026-10-21T07:43:06.640Z–2026-10-21T07:47:02.480Z（JST2026-10-21T16:43:06.640+09:00–2026-10-21T16:47:02.480+09:00）：getcode窗口总调用数0=getcode新增意图0，getvideoinfo窗口总调用数4。前后无其它领码/目录扫描在途，六服务error/permission denied0，未决/转人工/429/熔断0，635条摘要不变。没有重放或失败重试，没有48本plan/submit。独占窗口关闭，停止等待Owner另说“批准重领”。[本轮结果](evidence/v065-release/canary-four-94dec9dd/README.md)及[原始结论](evidence/v065-release/canary-four-94dec9dd/summary.txt)。早前五本运营说明及d9a124e8停点为保留历史，当前按本节口径。

## 最终：53本恢复 PASS（2026-10-21）

Owner“批准剩下48本”后重新plan及清单sha核对，通过原生web_app原路径提交一次；批次`4ab3f194-e194-47ba-b9a4-c0c4a55b181e`，48本全部already_available、有码有网址、失败0。先前4本最终仍already_available，MINE为resolved_by_catalog_scan未重提。53 = 1 + 4 + 48，53本全部码/网址就绪，按意图记录推定的每本getcode上限均0。

48本独占窗口UTC 2026-10-21T07:59:28.822Z–2026-10-21T08:03:42.242Z（JST 2026-10-21T16:59:28.822+09:00–2026-10-21T17:03:42.242+09:00），getcode窗口总调用数0=新增意图0，getvideoinfo窗口总调用数48。起止无其它领码/目录扫描在途，未决/转人工/429/熔断0，六服务error/permission denied0，635条摘要最终不变；没有重放、失败重试或补领。原baseline/48摘要及工件不变。[最终证据](evidence/v065-release/remaining48-94dec9dd/README.md)及[53本逐项结果](evidence/v065-release/remaining48-94dec9dd/books53.json)。生产执行已结束，后续只补齐发版治理。

最终治理收据：annotated v0.6.5固定原Final、生成CHANGELOG、台账、唯一日志及Notion四处同步回读全部PASS；原历史3910行保持。见[治理总收据](evidence/v065-release/closure/governance.json)。生产执行已停止，不再补领或重试。
