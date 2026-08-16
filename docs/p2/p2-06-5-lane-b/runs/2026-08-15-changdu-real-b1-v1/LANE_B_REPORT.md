# P2-06.5 Lane B · B1 Source Taxonomy Sampling Report

## Conclusion

Run `2026-08-15-changdu-real-b1-v1` contains **0** exact unique sampled books and **0** distinct `source scope + locale key + exact raw token` keys.
Taxonomy coverage is **NOT_ESTIMABLE_NO_DENOMINATOR**: the source exposes no authoritative complete token denominator, so this report does not invent a coverage percentage.

## Fact baseline

- Generated at: `2026-08-15T10:53:57.863Z`
- Target unique books: 10000
- Actual unique books: 0
- Exact source-token keys: 0
- Empirical token coverage (final sample / candidate pool): NOT_ESTIMABLE_EMPTY_CANDIDATE_POOL
- Unextractable/ambiguous raw list members: 0
- Discovery assessment: `TAXONOMY_DISCOVERY_NOT_SATURATED`

## Taxonomy discovery curve

```mermaid
xychart-beta
    title "Cumulative exact source-token discovery"
    x-axis "Unique sampled books" []
    y-axis "Distinct mapping keys" 0 --> 1
    line []
```

## Language / locale distribution

The chart uses the exact raw-language scope: JSON type + JSON value + raw languageName. Site locale remains null; this report does not guess a locale.

```mermaid
xychart-beta
    title "Sample distribution by exact locale key"
    x-axis []
    y-axis "Unique sampled books" 0 --> 1
    bar []
```

_No sampled raw-language scopes._

## Metric definitions and caveats

- Token identity is exact UTF-8 text under source scope and locale key. No trim, case fold, Unicode normalization, translation, spelling correction, fuzzy merge, or synonym merge is applied.
- `book_frequency` is distinct sampled books carrying the token; `occurrence_count` retains duplicate occurrences inside a book.
- Co-occurrence first set-deduplicates tokens within each book. `jaccard = n_ab / (n_a + n_b - n_ab)`; both directional conditional probabilities are also reported.
- The inventory CSV carries the exact token, UTF-8 base64, and SHA-256 so spreadsheet transport can be checked against authoritative raw JSONL.
- B1 does not establish any online mapping and does not classify novels.

## Fixed status block

```text
LANE_B_SAMPLE_STATUS=BLOCKED
LANE_B_MAPPING_STATUS=WAITING_FOR_CANONICAL_TAG_V1
SOURCE_TAXONOMY_DISCOVERY_STATUS=TAXONOMY_DISCOVERY_NOT_SATURATED
OWNER_REVIEW_ITEMS=0
TAXONOMY_COVERAGE_RATE=NOT_ESTIMABLE_NO_DENOMINATOR
EMPIRICAL_TOKEN_COVERAGE=NOT_ESTIMABLE_EMPTY_CANDIDATE_POOL
```
