# P2-06.5 Admin V1 UI · CPS Operational Parity Audit

```
AUDIT_TYPE=READ_ONLY
AUDIT_DATE=2026-08-17
CPS_BASELINE=cps-admin @ d77c3b9   (v8.1.1 production rollout, 2026-08-02)
NOVEL_BASELINE=cps-novel @ feature/p2-06-5-tagging-v3, worktree p2-06-5-tagging-v3
CPS_MODIFIED=NO
NOVEL_UI_MODIFIED=NO
TAG_ARCHITECTURE_REDESIGNED=NO
BOOTSTRAP_ENTERED=NO
```

方法：CPS 侧全部结论以 `git show d77c3b9:<path>` 核对，工作区仅用于 `git ls-tree` / `git grep` 检索
（CPS 工作区当前停在 `ops/nginx-ratelimit-hardening`，**未 checkout、未改动**）。

---

## 1. Summary

```
TOTAL_AUDITED_ITEMS=41

COPY_AS_IS=17
COPY_THEN_ADAPT=5
INTENTIONAL_NOVEL_DIFFERENCE=13
NOVEL_ONLY_REQUIRED=1
UNJUSTIFIED_DIVERGENCE=5
```

### 一句话结论

**后台操作惯例的继承是充分的，但有 5 处把 CPS 已有的东西重新发明了一遍，其中 3 处发明得更差。**

需要在 bootstrap 前修的只有 5 条（§4），其余 36 条要么已经对齐，要么是 Owner 冻结的必要差异。

### 审计中被推翻的两个先验判断

诚实记录，因为它们说明"看起来像缺陷"和"真的是缺陷"不是一回事：

1. **「manual 标签选择器没有搜索框」不是缺陷。** CPS 给每篇 Article 打标签用的 `TagMultiSelect`
   同样是一排 toggle pills，**没有搜索、没有过滤、没有上限、不分已选/可选**。Novel 的 checkbox
   列表反而更贴近 CPS 现状。若按直觉"修复"它，是在偏离生产惯例而不是靠近。
2. **CPS 在多个维度上弱于 Novel 现状。** CPS 全仓 **零 `error.tsx`、零 `loading.tsx`、零错误码→文案映射、
   零乐观并发控制、无共享确认弹窗、无 Table 原语、无权限拒绝组件**，且 `handleActionError` 的兜底分支
   会把 `error.message`（可能含 Prisma/上游原文）直接回给运营。这些地方**不应该**向 CPS 回退——
   P1-09 已经有意做得更严，回退等于制造新缺陷。

---

## 2. Divergence table

> `PARITY_CLASS` 取值：`COPY_AS_IS` / `COPY_THEN_ADAPT` / `INTENTIONAL_NOVEL_DIFFERENCE` /
> `NOVEL_ONLY_REQUIRED` / `UNJUSTIFIED_DIVERGENCE`

### 2.1 UNJUSTIFIED_DIVERGENCE（5 条 —— 本次审计的全部真实产出）

