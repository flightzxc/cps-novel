# P2-06.5 Lane C · Offline text calibration

This tool is deliberately file-only. It does not import Prisma, adapters,
Worker or Scheduler code; it does not connect to a database or make network
requests. Every run reads versioned local JSON/JSONL and writes a new, empty
caller-supplied output directory.

```bash
node scripts/p2-06-5-text-calibration.mjs score \
  --samples /absolute/path/samples.jsonl \
  --taxonomy /absolute/path/taxonomy-keywords.json \
  --source-mapping /absolute/path/source-mapping.json \
  --output-dir /tmp/lane-c-c1
```

`review` takes the same inputs plus `--reviews`; `c2` requires
`--preview-corpus`. Outputs are immutable in practice: the command refuses a
non-empty output directory and each generated run manifest hashes every output
artifact.

## Input contracts

### `samples.jsonl`

One JSON object per novel snapshot. `seriesTypeList` must be from the same
input snapshot as the textual fields. `manualSnapshotComplete=true` excludes
the book from text-tag selection and source union; an empty
`manualCanonicalTagIds` array is a valid explicit full-snapshot clear.

```json
{
  "sampleRowId": "sample-0001",
  "novelIdentity": "stable-book-identity",
  "sourceLanguageCode": "en",
  "sourceLanguageName": "English",
  "sourceSnapshotId": "upstream-export-2026-08-13T00:00:00Z",
  "scriptBucket": "latin",
  "title": "The Alpha's Vow",
  "description": "A wolf-shifter romance.",
  "seriesTypeList": ["Romance"],
  "sourceSnapshotComplete": true,
  "manualSnapshotComplete": false,
  "manualCanonicalTagIds": [],
  "sourceObservedAt": "2026-08-13T00:00:00.000Z"
}
```

`sourceSnapshotId` binds title, description, `seriesTypeList`, completeness,
and the language/script values to one upstream extract. The tool rejects a
non-empty manual tag list unless it is explicitly a complete manual snapshot.

### `taxonomy-keywords.json`

`textSelectionPriority` is the deterministic cap tie-break. A reliable tag
must supply at least one keyword. A tag marked
`KEYWORD_COVERAGE_INSUFFICIENT` must have no active keywords, so the matcher
fails closed rather than inventing coverage.

```json
{
  "taxonomyVersion": "candidate-2026-08-13",
  "keywordLexiconVersion": "candidate-2026-08-13",
  "canonicalTags": [{
    "canonicalTagId": "werewolf",
    "slug": "werewolf",
    "definition": "A novel centered on wolf-shifter or werewolf fiction.",
    "textSelectionPriority": 10,
    "keywordCoverageStatus": "RELIABLE",
    "keywords": [{
      "keywordId": "werewolf-en",
      "value": "werewolf",
      "scriptBuckets": ["latin"],
      "matchMode": "unicode_word",
      "sourceLanguageCodes": ["en"],
      "riskFlags": []
    }]
  }]
}
```

The only accepted `matchMode` values are `unicode_word`, `cjk_contiguous`, and
`auto`. `auto` resolves to the former for `latin` and the latter for `cjk`.
`other` and `unknown` script buckets remain
`KEYWORD_COVERAGE_INSUFFICIENT` unless a future approved matcher is added.

### Optional `source-mapping.json`

Only approved `series_type` exact values are accepted. Mapping is excluded
from text scoring and the Terra queue; it is exposed only in post-blind source
diagnostics.

```json
{
  "mappingVersion": "lane-b-approved-2026-08-13",
  "approvalStatus": "APPROVED",
  "mappings": [{
    "sourceLabelKind": "series_type",
    "externalLabelValue": "Werewolf",
    "canonicalTagIds": ["werewolf"]
  }],
  "mutuallyExclusivePairs": [["werewolf", "historical-realism"]]
}
```

Owner Final C1 使用 scoped v2 identity；同一 token 在不同 raw scope 不得串映：

```json
{
  "mappingVersion": "p2-06-5-b2-owner-final-2026-08-16",
  "approvalStatus": "APPROVED_OFFLINE_CANDIDATE_ONLY",
  "mappings": [{
    "channelAppId": "changdu-app",
    "rawLanguageScope": "<exact RAW_LANGUAGE_SCOPE_V1 JSON>",
    "sourceLabelKind": "series_type",
    "externalLabelValue": "Werewolf",
    "canonicalTagIds": ["ct-v1-werewolf"]
  }],
  "mutuallyExclusivePairs": []
}
```

## Owner Final 10k command

```bash
node scripts/p2-06-5-text-calibration.mjs owner-final-c1 \
  --raw-run-dir artifacts/p2-06-5-lane-b/2026-08-15-changdu-real-b1-v2 \
  --owner-waiver docs/p2/p2-06-5-owner-final/2026-08-16/OWNER_TIMING_WAIVER.json \
  --b2-dir docs/p2/p2-06-5-lane-b/b2-owner-final/2026-08-16 \
  --canonical docs/p2/p2-06-5-lane-a/canonical-tag-v1-final/2026-08-16/canonical-tag-v1.0.0-final.json \
  --canonical-sha256-file docs/p2/p2-06-5-lane-a/canonical-tag-v1-final/2026-08-16/canonical-tag-v1.0.0-final.json.sha256 \
  --channel-app-id changdu-app \
  --authoritative-output-dir artifacts/p2-06-5-lane-c/2026-08-16-owner-final-c1-v2 \
  --tracked-output-dir docs/p2/p2-06-5-lane-c/runs/2026-08-16-owner-final-c1-v2 \
  --run-id 2026-08-16-owner-final-c1-v2

node scripts/p2-06-5-text-calibration.mjs verify-owner-final-c1 \
  --tracked-output-dir docs/p2/p2-06-5-lane-c/runs/2026-08-16-owner-final-c1-v2
```

