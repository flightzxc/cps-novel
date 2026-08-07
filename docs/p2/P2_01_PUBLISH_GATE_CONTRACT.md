# P2-01 · 发布门禁共享契约

> 基线：`BASE 62453d2`（分支 `feature/v0.1.0-p2-01-publish-contract`）
> CPS 参照基线：`d77c3b968285698529cf97c7f0f97b286d7a2a9c`（只读参考，见 `CLAUDE.md` §2）
> 状态：待 Codex 契约审查
> 变更级别：🔴 `FROZEN`（变更需 Owner 确认）
> 输入依据：`docs/governance/P2_HANDOFF_INPUT.md` §3/§5/§9（背景材料，成文早于本轮
> Owner 决策，不包含 §0 记录的 supersession 内容——引用它时只作背景，见 §0 末尾说明）

本文件是 `src/contracts/publish-gate.ts` 的权威依据。契约本身零业务逻辑实现——
它只登记发布意图、失败理由码、`required_metadata_missing` 详情 DTO 形状与
`paid_from_chapter` 政策的**形状与语义**，供 Claude 前台/后台 UI 与 Codex 后端
发布准入服务共同引用，防止两侧各自发明一套判定。

---

## 0. Owner supersession（最高权威）

本节记录的是**最新一轮** Owner 决策，是本文件与 `src/contracts/publish-gate.ts`
的最高权威——与 §1「十三条决策」或本文件更早版本冲突之处，一律以本节为准。

### 0.1 最新八条决策

1. **发布门禁沿用 CPS**：lifecycle status + publish-time 硬门禁的整体形态照搬 CPS，不重新发明一套准入哲学。
2. **不建独立 Admission 状态机**：没有第二套"待审/通过/驳回"生命周期。
3. **不建 CurrentAdmission / 不持久化 REJECT**：门禁判定是同步计算，不建判定记录表，拒绝理由不写入数据库形成独立驳回记录。
4. **P2 V1 无 MANUAL_EXCEPTION**：没有人工豁免/放行机制。
5. **Changdu V1 试读**：最多物化上游真实返回的前 3 章；少于 3 章按实际数量；禁止用 `allEpis`/`totalChapterCount` 补造章节。
6. **`payEpisFrom` 只存来源值**：不因后续变化自动撤回、删除正文、重算 SEO 或推送 IndexNow。
7. **PromoLink 缺失禁止发布**：这是 Hard Gate，没有任何绕过路径。**Owner supersession 原文 §四（Promo Gate 条款）进一步明文规定**具体理由码为三项——`promo_link_missing`（PromoLink 不存在）、`promo_link_not_ready`（PromoLink 存在但未达 fetched/可用态）、`promo_url_invalid`（PromoLink 跳转 URL 未通过校验）。**这三项是原文明文列举的 Owner 决定，不是执行方对"PromoLink 缺失禁止发布"这句话的推论或延伸**——§3 理由码表逐项引用本条时以此为准。
8. **`splitRatio`、`source_label` 不参与发布 Gate**：分成比例是渠道业务元数据，来源标签是展示信息，两者都不构成发布与否的判断依据。

### 0.2 本节明确取代的旧内容

以下内容被本节**取代**，不再是本契约的有效口径：

- **旧四态准入候选合同**（`PASS`/`DRAFT`/`REJECT`/`MANUAL_EXCEPTION`）——本契约从未落地过这套状态机，任何未来实现都不得引入；
- **Manual Exception 机制**——参见决策 4，V1 没有人工特批通道；
- **旧"动态全量物化 `chapterList` 返回章节且禁止固定 `preview=3`"口径**——现行口径是决策 5：**固定 cap=3**（上限，不是"全量物化"），少于 3 章按实际数量，`allEpis` 永远不补章；
- **`payEpisFrom`"自动停止公开/退出 SEO"口径**——现行口径是决策 6：只存来源值，不触发任何自动动作（含不自动停止公开、不自动退出 SEO/sitemap/IndexNow）。

### 0.3 关于 `P2_HANDOFF_INPUT.md` 的引用边界

