# P2-06.5 Lane B · Current Gate Report

## Latest real B1 run

Run `2026-08-15-changdu-real-b1-v2` completed the frozen read-only acquisition plan: 240 unique pages, 240 HTTP attempts, zero retries, 23,998 unique candidate novels and an exact 10,000-book final sample. The refreshed catalog reported 96,598 rows across 966 pages. No database write, CatalogScanTask, Worker/Scheduler action, migration, production mapping, or B2 execution occurred.

The sampled facts passed raw semantic replay, deterministic final-selection replay, quota checks and secret scans. The final sample covers 17 exact raw-language scopes and all 285 mapping keys observed in the 23,998-book candidate pool (`EMPIRICAL_TOKEN_COVERAGE=1.000000`). This is empirical coverage only; the channel exposes no authoritative taxonomy denominator.

The run is deliberately reported as `PARTIAL`, not `COMPLETE`. Six adjacent request starts were persisted 999ms apart because the host timer woke one millisecond early; the frozen contract requires at least 1000ms. The strict raw verifier therefore reports only `request-attempts.jsonl:start_interval`. No additional requests were made. The client now rechecks the measured clock after timer wake-up so a future run cannot repeat this boundary error, but that fix is not applied retroactively to the v2 status.

- Successful pages: `240 / 240`
- HTTP attempts: `240 / 250`; retries: `0 / 10`
- Candidate/final books: `23,998 / 10,000`
- Exact raw-language scopes: `17`
- Exact source-token mapping keys: `285`
- Raw structure anomalies: `0`
- Raw semantic round-trip QA: `PASS`
- Request-budget QA: `FAIL (start_interval only)`
- Raw manifest SHA-256: `4d7d6931687a2391ded9699ce90d54ceb3242ec232515d537eb7721274f61148`
- Derived manifest SHA-256: `8233d8e4f427af94f92ba5787b16f6638395d2203b218361fa550929d0314cc1`

The candidate-acquisition curve reached 248 keys at 10,000 books and 285 at 23,998 books. Its last three blocks still added 1, 1 and 2 keys, respectively. The final-selection curve contains all 285 keys from its first checkpoint because deterministic selection prioritizes token coverage. Even though the numerical tail meets the configured novelty threshold, saturation cannot pass while request-budget QA is false.

The versioned, secret-free B1 package is under [`runs/2026-08-15-changdu-real-b1-v2/`](runs/2026-08-15-changdu-real-b1-v2/):

- [B1 report](runs/2026-08-15-changdu-real-b1-v2/LANE_B_REPORT.md)
- [Sample manifest](runs/2026-08-15-changdu-real-b1-v2/lane-b-run-manifest.json)
- [Raw token inventory](runs/2026-08-15-changdu-real-b1-v2/source-taxonomy-inventory.csv)
- [Discovery curve](runs/2026-08-15-changdu-real-b1-v2/taxonomy-discovery-curve.csv)
- [Raw-language distribution](runs/2026-08-15-changdu-real-b1-v2/locale-sample-distribution.csv)
- [Token evidence](runs/2026-08-15-changdu-real-b1-v2/source-token-evidence.jsonl)
- [Token co-occurrence](runs/2026-08-15-changdu-real-b1-v2/source-token-cooccurrence.csv)

Raw authoritative pages and book-level facts remain in the git-ignored run directory and are retained pending explicit Owner cleanup approval. The earlier 401 attempt remains preserved under [`runs/2026-08-15-changdu-real-b1-v1/`](runs/2026-08-15-changdu-real-b1-v1/) as historical evidence.

B2 remains intentionally unexecuted until CanonicalTag Final is supplied.

```text
RAW_RUN_STATUS=PARTIAL
LANE_B_SAMPLE_STATUS=PARTIAL
LANE_B_MAPPING_STATUS=WAITING_FOR_CANONICAL_TAG_V1
SOURCE_TAXONOMY_DISCOVERY_STATUS=TAXONOMY_DISCOVERY_NOT_SATURATED
OWNER_REVIEW_ITEMS=0
```
