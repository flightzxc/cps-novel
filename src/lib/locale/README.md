# src/lib/locale/

**Owner: Claude（独占写入）**

## 用途

上游语种码 → 站点 locale 的映射，以及公开面两层 locale 模型（静态登记表 + 动态活跃集）的查询入口。

## 唯一真源

```
src/lib/locale/locale-canonical.ts   ← 对外 API（resolveSiteLocale）+ 站点 locale 登记表 SITE_LOCALES（静态层）
src/lib/locale/channel-language.ts   ← L10N P1 新增：上游 moboreader 码表/别名表/resolveChannelLanguage/熔断评估，locale-canonical.ts 委托这里
src/lib/locale/active-locales.ts     ← L10N P4 新增：动态层 getActiveLocales()/queryActiveLocales()——SITE_LOCALES 的子集，按公开可见谓词族算出
src/lib/locale/active-locales-tag.ts ← L10N P4 新增：动态层 unstable_cache 标签名 ACTIVE_LOCALES_CACHE_TAG 单独拆出的零依赖模块（见该层小节说明为什么不能直接从 active-locales.ts 导入）
src/lib/locale/root-negotiation.ts   ← L10N P4 新增：根路径 Accept-Language/cookie 协商，COPY 自 CPS root-negotiation.ts
```

🔴 **L10N P4（2026-09-10）：发布白名单层已整体删除，不是改造。** `PUBLISHABLE_LOCALES`/
`isPublishableLocale`/`listPublishableLocales`/`pickPublishableLocale`/
`ARTICLE_TEMPLATE_CRUD_LANDED`/`assertPublishableLocalesFailClosed` 全部从
`locale-canonical.ts`/`request-locale.ts` 删除，不留别名壳。公开面从"三层"
（登记 → 可发布白名单 → 实际路由）收口为 CPS 同构的"两层"：

| 层 | 定义 | 住在哪 | 供谁读 |
| --- | --- | --- | --- |
| 静态层 | `SITE_LOCALES`（同步、常量、15 语） | `locale-canonical.ts` | 路由（`proxy.ts`/`[locale]/_guard.ts`）、sitemap 默认、IndexNow 资格、hreflang 枚举、后台语种下拉 |
| 动态层 | `getActiveLocales()`（异步、按公开可见谓词族算出、⊆ 静态层、`en` 恒含） | `active-locales.ts` | 目前只有一处：`SiteChrome.activeLocales` → `SiteHeader` → `LocaleSwitcher` |

**CPS 用静态集的地方海阅不得换动态集，反之亦然**——两层各自的消费点边界见
`docs/governance/port-registry.md` 的 L10N P4 小节 §1 清单①②。

🔴 **全项目唯一的语种映射实现，两个文件合起来算一处。** 禁止在这两个文件之外的任何位置出现第二处语种映射硬编码——CPS 因语种映射散落四处，付过两次全库 normalize 的代价。`tests/ui/locale-canonical.test.ts`「没有第二张语种映射表」/「没有第二份 normalize 实现」两条扫描已把排除范围从单文件扩到这两个文件。

## 当前状态（L10N P1，2026-09-10）

`locale-canonical.ts` 的 `resolveSiteLocale` 改为委托 `channel-language.ts` 的
`resolveChannelLanguage`（CPS `3a76877:src/lib/channel-language.ts` 的
COPY/ADAPT，见 `docs/governance/port-registry.md`）。**返回值形状变了**：

```
resolveSiteLocale(upstreamLanguageCode, upstreamLanguageName?)
  → { locale: string | null; confidence: "code" | "name_alias" | "unknown" }
```

这不是"扩展"旧签名（`SiteLocale | "unknown"`），是**替换**——旧签名装不下
"映射成功但不是站点语种"（`it`/`fil`/`ms`/`tr`）这个新状态。曾经把这个签名
标记 `FROZEN` 的 `docs/p1/P1_SHARED_CONTRACTS.md` §2 已同步改写，不再是
与本文件冲突的第二份口径。