`docs/governance/P2_HANDOFF_INPUT.md` 是**较早的输入材料**，成文早于本轮
P2-01 Owner 决策，**不包含**本节记录的八条决策或任何 supersession 内容。
本文件其余章节引用它时，只把它当作背景材料（P2 目标、既有基础、待决项等），
不得暗示、不得虚构它已经包含本节的 supersession 结论——凡是与本节冲突或
本节新增的口径，只以本节为准，不追溯到 `P2_HANDOFF_INPUT.md` 找依据。

---

## 1. Owner 冻结口径（十三条决策，P1 阶段背景）

以下十三条摘自 Owner 对 P2-01 的早期裁决，是本契约的背景依据；凡与 §0 冲突，
以 §0 为准。未被 §0 触及的部分（不建结果表、不持久化 REJECT、locale gate、
页面身份冲突、权利态等）仍然有效：

1. **沿用 CPS 设计**：发布门禁的整体形态（发布前硬校验、失败即保持草稿）照搬 CPS，不重新发明一套准入哲学。
2. **不新增独立 Admission 状态机**：没有第二套"待审/通过/驳回"生命周期，发布结果只是"通过"或"带理由拒绝"。
3. **不新增结果表**：门禁判定是同步计算，不持久化为一张"判定记录"表。
4. **不持久化 REJECT**：拒绝理由是本次调用的返回值，不写入数据库形成独立的驳回记录。
5. **V1 无 MANUAL_EXCEPTION**：没有人工豁免/放行机制；条件不满足就是不满足，没有"人工特批通过"这条路径。
6. **发布资格只在 publish-time 检查（含 scheduled 到点翻转走同一 gate）**：这是对 CPS 已知缺口的修正——
   CPS 的 cron 定时翻转（`src/instrumentation.ts:18-72`）在到点发布时**不复查**门禁，只要 `scheduled` 状态成立就直接翻转；
   小说侧冻结为进入 `published` 的**每一次**转换都必须过同一个 gate，包括到点自动发布。
7. **条件不满足保持 draft + 拒绝本次 now/scheduled + 返回稳定 reason**：不引入第二个"半发布"状态，
   失败的直接后果就是内容留在既有的 `draft`，附带机器可读的理由码。
8. **PromoLink 为 Hard Gate**：见 §0 决策 7——缺失时没有任何绕过路径；具体理由码来自 §0 决策 7 引用的原文 §四 Promo Gate 条款。
9. **splitRatio/source_label 永不参与准入**：见 §0 决策 8。
10. **payEpisFrom 只存来源值不监听变化**：见 §0 决策 6。
11. **Changdu V1 试读 ≤3 章仅真实返回章节、禁止用总数补造**：见 §0 决策 5。
12. **CSV/XLSX 常驻导入继续 DROP**：批量导入通道整体废弃（延续 P1 立项书 §4.2 的既有裁决），
    本契约不为它开任何口子。
13. **不实现具体校验器/HTTP client/接口**：本轮只交付类型、注册表常量与**三个纯函数**
    （`narrowPublishIntent`、`narrowPublishGateReason`、`createPublishGateResult`），不落地任何实际读数据库、
    调用渠道接口或触达 Worker 的代码。

---

## 2. CPS parity matrix

判定级别沿用 `docs/p1/P1_CPS_PARITY_MATRIX.md` §判定级别的完整四级定义：

| 级别 | 含义 |
| --- | --- |
| `CPS_PARITY` | 形态与语义都照搬 |
| `CPS_PARITY_ADAPTED` | 形态照搬，数据/命名/协议换小说语义 |
| `ORIGINAL_REQUIRED` | CPS 无对应物，或 CPS 现状本身是反例——**必须说明原因** |
| `DROP` | CPS 有但明确不搬 |

