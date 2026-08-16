# P2-06.5 Lane C 收口说明（2026-08-17）

面向 Owner。本文件说明这一轮做完了什么、得到了什么证据、还剩哪些决定。
**参数未冻结，`AUTO_WRITE_AUTHORIZED=NO`。**

---

## 一、这一轮在解决什么

小说的自动打标有两条证据线：上游自带的分类词，和我们自己从标题、简介里抓关键词。
本轮要定的是后者里**简介**该给多大权重。

争议点是：把简介抬到与标题齐平（都是 30 分、入选线 30）之后，简介第一次能够
**单独**把一个标签顶进结果。这些"只靠简介"选出来的标签到底准不准，跑数字回答不了，
只能靠人读。

于是做了两轮独立盲审。结论出乎最初的假设：

> **问题不在"简介权重该不该等于标题"这个参数，而在少数关键词种子本身是错的。**

---

## 二、结论：修词典比调参数有效得多

| 阶段 | 无偏精度 | 说明 |
| --- | ---: | --- |
| 修复前（v2） | **51.4%** | 400 本 / 653 条边独立盲审 |
| 修复后（v3） | **73.0%** | 新抽 200 本 / 294 条边独立盲审 |
| 配对回溯 | **73.78%** | 同一批人工判定，只改规则选择集 |

**两条互不依赖的路径落在同一点（73.0% / 73.78%）**，比任何单一数字都可信。
整书质量 GOOD 从 42.2% 升到 64.0%。

参数一个字没动：标题 30 / 简介 30 / 入选线 30 / 每本最多 3 个标签，全程固定。

### 读数纪律

- 51.9% → 73.78% 是**配对**结论（判定固定、只是规则改变了哪些边入选），可归因于修复。
- 新 200 本是**独立样本**，用于估计 v3 当前水平与发现残余缺陷。
- **不得**把两批不同样本相减，写成「51.4% → 73.0% 的提升」。

---

## 三、修了什么（覆盖层 `keyword-eligibility-v1`，CanonicalTag 未改）

CanonicalTag v1 Final 的哈希 `8bc8cdae…` 全程未变。修复走独立覆盖层，在词典构建时套用。

### A 级 · 证据充分，已生效

| 标签 | 处置 | 盲审证据 |
| --- | --- | --- |
| `happy-ending` | 种子 `he` 全字段停用 | 138 条中 133 条误报（精度 1.4%） |
| `tragic-ending` | 种子 `be` 全字段停用 | 同批 |
| `horror` | 单词种子仅限 title | 86.4% 误报，命中的是"恐惧"情绪词与比喻 |
| `family` | 单词种子仅限 title | 76.1% 误报，`family ties`、家族姓氏 |
| `doctor` | 单词种子仅限 title | 83.3% 误报，产检、告知病情、作者生平 |

`he`/`be` 是中文短剧圈 Happy/Bad Ending 的行话缩写，在拉丁文本里整词匹配命中的是
**英文代词 he 和系词 be**。移除后这两个标签在 description 上归零——这是预期结果，
因为它们的 642/321 条命中**全部**来自这两个种子，中文种子一条都没命中过。

**title 一律未动**：本轮盲审只覆盖 description-only 边，对 title 精度零证据。无证据不改。

### B 级 · 低证据，已生效但未冻结

`chef` 在 de/fr/es/pt、`luna` 在 es/it 的 description 停用，标注 `LOW_EVIDENCE_LOCALE_RULE`。

**这两条规则的证据显示应当撤销**，见下节。

---

## 四、最重要的发现：B 级规则删错了 40%

只评审"活下来的边"回答不了"删错没有"。因此额外做了一个 **SUPPRESSION_SAFETY** 包，
从 v2 抽 20 条被 B 级规则删掉的边独立盲审：

| 标签 | 语种 | 边 | 误删 |
| --- | --- | ---: | ---: |
| chef | 西语 | 3 | 2（67%） |
| chef | 法语 | 5 | 2（40%） |
| chef | 葡语 | 3 | 1（33%） |
| chef | 德语 | 1 | 0 |
| luna | 意大利语 | 2 | 2（100%） |
| luna | 西语 | 6 | 1（17%） |
| **合计** | | **20** | **8（40%）** |

被误删的是一个真实存在的子类型——**「糕点师重生复仇」**，西/法/葡三语各有实例
（`chef confeiteira aclamada`、Meilleur Ouvrier de France 大赛、《El Postre Más Dulce》）。
意大利语两条 luna 均为完整狼人设定（Branco 狼群、Alpha、Compagna Destinata）。

**locale 不是正确的判据。** `chef` 是厨师还是老板、`luna` 是月亮还是狼人女首领，
取决于句子而非语言；西/法/葡三语同时存在两种用法，一刀切必然连坐。

B 级只买到约 1.1 个百分点精度，代价是 40% 误删。**这笔交易是亏的。**

### `werewolf-luna` 双向失败

survivor 侧仍有 47.1% 误报，suppression 侧又有 38% 误删——**该关键词在两个方向同时失败**。
裸词 `luna` 无论怎么按语种切都不成立，需要短语级种子或退出 description 证据。
建议作为独立议题处理，不要并入 locale 规则的取舍。

---

## 五、误报的性质已经改变

| 归因 | v2（653 边） | v3（294 边） |
| --- | ---: | ---: |
| `GENERIC_KEYWORD` | 144 | **9** |
| `MULTIPLE_MEANING` | 56 | **16** |
| `INCIDENTAL_MENTION` | 44 | 14 |
| `SECONDARY_CHARACTER` | 24 | 12 |

