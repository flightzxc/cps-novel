# P1 · 正式实施分工冻结（P1-04 ～ P1-15）

> **Architecture Gate = OWNER_APPROVED**，进入正式开发。
> 不重新设计架构、不处理 SOL R-01～R-24、不修改 `candidate-v0.2.1`。
> 任务编号严格采用 Notion 正式编号 **P1-04～P1-15**，**不得重新编号**。
> P1-00～P1-03 归 Notion 台账管理（架构与 Gate 阶段），本表不覆盖；若 Notion 定义与本表冲突，**以 Notion 为准**。
>
> 🔴 本文件是**正式分工与目录所有权的唯一真源**，与 `P1_MODULE_OWNERSHIP.md` 冲突时以本文件为准。

---

## 1. 角色冻结

| 执行体 | 正式职责 |
| --- | --- |
| **Claude Code** | 架构设计总工程师 · 前端开发负责人 · **后台 UI 开发负责人** · ClaudeDesign 负责人 · 阅读器开发负责人 |
| **Codex** | 后端开发负责人 · PostgreSQL 数据库工程师 · Worker/Scheduler 工程师 · Auth/Credential/安全负责人 · **SOL 5.6 独立审计负责人** |
| **GPT + Notion** | 需求基线维护 · 前后端联调调度 · 依赖与 Gate 管理 · Notion 状态更新 |
| **Owner** | 产品与风险裁决 · 最终 Gate 放行 |

---

## 2. 目录所有权（唯一写入者，不存在共同维护）

### 2.1 Claude 独占写入

```
src/app/
src/components/
src/styles/
src/design/
src/features/admin-ui/
src/features/public-ui/
tests/ui/
```

### 2.2 Codex 独占写入

```
prisma/
src/server/
src/lib/db/
src/lib/auth/
src/lib/credentials/
src/lib/tasks/
src/lib/adapters/
worker/
scheduler/
infra/
scripts/
tests/backend/
tests/integration/
```

### 2.3 共享路径的唯一 merge custodian

**共享 ≠ 共同维护。** 每条共享路径有且只有一个合并人（custodian），另一方只有审核权，不直接合并。

| 路径 | Merge Custodian | 审核方 |
| --- | --- | --- |
| `src/contracts/` | **Claude 合并** | Codex 审核 |
| `src/domain/` | **Codex 合并** | Claude 审核 |
| `package.json` / lockfile / `tsconfig` / Next 配置 | **Claude 合并** | Codex 审核 |
| `Dockerfile` / compose / CI / `infra/` | **Codex 合并** | Claude 审核 |

**规则**：
1. 非 custodian 方通过 PR 提出改动，**由 custodian 合并**；
2. custodian 有义务在合并前取得审核方确认；
3. 🔴 **禁止任何路径出现两个写 Owner**；
4. 🔴 **禁止在任何文档中写"双方共同维护"**。

### 2.4 物理隔离（不可协商）

| 用途 | 路径 |
| --- | --- |
| **唯一可写** | `/Users/chenweifeng/Documents/产品原型及文档/cps海阅/cps-novel` |
| **只读参考** | `/Users/chenweifeng/Documents/产品原型及文档/cps项目/cps-admin-v811-search-ux` |

🔴 **禁止修改 CPS。** 每个任务交付时必须验证 CPS `git status --porcelain` = 0 行、HEAD 仍为 `d77c3b9`。

---

## 3. 任务分工表

### P1-04 · 新仓库和工程骨架