| 维度 | CPS 机制（file:line） | 小说侧承接 | 结论 |
| --- | --- | --- | --- |
| 生命周期 | `Article.status` 是普通 `String` 字段，`@default("draft")` 后仅跟一句行注释列出 `draft/pending/published/offline` 四值（`src/lib/constants.ts:6-11`、`prisma/schema.prisma:561`）——仅字段注释约定，无约束、无状态机 | 复用既有 `ARTICLE_STATUSES`：`draft/published/unpublished/takedown`（`src/domain/database-statuses.ts:22`）；无 `pending`；`scheduled` = `draft` + `publishAt` | `CPS_PARITY_ADAPTED`（受既有 domain 冻结约束，不新增状态） |
| 发布意图（draft/now/scheduled） | `publishType` = `z.enum(["draft","now","scheduled"])`，仅入参不落库（`src/lib/validators/article.ts:14`、`src/lib/article-generation.ts:63-91`；默认 `draft` 见 `docs/p1/P1_ADMIN_PARITY_SPEC.md:146`） | `PUBLISH_INTENTS` 同值同语义 | `CPS_PARITY` |
| 定时发布 | `scheduled` → `status=pending` + node-cron 每分钟翻转，翻转时**不复查**门禁（`src/instrumentation.ts:18-72`，已知缺口） | 冻结：进入 `published` 的每次转换（含到点翻转）都必须过同一个 gate | `CPS_PARITY_ADAPTED`（Owner 决策 6，不复制 CPS 缺口） |
| PromoLink 存在性/可用态门禁 | 发布前检查 `Drama.promoUrl` 非空，来源无关（`src/actions/drama-publish-actions.ts:110-114`、`src/actions/article-actions.ts:563-567`、`src/lib/batch-actions-core.ts:188-197`） | `promo_link_missing` / `promo_link_not_ready` / `promo_url_invalid` 三项 Hard Gate（§0 决策 7，原文 §四 Promo Gate 条款明文列举） | `CPS_PARITY` |
| `public_redirect_code`（公开跳转短码本身） | CPS `promoCode` 概念相近，但字段级不变量不同：CPS 没有"全局唯一、永不复用、创建后不可变"的显式约束（换绑流查 `promoCode` 处：`src/lib/article-drama-switch-service.ts:257-262`） | 小说侧原创约束：`prisma/schema.prisma:481` 定义 `publicRedirectCode` 为 `@unique` 且非可空（NOT NULL + UNIQUE）；唯一生成入口 `src/lib/redirect/public-redirect-code.ts`（`CLAUDE.md` §3.2.1、§5 修正 6：全局唯一、永不复用、不可变、唯一索引不排除软删）。仍是发布硬前置，但业务层因 DB 约束永远到达不了"码未分配"这个失败态，故不在 `PUBLISH_GATE_REASONS` 登记对应理由码 | `ORIGINAL_REQUIRED`（理由：该字段的具体不变量为小说侧原创，非 CPS 直接搬迁） |
| Locale gate | blog 族白名单 `normalizeBlogArticleFamilyLocale`（`src/lib/supported-site-locales.ts:46-65`）+ 模板/剧集语种一致校验（`src/lib/template-locale-guard.ts:13-28`） | `locale_not_publishable` 对应 `isPublishableLocale(novel.locale)` 为 `false`；唯一真源是 `src/lib/locale/locale-canonical.ts:143-145`（`CLAUDE.md` §3.2.1 登记的唯一真源文件），fail-closed，实现是小说侧唯一真源，非 CPS 白名单的直接搬迁 | `CPS_PARITY`（概念对齐：都是发布前语种白名单硬门禁） |
| 页面身份冲突 | `(locale, slug)` `@@unique`（`prisma/schema.prisma:577`）+ slug 预检 + `publicPageShortId` fail-closed 守卫（`src/lib/article-public-page-id.ts:94-128`）+ 换绑流 `duplicate_page` 硬拒（`src/lib/article-drama-switch-service.ts:333-350,404-422`） | `page_identity_conflict` | `CPS_PARITY` |
| 权利态 | `Drama.rightsStatus` 枚举 `unknown/cleared/restricted/takedown`（`src/lib/constants.ts:32-37`；`takedownDrama` → 前台 410） | `rights_blocked`，对应小说侧 `takedown`/`withdrawn` 语义 | `CPS_PARITY` |
| 发布检查结果（multi-reason DTO） | 无稳定机器码、直接抛中文串、first-failure-only、V2 catch 会外泄内部 exception message（`src/actions/article-actions.ts:1129-1136,1419-1426`，已知缺口） | 稳定 `snake_case` reason 码、`createPublishGateResult` 一次可携带多个理由、结果无自由文本字段（沿用 `src/contracts/errors.ts` 的纪律）；这是 DTO 归一 helper，不是 evaluator（见 §6） | `CPS_PARITY_ADAPTED`（不复制 CPS 的信息外泄缺口） |
| 准入平台 | 无 admission 状态机、无评分、无分成比例门、无来源标签门、无发布期人工豁免（全仓核实；`tests/article-generation-promo-gate.test.ts:125` 在测试级强制来源无关） | 同样不建 admission 平台、不建评分、不建人工豁免（§0 决策 2/3/4） | `CPS_PARITY`（保持缺席） |
| Changdu Preview 规则（试读物化上限） | 无对应概念（CPS 是短剧，无章节实体） | Changdu V1 cap=3 冻结在本文档（见 §4），落点是既有 `NovelPreviewPolicy.maxMaterializedChapters`，非通用 Gate 模块常量 | `ORIGINAL_REQUIRED`（理由：CPS 无章节实体，无从对应；试读章节物化是小说侧独有概念） |
| `payEpisFrom` | 无对应概念 | 只存 `paid_from_chapter` 来源值，不监听变化触发任何动作（§0 决策 6） | `ORIGINAL_REQUIRED`（理由：CPS 无对应字段/概念） |
| CSV/XLSX 常驻导入 | CPS 有 `/import` 批量表格导入通道（P1 阶段读取证据，详见 `docs/p1/P1_CPS_PARITY_MATRIX.md` §1 菜单矩阵"批量导入"行） | 不建；批量导入通道整体废弃（P1 立项书 §4.2 既有裁决，§0 决策未推翻，本轮再次确认） | `DROP` |

