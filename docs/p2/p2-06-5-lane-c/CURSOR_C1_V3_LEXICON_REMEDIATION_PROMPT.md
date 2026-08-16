# P2-06.5 Lane C · C1 v3 词典修复执行提示词（交付 Cursor）

> 本文件是给执行方的**唯一任务书**。已按真实产物核对过，纠正了三处与数据不符的前提。
> 执行完成后交回复核。`AUTO_WRITE_AUTHORIZED=NO`。

---

## 〇、这一轮在做什么

上一轮独立盲审（400 本 / 653 条边）已经证明：**问题不在"简介权重该不该等于标题"这个参数，而在少数关键词种子本身是错的。**

无偏总体精度 51.4%；剔除已备案的 he/be 缺陷后 64.7%。误报归因里 `GENERIC_KEYWORD` + `MULTIPLE_MEANING` 占全部误报的 64%。

所以这一轮只做一件事：**修关键词证据，然后用固定参数重跑一次，看精度是否如预期抬升。**

### 不得重开的议题

CanonicalTag 分类体系、B1、B2、标题/简介全局权重方案、C2 章节证据、生产库写入。

这些都已定案或已冻结，本轮一律不碰。

---

## 一、权威输入（哈希必须逐字校验，不符即中止）

| 产物 | 路径（相对仓库根） | SHA-256 |
| --- | --- | --- |
| 标签词典 | `docs/p2/p2-06-5-lane-a/canonical-tag-v1-final/2026-08-16/canonical-tag-v1.0.0-final.json` | `8bc8cdae8be2176bde170173e98bad2b9fa0e1770818174a57320816eefdccad` |
| C1 输入 | `artifacts/p2-06-5-lane-c/2026-08-16-owner-final-c1-v2/c1-input.jsonl` | `046fe9234b317eba145c3fbb35edd2e72af49e41309dcd5d5f45f7bc43d1776d` |

仓库根：`/Users/chenweifeng/Documents/cps海阅/p2-06-main-merge`（分支 `main`）。
**注意**：`产品原型及文档/cps海阅` 下有同名目录，不是这个。

样本 10,000 本、盲审结果分别在：

- `artifacts/p2-06-5-lane-c/2026-08-16-owner-final-c1-v2/`（v2 权威运行，只读）
- `docs/p2/p2-06-5-lane-c/reviews/2026-08-16-description-only-blind-review/`（样本包）
- `docs/p2/p2-06-5-lane-c/reviews/2026-08-16-description-only-blind-review-results/`（653 条判定）

---

## 二、⚠️ 三处必须先知道的事实（与初版方案不同）

初版方案在这三点上与真实数据不符，照初版做会改错。

### 事实 1 — 结局标签移除 he/be 后会在 description 上彻底失效

实际种子：

```
ct-v1-happy-ending   keyword_seeds = ['圆满结局', 'he', 'HE']
ct-v1-tragic-ending  keyword_seeds = ['悲剧结局', 'be', 'BE']
```

**词典里不存在** `happy ending` / `lived happily ever after` / `tragic ending` 这类 phrase 种子。

且在 4554 条候选边中：`happy-ending` 的 642 条**全部**由 `he` 触发，`tragic-ending` 的 321 条**全部**由 `be` 触发；中文种子 `圆满结局` / `悲剧结局` 在 description 上**零命中**。

**后果**：移除 he/be 后，这两个标签的 description 独立触发能力归零（全语种）。

**这是预期结果，不是缺陷**，必须在报告中显式写明，不得为了"保住覆盖"而私自新增种子。本轮**禁止**凭空生成新的结局类翻译词。

### 事实 2 — chef 的问题语种不是德语

全池 `chef` 命中 72 条，分布：

| 语种 | 条数 |
| --- | ---: |
| 法语 | 40 |
| 西语 | 15 |
| 葡语 | 9 |
| 英语 | 4 |
| 菲律宾语 | 2 |
| **德语** | **1** |

只做 DE 规则，修掉 1 条，剩下 71 条不动。德语 `Chef`＝老板确实成立（盲审实证），但**量在法语/西语/葡语**——法语 `chef` 同样主要是"头目/上司"义（`chef d'entreprise`）。

### 事实 3 — luna 的问题语种是西语，不是 ES/PT

盲审按语种拆：