| 表 | 状态 | 说明 |
| --- | --- | --- |
| 上游语种登记表 | **18 码（L10N P1）** | 值来自 `docs/governance/L10N_UPSTREAM_LANGUAGE_EVIDENCE_2026-09-10.md`——海阅自己 X8 库 `novel_source_item` 的真实成对 `(source_language_code, source_language_name)` 证据，住在 `channel-language.ts` 的 `MOBOREADER_LANGUAGE_CODE_TO_LOCALE`。未登记的数值码（含 code 19/20，上游 `languageName` 为 JSON `null`，零成对证据）依旧落 `{locale: null, confidence: "unknown"}` |
| 别名表 | CPS 完整表 | `channel-language.ts` 的 `LANGUAGE_NAME_ALIAS_TO_LOCALE` 是 CPS 原表的逐字 COPY（简体中文变体显式 `null`），不是过滤子集 |
| 熔断 | `total>=10 && conflicts>=3 && rate>=0.2` | `evaluateLanguageMappingSuspensions`，CPS 算法逐字 COPY，`worker/handlers/moboreader.ts` 按 `catalog_page` 粒度调用 |
| 发布白名单 | `{en}` | **U6 Owner 明示 D-7 放行 `en`，L10N P1 未改动。** 其余 14 语仍不进。S14 守卫允许 `{"en"}` 子集，模块加载不抛。 |

因此今天 `resolveSiteLocale(3)` → `{locale: "en", confidence: "code"}`、
`resolveSiteLocale(8)` → `{locale: "it", confidence: "code"}`（`it` 解析成功但
不是 `SITE_LOCALES` 成员）、`resolveSiteLocale(19)` →
`{locale: null, confidence: "unknown"}`；`isPublishableLocale("en")` 为
`true`，其余 14 语仍为 `false`，`listPublishableLocales()` 为 `["en"]`。
「解析出 locale」「是站点语种」「可发布」是三道各自独立的闸（`it` 已解析、
不是站点语种；`ru` 是站点语种、已解析、仍不可发布）。

### P0-S7a（2026-08-20）更新

`SITE_LOCALES`（**登记表**）已扩为 15 语，对齐 CPS 短剧站
`SUPPORTED_SITE_LOCALES`（`en`/`es`/`pt-BR`/`id`/`vi`/`th`/`ja`/`ko`/`zh-Hant`/`ar`/
`fr`/`de`/`pl`/`cs`/`ru`），Owner 已裁决"首批注册即全语种"。**登记 ≠ 可发布**——
U6 才按 Owner D-7 明示把 `en` 写入 `PUBLISHABLE_LOCALES`；其余 14 语仍不进。
新增任何 locale 必须先有 Owner 决策，且只能改这一个文件。

### P0-S14（本轮）更新：D-7 条件二 fail-closed 守卫

`locale-canonical.ts` 新增两个导出，**不属于**上面的冻结契约三元组，是给
`PUBLISHABLE_LOCALES` 自己用的模块加载期断言：

- `ARTICLE_TEMPLATE_CRUD_LANDED`（`boolean`，今天是 `false`）——`ArticleTemplate`
  CRUD 是否已经是真实机制而不是字面意义的"表存在于 schema"。翻转条件见该
  常量自己的行内注释。
- `assertPublishableLocalesFailClosed(locales, articleTemplateCrudLanded)`——
  只要后者是 `false`，前者的元素就必须 ⊆ `{"en"}`，否则模块一加载就抛。

背景：Opus 终审对 D-7 条件二的裁定是「内置默认 messages 目录让 `en` 实质满足
条件 2/3，但这份安全是巧合，不是机制」——`ArticleTemplate` CRUD 落地前，没有
任何东西拦着有人往 `PUBLISHABLE_LOCALES` 里加一个非 `en` 语种。这道守卫把
巧合钉成机制，正对应 CPS `v6.0.4` 事故的形状（只注册了前台 locale，漏了后台
模板枚举）。

### P0-S15（2026-08-26）更新：上游登记表首次填充

