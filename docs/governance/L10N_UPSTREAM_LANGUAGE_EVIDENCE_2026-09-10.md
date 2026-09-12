# L10N 上游语言码证据（2026-09-10）

依据：`施工提示词_Sonnet_L10N_P1_语言归一与存量重算_2026-09-10.md` §1.B；
规划背景：`CPS海阅_15语内容供应链_FullCPSParity_只读预研_2026-09-10.md` §5。

## 证据口径

`novel_source_item.raw_payload` 是上游 `getlistpc` 原样镜像。`(source_language_code,
source_language_name)` 在同一行成对出现即海阅自己的真实上游证据——与登记表已有
`3→英语→en`、`7→俄语→ru` 采用同一成对标准，不引入新口径。

X8 本地库只读实测（`docker exec -i cps-novel-x8-local-postgres-1 psql -U postgres -d
cps_novel -tAc "SELECT source_language_code, source_language_name, count(*) FROM
novel_source_item WHERE deleted_at IS NULL GROUP BY 1,2 ORDER BY 1::int NULLS
LAST;"`，执行于本轮施工开始时，无 `--apply`/写操作，库总行数 `96267`，`deleted_at IS NOT
NULL` 为 `0`）：

| code | 上游 languageName | 海阅成对样本数（实测） | 归一目标 locale | 是否站点语种（`SITE_LOCALES`） | CPS 交叉核对 | 状态 |
|---:|---|---:|---|---|---|---|
| 2 | 繁体 | 19 | zh-Hant | 是 | `CHANGDU_DRAMA_LANGUAGE_CODE_TO_LOCALE["2"]="zh-Hant"` | MAPPED_BY_EVIDENCE |
| 3 | 英语 | 42 702 | en | 是 | `["3"]="en"` | MAPPED_BY_EVIDENCE（此前已登记） |
| 4 | 西语 | 7 879 | es | 是 | `["4"]="es"` | MAPPED_BY_EVIDENCE |
| 5 | 葡语 | 6 982 | pt-BR | 是 | `["5"]="pt-BR"` | MAPPED_BY_EVIDENCE |
| 6 | 法语 | 7 277 | fr | 是 | `["6"]="fr"` | MAPPED_BY_EVIDENCE |
| 7 | 俄语 | 2 940 | ru | 是 | `["7"]="ru"` | MAPPED_BY_EVIDENCE（此前已登记） |
| 8 | 意大利语 | 123 | it | **否**（非站点语种，识别但不进站） | `["8"]="it"` | MAPPED_BY_EVIDENCE |
| 9 | 日语 | 1 099 | ja | 是 | `["9"]="ja"` | MAPPED_BY_EVIDENCE |
| 10 | 阿拉伯语 | 115 | ar | 是 | `["10"]="ar"` | MAPPED_BY_EVIDENCE |
| 11 | 印尼 | 4 606 | id | 是 | `["11"]="id"` | MAPPED_BY_EVIDENCE |
| 12 | 泰语 | 2 755 | th | 是 | `["12"]="th"` | MAPPED_BY_EVIDENCE |
| 13 | 越南语 | 785 | vi | 是 | `["13"]="vi"` | MAPPED_BY_EVIDENCE |
| 14 | 韩语 | 753 | ko | 是 | `["14"]="ko"` | MAPPED_BY_EVIDENCE |
| 15 | 菲律宾语 | 745 | fil | **否**（非站点语种） | `["15"]="fil"` | MAPPED_BY_EVIDENCE |
| 16 | 德语 | 788 | de | 是 | `["16"]="de"` | MAPPED_BY_EVIDENCE |
| 21 | 马来西亚语 | 59 | ms | **否**（非站点语种） | `["21"]="ms"` | MAPPED_BY_EVIDENCE |
| 22 | 土耳其语 | 618 | tr | **否**（非站点语种） | `["22"]="tr"` | MAPPED_BY_EVIDENCE |
| 23 | 波兰语 | 52 | pl | 是 | `CHANGDU_SHORTMAX_LANGUAGE_CODE_TO_LOCALE["23"]="pl"`（moboreels/shortmax 扩展表，非 common changdu 表） | MAPPED_BY_EVIDENCE |
| 19 | （JSON null） | 5 577 | — | — | CPS 表无 19 | **VENDOR_TABLE_ABSENT**（官方表无此码，永久 `sourceLocale=NULL`，不再是"待补证据"；见下方§畅读官方语种编号表） |
| 20 | （JSON null） | 10 393 | — | — | CPS 表无 20 | **VENDOR_TABLE_ABSENT**（官方表无此码，永久 `sourceLocale=NULL`，不再是"待补证据"；见下方§畅读官方语种编号表） |
| — | — | — | cs | 是（站点登记语种） | 畅读表无 cs（只有北斗 `24→cs`） | **NO_SOURCE_SAMPLE**（moboreader 无此码，不登记） |

合计：18 码有成对证据（96 267 − 5 577 − 10 393 = 80 297 行，占 83.4%）；两个无名码
（19/20）合计 15 970 行（16.6%）继续 `unknown`（本轮落 `NULL`，不落字面串）；`cs` 在
moboreader 码表中没有任何样本，不是"漏登记"，是"上游本来就没给过这个码"。

## CPS 交叉核对结论

