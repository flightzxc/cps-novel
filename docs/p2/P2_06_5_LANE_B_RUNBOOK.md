# P2-06.5 Lane B · 畅读标签采样与 CanonicalTag 映射评估

## 当前结论

Lane B 已实现为独立、只读、create-only 的离线流水线，不复用 `CatalogScanTask`，不写数据库，不创建渠道任务，不调用详情或试读接口。唯一网络调用被固定为：

```text
POST https://kocserver-cn.cdreader.com/api/v1/res/getlistpc
body={name:"",orderType:1,pageIndex,pageSize:100,projectType:1}
```

真实 B1 run `2026-08-15-changdu-real-b1-v2` 已完成 240 个唯一页的只读获取，得到 23,998 本候选书和恰好 10,000 本最终样本。该 run 因 6 组请求启动间隔被宿主时钟记录为 999ms，未满足冻结的 `>=1000ms` 合同，故保持 `PARTIAL / TAXONOMY_DISCOVERY_NOT_SATURATED`。B2 仍等待 A/Terra 的版本化 CanonicalTag Final。不要用 fixture、数据库 `SourceLabel` 或 `/tags` 结果冒充真实采样。

## 安全边界

- JWT 只通过 `sample --credential-file <仓库外路径>` 读取；CLI 不接受 JWT 明文参数。
- 凭证文件必须是仓库外的普通文件、非 symlink、Owner-only 权限（Unix `0600`），读取后仅保存在进程内存。
- 日志、错误、preflight、manifest 和产物均不包含 JWT；上游若回显 JWT，采样立即 fail-closed。
- 原始运行目录为 `artifacts/p2-06-5-lane-b/<run-id>/`，已被 git-ignore；原始响应 create-only，不自动删除。
- `raw-api-pages` 会保留整页上游 JSON，其中可能含任务不使用的行级字段；它属于受限审计数据，只能留在 git-ignored 运行目录，不得复制到入库报告或公开附件。
- 派生产物写入 `docs/p2/p2-06-5-lane-b/runs/<run-id>/` 或 Owner 指定的其他入库目录，写入同样拒绝覆盖。
- 不得把未用 retry reserve 转成额外新页，不得自行突破 250 次 HTTP 尝试。

## 预检

在任何真实请求前运行：

```bash
node scripts/p2-06-5-lane-b/cli.mjs preflight \
  --run-id 2026-08-13-owner-approved \
  --channel-app-id <CHANNEL_APP_ID>
```

预检固定输出：历史目录 95,479 行、955 页、240 个计划唯一页、10 次 retry reserve、250 次总尝试、最多约 24,000 个候选行、最终目标 10,000 本、渠道语种上限约 18 种。第一页只刷新 `totalCount`/页宇宙，不增加预算。

Owner 在批准真实采样前应核对：

1. `channel_app_id` 是否绑定本次期望 source scope；
2. JWT 临时文件路径与权限；
3. 240/10/250 请求预算仍被明确批准；
4. 运行主机可保存 git-ignored raw artifact 至 Owner 批准清理。

## B1 真实采样

```bash
node scripts/p2-06-5-lane-b/cli.mjs sample \
  --run-id 2026-08-13-owner-approved \
  --channel-app-id <CHANNEL_APP_ID> \
  --credential-file /secure/outside/repository/moboreader.jwt
```

运行器执行：

- page 1 刷新目录总量；20 个全区间等距页；22 波 × 10 页；
- 每波 6 个最大未采区间中点和 4 个高价值已采页邻页；
- 页面价值固定为 `45% 新 token/书 + 35% 未达配额语种产出 + 20% 样本不足 5 本 token 产出`；
- 并发 1、请求启动间隔至少 1 秒；每页至多一次 retry；
- 401/403、连续两次 429、三个连续终态页失败立即停止；
- 所有 HTTP 尝试（含失败与 retry）都计入 250 上限；
- book identity 为 exact `(channel_app_id, external book JSON identity, raw language scope)`；首次响应为事实，重复只写审计；
- raw language scope 区分 language JSON 类型/值和 languageName 的 missing/null/exact string；`site_locale=null`；
- string token 原样保留，object token 仅 `value/name/label/id` 中恰有一个 string 时提取；其余写结构异常；
- 自动按语种候选量/标签丰富度制定配额，先覆盖所有 token carrier 并尽量补至 5 本，最终最多恰好 10,000 本；预算内不足即 `PARTIAL`。