| # | Feature | Novel 现状 | CPS 现状 | 为何不同 | Class | 建议动作 |
|---|---|---|---|---|---|---|
| **U1** | 映射创建的外键录入 | `新增映射` 表单要求**手贴两个 UUID**（`channelAppId` / `canonicalTagId`），提示"可从下方表格复制 ID"。`mappings-client.tsx:320-333` | **CPS 全仓零个手贴 FK ID 的表单。** 5 种 picker 变体；`TagRuleForm` 就是同一处境（API 只收 `tagId`），CPS 主动从预加载列表迁到 300ms 防抖 XHR 搜索 | 实现方认为"API 只接受 ID"就只能贴 ID。CPS 的答案是补一个 40 行的 `{id,name}` 搜索端点 | **UNJUSTIFIED_DIVERGENCE** | 见 §4 F2 / F4（拆两半：canonicalTag 可立即修，channelApp 需 Codex） |
| **U2** | 变更历史展示 | contracts 已投影 `lastMutation` / `audit` / `lastManualMutation` 到浏览器，**UI 一处未渲染**；全站只有 mappings 表的 `approvedBy.username` | `home-carousel/page.tsx` 在**编辑器同页**挂 `操作日志`：动作 chip + scope chip + `操作人` + 时间戳 + 人类可读 `label：before → after` diff，30 条滚动区，每次成功变更后重取 | 数据齐备、投影齐备、只是没接线 | **UNJUSTIFIED_DIVERGENCE** | 见 §4 F1（纯 UI，成本最低价值最高） |
| **U3** | 逐 locale 译名编辑 | 自造译名行编辑器：locale 是**自由文本 `<input placeholder="locale">`**，运营手打语种码。`canonical-tag-editor.tsx:140-144` | `tags/_components/locale-field-editor.tsx` — **固定 19 语种列表**，渐进披露（默认只显 `en`/`zh-CN`/`zh-TW` + 已有值的语种，其余折在 `展开全部 N 种语言` 后），空值删 key 而非存 `""` | 自由文本 locale 打错一个字母就静默产生孤儿语种，且无法被任何校验拦截；CPS 的固定列表从结构上消除了这一类错误 | **UNJUSTIFIED_DIVERGENCE** | 见 §4 F3 |
| **U4** | 高风险变更的必填原因 | 三条 mutation **全都无法携带 reason**：8 个 `exactKeys` 集合均不含该键，且 `exactKeys` 拒绝多余键。但审计实体 `AdminTagAuditEntryView.reason` 存在且已投影到浏览器 | `reason: string` 是**表单必填项 + action 入参必填字段**，与 `actorUserId` 一起进服务层；`article-drama-switch-panel` 的切换历史把 `原因` 作为一等列回显给下一位运营 | 后端契约缺口：审计表有槽位、读路径有投影、写路径填不进去 | **UNJUSTIFIED_DIVERGENCE** | 见 §4 F5 —— **HANDOFF_REQUIRED（Codex）**，UI 侧无法自解 |
| **U5** | 映射变更的影响面量化 | 确认框写"此映射会影响所有匹配该 exact source token 的小说"——**定性，无数字** | CPS 三种量化：picker 选项自带 `count`（`SearchableFacetSelect`）、选择计数（`批量分类 (N 部剧集)`）、以及 dry-run 预览的分档汇总 | Novel 无 count 端点可用 | **UNJUSTIFIED_DIVERGENCE**（弱：需后端支持） | 非阻塞，见 §5 |

### 2.2 COPY_THEN_ADAPT（5 条）

| # | Feature | Novel 现状 | CPS 现状 | Class | 建议 |
|---|---|---|---|---|---|
| A1 | 子页面分组 | `/tags` 下子路由 + 页内 tab 条 | `/settlement/*` 用侧栏二级项 + 嵌套 route-group layout 共享页头 | COPY_THEN_ADAPT | 保持现状。Novel 侧栏被 `admin-nav-parity.test.tsx` 冻结成 14 项且 children 渲染为惰性 span，页内 tab 是该约束下的等价解 |
| A2 | 全量替换前的 diff 确认 | `replace_translations` / `replace_aliases` 是全量替换，保存前**不显示 before→after** | `buildCarouselConfigPatch` 产出 `{patch, changes}`，**同一份 changes 同时喂确认框和审计渲染**——运营批准的和被记录的逐字一致 | COPY_THEN_ADAPT | 建议采纳，与 F1 一并做收益最大 |
| A3 | flag 关闭态文案 | `tagging_disabled` → "标签功能当前未启用"（未点名 flag） | 全页解释面板**点名 env 变量与执行点**：`FEATURE_CHANGDU_TOTAL_REVENUE_DASHBOARD 默认关闭。契约尚未在生产验证前，本页面、菜单入口与…一律不可达` | COPY_THEN_ADAPT | 低优先。改 `error-copy.ts` 文案即可（Claude 独占） |
| A4 | 只读诊断卡壳 | 自造 `Panel`/`Field` dl 版式 | `settings/page-identity-v2-status-card.tsx` —— 明确"只读展示"契约，数组驱动 `label/value/help` 网格，`text-xs font-medium uppercase text-gray-400` 微标签 + 阈值着色函数 `countTone()` | COPY_THEN_ADAPT | 可选。现状不错，CPS 版本在"权威公示"语气上更成熟 |
| A5 | 影响面计数 | 见 U5 | 见 U5 | COPY_THEN_ADAPT | 非阻塞 |

### 2.3 INTENTIONAL_NOVEL_DIFFERENCE（13 条 —— 不得据 CPS 回退）

