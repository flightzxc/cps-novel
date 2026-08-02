# src/domain/

**Merge custodian: Codex；Claude 审核。**

## 用途

领域模型：核心实体类型（小说、章节、渠道、任务等）及其不变量，与 `prisma/` 的数据库结构对应但不等同——领域层可包含数据库不直接体现的业务规则与派生逻辑。

## 本轮范围

🔴 本轮（P1-04）只建目录，不写实现。当前目录仅含本 README 与 `.gitkeep` 占位。

## 硬纪律

1. Codex 负责合并，Claude 作为审核方，尤其对涉及前台展示、阅读器的领域模型部分需 Claude 签字确认；
2. 章节相关领域模型（CPS 无对应物，`ORIGINAL_REQUIRED`）需经 Claude 领域评审签字后方可视为定稿；
3. 非 custodian（Claude）如需在此提出改动，走 PR，由 Codex 合并前取得 Claude 确认。

## 填充任务

随 **P1-05（PostgreSQL Schema、Migration、约束和索引）** 填充。
