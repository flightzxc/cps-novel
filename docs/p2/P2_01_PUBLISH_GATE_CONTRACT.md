# P2-01 · 发布门禁共享契约

> 基线：`BASE 62453d2`（分支 `feature/v0.1.0-p2-01-publish-contract`）
> CPS 参照基线：`d77c3b968285698529cf97c7f0f97b286d7a2a9c`（只读参考，见 `CLAUDE.md` §2）
> 状态：待 Codex 契约审查
> 变更级别：🔴 `FROZEN`（变更需 Owner 确认）
> 输入依据：`docs/governance/P2_HANDOFF_INPUT.md` §3（P2 不得重新设计的冻结边界）、
> §5（多语发布前置）、§9（发布准入服务）

本文件是 `src/contracts/publish-gate.ts` 的权威依据。契约本身零业务逻辑实现——
它只登记发布意图、失败理由码、Changdu 试读上限与 `paid_from_chapter` 政策的**形状与语义**，
供 Claude 前台/后台 UI 与 Codex 后端发布准入服务共同引用，防止两侧各自发明一套判定。

---

## 1. Owner 冻结口径（十三条决策）

以下十三条摘自 Owner 对 P2-01 的裁决，是本契约的直接依据；任何实现分歧以此为准：

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
8. **PromoLink + public_redirect_code 为 Hard Gate**：这两项缺失时**没有任何绕过路径**，
   对应 CPS 侧发布前对 `Drama.promoUrl` 的强制检查。
9. **splitRatio/source_label 永不参与准入**：分成比例是渠道业务元数据，来源标签是展示信息，
   两者都不构成发布与否的判断依据（呼应 `src/domain/database-invariants.ts` 的
   `splitRatioMetadata` 不变量）。
10. **payEpisFrom 只存来源值不监听变化**：`paid_from_chapter` 仅作为落库的来源字段，
    它的变化不触发撤回、删除正文、重算 SEO 或重新推送 IndexNow 等任何自动动作。
11. **Changdu V1 试读 ≤3 章仅真实返回章节、禁止用总数补造**：物化的试读章节数取
    `min(上游可信返回的实际章节数, 3)`，`totalChapterCount`/上游总章数标量绝不用来"补"出并不存在的章节行。
12. **CSV/XLSX 常驻导入继续 DROP**：批量导入通道整体废弃（延续 P1 立项书 §4.2 的既有裁决），
    本契约不为它开任何口子。
13. **不实现具体校验器/HTTP client/接口**：本轮只交付类型、注册表常量与两个纯函数
    （`narrowPublishGateReason`、`buildPublishGateResult`），不落地任何实际读数据库、
    调用渠道接口或触达 Worker 的代码。

---

## 2. CPS parity matrix

判定级别沿用 `docs/p1/P1_CPS_PARITY_MATRIX.md` §判定级别的既有定义：
`CPS_PARITY`（形态与语义都照搬）/ `CPS_PARITY_ADAPTED`（形态照搬，数据/命名/协议换小说语义）。

