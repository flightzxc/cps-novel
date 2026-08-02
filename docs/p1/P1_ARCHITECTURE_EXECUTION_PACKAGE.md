# 海外阅读 P1 · 架构执行包（P1-01 / P1-02）

> 状态：**架构冻结材料**。`FORMAL_CODING = NOT_STARTED`。
> 🔴 **Codex 必须通过 SOL 5.6 审计后，才能进入 P1 编程。** 本包不是开工许可。
> 生成日期：2026-08-02
> 上游依据：`candidate-v0.2.1`（六份架构候选 + parity 复核 + CHANGELOG）
> CPS 只读参照基线：`d77c3b968285698529cf97c7f0f97b286d7a2a9c`（工作区 `cps-admin-v811-search-ux`，v8.1.1，勘察前后 `git status --porcelain` 均为 0 行）
> 写入根目录：`/Users/chenweifeng/Documents/产品原型及文档/cps海阅/cps-novel`（**唯一允许写入处**）

---

## 0. 这份包解决什么问题

P1 的目标不是"做出功能"，而是**让两个执行体（Claude / Codex）能在同一套契约下并行开工而不互相踩踏**。所以本包只回答四个问题：

1. **抄什么** —— CPS 已验证的后台形态、字段、权限、闸门，逐项建立复刻矩阵（`P1_CPS_PARITY_MATRIX.md`）；
2. **谁写哪里** —— 目录所有权与越界规则（`P1_MODULE_OWNERSHIP.md`）；
3. **接口长什么样** —— 跨所有权边界的共享契约（`P1_SHARED_CONTRACTS.md`）；
4. **长什么样子** —— 用户端深色设计（`P1_DARK_DESIGN_BRIEF.md`）与后台复刻清单（`P1_ADMIN_PARITY_SPEC.md`）。

**本包不产出**：Prisma Schema、Migration、Worker、Adapter、正式页面实现、数据库、Docker Compose。

---

## 1. P1 的边界

### 1.1 P1-01 与 P1-02 的定义（对齐立项书 §14.1）

| ID | 立项书原文 | 本包的交付形态 |
| --- | --- | --- |
| **P1-01** | 独立正式仓库规划（命名、分支策略、CI、`CLAUDE.md` 单一真源、搬运来源登记表） | 本文档 §2–§4 + `P1_MODULE_OWNERSHIP.md` |
| **P1-02** | PostgreSQL 16 架构落地（Compose · volume · 健康检查 · 连接池 · `statement_timeout`） | 本文档 §5（**架构与参数冻结，不写 compose 文件**） |

⚠️ 立项书 §14.1 给 P1-02 的验收是"本地与预生产均可一键起"。**本轮不做**——那属于 SOL 5.6 审计通过后的编程阶段。本轮只冻结**参数与形态**，让审计有可审对象。

### 1.2 渠道范围（Owner 2026-08-02 补充）

| 渠道 | V1 状态 | 说明 |
| --- | --- | --- |
| 畅读 / MoboReader（`projectType=1`） | **active** | 唯一已完成接口调研的渠道，V1 全链路基于它 |
| 北斗 | **占位，二期开启** | **接口尚未调研**。表与流程先参照 CPS 短剧形态占位（含系统后台）；`Channel` 登记 `inactive`、Adapter 能力 `registered_disabled`、worker 不消费其任务类型 |

🔴 **占位纪律**：结构预留 + 显式禁用 ≠ 可以凭 CPS 短剧协议猜写北斗请求体。北斗的 Endpoint / Body / 幂等规则一律 `UNPROVEN`。

这条同时是**渠道抽象的试金石**：如果二期接北斗需要动表结构或前台代码，说明第一渠道的抽象做漏了。前台对渠道零感知是硬契约（`P1_SHARED_CONTRACTS.md` §10）。

### 1.3 本轮明确不做

- ❌ Prisma Schema / Migration / `prisma generate`
- ❌ Worker 进程、Adapter 实现、任何页面组件
- ❌ 创建数据库、启动容器、写 `docker-compose.yml`
- ❌ 修改 CPS 工作区（只读勘察，前后 `git status --porcelain` = 0）
- ❌ 在 `cps-novel/` 之外的任何路径写文件

---

## 2. 仓库形态冻结