依据《C2 真上游只读诊断报告 2026-08-26》（执行基线 `d103cf2`，真实 `getlistpc`
接口 20 条样本）：`$.data.list[*].language` 20 条全为 number，标量集合
`{3, 7}`；`$.data.list[*].languageName` 20 条全为 string，集合
`{英语, 俄语}`；`$.data.currentLanguage` 为 number `{3}`。`language` 与
`languageName` 逐条成对出现，且与已归档 Lane B 证据一致：`3 → 英语 → en`，
`7 → 俄语 → ru`。`UPSTREAM_LANGUAGE_REGISTRY` 首次从空表填入这两条登记，每条
都带来源引用（见 `locale-canonical.ts` 内联注释）。

🔴 **这只是本页 20 条样本覆盖到的子集，不代表上游完整语种枚举。** 未登记的
数值码——即便看起来"像"某个语种——依旧返回 `unknown`，fail-closed 语义不变。
扩表规则不变：新增登记必须附带真实上游成对证据，禁止推测补齐。

**这不影响「映射 ≠ 可发布」。** U6 把 `PUBLISHABLE_LOCALES` 从空集改成 `{en}`
（Owner D-7 明示），P0-S14 的 D-7 条件二 fail-closed 守卫仍在——`{"en"}` 是
该守卫允许的子集。「上游码映射得到 locale」与「该 locale 可以发布」永远是
两道独立的闸；`7 → ru` 仍映射成功、仍不可发布。

### L10N P1（2026-09-10）更新：登记表扩到 18 码 + 存量重算工具

依据 `docs/governance/L10N_UPSTREAM_LANGUAGE_EVIDENCE_2026-09-10.md`（海阅自己
X8 库的真实成对证据，18 码全部有证据；CPS moboreader 无对应码表，仅同厂商跨
产品线交叉核对）：

- **`resolveSiteLocale` 返回形状换成 `{ locale, confidence }`**（见上方"当前
  状态"），映射失败/未登记码现在是 `{ locale: null, confidence: "unknown" }`，
  不再是字面串 `"unknown"`。
- `worker/handlers/moboreader.ts` 目录物化处按新形状写 `NovelSourceItem.
  sourceLocale`——**永不写字面串 `"unknown"`**，只写已解析 locale 或
  `NULL`；每个 `catalog_page` 任务项按 CPS `changdu-dry-run.ts:429-450` 的
  形状做一次熔断评估（`evaluateLanguageMappingSuspensions`），命中的码本批
  强制 `NULL`；任务结果 JSON 追加 `unknownLocaleCount`/
  `suspendedLanguageCodes`（只追加字段，不改既有字段）。
- `scripts/l10n/backfill-source-item-locale.ts`：对已入库行按新码表重算
  `sourceLocale`，默认 dry-run，`--apply` 需 `--approver`（存在且
  `status=active` 的 `AdminIdentity`）；幂等；本阶段（P1）不对生产/X8 执行
  `--apply`。

  🔴 **默认目标集是「从未被本轮码表重算过」的行，不是「全部 96 267 行」**（复核
  修复，2026-09-10）：X8 只读实测证明 `source_locale` 从来没有 SQL `NULL`
  过——`WHERE source_locale IS NULL` = **0** 行；P0-S15 之前的旧 worker 把"解析
  不出 locale"写成**字面串** `'unknown'`，不是 `NULL`。今天（2026-09-10）X8
  的真实分布：

  | `source_locale` 取值 | 行数 |
  | --- | ---: |
  | `'unknown'`（旧 worker 遗留字面串） | 50 625 |
  | `'en'` | 42 702 |
  | `'ru'` | 2 940 |
  | 合计 | 96 267 |

  （`en`/`ru` 恰好等于证据文档里 code 3/7 的样本数——P0-S15 的旧登记表只有这
  两码，其余全落 `'unknown'`。）默认（不给 `--re-resolve`）只扫
  `sourceLocale IS NULL OR sourceLocale = 'unknown'` 这两类，在今天的 X8 上
  即上表的 50 625 行；`--apply` 重算后无论是否解得出 locale，都不会再写回字面
  串 `'unknown'`——解不出就写 `NULL`（`resolveChannelLanguage` 本身就不返回
  `"unknown"`），字面串在这条路径上被顺带清除。`--re-resolve` 才会连同已经是
  真实 locale 值（如 `en`/`ru`）的行一并重算，用于码表本身发生变更之后的全量
  校验。
  `scanned === 0`（目标集本来就是空的）时 CLI 打印显式告警，且**不写**
  `OperationAudit`（一条 `scanned:0, changed:0` 的审计行会是"这轮工作从未真正
  发生"的假 provenance）；`scanned > 0` 但 `changed === 0`（扫到的行核对后确实
  不需要改）仍然写审计——这是一条真实的"已核对、无漂移"结论，不是空转。