| # | Feature | Novel | CPS | 为何必须不同 |
|---|---|---|---|---|
| B1 | 14 项 Owner 冻结语义 | CanonicalTag 身份模型 / mapping identity / read-derived mapped / `mapped ∪ auto` / FULL_SNAPSHOT / 不预填 / 空快照合法 / fail-closed / 30-30-30-3 / Tag 不进 publish gate / 无周期重分类 / Task Admin 关闭 / `AUTO_WRITE=NO` | CPS 的 tag 由分类器写入，无人工接管概念 | Owner Final 冻结，**不参与 parity 回退** |
| B2 | 页面壳组件 | `AdminShell`（title/description/actions/session） | **无壳组件**，28 个文件逐字重复同一段页头 JSX | Novel 更好 |
| B3 | 分页保参 | `ContentPagination` 克隆全部 query 参数只覆写 `page` | 三套互不相干实现；`ArticlesPagination` **硬编码 `/articles` 且只认 4 个参数**，静默丢弃 `articleType` 等筛选，URL 未编码 | Novel 更好 |
| B4 | 段级 loading / error | 每段 `loading.tsx` 骨架 + `error.tsx`（只渲染 digest） | **全仓零个** `loading.tsx` / `error.tsx` | Novel 更好 |
| B5 | mutation 传输 | 受 registry 守卫的 PUT + `adminFetch` | 主用 Server Action | `registry.ts:139-141` 明文"No Server Action is introduced here" |
| B6 | 确认弹窗 | `ConfirmDialog`（原生 `<dialog>` + `showModal()`，焦点陷阱/Esc 走平台） | `window.confirm()` × 15；唯一原生 `<dialog>` 在 `CategoryModal`；三种互不相同的 modal 手法，多数无 `role="dialog"`/焦点陷阱 | P1-09 验收③ 要求；Novel 更好 |
| B7 | 错误码→文案 | 冻结 `Record<AdminErrorCode, string>`，15 个 tagging 码全覆盖，测试强制无兜底穿透 | **无此模块**；`classifyPromoFailure` 用**正则解析自由文本错误串** | envelope 无 message 字段，契约层面就要求前端持有文案 |
| B8 | 不读服务端 message | 从不读 `error.message`（envelope 无此字段） | 直接渲染服务端字符串；`handleActionError` 兜底分支回传 `error.message` 原文 | Novel 更好（CPS 该行为是信息泄漏风险） |
| B9 | 409 冲突处理 | `revision_conflict` 专门文案 + 刷新动作，不自动重试不静默覆盖 | 全仓仅 1 个 409，消费端 `alert(err.error \|\| "删除失败")` 一视同仁 | 后端强制 |
| B10 | 乐观并发 | `expectedUpdatedAt`（ISO 逐字回送）/ `expectedRevision`（十进制字符串） | **零并发控制**，全部 last-write-wins，`updatedAt` 仅作展示列 | 后端契约强制 |
| B11 | 无权限的写控件 | 可见但禁用 + `capabilityBlockReason` 点名能力位 | **隐藏**写控件（`{canManage && <Form/>}`），另挂能力位状态 chip | P1-09 验收⑥；两者都点名能力位，取向不同但都成立 |
| B12 | 权限拒绝面板 | `ContentCapabilityDenied` 组件 | 一段 3 行内联 `<p>`，无组件 | Novel 更好 |
| B13 | 2FA step-up | `tag:manage` 的 `requiresTwoFactor: true`，写操作需已完成双验 | **业务操作零 step-up**；唯一 TOTP 重验是重新生成恢复码 | Novel 更严；后端 capability 配置强制 |

### 2.4 COPY_AS_IS（17 条 —— 已对齐，无需动作）

