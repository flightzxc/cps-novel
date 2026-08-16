# P2-06.5 Owner Final Closeout

## Outcome

Candidate 119 is superseded by CanonicalTag v1 Final with 123 public tags. Lane B B2 closes all 285 exact logical mapping groups as offline candidates. Lane C C1 v2 scores the verified 10,000-book final selection across all nine requested parameter configurations and materializes the exact per-book source hard evidence in a versioned machine-readable input. No production mapping, database, migration, Worker, Scheduler, C2, or network request was executed in this closeout.

The initial run `2026-08-16-owner-final-c1` is retained as a superseded draft. `2026-08-16-owner-final-c1-v2` is the authoritative C1 closeout run.

## B1 lineage and waiver

- Authoritative run: `2026-08-15-changdu-real-b1-v2`
- Raw manifest SHA-256: `4d7d6931687a2391ded9699ce90d54ceb3242ec232515d537eb7721274f61148`
- Raw status: `PARTIAL`
- Owner waiver: exactly six `request-attempts.jsonl:start_interval` observations at 999ms
- The global minimum request-start interval remains 1000ms
- `SOURCE_TAXONOMY_DISCOVERY_STATUS=TAXONOMY_DISCOVERY_NOT_SATURATED`

## CanonicalTag v1

- Count: 123
- Artifact SHA-256: `8bc8cdae8be2176bde170173e98bad2b9fa0e1770818174a57320816eefdccad`
- All required identity, definition, translation, alias, keyword, include/exclude and status fields are present
- Stable IDs and slugs are unique
- Alias collision audit: 0 cross-tag exact/NFKC+case-insensitive collisions
- All source-evidence file hashes read back against the manifest
- `fanfiction` is not created; it remains a B2 Canonical gap
- `xianxia` and `eastern-fantasy` are independent tags

## B2 Final

- 285/285 exact `channel_app_id + raw_language_scope + raw token` logical keys have a final offline disposition.
- 194 mapped groups produce 196 executable edges; the two additional CSV rows are non-executable `COMPOUND_GROUP_SUMMARY` records.
- Special-discipline checks pass for Adventure, scoped History/Histoire/Historia, Xuanhuan, ES/PT Young Adult, EN Young Adult, RU adult, EN Horror, 穿越重生 and fanfiction.
- No mapping conclusion is copied across raw-language scopes.

## C1 v2 input and lineage

- Authoritative input: `artifacts/p2-06-5-lane-c/2026-08-16-owner-final-c1-v2/c1-input.jsonl`
- Tracked summary: `docs/p2/p2-06-5-lane-c/runs/2026-08-16-owner-final-c1-v2/calibration-summary.json`
- C1 input SHA-256: `046fe9234b317eba145c3fbb35edd2e72af49e41309dcd5d5f45f7bc43d1776d`
- Scorer sample SHA-256: `f14fa303128aa8713cdbd1c3f60e3ed161f055ced47f65bde354462860d8d330`
- Unique novels/sample rows: 10,000/10,000
- Empty titles/descriptions: 0/1
- No source seriesType token: 1
- Manual FULL_SNAPSHOT rows: 0
- Novels with mapped source tags: 9,932; materialized mapped source edges across books: 17,932
- Language 19/20 samples: 1,155/1,165; all 2,320 remain raw-scope-only with `resolved_locale=null`
- Sparse text evidence rows: 56,115

Every `mapped_source_tags[]` row is read back against an exact B2 `MAPPING_EDGE` using the same channel, raw-language scope and raw token. Source hard evidence remains outside `maxTextTags`.

## C1 calibration evidence

| Scheme | Cap | Text hit | Title-only | Description-only | Both | Zero hit | Avg tags | p50/p90/p99 | Truncated books/tags | Mapped | Text supplement | Union |
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

The source-blind simulation is the same title+description-only result shown by the text columns. It exposes a 64.04% zero-hit rate for scheme C and 89.44% for A/B, but this alone does not prove that chapter text is the missing evidence: 1,207 books are already flagged for unsupported-script or scope-level keyword coverage insufficiency.

## Independent review and C2 boundary

- Blind audit cases: 9,511, deterministically sampled across configuration, cap, evidence class and Latin/CJK/script strata.
- High-tag-count and zero-hit strata are explicit.
- Source/text conflict population is zero because no approved mutual-exclusivity rules produced a real conflict; the zero population and shortfall are recorded instead of fabricating cases.
- False-positive audit and high false-positive keyword status remain `UNASSESSED_PENDING_INDEPENDENT_REVIEW`.
- No LLM adjudication is treated as the sole correctness label.
- C2 remains deferred; no chapter corpus was requested or read.

## Fixed status block

```text
CANONICAL_TAG_V1_STATUS=FINAL
CANONICAL_TAG_V1_COUNT=123
CANONICAL_TAG_V1_SHA256=8bc8cdae8be2176bde170173e98bad2b9fa0e1770818174a57320816eefdccad

LANE_B_B2_STATUS=COMPLETE_OFFLINE_CANDIDATES_GENERATED
B2_MAPPING_KEY_TOTAL=285
B2_ACCEPT_MAP=194
B2_DEFER=52
B2_IGNORE_DROP=37
B2_CANONICAL_GAP=2
B2_OWNER_REVIEW_REMAINING=0

LANE_C_C1_STATUS=CALIBRATION_REVIEW_PENDING
C1_SAMPLE_COUNT=10000
C1_RECOMMENDED_SCHEME=OWNER_REVIEW_REQUIRED
C1_RECOMMENDED_MAX_TEXT_TAGS=OWNER_REVIEW_REQUIRED
C1_RECOMMENDED_THRESHOLD=OWNER_REVIEW_REQUIRED
TEXT_PARAMETER_STATUS=CALIBRATION_RECOMMENDATION_ONLY
CHAPTER_EVIDENCE_STATUS=DEFER
C2_SAMPLE_REQUEST=NONE_PENDING_C1_ADJUDICATION

AUTO_WRITE_AUTHORIZED=NO
OWNER_NEXT_DECISIONS=C1_INDEPENDENT_ADJUDICATION;TEXT_PARAMETER_FREEZE;C2_NEED_DECISION_AFTER_RECALL_REVIEW
```

## Verification

- Lane B/C/Owner Final: **113/113 tests passed** across 12 files.
- TypeScript `tsc --noEmit`: **PASS**; targeted ESLint with zero-warning gate: **PASS**.
- Canonical, evidence snapshot, B2, C1 v2, portable report and delivery receipt byte-size/SHA-256 read-back: **PASS**.
- C1 v2 tracked verifier: **PASS**, with manifest SHA-256 `69591a49513019b8fba48e72e29bc2ea875944eafe3ed770df406cf5dcb17576`.
- Independent recomputation: **PASS** for 10,000 unique novels, missing fields, Language 19/20 distribution, all 285 B2 dispositions, nine configuration percentiles/truncation counts, mapped/text-supplement/union counts and source/text relations.
- Secret scan: **PASS**, zero findings across Canonical Final, B2 Final, tracked C1 v2, authoritative C1 v2 and Owner Final output roots.
- Production-side-effect static checks: **PASS**; the C1 and report entrypoints contain no database/Prisma/adapter/Worker/Scheduler imports and no `fetch()` calls.
- Portable report data equals tracked C1 v2 summary. Playwright desktop `1440×1000` and mobile `390×844` visual QA: **PASS**, responsive overflow **PASS**, console errors/warnings **0/0**.