| 语种 | SUPPORTED | UNSUPPORTED | UNCERTAIN |
| --- | ---: | ---: | ---: |
| 法语 | **4** | 2 | 0 |
| 西语 | 0 | **4** | 2 |
| 葡语 | 0 | 1 | 0 |
| 印尼 | 1 | 0 | 0 |
| 英语 | 1 | 0 | 0 |

**法语表现良好**。语言学原因：法语的"月亮"是 `lune`、葡语是 `lua`，只有**西班牙语和意大利语**的 `luna` 就是日常"月亮"一词。所以"luna＝月亮所以要禁"这个理由**只对西语/意语成立**，对法语和葡语不成立。

葡语那 1 条 UNSUPPORTED 的归因是 `PAST_OR_BACKSTORY`（Luna 是男主已故伴侣），属于真实 Luna 角色但在背景故事里——**不是同形词碰撞**，不能用同一条规则处理。

---

## 三、修复分级（按证据强度，不得越级）

### A 级 · 证据充分，本轮必须修

| 标签 | 处置 | 盲审证据 | 池内规模 |
| --- | --- | --- | ---: |
| `ct-v1-happy-ending` | 种子 `he`/`HE` 全字段停用 | 138 条边中 133 条 UNSUPPORTED（1.4% 精度）；2 条 SUPPORTED 经查证是简介另有明写结局，与 `he` 无关 | 642 |
| `ct-v1-tragic-ending` | 种子 `be`/`BE` 全字段停用 | 同上批次 | 321 |
| `ct-v1-horror` | 单词种子 `horror` / `Horreur` / `공포` / `恐怖` **description 停用**，title 保留 | n=22，86.4% UNSUPPORTED；命中的是"恐惧"情绪词与比喻（"the real horror began"） | 118 |
| `ct-v1-family` | 单词种子 `family` / `Family` / `家庭` **description 停用**，title 保留 | n=46，76.1% UNSUPPORTED；`family ties`、`the Parks family`（姓氏） | 296 |
| `ct-v1-doctor` | 单词种子 `doctor` / `Doctor` / `医生` **description 停用**，title 保留 | n=12，83.3% UNSUPPORTED；产检、告知病情、作者生平提及 | 47 |

**title 一律保留不动**：本轮盲审只覆盖 description-only 边，对 title 精度**零证据**。无证据即不改，这是纪律。

### B 级 · 证据薄弱，按 locale 精确处置并标注低置信

| 标签 | 处置 | 证据量 | 说明 |
| --- | --- | ---: | --- |
| `ct-v1-chef` | `chef` 在 **de / fr / es / pt** locale 的 description 停用；en 保留 | 全池 72 条，盲审仅 8 条 | 德语实证＝老板；法语同义项同样强势且占 40 条 |
| `ct-v1-werewolf-luna` | `luna` 在 **es / it** locale 的 description 停用；fr / pt / en / id 保留 | 全池 94 条，盲审仅 18 条 | 只有西语/意语的 luna＝日常月亮；法语实证为 4:2 正向 |

B 级合计只贡献约 **1.1 个百分点**精度（见第六节），但会影响 166 条边。必须在 `change_reason` 里标注 `LOW_EVIDENCE_LOCALE_RULE`，供 Owner 在最终冻结时单独决定是否保留。

### 不得触碰 · 高精度对照组

以下标签盲审表现优异，**任何修改都不得波及**，并须在产出中逐一验证其边数无异常塌陷：

| 标签 | 盲审 SUPPORTED | 池内边数 |
| --- | ---: | ---: |
| `ct-v1-time-travel` | 100% | 479 |
| `ct-v1-werewolf-alpha` | 100% | 118 |
| `ct-v1-rebirth` | 95.7% | 259 |
| `ct-v1-wealthy-ceo` | 91.7% | 143 |
| `ct-v1-romance` | 91.3% | 125 |
| `ct-v1-mafia` | 88.9% | 68 |
| `ct-v1-revenge` | 83.3% | 76 |

**严禁**为了拉高整体精度而对 description 做全局降权——那正是上一轮证明不该做的事。

---

## 四、实现方式（关键：不许动 CanonicalTag）

关键词词典是**派生**产物：`scripts/p2-06-5-lane-c/owner-final-c1.mjs` 里的 `buildLexicon(canonical)` 从 `canonical.keyword_seeds` 生成 `taxonomy-keywords.json`。

**CanonicalTag v1 Final 的哈希 `8bc8cdae…` 已冻结，绝对不能改。**

