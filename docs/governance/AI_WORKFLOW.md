# AI 协作工作流（跨 Agent 唯一真源）

本文件是 **所有 AI Agent（Claude Code / Codex / Cursor / 其它）在本仓库工作时的流程唯一真源**。

三个入口文件 —— `CLAUDE.md`、`AGENTS.md`、`.cursor/rules/repository-governance.mdc` ——
都只是**薄引导层**：它们负责把各自的 Agent 带到这里，**不得**复制本文件的规则正文。
规则只有一份，改规则改这里。`tests/backend/governance/ai-workflow-entrypoints.test.ts`
会在 CI 里检查三个入口仍然指向本文件，并且没有把规则抄过去。

## 两个真源，不要混

| 问题 | 真源 |
|---|---|
| 项目**架构事实**是什么（身份、隔离边界、技术栈、红线） | `CLAUDE.md` |
| **怎么干活**（读什么、怎么提交、怎么记录、怎么部署） | 本文件 |

冲突裁决顺序：**Owner 当面决策 > `CLAUDE.md`（架构事实）> 本文件（流程）> 代码注释 > 历史文档**。
代码注释排在文档之后是有前车之鉴的：2026-09-18 的批量发布事故，
根因就是 `publish-gate/service.ts` 一句"审计表没有唯一约束"的注释——写的时候大概是对的，
索引后来加了没人回来改，于是这句话把真 bug 挡了一个多月。

## 改代码前必读

1. `CLAUDE.md` —— 架构事实与红线。
2. 本文件 —— 流程。
3. 你要动的那块的**近期 commit**，不是历史文档：
   ```bash
   git log --oneline -15 -- <你要改的路径>
   ```
   本仓库的 commit message 写得比任何流水账都细，且**不可能与代码漂移**。
4. 涉及 Owner/架构决策时 —— `docs/adr/`。
5. 涉及数据库时 —— `docs/governance/database-governance.md` 与
   `database-schema-dictionary.jsonl`（任何 schema 改动必须同步字典，CI 有 drift 检查）。

`docs/governance/development-log.md` **已于 2026-09-07 冻结**，只作历史参考，不要再往里写。

## 提交约定

每个 commit 必须带结构化 trailer，说明是谁、用什么模型做的：

```
Agent: claude-code
Model: Claude Opus 5
```

经过独立复核的，再加：

```
Reviewed-By-Agent: claude-code
Reviewed-By-Model: Fable 5.1
```

取值约定（保持稳定，`scripts/generate-changelog.mjs` 按原样输出）：

- `Agent:` —— `claude-code` / `codex` / `cursor` / `human`
- `Model:` —— 人类可读的模型名，例如 `Claude Opus 5`、`Fable 5.1`、`GPT-5-Codex`

**为什么是 trailer 而不是日志文件**：trailer 钉死在 commit 上，
和代码同生共死，不可能腐化；手写流水账会（本仓库 2026-09-07 到 09-18 就漏了 10+ 次实质改动）。

历史 commit 用的 `Co-Authored-By:` 仍被生成器识别，**新提交请用上面的结构化 trailer**。

## CHANGELOG 是生成的，不是写的

```bash
node scripts/generate-changelog.mjs            # 打印到 stdout
node scripts/generate-changelog.mjs --write    # 写入 CHANGELOG.md
```

来源是 `git log` + tag + trailer。**不要手工编辑 `CHANGELOG.md`**——下一次生成会覆盖。
需要补充的叙述性内容，写进 commit message 或 ADR。

## 决策写 ADR，不写 CHANGELOG

Owner 裁决、架构选型、"为什么不这么做"——一律 `docs/adr/`。
判据很简单：**跨越多个 commit、且将来有人会想问"当初为什么"的，就是 ADR**；
单个 commit 讲得清的，留在 commit message 里。

CHANGELOG 只回答"改了什么"，不回答"为什么这么定"。

## 本地 X8 部署与身份

唯一**受支持**的部署入口是：

```bash
X8_LEVEL=uat scripts/x8-production-like.sh up
```

它在 build → 数据库准备 → recreate → 三服务 healthy → HTTP 探针全过之后，
才把候选身份提升为 `.tmp/x8-production-like/release-identity.json`。
中途任何一步失败都不会提升，旧身份原样保留。

绕过它手工 `docker compose up` 是可以的（调试常用），但**必然造成身份漂移**：
身份文件还写着上一版，容器已经换了。因此：

```bash
scripts/x8-production-like.sh status
```

会把身份文件与**容器实际镜像的 `org.opencontainers.image.revision`** 逐个比对，
不一致就打印 `X8_IDENTITY_DRIFT=...` 并以非零码退出。
**不要凭身份文件断言线上跑的是什么**——以 `status` 或 `/api/health` 的 `build.commit` 为准。
