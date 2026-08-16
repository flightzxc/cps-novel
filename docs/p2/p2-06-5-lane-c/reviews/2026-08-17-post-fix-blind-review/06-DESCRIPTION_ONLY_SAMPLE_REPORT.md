# P2-06.5 Lane C · 简介独立触发标签 400 本盲审样本报告

运行标识 `2026-08-16-owner-final-c1-v3`，生成于 2026-08-17T09:00:00+09:00。

本轮**只生成盲审材料，不下结论**。没有设定通过门槛，没有冻结任何方案，没有修改任何既有产物。

## 一、本轮在问什么

文本标签有两条证据线：标题和简介。前两个候选方案把简介分值压在入选线之下，
简介永远无法单独把标签顶进结果；本轮受审的候选方案把简介抬到与标题齐平
（标题权重 30 / 简介权重 30 / 入选线 30 / 每本最多 3 个文本标签），
简介第一次能够独立触发标签。

唯一要回答的问题是：**这些只靠简介选出来的标签，到底准不准。**

## 二、候选池

「简介独立触发」的定义回到逐条证据：某条文本标签**简介命中、标题未命中、且最终入选**。

| 事项 | 数量 |
| --- | ---: |
| 候选池小说数 | 2412 |
| 候选池条目数（小说 × 标签） | 3218 |
| 涉及标签种类 | 89 |
| 语种分层数 | 13 |

口径已与运行自带的书级标记双向对账，两边集合完全一致。

## 三、样本构成

| 事项 | 数量 |
| --- | ---: |
| 唯一小说数 | 200 |
| 待判定条目数 | 294 |
| 总体分层样本 | 150 |
| 风险追加样本 | 50 |
| 覆盖标签种类 | 59 |

### 按语种分层

| 语种 | 候选池 | 总体样本 | 风险样本 | 合计 | 抽样比 |
| --- | ---: | ---: | ---: | ---: | ---: |
| code 19, no upstream name | 615 | 38 | 5 | 43 | 6.99% |
| 英语 (3) | 565 | 35 | 21 | 56 | 9.91% |
| code 20, no upstream name | 536 | 33 | 2 | 35 | 6.53% |
| 法语 (6) | 231 | 14 | 8 | 22 | 9.52% |
| 葡语 (5) | 153 | 9 | 6 | 15 | 9.80% |
| 西语 (4) | 100 | 6 | 0 | 6 | 6.00% |
| 印尼 (11) | 68 | 4 | 3 | 7 | 10.29% |
| 日语 (9) | 50 | 2 | 0 | 2 | 4.00% |
| 菲律宾语 (15) | 44 | 2 | 2 | 4 | 9.09% |
| 德语 (16) | 29 | 2 | 2 | 4 | 13.79% |
| 土耳其语 (22) | 11 | 2 | 1 | 3 | 27.27% |
| 越南语 (13) | 6 | 2 | 0 | 2 | 33.33% |
| 意大利语 (8) | 4 | 1 | 0 | 1 | 25.00% |

### 风险单元填充

| 风险类别 | 配额 | 实际 |
| --- | ---: | ---: |
| LOCALE_COLLISION_SURVIVOR | 12 | 12 |
| SAME_REGION_MULTI_TAG | 7 | 7 |
| ROLE_OR_SETTING_TAG | 7 | 7 |
| LONG_DESC_SINGLE_OCCURRENCE | 6 | 6 |
| SELECTED_TAG_COUNT_GE3 | 5 | 5 |
| RAW_TAG_COUNT_GE4 | 5 | 5 |
| SOURCE_TEXT_DISAGREE_TEXT_ONLY | 4 | 4 |
| CROSS_SCRIPT_KEYWORD | 2 | 0 |
| SHORT_GENERIC_KEYWORD_NON_HE_BE | 2 | 2 |

未填满的单元（如实记录，未静默截断）：

| 层 | 单元 | 请求 | 可用 | 缺口 |
| --- | --- | ---: | ---: | ---: |
| RISK | CROSS_SCRIPT_KEYWORD | 2 | 0 | 2 |

### 样本内风险标记分布（一本可带多个）

| 标记 | 小说数 |
| --- | ---: |
| ROLE_OR_SETTING_TAG | 116 |
| MULTI_DESC_ONLY_EDGE | 74 |
| LONG_DESC_SINGLE_OCCURRENCE | 69 |
| SAME_REGION_MULTI_TAG | 40 |
| SHORT_GENERIC_KEYWORD_NON_HE_BE | 40 |
| SELECTED_TAG_COUNT_GE3 | 35 |
| LOCALE_COLLISION_SURVIVOR | 20 |
| CAP_TRUNCATED | 15 |
| RAW_TAG_COUNT_GE4 | 15 |
| SOURCE_TEXT_DISAGREE_TEXT_ONLY | 5 |

### 样本内标签分布（前 25）

| CanonicalTag | 条目数 |
| --- | ---: |
| ct-v1-time-travel | 29 |
| ct-v1-wealthy-ceo | 17 |
| ct-v1-werewolf-luna | 17 |
| ct-v1-crime | 15 |
| ct-v1-romance | 14 |
| ct-v1-rebirth | 13 |
| ct-v1-betrayal | 11 |
| ct-v1-genius | 11 |
| ct-v1-werewolf-alpha | 11 |
| ct-v1-divorce | 8 |
| ct-v1-mafia | 8 |
| ct-v1-revenge | 8 |
| ct-v1-legitimate-daughter | 7 |
| ct-v1-marriage | 7 |
| ct-v1-student | 7 |
| ct-v1-crown-prince | 6 |
| ct-v1-emperor | 6 |
| ct-v1-princess | 6 |
| ct-v1-apocalypse | 5 |
| ct-v1-assassin | 5 |
| ct-v1-heir | 5 |
| ct-v1-supernatural | 5 |
| ct-v1-adventure | 4 |
| ct-v1-campus | 4 |
| ct-v1-first-love | 4 |