原始权威层：

```text
raw-api-pages/
source-book-samples.jsonl
source-token-observations.jsonl
source-token-structure-anomalies.jsonl
final-sample-book-keys.jsonl
request-attempts.jsonl
duplicate-books.jsonl
raw-run-manifest.json
```

## B1 派生与验证

```bash
node scripts/p2-06-5-lane-b/cli.mjs analyze \
  --raw-run-dir artifacts/p2-06-5-lane-b/2026-08-13-owner-approved \
  --output-dir docs/p2/p2-06-5-lane-b/runs/2026-08-13-owner-approved \
  --channel-app-id <CHANNEL_APP_ID>

node scripts/p2-06-5-lane-b/cli.mjs verify-raw \
  --raw-run-dir artifacts/p2-06-5-lane-b/2026-08-13-owner-approved

node scripts/p2-06-5-lane-b/cli.mjs verify-b1 \
  --output-dir docs/p2/p2-06-5-lane-b/runs/2026-08-13-owner-approved
```

B1 产物包括 inventory、真实样本 evidence、Jaccard/双向条件共现、candidate/final/per-language 发现曲线、语种分布、逐文件 SHA-256 manifest 与带 Mermaid 图的报告。渠道无完整标签字典分母，因此报告只输出：

```text
TAXONOMY_COVERAGE_RATE=NOT_ESTIMABLE_NO_DENOMINATOR
EMPIRICAL_TOKEN_COVERAGE=<final sample keys / all fetched candidate keys>
```

只有 10,000 本、配额满足/候选不足、最后 3 个全局 1,000-block 稳定、所有 ≥1,000 本语种的最后 500-block 稳定、raw round-trip 与预算 QA 全通过，才可标记 `TAXONOMY_DISCOVERY_SATURATED`。

`verify-raw` 始终是严格 Gate，任何预算 QA 失败都返回非零。为了保留可审计的 PARTIAL B1 事实，`analyze` 仅在 raw semantic round-trip 已通过、raw manifest 已明确标记 `PARTIAL` 且唯一 verifier failure 为 `request-attempts.jsonl:start_interval` 时允许生成派生包。该包必须保留 `requestBudgetQaPassed=false`、`LANE_B_SAMPLE_STATUS=PARTIAL` 和 `TAXONOMY_DISCOVERY_NOT_SATURATED`；B2 不接受这一特例，仍要求 raw verifier 全通过。

## B2：等待 A/Terra CanonicalTag v1

A 输入必须是 JSON，并提供独立 `.sha256` 文件。每个 tag 必须含稳定 ID、slug、display name、locale scope、定义、包含例、排除例与状态；实际文件 bytes 与 SHA 不一致时 B2 阻断。

先生成不含任何猜测 edge 的 evidence template：

```bash
node scripts/p2-06-5-lane-b/cli.mjs b2-template \
  --raw-run-dir artifacts/p2-06-5-lane-b/2026-08-13-owner-approved \
  --channel-app-id <CHANNEL_APP_ID> \
  --output /secure/review/lane-b-source-groups.jsonl
```

离线 reviewer/模型必须读取真实 title、description、同书 token、共现与 CanonicalTag 定义，再为每个 group 显式填写 `proposals[]` 或 unmapped 原因。五项 score 只允许 `0 / 0.25 / 0.5 / 0.75 / 1`，按冻结权重直接加权；不得提交 `0..4` 整数刻度或任意小数。不得通过词面、翻译、embedding 或 LLM 自动批准映射。随后运行：