| 项 | 内容 |
| --- | --- |
| **主责** | **Claude** |
| **Reviewer** | Codex |
| **前置依赖** | 无（Architecture Gate 已放行） |
| **唯一写入目录** | 仓库根（`package.json` / `tsconfig` / Next 配置 / lint / CI 骨架）· `src/app/` · `src/components/` · `src/styles/` · `src/design/` · `src/features/` · `src/contracts/`（建目录与占位契约）· `docs/governance/` |
| **CPS 只读参考模块** | 工程配置（`tsconfig`、lint、Next 配置）、`src/lib/feature-flags.ts` 形态、`docs/governance/` 治理文件形态 |
| **CPS 复刻分类** | `CPS_PARITY_ADAPTED`（工程配置形态照搬，内容重写）；`tsconfig` 排除 `scripts/` 的做法 **不继承** |
| **交付物** | ① 可 `build` 的空骨架；② 目录树按 §2 建全（含 Codex 侧空目录与 `.gitkeep`）；③ `CLAUDE.md` 架构事实唯一真源；④ `docs/governance/port-registry.md` 空表 + 表头；⑤ `src/contracts/` 目录 + 契约占位文件；⑥ CI 骨架（lint + typecheck + test，可空跑） |
| **验收标准** | ① `npm run build` 通过；② `npm run typecheck` / lint 通过；③ 目录树与 §2 逐条一致；④ 无任何 CPS 路径引用（无 symlink / submodule / 相对路径）；⑤ CPS 工作区 `git status` = 0 行 |
| **开始条件** | ✅ **立即可开始** |
| **完成后交接对象** | **Codex**（解锁 P1-05 正式写文件）；**GPT+Notion**（更新 Notion 状态） |

---

### P1-05 · PostgreSQL Schema、Migration、约束和索引

| 项 | 内容 |
| --- | --- |
| **主责** | **Codex** |
| **Reviewer** | **Claude（复核领域模型）** |
| **前置依赖** | **P1-04**（骨架与 `src/contracts/` 路径就位） |
| **唯一写入目录** | `prisma/` · `src/domain/`（Codex 合并）· `src/lib/db/` · `docs/governance/database-governance.md` |
| **CPS 只读参考模块** | `prisma/schema.prisma`：渠道注册四表（`:99-246`）、`DramaSourceItem`（`:249-289`）、`DramaPromoLink`（`:292-326`）、推广审计（`:351-387`）、IndexNow 两表（`:1460-1519`）、指纹互斥模式（`:1236-1258`）、`home_carousel_*`（`:740-843`） |
| **CPS 复刻分类** | 渠道四表 / 推广资产 / 审计四段状态 / IndexNow / 指纹互斥 = `CPS_PARITY`；来源条目与任务表 = `CPS_PARITY_ADAPTED`；章节三表 = **`ORIGINAL_REQUIRED`**（CPS 无对应物）；`BatchTaskItem.dramaId` 非空 Int 形态 = **不继承**（泛化为 `target_type` + `target_id`） |
| **交付物** | ① Prisma Schema；② 初始 migration；③ 状态列 CHECK 约束；④ 软删部分唯一索引；⑤ **`public_redirect_code` 全局唯一且不排除软删**（修正 6.1）；⑥ 任务表含 `execution_token` + `lease_epoch`；⑦ `side_effect_intent` / `operation_audit` 两表；⑧ `database-governance.md` 字典 + 改动日志 |
| **验收标准** | ① `migrate` 在空库可跑通；② 所有状态列有 CHECK；③ 领取查询 `EXPLAIN` 走索引，**pending 与租约过期两条独立路径**（不得用 `OR` 合并）；④ 目录扫描互斥索引 = `(channel_account_id, channel_app_id, project_type)`；⑤ 章节三表经 Claude 领域评审签字；⑥ 无 `AS camelCase` 未加引号别名 |
| **开始条件** | 设计与草案**可并行准备**；🔴 **正式写文件必须等 P1-04 完成** |
| **完成后交接对象** | **Codex**（P1-06 / P1-07 / P1-08）；**Claude**（前台读契约据此定稿） |

---

### P1-06 · 数据库角色、备份和恢复方案