因此修复必须走**独立的覆盖层**：

1. 新增一份受版本管理的覆盖产物，例如
   `docs/p2/p2-06-5-lane-c/lexicon-overrides/2026-08-16/keyword-eligibility-v1.json`，
   自带 `version` 与 `sha256`，在 `buildLexicon` 阶段套用。
2. 复用**已存在**的停用机制：`keyword-seed-audit.json` 已经有 `disabled[]` 结构与 `reason` 字段
   （现有取值如 `KEYWORD_COVERAGE_INSUFFICIENT_OTHER_SCRIPT`，本轮停用了 6 个种子）。
   新增理由取值即可，不要另造一套并行机制。
3. 覆盖层的 sha256 必须进入 v3 的 `lane-c-run-manifest.json` 与 `C1_MANIFEST.json` 血缘块。

### 最小 schema 扩展

只加真实证据要求的两项能力：

```
keyword:
  value
  language_scope:  [locale, ...] | "*"     # 允许命中的语种
  allowed_fields:  [title, description]     # 允许命中的字段
  enabled:         true | false
```

字段名不必与上面完全一致，但必须支持：

- 同一关键词 **title 允许、description 禁止**
- 同一关键词 **en 允许、de 禁止**

**禁止**引入：per-tag 权重、per-keyword 分数、ML 模型、embedding、正则 DSL 框架、语义解析器、多层继承。

语种作用域以现有 `rawLanguageScope` 为准。**不得**擅自解决 `LANGUAGE_19` / `LANGUAGE_20` 的 locale 身份，保持 `RAW_SCOPE_ONLY`；本轮不猜。

---

## 五、C1 v3 运行

用修复后的词典重跑同一批 **10,000 本**，参数固定：

```
titleWeight=30  descriptionWeight=30  chapterWeight=0  threshold=30  maxTextTags=3
```

**只跑这一组**。不再跑 9 组配置，不做 A/B/C 参数搜索。本轮只验证"修词典后的方案 C"。

运行标识建议 `2026-08-16-owner-final-c1-v3`，走既有的空目录断言 + 暂存目录 + 仅新建写入 + 重命名落盘，产出目录不可覆盖既有运行。

### 必须输出

指标：`text_hit_rate`、`zero_hit_rate`、`description_only_rate`、`title_only_rate`、`both_rate`、`avg_text_tags`、`p50/p90/p99`、`mapped_count`、`text_supplement_count`、`union_count`、`source_blind_text_hit_rate`、`source_blind_zero_hit_rate`。

前后对比（v2 的 C/3 对 v3）：`removed_candidate_edges`、`removed_description_edges`、`affected_novel_count`、`coverage_delta`。

**覆盖率下降本身不算回归。** 本轮的目标就是用更少但更可信的标签，替换掉高覆盖低精度。

`tag-level-before-after.csv`，至少含：
`canonical_tag, v2_description_edges, v3_description_edges, removed_edges, v2_review_precision_if_available, change_reason`

按语种的前后对比，重点覆盖：英语、raw19、raw20、法语、西语、葡语、德语、韩语。

---

## 六、验收靶子（可先自查，无需等人工评审）

已有的 653 条盲审判定可以直接预测 v3 精度——**存活边的判定是已知的**。按修复范围逐级预测（总体分层层，无偏口径）：

| 修复范围 | 存活边 | 预测精度 |
| --- | ---: | ---: |
| v2 现状 | 491 | 51.9% |
| 仅移 he/be | 391 | 64.7% |
| + horror | 377 | 66.3% |
| + family | 344 | 70.6% |
| **+ doctor（A 级全做完）** | **335** | **72.2%** |
| + chef/luna（B 级）| 330 | 73.3% |

**验收要求**：跑完 v3 后，把 v3 存活边与这 653 条判定做交集，重算精度。
若实测与上表偏差超过 ±2 个百分点，说明修复范围与预期不符，需排查后再交付。

### 规模预期

| 口径 | 数值 |
| --- | ---: |
| v2 description-only 边 | 4554 |
| A 级预计移除（he/be 963 + horror 118 + family 296 + doctor 47） | ≈1424（31.3%） |
| B 级预计再移除 | ≈166 |
| **v3 description-only 边预计** | **≈3000–3130** |

英语的 description-only 信号会大幅缩减（he/be/family 大多集中在英语），属预期，如实报告即可。

