# 版本台账

记录本项目对外可辨识的版本号变更和阶段里程碑。阶段完成不等于发布或部署。

## 同步纪律

版本号需在 `package.json`、`Dockerfile` 构建参数（`APP_VERSION` / `NEXT_PUBLIC_BUILD_VERSION`）、
compose / 环境变量（`.env.example`、`infra/preproduction/preprod.env.example` 及目标机
`/opt/cps-novel/shared/env/preprod.env`）之间保持一致。P1-12 已落地不可变构建 metadata、
Compose runtime 与 Health 身份一致性验证（`/api/health` 的 `metadataConsistency`，见
`src/server/health/service.ts`）；正式远端 CI 和发布流程仍未配置，不得把本地门禁结果登记
为已发布。

> Notion 权威页：**待新建后回填链接**（由 ChatGPT 按发版治理规程在海阅项目文档下新建
> 独立发版手账页后，由 Owner 回填本行）。本文件是仓库内的镜像，Notion 台账需人工同步；
> 本文件变更不会自动写入 Notion。

## 当前快照

### v0.3.0 —— 准备中（未发布）

- Owner 裁决（2026-09-23）：本轮版本号定为 v0.3.0，借此消除此前"git tag `v0.2.0` 已存在、
  `package.json` 仍是 `0.1.0`"的版本身份漂移（历史与收尾说明见下方台账，以及
  `docs/adr/ADR-DEPLOYMENT-ARTIFACT-DISTRIBUTION.md` §8.2、
  `docs/adr/ADR-PREPRODUCTION-MAINTENANCE-DEPLOYMENT.md` 的追加说明）。
- 本轮计划合入的分支：`fix/preprod-approved-open-write-gates`、
  `feat/upstream-call-observability`、`chore/release-v0.3.0-prep`（本分支：版本身份统一 +
  开发日志解冻为发版级 + `AI_WORKFLOW.md` 发版治理段 + 本台账改版）。
- 本轮**不上线**：第二阶段生命周期 / 自动分片能力（分支 `feat/promo-claim-lifecycle-v1`）
  仍在施工中（截至 2026-09-23：第 1、2 步已复核，第 3 步施工中，共 5 步）；五步全部完成并复核前
  不交主控并入。即便日后并入，开关 `PROMO_CLAIM_LIFECYCLE_V1_ENABLED` 代码默认 `false`，
  等于未上线；预生产开启须另经 Owner 批准。
- **未发布、未部署、未打 tag**——本节只是发版准备阶段的记录，不得视为已发布版本。
  v0.3.0 的最终发布日期、合入分支清单与实际 Bump 结果，在正式发布完成后由发版执行者
  据实更新本节。

## 台账（Registry）

| Version | Date (+0800) | Bump | Summary | Commit / Release | Status |
| --- | ---: | --- | --- | --- | --- |
| `v0.3.0` | 发布时填写 | MINOR | 版本身份统一到 0.3.0（package.json / 环境变量模板 / 镜像版本前缀）；开发日志解冻为发版级记录；`AI_WORKFLOW.md` 新增发版治理段；版本台账改为 CPS 同款格式。详见"当前快照" | 发布时填写 | 🟡 准备中（未发布） |
| 预生产部署 | 2026-09-22（约 15:24） | — | 基础资产补齐 + 合回 PR #8/#9 多语成果（CanonicalTag 1,845 格公开多语译名落库），`RELEASE=PASS` | 镜像 `cps-novel:0.1.0-9728551`；merge commit `97285515b00b2f6d810b2944f8daf1f5aef10ad8`（PR #24，author date 2026-09-22T16:16:46+09:00） | ✅ 预生产部署成功；未打 tag |
| 预生产部署 | 2026-09-22（约 11:35） | — | 预生产首次正式部署：等待服务健康再验证；失败 trap 由可静默失败改为 fail-closed，`RELEASE=PASS` | 镜像 `cps-novel:0.1.0-921119d`；merge commit `921119dc3c6544848aad7d306c2525c7971ed376`（PR #23，author date 2026-09-22T12:02:04+09:00） | ✅ 预生产首次正式部署成功；未打 tag |
| `v0.2.0` | 2026-08-19（01:47） | MINOR | P2-07～P2-12 轮次：publish gate、公开站、缓存失效、sitemap、IndexNow、验收收口 | annotated tag `v0.2.0` → `eb7dd9d60d5cef38c5343fc6cfa383533c0d8570` | 已打 tag、已合入 main；未部署（当时 `package.json` 仍为 `0.1.0`，即已知版本身份漂移，已于 v0.3.0 统一） |
| `v0.1.0` | 未核实（分支持续演进，无法从当前 tip 可靠核实里程碑落地日期） | — | M0–M12 launch parity：后台核心能力、首页轮播、模板/文章/分类、安全设置与公开 SEO consumer 一次性交付 | `feature/launch-parity-operating-surfaces`（本地） | LOCAL_IMPLEMENTED；OWNER_PUSH_GATE；UNRELEASED；UNDEPLOYED |
| `v0.1.0` | 2026-08-06 | — | P1-15：P1 收口报告、风险债务登记与 P2 交接输入包 | `feature/v0.1.0-p1-15-closeout` → `62453d2cf4fb756b4c614d560b4522b3d07df067`（"docs(p1-15): close P1 and prepare P2 handoff"） | WAITING_FOR_GPT_NOTION_AND_OWNER_GATE |
| `v0.1.0` | 2026-08-05 | MINOR | P1-04～P1-14：P1 工程底座、Schema/运维、Worker/Scheduler、Auth/Credential、后台与公共 UI、阅读器、四容器/Health、最终测试和只读审计 | `main@fb8cddbdf7c8ff6b566169eade4a89258e7db668` | P1_LOCAL_COMPLETE；UNRELEASED；UNDEPLOYED |

注：两条预生产部署行的日期取自 Owner 提供的部署执行时间（约数）；对应 merge commit 的
author date（+0900 换算 +0800 后分别为 2026-09-22 11:02:04 与 2026-09-22 15:16:46）与之相差
数十分钟，落在"合并代码 → 实际执行发布脚本"的正常间隔内，作为交叉核验依据一并列出，
不代表两者本应完全相等。`v0.1.0` M0–M12 一行的分支在原始里程碑之后仍有大量后续 commit
（如 2026-09-10 的 i18n 测试），故未采用分支当前 tip 的日期，只标注"未核实"，避免误导。

## 远端同步状态

- P1 最终本地 `main`：`fb8cddbdf7c8ff6b566169eade4a89258e7db668`；
- 本轮只读观察的缓存 `origin/main`：`36c9ca6e8b39ec3041a845bb55d246412ac0ea79`；
- 本地 `main` 相对缓存 remote-tracking ref：ahead 52、behind 0；
- P1-15 未 fetch、未 push；远端服务器实时状态 `NOT_VERIFIED`；
- 未发布、未部署、未执行生产数据库操作。