| 项 | 内容 |
| --- | --- |
| **主责** | **Codex** |
| **Reviewer** | **GPT+Notion** |
| **前置依赖** | P1-05 |
| **唯一写入目录** | `infra/` · `scripts/` · `docs/governance/` |
| **CPS 只读参考模块** | 无直接可搬（CPS 是 SQLite `.backup` 文件快照，SOP 整体作废） |
| **CPS 复刻分类** | **`ORIGINAL_REQUIRED`** —— 原因：CPS 备份方案基于单文件 SQLite，PG 下不可平移 |
| **交付物** | ① 五角色脚本（`migration_owner` / `web_app` / `worker_app` / `analyst_ro` / `backup_role`）；② 密文列对 `web_app`、`analyst_ro` REVOKE；③ `pg_dump` + WAL 归档 + PITR 方案；④ 恢复演练脚本；⑤ `analyst_ro` 的 `statement_timeout` |
| **验收标准** | ① 🔴 **完整恢复演练已执行并计时**，行数核对一致；② `web_app` 读密文列被拒绝（实测）；③ `analyst_ro` 写操作被拒绝；④ 应用**不使用 owner 角色**运行；⑤ Scheduler 容器**无凭证密钥**（修正 5.2） |
| **开始条件** | P1-05 完成 |
| **完成后交接对象** | **GPT+Notion**（Gate B 前置登记）；**Codex**（P1-12 Compose 接入） |

---

### P1-07 · Worker、Scheduler、任务租约和 fencing

| 项 | 内容 |
| --- | --- |
| **主责** | **Codex** |
| **Reviewer** | **SOL 5.6** |
| **前置依赖** | P1-05 |
| **唯一写入目录** | `worker/` · `scheduler/` · `src/lib/tasks/` |
| **CPS 只读参考模块** | `worker/index.ts`（`HANDLERS` 注册表 `:65-84`、超时表 `:41-61`）、`worker/guardrails.ts:28-44`、`src/lib/channel-sync-task.ts`（attempt 领取时计数 `:751-760`、状态派生 `:566-584`、stale 恢复 `:623-665`、检查点 `:827-835`）、`batch-task-stale-recovery.ts` |
| **CPS 复刻分类** | `HANDLERS` 注册 / 超时表 / allowlist 双重 fail-closed / attempt 领取时计数 / 状态派生 / item 级 stale 恢复 / 检查点 = `CPS_PARITY`；任务领取、active 互斥、item 租约、Cron 单例 = **`ORIGINAL_REQUIRED`**（CPS 实现建立在 SQLite 单进程前提，PG 下静默失效） |
| **交付物** | ① 原子领取（`FOR UPDATE SKIP LOCKED` + 同事务 update/audit）；② **`execution_token` + `lease_epoch` fencing**；③ 心跳续租（只延 `locked_until`，**不改** `lease_epoch`）；④ 独立 Scheduler + `(schedule_key, scheduled_bucket)` 唯一键；⑤ allowlist ∩ handlers 双重 fail-closed；⑥ dry-run 统一语义 |
| **验收标准** | ① 双 worker 同一任务只执行一次；② 🔴 **旧租约持有者提交被拒**（构造 `lease_epoch` 落后场景实测）；③ 杀进程重启后 item 恢复且 attempt 已 +1；④ 10 个 scheduler 只产生 1 次调度；⑤ allowlist 为空零消费；⑥ 目录扫描同账户×应用×projectType 单 active；⑦ dry-run 零上游副作用、零业务资产写入 |
| **开始条件** | P1-05 完成 |
| **完成后交接对象** | **SOL 5.6**（P1-14 审计输入）；**Codex**（P1-08 凭证任务在此之上执行） |

---

### P1-08 · Auth、Credential、后台 API 和能力位

