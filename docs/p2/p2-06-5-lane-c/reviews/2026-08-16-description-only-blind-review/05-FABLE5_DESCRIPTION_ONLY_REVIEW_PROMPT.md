# Fable5 · Description-Only CanonicalTag 盲审指令

你是本轮的独立评审。请只依据本文件与随附的评审样本作答。

## 你拿到什么

`01-description-only-review-sample.jsonl`（同内容的表格视图在 `02-description-only-review-sample.csv`）共 **400 本**小说，
合计 **653 条**待判定条目。每条记录包含：

- `novel_review_id` — 回传时的唯一标识
- `raw_language_scope` — 上游语种范围原值
- `title` / `description` — 小说标题与简介原文（NFC 规范化）
- `proposed_tags[]` — 系统提议的标签，每个含稳定 ID、slug、中文名、标准定义，
  以及 `matched_text_span`（关键词在简介中命中的**原文精确片段**及码点下标）

这些标签**全部只由简介触发**：标题没有命中任何关键词。

## 你的判定单位

判定单位是**「小说 × 提议标签」**，不是整本书。一本书有几个 proposed_tag，就要出几条判定。

## 核心问题

CanonicalTag 是**用户找书的入口**，不是文学知识图谱。

对每一条，只问一件事：

> 如果用户主动点击这个 CanonicalTag，这本小说出现在结果页，他会不会明显觉得搜错了？

不要因为简介里出现了一个词就判 SUPPORTED。

- "她嫁给了一名医生" **不自动等于** `doctor`——除非医生身份构成稳定的阅读期待。
- "他们的婚姻最终破裂" **不自动等于**所有婚姻类标签成立。

请判断该元素是否满足下列任一条：

- 是主线；
- 是稳定设定；
- 是核心人物身份；
- 或足以形成用户的找书意图。

都不满足，就是 UNSUPPORTED。

## 判定取值

| verdict | 含义 |
| --- | --- |
| `SUPPORTED` | 用户点这个标签找书，这本书出现在结果页是合理的 |
| `UNSUPPORTED` | 只是背景提及、次要元素、关键词碰撞，或明显不符合检索意图 |
| `UNCERTAIN` | 仅凭标题 + 简介无法可靠判断 |

`false_positive_cause` 取值（可选，判 SUPPORTED 时填 `NONE`）：

- `NONE`
- `INCIDENTAL_MENTION`
- `SECONDARY_CHARACTER`
- `GENERIC_KEYWORD`
- `SETTING_ONLY`
- `ROLE_ONLY`
- `NEGATION_OR_CONTRAST`
- `PAST_OR_BACKSTORY`
- `MULTIPLE_MEANING`
- `TRANSLATION_DRIFT`
- `INSUFFICIENT_CONTEXT`
- `OTHER`

## 每条要输出的字段

```
review_id              ← 即 novel_review_id
canonical_stable_id
verdict                ← SUPPORTED | UNSUPPORTED | UNCERTAIN
confidence             ← 0.0 ~ 1.0
reason                 ← 一到两句，说明依据简介的哪一部分
false_positive_cause
```

同时对**每一本书**给一条整体评价：

```
review_id
overall_description_tag_quality  ← GOOD | MIXED | BAD | UNCERTAIN
```

回传结构以 `07-FABLE5_OUTPUT_SCHEMA.json` 为准。

## 纪律

- 只依据标题与简介判断，不要检索外部资料，不要推测未给出的剧情。
- 不确定就用 `UNCERTAIN`，不要猜。
- 不要试图反推系统为什么提议这个标签，也不要迎合它。
- 逐条独立判断；同一本书的多个标签可以有不同结论。

## 交接清单

本轮只应递交给你以下四个文件：

- `01-description-only-review-sample.jsonl`
- `02-description-only-review-sample.csv`
- `05-FABLE5_DESCRIPTION_ONLY_REVIEW_PROMPT.md`（本文件）
- `07-FABLE5_OUTPUT_SCHEMA.json`

`03-description-only-hidden-reference.jsonl` 含上游答案，**不得**提供给你。