---

## 3. Reason 码表

`PUBLISH_GATE_REASONS` 的十个理由码全部为**阻断级**：任一出现即拒绝本次
`now`/`scheduled`，内容保持 `draft`；`createPublishGateResult` 可一次归一多个
理由，按下表顺序输出。

| 理由码 | 冻结条件 | 依据 |
| --- | --- | --- |
| `locale_not_publishable` | `isPublishableLocale(novel.locale)` 为 `false` | `src/lib/locale/locale-canonical.ts`；D-7 fail-closed |
| `required_metadata_missing` | 标题/slug/正文等发布硬字段缺失；可携带 `RequiredMetadataMissingDetail.missingFields`（P2-07 填充） | 对应 `article` 表 `published` 行 CHECK 约束语义；字段域见 `PUBLISH_REQUIRED_METADATA_FIELDS` |
| `preview_chapter_missing` | 无可信已物化、可公开的试读章节 | §4；章节真源边界 |
| `preview_body_missing` | 已物化试读章节存在，但正文为空 | §4 |
| `promo_link_missing` | PromoLink 记录不存在 | Hard Gate；§0 决策 7（原文 §四 Promo Gate 条款明文列举，非推论）；CPS `promoUrl` 门禁概念对齐 |
| `promo_link_not_ready` | PromoLink 存在但未达 `fetched`/可用态 | Hard Gate；§0 决策 7（原文 §四 Promo Gate 条款明文列举，非推论） |
| `promo_url_invalid` | PromoLink 的跳转 URL 未通过校验 | Hard Gate；§0 决策 7（原文 §四 Promo Gate 条款明文列举，非推论）——这是 Owner 原文的明文规定，不是执行方对"PromoLink 缺失禁止发布"这句话的推论或延伸 |
| `page_identity_conflict` | slug / `(novelId, locale)` / 短码等页面身份冲突 | CPS `duplicate_page` parity |
| `rights_blocked` | 权利态阻断（`takedown`/`withdrawn` 等） | CPS `rightsStatus` parity |
| `blocking_sync_exception` | `createPublishGateResult` 归一阶段的 fail-closed 收敛：候选理由不在本注册表内，或输入本身不是数组 | DTO 层输入卫生（hygiene），不是门禁评估；未登记的理由不丢弃、不静默通过 |