| # | Feature | 证据 |
|---|---|---|
| C1 | `(admin)` route group | 两侧同构 |
| C2 | 侧栏 = 模块级字面量数组 + 布尔量 gating | CPS `sidebar.tsx` `NAV_ITEMS`；Novel `nav-items.ts` `ADMIN_NAV_ITEMS`（注释即声明"mirror CPS sidebar.tsx:39-72"） |
| C3 | 菜单顺序与中文标签 | P1-09 已按 CPS 冻结 |
| C4 | 桌面端布局（无移动端） | CPS `pl-60` 无断点、无抽屉；Novel 侧栏定宽。两侧一致 |
| C5 | 列表页 = Server Component 直调 service | CPS `dramas/page.tsx` 调 `getDramas()`；Novel 调 `listAdminCanonicalTags()` |
| C6 | 搜索 = `<form method="GET">` + `defaultValue` + 不放 `page` 字段 | CPS `dramas/page.tsx` 与 Novel 逐字同构 |
| C7 | 筛选控件 class 串 | `rounded-lg border border-gray-300 … focus:ring-1 focus:ring-blue-500` / 提交按钮 `bg-gray-100 … hover:bg-gray-200` 两侧一致 |
| C8 | 表格 class 词汇 | `rounded-xl border border-gray-200 bg-white shadow-sm overflow-hidden` + `px-4 py-3 text-left font-medium text-gray-500` + `hover:bg-gray-50`，与 CPS canonical A 一致 |
| C9 | 空态 = 居中 `<td colSpan>` | 两侧一致 |
| C10 | 成功/失败内联 banner | CPS `border-green-200 bg-green-50 text-green-700`；Novel emerald 同构（色号微差，纯视觉） |
| C11 | 忙态 = 禁用 + 进行时文案 | CPS `{pending ? "保存中..." : "保存"}`；Novel `处理中…` |
| C12 | 变更后 `router.refresh()`，无乐观更新 | 两侧一致；CPS `useOptimistic` 零occurrence |
| C13 | 不可逆后果写进确认文案 | CPS `SupersedeCredentialForm` 点明下游影响+不可逆+逃生口；Novel `exit_manual` 确认说明"删除 manual 行、不重跑分类器" |
| C14 | 能力位来自 env（角色表 + userId 白名单，默认 `super_admin`） | CPS `CAPABILITY_ENV`；Novel `ADMIN_CAPABILITY_CONFIG` |
| C15 | 配置行展示操作人 | CPS `<Th zh="操作人" en="updatedBy" />`；Novel mappings 表 `approvedBy.username` |
| C16 | 多选标签 = 无搜索的平铺选择 | CPS `TagMultiSelect` pills；Novel checkbox 列表。**先验判断被推翻，见 §1** |
| C17 | 状态启停 = 表单内控件、随表单提交、不单独确认 | CPS `<select>` 启用/禁用；Novel 表单内 status 控件 |

### 2.5 NOVEL_ONLY_REQUIRED（1 条）

| # | Feature | 说明 |
|---|---|---|
| N1 | provenance 可视化（`mapped` / `auto` / `mapped·auto` / `manual`） | CPS **数据模型有** provenance（`article_tags.source` 带 CHECK 约束 `inherited\|manual\|fallback`，`DramaTag.source` 必填带索引，`article-tag-inheritance.ts` 有完整解析代数），但 **UI 一处不展示**——`TagMultiSelect` 只收到 `{id,name,slug}`，运营分不清哪个标签是自己选的、哪个是分类器给的。Novel 必须展示（ADR §13）。**无可复用前端，这是 CPS 的缺口而非 Novel 的** |

---

## 3. Exact reuse candidates

| CPS source file | Component / function | Novel target file | Est. reuse |
|---|---|---|---|
| `src/app/(admin)/tags/_components/locale-field-editor.tsx` | `LocaleFieldEditor({ label, value, onChange, multiline?, required? })` + 模块级 `ALL_LOCALES` / `LOCALE_LABELS` / `DEFAULT_EXPANDED` 渐进披露逻辑 | `src/app/(admin)/tags/canonical/_components/canonical-tag-editor.tsx`（译名区） | **~70%** —— 交互与渐进披露逻辑照搬；数据形状需适配：CPS 编辑 `Record<string,string>` JSON blob，Novel 是 `{locale,displayName}[]` 关系行，需一层 map/unmap |
| `src/app/(admin)/tags/_components/tag-rule-form.tsx` | 标签搜索 picker：300ms 防抖 → `GET /api/admin/tags?noRule=true&take=50&q=…`，挂载时预取前 50，选中后另起一行显示 `已选：{slug}` | `src/app/(admin)/tags/mappings/_components/mappings-client.tsx`（新增映射表单的 `canonicalTagId` 字段） | **~85%** —— Novel 已有等价读端点 `GET /api/admin/canonical-tags?search=&active=active`（`content:view`），**无需任何后端改动** |
| `src/components/articles/batch-drama-switch-v2-client.tsx` | `SearchableFacetSelect`（模块私有）——唯一真 ARIA combobox：`role="combobox"` + `aria-controls/expanded/autocomplete`，popup `role="listbox"`/`option`，选项行带 `count`，`onMouseDown` preventDefault + 120ms blur 延迟解决点选被 blur 抢先 | 同上（若要更完整的可访问性） | **~60%** —— 可访问性骨架可直接抄；选项加载方式需改（CPS 是 server 预算 facet prop） |
| `src/app/(admin)/home-carousel/page.tsx` | `操作日志` section（≈L1081-1140）+ `buildCarouselConfigPatch` → `{patch, changes}` 双用（确认框与审计渲染同源） | 新建 `src/app/(admin)/tags/_components/tag-audit-log.tsx`，挂在 canonical / mappings / novel 三处 | **~75%** —— 版式与 `label：before → after` 渲染照搬；Novel 的 `AdminTagAuditEntryView.before/after` 已是白名单投影（11 键、深度 4、数组截 200），比 CPS 的裸 JSON `<pre>` 更好，直接渲染即可 |
| `src/app/(admin)/settings/page-identity-v2-status-card.tsx` | 只读状态卡：数组驱动 `label/value/help` 网格 + `text-xs font-medium uppercase text-gray-400` 微标签 + `countTone()` 阈值着色 | `src/app/(admin)/tags/canonical/_components/classifier-diagnostics-panel.tsx` | **~50%** —— 现状可用；采纳其数组驱动写法可减少手写卡片 |
| `src/app/(admin)/settlement/_components/token-status-tag.tsx` | `TokenStatusTag` —— 唯一带 `Record<Status,{label,icon,cls}>` + `?? CONFIG.unknown` 安全兜底的 chip | Novel 已有 `StatusBadge`，可借鉴 `?? unknown` 兜底 | **~30%** —— Novel 版本已更好，仅借鉴兜底思路 |