- `scripts/l10n/probe-unnamed-language-codes.ts`：code 19/20（合计 15 970 行，
  16.6%，零成对证据）的认领探针，默认 dry-run 只读 DB 抽样，`--apply` 才会
  调用真实上游 `getchapterinfo`——P1 本身不执行 `--apply`。
- `src/app/(admin)/catalog-sync` 列表新增语种筛选，对齐 CPS
  `UNKNOWN_SOURCE_LOCALE_FILTER`（`"__unknown"`）与"全部语种/未知语种"下拉
  形态。

**这不影响任何一道既有的闸。** `SITE_LOCALES`/`PUBLISHABLE_LOCALES`/
`isPublishableLocale`/`listPublishableLocales`/`ARTICLE_TEMPLATE_CRUD_LANDED`/
D-7 fail-closed 守卫全部未改——18 码扩表只是让更多上游码"解析成功"，不改变
"解析成功"与"可发布"之间那道独立的闸。

### L10N P3（2026-09-10）更新：ArticleTemplate.locale 非空化 + 15 语默认模板资产

`施工提示词_Sonnet_L10N_P3_模板locale非空化与15语模板资产_2026-09-10.md` §1，矩阵 #5。这一轮不碰
`locale-canonical.ts`/`channel-language.ts` 的任何一处唯一真源——`SITE_LOCALES`（15 项，登记表）
本身没变，改的是**另一张表**（`ArticleTemplate`）如何使用它：

- `ArticleTemplate.locale` 从可空收口为数据库层 `NOT NULL DEFAULT 'en'`
  （`prisma/migrations/20260912090000_l10n_article_template_locale_not_null`），应用层
  `ArticleTemplateWrite.locale`（`src/lib/article-templates/contract.ts`）同步从
  `string | null` 收紧为必填 `string`，后台表单 `select[name=locale]` 加 `required`——三层对齐。
  `requireLocale`（`src/server/article-templates/service.ts`）删掉了旧版本"`null`/空白 = 全部语种"
  这个本仓自己发明、CPS 没有的第三态，只接受 `SITE_LOCALES` 成员；`selectActiveArticleTemplate`/
  `listActiveArticleTemplateOptions` 同步删掉各自那条 `{locale: null}` 通配 `OR` 分支，改精确匹配。
- 新增 `assets/article-templates/*.json`（15 份，每个 `SITE_LOCALES` 成员一份）+
  `manifest.json`（SHA-256 逐份钉死）+ `scripts/l10n/article-template-bootstrap.ts`
  （dry-run 默认、SHA 校验、结构不变量交叉校验——占位符/控制标记序列 + HTML 标签名序列都与
  `en.json` 逐一比对、`--apply --approver` 落库、按 `(templateKey, version)` 幂等 upsert、遇软删行
  跳过并告警、不复活不重建）。`en` 沿用既有 `system-default-v1`，其余 14 语各自独立
  `system-default-<locale>-v1`——每语种一个独立业务标识，不共用一份带通配语义的模板行。
- `ARTICLE_TEMPLATE_CRUD_LANDED`（本文件上一节，`locale-canonical.ts`）**今天仍是 `false`**，
  本轮完全没有改它，也不受本轮影响——它管的是"`ArticleTemplate` CRUD 是否已经是真实机制"这道
  D-7 条件二 fail-closed 守卫，跟"`ArticleTemplate.locale` 这一列本身是否非空"是两件事。翻转
  `ARTICLE_TEMPLATE_CRUD_LANDED` 仍需 P4 把 `PUBLISHABLE_LOCALES`/`proxy.ts` 那一整层按 Owner 决策
  打开，不是这一轮迁移或资产文件能单独触发的。