### 2.1 命名与位置

| 项 | 取值 |
| --- | --- |
| 本地根 | `/Users/chenweifeng/Documents/产品原型及文档/cps海阅/cps-novel` |
| 远端仓库 | `flightzxc/cps-novel`（已存在，当前承载架构候选归档） |
| 与 CPS 的关系 | **零共享**：独立仓库、独立数据库、独立域名、独立部署、独立凭证。不 fork、不 monorepo 抽包 |

### 2.2 目录骨架（冻结，实现时按此建）

```
cps-novel/
├─ CLAUDE.md                    ← 架构事实唯一权威源（继承 CPS 治理形态）
├─ docs/
│  ├─ p1/                       ← 本包
│  ├─ architecture/             ← candidate-v0.2.1 的正式化落点
│  └─ governance/
│     ├─ database-governance.md ← DB 字典 + 改动日志（CPS 同名文件的形态）
│     ├─ version-registry.md    ← 版本台账
│     ├─ development-log.md
│     └─ port-registry.md       ← 搬运来源登记表（见 §2.4）
├─ prisma/                      ← P1 编程阶段才建
├─ src/
│  ├─ app/
│  │  ├─ (admin)/               ← 后台，Codex 主责
│  │  ├─ [locale]/(site)/       ← 前台，Claude 主责
│  │  └─ go/[code]/             ← 跳转，Codex 主责
│  ├─ components/
│  │  ├─ admin/                 ← Codex
│  │  ├─ site/                  ← Claude
│  │  └─ ui/                    ← 共享基元（改动需双方确认）
│  ├─ lib/                      ← 见 P1_MODULE_OWNERSHIP.md 逐目录划分
│  └─ styles/
├─ worker/                      ← Codex
├─ scheduler/                   ← Codex
└─ tests/
```

### 2.3 分支策略

继承 CPS 已验证形态：

| 分支 | 用途 |
| --- | --- |
| `main` | 唯一长期分支 |
| `feature/<version>-<slug>` | 功能开发，如 `feature/v0.1.0-p1-foundation` |
| `hotfix/<version>-<slug>` | 紧急修复 |
| `release/<version>-<slug>` | 发布集成 |

**冻结规则**：版本号在 `package.json` / `Dockerfile` / compose / `src/lib/app-version.ts` 必须同步（CPS `v7.10.0` INT-4 的做法），发布前有一致性测试。

### 2.4 搬运来源登记表（`docs/governance/port-registry.md`）

**每一个从 CPS 搬入的符号都必须可查到来源。** 表结构冻结为：

| 列 | 说明 |
| --- | --- |
| `symbol` | 搬入后的符号名 |
| `source_file` | CPS 原始文件路径 |
| `source_lines` | 原始行号区间 |
| `baseline_commit` | **`d77c3b9`**（本项目统一基线） |
| `port_kind` | `COPY` / `ADAPT` / `PG_REIMPLEMENT` / `PATTERN_ONLY` |
| `changed_what` | 改了什么、为什么 |
| `owner` | Claude / Codex |

这张表是 SOL 审计的输入之一：任何"看起来像 CPS 但没登记"的代码都应被质疑。

---

## 3. 执行体分工与开工顺序

### 3.1 三个角色

| 角色 | 职责 | 本包中的落点 |
| --- | --- | --- |
| **架构设计总工程师**（Claude） | 契约冻结、复刻矩阵、审计口径、跨模块一致性 | 全部六份文档 |
| **前端开发负责人**（Claude） | 前台 `[locale]/(site)` 与 `components/site`、深色主题实现 | `P1_MODULE_OWNERSHIP.md` §2、`P1_DARK_DESIGN_BRIEF.md` |
| **ClaudeDesign 设计负责人** | 用户端视觉出稿（深色）、设计 token 定义 | `P1_DARK_DESIGN_BRIEF.md` |
| **Codex**（外部执行体） | 后台 `(admin)`、`worker/`、`scheduler/`、`lib` 中的渠道与任务层 | `P1_MODULE_OWNERSHIP.md` §3 |

### 3.2 硬性开工顺序

```
本包冻结
   ↓
SOL 5.6 审计  ← 🔴 阻塞点，未通过不得进入编程
   ↓
P1 编程阶段（Codex + Claude 并行，按目录所有权）
   ↓
P1 三条硬前置验收（Worker 原子领取 / locale 单一真源 / 章节表定稿）
   ↓
Owner Gate → P2
```

