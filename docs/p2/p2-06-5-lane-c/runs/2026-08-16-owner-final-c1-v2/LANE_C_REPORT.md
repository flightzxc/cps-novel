# P2-06.5 Lane C C1 10k Calibration v2

## Technical summary

C1 scored the verified 10,000-book final sample across A/B/C × maxTextTags 2/3/5. The output is calibration evidence only; no threshold, scheme, or text cap is frozen.

Source tags use the exact composite key `channel_app_id + raw_language_scope + exact token`, are materialized per book in `c1-input.jsonl`, remain outside the text cap, and are unioned with selected text tags. Language 19 and 20 remain raw scopes with locale-specific statistics blocked.

## Input QA and lineage

- Unique novels/sample rows: 10000/10000
- Empty title: 0
- Empty description: 1
- No seriesType token: 1
- Manual FULL_SNAPSHOT rows: 0
- Novels with mapped source tags: 9932
- C1 input SHA-256: `046fe9234b317eba145c3fbb35edd2e72af49e41309dcd5d5f45f7bc43d1776d`
- Scorer sample SHA-256: `f14fa303128aa8713cdbd1c3f60e3ed161f055ced47f65bde354462860d8d330`
- Sparse text evidence rows: 56115

## Nine calibration configurations

| scheme | cap | hit | title-only | description-only | both | zero | avg | p50/p90/p99 | truncated books/tags | mapped | supplement | union |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: |
| A | 2 | 10.56% | 5.24% | 0.00% | 5.72% | 89.44% | 0.115 | 0/1/1 | 9/10 | 9932 | 2 | 9934 |
| A | 3 | 10.56% | 5.26% | 0.00% | 5.72% | 89.44% | 0.116 | 0/1/1 | 1/1 | 9932 | 2 | 9934 |
| A | 5 | 10.56% | 5.27% | 0.00% | 5.72% | 89.44% | 0.116 | 0/1/1 | 0/0 | 9932 | 2 | 9934 |
| B | 2 | 10.56% | 5.24% | 0.00% | 5.72% | 89.44% | 0.115 | 0/1/1 | 9/10 | 9932 | 2 | 9934 |
| B | 3 | 10.56% | 5.26% | 0.00% | 5.72% | 89.44% | 0.116 | 0/1/1 | 1/1 | 9932 | 2 | 9934 |
| B | 5 | 10.56% | 5.27% | 0.00% | 5.72% | 89.44% | 0.116 | 0/1/1 | 0/0 | 9932 | 2 | 9934 |
| C | 2 | 35.96% | 4.65% | 30.07% | 5.72% | 64.04% | 0.505 | 0/2/2 | 623/1186 | 9932 | 33 | 9965 |
| C | 3 | 35.96% | 4.93% | 30.34% | 5.72% | 64.04% | 0.567 | 0/2/3 | 301/563 | 9932 | 33 | 9965 |
| C | 5 | 35.96% | 5.23% | 30.37% | 5.72% | 64.04% | 0.614 | 0/2/5 | 68/100 | 9932 | 33 | 9965 |

## Source-blind and scope evidence

The text-only source-blind simulation is identical to the text metrics above and is separately materialized in the authoritative scored bundle. Per raw scope, the tracked summary records hit/zero rates, average tags, percentiles, cap truncation and keyword-coverage insufficiency. Raw scopes 19/20 are not relabeled as locales.

## Precision and review status

- False-positive audit: `UNASSESSED_PENDING_INDEPENDENT_REVIEW`
- High false-positive keyword: `UNASSESSED_PENDING_INDEPENDENT_REVIEW`
- Source/text conflict population: 0; zero populations are recorded as shortfalls and are not fabricated.
- Other-script and scope-level keyword gaps remain `KEYWORD_COVERAGE_INSUFFICIENT`.

## Limitations

No independent C1 adjudications were supplied. Matcher risk flags are queueing signals, not measured false positives. Chapter evidence is deferred, and no C2 corpus was requested or read.

## Fixed status block

```text
LANE_C_C1_STATUS=CALIBRATION_REVIEW_PENDING
C1_SAMPLE_COUNT=10000
C1_RECOMMENDED_SCHEME=OWNER_REVIEW_REQUIRED
C1_RECOMMENDED_MAX_TEXT_TAGS=OWNER_REVIEW_REQUIRED
C1_RECOMMENDED_THRESHOLD=OWNER_REVIEW_REQUIRED
TEXT_PARAMETER_STATUS=CALIBRATION_RECOMMENDATION_ONLY
CHAPTER_EVIDENCE_STATUS=DEFER
C2_SAMPLE_REQUEST=NONE_PENDING_C1_ADJUDICATION
LANGUAGE_19_RESOLUTION=RAW_SCOPE_ONLY_LOCALE_STATISTICS_BLOCKED
LANGUAGE_20_RESOLUTION=RAW_SCOPE_ONLY_LOCALE_STATISTICS_BLOCKED
OWNER_NEXT_DECISIONS=C1_INDEPENDENT_ADJUDICATION;TEXT_PARAMETER_FREEZE;C2_NEED_DECISION_AFTER_RECALL_REVIEW
AUTO_WRITE_AUTHORIZED=NO
```