### L10N P4（2026-09-10）更新：公开面两层分层、根路径协商、白名单层删除

`施工提示词_Sonnet_L10N_P4_公开面两层分层与白名单删除_2026-09-10.md`，矩阵 #9/#10/#12。上一节
末尾提到"翻转 `ARTICLE_TEMPLATE_CRUD_LANDED` 仍需 P4 把 `PUBLISHABLE_LOCALES`/`proxy.ts` 那一整层
按 Owner 决策打开"——这就是那一轮，但结果不是"打开"而是**整层删除**：

- `PUBLISHABLE_LOCALES`/`isPublishableLocale`/`listPublishableLocales`/`pickPublishableLocale`/
  `ARTICLE_TEMPLATE_CRUD_LANDED`/`assertPublishableLocalesFailClosed` 全部从
  `locale-canonical.ts`/`request-locale.ts` 删除，不留别名壳。上一节"`ARTICLE_TEMPLATE_CRUD_LANDED`
  今天仍是 `false`"这句话因此也随之作废——这个符号已经不存在，不是"翻转成 `true`"。
- 公开面从"三层"（登记 `SITE_LOCALES` → 可发布白名单 `PUBLISHABLE_LOCALES` → 实际路由）收口为
  CPS 同构的"两层"：静态层 `SITE_LOCALES`（不变，仍是本文件唯一真源）+ 新增动态层
  `getActiveLocales()`（`active-locales.ts`，按既有公开可见谓词族——`isPublicationStatePublic` ∧
  `isPromoReady` ∧ Novel/PromoLink 未软删——算出，不是新造第二份可见性 where）。
  `[locale]/_guard.ts`/`proxy.ts`/sitemap 默认/IndexNow 资格/hreflang 枚举/blog 创建表单全部改读
  `SITE_LOCALES`（静态层）；`SiteChrome.activeLocales`（→ `SiteHeader` → `LocaleSwitcher`）是动态层
  唯一消费点，对齐 CPS 自己 `getActiveLocales()` 的唯一真实消费点（`site-header.tsx`）。
- 新增 `root-negotiation.ts`（根路径 Accept-Language/cookie 协商，COPY 自 CPS）与
  `active-locales-tag.ts`（`unstable_cache` 标签名单独拆出的零依赖模块——见该文件自己的头注释，
  `revalidate.ts` 若直接从 `active-locales.ts` 导入会把该模块整个的 `unstable_cache(...)`
  模块加载期副作用一并拖进来，破坏了好几个只 mock `next/cache` 里 `revalidatePath` 的既有测试）。
- 完整的四张取证清单、改动清单、六条变异见
  `docs/governance/port-registry.md` 的 L10N P4 小节。

## 硬前置

`locale-canonical.ts` 是 P1 的**硬前置 2**：必须在写入任何多语言数据之前建好，早于 P1-05 之后的任何内容写入链路。

## 特别纪律

- 映射失败返回 `{ locale: null, confidence: "unknown" }`，**不得猜测、不得用上游原值当 locale**；
- `locale: null` 的后果：来源条目可建，**canonical 内容实体不建**，进人工队列；
- 「解析出 locale」≠「是站点语种」——两道独立的闸，`it`/`fil`/`ms`/`tr` 解析成功但不是 `SITE_LOCALES` 成员（L10N P4：曾经的第三道闸"可发布"已随白名单层删除，"这个 `SITE_LOCALES` 成员现在有没有真实内容"改由动态层 `active-locales.ts` 的 `getActiveLocales()` 回答，不再是一道 fail-closed 准入闸）；
- 对外接口形状见 `src/contracts/`：`resolveSiteLocale`；上游码表/别名表/熔断评估的唯一真源是 `channel-language.ts`，不在别处重复；`getActiveLocales()` 的对外形状见 `active-locales.ts` 自己的头注释，不在本文件重复。
