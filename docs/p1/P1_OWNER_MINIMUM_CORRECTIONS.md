# P1 · Owner 最小修正说明

> **Owner 裁决（2026-08-02）**：保留 `candidate-v0.2.1` 与现有 P1 六份架构文件。
> **不接受**按 SOL R-01～R-24 重新设计整套架构。
> 本文件是**唯一新增**的修正说明，仅列六项必须生效的修正。
>
> 🔴 **效力**：本文件与既有文档冲突时，**以本文件为准**；其余部分既有文档继续有效。
> **完成本说明后，P1 Architecture Gate 视为 Owner 批准，可进入正式开发。**

---

## 修正 1 · 任务编号与职责以 Notion 为准

**正式任务编号唯一真源：Notion `P1-00～P1-15`。**

任何文档、PR、提交信息、审计报告引用 P1 任务时，一律使用 Notion 编号，**不得重新编号、不得自造编号**。

若既有文档（含 `P1_ARCHITECTURE_EXECUTION_PACKAGE.md` §6 的任务表）与 Notion 编号不一致，**以 Notion 为准**；既有文档中的编号视为早期草稿映射，不再作为执行依据。

### 职责分界（冻结）

| 执行体 | 负责 |
| --- | --- |
| **Claude** | 前台、**后台 UI**、设计、阅读器 |
| **Codex** | 后端、数据库、Auth、Credential、Worker、Scheduler、Adapter |

**关键澄清**：后台 UI 归 **Claude**。Codex 负责后台背后的 API、能力位与数据，但**页面与交互由 Claude 实现**。这修正了 `P1_MODULE_OWNERSHIP.md` §1 中"`src/app/(admin)/**` Owner = Codex"的划分——详见 `P1_IMPLEMENTATION_ASSIGNMENT.md` 的正式目录所有权表。

---

## 修正 2 · 物理隔离：固定新项目与 CPS 只读目录

| 用途 | 绝对路径 | 权限 |
| --- | --- | --- |
| **新项目（唯一可写）** | `/Users/chenweifeng/Documents/产品原型及文档/cps海阅/cps-novel` | 读 + 写 |
| **CPS 参考（只读）** | `/Users/chenweifeng/Documents/产品原型及文档/cps项目/cps-admin-v811-search-ux` | **只读** |

**硬性约束**：

1. 所有正式代码、配置、文档**只能**写入新项目根目录；
2. **CPS 工作区任何情况下不得写入**——包括临时文件、日志、缓存、测试产物；
3. 每个交付节点必须验证 CPS 工作区 `git status --porcelain` 为 **0 行**，HEAD 仍为 `d77c3b968285698529cf97c7f0f97b286d7a2a9c`；
4. 不得在新项目中以符号链接、git submodule、相对路径引用等方式把 CPS 目录接入构建；
5. 从 CPS 搬运代码一律**复制 + 改造**，并登记 `docs/governance/port-registry.md`（来源文件、行号、基线 commit、改动说明）。

---

## 修正 3 · Worker 采用 at-least-once + fencing

**投递语义冻结为 `at-least-once`**（不是 exactly-once）。因此**业务侧必须幂等**，且必须有 fencing 防止旧租约持有者写入。

### 机制

| 字段 | 责任 |
| --- | --- |
| `execution_token` | 本次执行的所有权凭证 |
| `lease_epoch` | **单调递增的租约世代号**。每次租约被重新分配（含超时回收、抢占）时 +1 |

### 铁律

🔴 **旧租约持有者不得提交业务结果。**

具体要求：

1. 每次租约分配生成新的 `execution_token` 并使 `lease_epoch` +1；
2. Worker **每一次业务写入**都必须在同一条语句/事务中带上 `WHERE execution_token = ? AND lease_epoch = ?` 的 fencing 条件；
3. fencing 条件不匹配（说明租约已被回收或重新分配）→ **该次写入必须被拒绝**，Worker 放弃本轮结果并退出该 item，**不得重试写入**；
4. 心跳续租只延长 `locked_until`，**不改变** `lease_epoch`；只有租约易主才 +1；
5. 因 at-least-once 而可能重复执行的所有上游调用与本地写入，必须由幂等键保证幂等（`PromoLink.idempotency_key`、`dedupe_key`、`(url, revision)` 等）。

**这条修正强化了** `candidate-v0.2.1` 中的"显式租约（`locked_by` / `locked_until` / `execution_token`）"——新增 `lease_epoch` 与显式 fencing 条件，把"旧持有者写不进来"从约定升级为**数据库层强制**。

---

## 修正 4 · 副作用意图与操作审计的事务边界

两张审计的事务边界**不同**，不得混为一谈：

### `side_effect_intent` —— 外部调用前**独立提交**

```
写 side_effect_intent 行  →  COMMIT（独立事务，必须先落地）
        ↓
调用外部接口（有副作用）
        ↓
回读 / 写回结果
```

🔴 **绝不允许**把 `side_effect_intent` 的 insert 与外部调用包在同一个尚未提交的事务里——否则进程崩溃后无法判断请求是否已发出，反重复闩失效。

配套：意图行未被结果确认时，**禁止自动重试**，转人工复核（`claim_retry_blocked`）。

### `operation_audit` —— 与本地业务写**同事务**

