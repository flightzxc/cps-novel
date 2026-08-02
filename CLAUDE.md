# CLAUDE.md

本文件是 **cps-novel 项目架构事实的唯一权威源**。任何与本文件冲突的口头约定、旧草稿、聊天记录一律以本文件为准（除非按下方"冲突裁决顺序"另有更高优先级来源）。

---

## 1. 项目身份

**cps-novel（海外阅读）**：面向海外用户的网文/小说 CPS 分发站。

- 独立于 CPS 短剧站（下称"CPS"）：**零共享**——独立代码仓库、独立数据库、独立域名、独立部署环境、独立凭证体系；
- 技术栈独立：Next.js + TypeScript + PostgreSQL（CPS 是 SQLite）；
- 视觉体系独立：本项目用户端是深色设计，CPS 是暖米色浅色，两者刻意区隔，不共享 token；
- 与 CPS 的唯一关系：**CPS 的既有代码作为只读参考**，用于评估哪些工程形态/模式值得复刻（`CPS_PARITY` / `CPS_PARITY_ADAPTED`）、哪些不适用（`DROP`）、哪些需要全新设计（`ORIGINAL_REQUIRED`）。

---

## 2. 物理隔离（不可协商）

| 用途 | 路径 | 权限 |
| --- | --- | --- |
| **本项目（唯一可写）** | `/Users/chenweifeng/Documents/产品原型及文档/cps海阅/cps-novel` | 读 + 写 |
| **CPS 参考（只读）** | `/Users/chenweifeng/Documents/产品原型及文档/cps项目/cps-admin-v811-search-ux` | **只读**，基线 commit `d77c3b968285698529cf97c7f0f97b286d7a2a9c` |

硬性约束：

1. 所有代码、配置、文档**只能**写入本仓库根目录之下；
2. **CPS 工作区任何情况下不得写入**——包括临时文件、日志、缓存、测试产物；
3. 每个任务交付节点必须验证 CPS 工作区 `git status --porcelain` 为 **0 行**，`HEAD` 仍为 `d77c3b968285698529cf97c7f0f97b286d7a2a9c`；
4. **禁止**以 symlink、git submodule、相对路径引用等任何方式把 CPS 目录接入本项目构建；
5. 从 CPS 搬运代码一律**复制 + 改造**，并登记 `docs/governance/port-registry.md`（来源文件、行号、基线 commit、改动说明）——未登记的搬运视为违规；
6. 文档中提及 CPS 参考路径时，只使用上表这一条绝对路径，不得散落引用其他 CPS 内部路径写法。

---

## 3. 目录所有权表（唯一写入者，不存在共同维护）

🔴 **任何路径不得有两个写 Owner。禁止在任何文档中写"双方共同维护"。**

### 3.1 Claude 独占写入

```
src/app/
src/components/
src/styles/
src/design/
src/features/admin-ui/
src/features/public-ui/
src/lib/locale/
src/lib/seo/
src/lib/slug/
tests/ui/
```

### 3.2 Codex 独占写入

```
prisma/
src/server/
src/lib/db/
src/lib/auth/
src/lib/credentials/
src/lib/tasks/
src/lib/adapters/
src/lib/app/
src/lib/flags/
src/lib/redirect/
worker/
scheduler/
infra/
scripts/
tests/backend/
tests/integration/
```

### 3.2.1 `src/lib/` 子目录分权与唯一真源

🔴 **`src/lib/` 根目录不放任何文件**，只作为子目录容器。每个子目录有唯一 Owner；新增子目录必须先在本表登记。

| 子目录 | Owner | 唯一真源文件 |
| --- | --- | --- |
| `src/lib/app/` | Codex | `app-version.ts` |
| `src/lib/flags/` | Codex | `feature-flags.ts` |
| `src/lib/redirect/` | Codex | `public-redirect-code.ts` |
| `src/lib/locale/` | **Claude** | `locale-canonical.ts` |
| `src/lib/seo/` | **Claude** | — |
| `src/lib/slug/` | **Claude** | — |
| `src/lib/db/` `auth/` `credentials/` `tasks/` `adapters/` | Codex | — |

四条「唯一真源」路径不得在别处出现第二份实现：

```
src/lib/locale/locale-canonical.ts      语种映射唯一真源
src/lib/redirect/public-redirect-code.ts 公开跳转码唯一生成入口
src/lib/app/app-version.ts               版本与构建元数据
src/lib/flags/feature-flags.ts           Feature Flag 与写入闸
```

### 3.3 共享路径的唯一 merge custodian

**共享 ≠ 共同维护。** 每条共享路径有且只有一个合并人（custodian），另一方只有审核权，不直接合并。

| 路径 | Merge Custodian | 审核方 |
| --- | --- | --- |
| `src/contracts/` | **Claude 合并** | Codex 审核 |
| `src/domain/` | **Codex 合并** | Claude 审核 |
| `package.json` / lockfile / `tsconfig` / Next 配置 | **Claude 合并** | Codex 审核 |
| `Dockerfile` / compose / CI / `infra/` | **Codex 合并** | Claude 审核 |

规则：

1. 非 custodian 方通过 PR 提出改动，由 custodian 合并；
2. custodian 有义务在合并前取得审核方确认；
3. 🔴 **禁止任何路径出现两个写 Owner**；禁止在任何文档中写「双方共同维护」；
4. `src/lib/` 根目录不放普通文件，只作为子目录容器——分权见 §3.2.1。

---

## 4. 冲突裁决顺序

当不同文档对同一事项的表述不一致时，按以下优先级取高者：

