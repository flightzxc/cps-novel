# 海外阅读 P1 · 模块所有权与目录契约

> 目的：让 Claude 与 Codex 能并行开工而不互相踩踏。
> 生效前提：**SOL 5.6 审计通过**。本文件本身是审计对象，不是开工许可。

---

## 0. 三条所有权铁律

1. **一个目录只有一个 owner。** 跨 owner 的改动必须走共享契约（`P1_SHARED_CONTRACTS.md`），不允许直接改对方目录。
2. **契约先行。** 需要对方提供能力时，先在共享契约里定义签名与语义，双方各自实现自己那一侧。契约未冻结前不得开始依赖它的实现。
3. **越界即回退。** 发现越界改动，先回退再讨论；不在越界代码上继续叠加。

---

## 1. 所有权总表

| 目录 | Owner | 说明 |
| --- | --- | --- |
| `src/app/(admin)/**` | **Codex** | 后台全部页面与 server actions |
| `src/app/api/**` | **Codex** | 内部 API |
| `src/app/go/[code]/**` | **Codex** | 跳转路由（与推广资产同侧） |
| `src/app/[locale]/(site)/**` | **Claude** | 前台全部页面 |
| `src/app/layout.tsx` / `globals.css` | **Claude** | 根布局与主题变量 |
| `src/components/admin/**` | **Codex** | 后台组件 |
| `src/components/site/**` | **Claude** | 前台组件 |
| `src/components/ui/**` | **共享**（改动需双方确认） | 基元组件（Button / Input / Table / Dialog…） |
| `src/lib/` | 见 §2 逐目录 | — |
| `src/styles/**` | **Claude** | 设计 token、主题 |
| `worker/**` | **Codex** | 任务执行 |
| `scheduler/**` | **Codex** | cron 单例 |
| `prisma/**` | **Codex**（Schema 由 Claude 定稿评审后落地） | 见 §3 |
| `docs/architecture/**`、`docs/p1/**` | **Claude** | 架构与契约文档 |
| `docs/governance/**` | **共享**（各自登记自己的改动） | DB 字典、版本台账、port-registry |
| `tests/**` | 各自负责自己模块的测试 | 跨模块集成测试归 Codex |

---

## 2. `src/lib/` 逐目录划分

| 子路径 | Owner | 理由 |
| --- | --- | --- |
| `lib/adapters/**` | **Codex** | 渠道协议实现 |
| `lib/channel/**`（注册表、账户、凭证） | **Codex** | 渠道与凭证 |
| `lib/tasks/**`（任务工厂、租约、状态派生） | **Codex** | 任务体系 |
| `lib/promo/**`（PromoLink、公开短码、审计） | **Codex** | 推广资产 |
| `lib/revenue/**` | **Codex** | P4 占位 |
| `lib/indexnow/**` | **Codex** | outbox 与投递 |
| `lib/sitemap/**` | **Codex** | 产物生成（Claude 提供 URL 构造规则） |
| `lib/tracking/**` | **Codex** | 埋点写入 |
| `lib/auth/**`、`lib/admin-capabilities.ts`、`lib/feature-flags.ts` | **Codex** | 鉴权、能力位、开关 |
| **`lib/locale-canonical.ts`** | **Claude** | 🔴 单一语种真源，硬前置 2；**全项目唯一映射实现** |
| `lib/site/**`（前台查询层） | **Claude** | 前台读路径 |
| `lib/seo/**`（模板引擎、metadata、canonical） | **Claude** | SEO 口径 |
| `lib/slug/**`、`lib/public-page-id.ts` | **Claude** | 页面身份与 slug |
| **`lib/public-redirect-code.ts`** | **Codex** | 🔴 公开短码唯一生成入口（与 PromoLink 同侧） |
| `lib/db.ts`、`lib/datasource-url.ts` | **Codex** | 数据库连接 |
| `lib/constants.ts` | **共享** | 只放跨侧共用常量；渠道/前台专属常量各自放自己目录 |

### 两个"唯一真源"文件的特别约束

| 文件 | Owner | 约束 |
| --- | --- | --- |
| `lib/locale-canonical.ts` | Claude | 上游语种码 → 站点 locale 的**唯一**映射。**全仓禁止第二处语种映射硬编码**，lint 规则卡住新增映射表。CPS 为缺这一步付过两次全库 normalize 的代价 |
| `lib/public-redirect-code.ts` | Codex | 公开跳转码的**唯一**生成入口。禁止任何 Adapter / 业务模块自行生成短码；DB 唯一约束兜底；创建后不可变 |

