# Post-fix 盲审移交说明（交付执行方）

## ⚠️ 独立性前提（不满足则本次评审无效）

本轮修复由 Cursor 实施。**实施者不得评审自己的成果。**

因此本评审必须满足：

1. **全新会话**，不携带任何本轮修复的上下文
2. **只能读本目录**（`2026-08-17-post-fix-blind-review-HANDOFF/`），不得访问仓库其余部分
3. 不得检索覆盖层、`keyword-eligibility-v1`、ADR、实施方案、上一轮判定
4. 不得联网检索书名或作者

本目录已做过泄露扫描：不含上游分类词、来源映射、风险标记、change_reason、
以及任何"哪些关键词被修过"的线索。

## 内容

```
05-FABLE5_DESCRIPTION_ONLY_REVIEW_PROMPT.md   评审指令（先读这个）
07-FABLE5_OUTPUT_SCHEMA.json                  回传结构
shards/shard-00..04.jsonl                     5 个分片，各 40 本
verdicts/                                     判定写到这里
```

合计 **200 本 / 294 条待判定边**。

## 执行方式

**分片并行，不要串行。** 智能体成本随上下文超线性增长（每步重发全部上下文），
一个会话读完 200 本再逐条判定，token 消耗约是分 5 片的 2–3 倍，且容易触上下文上限。

每个分片起一个独立会话，只给它自己那一片：

> 你是独立评审。只读 `<HANDOFF 目录>` 内的文件，不要访问其他任何路径，不要联网。
> 1. 读 `05-FABLE5_DESCRIPTION_ONLY_REVIEW_PROMPT.md`（任务定义与判定标准）
> 2. 读 `07-FABLE5_OUTPUT_SCHEMA.json`（回传结构）
> 3. 读 `shards/shard-NN.jsonl`（40 本）
> 4. 对**每一条**「小说 × 提议标签」独立判定，不得跳过
> 5. 结果写入 `verdicts/shard-NN.json`，结构：
>    `{"edge_verdicts":[{review_id, canonical_stable_id, verdict, confidence, reason, false_positive_cause}],`
>    ` "novel_verdicts":[{review_id, overall_description_tag_quality}]}`
>
> 枚举：
> - `verdict` ∈ SUPPORTED | UNSUPPORTED | UNCERTAIN
> - `overall_description_tag_quality` ∈ GOOD | MIXED | BAD | UNCERTAIN
> - `false_positive_cause` ∈ NONE | INCIDENTAL_MENTION | SECONDARY_CHARACTER | GENERIC_KEYWORD |
>   SETTING_ONLY | ROLE_ONLY | NEGATION_OR_CONTRAST | PAST_OR_BACKSTORY | MULTIPLE_MEANING |
>   TRANSLATION_DRIFT | INSUFFICIENT_CONTEXT | OTHER
> - `confidence` 为 0.0–1.0 的数字；`reason` 一到两句，指明依据简介的哪一部分
>
> 核心判据：用户点击该标签找书时，这本书出现在结果页是否会让他明显觉得搜错了。
> 简介里出现某个词**不足以**判 SUPPORTED——该元素须是主线、稳定设定、核心人物身份，
> 或足以形成真实的检索意图。
>
> 完成后只回一行汇总：分片号、本数、边数、三种判定的计数。

## 完成后

把 `verdicts/` 下 5 个文件交回，我做聚合校验（完整性 294 条、枚举合法性、
与隐藏参照一一对齐），再出精度报告。**不要自行下结论或改任何产物。**

## 本轮重点

风险层专门加了 `LOCALE_COLLISION_SURVIVOR` 单元，样本内含
`ct-v1-chef` 3 条、`ct-v1-werewolf-luna` 17 条——这些是低证据 locale 规则**保留下来**的边，
用于判断该规则是否留对了。评审无需知道这一点，正常判定即可。
