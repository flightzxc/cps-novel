# P2-06.5 · CPS Parity 修正 · Codex 交接单

```
SOURCE_AUDIT=docs/p2/P2-06-5-ADMIN-CPS-PARITY-AUDIT.md
OWNER_RULING_DATE=2026-08-17
HANDOFF_ITEMS=4        # F5 / F4 / U5 / F6
UI_SIDE_ITEMS=3        # F1 / F2 / F3 —— Claude 侧已完成并验收，见 §5
BOOTSTRAP_BLOCKING=NO  # 四项均不阻塞 bootstrap
```

排期（Owner 2026-08-17 定）：

```
F5 契约  ┐
F4 picker ┼─ 与 Bootstrap 实现【完全并行】，无依赖（理由见 §0.2）
Bootstrap ┘
              ↓
       Integrated Dry Run     ← UI 第一次接触真实数据
              ↓
             U5              ← 【硬依赖】真实 bootstrap 数据到位后才可验证
              ↓
          Admin UAT          ← F6 须在此之前闭合
```
C1_PARAMETER_STATUS=FROZEN
AUTO_WRITE_AUTHORIZED=NO
```

本单只列**必须由 Codex 落地**的部分。每项都注明了为什么 UI 侧无法自解。

---

## 0. 本轮新增的 Owner 长期决策（影响下游设计，先读）

### 0.1 CanonicalTag 的定位升级

> CanonicalTag 是**未来面向用户检索/浏览的公共 taxonomy**，不是仅内部标签。

由此派生的多语策略：

- locale 域继承 CPS 现行 19 码，**并补 Novel 所需 `zh`**，共 20 码；
- CPS 原样继承的 CanonicalTag **优先继承 CPS 已有多语翻译**；
- 语义被修改/合并的 Tag **必须按 Novel Final 语义重审翻译**，不得直接沿用 CPS 译文；
- Novel 新增 Tag **直接补多语**；
- **多语翻译完成度是 CanonicalTag 对外开放前的重要 Gate。**

工程含义：当前 canonical taxonomy v1（123 条，SHA `8bc8cdae…`）**只有 `zh` 一个语种有数据**，
其余 19 个语位为空是**预期状态**，不是缺陷，不要写"补齐/回填"类自动化去填它。
`zh` 是 `service.ts` 中 `COALESCE(requested.display_name, zh.display_name, ct.slug)` 的硬编码回退，
**任何时候都不得从 locale 域里移除**。

### 0.2 Bootstrap 属于 authority 平面，不属于 admin mutation 平面

> 初始 CanonicalTag / B2 写入属于 **authority bootstrap**，不属于 admin mutation。
> Seeder **不得**调用 `mutateAdmin*`、**不得**伪造 actor / reason / `OperationAudit`。
> Bootstrap 由独立、显式、**dry-run-first、hash-pinned、idempotent、fail-closed** 的 CLI/service 完成，
> 可复用底层 validation / transaction primitive，**但不复用 Admin 语义层**。

为什么这条必须守住（三条硬理由）：

1. `mutateAdmin*` 需要 `AdminServiceAuthorization` 票据，而 `requireFreshAdminServiceMutation`
   会**重读 DB session 并复查能力位 + 2FA**。CLI 没有会话 —— 复用就只能伪造票据。
2. `approve_edge` 的语义是"某个授权运营批准了这条边"。把 bootstrap 记成 approval，
   会抹掉「哈希锁定的权威产物物化」与「有人拍板」之间的区别 —— 而这正是审计的全部价值。
3. 仓内已有先例：`scripts/p2-06-5-production/tagging-backfill.ts` 直连 Prisma，本就不走 `mutateAdmin*`。

**排期含义：F4 / F5 与 Bootstrap 实现可以完全并行**，两者无依赖。

#### 🔴 Owner 补充裁决：Bootstrap `approvedBy` 语义

Authority Bootstrap 不进入 Admin mutation 平面：**不调用 `mutateAdmin*`、不伪造
`AdminServiceAuthorization`、不伪造 session / 2FA、不生成虚假的 `OperationAudit`。**

但当前 `SourceLabelMapping.approvedBy` 为 NOT NULL FK。

**关键在于分清这个字段问的是什么。** schema 本身已经把两件事分成两对字段：

```prisma
// prisma/schema.prisma:544-547,551
approvedBy String        @map("approved_by") @db.Uuid   // 谁批准了这条业务规则
approvedAt DateTime      @map("approved_at")            //   ——审批事实
createdAt  DateTime      @map("created_at")             // 行何时落库
updatedAt  DateTime      @map("updated_at")             //   ——行生命周期
approver   AdminIdentity @relation("SourceLabelMappingApprover", ...)
```

若 `approvedBy` 指"谁插的行"，它就与 `createdAt` 冗余，更不会另立 `approvedAt`；
关系名亦直书 `Approver`。**所以 `approvedBy` 是业务审批事实，不是执行者槽位。**

而 B2 Final 的 mapping **本就经过 Owner Final 审批**。因此写入真实审批者 UUID
不是伪造 actor，而是记录真相；反过来塞一个 bootstrap 执行身份进去，
才是把假事实写进审批位。两件事必须各归各位：

- `approvedBy` = **谁批准了这条业务规则**
- Bootstrap manifest / hash = **谁或什么把冻结规则物化进数据库**（见下节 provenance）

**处理纪律：**

1. **先审计** `approvedBy` / `AdminIdentity` 的真实领域语义，不要从字段可空性倒推设计。
2. B2 Final mappings 已经过 Owner 审批，因此**若生产环境存在可真实代表该审批者的 `AdminIdentity`**：
   - Bootstrap **必须显式接收** `approvedBy` UUID（不得推断、不得默认）；
   - 校验该 identity 确实存在；
   - 将其作为**业务审批者**写入 `approvedBy`；
   - **不**把它当成 bootstrap 执行 actor；
   - **不**生成 Admin mutation audit。
3. **禁止：**
   - 随手取第一个 `super_admin`；
   - 用当前 CLI 执行用户冒充审批者；
   - 默认创建 system identity 并把它解释成人类 approver。
4. **若无法绑定真实审批者：**
   - **fail closed**；
   - 输出 `BOOTSTRAP_APPROVER_MODEL_CONFLICT`；
   - 回报 Owner 决策（`approvedBy` 是否应 nullable / 是否需要独立 authority provenance /
     现有 `AdminIdentity` 是否支持非人类 principal）；
   - **不得自行改 schema。**

只有在现有 `AdminIdentity` 模型**已经明确支持 non-human principal**，
且 `approvedBy` 的领域定义允许 "authority principal" 而非 "human approver" 时，
才允许提出 system identity 方案，**并须给出代码证据**。

> 修订记录：本节初版曾把"新建 `system:p2-06-5-bootstrap` 非人类 identity"列为推荐方案。
> 该建议错误 —— 它把**执行者**写进**审批位**，正好摧毁 schema 用
> `approvedBy/approvedAt` 与 `createdAt/updatedAt` 两对字段刻意建立的区分，
> 且与本文件下一节"bootstrap provenance 不落审计、落权威面板"的立场自相矛盾。已由 Owner 裁决更正。

（`CanonicalTag` 无此问题 —— 全表**没有任何 actor 列**，只有 `taxonomyVersion`。）

#### Bootstrap 的 provenance 落在哪

既然不写 `OperationAudit`，"这 123 条从哪来"的答案**不在变更历史面板，而在权威诊断面板**：
`readAdminTagAuthority` 已经在比对 `canonicalV1Sha256` / `databaseActiveCount === 123` /
`versions.length === 1`，`canonical_tag.taxonomy_version` 是天然的 bootstrap 版本载体。

→ 连带影响：**播种出来的行在 F1 的变更历史里显示「暂无变更记录」是正确行为**，不是缺陷。
UAT 脚本应预先说明，否则运营大概率当 bug 报上来。

### 0.3 SourceLabel 映射与 CanonicalTagTranslation 严格分层

> `channel + raw-language scope + exact raw token → CanonicalTag`
> **不得**通过翻译字符串相似、跨语言归并或 fuzzy matching 代替 exact source mapping。

这条对 U5（blast-radius 计数）是硬约束：计数查询必须走 4 元组精确身份 + `COLLATE "C"`，
**不得**为了"更好看的数字"引入任何模糊匹配或跨语种合并。

---

## 1. F5 · mutation 支持 reason（建议优先）

### 现状缺口

审计实体已经有槽位、读路径已经投影，**只有写路径填不进去**：

| 层 | 现状 |
|---|---|
| `AdminTagAuditEntryView.reason: string \| null` | ✅ 已定义（`src/contracts/tagging-admin.ts:20`） |
| `admin-service.ts:234` `reason: row.reason` | ✅ 已从 `OperationAudit` 读出并投影到浏览器 |
| 8 个 `exactKeys` 集合 | ❌ **全部不含 `reason`**，且 `exactKeys` 拒绝多余键 → 传了就是 400 |

结论：`reason` 对所有 admin 发起的 tagging 变更**恒为 `null`**。

**UI 侧无法自解** —— 键集校验在 `src/app/api/admin/_lib/tagging-route.ts`（Claude 可写），
但 mutation 类型定义在 `src/domain/tagging-admin.ts`、落库在 `src/server/tagging/admin-service.ts`（Codex 独占）。

### Owner 裁决的风险分级

| 动作 | reason | 理由 |
|---|---|---|
| `approve_edge` / `deactivate_edge`（Source Mapping 新增/修改/停用） | **必填** | 影响所有匹配该 exact token 的小说，高影响面 |
| `set_status` / `replace_translations` / `replace_aliases`（CanonicalTag 全局状态或语义变更） | **必填** | 全局 taxonomy 语义变更 |
| `replace_manual` / `exit_manual`（单本 Novel FULL_SNAPSHOT / reset） | **可选，不强制** | 避免单书人工调整产出无意义的"调整/修改"类 reason |

（`replace_keywords` 本轮 UI 未开放；若将来开放，按 CanonicalTag 档位归入**必填**。）

### 实现要点

1. `AdminCanonicalTagMutation` / `AdminSourceLabelMappingMutation` 增加 `reason: string`；
   `AdminNovelTagMutation` 增加 `reason?: string`。
2. `exactKeys(value, required, optional)` **已支持可选键集**（`tagging-route.ts:20-28`），
   不需要新机制：必填档进 `required`，Novel 档进 `optional`。
3. 🔴 **必填必须在服务端校验非空白**，不能只靠前端 `required`。
   前端 guard 只是 UX，后端才是 authority —— 这是本项目已确立的纪律。
   建议与 CPS 一致：`!reason.trim()` 即拒，返回 `invalid_tag_request` 400。
4. 空串处理需明确：可选档收到 `reason: ""` 时，建议**归一为 `null`** 再落库，
   避免审计里出现空字符串与 `null` 两种"没填"。
5. 落库写入 `OperationAudit.reason`，读路径无需改动（已投影）。

### CPS 先例（可直接对照）

`channel-account-forms.tsx` 的 `SupersedeCredentialForm` / `DisableChannelAccountForm` / `UpdateJwtForm`：
`reason: string` 既是表单必填项，**也是 action 入参的必填字段**，与 `actorUserId: session.user.id` 一起进服务层。
`article-drama-switch-panel.tsx` 的切换历史把 `原因` 作为**一等列回显给下一位运营** —— 这是 reason 的真正价值所在。

---

## 2. F4 · 渠道应用列表读服务（供 picker 使用）

### 现状缺口

"新增映射"表单需要 `channelAppId`（UUID）。当前**运营手贴**。

审计结论：**CPS 生产后台全仓零个手贴外键 ID 的表单**，共 5 种 picker 变体；
最贴切的先例 `TagRuleForm` 就是同一处境（API 只收 `tagId`），CPS 的答案是**补一个 ~40 行的搜索端点**，
而不是接受贴 ID。

`canonicalTagId` 那一半 Claude 已用现有的 `GET /api/admin/canonical-tags?search=` 修好（F2，零后端改动）。
**`channelAppId` 这一半没有任何可用的列表读服务**，故交接。

### 需要 Codex 提供

一个轻量只读服务，形如：

```ts
export async function listAdminChannelApps(
  db: PrismaClient,
  input?: { search?: unknown; active?: unknown; pageSize?: unknown },
): Promise<AdminChannelAppList>
```

返回项至少包含 `AdminMappingChannel` 已有的字段（`src/domain/tagging-admin.ts:154-160`）：
`channelAppId` / `channelCode` / `sourceAppCode` / `externalAppId` / `active`。

### 分工边界

| 部分 | Owner | 路径 |
|---|---|---|
| 读服务 | **Codex** | `src/server/**` |
| domain 类型 + contracts 投影 | **Codex 合并**（contracts 由 Claude 合并、Codex 审核） | `src/domain/`、`src/contracts/` |
| Route Handler | Claude | `src/app/api/admin/channel-apps/route.ts` |
| 路由注册 | Claude | `src/app/api/admin/_lib/registry.ts`（`ADMIN_TAGGING_ROUTES`） |
| Picker UI | Claude | `src/app/(admin)/tags/mappings/_components/` |

建议注册为 `GET`，能力位 **`content:view`**（与三条既有 tagging 读路由一致，读不需要 step-up）。
⚠️ `resolveAdminRoute` 比较**完整 pathname 且无动态段匹配器**，路径必须扁平、标识走 query 参数。

---

## 3. U5 · 映射变更的影响面计数（不阻塞 bootstrap）

Owner 裁决：赞成补"预计影响 N 本小说"，**不作为 bootstrap blocker**，
要求在 **Production Admin 正式交付运营前闭合**。

### 🔴 设计要点：这是两个不同的问题，不能共用一个查询

| 动作 | 该回答的问题 |
|---|---|
| `deactivate_edge` | 当前有多少本小说正**通过这条边**拿到该标签（停用后会失去） |
| `approve_edge`（新建） | 有多少本小说带该 raw token、**将会新增**这个标签 |

混用会给出误导数字。两者都必须绑定 4 元组精确身份
（`channelAppId` + `rawLanguageScope` + `rawToken` + `canonicalTagId`）并走 `COLLATE "C"` 字节精确匹配 ——
见 §0.2，**不得**用模糊匹配或跨语种归并把数字做"好看"。

### 其它约束

- 链路是 `novel_source_item_label → source_label → source_label_mapping → canonical_tag`，
  **上线前需确认走索引**。在确认弹窗里挂一个慢扫描是很糟的体验。
- 结果是**时点估算**，UI 文案须用"预计"，不要说成精确值。
- 若计数超时或失败，确认框应**降级为当前的定性文案**继续可用，
  不得因为数字取不到就阻塞高风险操作的确认路径。

---

## 4. F6 · 审计操作人只有 UUID，没有用户名（F1 实施中发现，新增项）

### 现状

`AdminTagAuditEntryView.actorId` 是**裸 UUID**，投影里没有任何用户名解析。
F1 已把变更历史接进三处 UI，形状上完成了 CPS parity，但**可读性没有**：

- CPS `home-carousel` 的操作日志显示 `操作人 {log.changedBy}` —— 是**人名**
- Novel 只能显示 `操作人 a3f9c1e2-…`（mono 截断，完整值挂 `title`）

### 🔴 明确禁止的"就近取材"

`AdminSourceLabelMappingView.approvedBy.username` 看起来可以顶上，**但绝对不能用**：

> `approvedBy` 是**该映射边的审批人**，`audit.actorId` 是**本次这条变更的操作人**。
> 两者在语义上是不同的人，拿前者顶替后者等于**在审计上撒谎**——而审计的全部价值就在于可信。

F1 的实现已按此约束落地（`tag-audit-log.tsx` 注释中明确 "never a resolved username"），
并有测试断言"审批人的用户名不得出现在审计条目的操作人位"。

### 需要 Codex 决策

是否在 `AdminTagAuditEntry` 的读路径上补一个 actor → username 的 join。

| 选项 | 代价 | 说明 |
|---|---|---|
| A. 补 join，投影增加 `actorUsername: string \| null` | 读服务 + domain 类型 + contracts 投影 | 达到 CPS 的可读性；注意投影层是白名单，新增字段要同步 |
| B. 维持 UUID | 零 | 审计可用但不可读，追责时需人工查表 |

优先级低于 F5（reason）—— 没有 reason 时审计条目缺的是**为什么**，
没有 username 缺的只是**谁的可读形式**，UUID 至少仍可追溯。

---

## 5. 不在本单内（Claude 侧已完成并验收）

| # | 项 | 状态 |
|---|---|---|
| F1 | 变更历史展示（`lastMutation` / `audit` / `lastManualMutation` 接线） | ✅ **已完成** 纯 UI；canonical 复用既有 detail 请求未增请求；mappings / novel 纯 prop 消费零请求 |
| F2 | canonicalTag 搜索选择器 | ✅ **已完成** 复用既有 `GET /api/admin/canonical-tags?search=&active=active`，零后端改动 |
| F3 | 译名固定 20 语种列表 + 渐进展开 | ✅ **已完成** 列表登记进 `src/lib/locale/locale-canonical.ts` 唯一真源，组件零语种字面量 |

验收基线：`typecheck` / `lint` 干净，`npm run test:ui` **40 文件 / 824 测试全绿**，
`src/server` / `src/domain` / `src/contracts` / `prisma` **零触碰**。

---

## 5. 明确不做（避免下轮重开）

| 项 | 理由 |
|---|---|
| 给 manual 标签选择器加搜索框 | CPS `TagMultiSelect` 同样无搜索。加了是**偏离**生产惯例 |
| 回退确认弹窗到 `window.confirm()` | P1-09 验收③要求真 modal；CPS 现状无焦点陷阱、无 `role="dialog"`，是待改进项不是标杆 |
| 回退错误处理到"渲染服务端字符串" | envelope 契约无 message 字段；CPS 该路径还会泄漏 `error.message` 原文 |
| 去掉 `loading.tsx` / `error.tsx` | CPS 全仓零个不是惯例，是缺口 |
| 去掉乐观并发 token | 后端 `expectedUpdatedAt` / `expectedRevision` 强制；CPS 无此概念是因其 last-write-wins |
| 自动回填 19 个空语位 | 见 §0.1，空是预期状态；翻译完成度是人工 Gate，不是自动化任务 |
```
