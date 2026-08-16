# P2-06.5 Gate A · Empirical Closeout

Decision date: 2026-08-16

## Outcome

CanonicalTag v1 is **FINAL at 116 entries**. The previous 119-entry candidate set closes at 116: `student` merges into `campus` as an alias, while `both-virgin` and `power-play` are dropped from v1. Office Tension and Office Romance remain separate; Future World and Science Fiction remain separate. No frozen decision was reopened.

B1 remains authoritatively `PARTIAL`. Owner accepted this one run with a timing waiver because all 240 pages succeeded, there were no retries or 429s, semantic round-trip passed, and the final sample contains 10,000 books. The six 999ms request-start intervals remain visible in the source run; this report does not change the global >=1000ms contract.

Timing violations (previous attempt → next attempt): 11→12 (999ms), 46→47 (999ms), 79→80 (999ms), 179→180 (999ms), 204→205 (999ms), 222→223 (999ms).

## Closed merge reviews

### Office Tension / Office Romance — KEEP_SEPARATE

Office evidence contains genuine workplace romance and non-romantic workplace competition/adventure. Merging pure office tension into romance would create a materially wrong result set. The sample has 40 books mentioning “office”, but only 1 explicit “office romance” phrase match.

- `31927497` · THE NANNY OF THE CEO · raw tokens `["男频","Adventure"]`
- `470747970` · A Secretive Deal with My Billionaire Boss · raw tokens `["女频","Billionaires"]`
- `5593250` · Desired By The Jerky Billionaire  · raw tokens `["男频","Adventure"]`
- `113848680` · The Twin Who Stole Tomorrow · raw tokens `["女频","Horror"]`
- `5598417` · Titan's Advent · raw tokens `["男频","Pantasya"]`

### Future World / Science Fiction — KEEP_SEPARATE

Three future-world mentions lead into ancient rebirth or campus stories, while a Sci-fi-labelled contemporary relationship experiment is not a future-world setting. Neither direction of the result-set test is safe. The accepted sample contains 3 future-world phrase matches and 85 books carrying the listed exact English Sci-fi variants.

- `1075322689` · 傾城醫妃：傲嬌王爺請讓道 · raw tokens `["女频","穿越重生"]`
- `1075328862` · 學霸馬甲捂不住了 · raw tokens `["女频","青春校園"]`
- `5604553` · 医妃翻身：皇叔，放肆宠 · raw tokens `["女频","穿越重生"]`
- `186675186` · Data of a Broken Heart · raw tokens `["女频","Sci-fi"]`

### Student / Campus — MERGE + ALIAS

Stable positive examples are school/campus stories, while Young Adult and Adolescent buckets contain adult and mislabelled works. A separate Student retrieval entry would not reliably improve results; Campus carries the user-facing intent and Student remains an alias. Evidence buckets contain 37 `青春校园`, 66 `青春校園`, 196 Young Adult variants, and 5 Adolescent books.

- `5610480` · 拽少别嚣张：本小姐惹上你了！ · raw tokens `["女频","青春校园"]`
- `5610484` · 青涩信笺 · raw tokens `["女频","青春校园"]`
- `248122964` · 身份曝光后，打脸冒充豪门的男友 · raw tokens `["女频","青春校园"]`
- `186674204` · The Ex-Wife's Fiery Reckoning · raw tokens `["女频","Young Adult"]`
- `1075326139` · 為她破戒！我養的小狼狗竟然是京圈大佬 · raw tokens `["女频","Adolescent"]`

## Closed low-value reviews

- **Both Virgin — DROP_LOW_VALUE.** No exact source token or explicit mutual-first-experience phrase appears in the accepted 10k sample. Generic virgin mentions do not prove both protagonists share a first experience, so the entry is too fragile and sensitive for Canonical v1. Explicit mutual-first-experience matches: 0; generic virgin mentions: 7.
- **Power Play — DROP_LOW_VALUE.** No exact Power Play source token appears. Both literal phrase matches describe explicit dominance/BDSM dynamics rather than a stable political, business, or court-intrigue retrieval concept; merging them elsewhere would be materially wrong.

- `77465256` · Through Realms Of Sins (Short Steamy Compilations) · raw tokens `["女频","Short stories"]`
- `576636506` · EDEN: Steamy Forbidden Pleasures  · raw tokens `["女频","Short stories"]`

## Raw language identities 19 and 20

Neither raw numeric value has an upstream `languageName` or a repository registry entry. The observed character forms are strongly suggestive but do not prove a locale or region. They therefore remain exact raw scopes, and locale-specific C1 statistics are blocked.

| raw language | final books | exact tokens | evidence | resolution | C1 locale stats |
| ---: | ---: | ---: | --- | --- | --- |
| 19 | 1155 | 31 | Simplified-script tokens such as 现代言情 / 青春校园 / 总裁豪门 | RAW_SCOPE_ONLY | BLOCKED |
| 20 | 1165 | 33 | Traditional-script tokens such as 現代言情 / 青春校園 / 總裁豪門 | RAW_SCOPE_ONLY | BLOCKED |

The closeout does not guess `zh-CN`, `zh-TW`, `zh-Hans`, or `zh-Hant`. A future locale mapping needs exact upstream documentation or an Owner-approved registry.

## Versioned artifact

- Canonical version: `1.0.0`
- CanonicalTag count: `116` (including the previously counted 7 facet values)
- Artifact: `canonical-tag-v1.0.0.json`
- SHA-256: `480bab2dcd0141e05012aa7e07a76ec4a0159ca372e222de3aa2c6a25508a7bd`
- Scope: cross-language canonical concepts; raw source-language scope remains a separate B2 mapping-key component.

B2 was not executed. No database, schema, migration, classifier configuration, SourceLabelMapping, Worker, Scheduler, or business code was modified.

## Evidence lineage and limitations

- B1 raw manifest: run `2026-08-15-changdu-real-b1-v2`, status `PARTIAL`, SHA-256 `4d7d6931687a2391ded9699ce90d54ceb3242ec232515d537eb7721274f61148`.
- B1 derived manifest: status `PARTIAL`, raw round-trip `true`, SHA-256 `8233d8e4f427af94f92ba5787b16f6638395d2203b218361fa550929d0314cc1`.
- Prior A tag coverage SHA-256: `4f4249d78655e52f5b18f9ed2f401a159beededd3f1550b860b4220284b86c09`.
- Owner correction delta SHA-256: `260c46d73a6b4b11f91a31c1f7a99cde24fbc9c41cc28eba2e840662d8c7c9d0`.
- This is evidence-based taxonomy closeout, not a prevalence estimate. Missing exact source tokens are negative evidence for v1 mapping readiness, not proof that a concept never occurs.

## Fixed status block

```text
CANONICAL_TAG_V1_COUNT=116
A_REMAINING_MERGE_REVIEWS=0
A_REMAINING_LOW_VALUE_REVIEWS=0
LANGUAGE_19_RESOLUTION=RAW_SCOPE_ONLY_LIKELY_SIMPLIFIED_CHINESE_C1_LOCALE_STATS_BLOCKED
LANGUAGE_20_RESOLUTION=RAW_SCOPE_ONLY_LIKELY_TRADITIONAL_CHINESE_C1_LOCALE_STATS_BLOCKED
CANONICAL_TAG_V1_STATUS=FINAL
```