CPS `3a76877:src/lib/channel-language.ts` 从未注册 `moboreader` 这个 `sourceAppCode`——
它是海阅独有的渠道。上表"CPS 交叉核对"列只是同厂商跨产品线（畅读 `changdu_moboreels`/
`changdu_shortmax` 等 changdu 系）的参考核对，不是取值来源：**18 个重叠码在 CPS 表中的
locale 取值全部一致，18/18，无一冲突**（`8→it`、`15→fil`、`21→ms`、`22→tr` 在 CPS 里同样
标注为非站点语种但仍登记码值，两侧口径一致）。`23→pl` 在 CPS 的 common changdu 表里不存在，
只在 `CHANGDU_MOBOREELS_LANGUAGE_CODE_TO_LOCALE`/`CHANGDU_SHORTMAX_LANGUAGE_CODE_TO_LOCALE`
两张扩展表里出现，值同为 `pl`，不冲突。

## 测试钉死

`tests/backend/locale/channel-language.test.ts` 的码表快照断言直接对照本文档这张表
（18 条），不对照 CPS 源文件——CPS 表是交叉核对参考，不是本仓的取值来源，避免"改了 CPS
就得跟着改海阅测试"的错误耦合。

## § 畅读官方语种编号表（Owner 2026-09-11 提供）

Owner 于 2026-09-11 转述畅读官方语种编号表（逐字）：

```
繁体中文 2 / 英语 3 / 西语 4 / 葡语 5 / 法语 6 / 俄语 7 / 意大利语 8 / 日语 9 /
阿拉伯语 10 / 印尼语 11 / 泰语 12 / 越南语 13 / 韩语 14 / 菲律宾语 15 / 德语 16 /
马来西亚语 21 / 土耳其语 22 / 波兰语 23
```

18 行，一一展开如下，并与上方"证据口径"表的海阅登记表（同样 18 码，来源于本仓
X8 库真实成对 `(source_language_code, source_language_name)` 样本）逐条对照：

| code | 官方语种名 | 官方表 → 本仓归一 locale（人工对照，非官方表自带） | 海阅登记表（`MOBOREADER_LANGUAGE_CODE_TO_LOCALE`） | 对照结果 |
|---:|---|---|---|---|
| 2 | 繁体中文 | zh-Hant | zh-Hant | 一致 |
| 3 | 英语 | en | en | 一致 |
| 4 | 西语 | es | es | 一致 |
| 5 | 葡语 | pt-BR | pt-BR | 一致 |
| 6 | 法语 | fr | fr | 一致 |
| 7 | 俄语 | ru | ru | 一致 |
| 8 | 意大利语 | it | it | 一致 |
| 9 | 日语 | ja | ja | 一致 |
| 10 | 阿拉伯语 | ar | ar | 一致 |
| 11 | 印尼语 | id | id | 一致 |
| 12 | 泰语 | th | th | 一致 |
| 13 | 越南语 | vi | vi | 一致 |
| 14 | 韩语 | ko | ko | 一致 |
| 15 | 菲律宾语 | fil | fil | 一致 |
| 16 | 德语 | de | de | 一致 |
| 21 | 马来西亚语 | ms | ms | 一致 |
| 22 | 土耳其语 | tr | tr | 一致 |
| 23 | 波兰语 | pl | pl | 一致 |

18/18 全部一致，码值、语种名、归一 locale 三者在官方表与海阅登记表之间无一冲突。

**官方表不含 19、20。** 畅读官方给出的编号是 2–16、21–23 这 18 个码，没有 17、18、
19、20 这四个号段；本仓上游 `getlistpc` 样本里出现的 19/20（`languageName` 均为
JSON `null`，分别 5 577/10 393 行）在官方表里找不到对应条目——不是官方表遗漏、也
不是本仓漏抄，是这两个码本来就不在畅读的官方语种枚举里。因此 19/20 的结论从"证据
不足、待补"（`MAPPING_EVIDENCE_MISSING`）升级为确定性结论：**`VENDOR_TABLE_ABSENT`
——官方表无此码，永久不登记，`sourceLocale` 永久落 `SQL NULL`**，任何依赖该字段做
`locale` 判定的路径（如创建链 `deriveLocale` 的 `missing_locale` 阻断）按"该来源条
目没有可用语种"处理，不得靠猜测/启发式补一个 locale 上去。

**证据等级说明**：本节的畅读官方语种编号表是**一级来源**（vendor-provided，Owner
直接转述畅读官方给出的码表，非本仓推导）。上方"证据口径"一节的 X8 数据库成对样本
统计、以及与 CPS `changdu` 系码表的交叉核对，原先是本仓 18 码登记表唯一的取值依据，
现降级为**佐证**（corroborating evidence）——两者与官方表逐条比对后完全吻合，18 码
的登记值本身不需要改动；官方表的价值在于把"18 码取值有真实上游样本支持、且与同厂
商其它产品线交叉核对一致"这条较弱的证据链，升级为"畅读官方直接确认这就是完整枚举"
这条更强的证据链，同时把 19/20 从"未决"钉死为"确定不存在"。

## 后续（不在本阶段范围）

code 19/20 的真身认领曾计划走《施工提示词》§1.G 的探针
（`scripts/l10n/probe-unnamed-language-codes.ts`）——上方官方表已把 19/20 的结论钉死
为 `VENDOR_TABLE_ABSENT`（官方表没有这两个码，不是"还没探明"），探针脚本本身继续
保留在仓库里作为诊断工具（例如核实上游 `getchapterinfo` 是否在其它字段里暴露语种
信息，属于独立的数据探索价值），但不再是 19/20 登记状态的认领依据，不需要再执行
`--apply` 去"补齐"这两个码。P1 阶段交付的探针脚本（默认 dry-run，零上游调用）保持
不变，见预研文档"并行证据线 X"章节。
