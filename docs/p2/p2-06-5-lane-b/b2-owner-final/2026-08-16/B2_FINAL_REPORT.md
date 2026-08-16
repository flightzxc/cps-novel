# P2-06.5 Lane B B2 Owner Final

## Technical summary

The 285 exact B1 mapping groups are closed as offline candidates: **194 mapped**, **52 deferred**, **37 ignored/dropped**, and **2 Canonical gaps**. No production mapping was created.

B1 remains `PARTIAL`. The single-run timing waiver accepts only the six recorded 999ms intervals; the global >=1000ms contract is unchanged.

## Exact mapping outcome

| disposition | logical groups |
| --- | ---: |
| APPROVED_MAP_CANDIDATE | 194 |
| DEFER_SOURCE_DIRTY | 52 |
| IGNORE_NON_CONTENT / DROP_LOW_VALUE | 37 |
| CANONICAL_GAP | 2 |

The 194 mapped groups produce 196 executable edges. The CSV has 198 rows because each of the two exact 科幻末世 1:N groups also has one non-edge group-summary row; all 196 nonblank targets are foreign keys to CanonicalTag v1. 穿越重生 has no hard 1:N.

## Coverage

- Token-group coverage: 68.07%
- Occurrence-weighted mapping coverage: 89.51%
- Books with at least one mapped source token: 9932/10000 (99.32%)
- Books whose complete observed token set is mapped: 7968/10000 (79.68%)

## Fixed status block

```text
LANE_B_B2_STATUS=COMPLETE_OFFLINE_CANDIDATES_GENERATED
B2_MAPPING_KEY_TOTAL=285
B2_ACCEPT_MAP=194
B2_MAPPING_CANDIDATE_ROW_COUNT=198
B2_EXECUTABLE_MAPPING_EDGE_COUNT=196
B2_DEFER=52
B2_IGNORE_DROP=37
B2_CANONICAL_GAP=2
B2_OWNER_REVIEW_REMAINING=0
AUTO_WRITE_AUTHORIZED=NO
```