1. **Notion 任务台账**（正式任务编号与状态的唯一真源）
2. `docs/p1/P1_OWNER_MINIMUM_CORRECTIONS.md`（Owner 最小修正，六项修正的最高优先级说明）
3. `docs/p1/P1_IMPLEMENTATION_ASSIGNMENT.md`（正式分工与目录所有权的唯一真源）
4. 其余 P1 文档（`P1_ARCHITECTURE_EXECUTION_PACKAGE.md`、`P1_MODULE_OWNERSHIP.md`、`P1_ADMIN_PARITY_SPEC.md`、`P1_CPS_PARITY_MATRIX.md`、`P1_DARK_DESIGN_BRIEF.md`、`P1_SHARED_CONTRACTS.md` 等）
5. `docs/architecture/candidate-v0.2.1`（架构候选文档，已冻结不改）

本 `CLAUDE.md` 是对以上来源的浓缩摘要，用于日常查阅；出现表述分歧时以上述优先顺序原文为准。

---

## 5. Owner 六项最小修正摘要

以下摘自 `docs/p1/P1_OWNER_MINIMUM_CORRECTIONS.md`（2026-08-02 Owner 裁决），是**必须生效**的六项修正，优先级仅次于 Notion 台账。完整条文以原文件为准。

### 修正 1 · 任务编号与职责分界

正式任务编号唯一真源是 Notion `P1-00～P1-15`，不得重新编号、不得自造编号。职责分界冻结：**Claude 负责前台、后台 UI、设计、阅读器**；**Codex 负责后端、数据库、Auth、Credential、Worker、Scheduler、Adapter**。关键澄清：**后台 UI 归 Claude**——Codex 只负责后台背后的 API、能力位与数据，页面与交互由 Claude 实现。

### 修正 2 · 物理隔离

见本文件第 2 节，条文以 `P1_OWNER_MINIMUM_CORRECTIONS.md` 修正 2 为准。

### 修正 3 · Worker at-least-once + fencing

投递语义冻结为 **at-least-once**（非 exactly-once），业务侧必须幂等且需 fencing 防止旧租约持有者写入。核心机制：`execution_token`（本次执行所有权凭证）+ `lease_epoch`（单调递增租约世代号，每次租约重新分配含超时回收/抢占都 +1）。🔴 铁律：**旧租约持有者不得提交业务结果**——每次业务写入必须在同一事务内带 `WHERE execution_token = ? AND lease_epoch = ?` 的 fencing 条件，不匹配则拒绝且不得重试；心跳续租只延 `locked_until`，不改 `lease_epoch`。

### 修正 4 · 副作用意图与操作审计的事务边界

两张审计表事务边界不同：`side_effect_intent`（外部调用前**独立提交**，先于外部调用落地，绝不与外部调用共享未提交事务，意图未被结果确认时禁止自动重试）；`operation_audit`（与本地业务写**同事务**，保证"写了业务必有审计"，也是不建独立审计库的根本原因——跨库无法同事务）。

### 修正 5 · 默认拒绝与密钥面收敛

未显式登记为公开的 Admin 路由 / API 路由 / Server Action **一律拒绝**（不是"忘了加校验就放行"，而是"没登记就 403/404"）。凭证密钥面：**Web 不解密凭证**（不持有解密密钥，不读密文列）；**Worker 是唯一可解密方**，所有需要凭证的任务由 Worker 执行；**Scheduler 无密钥**，只负责到点建任务。Web 可展示凭证元数据（指纹前缀、过期时间、状态），永不回显密文。

### 修正 6 · 公开短码唯一性与阅读器能力

`public_redirect_code` **全局唯一、永不复用、创建后不可变**——即使原 PromoLink 被软删除/撤回，已分配的码也不回收再分配；其唯一索引**不排除软删**（与其他表"部分唯一索引排除软删"的通用做法相反，是本字段的特例）；唯一生成入口归 Codex 所有，禁止 Adapter/业务模块自行生成。阅读器必须具备七项能力：手动主题覆盖（`system`/`light`/`dark` 三态，`system` 为默认，手动覆盖优先级更高）、`localStorage` 持久化、字号可调、行高可调、页宽可调、阅读位置记忆（`novel + chapter` 粒度）、**章节切换无整页刷新**（客户端路由，保持阅读设置与滚动上下文）。此修正使 `P1_DARK_DESIGN_BRIEF.md` §3"V1 不做站内手动主题切换器"的表述作废。

---

## 6. 技术栈

- **前端**：Next.js 16 + React 19 + TypeScript 5 + Tailwind CSS v4
- **测试**：Vitest
- **数据库**：PostgreSQL 16（由 P1-05 落地 Schema/Migration，P1-06 落地角色与备份方案）
- **包管理**：npm（见 `package.json` 的 `packageManager` 字段）

---

## 7. 开发命令

```bash
npm run dev        # 本地开发服务器
npm run build      # 生产构建
npm run typecheck  # tsc --noEmit
npm run lint       # eslint
npm run test       # vitest run
```

---

## 8. 当前阶段

**P1-04（新仓库和工程骨架）已完成**：目录树按第 3 节所有权表建全，Codex 侧空目录含 `.gitkeep` 占位，`docs/governance/` 治理文档骨架就位，本 `CLAUDE.md` 建立。

**下一步：P1-05（Codex，PostgreSQL Schema、Migration、约束和索引）**——设计与草案可与 P1-04 并行准备，但正式写文件需等本任务（P1-04）交付确认后开始。P1-05 完成后解锁 P1-06 / P1-07 / P1-08。