```bash
node scripts/p2-06-5-lane-b/cli.mjs b2 \
  --canonical /secure/a/canonical-tag-v1.json \
  --canonical-sha256-file /secure/a/canonical-tag-v1.json.sha256 \
  --source-groups /secure/review/lane-b-source-groups-reviewed.jsonl \
  --raw-run-dir artifacts/p2-06-5-lane-b/2026-08-13-owner-approved \
  --channel-app-id <CHANNEL_APP_ID> \
  --semantic-clusters /secure/review/lane-b-semantic-clusters.jsonl \
  --output-dir docs/p2/p2-06-5-lane-b/runs/2026-08-13-owner-approved/b2
```

### B2 JSONL 输入合同

逻辑上的 `reviewed-groups` 输入由当前 CLI 的 `--source-groups` 参数承载；不存在另一个 `--reviewed-groups` CLI alias。最安全的制作方式是逐行编辑 `b2-template` 输出：所有 evidence 字段原样保留，只填写 `proposals`，或在没有 proposal 时填写一个明确的 `unmapped_reason`。下例中的 `<...>` 必须替换为 template 中的原值，尤其不得自行计算或改写 identity/hash：

```jsonl
{"channel_app_id":"changdu-app","raw_language_scope":"<EXACT_RAW_LANGUAGE_SCOPE_FROM_TEMPLATE>","exact_raw_token":"霸总","frequency":3,"occurrence_count":3,"carrier_book_ids":["<BOOK_ID_1>","<BOOK_ID_2>","<BOOK_ID_3>"],"carrier_book_ids_complete":true,"evaluation_sample_count":3,"samples":[{"book_identity":"<BOOK_ID_1>","external_book_id":"<EXTERNAL_ID_1>","external_book_id_raw_json":"<EXACT_JSON>","title":"<TITLE_1>","title_raw_json":"<EXACT_JSON>","description":"<DESCRIPTION_1>","description_present":true,"description_raw_json":"<EXACT_JSON>","cooccurring_exact_tokens":["先婚后爱"]},{"book_identity":"<BOOK_ID_2>","external_book_id":"<EXTERNAL_ID_2>","external_book_id_raw_json":"<EXACT_JSON>","title":"<TITLE_2>","title_raw_json":"<EXACT_JSON>","description":"<DESCRIPTION_2>","description_present":true,"description_raw_json":"<EXACT_JSON>","cooccurring_exact_tokens":[]},{"book_identity":"<BOOK_ID_3>","external_book_id":"<EXTERNAL_ID_3>","external_book_id_raw_json":"<EXACT_JSON>","title":"<TITLE_3>","title_raw_json":"<EXACT_JSON>","description":"<DESCRIPTION_3>","description_present":true,"description_raw_json":"<EXACT_JSON>","cooccurring_exact_tokens":[]}],"cooccurrence":[{"exact_raw_token":"先婚后爱","count":1,"jaccard":0.2,"conditional_probability":0.3333}],"proposals":[{"canonical_tag_id":"ct-dominant-ceo","target_locale":"zh","scores":{"literal_meaning":1,"sample_semantic_evidence":1,"cooccurrence_evidence":0.75,"canonical_definition_fit":1,"filter_semantic_fit":1},"evidence":{"only_lexical":false,"only_translation":false,"polysemous":false,"sample_conflict":false},"reason":"三本真实样本与 CanonicalTag 定义均指向霸道总裁题材。","risk":"NONE_IDENTIFIED"}],"offline_review_instructions":{"proposal_template":{"canonical_tag_id":"","target_locale":"","scores":{"literal_meaning":null,"sample_semantic_evidence":null,"cooccurrence_evidence":null,"canonical_definition_fit":null,"filter_semantic_fit":null},"evidence":{"only_lexical":false,"only_translation":false,"polysemous":false,"sample_conflict":false},"reason":"","risk":""},"permitted_unmapped_reasons":["CANONICAL_GAP","SEMANTIC_UNCERTAIN","LOW_VALUE_SOURCE_TAG","INSUFFICIENT_SAMPLE"],"must_read_real_samples_and_canonical_definition":true},"group_identity":"<GROUP_IDENTITY_FROM_TEMPLATE>","source_evidence_sha256":"<SOURCE_EVIDENCE_SHA256_FROM_TEMPLATE>"}
```