| 维度 | CPS 机制（file:line） | 小说侧承接 | 结论 |
| --- | --- | --- | --- |
| 生命周期 | `Article.status` 是普通 `String` 字段，`@default("draft")` 后仅跟一句行注释列出 `draft/pending/published/offline` 四值（`src/lib/constants.ts:6-11`、`prisma/schema.prisma:561`）——仅字段注释约定，无约束、无状态机 | 复用既有 `ARTICLE_STATUSES`：`draft/published/unpublished/takedown`（`src/domain/database-statuses.ts:22`）；无 `pending`；`scheduled` = `draft` + `publishAt` | `CPS_PARITY_ADAPTED`（受既有 domain 冻结约束，不新增状态） |
| 发布意图 | `publishType` = `z.enum(["draft","now","scheduled"])`，仅入参不落库（`src/lib/validators/article.ts:14`、`src/lib/article-generation.ts:63-91`；默认 `draft` 见 `docs/p1/P1_ADMIN_PARITY_SPEC.md:146`） | `PUBLISH_INTENTS` 同值同语义 | `CPS_PARITY` |
| 定时发布 | `scheduled` → `status=pending` + node-cron 每分钟翻转，翻转时**不复查**门禁（`src/instrumentation.ts:18-72`，已知缺口） | 冻结：进入 `published` 的每次转换（含到点翻转）都必须过同一个 gate | `CPS_PARITY_ADAPTED`（Owner 决策 6，不复制 CPS 缺口） |
| Promo Hard Gate | 发布前检查 `Drama.promoUrl` 非空，来源无关（`src/actions/drama-publish-actions.ts:110-114`、`src/actions/article-actions.ts:563-567`、`src/lib/batch-actions-core.ts:188-197`；换绑流另查 `promoCode`，`src/lib/article-drama-switch-service.ts:257-262`） | `promo_link_missing` / `public_redirect_code_missing`：PromoLink 须为 `fetched` 且公开跳转码已分配（Owner 决策 8；对应 CPS `src/actions/drama-publish-actions.ts:110-114` 的强制检查） | `CPS_PARITY` |
| Locale gate | blog 族白名单 `normalizeBlogArticleFamilyLocale`（`src/lib/supported-site-locales.ts:46-65`）+ 模板/剧集语种一致校验（`src/lib/template-locale-guard.ts:13-28`） | 唯一真源 `isPublishableLocale`，fail-closed（`src/lib/locale/locale-canonical.ts:143-145`） | `locale_not_publishable`，概念对齐 `CPS_PARITY`，实现是小说侧唯一真源 |
| 页面身份冲突 | `(locale, slug)` `@@unique`（`prisma/schema.prisma:577`）+ slug 预检 + `publicPageShortId` fail-closed 守卫（`src/lib/article-public-page-id.ts:94-128`）+ 换绑流 `duplicate_page` 硬拒（`src/lib/article-drama-switch-service.ts:333-350,404-422`） | `page_identity_conflict` | `CPS_PARITY` |
| 权利态 | `Drama.rightsStatus` 枚举 `unknown/cleared/restricted/takedown`（`src/lib/constants.ts:32-37`；`takedownDrama` → 前台 410） | `rights_blocked`，对应小说侧 `takedown`/`withdrawn` 语义 | `CPS_PARITY` |
| 错误契约 | 无稳定机器码、直接抛中文串、first-failure-only、V2 catch 会外泄内部 exception message（`src/actions/article-actions.ts:1129-1136,1419-1426`，已知缺口） | 稳定 `snake_case` reason 码、一次可携带多个理由、结果无自由文本字段（沿用 `src/contracts/errors.ts` 的纪律） | `CPS_PARITY_ADAPTED`（Owner 决策 7；不复制 CPS 的信息外泄缺口） |
| 准入平台 | 无 admission 状态机、无评分、无分成比例门、无来源标签门、无发布期人工豁免（全仓核实；`tests/article-generation-promo-gate.test.ts:125` 在测试级强制来源无关） | 同样不建 admission 平台、不建评分、不建人工豁免 | `CPS_PARITY`（保持缺席） |
| 试读 | 无对应概念（CPS 是短剧，无章节实体） | Changdu V1 上限 3 章，仅物化上游可信实际返回的章节 | `CPS_PARITY_ADAPTED` |
| `payEpisFrom` | 无对应概念 | 只存 `paid_from_chapter` 来源值，不监听变化触发任何动作 | `CPS_PARITY_ADAPTED` |

---

## 3. Reason 码表

`PUBLISH_GATE_REASONS` 的八个理由码全部为**阻断级**：任一出现即拒绝本次 `now`/`scheduled`，
内容保持 `draft`；`buildPublishGateResult` 可一次返回多个理由，按下表顺序输出。