> 注：两仓是**独立仓库、独立组件体系**（Novel 有 `src/components/ui/`，CPS 只有 6 个单变体文件）。
> 这里的"复用"一律指**移植模式/逐字抄类名与交互逻辑**，不是跨仓 import。

---

## 4. Required fixes before bootstrap

只列真正的 parity 偏差。"视觉可以更漂亮"一律不入此表。

| # | Fix | Class | Owner | 依赖 | 理由 |
|---|---|---|---|---|---|
| **F1** | **接上变更历史展示**：新建共享 `TagAuditLog` 组件，渲染 canonical tag / mapping 的 `lastMutation`+`audit` 与 novel 的 `lastManualMutation`，版式照 CPS `操作日志`（动作 chip + 操作人 + 时间 + `label：before → after`） | UNJUSTIFIED_DIVERGENCE (U2) | **Claude / 纯 UI** | 无 —— 数据已在投影里 | 成本最低、价值最高。三块 UI 都是高影响面写操作，CPS 惯例是审计与编辑器同页。当前 contracts 白造了一整套审计投影却无人消费 |
| **F2** | **canonicalTag 改用搜索 picker**：新增映射表单的目标标签字段，从手贴 UUID 换成防抖搜索选择，照 `TagRuleForm` 模式 | UNJUSTIFIED_DIVERGENCE (U1a) | **Claude / 纯 UI** | 无 —— `GET /api/admin/canonical-tags?search=&active=active` 已存在且已注册 | CPS 全仓零个手贴 FK 表单。这一半今天就能修，不需要任何后端配合 |
| **F3** | **译名 locale 改固定列表**：移植 `LocaleFieldEditor` 的固定语种表 + 渐进披露，取消自由文本 locale 输入 | UNJUSTIFIED_DIVERGENCE (U3) | **Claude / 纯 UI** | 无 | 自由文本 locale 打错即静默产生孤儿语种，无任何校验拦截；bootstrap 后写入真实数据再发现就要清洗 |
| **F4** | **channelApp 搜索端点 + picker**：需要一个轻量 `{id, code, name}` 渠道应用列表读服务 | UNJUSTIFIED_DIVERGENCE (U1b) | **Codex 服务 + Claude UI** | `src/server/**` 需新增读服务（路由与注册在 `src/app/api/admin/**`，Claude 可写） | 同 F2 的另一半。CPS 的答案是补一个 ~40 行端点而不是接受贴 ID |
| **F5** | **高风险 mutation 支持 reason**：三条 mutation 的 `exactKeys` 集合增加可选 `reason`，写入 `OperationAudit.reason` | UNJUSTIFIED_DIVERGENCE (U4) | **Codex —— HANDOFF_REQUIRED** | `src/domain/tagging-admin.ts` + `src/server/tagging/admin-service.ts` + 路由解析器 | CPS 把必填 reason 作为高风险变更阶梯的核心，并在历史里回显给下一位运营。Novel 审计表有槽位、读路径有投影、写路径填不进去——这是契约缺口，UI 侧无法自解 |

### 修正执行结果（2026-08-17，Owner 裁决后同日闭合）