## C1 v3（关键词资格覆盖层）

v3 与 v2 的唯一差别是加载了 `keyword-eligibility-v1` 覆盖层；CanonicalTag 产物本身未改。
覆盖层停用 `he`/`be`，把 `horror`/`family`/`doctor` 的单词种子限制为仅 title，
并对 `chef`/`luna` 施加 grade-B 的 `LOW_EVIDENCE_LOCALE_RULE`（**未经 Owner 冻结**）。

复现权威 v3（先把输出目录指向临时路径，**不要覆盖既有权威目录**）：

```bash
node scripts/p2-06-5-text-calibration.mjs owner-final-c1 \
  --raw-run-dir artifacts/p2-06-5-lane-b/2026-08-15-changdu-real-b1-v2 \
  --owner-waiver docs/p2/p2-06-5-owner-final/2026-08-16/OWNER_TIMING_WAIVER.json \
  --b2-dir docs/p2/p2-06-5-lane-b/b2-owner-final/2026-08-16 \
  --canonical docs/p2/p2-06-5-lane-a/canonical-tag-v1-final/2026-08-16/canonical-tag-v1.0.0-final.json \
  --canonical-sha256-file docs/p2/p2-06-5-lane-a/canonical-tag-v1-final/2026-08-16/canonical-tag-v1.0.0-final.json.sha256 \
  --channel-app-id changdu-app \
  --lexicon-override docs/p2/p2-06-5-lane-c/lexicon-overrides/2026-08-16/keyword-eligibility-v1.json \
  --authoritative-output-dir /tmp/c1-v3-repro/auth \
  --tracked-output-dir /tmp/c1-v3-repro/tracked \
  --run-id 2026-08-16-owner-final-c1-v3
```

`--run-id 2026-08-16-owner-final-c1-v3` 会让 CLI 自动套用冻结的 `generatedAt`
（`C1_V3_GENERATED_AT`），因此**无需手工传 `--generated-at`**。其他 run id 一律使用实时时间戳，
不会被误盖成 v3 的身份。

复现结果应与权威 v3 逐字节一致——把 `/tmp/c1-v3-repro/auth/scored/` 下每个产物的 sha256
与 `artifacts/p2-06-5-lane-c/2026-08-16-owner-final-c1-v3/scored/lane-c-run-manifest.json`
登记的值比对，**11/11 全中**才算通过。核对完请删除临时目录，不要留下第二份 v3。

权威逐书输入和稀疏 row evidence 位于 git-ignored `artifacts`。仓库只保存汇总、报告和 lineage hashes。Language 19/20 始终为 `RAW_SCOPE_ONLY`、`resolvedLocale=null`，并阻断 locale-specific 统计；其真实文本仍可按实际 Unicode script 进入 CJK matcher。

Owner Final v2 额外输出 `c1-input.jsonl`，作为可审计的 Lane C 输入合同。它使用 snake_case 字段，并把每本书依据 B2 exact scoped identity 得到的 source hard evidence 物化为：

```json
{
  "novel_identity": "stable-book-identity",
  "channel_app_id": "changdu-app",
  "raw_language_scope": "<exact RAW_LANGUAGE_SCOPE_V1 JSON>",
  "title": "...",
  "description": "...",
  "raw_series_types": ["Romance"],
  "mapped_source_tags": [{
    "canonical_stable_id": "ct-v1-romance",
    "canonical_slug": "romance",
    "mapping_key": "<B2 mapping key>",
    "exact_raw_token": "Romance"
  }]
}
```

`mapped_source_tags` 只允许来自同一 `channel_app_id + raw_language_scope + exact_raw_token` 的 B2 `MAPPING_EDGE`；它不会消耗 `maxTextTags` 配额。v2 使用新的 immutable run 目录 `2026-08-16-owner-final-c1-v2`，不覆盖初始 closeout draft。

Phase 1 authority baseline excludes the separate C1 v3 lexicon-remediation WIP,
including overrides, comparison tooling, post-fix review output, and ignored raw artifacts.

### `preview-corpus.jsonl` for C2

Only approved, offline chapters 1–3 are accepted. Each body is verified by
SHA-256 and Unicode code-point `charCount`; this prevents the C2 run from
quietly relying on a changed or incomplete chapter corpus.

```json
{
  "sampleRowId": "sample-0001",
  "requestCount": 1,
  "fetchDurationMs": 420,
  "responseBytes": 2048,
  "chapters": [{
    "chapterNumber": 1,
    "body": "...",
    "contentHash": "<sha256 of body>",
    "charCount": 3
  }]
}
```

## Review contract

Terra receives `blind-audit-queue.jsonl`: it has canonical definitions and
minimal matcher excerpts, but no `seriesTypeList`, source mapping or manual
labels. Terra writes `CORRECT`, `FALSE_POSITIVE`, `AMBIGUOUS`, or
`NOT_ADJUDICABLE`, with `HIGH` or `LOW` confidence. Low-confidence, false
positive, ambiguous and not-adjudicable outcomes route to Sol. Sol writes a
final verdict; unresolved taxonomy/source/business decisions route to Owner.

The report labels every FPR as `CALIBRATION_PROVISIONAL_SAMPLE_FP`. The C1
5% point-estimate / 10% 95%-upper-bound threshold is only a candidate filter;
all emitted choices remain `CALIBRATION_RECOMMENDATION_ONLY`.