---

## 七、修复后盲审包（约 200 本）

从 v3 的 description-only 边重新抽样，**150 总体比例分层 + 50 风险层**。

风险层继续覆盖：generic keyword、multiple meaning、role only、长简介单次命中、多标签、locale 碰撞。

评审包必须保持盲审。**不得提供**：上游分类词、来源映射、B2 结果、上一轮判定、change_reason、缺陷标签。
**只提供**：`title`、`description`、提议的 CanonicalTag（稳定 ID / slug / 中文名 / 标准定义）、原文精确命中片段。

复用既有生成器 `scripts/p2-06-5-lane-c/description-only-blind-review.mjs` 的白名单与确定性抽样逻辑（排序键 = `sha256([seed, c1_input_sha256, 分层键, sample_row_id].join("\n"))`，无随机数）。

### ⚠️ 两个必须照做的既有教训

1. **禁用 `node:readline`**：Lane C 产物的 description 里有裸 U+2028（LINE SEPARATOR），`JSON.stringify` 不转义它而 readline 当换行处理，会静默切碎记录。按 `/\r?\n/` 自己切；写出时把 U+2028/U+2029 转义。
2. **命中下标是「码点 + NFC」**：取原文片段用 `Array.from(nfc).slice(start,end).join("")`，用 UTF-16 字符串下标会错位。

### 对照组回归抽查

修复后必须确认高精度族仍正常命中：`time-travel`、`rebirth`、`werewolf-alpha`、`wealthy-ceo`、`romance`、`mafia`、`revenge`。任一出现大面积消失即为回归，须排查。

---

## 八、测试

既有 Lane C 测试必须全绿（`npm run test:backend`，当前基线 385 项 / 45 文件）。

新增测试至少覆盖：

- `he` / `be` 已停用，且 `happy-ending` / `tragic-ending` 不再由其触发
- `family` description 禁用、title 仍可用
- `doctor` description 泛化词禁用、title 仍可用
- `horror` description 单词种子禁用、title 仍可用
- `chef`：en 与 de **不共享语义**（en 命中、de 不命中）
- `luna`：es 泛化碰撞被拦，fr 仍可命中
- 高精度对照组关键词仍然生效
- 确定性重跑逐字节一致
- 清单哈希读回校验
- 泄露扫描为 0
- 生产副作用扫描（无 Prisma import、无 `fetch(`、无适配器）

---

## 九、边界

**禁止**：Prisma 迁移、生产库写入、CanonicalTag 变更、B2 变更、Worker 实现、生产回填、在线 LLM、外部 API 变更、拉取前三章、运行章节校准。

**允许**：Lane C 规则/关键词校准产物、分类器纯逻辑的最小字段/语种可用性、测试、C1 v3、盲审包、文档。

离线 LLM 本轮不实现，只保留 ADR 接缝：`NO_SOURCE_MAPPING`、`TEXT_ZERO_HIT`、`LOW_TEXT_CONFIDENCE`、`UNSUPPORTED_LANGUAGE`。不因此改动本轮分类器。

---

## 十、交付状态块

```text
C1_V3_STATUS=
C1_V3_SAMPLE_COUNT=10000

TITLE_WEIGHT=30
DESCRIPTION_WEIGHT=30
THRESHOLD=30
MAX_TEXT_TAGS=3

C1_V2_TEXT_HIT_RATE=0.3596
C1_V3_TEXT_HIT_RATE=

C1_V2_DESCRIPTION_ONLY_RATE=0.3034
C1_V3_DESCRIPTION_ONLY_RATE=

REMOVED_BAD_SEED_EDGES=
PREDICTED_PRECISION_FROM_EXISTING_VERDICTS=
MEASURED_PRECISION_ON_SURVIVING_REVIEWED_EDGES=

POST_FIX_BLIND_REVIEW_SAMPLE_COUNT=
POST_FIX_BLIND_REVIEW_STATUS=

TEXT_PARAMETER_STATUS=CALIBRATION_RECOMMENDATION_ONLY
CHAPTER_EVIDENCE_STATUS=DEFER
C2_SAMPLE_REQUEST=NONE

AUTO_WRITE_AUTHORIZED=NO
OWNER_NEXT_DECISION=POST_FIX_PRECISION_REVIEW_AND_FINAL_PARAMETER_FREEZE
```

做完即停，等 Owner 做最终参数冻结。