### 3.3 三条不可调换的硬前置（沿用 candidate-v0.2.1）

1. **Worker 原子领取必须在 P2 开始前做对**——P2 的扫描、物化、推广读取全跑在它上面；
2. **`locale-canonical.ts` 单一真源必须在写入任何多语言数据之前建好**——CPS 为缺这一步付过两次全库归一；
3. **章节三表设计必须在 P1 定稿**——它决定 P2 模板字段、P3 同步粒度、P4 归因维度，且 CPS 无对应物。

---

## 4. 复刻总原则

### 4.1 三级复刻判定

| 级别 | 含义 | 处理 |
| --- | --- | --- |
| `CPS_PARITY` | CPS 有成熟实现，形态与语义都照搬 | 按 CPS 做，登记 port-registry |
| `CPS_PARITY_ADAPTED` | 形态照搬，数据/命名/协议换小说语义 | 按 CPS 结构做，内容替换，登记差异 |
| `ORIGINAL_REQUIRED` | CPS 无对应物，或 CPS 现状本身是反例 | **必须说明原因**，单独设计并标注风险 |

**默认判定是 `CPS_PARITY`。** 选 `ORIGINAL_REQUIRED` 需要举证——这是本包的基本纪律，逐项判定见 `P1_CPS_PARITY_MATRIX.md`。

### 4.2 按符号切，不按文件闭包

CPS 依赖闭包审计的结论：M10 sitemap 的 27 文件闭包里有 3 个北斗 HTTP 文件，只因 `sitemap.ts:12` 引了一个常量；M11 import 的 40 文件 / 8,819 行闭包里 `nodejieba` 与 `sharp` 各由一个符号拖入。

**搬运纪律**：只搬需要的符号；发现闭包泄漏先切断再搬；每个搬入符号登记 port-registry。

### 4.3 原生 SQL 纪律（🔴 PG 静默故障防线）

CPS 中 `AS camelCase` 形态本轮独立计数 **67 处**（`src` + `scripts` + `worker`）。PG 会把未加引号的别名折叠成小写，`row.taskName` 变 `undefined` 且**不报错**。

**规则**：搬运任何带原生 SQL 的模块，一律改 Prisma 查询；确需原生 SQL 时别名必须加双引号；搬运后逐个断言返回字段非 `undefined`。**特别点名**：`home-carousel-config.ts:101` 的别名会让轮播静默回落默认配置。

---

## 5. P1-02 · PostgreSQL 架构参数冻结

**本节只冻结参数与形态，不写任何配置文件。**

### 5.1 拓扑

```
单 VPS 实例（Day 0）
  ├─ web        容器（Next SSR，无 cron）
  ├─ worker     容器（任务执行，可多副本）
  ├─ scheduler  容器（cron 单例，只入队不干活）
  └─ postgres   容器（同机不同容器，走网络不走共享文件）
        └─ volume（持久化）
对象存储：封面 / 运营上传物 / sitemap 静态产物
```

### 5.2 冻结参数

| 项 | 取值 | 依据 |
| --- | --- | --- |
| PostgreSQL 大版本 | **16** | 立项书 §3.1（已冻结 PG 原型跑的是 18.4，以立项书为准；未依赖 16 之后特性） |
| 数据库角色 | `migration_owner` / `web_app` / `worker_app` / `analyst_ro` / `backup_role` | 立项书 X7 |
| 应用运行角色 | **绝不使用 owner** | — |
| 凭证密文列权限 | 对 `web_app`、`analyst_ro` **REVOKE**；仅 `worker_app` 可读 | 安全架构字典 |
| `analyst_ro` | 必带 `statement_timeout` | 立项书 §3.5 |
| 连接池 | 先用 Prisma 自带；连接数吃紧再上 PgBouncer（transaction 模式） | 立项书 §3.5 |
| `max_connections` | 显式设定；各容器池上限之和留 **30% 余量** | — |
| 慢查询 | `log_min_duration_statement`，阈值先定 **500ms** | — |
| 可观测 | `pg_stat_statements` + 慢查询日志 + 连接数告警 | 立项书 §3.5 |
| 备份 | 每日 `pg_dump` + WAL 归档 + PITR，异地留存 | 立项书 §3.5 |
| 恢复演练 | **P1 内必须执行一次完整恢复并计时** | R5，Gate B 前置 |
| 健康检查 | `/api/health`：版本 / commit / flag 快照 / DB 连通性 / 元数据一致性 | CPS `v7.9.5` 事故治理 |
| 构建元数据 | `/app/.build-metadata.json` 烘焙，**不可被 env 覆盖** | CPS §9.4 |
| 镜像参数 | `CPS_APP_IMAGE` 类参数 **fail-closed**，不给 `latest` 兜底 | CPS §9.4 |
| 端口暴露 | **禁止容器端口绕过防火墙直连公网**（CPS 有过 Docker DNAT 绕过 UFW 的敞口） | — |

