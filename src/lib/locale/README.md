# src/lib/locale/

**Owner: Claude（独占写入）**

## 用途

上游语种码 → 站点 locale 的映射，以及发布语种白名单的查询入口。

## 唯一真源

```
src/lib/locale/locale-canonical.ts
```

🔴 **全项目唯一的语种映射实现。** 禁止在任何其他位置出现第二处语种映射硬编码——CPS 因语种映射散落四处，付过两次全库 normalize 的代价。后续应有 lint 规则卡住新增映射表。

## 当前状态

`locale-canonical.ts` 已落地（P1-13），导出冻结契约的三个 API。

| 表 | 状态 | 说明 |
| --- | --- | --- |
| 上游语种登记表 | **部分填充（2 项，P0-S15）** | 依据《C2 真上游只读诊断报告 2026-08-26》真实 `getlistpc` 20 条样本登记了 `3 → en`、`7 → ru`（详见下方「P0-S15 更新」）。这只是样本覆盖到的子集，不是完整上游枚举——未登记的数值码依旧落 `unknown` |
| 发布白名单 | `{en}` | **U6 Owner 明示 D-7 放行 `en`。** 其余 14 语仍不进。S14 守卫允许 `{"en"}` 子集，模块加载不抛。 |

因此今天 `resolveSiteLocale(3)` / `resolveSiteLocale(7)`（及其字符串写法）能解出 `en` / `ru`，其余数值码依旧返回 `unknown`；`isPublishableLocale("en")` 为 `true`，其余 14 语仍为 `false`，`listPublishableLocales()` 为 `["en"]`。「映射成功」与「可发布」始终是两道独立的闸（`ru` 已映射、仍不可发布）。证据继续到手后，唯一要改的还是这一个文件。

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

## 硬前置

`locale-canonical.ts` 是 P1 的**硬前置 2**：必须在写入任何多语言数据之前建好，早于 P1-05 之后的任何内容写入链路。

## 特别纪律

- 映射失败返回 `unknown`，**不得猜测、不得用上游原值当 locale**；
- `unknown` 的后果：来源条目可建，**canonical 内容实体不建**，进人工队列；
- 「映射成功」≠「可发布」——发布白名单是独立的一道，fail-closed；
- 对外接口形状见 `src/contracts/`：`resolveSiteLocale` / `isPublishableLocale` / `listPublishableLocales`。