| 项 | 内容 |
| --- | --- |
| **主责** | **Codex** |
| **Reviewer** | **Claude（复核前端契约）** |
| **前置依赖** | P1-05、P1-07（凭证任务由 Worker 执行） |
| **唯一写入目录** | `src/server/` · `src/lib/auth/` · `src/lib/credentials/` · `src/contracts/`（提 PR，**Claude 合并**） |
| **CPS 只读参考模块** | `src/lib/admin-capabilities.ts`（全文 81 行）、`channel-account/credential-crypto.ts`、`jwt.ts`、`service.ts:181-262`、`(admin)/channel-accounts/actions.ts`（六操作 + `*FromForm` 双层）、`src/proxy.ts:21-37`、2FA 全套（14 文件闭包） |
| **CPS 复刻分类** | 能力位模型 / AES 加密 / JWT 本地校验 / 三重校验 / 换证事务 / 指纹 DB 互斥 / 2FA 全套 / 六个凭证操作 = `CPS_PARITY`；三轨凭证 + `conflict` 态、`site_settings` 明文列、env 兜底 = **`DROP`**；**默认拒绝** = `ORIGINAL_REQUIRED`（CPS 现状是缺陷） |
| **交付物** | ① Auth + 2FA + 会话超时；② 能力位框架；③ 凭证单轨 + AES + 指纹互斥；④ 后台 API / Server Action；⑤ 🔴 **默认拒绝**保护清单；⑥ 🔴 **Web 不解密凭证**——凭证任务入队交 Worker；⑦ `src/contracts/` 中的 API 契约定义 |
| **验收标准** | ① 未登记 admin 路由/API/Action **实测 403/404**；② 六个凭证写操作**全部**有 `credential:manage` 门控；③ 🔴 **Web 进程无解密密钥**（配置层实测）；④ Web 侧永不回显密文；⑤ `jwt_missing` / `jwt_expired` 二分；⑥ 指纹冲突由 DB 唯一约束兜底；⑦ 前端契约经 Claude 签字 |
| **开始条件** | P1-05 完成（P1-07 未完成时可先做 Auth 部分，凭证执行链路待 Worker 就绪） |
| **完成后交接对象** | **Claude**（P1-09 后台 UI 消费这些 API）；**SOL 5.6**（安全审计输入） |

---

### P1-09 · 后台框架、菜单、字段与 CPS UI 复刻

| 项 | 内容 |
| --- | --- |
| **主责** | **Claude** |
| **Reviewer** | **Codex（复核权限与 API 使用）** |
| **前置依赖** | P1-04、P1-08（API 与能力位契约） |
| **唯一写入目录** | `src/app/` · `src/components/` · `src/features/admin-ui/` · `src/styles/` |
| **CPS 只读参考模块** | `src/components/layout/sidebar.tsx:39-72`（`NAV_ITEMS`）、`(admin)/**` 全部页面、`dramas-list-client.tsx:200-223`、`batch-wizard.tsx`（三步向导）、`task-auto-refresh.tsx`、`task-control-buttons.tsx`、`copy-value-button.tsx`、`(admin)/channel-accounts/page.tsx` |
| **CPS 复刻分类** | 菜单常量形态 / 折叠 / 活跃态 / 版本号低调展示 / 列表表头样式 / 三步批量向导 / 任务中心六列 / 自动刷新 / 复制按钮 / 二次确认弹窗 = `CPS_PARITY`；列字段 = `CPS_PARITY_ADAPTED`；试读管理页 = **`ORIGINAL_REQUIRED`** |
| **交付物** | ① 后台布局 + 侧栏 + 菜单常量；② 浅色主题（沿用 CPS 视觉）；③ 渠道账户页（消费 P1-08 六操作）；④ 通用列表/表单/弹窗基元；⑤ 权限驱动的菜单可见性；⑥ 敏感值掩码 + 能力位展开交互 |
| **验收标准** | ① 菜单与 `P1_ADMIN_PARITY_SPEC.md` §1 逐项一致（含"为什么不建"）；② 凭证 UI **从不回显密文**；③ 破坏性操作有二次确认；④ 批量入口默认 `draft` / `dry_run`；⑤ 公开短码可复制、渠道真实码掩码；⑥ 权限不足文案明确指出缺哪个能力；⑦ Codex 签字确认 API 使用与权限调用正确 |
| **开始条件** | P1-08 的 API 契约冻结后（不必等其全部实现，可用契约 mock 并行） |
| **完成后交接对象** | **Codex**（联调 P1-12）；**GPT+Notion**（Notion 状态） |

---

### P1-10 · 用户端深色设计系统和页面壳

