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

### v0.4.1 —— 已发布到预生产（2026-09-24 16:27 +0800，`RELEASE=PASS`；生命周期开关开启）

- 身份：Final SHA `0a2546968d258304990918276b201026c8cccf66`，annotated tag `v0.4.1`，开发线
  `integration/v0.4.1-2026-09-24`（基于 `c4bdcbb`）；镜像 `cps-novel:0.4.1-0a25469`（linux/amd64，config digest
  `sha256:c6336cafb97c0261d8772b6b5fbd4148b6293e3077934988b5f46467f37e2882`，归档 sha256
  `b6fe79a64f699afc8561ef5b593436a9e3a56ac72c50fb4a4b9ad21fde05abf4`）；发布目录
  `/opt/cps-novel/releases/0a2546968d258304990918276b201026c8cccf66`；`/api/health` 版本 0.4.1、commit `0a25469`、
  `metadataConsistency=passed`。
- 合入：`feat/catalog-sync-promo-link-status-filter` @ `42114d9`（待办 B-4，经 Opus 复核；首版因全量 ID 拼
  in/notIn 在 8 万规模报错被打回，改为库内关联过滤并补 3.6 万+ 规模回归测试）+ 版本身份升到 0.4.1。
- **已上线**：目录同步页"推广链接状态"筛选（未领取 / 已领取 / 人工核对中，与书目状态、语种取交集）；领取资格列把
  有码书显示为"已有推广码"、人工核对中的书显示为"人工核对中"；全选提交后枚举与界面筛选共用同一判定。部署后
  以同一口径只读核对：俄语已建立书目 2,978 = 已领取 156 + 人工核对中 0 + 未领取 2,822。
- 数据库：无迁移、无 grants 变更。配置：目标机 `APP_VERSION` 0.4.0→0.4.1、`NEXT_PUBLIC_BUILD_VERSION`
  v0.4.0→v0.4.1（备份 `preprod.env.bak-20260924T082608Z`）；生命周期开关保持开启。发布前逻辑备份
  `cps-novel-20260924T082520Z.dump`。
- 构建备注：公司网络下 Docker 构建两次因 npm 官方源超时失败（依赖层因版本号变更失去缓存），切换网络后第三次成功；
  未改动 `.npmrc` / Dockerfile 等构建输入。
- 回滚到 `8e83da4`（v0.4.0）：代码层面完全兼容（无迁移 / grants / compose 变更）；两个版本变量改回 0.4.0 即可。

### v0.4.0 —— 已发布到预生产（2026-09-24 01:33 +0800，`RELEASE=PASS`；生命周期开关关闭）

- 身份：Final SHA `8e83da49f79f3943a6c6062f5f5b1014a3a72e67`，annotated tag `v0.4.0`，开发线
  `integration/v0.4.0-2026-09-24`（基于 `1da7ed7`）；镜像 `cps-novel:0.4.0-8e83da4`（linux/amd64，
  config digest `sha256:048442eba9011020a74a78940984ebce00449678a14feca17210d5dba3f9c873`，归档 sha256
  `42f857f9ad0b0f19560433bee9fb92c0caf6c3f8f2210358fc53ad467a2e99e3`）；发布目录
  `/opt/cps-novel/releases/8e83da49f79f3943a6c6062f5f5b1014a3a72e67`；`/api/health` 版本 0.4.0、
  commit `8e83da4`、`metadataConsistency=passed`。
- 合入：`feat/promo-claim-lifecycle-v1` @ `537490e`（领推广链接生命周期与自动分片，正式修复第 2 阶段，
  23 提交，逐步经 Opus 复核）+ 版本身份升到 0.4.0。
- 范围四档：**已合入但开关默认关闭（等于未上线）**——生命周期与自动分片全部能力（预生产
  `PROMO_CLAIM_LIFECYCLE_V1_ENABLED` 未设置，发版前检查确认 `enabled=false`）；**已上线（与开关无关）**——
  scheduler_app 最小权限（已核实读不到凭据密文）、发版前生命周期配置校验、已终态旧路径父批次不再显示
  中止按钮、单任务暂停/恢复对生命周期分片返回 409；**进行中**——新渠道凭据录入与验证、开关开启与三级
  真实 UAT（`docs/operations/PROMO_CLAIM_LIFECYCLE_UAT_PLAN_2026-09-24.md`，选项 C），均须 Owner 另行授权。
- 数据库：无迁移；grants 新增 scheduler_app 最小权限。配置：目标机 `APP_VERSION` 0.3.0→0.4.0、
  `NEXT_PUBLIC_BUILD_VERSION` v0.3.0→v0.4.0（备份 `preprod.env.bak-20260923T173306Z`）。发布前逻辑备份
  `cps-novel-20260923T172917Z.dump`。
