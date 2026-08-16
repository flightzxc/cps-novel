# P2-06.5 Tagging ADR · Superseded

```text
CURRENT_ADR_STATUS=SUPERSEDED_BY_V3
SUPERSEDED_DATE=2026-08-16
AUTHORITATIVE_ADR=docs/adr/ADR-P2-06-5-TAGGING-V3.md
```

本路径对应的旧 P2-06.5 Tagging 方案已经失效。唯一权威工程合同是
[ADR-P2-06-5-TAGGING-V3](../adr/ADR-P2-06-5-TAGGING-V3.md)。

旧方案中以下描述不得用于施工：

- locale-scoped CanonicalTag identity；
- `manual > mapped > auto > 0` 按层短路或 mapped 屏蔽 auto；
- 用 manual row 是否存在表示 manual ownership，或拒绝空 manual snapshot；
- 以无 raw-language scope 的 SourceLabel FK 作为 B2 mapping identity；
- mapped `NovelCanonicalTag` materialization；
- auto 仅在 mapped 为空时运行；
- 禁止显式 GenericTask backfill；
- 将未冻结 C1 参数散布在多个实现文件。

仍可复用的读时派生、import boundary、invariant guard、dry-run、audit、write gate、数据库治理与测试
骨架，均已重新表述并受 V3 ADR 约束。不要从旧 worktree 恢复或复制旧 ADR 正文。