| # | 状态 | 落地方式 |
|---|---|---|
| **F1** | ✅ **已完成并验收** | 新建共享 `tag-audit-log.tsx`，接进 canonical（复用既有 detail 请求，**未增请求**）/ mappings（纯 prop 消费 `lastMutation`，零请求）/ novel（纯 prop 消费 `lastManualMutation`）。`reason` 恒 `null` 时渲染 `—` 且不做成错误态；`actorId` 以 mono 截断显示，**禁止用 `approvedBy.username` 顶替**（已有测试断言） |
| **F2** | ✅ **已完成并验收** | 新建 `canonical-tag-picker.tsx`，300ms 防抖搜索既有 `GET /api/admin/canonical-tags?search=&active=active`，**零后端改动**。缺 `zh` 译名渲染 `—` 不回落 slug。`channelAppId` 保持现状（→ F4） |
| **F3** | ✅ **已完成并验收** | 20 语种（CPS 19 + `zh`）登记进 `src/lib/locale/locale-canonical.ts` 唯一真源，纯追加零删除；新建 `locale-field-editor.tsx` 固定列表 + 渐进展开，组件内**零语种字面量**；自由文本 locale 输入已绝迹 |
| **F4** | → Codex | 见交接单 §2 |
| **F5** | → Codex | 见交接单 §1（建议优先） |
| **F6** | → Codex（本轮新增） | 审计操作人只有 UUID 无用户名，见交接单 §4 |

验收基线：`typecheck` / `lint` 干净，`npm run test:ui` **40 文件 / 824 测试全绿**
（修正前基线 801），`src/server` / `src/domain` / `src/contracts` / `prisma` **零触碰**。

一处验收期的加固：F3 原本给 `/tags` 的语种红线护栏挂了**文件白名单例外**以放行合法的单一真源消费。
白名单会被后来者当先例扩张，故改为**按符号禁止**——封死 `locale-canonical.ts` 站点发布域的全部
5 个导出（`SITE_LOCALES` / `SiteLocale` / `resolveSiteLocale` / `isPublishableLocale` /
`listPublishableLocales`），例外名单归零，且覆盖面比原实现更宽（原来只拦 `SITE_LOCALES` 一个符号）。

Owner 裁决后新增的长期决策（CanonicalTag 作为公共 taxonomy 的多语策略、SourceLabel 映射与
CanonicalTagTranslation 严格分层）已记入交接单 §0。

---

## 5. 明确不修（记录理由，避免下轮重开）

| 项 | 理由 |
|---|---|
| manual 选择器加搜索框 | CPS `TagMultiSelect` 同样无搜索。加了是偏离生产惯例。若将来 taxonomy 远超 123 项再议 |
| 向 CPS 回退确认弹窗到 `window.confirm()` | P1-09 验收③ 要求真 modal；CPS 现状无焦点陷阱、无 `role="dialog"`，是待改进项而非标杆 |
| 向 CPS 回退错误处理到"渲染服务端字符串" | envelope 契约无 message 字段；CPS 该路径还会泄漏 `error.message` 原文 |
| 去掉 `loading.tsx` / `error.tsx` | CPS 零个不是惯例，是缺口 |
| 去掉乐观并发 token | 后端 `expectedUpdatedAt`/`expectedRevision` 强制，CPS 无此概念是因其 last-write-wins |
| 改成侧栏二级菜单 | `admin-nav-parity.test.tsx` 冻结 14 项；且 Novel 侧栏 children 渲染为惰性 span |
| 影响面数字 (U5) | 需后端 count 支持，收益低于 F1–F5，非阻塞 |
| flag 文案点名 env 变量 (A3) | 纯文案改进，非阻塞 |
| 全量替换的 diff 确认 (A2) | 建议与 F1 合并做；单独做收益有限 |

---

## 6. 纪律声明

```
CPS_REPO_MODIFIED=NO           # 仅 git show / git ls-tree / git grep，未 checkout
NOVEL_UI_MODIFIED=NO           # 本轮未改任何 src/ 文件
SCHEMA_MODIFIED=NO
CLASSIFIER_MODIFIED=NO
TAXONOMY_REDESIGNED=NO
OWNER_FINAL_OVERRIDDEN=NO
BOOTSTRAP_ENTERED=NO

C1_PARAMETER_STATUS=FROZEN
AUTO_WRITE_AUTHORIZED=NO
NEXT_STREAM=BOOTSTRAP_AND_INTEGRATED_DRY_RUN
HANDOFF_REQUIRED=F4(channelApp 读服务), F5(mutation reason 契约)
```
