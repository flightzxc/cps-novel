# 53 本 MoboReader 重领：独立 ops 脚本与执行约定

当前：v0.6.5部署技术验收已通过；甲阶段原mine_identity_mismatch经主控查实为定位规则问题。仅在ops分支修正，待本次主控复核通过后从captureBaseline重启甲阶段。金丝雀继续暂停，余48本仍须Owner“批准重领”。本轮不连接生产、不提交领码；失败书不重试。

发布Final固定为 `b378910a8ec4b78029e71ad1bac92c742efb9f5b`。ops分支 `ops/promo-reclaim-53-2026-10-20` 从Final切出，仅留档不合入集成/发布镜像。脚本源与门禁结果在完成后记录于本页。

## 复用与身份

`validatePromoAccountConfiguration`逐字抄自基线58cdb94d的 `src/app/(admin)/catalog-sync/_actions.ts:477-496`，有逐行对照。只保留原绑定检查、原 `resolveClaimCredentialAdmission` 调用和原临期提示；通过原 `enqueueCatalogBatch` 的事务钩子运行。enabled、临期审计与按钮一致。Owner明确授权用批准重领、确认短语、清单摘要和显式actor替代浏览器会话与两步验证。

所有命令只用web容器原生web_app连接，不接受连接覆盖参数；production必须cwd=/app、metadata版本0.6.5与Final一致。actor显式固定为10-15相同的 `71f0e655-0640-4f07-bcbb-041f027fa7cb`，并核对username=admin、role=super_admin、status=active。账户取近期同一管理员后台领码批次中MoboReader的账户，冻结入甲阶段快照、清单并输出核对；不猜选账户。权限不足立即停，不改grants或切换角色。

## 甲阶段与命令

先部署验收，再以证据中的phase-a-capture包装器执行只读快照。附录C历史查询限定MoboReader app `85c2fb3e-28f8-476a-83f2-9647e2206192`，53个前缀必须与附录B逐项一致。逐本检查linked/novel关联、无带码链接、无在途领码条目、无任何意图；Contract不在范围。冻结完整53 ID、金丝雀5 ID、剩余48 ID摘要、actor/账户以及635条PlotNovel人工复核记录摘要。

金丝雀固定为下表五本。目录同步先选剧场MoboReader，再选对应语种并按书名搜索、核对ID后勾选；按主控查实，在英语下搜MINE只会出现目标这一本。运营须按完整ID核对，避免同名OBSESSION；如要更换，停下更新甲阶段基线并交Owner裁定。运营提交后Codex只读验收；MINE必须already_available、有码有网址、意图数0。其余成功书检查有码有网址，失败列原因；无未决意图/转人工。回报后停等“批准重领”。



| 书名 | 剧场 | 语种筛选 / source_locale / 上游语言码 | 书目行ID或待甲阶段冻结的前缀 |
| --- | --- | --- | --- |
| MINE（原始标题末尾有一个空格） | MoboReader | 英语 / en / 3 | c838c281-c9ba-482a-aa80-05792e8fdc4a |
| Fran | MoboReader | 英语 / en / 3 | 17f20eb7 |
| SOLD | MoboReader | 英语 / en / 3 | 49e254d4 |
| Obsession | MoboReader | 法语 / fr / 6 | 4265a05f |
| Heart | MoboReader | 英语 / en / 3 | 191da4c8 |

不要选印尼语MINE（63172440-a1bb-4df2-a920-75f1a7b40a44），也不要选英语OBSESSION（50cdc502）。筛选、排序、翻页会清空勾选；切换语种时不能假定此前勾选仍在，提交前核对实际勾选与批次范围。当前表仅供定位核对，运营不得开始金丝雀；须主控复核通过、重新完成甲阶段后再按确认的五本执行。其余四本语种依据方案附录B与现有语言映射（3=en，6=fr），本轮未查询生产。

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

保留permission-stop.json作为历史。薄脚本不读novel_source_item.raw_payload，不预检agencyId/seriesId/language；原三项定位规则已被下述主控裁定替代：MoboReader剧场、书名trim后严格等于MINE、source_locale=en、附录B前缀c838c281四项同时满足且恰好1行。身份字段由原worker在调用上游前校验，缺失时claim_source_fields_missing。主控已用postgres只读事务查实目标c838c281-c9ba-482a-aa80-05792e8fdc4a对应seriesId=131539322，本轮引用该证据，不重复查询；这项身份数据不进入脚本提交路径。旧phase-a-identity-readonly.sql.txt是历史模板，MINE部分已被主控查实结论替代，不再运行。side_effect_intent的所需列在当前grants已授权web_app；真实web_app冒烟验证，禁止扩大权限或换运行角色。

