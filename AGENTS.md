# AGENTS.md

Codex 以及任何按 `AGENTS.md` 约定寻找入口的 Agent，从这里开始。

本文件是**引导层**，不是规则正文。

## 开工前读这两份

1. **[`docs/governance/AI_WORKFLOW.md`](docs/governance/AI_WORKFLOW.md)** —— 跨 Agent 工作流唯一真源：
   必读顺序、commit trailer 约定、CHANGELOG 生成方式、ADR 边界、X8 部署与身份纪律。
2. **[`CLAUDE.md`](CLAUDE.md)** —— 项目架构事实唯一权威源：项目身份、物理隔离、红线。
   文件名带 Claude 只是历史原因，内容与 Agent 无关，对所有 Agent 同等有效。

规则正文只存在于上面两份文件里。本文件刻意不复制它们——三份副本必然漂移，
而漂移的规则比没有规则更危险。

## 最低限度约定（细则见 AI_WORKFLOW.md）

- 每个 commit 带 `Agent:` / `Model:` trailer；经复核的再加 `Reviewed-By-Agent:` / `Reviewed-By-Model:`。
- `CHANGELOG.md` 由 `node scripts/generate-changelog.mjs --write` 生成，**不要手写**。
- `docs/governance/development-log.md` 自 v0.3.0 起只记发版级条目（一次正式发版一条，由发版执行者在发布后写）；日常改动不要往里写。
- Owner/架构决策写 `docs/adr/`，不要塞进 CHANGELOG。
- 数据库改动必须同步 `docs/governance/database-schema-dictionary.jsonl`（CI 有 drift 检查）。