泛化词误报基本清除；**剩下的主要矛盾变成同形异义**。这类问题语种规则解决不了，
需要短语级证据或上下文判断——也是为什么 B 级那种"按语种一刀切"的路子走不通。

---

## 六、一个计划外的增益

删掉垃圾种子会**腾出 cap 名额**。v2 里被 `maxTextTags=3` 截掉的真标签，v3 里补了回来：

```
全部证据类   5672 − 1546 + 215 = 4341
DESCRIPTION_ONLY  4554 − 1525 + 189 = 3218
```

新增的 215 条边**100% 来自 v2 的 cap 截断名单**；被截断的书从 301 本降到 96 本。
所以覆盖损失比屏蔽量小，存活标签集本身也更好。

⚠️ **215 与 189 不可混称**：215 是跨证据类口径，189 仅指 description-only，差额 26 全是 `TITLE_ONLY`。

---

## 七、可复现性

**C1 v3 现在可从 HEAD 完整复现，已实证 11/11**（含 170MB 诊断与 116MB 证据文件逐字节一致）。

复现命令见 `scripts/p2-06-5-lane-c/README.md` 的「C1 v3」一节。
传 `--run-id 2026-08-16-owner-final-c1-v3` 即自动套用冻结的 `generatedAt`，
**无需手工记忆时间戳**；其他 run id 一律实时时间戳，未来的 v4 不会被误盖成 v3 身份。

| 检查 | 结果 |
| --- | --- |
| 从 HEAD 重跑比对 | 11/11 |
| `npm run test:backend` | 399/399，46 文件 |
| `verify-owner-final-c1` | ok |
| CanonicalTag / c1-input 哈希 | 未变 |
| 覆盖层 `781916c9…` | 未变 |
| 生产副作用扫描 | 无 Prisma / fetch / adapter |

---

## 八、等 Owner 的三个决定

1. **B 级 locale 规则去留。** 证据支持撤掉 `chef` 四语种与 `luna@意大利语`；
   `luna@西语` 误删 17% 相对最轻。撤销只需删覆盖层里两个规则对象并重跑，不必返工。
2. **`werewolf-luna` 是否单独立项。** 双向失败，与 locale 取舍是两回事。
3. **C1 参数冻结。** 现为 `CALIBRATION_RECOMMENDATION_ONLY`。

另有两个新暴露但证据不足的标签：`princess`、`crown-prince`（各 66.7% 误报，n=6）、
`student`（57.1%，n=7）。样本太小，不足以立规则，建议列入观察。

---

## 九、方法学（后续轮次可复用）

- **只评"留下的"回答不了"删错没有"**，凡是做了抑制规则，必须配一个从旧产物抽被删边的
  suppression safety 包。这是本轮最有价值的方法论收获。
- **盲审隔离靠字段白名单 + 独立目录**，不靠自觉；交出去的指令要删掉提及隐藏参照文件名的段落。
- **多方写同一 verdicts 目录会污染来源**，聚合前必须按 mtime 核验。本轮踩过一次。
- **实施方不应评审自己的成果**。本轮做了对照：129 条可比边一致 87.6%，
  实施方 SUPPORTED 率反而低 10.1pp——自评偏**严**不偏宽。隔离流程仍应坚持，
  但即使混入，偏差方向是悲观而非自我美化。
- **Lane C 产物含裸 U+2028**，`JSON.stringify` 不转义、`node:readline` 会当换行切碎记录。
  读这些 JSONL 必须按 `/\r?\n/` 自己切。
- **匹配下标是「码点 + NFC」**，取原文片段用 `Array.from(nfc).slice(start,end)`，
  用 UTF-16 下标会错位。

---

## 十、产物索引

| 位置 | 内容 |
| --- | --- |
| `lexicon-overrides/2026-08-16/` | 关键词资格覆盖层（`781916c9…`） |
| `runs/2026-08-16-owner-final-c1-v3/` | v3 报告、汇总、血缘清单 |
| `reviews/2026-08-16-description-only-blind-review/` | 第一轮 400 本样本包 |
| `reviews/2026-08-16-description-only-blind-review-results/` | 第一轮 653 条判定与报告 |
| `reviews/2026-08-17-post-fix-blind-review/` | 修复后 200 本样本包 |
| `reviews/2026-08-17-post-fix-blind-review-HANDOFF/` | 交付评审的分片与回传判定 |
| `reviews/2026-08-17-suppression-safety-review/` | 被删边安全性抽查（20 条） |
| `reviews/2026-08-17-post-fix-results/` | 合并判定与最终报告 |

未纳入版本控制：`reviews/2026-08-16-post-fix-blind-review/`——被 08-17 那版取代的旧包，
无人评审过，留着容易递错，建议删除。

```text
LANE_C_STATUS=POST_FIX_REVIEW_RETURNED
V3_REPRODUCIBLE_FROM_HEAD=YES
V3_PRECISION_WEIGHTED=73.0%
PAIRED_RETROSPECTIVE_PRECISION=73.78%
SUPPRESSION_FALSE_REMOVAL_RATE=40%
GRADE_B_STILL_LOW_EVIDENCE=YES
TEXT_PARAMETER_STATUS=CALIBRATION_RECOMMENDATION_ONLY
CHAPTER_EVIDENCE_STATUS=DEFER
C2_SAMPLE_REQUEST=NONE
AUTO_WRITE_AUTHORIZED=NO
OWNER_NEXT_DECISION=GRADE_B_LOCALE_RULE_DISPOSITION_AND_C1_PARAMETER_FREEZE
```