**这两个文件任一出现"第二处实现"，都视为架构违规，直接回退。**

---

## 3. Prisma Schema 的特殊流程

Schema 是唯一需要双方共同确认的产物——它同时约束前台读和后台写。

```
Claude 出逻辑模型定稿（已在 candidate-v0.2.1）
   ↓
Codex 转 Prisma Schema 草案
   ↓
Claude 评审：字段责任 / 唯一键 / 索引 / jsonb 边界 / CHECK 约束 / 软删部分唯一
   ↓
双方签字 → 落 docs/governance/database-governance.md（字典 + 改动日志）
   ↓
Codex 落 migration
```

🔴 **任何 DB 改动必须同步 `database-governance.md`。** 这是 CPS 已确立的治理纪律，海外阅读第一天就执行。

---

## 4. 北斗（第二渠道）占位的所有权

> Owner 2026-08-02 补充：**北斗接口尚未调研。北斗的表与流程先参考 CPS 短剧形态占位（含系统后台），二期再开启。**

| 项 | 处置 | Owner |
| --- | --- | --- |
| 渠道注册表 | `Channel` 表登记 `beidou` 行，`status = 'inactive'` | Codex |
| Adapter | 能力注册表登记 `beidou` 全部能力为 `registered_disabled`，`reason_code = channel_not_researched` | Codex |
| 表与流程形态 | **以 CPS 短剧链路为占位参照**（`beidou-list-sync` / `batch_promo` 的形态），不实现协议 | Codex |
| 后台 | 渠道账户页支持多渠道选择，北斗选项**可见但禁用**并显示原因 | Codex |
| 前台 | **零感知**——前台按 `Novel` / `Article` 读，不关心来源渠道 | Claude |
| 何时开启 | **二期**（Post-V1），需先完成接口调研 | — |

**占位的纪律**：占位意味着"结构预留 + 显式禁用"，**不意味着可以凭 CPS 短剧协议猜写北斗请求体**。北斗的 Endpoint / Body / 幂等规则一律 `UNPROVEN`，与 `claimPromo` 同一处置口径。

---

## 5. 越界规则

### 5.1 需要对方目录的能力时

```
1. 在 P1_SHARED_CONTRACTS.md 新增/修改契约条目（提 PR，双方 review）
2. 契约冻结后，owner 侧实现，调用侧按签名接入
3. 契约未冻结 → 调用侧不得先写"临时实现"占位
```

### 5.2 紧急情况（生产阻塞）

允许越界热修，但必须：① 当次 PR 标 `CROSS_OWNER_HOTFIX`；② 24 小时内补契约条目；③ 在 port-registry 或 development-log 留痕。

### 5.3 冲突解决

| 冲突类型 | 裁决方 |
| --- | --- |
| 契约语义分歧 | 架构设计总工程师（Claude） |
| 后台交互形态 | 参照 `P1_ADMIN_PARITY_SPEC.md`，以 CPS 现状为准 |
| 前台视觉 | ClaudeDesign |
| 数据模型 | 双方评审，不一致时以 candidate-v0.2.1 逻辑模型为准 |
| 均无先例 | 升 Owner |

---

## 6. 共享基元的改动规则（`src/components/ui/**`）

这是唯一双方都会改的代码目录，规则从严：

1. **只放无业务语义的基元**：Button / Input / Select / Table / Dialog / Badge / Toast；
2. **改动必须向后兼容**：不得删除已有 prop、不得改默认行为；
3. **深色适配是硬要求**：每个基元必须同时在后台（浅色）与前台（深色）下可用——见 `P1_DARK_DESIGN_BRIEF.md` §5；
4. 破坏性改动走契约流程。

---

## 7. 目录所有权速查

```
Claude 拥有：
  src/app/[locale]/(site)/**   src/app/layout.tsx   globals.css
  src/components/site/**       src/styles/**
  src/lib/locale-canonical.ts  src/lib/site/**   src/lib/seo/**
  src/lib/slug/**              src/lib/public-page-id.ts
  docs/architecture/**         docs/p1/**

Codex 拥有：
  src/app/(admin)/**    src/app/api/**    src/app/go/[code]/**
  src/components/admin/**
  src/lib/adapters/**   channel/**   tasks/**   promo/**   revenue/**
  src/lib/indexnow/**   sitemap/**   tracking/**   auth/**
  src/lib/public-redirect-code.ts    db.ts    datasource-url.ts
  src/lib/admin-capabilities.ts      feature-flags.ts
  worker/**   scheduler/**   prisma/**

共享（需双方确认）：
  src/components/ui/**   src/lib/constants.ts   docs/governance/**
```