| 项 | 内容 |
| --- | --- |
| **主责** | **ClaudeDesign + Claude** |
| **Reviewer** | **GPT+Notion（复核需求）** |
| **前置依赖** | P1-04 |
| **唯一写入目录** | `src/design/` · `src/styles/` · `src/features/public-ui/` · `src/app/` · `src/components/` |
| **CPS 只读参考模块** | `src/app/globals.css`（`--site-*` token 组织形态）；**视觉不参照**（CPS 是暖米色浅色，海外阅读是深色） |
| **CPS 复刻分类** | token 组织形态 = `CPS_PARITY_ADAPTED`；视觉体系 = **`ORIGINAL_REQUIRED`**（整体深色是新设计，且需与 CPS 视觉区隔） |
| **交付物** | ① `--novel-*` / `--reader-*` token 色值定稿；② 三个关键页视觉稿（首页 / 详情 / 章节）；③ 页面壳（布局、导航、页脚）；④ 基元深色适配；⑤ 对比度自检报告 |
| **验收标准** | ① 正文对比度 ≥ WCAG AA 4.5:1；② 焦点态可见、键盘可达；③ 基底不用纯黑、正文不用纯白；④ 组件零硬编码色值（全部走 token）；⑤ 无 Web Font；⑥ **设计稿不含作者/国家/完结三个位置**（字段恒 NULL） |
| **开始条件** | P1-04 完成；**D-12（目录承载形式）与 W6（品牌口径）需在视觉稿开工前给出** |
| **完成后交接对象** | **Claude**（P1-11 阅读器在此之上）；**GPT+Notion** |

---

### P1-11 · 阅读器主题、字号、行高、页宽、阅读位置和章节切换

| 项 | 内容 |
| --- | --- |
| **主责** | **Claude** |
| **Reviewer** | **Codex（复核数据契约）** |
| **前置依赖** | P1-10、P1-05（章节数据模型） |
| **唯一写入目录** | `src/features/public-ui/` · `src/components/` · `src/app/` · `src/styles/` |
| **CPS 只读参考模块** | **无** —— CPS 无阅读器（试看是视频跳转，语义不可平移） |
| **CPS 复刻分类** | **`ORIGINAL_REQUIRED`** —— 原因：CPS 零可复用的正文托管、分章渲染、阅读版式资产 |
| **交付物** | ① 主题三态（`system` 默认 / `light` / `dark`）**手动覆盖**；② 偏好 `localStorage` 持久化；③ 字号 / 行高 / 页宽可调；④ 阅读位置记忆与恢复（`novel + chapter` 粒度）；⑤ 🔴 **章节切换无整页刷新**（客户端路由） |
| **验收标准** | ① 手动主题覆盖生效且跨会话保持；② 四项排版参数可调且持久化；③ 阅读位置刷新后可恢复；④ 🔴 **章节切换不触发整页刷新**，阅读设置与上下文保持；⑤ 切换后 canonical / SEO metadata 仍正确（self-canonical）；⑥ 无账号体系下偏好不跨设备（预期行为） |
| **开始条件** | P1-10 token 定稿 + P1-05 章节模型定稿 |
| **完成后交接对象** | **Codex**（P1-13 集成测试）；**GPT+Notion** |

---

### P1-12 · 前后端契约联调和本地 Compose

| 项 | 内容 |
| --- | --- |
| **主责** | **Claude 与 Codex 分别在各自目录实施** |
| **Reviewer** | 互为 Reviewer |
| **调度** | **GPT+Notion**（🔴 **不允许双方修改同一文件**） |
| **前置依赖** | P1-06、P1-08、P1-09 |
| **唯一写入目录** | **Claude**：`src/contracts/`（合并）、`src/app/`、`src/features/`、`package.json`/`tsconfig`/Next 配置（合并）<br>**Codex**：`infra/`、`Dockerfile`/compose/CI（合并）、`src/server/`、`src/domain/`（合并）、`scripts/` |
| **CPS 只读参考模块** | `docker-compose.yml`（服务编排形态、flag 透传）、`deploy-preflight.sh`、`/api/health` 实现 |
| **CPS 复刻分类** | 编排形态 / 健康检查 / 构建元数据烘焙 / `CPS_APP_IMAGE` fail-closed = `CPS_PARITY_ADAPTED`；SQLite 相关配置 = **`DROP`** |
| **交付物** | ① 本地 Compose（web / worker / scheduler / postgres 四容器）；② `/api/health`（版本 / commit / flag 快照 / DB 连通 / 元数据一致性）；③ 契约联调通过；④ 构建元数据烘焙（不可被 env 覆盖） |
| **验收标准** | ① 一键起本地环境；② 四容器健康；③ 🔴 **Scheduler 容器无凭证密钥**（实测环境变量）；④ web 与 postgres 同机不同容器、走网络；⑤ `/api/health` 可检出镜像与 env 不一致；⑥ 🔴 **全程无双方同文件修改冲突**（GPT+Notion 出调度记录） |
| **开始条件** | P1-06 + P1-08 + P1-09 完成 |
| **完成后交接对象** | **Codex**（P1-13）；**GPT+Notion**（联调记录） |

