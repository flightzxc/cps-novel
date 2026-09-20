# ADR-OWNERSHIP-EXCEPTION-CODEX-QUOTA · Codex 额度不足期间的目录分权例外

```text
ADR_ID                         = OWNERSHIP-EXCEPTION-CODEX-QUOTA
DECISION_STATUS                = ACCEPTED
DECISION_DATE                  = 2026-09-19
DECIDED_BY                     = Owner（当面口头指派）
BASELINE                       = integration/2026-09-16-night 4ba5bd9
SUPERSEDES_FOR_SCOPE           = CLAUDE.md §3.1/§3.2 的按目录独占（仅在本 ADR 范围内）
STILL_BINDING                  = CLAUDE.md §3.3「任何路径不得有两个写 Owner」
TRIGGER                        = Codex 额度耗尽，Codex 侧工单无法执行
EXPIRY                         = Codex 额度恢复后自动失效，需 Owner 再次确认方可延续
```

本 ADR 记录 Owner 于 2026-09-19 当面给出的一条**目录分权例外**：在 Codex 额度不足、
无法执行 Codex 侧工单期间，**允许 Claude 直接写入 `CLAUDE.md` §3.2 列举的 Codex 独占目录**。

## 1. 背景

`CLAUDE.md` §3.1/§3.2 把仓库按目录切成 Claude / Codex 两个独占写入面，§5 修正 1 进一步
把职责冻结为「Claude 负责前台、后台 UI、设计、阅读器；Codex 负责后端、数据库、Auth、
Credential、Worker、Scheduler、Adapter」。这套分权反映的是双方额度都充足时的协作模式。

2026-09-19 出现两件事同时成立：

