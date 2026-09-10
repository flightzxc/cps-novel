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
| 19 | （JSON null） | 5 577 | — | — | CPS 表无 19 | **MAPPING_EVIDENCE_MISSING**（继续 `sourceLocale=NULL`） |
| 20 | （JSON null） | 10 393 | — | — | CPS 表无 20 | **MAPPING_EVIDENCE_MISSING**（继续 `sourceLocale=NULL`） |
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

## 后续（不在本阶段范围）

code 19/20 的真身认领走《施工提示词》§1.G 的探针
（`scripts/l10n/probe-unnamed-language-codes.ts`），P1 阶段只交付探针脚本本身（默认
dry-run，零上游调用），不执行 `--apply`，见预研文档"并行证据线 X"章节。