---

### P1-13 · 测试、项目隔离检查、恢复 smoke test

| 项 | 内容 |
| --- | --- |
| **主责** | **Codex（后端与集成）** + **Claude（UI 与视觉）** |
| **汇总** | **GPT+Notion** |
| **前置依赖** | P1-12 |
| **唯一写入目录** | **Codex**：`tests/backend/`、`tests/integration/`、`scripts/`<br>**Claude**：`tests/ui/` |
| **CPS 只读参考模块** | `tests/` 组织形态；**`tests/test-global-setup.ts:11-28`（复制 `.db` 文件）不可用** |
| **CPS 复刻分类** | 测试组织形态 = `CPS_PARITY_ADAPTED`；测试库方案 = **`ORIGINAL_REQUIRED`**（改 `CREATE DATABASE … TEMPLATE` 或 per-worker schema） |
| **交付物** | ① 后端单测 + 集成测试；② UI / 视觉测试；③ 🔴 **项目隔离检查脚本**（验证无 CPS 路径引用、CPS 工作区未被写入）；④ 恢复 smoke test；⑤ 汇总报告 |
| **验收标准** | ① P1-04～P1-12 各自验收项全部有对应测试；② 隔离检查脚本通过：无 symlink / submodule / CPS 相对路径引用；③ 🔴 **CPS 工作区 `git status --porcelain` = 0 行**；④ 恢复 smoke test 通过并计时；⑤ 三方结果由 GPT+Notion 汇总入 Notion |
| **开始条件** | P1-12 完成 |
| **完成后交接对象** | **SOL 5.6**（P1-14） |

---

### P1-14 · 最终代码和架构审计

| 项 | 内容 |
| --- | --- |
| **主责** | **Codex（SOL 5.6）** |
| **Reviewer** | Claude 配合答辩，Owner 知悉 |
| **前置依赖** | P1-13 |
| **唯一写入目录** | `docs/`（审计报告）· `tests/integration/`（补充验证用例） |
| **CPS 只读参考模块** | 全部被搬运模块的原始出处（据 `port-registry.md` 逐条回溯） |
| **CPS 复刻分类** | 审计不产生复刻，只核验 |
| **交付物** | ① SOL 5.6 审计报告；② `port-registry.md` 完整性核验；③ 不符合项清单 + 严重度；④ 修复建议 |
| **验收标准** | ① 逐条核验 `P1_OWNER_MINIMUM_CORRECTIONS.md` 六项修正**全部落地**；② 22 条 `COPY_AS_IS` 不可简化项逐条核验；③ 每个搬入符号可回溯 CPS 来源与行号；④ 无未加引号的 `AS camelCase` 原生 SQL；⑤ fencing 有效性独立验证；⑥ 密钥面收敛独立验证 |
| **开始条件** | P1-13 完成 |
| **完成后交接对象** | **GPT+Notion**（P1-15） |

---

### P1-15 · P1 收口和 P2 交接