1. PR [#10](https://github.com/flightzxc/cps-novel/pull/10) 的必需检查 `Quality gate` 被一条
   **基线缺陷**卡红：`tests/backend/local-x8/x8-local-wal-gc-launchd.test.ts` 测的是
   macOS LaunchAgent 安装脚本，自身没有平台守卫，CI 的 Linux runner 上脚本以
   `reason=not_darwin` 拒绝，三条断言必挂。该文件与基线逐字节相同，本机 macOS 7/7 全绿，
   属 2026-09-18 P2-12 引入的既有缺陷。修它必须写 `tests/backend/**`（Codex 目录）。
2. **Codex 额度耗尽**，该工单无法按原分权交付。

结果是：一条与 Claude 侧改动完全无关的基线缺陷，把 Claude 侧的 PR 永久卡在红灯，而
按分权又无人可修。这不是分权要防的情形，是分权的副作用。

## 2. 决定

Owner 授权：**Codex 额度不足期间，Claude 可以直接写入 Codex 独占目录。**

例外的形状沿用 `CLAUDE.md` §3.4 已有的先例（2026-09-06 Parity 收敛）：
**唯一 Owner 由任务指派，而不是由目录表指派**。

## 3. 仍然生效的纪律（本例外不豁免）

1. 🔴 **§3.3「任何路径不得有两个写 Owner」继续成立。** 本例外改变的是「谁是那个
   Owner」，不是「可以有两个 Owner」。同一时间同一路径仍然只能有一个执行方。
2. 🔴 **物理隔离（§2）不受影响**：两个 CPS 参考工作区仍然绝对只读。
3. 任何 schema 改动仍必须同步 `docs/governance/database-governance.md` 与
   `database-schema-dictionary.jsonl`（CI 有 drift 检查）。
4. 既有迁移**不得修改**，只能新增。
5. Worker/Scheduler 的 at-least-once + fencing（§5 修正 3）、副作用意图与操作审计的
   事务边界（修正 4）、默认拒绝与密钥面收敛（修正 5）全部照旧。
   尤其：**Web 不解密凭证**这条红线不因本例外松动。
6. 交付仍须经独立复核后方可合入。
7. 越界改动的 commit message 必须写明「依据 ADR-OWNERSHIP-EXCEPTION-CODEX-QUOTA，
   Owner 指派」，并注明本次指派覆盖的具体路径——避免将来被当成目录分权整体失效的先例。

## 4. 范围与失效

- **范围**：Codex 额度不足期间、Owner 指派给 Claude 的具体任务所涉路径。
  未被指派的 Codex 路径仍按 §3.2 执行，不因本 ADR 自动开放。
- **失效**：Codex 额度恢复后本例外自动失效。若届时希望延续，需 Owner 再次确认，
  并在本 ADR 追加一条决定记录。
- 本 ADR **不**重写 `CLAUDE.md` §3.1–§3.3。是否把分权表整体改写成四层分工模型，
  仍是 §3.4 留给 Owner 的未决项。

## 5. 依据本例外执行的任务

| 日期 | 任务 | 涉及路径 | 执行方 |
| --- | --- | --- | --- |
| 2026-09-19 | GitHub Actions local-X8 平台测试修复 | `tests/backend/local-x8/x8-local-wal-gc-launchd.test.ts`（必要时 + `scripts/x8-local-wal-gc-launchd.sh`） | Claude（独立会话） |
| 2026-09-20 | PR #10 收口 + PR #14 stacked 归一化 | PR 合并与 base 改指，无仓库文件写入 | Claude |
| 2026-09-20 | Phase 2C · GHCR Bootstrap + 部署工件运输固化 | `.github/workflows/ghcr-release.yml`（新增）、`docs/adr/ADR-DEPLOYMENT-ARTIFACT-DISTRIBUTION.md`（新增）、`docs/operations/GHCR_RELEASE_AND_FALLBACK.md`（新增）、`docs/governance/P1_RISK_AND_DEBT_REGISTER.md`、`CLAUDE.md`（仅事实指针）、`CHANGELOG.md`（仅生成器） | Claude |
| 2026-09-20 | Phase 2C · artifact transport 切换为不可变归档（Owner 推翻同日 GHCR 裁决） | `scripts/preproduction/build-release-archive.sh`、`scripts/preproduction/verify-release-archive.sh`（均为**新增**）、`tests/backend/runtime/preproduction-archive-contract.test.ts`（新增）、`docs/adr/`、`docs/operations/`、`CLAUDE.md`、`CHANGELOG.md`、删除 `.github/workflows/ghcr-release.yml` | Claude |
| 2026-09-20 | Phase 2C · 归档 → release consumer 最小闭环接线 | `scripts/preproduction/{lib,preflight,release,verify-release,database,verify-release-archive,build-release-archive}.sh`、`infra/preproduction/{docker-compose.yml,preprod.env.example}`、`tests/backend/runtime/preproduction-archive-{contract,consumer}.test.ts`、`docs/adr/`、`docs/operations/`、`CHANGELOG.md` | Claude |

新增任务请在此表追加一行，不要另起文档。

🔴 **2026-09-20 的 GHCR Bootstrap 一轮并未写入 §3.2 的 Codex 独占目录**：
`.github/`、`docs/`、`CLAUDE.md`、`CHANGELOG.md` 都不在 §3.1/§3.2 任一独占表里。
之所以仍登记在此，是因为 Owner 是以「Codex/Cursor 今日不可用」为由做的单次指派，
需要一条能从 Git 追溯的记录。该轮的授权边界同时**明确排除**了
`infra/`、`scripts/preproduction/**`、`Dockerfile`、`docker-compose.yml` 与后端运行时代码——
必须改动这些时要求 STOP 并报告，实际执行中未触碰其中任何一个。

🔴 **2026-09-20 第二轮（artifact transport 切换）确实写入了 Codex 独占目录**：
`scripts/preproduction/` 与 `tests/backend/`。两者都由该轮工单**显式点名**
（工单 §5 指定新增 `scripts/preproduction/build-release-archive.sh`，§13 要求配套测试）。
边界是**只新增文件**：`scripts/preproduction/release.sh`、`build-release-artifact.sh`、
`infra/`、`Dockerfile`、`docker-compose.yml` 一行未改。
其中 `release.sh` 的 manifest 契约与归档运输不兼容，属**已识别但未执行**的改动，
已记录在 `ADR-DEPLOYMENT-ARTIFACT-DISTRIBUTION` §8.1，留待 Owner 另行授权。

🔴 **2026-09-20 第四轮（archive image identity portability 修复）同样写入 Codex 独占目录**：
`scripts/preproduction/`、`tests/backend/`、`.github/workflows/ci.yml`、`docs/`、`CLAUDE.md`。
全部由该轮工单**显式点名**（工单 §2 逐条列出允许修改的文件，含 release/preflight/
verify-release 与"必要的共享解析辅助模块"、对应测试、双 image-store 实测所需的最小 CI 接线、
ADR/runbook/ownership/生成式 CHANGELOG）。

与第二轮不同，本轮**不是"只新增文件"**：`lib.sh`、`preflight.sh`、`release.sh`、
`verify-release-archive.sh`、`build-release-archive.sh` 都被改写——这正是工单要解决的问题
（判据锚点散在多处且选错）。边界内**未触碰**：业务代码、数据库 schema、`prisma/`、
`infra/preproduction/docker-compose.yml`、`Dockerfile`、Nginx、真实 secrets、GHCR。

新增的共享模块 `scripts/preproduction/image-identity.mjs` 是工单 §2 所称
"scripts/preproduction 内必要的共享解析辅助模块"。

## 6. 被本例外解除阻塞、但仍待 Owner 产品决策的项

以下项此前的阻塞理由是「属 Codex 目录」，本例外解除了该理由，但它们本身还需要
Owner 的产品决策，不因例外自动开工：

- **新环境的站点名默认值**。当前新环境初始化出来仍是 `CPS Novel`，来源只有两处：
  `prisma/schema.prisma` 的 `@default("CPS Novel")`，以及
  `prisma/migrations/20260818120000_v020_foundation_shared/migration.sql` 的列 DEFAULT
  与 seed 行。代码里**没有**第三处兜底（行缺失时 `SiteSettingNotSeededError` fail closed）。
  已有环境的行不受默认值影响，仍需在后台改配置。
  改法：🔴 不能改既有迁移，只能新增一条
  `ALTER TABLE "site_setting" ALTER COLUMN "site_name" SET DEFAULT 'PulseNovel';`
  并同步 schema 与数据字典。**是否要改，待 Owner 拍板。**