`--source-groups` 字段合同：`channel_app_id + raw_language_scope + exact_raw_token` 是 exact group；频次、完整 carrier IDs、样本、共现、`group_identity`、`source_evidence_sha256` 与 review instructions 都是不可编辑事实。每个 proposal 必须给未 deprecated 的 `canonical_tag_id`、合法 `target_locale`、五个 quarter-scale score、严格 evidence flags，以及非空白 `reason` 和 `risk`；`evidence` 只允许布尔字段 `only_lexical / only_translation / polysemous / sample_conflict`，未知字段或非布尔值会 fail-closed。其中任一标记为 `true` 都会把置信度上限压到 `0.79`。确实没有已知风险时也不得留空，必须写 `"risk":"NONE_IDENTIFIED"`。无 proposal 时 `unmapped_reason` 只能是 `CANONICAL_GAP / SEMANTIC_UNCERTAIN / LOW_VALUE_SOURCE_TAG / INSUFFICIENT_SAMPLE`。

`--semantic-clusters` 是可选的离线判断，一行一个 cluster；成员只能引用本次 source group 的完整 `group_identity`：

```jsonl
{"cluster_id":"offline-zh-dominant-ceo-001","canonical_tag_id":null,"recommendation":"UNDECIDED","confidence":0.75,"review_status":"HUMAN_REVIEW_REQUIRED","reason":"样本显示题材接近，但强势老板可能只是职业设定。","risk":"错误合并会把职业标签误当题材标签。","members":[{"group_identity":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},{"group_identity":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}]}
```

`--semantic-clusters` 字段合同：`cluster_id` 在文件内唯一；cluster 和 member 均为严格 schema，未知字段直接 fail-closed；`members` 至少两个且 FK 不重复；`recommendation` 只能是 `SAME_CANONICAL_TAG / DISTINCT_CANONICAL_TAGS / UNDECIDED`。`canonical_tag_id` 可为 `null`，否则必须引用未 deprecated CanonicalTag。`confidence` 只允许 quarter 刻度，且 `review_status` 必须按 `>=0.95 / >=0.80 / <0.80` 分别为 `HIGH_CONFIDENCE_MAPPING / REVIEW_RECOMMENDED / HUMAN_REVIEW_REQUIRED`；`reason` 和 `risk` 均必须为非空白决策文本，确无已知风险时使用 `NONE_IDENTIFIED`。

第一次 B2 编译产生的 `review-template.jsonl` 只包含尚未闭合的 `REVIEW_RECOMMENDED` group，不包含 `HUMAN_REVIEW_REQUIRED`、`CANONICAL_GAP` 或已闭合项目。独立 reviewer 填完后作为 `--blind-review` 输入；不得添加不在 template 中的 group：

```jsonl
{"canonical_version":"v1.0.0","canonical_sha256":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","group_identity":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","review_round":2,"current_group_status":"REVIEW_RECOMMENDED","decision":"CLOSE_RECOMMENDED","reviewer":"owner-reviewer-2","rationale":"盲化复核的标题、简介和排除例均支持候选。","blind_evidence_reference":"packet-2026-08-13-007"}
```

`--blind-review` 字段合同：canonical version/SHA、`group_identity` 与 `review_round:2` 必须原样绑定 template；`decision` 只能是 `CLOSE_RECOMMENDED` 或 `ESCALATE_HUMAN`；`reviewer`、`rationale`、`blind_evidence_reference` 都必须为非空字符串。`CLOSE_RECOMMENDED` 只表示离线复核闭合，不会把候选提升成 `HIGH_CONFIDENCE_MAPPING`。

B2 会从已通过 raw manifest SHA-256/逐文件校验的运行目录重新计算 authoritative evidence；reviewed JSONL 只允许改变 `proposals` 与 `unmapped_reason`，token、频次、carrier、真实样本或共现等任何事实差异都会 fail-closed。B2 manifest 同时绑定 raw manifest SHA-256 与完整 source-evidence digest。所有 book coverage 以完整 final sample book identity 集合为分母，因此零 token/全结构异常书目也会降低覆盖率。