| 项 | 内容 |
| --- | --- |
| **主责** | **GPT+Notion** |
| **放行** | **Owner** |
| **前置依赖** | P1-14 |
| **唯一写入目录** | `docs/governance/`（版本台账、development-log）· Notion |
| **CPS 只读参考模块** | `docs/governance/version-registry.md` 形态 |
| **CPS 复刻分类** | 治理文档形态 = `CPS_PARITY` |
| **交付物** | ① P1 收口报告；② 三条硬前置验收证据（Worker 原子领取 / locale 单一真源 / 章节表定稿）；③ 遗留项与风险清单；④ P2 开工输入包；⑤ Notion 全量状态更新 |
| **验收标准** | ① P1-04～P1-14 全部 Notion 状态为完成；② 三条硬前置有可验证证据；③ 待决项（D-2 / D-7 / D-8 / D-12 / W6 / W9 / R3）状态明确；④ 🔴 **Owner 明确放行**才进 P2 |
| **开始条件** | P1-14 完成 |
| **完成后交接对象** | **Owner**（Gate 放行）→ **P2** |

---

## 4. 依赖图

```
P1-04 骨架 [Claude] ← 立即开始
   │
   ├─→ P1-05 Schema [Codex]（设计可并行；正式写文件等 P1-04）
   │      ├─→ P1-06 角色/备份 [Codex]
   │      ├─→ P1-07 Worker/Scheduler/fencing [Codex]
   │      └─→ P1-08 Auth/Credential/API [Codex]（凭证执行链路依赖 P1-07）
   │             └─→ P1-09 后台 UI [Claude]（契约冻结后即可并行）
   └─→ P1-10 深色设计与页面壳 [ClaudeDesign+Claude]
          └─→ P1-11 阅读器 [Claude]（另需 P1-05 章节模型）

P1-06 + P1-08 + P1-09 ─→ P1-12 联调与 Compose [双方分目录，GPT+Notion 调度]
                              └─→ P1-13 测试与隔离检查
                                     └─→ P1-14 SOL 5.6 审计 [Codex]
                                            └─→ P1-15 收口交接 [GPT+Notion] → Owner
```

**并行窗口**：
- P1-05 设计与 P1-04 并行；**正式写文件必须等 P1-04 的骨架与 `src/contracts/` 路径建立**；
- P1-10 与 P1-05～P1-08 全程并行（无后端依赖）；
- P1-09 在 P1-08 契约冻结后即可用 mock 并行，不必等其全部实现完成。

---

## 5. 冲突与越界处理

| 情形 | 处理 |
| --- | --- |
| 需要对方目录能力 | 在 `src/contracts/` 提契约 PR，由 custodian 合并，双方各自实现自己一侧 |
| 共享路径改动 | 非 custodian 提 PR，custodian 合并；custodian 合并前取得审核方确认 |
| 发现越界改动 | **先回退再讨论**，不在越界代码上叠加 |
| 契约语义分歧 | 架构设计总工程师（Claude）裁决 |
| 安全与数据一致性分歧 | Auth/Credential/安全负责人（Codex）裁决 |
| 需求与优先级分歧 | GPT+Notion 汇总 → Owner 裁决 |
| 生产阻塞的紧急越界 | 允许，但 PR 标 `CROSS_OWNER_HOTFIX`，24 小时内补契约并留痕 |

🔴 **绝对禁止**：任何路径出现两个写 Owner；任何文档写"双方共同维护"；修改 CPS 工作区。

---

## 6. 每个任务的通用完成检查

任务标记完成前，主责方必须自检：

1. 只写入了自己的唯一写入目录（共享路径经 custodian 合并）；
2. 从 CPS 搬运的符号已登记 `docs/governance/port-registry.md`（来源文件 + 行号 + 基线 commit + 改动说明）；
3. 🔴 CPS 工作区 `git status --porcelain` = **0 行**，HEAD 仍 `d77c3b9`；
4. 新项目无任何 CPS 路径引用（symlink / submodule / 相对路径）；
5. 涉及 `P1_OWNER_MINIMUM_CORRECTIONS.md` 六项修正的部分逐条对照；
6. Reviewer 已签字；
7. GPT+Notion 已更新 Notion 状态。

---

```text
RESULT=P1_IMPLEMENTATION_ASSIGNMENT_READY
NEXT_TASK=P1-04
```