本地首次完整门禁：tsc0、lint0error/16既有warning、真实web_app CLI冒烟14/14通过，skipped0、无Unhandled、42501/permission_denied_stop0；54行书目payload形态断言通过。包含精确MINE定位、无raw_payload读取、外来根领码任务在重放/status时拒绝。两组变异与最终收据随后补齐。

## 第一阶段脚本交付

代码提交 `9e8e2ee7586adec48436ca30596f62f1e245f57e`，脚本SHA256 `64bff7823aca3229421aa01e9b5dd89d7aa30faffc2e28e5a6b157f90bbdfd3e`。原校验函数20行逐字一致；[逐行对照](evidence/promo-reclaim-53-2026-10-20/account-validation-lines.txt)。真实web_app冒烟14/14、无跳过/Unhandled/42501，54行payload形态断言通过。两组变异均行为变红后还原、git diff --quiet，最终完整冒烟再14/14通过。tsc0、lint0error/16既有warning；治理提交后再做提交后检查与GitHub回读。

[原始结论](evidence/promo-reclaim-53-2026-10-20/summary.txt)、[门禁收据](evidence/promo-reclaim-53-2026-10-20/gates.json)、[变异](evidence/promo-reclaim-53-2026-10-20/mutations.json)、[夹具修正](evidence/promo-reclaim-53-2026-10-20/fixture-repair.json)、[权限修正](evidence/promo-reclaim-53-2026-10-20/permission-repair.json)。历史权限停点原样保留；原始失败日志保存在本地.tmp/promo-reclaim-53，不混作当前结果。此为第一阶段交付时的历史状态，后续部署与原甲阶段停点由release分支归档。本次ops修正仍须主控重新复核。

## MINE定位修正与复核边界（2026-10-20）

主控裁定：原STOP符合旧规则，但目标实际标题是`"MINE "`、source_locale=en、external_book_id=1274862844；另一本精确标题`"MINE"`为印尼语、ID63172440-a1bb-4df2-a920-75f1a7b40a44、external_book_id=5531080、seriesId=2946414。目标与seriesId=131539322对应关系由主控只读SQL查实，本会话不再连接生产核对。

脚本仅调整MINE定位：SQL仅预选MoboReader内含MINE的标题（不分页、不截断），再同时严格检查trim后的标题、英语locale与附录B前缀，恰好一行并且属于53本范围才通过。无raw_payload读取；账户校验逐字复制部分、提交函数、状态机、grants和运行角色不变。发布分支与已部署Final不动。

真实库夹具复用原辅助函数，并按主控提供的两本MINE完整身份构造同剧场重名；另以同前缀跨语种、同语种跨前缀干扰行验证两个约束独立必要，四条件多行也拒绝。要求trim退回精确比较的变异必须红，恢复后git diff --quiet；locale与prefix删除也以真实数据行为验证歧义停手。门禁及diff见本次mine-location-fix证据。本次推送供主控复核，未获复核通过前不重启生产captureBaseline，不执行金丝雀。

本次代码提交`c1ca68182ff598d38bf285a52a6996e04ce6d7c7`，脚本SHA256 `08cc8d899f3103f772a07c0fa52c0c4137f3f3539efb5402ff6d2bf0d6404a15`。tsc0、lint0error/16既有warning；真实web_app冒烟及还原后完整冒烟均18/18，skipped0/无Unhandled/42501；trim、locale、prefix三种变异均红后还原并git diff --quiet。现有拒绝码、临期审计、plan→submit→status和635条基线守卫均通过，字典drift0。主控复核材料：[核心diff](evidence/promo-reclaim-53-2026-10-20/mine-location-fix/script-diff.txt)、[完整diff](evidence/promo-reclaim-53-2026-10-20/mine-location-fix/review-diff.txt)、[结论行](evidence/promo-reclaim-53-2026-10-20/mine-location-fix/summary.txt)、[复核包](evidence/promo-reclaim-53-2026-10-20/mine-location-fix/controller-review.txt)。本轮未连接生产，待主控复核通过后才从captureBaseline重启甲阶段。
