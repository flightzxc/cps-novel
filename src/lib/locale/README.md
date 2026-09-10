# src/lib/locale/

**Owner: Claude（独占写入）**

## 用途

上游语种码 → 站点 locale 的映射，以及发布语种白名单的查询入口。

## 唯一真源

```
src/lib/locale/locale-canonical.ts   ← 对外三个 API（resolveSiteLocale / isPublishableLocale / listPublishableLocales）+ 站点 locale 登记表 + 发布白名单
src/lib/locale/channel-language.ts   ← L10N P1 新增：上游 moboreader 码表/别名表/resolveChannelLanguage/熔断评估，locale-canonical.ts 委托这里
```

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
- `scripts/l10n/backfill-source-item-locale.ts`：对已入库的 96 267 行按新码表
  重算 `sourceLocale`，默认 dry-run，`--apply` 需 `--approver`（存在且
  `status=active` 的 `AdminIdentity`）；幂等；本阶段（P1）不对生产/X8 执行
  `--apply`。
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

## 硬前置

`locale-canonical.ts` 是 P1 的**硬前置 2**：必须在写入任何多语言数据之前建好，早于 P1-05 之后的任何内容写入链路。

## 特别纪律

- 映射失败返回 `{ locale: null, confidence: "unknown" }`，**不得猜测、不得用上游原值当 locale**；
- `locale: null` 的后果：来源条目可建，**canonical 内容实体不建**，进人工队列；
- 「解析出 locale」≠「是站点语种」≠「可发布」——三道独立的闸，`it`/`fil`/`ms`/`tr` 解析成功但不是 `SITE_LOCALES` 成员；
- 对外接口形状见 `src/contracts/`：`resolveSiteLocale` / `isPublishableLocale` / `listPublishableLocales`；上游码表/别名表/熔断评估的唯一真源是 `channel-language.ts`，不在别处重复。