### 5.3 何时才升级（未触发前引入即过度设计）

| 组件 | 触发条件 |
| --- | --- |
| PgBouncer | 连接数达 `max_connections` 70%，或 web 副本 > 3 |
| 只读副本 | 前台读让主库 CPU 持续 > 60%，且已确认非缺索引 |
| 独立分析库 | 分析查询影响线上 P95，且 `statement_timeout` 已不够用 |
| ClickHouse | 埋点量级达千万行/月且 PG 聚合无法优化 |
| Elasticsearch | 搜索需求超出"标题/简介 LIKE + 有界结果"（CPS `v8.1.0` 是可参照的低成本路径） |
| 分区表 | 单表 > 1 亿行，或按时间清理成为主要运维负担 |

**Day 0 一律不上**：独立审计库、Redis、K8s、多区域、事件溯源、CQRS、GraphQL 网关、微服务拆分、物化视图、Kafka。

### 5.4 容量口径

实测单章 2.2–11.9 KB，取 3 章/本，9.5 万本 ≈ **0.7–2 GB** 正文，PG + TOAST 压缩后更低。**结论：正文直接进 PG，不需要对象存储正文、不需要冷热分层。**

---

## 6. P1 任务清单（12 项，映射立项书 P1-01~P1-12）

| ID | 任务 | 所有者 | 前置 | 冻结状态 |
| --- | --- | --- | --- | --- |
| P1-01 | 仓库规划、分支策略、CI 骨架、`CLAUDE.md`、port-registry | Claude | — | ✅ 本包 §2 |
| P1-02 | PG 架构参数与三容器编排形态 | Codex | P1-01 | ✅ 本包 §5（**参数冻结，文件待编程**） |
| P1-03 | 数据模型草案：`novel` / `novel_source_item` / `novel_chapter` / `novel_chapter_content` | Claude 定稿 → Codex 落地 | P1-01 | ✅ candidate-v0.2.1 逻辑模型 |
| P1-04 | 任务两级模型 + `targetType`/`targetId` 泛化 + `CatalogScanTask` | Codex | P1-03 | ✅ 逻辑模型 §2.13 |
| P1-05 | 鉴权 / 2FA / 能力位（`requireAdminSession` **改默认拒绝**） | Codex | P1-01 | ✅ 复刻矩阵 §2 |
| P1-06 | Feature Flag + Allow Write 双闸基础设施 | Codex | P1-01 | ✅ 复刻矩阵 §4 |
| P1-07 | 🔴 Worker 原子领取 + item lease（硬前置 1） | Codex | P1-02, P1-04 | ✅ 契约文档 §4 |
| P1-08 | Cron 唯一执行（移出 web 进程） | Codex | P1-07 | ✅ 契约文档 §4.7 |
| P1-09 | 🔴 `locale-canonical.ts` 单一真源（硬前置 2） | Claude | P1-01 | ✅ 共享契约 §3 |
| P1-10 | 凭证单轨（只保留 `ChannelAccountCredential` + AES + 指纹互斥） | Codex | P1-03 | ✅ 复刻矩阵 §7 |
| P1-11 | 备份、真实恢复演练、五角色权限 | Codex | P1-02 | ✅ 本包 §5.2 |
| P1-12 | 发布回滚 SOP + 构建元数据烘焙 + `/api/health` 陈旧 env 检测 | Codex | P1-02 | ✅ 本包 §5.2 |