**已移除**：`public_redirect_code_missing`。原因：`PromoLink.publicRedirectCode`
在数据库层是 `NOT NULL + UNIQUE`（`prisma/schema.prisma:481`），业务层永远不会
观察到"码未分配"这个状态；该约束仍然是发布的硬前置条件（分类
`ORIGINAL_REQUIRED`，见 §2），但不应该在业务层制造一个不可达的理由码。

---

## 4. 试读物化政策（冻结，P2-05 落地）

`P2-01` 不能安全初始化 `NovelPreviewPolicy` 行——那是数据库落地的职责，属于
`P2-05` 范围。因此本轮把 cap 的口径**冻结在本文档**，不在
`src/contracts/publish-gate.ts` 里定义 `CHANGDU_PREVIEW_CHAPTER_CAP` 之类的常量：

- Changdu V1 试读上限 **cap = 3**，落点是既有 `NovelPreviewPolicy.maxMaterializedChapters` 列（该列本就存在，Changdu 的策略行由 `P2-05` 初始化为 3，不需要新增 migration）；
- 物化数量 = `min(可信 chapterList[] 实际返回数量, policy cap)`；少于 cap 按实际数量；
- `allEpis` / `totalChapterCount` 永远只是标量，绝不用来生成、补造章节行；
- 通用 Gate 模块（`publish-gate.ts`）只检查"是否存在真实、正文非空、可公开的 Preview"，不掌握、也不计算具体物化数量——对应 `preview_chapter_missing` / `preview_body_missing` 两个理由码（见 §3）。

---

## 5. 本轮明确不实现清单

照 Owner 任务书第四节（本轮范围边界），以下项目**不在本次交付内**：

- Schema / migration 改动（含 `NovelPreviewPolicy` 的任何 Changdu 策略行初始化——留给 `P2-05`）；
- Admission 结果表、Admission 状态枚举、`MANUAL_EXCEPTION`（§0 决策 2/3/4）；
- `policyVersion` 或任何版本化豁免配置；
- override / waiver / allowlist 一类的人工放行清单；
- 实际发起校验的 HTTP client；
- 三个消费方接口（后台发布检查 UI、批量发布/撤回 Server Action、到点调度翻转）的具体实现；
- 试读章节物化 Worker 逻辑，以及 `NovelPreviewPolicy` 的读写（`P2-05`）；
- 真正逐项执行发布检查、产出 reasons 的 evaluator（`P2-07`）；
- 批量发布/撤回流程；
- Sitemap、IndexNow/outbox 具体实现；
- Admin UI 页面；
- 正式公共路由。

本次交付仅是 `src/contracts/` 下的类型、注册表常量与**三个纯函数**
（`narrowPublishIntent`、`narrowPublishGateReason`、`createPublishGateResult`），供后续任务引用。

---

## 6. `createPublishGateResult` 是 DTO helper，不是 evaluator

🔴 这条边界本身也是本轮修订的一部分，写清楚是为了防止后续实现方误用：

- `createPublishGateResult(candidateReasons)` 只做**去重 + 按注册表顺序排序 +
  fail-closed 归一**（未登记值、非数组输入 → `blocking_sync_exception`），
  这是 DTO 层的输入卫生（hygiene），不是执行 locale/metadata/preview/promo/
  身份/权利检查的门禁评估本身；
- 调用方传入空数组，`createPublishGateResult` 返回 `publishable: true`——但这
  只代表"这次调用没有收到失败理由"，**不代表所有检查项都已经被执行过**；
  `PublishGateResult` 的形状恒为 `{ publishable, reasons }` 两个字段，没有第
  三个字段能携带"检查已执行"这类证明；
