# P2-06.5 Lane C C1 v3 lexicon repair

## Technical summary

C1 v3 re-scored the same 10,000-book sample with a frozen parameter set (scheme C: titleWeight=30, descriptionWeight=30, chapterWeight=0, threshold=30, maxTextTags=3) after applying the keyword-eligibility-v1 overlay. CanonicalTag v1 Final was not modified. Coverage decline is the intended trade for precision.

Removing `he`/`be` zeroes description-only independent triggering for `ct-v1-happy-ending` and `ct-v1-tragic-ending` across every named scope and raw 19/20. The remaining seeds are `圆满结局` / `悲剧结局`, which had zero description hits in v2. **This is the expected outcome, not a defect.** No new ending-class translation seeds were added.

B-level chef/luna rules are marked `LOW_EVIDENCE_LOCALE_RULE` and key off already-named `sourceLanguageName` values. Language 19/20 stay `RAW_SCOPE_ONLY`.

## Input QA and lineage

- Unique novels/sample rows: 10000/10000
- Empty title: 0
- Empty description: 1
- C1 input SHA-256: `046fe9234b317eba145c3fbb35edd2e72af49e41309dcd5d5f45f7bc43d1776d`
- Scorer sample SHA-256: `f14fa303128aa8713cdbd1c3f60e3ed161f055ced47f65bde354462860d8d330`
- Lexicon overlay SHA-256: `781916c970dc81735080f425fb9441c4484daf92ee534c82e1e48c04d8d259e4`
- Sparse text evidence rows: 4476

## Scheme C / maxTextTags=3

| hit | title-only | description-only | both | zero | avg | p50/p90/p99 | mapped | supplement | union | source-blind hit | source-blind zero |
| ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: |
| 30.61% | 5.30% | 24.12% | 5.35% | 69.39% | 0.434 | 0/1/3 | 9932 | 11 | 9943 | 30.61% | 69.39% |

## v2 C/3 versus v3

- v2 description-only edges: 4554
- v3 description-only edges: 3218
- removed_description_edges: 1525
- affected_novel_count: 1147
- coverage_delta: -1336

Coverage decline is not a regression.

## Locale before/after (description-only edges)

| locale | v2 | v3 | removed |
| --- | ---: | ---: | ---: |
| 英语 | 1876 | 911 | 965 |
| 语种19 | 837 | 816 | 21 |
| 语种20 | 719 | 702 | 17 |
| 法语 | 338 | 271 | 67 |
| 西语 | 242 | 107 | 135 |
| 葡语 | 197 | 166 | 31 |
| 德语 | 32 | 31 | 1 |
| 韩语 | 12 | 0 | 12 |

## High-precision control tags

| tag | v2 | v3 |
| --- | ---: | ---: |
| ct-v1-time-travel | 479 | 480 |
| ct-v1-werewolf-alpha | 118 | 127 |
| ct-v1-rebirth | 259 | 260 |
| ct-v1-wealthy-ceo | 143 | 156 |
| ct-v1-romance | 125 | 130 |
| ct-v1-mafia | 68 | 81 |
| ct-v1-revenge | 76 | 96 |

## Precision on surviving population-layer reviewed edges

- v2 population reviewed edges / precision: 491 / 51.93%
- v3 surviving reviewed edges / measured precision: 328 / 73.78%
- predicted (A+B): 330 edges / 73.3%
- within ±2pp of 73.3%: YES

## Post-fix blind review

- sample count: 200
- status: READY_FOR_INDEPENDENT_REVIEW

## Source/text conflict

- Source/text conflict population: 0

## Fixed status block

```text
C1_V3_STATUS=CALIBRATION_REVIEW_PENDING
C1_V3_SAMPLE_COUNT=10000
TITLE_WEIGHT=30
DESCRIPTION_WEIGHT=30
THRESHOLD=30
MAX_TEXT_TAGS=3
C1_V2_TEXT_HIT_RATE=0.3596
C1_V3_TEXT_HIT_RATE=0.3061
C1_V2_DESCRIPTION_ONLY_RATE=0.3034
C1_V3_DESCRIPTION_ONLY_RATE=0.2412
GROSS_BLOCKED_EDGES=1525
CAP_RECOVERED_EDGES=189
NET_DESCRIPTION_ONLY_REDUCTION=1336
EDGE_RECONCILIATION=4554 - 1525 + 189 = 3218
PREDICTED_PRECISION_FROM_EXISTING_VERDICTS=0.733
MEASURED_PRECISION_ON_SURVIVING_REVIEWED_EDGES=0.7378048780487805
POST_FIX_BLIND_REVIEW_SAMPLE_COUNT=200
POST_FIX_BLIND_REVIEW_STATUS=READY_FOR_INDEPENDENT_REVIEW
TEXT_PARAMETER_STATUS=CALIBRATION_RECOMMENDATION_ONLY
CHAPTER_EVIDENCE_STATUS=DEFER
C2_SAMPLE_REQUEST=NONE
AUTO_WRITE_AUTHORIZED=NO
OWNER_NEXT_DECISION=POST_FIX_PRECISION_REVIEW_AND_FINAL_PARAMETER_FREEZE
LANGUAGE_19_RESOLUTION=RAW_SCOPE_ONLY_LOCALE_STATISTICS_BLOCKED
LANGUAGE_20_RESOLUTION=RAW_SCOPE_ONLY_LOCALE_STATISTICS_BLOCKED
```