```
BEGIN
  写业务表
  写 operation_audit
COMMIT
```

🔴 保证"写了业务必有审计"，不出现审计缺失的业务变更。这也是**不建独立审计库**的根本原因——跨库无法同事务。

| 审计类型 | 事务边界 | 目的 |
| --- | --- | --- |
| `side_effect_intent` | **独立先提交**，早于外部调用 | 崩溃后可判断"是否已发出" |
| `operation_audit` | **与业务写同事务** | 保证业务与审计原子一致 |

---

## 修正 5 · 默认拒绝与密钥面收敛

### 5.1 Admin / API / Action 默认拒绝

**未显式登记为公开的 Admin 路由、API 路由、Server Action 一律拒绝。**

- 不是"忘了加校验就放行"，而是"没登记就 403/404"；
- 新增任何 admin 路由/API/Action，必须显式登记进保护清单才能访问；
- 这修正了 CPS "靠每个 route 自觉调 `requireAdminSession()`" 的缺陷形态。

### 5.2 凭证密钥面收敛

| 进程 | 凭证权限 |
| --- | --- |
| **Web** | 🔴 **不解密凭证**。不持有解密密钥，不读密文列（数据库角色层 REVOKE） |
| **Worker** | ✅ 唯一可解密方。**所有需要凭证的任务由 Worker 执行** |
| **Scheduler** | 🔴 **无密钥**。只负责"到点建任务"，不接触凭证、不执行业务 |

推论：

1. 后台点击"校验凭证""同步"等操作，Web 侧只**入队任务**，实际执行在 Worker；
2. Web 可展示凭证**元数据**（指纹前缀、过期时间、状态），**永不回显密文**；
3. Scheduler 容器不注入 `CHANNEL_CREDENTIAL_ENCRYPTION_KEY` 类环境变量；
4. 密钥泄露面从三个进程收敛到一个。

---

## 修正 6 · 公开短码唯一性与阅读器能力

### 6.1 `public_redirect_code` 全局唯一且永不复用

| 约束 | 说明 |
| --- | --- |
| 全局唯一 | 数据库 `UNIQUE` 约束 |
| **永不复用** | 🔴 已分配过的码**永不回收再分配**给其他内容——即使原 PromoLink 被软删除或撤回 |
| 不可变 | 创建后不重新生成：重跑同步、换执行体、上游真实码变化，公开码均不变 |
| 唯一生成入口 | `src/lib/…/public-redirect-code`（Codex 所有），禁止任何 Adapter/业务模块自行生成 |
| 公开面 | `/go/{public_redirect_code}` 只按公开码查；渠道真实码 `upstream_code` **绝不进公开 URL** |

**"永不复用"的实现要求**：唯一索引**不得**是排除软删的部分索引——软删行必须继续占位，防止码被回收。这与其他表"部分唯一索引排除软删"的通用做法**相反**，是本字段的特例。

理由：公开短码一旦被外部链接、被搜索引擎收录、被埋点记录，复用会导致历史流量被错误归因到新内容。

### 6.2 阅读器能力（修正既有设计说明）

🔴 **本条修正 `P1_DARK_DESIGN_BRIEF.md` §3 中"V1 不做站内手动主题切换器"的表述——该表述作废。**

阅读器必须具备以下能力：

| 能力 | 要求 |
| --- | --- |
| **手动主题覆盖** | 在 `prefers-color-scheme` 跟随之上，提供用户手动切换（浅/深/跟随系统） |
| **持久化** | 用户偏好本地持久化（无账号体系，用 `localStorage`），跨会话保持 |
| **字号** | 可调 |
| **行高** | 可调 |
| **页宽** | 可调 |
| **阅读位置** | 记忆并恢复（按 `novel + chapter` 粒度） |
| **章节切换** | 🔴 **无整页刷新**——客户端路由切换，保持阅读设置与滚动上下文 |

**优先级说明**：跟随系统仍是**默认**行为；手动覆盖是用户显式选择后的**更高优先级**。三态语义：`system`（默认）/ `light` / `dark`。

**对既有文档的影响**：
- `P1_DARK_DESIGN_BRIEF.md` §3 "V1 不做站内主题切换器" → **作废**；
- 同文件 §8 "明确不做"中的"站内主题切换器""完整阅读器交互（字号调节、阅读进度）" → **部分作废**，上表七项能力纳入 V1；
- 仍然不做的：翻页器交互（长章仍为段落分块连续渲染）、Web Font、账号级偏好同步。

---

## 生效范围与冲突处理

| 文档 | 状态 |
| --- | --- |
| `candidate-v0.2.1`（10 文件） | **保留，不修改** |
| P1 既有六份架构文件 | **保留，不修改** |
| 本文件 | **新增，最高优先级** |
| `P1_IMPLEMENTATION_ASSIGNMENT.md` | 正式分工与目录所有权的唯一真源 |

**冲突裁决顺序**：Notion 任务台账 > 本文件 > `P1_IMPLEMENTATION_ASSIGNMENT.md` > P1 既有六份 > `candidate-v0.2.1`。

---

```text
P1_ARCHITECTURE_GATE = OWNER_APPROVED
FORMAL_DEVELOPMENT = UNBLOCKED
```