| 理由码 | 冻结条件 | 依据 |
| --- | --- | --- |
| `locale_not_publishable` | `isPublishableLocale(novel.locale)` 为 `false` | `src/lib/locale/locale-canonical.ts`；D-7 fail-closed |
| `required_metadata_missing` | 标题/slug/正文等发布硬字段缺失 | 对应 `article` 表 `published` 行 CHECK 约束语义 |
| `preview_unavailable` | 无可信已物化的试读章节 | `docs/governance/P2_HANDOFF_INPUT.md` §3.2/§3.3 章节真源边界 |
| `promo_link_missing` | PromoLink 缺失，或状态非 `fetched` | Hard Gate；CPS `promoUrl` 门禁 parity |
| `public_redirect_code_missing` | 公开跳转短码未分配 | Hard Gate；CPS `promoCode` parity |
| `page_identity_conflict` | slug / `(novelId, locale)` / 短码等页面身份冲突 | CPS `duplicate_page` parity |
| `rights_blocked` | 权利态阻断（`takedown`/`withdrawn` 等） | CPS `rightsStatus` parity |
| `blocking_exception` | 机器校验存在未处置异常；或候选理由不在本注册表内 | fail-closed 收敛：未登记的理由不丢弃、不静默通过 |

---

## 4. 本轮明确不实现清单

照 Owner 任务书第四节（本轮范围边界），以下项目**不在本次交付内**：

- Schema / migration 改动；
- Admission 结果表、Admission 状态枚举、`MANUAL_EXCEPTION`；
- `policyVersion` 或任何版本化豁免配置；
- override / waiver / allowlist 一类的人工放行清单；
- 实际发起校验的 HTTP client；
- 三个消费方接口（后台发布检查 UI、批量发布/撤回 Server Action、到点调度翻转）的具体实现；
- 试读章节物化 Worker 逻辑；
- 批量发布/撤回流程；
- Sitemap、IndexNow/outbox 具体实现；
- Admin UI 页面；
- 正式公共路由。

本次交付仅是 `src/contracts/` 下的类型、注册表常量与两个纯函数，供后续任务引用。

---

## 5. 测试清单

对应 `tests/ui/publish-gate-contract.test.ts`，vitest `ui` project：

| 分组 | 覆盖点 |
| --- | --- |
| stripComments 自检 | 字符串字面量里的 `//` 不会把同一行后续真实代码一并剥掉（防止扫描器自身的假阴性）；真实行注释仍被正确剥离 |
| 🔴 生命周期不复制第二套 | `PUBLISH_INTENTS` 精确值；剥注释源码无 `pending`/`offline`；不为 `ARTICLE_STATUSES` 建第二份同值数组；任何导出数组不得混入 `published`/`unpublished`/`takedown`（防改序或部分复制） |
| 🔴 无 Admission 四态 / 无 Manual Exception | `src/contracts/` 全目录无 admission / manual exception / override / waiver / allowlist；导出名不含 admission/exception |
| 🔴 Hard Gate | `PUBLISH_GATE_REASONS` 精确等于冻结的八元素列表（防新增/删除/改序）且数组本身冻结；`promo_link_missing`、`public_redirect_code_missing` 在册；单独出现即拒绝 |
| 🔴 分成比例/来源标签不进 gate | 理由码不含 split/label/pay；剥注释源码无 splitRatio 等敏感标识 |
| Gate 行为 | 空输入通过；多理由去重且按注册表顺序；未登记理由收敛为 `blocking_exception`；非数组输入同样 fail-closed 不抛异常；结果与数组冻结；结果无自由文本字段（含 `expectTypeOf` 类型层形状校验，运行时键检查之外再钉一遍类型） |
| PublishIntent 行为 | 合法值识别；非法值收敛为 `null`；默认值 `draft`；注册表冻结 |
| 🔴 Changdu 试读上限 | 上限恒为 3；与 `PREVIEW_MATERIALIZATION_POLICIES[0]` 的值导入一致；`CHANGDU_PREVIEW_POLICY` 冻结；输入映射表含 `Infinity`/`-Infinity`/`-0`/`true`/`3.0` 边界值，`-0` 用 `Object.is` 精确比对；单一入参 |
| 🔴 allEpis 不是物化输入 | 剥注释源码无 `allEpis`；`CHANGDU_PREVIEW_POLICY` 仅两个键 |
| `paid_from_chapter` 政策 | 四个自动动作全部关闭；对象冻结 |

---

```text
NEXT_GATE=CODEX_P2_01_CONTRACT_REVIEW
```