- 真正逐项执行发布检查、决定该传入哪些理由的是 **P2-07** 的 evaluator，不在
  本轮交付范围内（见 §5）。

---

## 7. 测试清单

对应 `tests/ui/publish-gate-contract.test.ts`，vitest `ui` project：

🔴 **`expectTypeOf` 类型层断言在 `npm run typecheck` 之外没有把关力**：`vitest
run` 执行时这类断言会编译期擦除、运行时不做任何校验，只是 `tsc --noEmit` 阶段
才真正比对类型是否精确相等。因此下表里标了"类型层"的两条（`PublishGateResult`
形状、`RequiredMetadataMissingDetail` 形状）对"结果无自由文本字段"这条不变量
而言，**`npm run typecheck` 是承重的（load-bearing）**——只跑 `npm run test:ui`
不足以验证过这两条形状约束，两个命令必须都跑。

| 分组 | 覆盖点 |
| --- | --- |
| stripSource 自检 | 双变体扫描器：`codeOnly`（字符串清空，验证字面量里的 `//` 不吞掉同一行后续真实代码）与 `valueVisible`（只剥注释、字符串内容原样保留，验证禁用值藏不进字符串字面量）；两者都正确剥离行注释/块注释；回归证据覆盖 `NOVEL_LIFECYCLE` 式字符串数组与藏进字符串的 `splitRatio` |
| 🔴 生命周期不复制第二套 | `PUBLISH_INTENTS` 精确值；剥注释源码（valueVisible）无 `pending`/`offline`；不为 `ARTICLE_STATUSES` 建第二份同值数组；任何导出数组不得混入 `published`/`unpublished`/`takedown`（防改序或部分复制） |
| 🔴 模块导出面精确锁定 | `Object.keys(publishGate).sort()` 精确等于冻结的八个导出名——防止复活 cap 常量或新增任何游离导出 |
| 🔴 无 Admission 四态 / 无 Manual Exception | `src/contracts/` 全目录（valueVisible）无 admission / manual exception / override / waiver / allowlist；导出名不含 admission/exception，命中值只能是 `blocking_sync_exception` |
| 🔴 Hard Gate（PromoLink） | `PUBLISH_GATE_REASONS` 精确等于冻结的十元素列表（防新增/删除/改序）且数组本身冻结；`public_redirect_code_missing` 已不在册；`promo_link_missing`/`promo_link_not_ready`/`promo_url_invalid` 在册；单独出现即拒绝 |
| 🔴 分成比例/来源标签不进 gate | 理由码不含 split/label/pay；剥注释源码（valueVisible）无 splitRatio 等敏感标识 |
| 🔴 试读物化规则移出通用 Gate 模块 | 模块导出无 `/^CHANGDU/`、`/^PREVIEW_MAX/` 前缀键；`resolveChangduPreviewChapterCount` 不再导出；剥注释源码（valueVisible）无 `allEpis` |
| `createPublishGateResult` 行为（DTO 归一，不是 evaluator） | 旧名 `buildPublishGateResult` 不再导出；空输入通过；多理由去重且按注册表顺序；未登记理由收敛为 `blocking_sync_exception`；非数组输入同样 fail-closed 不抛异常；结果与数组冻结；结果无自由文本字段（`expectTypeOf` 类型层形状校验，见上方 load-bearing 说明）；空 reasons 不证明所有 Gate 已执行 |
| PublishIntent 行为 | 合法值识别；非法值收敛为 `null`；默认值 `draft`；注册表冻结 |
| `required_metadata_missing` 详情 DTO 形状 | `PUBLISH_REQUIRED_METADATA_FIELDS` 精确等于 `[title, slug, body]` 且冻结；`RequiredMetadataMissingDetail` 类型层形状校验（见上方 load-bearing 说明）；不混入 `PublishGateResult` 形状 |
| `paid_from_chapter` 政策 | 四个自动动作全部关闭；对象冻结 |

---

```text
NEXT_GATE=CODEX_P2_01_CONTRACT_REVIEW
```