可选 `--semantic-clusters` JSONL 只能用完整 source-group identity 作成员 FK；`canonical_tag_id` 若存在必须指向未 deprecated 的 CanonicalTag，confidence 同样只允许 quarter 刻度，review status 必须与 `>=0.95 / >=0.80 / <0.80` 阈值一致。其规范化内容摘要写入 B2 result/manifest。

`REVIEW_RECOMMENDED` 必须经过第二次盲化复核；用 `--blind-review` 传入 round-2 JSONL。`CLOSE_RECOMMENDED` 不发明新的 mapping status：group/edge 仍为 `REVIEW_RECOMMENDED`，另记 `review_closed=true` 并从待办包移除；summary 继续统计 recommended，同时单独统计 closed。共享 CanonicalTag 自动派生的 cluster 在所有非 HIGH 成员均闭合时也记 `review_closed=true`，但保留原 confidence/status 分桶供审计。人工包只收未关闭的 recommended/human group、`CANONICAL_GAP`、`SEMANTIC_UNCERTAIN`、fan-out > 3，以及未闭合的 recommended/human semantic cluster；group 以 group identity 去重，cluster 以 cluster id 独立计数。单纯 `LOW_VALUE_SOURCE_TAG` / `INSUFFICIENT_SAMPLE` 留在完整 unmapped 清单，不甩给 Owner。B2 输出包括 mapping/unmapped、语义簇及 pair、fan-out 风险、人工包、summary 与逐文件 SHA-256 manifest；只产生候选，不写正式 mapping、不修改 CanonicalTag、不提供线上 fuzzy fallback。

## 当前 Gate 状态

```text
LANE_B_SAMPLE_STATUS=PARTIAL
LANE_B_MAPPING_STATUS=COMPLETE_OFFLINE_CANDIDATES_GENERATED
SOURCE_TAXONOMY_DISCOVERY_STATUS=TAXONOMY_DISCOVERY_NOT_SATURATED
OWNER_REVIEW_ITEMS=0
```

B1 保留 `PARTIAL`；Owner Final 仅对 run `2026-08-15-changdu-real-b1-v2` 的六次 999ms start interval 作单次 waiver。B2 已对 CanonicalTag v1 Final 123 生成离线候选，不写生产 mapping。

## Owner Final B2（单次 waiver 路径）

该命令必须显式传入版本化 waiver；它不会改变 `verify-raw` 的全局 ≥1000ms 合同：

```bash
node scripts/p2-06-5-lane-b/cli.mjs b2-finalize \
  --canonical docs/p2/p2-06-5-lane-a/canonical-tag-v1-final/2026-08-16/canonical-tag-v1.0.0-final.json \
  --canonical-sha256-file docs/p2/p2-06-5-lane-a/canonical-tag-v1-final/2026-08-16/canonical-tag-v1.0.0-final.json.sha256 \
  --cross-review-matrix docs/p2/p2-06-5-owner-final/2026-08-16/evidence/CROSS_REVIEW_MATRIX.csv \
  --owner-waiver docs/p2/p2-06-5-owner-final/2026-08-16/OWNER_TIMING_WAIVER.json \
  --raw-run-dir artifacts/p2-06-5-lane-b/2026-08-15-changdu-real-b1-v2 \
  --channel-app-id changdu-app \
  --output-dir docs/p2/p2-06-5-lane-b/b2-owner-final/2026-08-16

node scripts/p2-06-5-lane-b/cli.mjs verify-b2-final \
  --output-dir docs/p2/p2-06-5-lane-b/b2-owner-final/2026-08-16
```

`mapping-candidates-final.csv` 的 198 行由 196 个 `MAPPING_EDGE` 和 2 个 `COMPOUND_GROUP_SUMMARY` 组成。后者不是 executable edge，Canonical FK 字段为空；所有非空 target 均 FK 到 Final 123。