- 回滚到 `a31a146`（v0.3.0）：库结构兼容；两个版本变量改回 0.3.0；旧 grants 重放去掉 scheduler 新权限，
  对旧代码无害。详见 `docs/governance/development-log.md` 发版记录。

### v0.3.0 —— 已发布到预生产（2026-09-23 23:26 +0800，`RELEASE=PASS`）

- 身份：Final SHA `a31a1468816904920bcf326537426bfe0d4a1ae4`，annotated tag `v0.3.0`，
  开发线 `integration/v0.3.0-2026-09-23`（基于 `a9317e5`）；镜像 `cps-novel:0.3.0-a31a146`
  （linux/amd64，config digest `sha256:f49585279286575994b558eaa6106f4c1112f8fffa440789dba446d42e2b4130`，
  归档 sha256 `de4284d9bc2450a38b4f021eb3e373cc17bac769fa5b278300ab8b8bcd94aeb9`）；发布目录
  `/opt/cps-novel/releases/a31a1468816904920bcf326537426bfe0d4a1ae4`；`/api/health` 版本 0.3.0、
  commit `a31a146`、`metadataConsistency=passed`。
- Owner 裁决（2026-09-23）：版本号定为 v0.3.0，消除"tag `v0.2.0` 已存在、`package.json` 仍是
  `0.1.0`"的版本身份漂移（见 `docs/adr/ADR-DEPLOYMENT-ARTIFACT-DISTRIBUTION.md` §8.2、
  `docs/adr/ADR-PREPRODUCTION-MAINTENANCE-DEPLOYMENT.md` 的追加说明）。
- 合入：`fix/preprod-approved-open-write-gates` @ `b9fe386`（写闸登记制 + 凭据 blocker 重评估）、
  `chore/release-v0.3.0-prep` @ `f8dc929`（版本身份 + 发版治理）、
  `feat/upstream-call-observability` @ `3dd996c`（上游请求观测）、`23cce42`（X8 镜像清理）、
  `6ac60f3`（CLAUDE.md）、`a31a146`（隔离守卫测试修复）。
- **已上线**：以上全部。**已合入但开关默认关闭**：无。**进行中、未上线**：领推广生命周期与
  自动分片（第 2 阶段，`feat/promo-claim-lifecycle-v1`，开关 `PROMO_CLAIM_LIFECYCLE_V1_ENABLED`
  代码默认 `false`），计划 `v0.4.0`。
- 数据库：无迁移、无 grants 变更。配置：目标机 `APP_VERSION` 0.1.0→0.3.0、
  `NEXT_PUBLIC_BUILD_VERSION` v0.1.0→v0.3.0（备份 `preprod.env.bak-20260923T152433Z`）。
  发布前逻辑备份 `cps-novel-20260923T135245Z.dump`。
- 回滚到 `9728551`：库结构兼容；须先把两个版本变量改回 0.1.0，并先经批准关闭两组写闸
  （旧版发版前检查不认登记制）。详细记录见 `docs/governance/development-log.md` 的发版记录。

## 台账（Registry）

| Version | Date (+0800) | Bump | Summary | Commit / Release | Status |
| --- | ---: | --- | --- | --- | --- |
| `v0.4.1` | 2026-09-24（16:27） | PATCH | 目录同步页推广链接状态筛选（未领取 / 已领取 / 人工核对中）与"已有推广码"显示（待办 B-4）。详见"当前快照" | annotated tag `v0.4.1` → `0a2546968d258304990918276b201026c8cccf66`；镜像 `cps-novel:0.4.1-0a25469`；`RELEASE=PASS` | ✅ 预生产已发布；生产未上线 |
| `v0.4.0` | 2026-09-24（01:33） | MINOR | 领推广链接生命周期与自动分片（正式修复第 2 阶段，开关默认关闭、未上线）；scheduler_app 最小权限；发版前生命周期配置校验。详见"当前快照" | annotated tag `v0.4.0` → `8e83da49f79f3943a6c6062f5f5b1014a3a72e67`；镜像 `cps-novel:0.4.0-8e83da4`；`RELEASE=PASS` | ✅ 预生产已发布（生命周期开关关闭）；生产未上线 |
| `v0.3.0` | 2026-09-23（23:26） | MINOR | 预生产写闸登记制 + 凭据 blocker 重评估与一套环境一套凭据；上游请求观测（领推广正式修复第 1 阶段）；版本身份统一到 0.3.0；开发日志发版级 + 发版治理 + 台账 CPS 格式；X8 镜像清理按版本形状。详见"当前快照" | annotated tag `v0.3.0` → `a31a1468816904920bcf326537426bfe0d4a1ae4`；镜像 `cps-novel:0.3.0-a31a146`；`RELEASE=PASS` | ✅ 预生产已发布；生产未上线 |
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