**🔴 标记的两项是硬前置**，第三条硬前置（章节表定稿）落在 P1-03。

---

## 7. P1 验收口径

沿用 candidate-v0.2.1 计划文档的 P1 验收，共 10 条：

| # | 验收项 |
| ---: | --- |
| 1 | 两个 worker 副本同时轮询，同一任务只被执行一次 |
| 2 | 两个并发入队请求，只有一个建出 active task；**目录扫描按账户×应用×projectType 单 active** |
| 3 | 杀 worker 重启，未完成 item 恢复且 attempt 已 +1 |
| 4 | 10 个 scheduler 实例只产生 1 次调度 |
| 5 | 任务领取查询走索引（`EXPLAIN` 证明，**pending 与租约过期两条独立路径**） |
| 6 | allowlist 为空时零消费 |
| 7 | `web_app` 角色读凭证密文列被拒绝 |
| 8 | 备份恢复演练成功，行数核对一致 |
| 9 | 所有状态列有 CHECK 约束 |
| 10 | 单一语种真源是唯一映射实现（全仓无第二处） |

**领取 SQL 的踩坑（PG 原型 `SANDBOX_PROVEN`）**：不得用 `OR` 把"待领取"与"租约过期"合成一个谓词——原型 L 轮因此绕过 pending 偏索引，在 1,694/100,000 处停滞。两条路径必须各走各的偏索引。

---

## 8. SOL 5.6 审计的可审对象

本包为审计提供以下可审物，审计通过前 **Codex 不得进入 P1 编程**：

| 审计维度 | 可审对象 |
| --- | --- |
| 复刻完整性 | `P1_CPS_PARITY_MATRIX.md`——逐项判定 + `ORIGINAL_REQUIRED` 举证 |
| 边界清晰度 | `P1_MODULE_OWNERSHIP.md`——目录所有权 + 越界规则 |
| 接口稳定性 | `P1_SHARED_CONTRACTS.md`——跨所有权契约 + 冻结级别 |
| 安全防线 | 本包 §5.2（角色/密文/端口）+ 复刻矩阵 §7（凭证）+ §8（审计脱敏） |
| 前台形态 | `P1_DARK_DESIGN_BRIEF.md` |
| 后台形态 | `P1_ADMIN_PARITY_SPEC.md` |
| 不可简化项 | candidate-v0.2.1 契约文档 §5 的 22 条 `COPY_AS_IS` |

### 审计应重点质疑的三处

1. **凡标 `ORIGINAL_REQUIRED` 的**——是真的没有 CPS 对应物，还是没找？
2. **凡涉及原生 SQL 的搬运**——别名是否加引号、是否改成了 Prisma？
3. **凡涉及有副作用上游调用的**——写前意图审计是否先提交、反重复闩是否在？

---

## 9. 交付物索引

| 文件 | 内容 |
| --- | --- |
| `P1_ARCHITECTURE_EXECUTION_PACKAGE.md` | 本文件：边界、仓库形态、PG 参数、任务清单、验收、审计对象 |
| `P1_CPS_PARITY_MATRIX.md` | 十一个维度的逐项复刻判定 + `ORIGINAL_REQUIRED` 举证 |
| `P1_MODULE_OWNERSHIP.md` | Claude / Codex 目录所有权、越界规则、冲突解决 |
| `P1_SHARED_CONTRACTS.md` | 跨所有权边界的共享契约与冻结级别 |
| `P1_DARK_DESIGN_BRIEF.md` | 用户端深色设计说明（ClaudeDesign 出稿口径） |
| `P1_ADMIN_PARITY_SPEC.md` | 后台 UI 复刻清单：菜单、页面、字段、安全交互 |

---

## 10. 合规声明

- 写入范围：仅 `/Users/chenweifeng/Documents/产品原型及文档/cps海阅/cps-novel`
- CPS 工作区：**只读勘察**，勘察前后 `git status --porcelain` 均为 **0 行**，HEAD 仍为 `d77c3b9`
- 本轮未创建：Prisma / Migration / Worker / Adapter / 页面实现 / 数据库 / 容器
- 本轮未修改：candidate-v0.1 / v0.2 / v0.2.1 任何文件

```text
RESULT=P1_ARCH_PACKAGE_READY
NEXT=WAIT_SOL_5.6_AUDIT
```