## 四、KNOWN_SEED_DEFECT · 「圆满结局 / 悲剧结局」关键词种子缺陷

**这是本轮开工前就已存在的缺陷，本轮不修，仅备案。**

### 根因

在中文短剧圈，HE 是 Happy Ending、BE 是 Bad Ending 的行话缩写。CanonicalTag v1 Final 把它们
原样收进了关键词种子：

- `ct-v1-happy-ending` 的 `keyword_seeds` = `["圆满结局", "he", "HE"]`
- `ct-v1-tragic-ending` 的 `keyword_seeds` = `["悲剧结局", "be", "BE"]`

匹配器对拉丁文本按整词匹配且不分大小写，于是在英文简介里，这两个种子命中的是
**英文人称代词 he 和系动词 be**，与结局无关。

现有的种子停用机制只拦「字系未覆盖」（本轮停用了 6 个），拉丁字系的 he/be 因此未被拦下。

### 足迹

| 口径 | 数量 | 占比 |
| --- | ---: | ---: |
| 候选池中由该缺陷产生的条目 | 0 / 3218 | 0.0% |
| 候选池中被波及的小说 | 0 / 2412 | 0.0% |
| 本样本中由该缺陷产生的条目 | 0 / 294 | 0.0% |
| 本样本中被波及的小说 | 0 / 200 | 0.0% |

这两个标签因此成为候选池中占比最高的标签之一。

### 本轮处置

1. 样本**按真实比例保留**，不做人为压制——这样 Owner 拿到的是对**现状产物**的真实精度估计。
2. 缺陷标记 `GENERIC_KEYWORD_HE_BE` **只写进隐藏参照包**，评审包中不出现，评审全程无感。
3. 风险追加抽样**未给该缺陷配额**，配额留给未知失效模式。
4. 回收 Fable5 判定后，精度须**分三档报告**：整体 / 剔除该缺陷 / 该缺陷单独。
   否则一个已知的机械缺陷会淹没「简介权重本身是否成立」这个真问题。

### 明确声明

本轮**未**修改关键词种子、**未**修改 CanonicalTag 产物、**未**重跑 C1、**未**调整权重或入选线。
是否修复、如何修复，由 Owner 另行决定。

## 五、盲审边界

评审包按**显式字段白名单**构造，从不展开源记录。评审可见：
`novel_review_id`、`raw_language_scope`、`title`、`description`，以及每个提议标签的
稳定 ID、slug、中文名、标准定义、原文精确命中片段。

评审**不可见**：上游原始分类词、来源标签映射、来源与文本关系、既有人工标签、
任何得分与权重、证据分类、风险标记、抽样层、原始行号与小说身份标识。

隐藏参照包按 `novel_review_id` 与评审包一一对齐，保留全部被排除的证据，供回收判定后对照。

## 六、可复现性

抽样不使用随机数。排序键为：

```
sha256([ "20260816", c1_input_sha256, 分层键, sample_row_id ].join("\n"))
```

按哈希序取前 N 本。同脚本、同输入、同 `--generated-at` 必然产出逐字节一致的输出目录。

### 血缘

| 项 | 值 |
| --- | --- |
| 运行标识 | `2026-08-16-owner-final-c1-v3` |
| CanonicalTag v1 Final | `8bc8cdae8be2176bde170173e98bad2b9fa0e1770818174a57320816eefdccad` |
| C1 输入 | `046fe9234b317eba145c3fbb35edd2e72af49e41309dcd5d5f45f7bc43d1776d` |
| 样本指纹 | `a13586b02af329ca97fc6790c1448d51e81d87c6b401ce967c73d9ac9df69582` |
| 关键词词典指纹 | `f135f2a81ace324cc7d3676cff3a546f2982a52aa36152d14207664cbf1d85e1` |
| 来源映射指纹 | `fcd3c9df0dd411093045fce7b2b5d020c1517a98dca05c6127e8c2ff09f241b6` |
| 逐条文本证据 | `a436ecf98d90cdc565028303b72a186d49f0d9dda844cb54d6f5fb9ffe80051b` |
| 书级诊断 | `b4ba2c4b4e1347343ed238b54a04a7c11b4b12bccfddb1bab650dd78e13a8b63` |

## 七、验收

| 检查 | 结果 |
| --- | --- |
| unique_novels_equals_target | PASS — 200 novels |
| review_ids_unique | PASS — 200 rows |
| packages_aligned_one_to_one | PASS — 200 reviewer / 200 hidden |
| all_edges_are_description_only | PASS — title_matched must be false on every edge |
| all_tags_in_canonical_final | PASS — all proposed tags resolve |
| reviewer_package_has_no_source_evidence | PASS — no forbidden field present |
| matched_spans_are_exact_substrings | PASS — every span re-derives from the description |

未写数据库、未调用生产接口、未调用外部大模型、未修改 CanonicalTag 产物、
未修改来源映射、未修改分类器、未重跑 C1。

## 八、状态

```text
DESCRIPTION_ONLY_POPULATION=2412
DESCRIPTION_ONLY_SAMPLE_COUNT=200
POPULATION_SAMPLE_COUNT=150
RISK_SAMPLE_COUNT=50
DESCRIPTION_ONLY_BLIND_REVIEW_STATUS=READY_FOR_INDEPENDENT_REVIEW
AUTO_WRITE_AUTHORIZED=NO
```

做完即停，等待 Fable5 独立评审回传。
