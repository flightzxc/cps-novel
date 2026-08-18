# v0.2.0 Foundation — Stream F Interface Freeze

**Status:** 🔴 FROZEN as of this PR — this is the contract Streams A/B/C/D/E build against. Changing
any signature below requires flagging it back to Stream F (Claude) for arbitration, not a silent
edit in a downstream PR.

**Scope:** this document covers everything Stream F (`P2_07_12_一轮实施分工方案_2026-08-12.md` §三)
shipped: the one migration, `db-retry`, the visibility predicate family, the `SiteSetting`
accessor, the public access-check entry point, `publication-dispatcher`, and the Article path
builder. It does not cover Stream A/B/C/D/E's own deliverables — those get their own freeze docs
when they land.

**Governance cross-reference:** `docs/governance/database-governance.md` (word dictionary + §12
changelog) and `docs/governance/port-registry.md` (CPS port registrations) are the schema/port
authorities; this document is the *code-interface* authority (function signatures and call
conventions) for the six shared modules below.

---

## 0. A note on directory ownership (read this first)

This repo's `CLAUDE.md` declares itself the sole authority on directory ownership and reserves
`prisma/`, `src/server/`, `src/lib/db/`, `tests/backend/`, `tests/integration/`, etc. exclusively
for "Codex", with a repeated 🔴 "no path may have two write owners" rule. That table is P1-era
(dated 2026-08-02, still says "next step: P1-05") and predates the P2-07~12 round's explicit
reassignment (`P2_07_12_一轮实施分工方案_2026-08-12.md` §三: "Claude 拿设计密度高…的流（地基、门禁、
IndexNow、失效矩阵）") of exactly this backend-territory work to Claude for this round. This PR
was implemented under the newer assignment, per two explicit rounds of coordinator instruction.
**This conflict has not been reconciled in `CLAUDE.md` itself** — Owner should either update the
ownership table for the P2 round or clarify that P1-era ownership still governs and this PR's
placement needs to move. Flagging here rather than resolving it unilaterally a second time.

---

## 1. Prisma schema diff (migration `20260818120000_v020_foundation_shared`)

44 tables (was 43). Verified against a disposable PostgreSQL 16 container: `migrate deploy`
(idempotent replay), `migrate diff --exit-code` (migrations→schema and live-db→schema both zero
difference), `scripts/check-database-dictionary-drift.mjs` (44 tables, 950 active dictionary
records, zero orphans/ghosts).

### `IndexNowOutbox` — 8 new fields + 1 new index

| Field | Type | Notes |
| --- | --- | --- |
| `lastRequestAt` | `DateTime?` | Most recent delivery attempt's request time |
| `lastResponseAt` | `DateTime?` | Most recent delivery attempt's response time |
| `deferReason` | `String? @db.VarChar(96)` | Review-defer workflow reason code; non-null only while deferred |
| `releasedAt` | `DateTime?` | When the review-defer was released |
| `releaseReason` | `String? @db.Text` | Free-text release reason |
| `releaseCommit` | `String @default("")` | Deploy-commit audit trail; `""` when never deferred |
| `payloadHost` | `String @default("")` | Audit-only recorded IndexNow endpoint host; `""` before first attempt |
| `deliveryTaskId` | `String? @db.Uuid` | `GenericTask.id` correlation — **bare column, no Prisma relation/FK** (see §4) |

New index: `@@index([deferReason, status])`.

### `IndexNowOutboxAttempt` — field rename + 1 new field

| Change | Detail |
| --- | --- |
| `attemptState` → `outcome` | Physical rename (`RENAME COLUMN` + `RENAME CONSTRAINT`). **Values unchanged**: `started \| accepted \| retryable_failed \| permanent_failed`. Zero verified consumers before rename. |
| new `attemptState` | CPS crash-recovery semantics, distinct field: `started \| completed \| unknown_outcome`. **Do not confuse with `outcome`** — they answer different questions (HTTP result classification vs. worker crash-recovery state). |
| `workerTaskId` | `String? @db.Uuid` — `GenericTask.id` correlation, same bare-column pattern as `deliveryTaskId` |

### New table: `SiteSetting`

Singleton (`id Int @id @default(1)`, `CHECK (id = 1)` enforced at the DB layer — CPS relied on
application discipline alone). Fields: `siteName`, `siteDescription`, `homeMetaTitle`,
`homeMetaDescription`, `defaultOgImage`, `googleSearchConsoleVerification`,
`footerCopyrightText`, `footerDisclaimerText`, `friendLinks` (`Json`/`jsonb`, not CPS's
JSON-serialized `String`), `indexNowHost`, `indexNowKey`, `indexNowKeyLocation`,
`ga4MeasurementId`, `updatedAt`. **Dropped from CPS**: `beidouApiBase`/`beidouAuthToken`/
`beidouConfigUpdatedAt`/`previewSyncEnabled`/`carouselConfigJson`/`feishuAppId`/`feishuAppSecret`/
`feishuUserToken`/`feishuConfigUpdatedAt` — no such vendor integrations exist in this project, and
carousel parameters already live per-batch in `HomeCarouselAutoBatch.params`.

---

## 2. `src/lib/db/db-retry.ts`

```ts
function isUniqueConstraintViolation(error: unknown): boolean;   // P2002, or P2010 wrapping SQLSTATE 23505
function isSerializationFailure(error: unknown): boolean;        // P2034, or P2010 wrapping SQLSTATE 40001
function isForeignKeyViolation(error: unknown): boolean;         // P2003
function isTransientDbError(error: unknown): boolean;            // composition: P1008/serialization = retry; unique/FK = never
function summarizeDbError(error: unknown): string;
function withDbRetry<T>(
  operation: () => Promise<T>,
  context: DbRetryContext,           // { op, itemId?, idempotencyKey?, page?, sourceKey?, sourceItemId?, sourceLanguageCode?, sourceLocale?, itemIndex? }
  options?: DbRetryOptions,          // { delaysMs?, jitterMs?, sleep?, logger? }
): Promise<T>;
```

**Calling convention — mandatory:** any code anywhere in this repo that needs to classify a Prisma
error as a unique/serialization/FK violation **must** import from this module. Do not write a
second `error.code === "P2002"` check anywhere else, including `$queryRaw`/`$executeRaw` call
sites that need the `P2010` + `meta.code` raw-SQL equivalent — `isUniqueConstraintViolation`/
`isSerializationFailure` already handle both forms. `src/server/credentials/service.ts` was
refactored in this PR to import these instead of its own local copies; treat that as the reference
example.

---

## 3. `src/server/publication/visibility.ts`

```ts
function isPromoReady(promoLink: PromoLinkReadinessState): boolean;
function isPublicationStatePublic(novel: NovelPublicationState, article: ArticlePublicationState): boolean;
function isRightsBlocked(novel, article): boolean;
function isNoIndexRemovalState(novel, article): boolean;
function isPubliclyAccessible(novel, article, promoLink): boolean;
function isIndexNowEligible(novel, article, promoLink): boolean;  // same body as isPubliclyAccessible today; kept distinct for Stream E to extend

const PRIMARY_NOVEL_RECORD: Prisma.NovelWhereInput;      // { deletedAt: null }
const PUBLIC_NOVEL_RECORD: Prisma.NovelWhereInput;       // + { status: "published" }
function buildPrimaryNovelWhere(extra?): Prisma.NovelWhereInput;
function buildPublicNovelWhere(extra?): Prisma.NovelWhereInput;

const PRIMARY_ARTICLE_RECORD: Prisma.ArticleWhereInput;  // { deletedAt: null }
const PUBLIC_ARTICLE_RECORD: Prisma.ArticleWhereInput;   // + { status: "published", novel: {is: PUBLIC_NOVEL_RECORD}, promoLink: {is: {status: "fetched"}} }
function buildPrimaryArticleWhere(extra?): Prisma.ArticleWhereInput;
function buildPublicArticleWhere(extra?): Prisma.ArticleWhereInput;
```

**`isPromoReady` is the single authoritative "is this promo link usable" check in the codebase.**
CPS reimplemented this question four times and one of them (`sitemap.ts`'s DB filter,
`promoUrl: { not: "" }`) silently drifted from the other three by skipping `.trim()`
(`P2-07-12-移植审计-2026-08-12/DECISION-CHECK.md` 核查3). Do not write a second
`webUrl?.trim()`/`appUrl?.trim()` check anywhere — call `isPromoReady`.

**Calling convention — mandatory:**
- Stream A's evaluator, Stream D's sitemap data layer, and Stream E's IndexNow eligibility must all
  call `isPromoReady`/`isPubliclyAccessible`/`isIndexNowEligible` rather than inlining status
  checks.
- `buildPublicNovelWhere`/`buildPublicArticleWhere` are **non-authoritative pre-filters only** —
  the `promoLink.status === "fetched"` condition is deliberately not trim-checked in SQL. Any
  consumer of a row list produced by these builders **must** still call `isPromoReady` per row
  before rendering/indexing/submitting it. Treating the DB filter alone as sufficient is exactly
  the CPS defect (`sitemap.ts`'s un-trimmed filter) this round is instructed not to reproduce.

---

## 4. `src/server/publication/access.ts`

```ts
type NovelArticleAccessResult =
  | { kind: "published"; articleId: string; novelId: string }
  | { kind: "unavailable" }   // stable noindex removal page — HTTP 200, not a 404
  | { kind: "takedown" }      // HTTP 410 Gone
  | { kind: "not_found" };    // plain HTTP 404

function checkNovelArticlePublicAccess(
  db: PrismaClient | Prisma.TransactionClient,
  input: { locale: string; slug: string },
): Promise<NovelArticleAccessResult>;
```

**Calling convention:** the eventual public `[locale]/novel/[slug]` route (Stream B) — whether
implemented as a page Server Component or a future proxy/middleware layer — must call this
function rather than re-deriving status branching from raw `status` columns. Map the four `kind`
values to: `published` → normal render; `unavailable` → the existing `/unavailable` screen
(`src/app/dev-preview/unavailable`); `takedown` → the existing `/takedown` screen
(`src/app/dev-preview/takedown`) + HTTP 410; `not_found` → `next/navigation`'s `notFound()`.

Slug-alias resolution (CPS's `findSlugAlias` redirect step) is **not** implemented here — no
slug-alias table exists yet. Once `src/lib/slug/` builds one, its caller resolves an alias to a
canonical slug and then calls this function, same layering CPS uses.

---

## 5. `src/server/publication/dispatcher.ts`

```ts
type DispatchFirstPublicPublicationInput = {
  articleId: string; novelId: string; locale: string; source: string;
  sourceTaskId?: string; eventType?: string;
};
type PublicationDispatchHandlers = {
  enqueueIndexNow?: (input: DispatchFirstPublicPublicationInput, db) => Promise<unknown>;
  enqueueSitemapRefresh?: (input: { reason: string; triggeredBy: string }, db) => Promise<unknown>;
};
type PublicationDispatchResult = { indexnow?: unknown; sitemap?: unknown; errors: string[] };

function dispatchFirstPublicPublication(
  input: DispatchFirstPublicPublicationInput,
  db: PrismaClient | Prisma.TransactionClient,
  handlers?: PublicationDispatchHandlers,
): Promise<PublicationDispatchResult>;
```

**This PR does not implement IndexNow enqueue or Sitemap refresh enqueue** — that is Stream E and
Stream D's scope respectively. `handlers` is intentionally a parameter, not a static import,
because neither module exists yet.

**Calling convention:**
- Stream A wires `dispatchFirstPublicPublication(input, db)` into the publish write path **today**,
  with no `handlers` argument. This is a safe no-op (empty `errors`, no side effects) — the call
  site does not need to change once Streams D/E land.
- Stream D and Stream E each supply their own `enqueueSitemapRefresh`/`enqueueIndexNow`
  implementation (each internally deciding whether to no-op via its own feature flag, mirroring
  CPS's `isIndexNowOutboxEnabled()`/`isSitemapAutoRefreshEnabled()` per-handler gating) and wire it
  in wherever `dispatchFirstPublicPublication` is called — **do not** bypass the dispatcher and
  call an enqueue function directly from a publish write path; the isolation behavior (one side
  effect's failure never blocks the other or the caller's transaction) only holds if both handlers
  go through this function.

---

## 6. `src/server/site-settings/service.ts`

```ts
function getSiteSetting(db, options?: { ttlMs?: number; now?: () => number }): Promise<SiteSettingSnapshot>;
function invalidateSiteSettingCache(): void;
function getIndexNowDeliveryConfig(db, options?): Promise<{ host: string; key: string; keyLocation: string }>;
function isIndexNowConfigured(config: IndexNowDeliveryConfig): boolean;  // trim-authoritative on all 3 fields
function getGa4MeasurementId(db, options?): Promise<string | null>;
class SiteSettingNotSeededError extends Error {}   // thrown, fail-closed, if the singleton row is ever missing
```

Default cache TTL: 30s (`DEFAULT_SITE_SETTING_TTL_MS`). Pass `ttlMs: 0` to force a fresh read.
Call `invalidateSiteSettingCache()` immediately after any admin write to `site_setting`.

**Calling convention — mandatory:** CPS queried `site_setting` from 25 independent call sites
across 14 files with zero caching and zero shared type. **Nobody in this codebase may write a bare
`db.siteSetting.findUnique(...)`/`findFirst(...)` outside this file.** Every read — IndexNow config
for Stream E, SEO metadata defaults for Stream B, footer content — goes through `getSiteSetting` or
one of the narrow typed getters above.

---

## 7. `src/lib/slug/article-path.ts`

```ts
function buildArticleUrlSuffix(shortId: string): string;                    // `p${shortId}`
function buildArticleRoutePath(input: { slug: string; shortId: string }): string;  // `/novel/{slug}-p{shortId}`
function buildArticlePath(input: { locale: SiteLocale; slug: string; shortId: string }): string; // + locale prefix (empty for "en")
function parseArticleSlugParam(param: string): { slugPart: string; shortId: string } | null;
```

`shortId` is **required, not optional** — unlike CPS's `flagOn`-gated optional field,
`Article.publicPageShortId` is `NOT NULL UNIQUE` from day one. No feature-flag branch exists to
port. Route segment is `/novel/`, not CPS's `/drama/`.

**Calling convention — mandatory (`src/lib/slug/README.md`):** sitemap entries, IndexNow submitted
URLs, CTA links, admin preview links, and structured data must all call these functions. Do not
concatenate `/novel/${slug}-p${shortId}` inline anywhere.

---

## 8. Test coverage shipped with this PR

All under `tests/backend/` (vitest `node` project; `tests/ui/` is the only path actually collected
for jsdom/UI tests — see `reference_cps_novel_repo_conventions`). 132 new tests, all passing at PR
time:

| Module | Test file | Count |
| --- | --- | --- |
| `db-retry.ts` | `tests/backend/db/db-retry.test.ts` | 23 |
| `visibility.ts` | `tests/backend/publication/visibility.test.ts` | 31 |
| `access.ts` | `tests/backend/publication/access.test.ts` | 13 |
| `dispatcher.ts` | `tests/backend/publication/dispatcher.test.ts` | 8 |
| `site-settings/service.ts` | `tests/backend/site-settings/service.test.ts` | 14 |
| `article-path.ts` | `tests/backend/slug/article-path.test.ts` | 11 |

Migration itself is verified by a disposable-PostgreSQL-16 integration flow (see §1), not a vitest
file — matching how `20260803090000_p1_initial_schema` was verified.

---

## 9. Out of scope for this PR (explicitly, per the round's task book)

- IndexNow delivery/enqueue business logic (Stream E).
- Sitemap generation/refresh business logic (Stream D).
- The publish-gate evaluator itself (Stream A) — this PR ships the predicates it will compose, not
  the evaluator.
- Any write path that changes `Novel.status`/`Article.status` to `published` (Stream A).
- `src/contracts/publish-gate.ts` — read-only reference in this PR, not modified.
- P1's existing 45 models' full dictionary backfill — deferred to a separate lightweight task per
  the 2026-08-12 Owner decision (`database-governance.md` §12 changelog entry for this PR).
