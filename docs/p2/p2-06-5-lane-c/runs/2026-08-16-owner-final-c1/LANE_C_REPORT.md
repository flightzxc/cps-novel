# P2-06.5 Lane C C1 10k Calibration

## Technical summary

C1 scored the verified 10,000-book final sample across A/B/C × maxTextTags 2/3/5. The output is calibration evidence only; no threshold, scheme, or text cap is frozen.

Source tags use the exact composite key `channel_app_id + raw_language_scope + exact token`, remain outside the text cap, and are unioned with selected text tags. Language 19 and 20 remain raw scopes with locale-specific statistics blocked.

## Input QA

- Unique novels: 10000
- Empty title: 0
- Empty description: 1
- No seriesType token: 1
- Sparse text evidence rows: 56115

## Nine calibration configurations

| scheme | max text tags | text hit | zero hit | avg text tags | cap-truncated books |
| --- | ---: | ---: | ---: | ---: | ---: |
| A | 2 | 10.56% | 89.44% | 0.115 | 9 |
| A | 3 | 10.56% | 89.44% | 0.116 | 1 |
| A | 5 | 10.56% | 89.44% | 0.116 | 0 |
| B | 2 | 10.56% | 89.44% | 0.115 | 9 |
| B | 3 | 10.56% | 89.44% | 0.116 | 1 |
| B | 5 | 10.56% | 89.44% | 0.116 | 0 |
| C | 2 | 35.96% | 64.04% | 0.505 | 623 |
| C | 3 | 35.96% | 64.04% | 0.567 | 301 |
| C | 5 | 35.96% | 64.04% | 0.614 | 68 |

## Limitations

No independent C1 adjudications were supplied. Matcher risk flags are queueing signals, not measured false positives. Other-script keyword coverage is explicitly insufficient. Chapter evidence is deferred.

## Fixed status block

```text
LANE_C_C1_STATUS=CALIBRATION_REVIEW_PENDING
C1_SAMPLE_COUNT=10000
C1_RECOMMENDED_SCHEME=OWNER_REVIEW_REQUIRED
C1_RECOMMENDED_MAX_TEXT_TAGS=OWNER_REVIEW_REQUIRED
C1_RECOMMENDED_THRESHOLD=OWNER_REVIEW_REQUIRED
TEXT_PARAMETER_STATUS=CALIBRATION_RECOMMENDATION_ONLY
CHAPTER_EVIDENCE_STATUS=DEFER
LANGUAGE_19_RESOLUTION=RAW_SCOPE_ONLY_LOCALE_STATISTICS_BLOCKED
LANGUAGE_20_RESOLUTION=RAW_SCOPE_ONLY_LOCALE_STATISTICS_BLOCKED
AUTO_WRITE_AUTHORIZED=NO
```
