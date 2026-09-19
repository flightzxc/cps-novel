/**
 * CanonicalTag public-locale translation overlay.
 *
 * Applies `docs/p2/canonical-tag-translations/2026-09-19/canonical-tag-translations-v1.json`
 * onto existing CanonicalTag rows. It only upserts `(canonicalTagId, locale)`
 * translation display names. It does not create tags, change slugs, rewrite
 * mappings, or touch keywords.
 *
 * Default: dry-run / validate (read-only plan). `--apply` requires
 * `--approver` and `--request-id` and writes one `OperationAudit` row.
 * Apply order is: transaction → advisory lock → replay check → re-read
 * translations and rebuild the insert/update/unchanged plan → validate →
 * write → audit. Dry-run keeps a read-only plan outside the lock.
 * `zh` rows are skipped unless `--overwrite-zh` is passed (the overlay
 * artifact itself contains none; `zh` stays the P2-06.5 v1 bootstrap
 * baseline).
 *
 * Cache: public listing/category/novel pages are `force-dynamic`. Taxonomy
 * loaders use request-scoped `React.cache()` only — not `unstable_cache`.
 * `getActiveLocales` is cached for 300s and does **not** include tag labels.
 * After QA/production `--apply`, the next request reads the new display
 * names; no application restart and no 300s wait. CDN/HTML cache, if any,
 * follows the existing force-dynamic contract.
 *
 * Data-first release: validate → QA apply → QA smoke → production apply →
 * then deploy application code (en fallback, admin locale list, category
 * description omit). Between production apply and app deploy, locales that
 * already have a translation show it; missing ones still fall back to zh.
 *
 * Usage:
 *   npx tsx scripts/p2-06-5-production/canonical-tag-translation-overlay.ts \
 *     --request-id <stable-request-id> \
 *     --reason "<change ticket/reason>"
 *
 *   npx tsx scripts/p2-06-5-production/canonical-tag-translation-overlay.ts \
 *     --request-id <same-stable-request-id> \
 *     --reason "<same change ticket/reason>" \
 *     --approver <adminIdentity UUID or username> \
 *     --apply
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Prisma, PrismaClient, type PrismaClient as PrismaClientType } from "@prisma/client";

import { SITE_LOCALES, type SiteLocale } from "../../src/lib/locale/locale-canonical";
import { CANONICAL_TAG_V1_COUNT, CANONICAL_TAG_V1_SHA256 } from "../../src/lib/tagging/keyword-artifact";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const TRANSLATION_OVERLAY_AUDIT_ACTION = "canonical_tag.translation_overlay";
export const TRANSLATION_OVERLAY_ADVISORY_LOCK_NAMESPACE = "p2-06-5:canonical-tag-translation-overlay";
export const TRANSLATION_OVERLAY_RELATIVE_PATH =
  "docs/p2/canonical-tag-translations/2026-09-19/canonical-tag-translations-v1.json";
export const TRANSLATION_OVERLAY_SHA256 =
  "0100fb36e638849ecdcd277792f6658250c51819aef97e1c59c3040316080488";
export const TRANSLATION_OVERLAY_EXPECTED_COUNT = CANONICAL_TAG_V1_COUNT * SITE_LOCALES.length;
export const TRANSLATION_OVERLAY_RECOVERY =
  "Apply is a single PostgreSQL transaction with pg_advisory_xact_lock; any exception rolls back every upsert and leaves no partial CanonicalTagTranslation writes. Replay the same --request-id to no-op. Undo a committed apply by restoring CanonicalTagTranslation from the pre-apply backup or by applying a previous overlay artifact. This CLI never updates CanonicalTag identity, slug, or zh baseline rows.";

const OVERLAY_SOURCES = ["reuse_cps_exact_slug", "reuse_cps_semantic_map", "reuse_repair", "new"] as const;
const OVERLAY_REVIEW_STATUSES = ["reviewed", "adapted", "new", "pending-review"] as const;

export type OverlaySource = (typeof OVERLAY_SOURCES)[number];
export type OverlayReviewStatus = (typeof OVERLAY_REVIEW_STATUSES)[number];

export type TranslationOverlayRow = Readonly<{
  stableId: string;
  slug: string;
  locale: SiteLocale;
  displayName: string;
  source: OverlaySource;
  sourceLocale: string;
  reviewStatus: OverlayReviewStatus;
  sourceSlug?: string;
}>;

export type TranslationOverlayArtifact = Readonly<{
  schema_version: 1;
  artifact_status: string;
  taxonomy_version: string;
  canonical_v1_sha256: string;
  canonical_v1_count: number;
  public_locales: readonly SiteLocale[];
  translation_count: number;
  overwrite_zh: boolean;
  cache_note: string;
  translations: readonly TranslationOverlayRow[];
}>;

export type TranslationOverlayErrorCode =
  | "argument_missing"
  | "argument_value_missing"
  | "approver_inactive"
  | "approver_not_found"
  | "artifact_invariant_violation"
  | "canonical_tag_missing"
  | "invalid_reason"
  | "invalid_request_id"
  | "sha256_mismatch"
  | "request_id_conflict";

export class TranslationOverlayError extends Error {
  constructor(readonly code: TranslationOverlayErrorCode, message: string) {
    super(message);
    this.name = "TranslationOverlayError";
  }
}

function fail(code: TranslationOverlayErrorCode, message: string): never {
  throw new TranslationOverlayError(code, message);
}

export type TranslationOverlayCliOptions = Readonly<{
  requestId: string;
  reason: string;
  approver: string | null;
  apply: boolean;
  overwriteZh: boolean;
}>;

function argValue(argv: readonly string[], index: number, flag: string): string {
  const next = argv[index + 1];
  if (next === undefined || next.startsWith("--")) {
    throw new TranslationOverlayError("argument_value_missing", `${flag} requires a value`);
  }
  return next;
}

function boundedText(value: string | undefined, field: string, maxLength: number, code: TranslationOverlayErrorCode): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized || normalized.length > maxLength) fail(code, `${field} must contain 1-${maxLength} characters`);
  return normalized;
}

export function parseTranslationOverlayCliOptions(argv: readonly string[]): TranslationOverlayCliOptions {
  let requestId: string | undefined;
  let reason: string | undefined;
  let approver: string | undefined;
  let apply = false;
  let overwriteZh = false;

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--request-id") { requestId = argValue(argv, index, flag); index += 1; }
    else if (flag === "--reason") { reason = argValue(argv, index, flag); index += 1; }
    else if (flag === "--approver") { approver = argValue(argv, index, flag); index += 1; }
    else if (flag === "--apply") apply = true;
    else if (flag === "--overwrite-zh") overwriteZh = true;
    else fail("argument_missing", `Unknown argument: ${flag}`);
  }

  if (requestId === undefined) fail("argument_missing", "--request-id is required");
  if (reason === undefined) fail("argument_missing", "--reason is required");
  if (apply && (approver === undefined || approver.trim().length === 0)) {
    fail("argument_missing", "--approver is required for --apply");
  }

  return Object.freeze({
    requestId: boundedText(requestId, "requestId", 160, "invalid_request_id"),
    reason: boundedText(reason, "reason", 2_000, "invalid_reason"),
    approver: approver === undefined ? null : boundedText(approver, "approver", 160, "argument_missing"),
    apply,
    overwriteZh,
  });
}

function isSiteLocale(value: string): value is SiteLocale {
  return (SITE_LOCALES as readonly string[]).includes(value);
}

function isOverlaySource(value: string): value is OverlaySource {
  return (OVERLAY_SOURCES as readonly string[]).includes(value);
}

function isOverlayReviewStatus(value: string): value is OverlayReviewStatus {
  return (OVERLAY_REVIEW_STATUSES as readonly string[]).includes(value);
}

export function parseTranslationOverlayArtifact(raw: unknown): TranslationOverlayArtifact {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    fail("artifact_invariant_violation", "overlay artifact must be an object");
  }
  const body = raw as Record<string, unknown>;
  if (body.schema_version !== 1) fail("artifact_invariant_violation", "overlay schema_version must be 1");
  if (body.canonical_v1_sha256 !== CANONICAL_TAG_V1_SHA256) {
    fail(
      "artifact_invariant_violation",
      `overlay canonical_v1_sha256 must stay ${CANONICAL_TAG_V1_SHA256}`,
    );
  }
  if (body.canonical_v1_count !== CANONICAL_TAG_V1_COUNT) {
    fail("artifact_invariant_violation", `overlay canonical_v1_count must be ${CANONICAL_TAG_V1_COUNT}`);
  }
  if (body.overwrite_zh !== false) {
    fail("artifact_invariant_violation", "overlay overwrite_zh must be false");
  }
  if (!Array.isArray(body.public_locales) || JSON.stringify(body.public_locales) !== JSON.stringify([...SITE_LOCALES])) {
    fail("artifact_invariant_violation", "overlay public_locales must equal SITE_LOCALES");
  }
  if (!Array.isArray(body.translations)) fail("artifact_invariant_violation", "overlay translations must be an array");
  if (body.translation_count !== body.translations.length) {
    fail("artifact_invariant_violation", "overlay translation_count must match translations.length");
  }
  if (typeof body.cache_note !== "string" || !body.cache_note.includes("force-dynamic")) {
    fail("artifact_invariant_violation", "overlay cache_note must document force-dynamic label visibility");
  }

  const seen = new Set<string>();
  const translations: TranslationOverlayRow[] = [];
  for (const item of body.translations) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      fail("artifact_invariant_violation", "each overlay translation must be an object");
    }
    const row = item as Record<string, unknown>;
    const stableId = typeof row.stableId === "string" ? row.stableId.trim() : "";
    const slug = typeof row.slug === "string" ? row.slug.trim() : "";
    const locale = typeof row.locale === "string" ? row.locale.trim() : "";
    const displayName = typeof row.displayName === "string" ? row.displayName.trim() : "";
    const source = typeof row.source === "string" ? row.source.trim() : "";
    const sourceLocale = typeof row.sourceLocale === "string" ? row.sourceLocale.trim() : "";
    const reviewStatus = typeof row.reviewStatus === "string" ? row.reviewStatus.trim() : "";
    const sourceSlug = typeof row.sourceSlug === "string" && row.sourceSlug.trim() ? row.sourceSlug.trim() : undefined;
    if (!stableId || !slug || !displayName || !sourceLocale) {
      fail("artifact_invariant_violation", `overlay translation for ${slug}/${locale} is missing required fields`);
    }
    if (locale === "zh") fail("artifact_invariant_violation", "overlay must not include zh rows");
    if (!isSiteLocale(locale)) fail("artifact_invariant_violation", `overlay locale ${locale} is not a SITE_LOCALES member`);
    if (!isOverlaySource(source)) fail("artifact_invariant_violation", `overlay source ${source} is not allowed`);
    if (!isOverlayReviewStatus(reviewStatus)) {
      fail("artifact_invariant_violation", `overlay reviewStatus ${reviewStatus} is not allowed`);
    }
    const key = `${stableId}::${locale}`;
    if (seen.has(key)) fail("artifact_invariant_violation", `duplicate overlay row ${key}`);
    seen.add(key);
    translations.push(Object.freeze({
      stableId,
      slug,
      locale,
      displayName,
      source,
      sourceLocale,
      reviewStatus,
      ...(sourceSlug ? { sourceSlug } : {}),
    }));
  }

  if (translations.length !== TRANSLATION_OVERLAY_EXPECTED_COUNT) {
    fail(
      "artifact_invariant_violation",
      `overlay must cover ${CANONICAL_TAG_V1_COUNT} × ${SITE_LOCALES.length} = ${TRANSLATION_OVERLAY_EXPECTED_COUNT} rows, got ${translations.length}`,
    );
  }

  const stableIds = new Set(translations.map((row) => row.stableId));
  if (stableIds.size !== CANONICAL_TAG_V1_COUNT) {
    fail("artifact_invariant_violation", `overlay must reference ${CANONICAL_TAG_V1_COUNT} distinct stableId values`);
  }

  return Object.freeze({
    schema_version: 1,
    artifact_status: String(body.artifact_status ?? ""),
    taxonomy_version: String(body.taxonomy_version ?? ""),
    canonical_v1_sha256: CANONICAL_TAG_V1_SHA256,
    canonical_v1_count: CANONICAL_TAG_V1_COUNT,
    public_locales: SITE_LOCALES,
    translation_count: translations.length,
    overwrite_zh: false,
    cache_note: String(body.cache_note),
    translations,
  });
}

function verifySha256(buffer: Buffer, expected: string, label: string): string {
  const actual = createHash("sha256").update(buffer).digest("hex");
  if (actual !== expected) fail("sha256_mismatch", `${label} SHA-256 mismatch: expected ${expected}, got ${actual}`);
  return actual;
}

export function loadTranslationOverlayArtifact(repoRoot: string = REPO_ROOT): {
  artifact: TranslationOverlayArtifact;
  sha256: string;
} {
  const buffer = readFileSync(path.join(repoRoot, TRANSLATION_OVERLAY_RELATIVE_PATH));
  const sha256 = verifySha256(buffer, TRANSLATION_OVERLAY_SHA256, "CanonicalTag translation overlay");
  const artifact = parseTranslationOverlayArtifact(JSON.parse(buffer.toString("utf8")));
  return { artifact, sha256 };
}

type Db = Pick<PrismaClientType, "canonicalTag" | "canonicalTagTranslation" | "adminIdentity" | "operationAudit" | "$transaction"> & {
  $queryRaw?: PrismaClientType["$queryRaw"];
};
type Tx = Omit<Db, "$transaction">;

export type OverlayWriteClass = "insert" | "update" | "unchanged";

export type OverlayOverwriteSample = Readonly<{
  slug: string;
  locale: SiteLocale;
  existingDisplayName: string;
  plannedDisplayName: string;
}>;

export type OverlayExceptionSample = Readonly<{
  stableId: string;
  slug: string;
  locale: SiteLocale;
  code: "canonical_tag_missing" | "slug_mismatch";
}>;

export interface TranslationOverlayReport {
  mode: "dry-run" | "apply";
  outcome: "eligible" | "applied" | "replayed" | "blocked";
  requestId: string;
  wrote: boolean;
  auditId: string | null;
  overlaySha256: string;
  canonicalV1Sha256: string;
  planned: number;
  skippedZh: number;
  insert: number;
  update: number;
  unchanged: number;
  exception: number;
  wouldOverwriteExisting: number;
  overwriteSamples: readonly OverlayOverwriteSample[];
  exceptionSamples: readonly OverlayExceptionSample[];
  databaseBefore: number;
  databaseAfter: number | null;
  identityGuard: Readonly<{
    canonicalTagMutations: 0;
    slugMutations: 0;
    zhUpdates: 0;
  }>;
  recovery: string;
}

type ApproverRow = { id: string; username: string; status: string };

async function resolveApprover(db: Pick<Db, "adminIdentity">, approver: string): Promise<ApproverRow> {
  const where: Prisma.AdminIdentityWhereInput = UUID_PATTERN.test(approver)
    ? { id: approver.toLowerCase() }
    : { username: approver };
  const identity = await db.adminIdentity.findFirst({ where, select: { id: true, username: true, status: true } });
  if (!identity) fail("approver_not_found", `approver ${approver} does not resolve to any admin_identity row`);
  if (identity.status !== "active") fail("approver_inactive", `approver ${approver} is not active`);
  return identity;
}

function rowsToApply(artifact: TranslationOverlayArtifact, overwriteZh: boolean): readonly TranslationOverlayRow[] {
  if (overwriteZh) return artifact.translations;
  return artifact.translations.filter((row) => (row.locale as string) !== "zh");
}

const IDENTITY_GUARD = Object.freeze({
  canonicalTagMutations: 0,
  slugMutations: 0,
  zhUpdates: 0,
} as const);

type OverlayPlan = Readonly<{
  insert: number;
  update: number;
  unchanged: number;
  exception: number;
  wouldOverwriteExisting: number;
  overwriteSamples: readonly OverlayOverwriteSample[];
  exceptionSamples: readonly OverlayExceptionSample[];
  writes: readonly { tagId: string; row: TranslationOverlayRow; writeClass: Exclude<OverlayWriteClass, "unchanged"> }[];
}>;

async function planTranslationOverlayWrites(
  db: Pick<Db, "canonicalTag" | "canonicalTagTranslation">,
  plannedRows: readonly TranslationOverlayRow[],
): Promise<OverlayPlan> {
  const tags = await db.canonicalTag.findMany({
    where: { stableId: { in: [...new Set(plannedRows.map((row) => row.stableId))] } },
    select: { id: true, stableId: true, slug: true },
  });
  const byStableId = new Map(tags.map((tag) => [tag.stableId, tag]));
  const existing = tags.length === 0
    ? []
    : await db.canonicalTagTranslation.findMany({
      where: { canonicalTagId: { in: tags.map((tag) => tag.id) } },
      select: { canonicalTagId: true, locale: true, displayName: true },
    });
  const existingByKey = new Map(
    existing.map((row) => [`${row.canonicalTagId}::${row.locale}`, row.displayName] as const),
  );

  const overwriteSamples: OverlayOverwriteSample[] = [];
  const exceptionSamples: OverlayExceptionSample[] = [];
  const writes: OverlayPlan["writes"][number][] = [];
  let insert = 0;
  let update = 0;
  let unchanged = 0;

  for (const row of plannedRows) {
    const tag = byStableId.get(row.stableId);
    if (!tag) {
      if (exceptionSamples.length < 20) {
        exceptionSamples.push({ stableId: row.stableId, slug: row.slug, locale: row.locale, code: "canonical_tag_missing" });
      }
      continue;
    }
    if (tag.slug !== row.slug) {
      if (exceptionSamples.length < 20) {
        exceptionSamples.push({ stableId: row.stableId, slug: row.slug, locale: row.locale, code: "slug_mismatch" });
      }
      continue;
    }
    const current = existingByKey.get(`${tag.id}::${row.locale}`);
    if (current === undefined) {
      insert += 1;
      writes.push({ tagId: tag.id, row, writeClass: "insert" });
      continue;
    }
    if (current === row.displayName) {
      unchanged += 1;
      continue;
    }
    update += 1;
    writes.push({ tagId: tag.id, row, writeClass: "update" });
    if (overwriteSamples.length < 20) {
      overwriteSamples.push({
        slug: row.slug,
        locale: row.locale,
        existingDisplayName: current,
        plannedDisplayName: row.displayName,
      });
    }
  }

  const exception = plannedRows.length - insert - update - unchanged;
  return Object.freeze({
    insert,
    update,
    unchanged,
    exception,
    wouldOverwriteExisting: update,
    overwriteSamples,
    exceptionSamples,
    writes,
  });
}

function overlayReport(
  base: Omit<TranslationOverlayReport, "identityGuard" | "recovery" | "insert" | "update" | "unchanged" | "exception" | "wouldOverwriteExisting" | "overwriteSamples" | "exceptionSamples">,
  plan: Pick<OverlayPlan, "insert" | "update" | "unchanged" | "exception" | "wouldOverwriteExisting" | "overwriteSamples" | "exceptionSamples">,
): TranslationOverlayReport {
  return Object.freeze({
    ...base,
    insert: plan.insert,
    update: plan.update,
    unchanged: plan.unchanged,
    exception: plan.exception,
    wouldOverwriteExisting: plan.wouldOverwriteExisting,
    overwriteSamples: plan.overwriteSamples,
    exceptionSamples: plan.exceptionSamples,
    identityGuard: IDENTITY_GUARD,
    recovery: TRANSLATION_OVERLAY_RECOVERY,
  });
}

export function describeOverlayDatabaseTarget(databaseUrl: string | undefined): Readonly<{
  configured: boolean;
  user?: string;
  database?: string;
  hostFingerprint?: string;
  port?: string;
}> {
  if (!databaseUrl?.trim()) return Object.freeze({ configured: false });
  try {
    const parsed = new URL(databaseUrl);
    return Object.freeze({
      configured: true,
      user: parsed.username || undefined,
      database: decodeURIComponent(parsed.pathname.replace(/^\//, "")).split("?")[0] || undefined,
      hostFingerprint: createHash("sha256").update(parsed.hostname).digest("hex").slice(0, 12),
      port: parsed.port || "5432",
    });
  } catch {
    return Object.freeze({ configured: false });
  }
}

export async function runTranslationOverlayCli(
  db: Db,
  options: TranslationOverlayCliOptions,
  loaded: { artifact: TranslationOverlayArtifact; sha256: string },
): Promise<TranslationOverlayReport> {
  const plannedRows = rowsToApply(loaded.artifact, options.overwriteZh);
  const skippedZh = loaded.artifact.translations.length - plannedRows.length;
  const countBase = {
    overlaySha256: loaded.sha256,
    canonicalV1Sha256: loaded.artifact.canonical_v1_sha256,
    planned: plannedRows.length,
    skippedZh,
  };

  if (!options.apply) {
    const databaseBefore = await db.canonicalTagTranslation.count();
    const plan = await planTranslationOverlayWrites(db, plannedRows);
    return overlayReport({
      mode: "dry-run",
      outcome: plan.exception > 0 ? "blocked" : "eligible",
      requestId: options.requestId,
      wrote: false,
      auditId: null,
      databaseBefore,
      databaseAfter: null,
      ...countBase,
    }, plan);
  }

  const approver = await resolveApprover(db, options.approver!);

  return db.$transaction(async (tx: Tx) => {
    await tx.$queryRaw!(Prisma.sql`
      SELECT pg_advisory_xact_lock(hashtextextended(${TRANSLATION_OVERLAY_ADVISORY_LOCK_NAMESPACE}, 0))::text AS lock_result
    `);

    const committed = await tx.operationAudit.findFirst({
      where: { actorType: "system", action: TRANSLATION_OVERLAY_AUDIT_ACTION, requestId: options.requestId },
      select: { id: true, actorId: true, reason: true, afterSnapshot: true },
    });
    const databaseBefore = await tx.canonicalTagTranslation.count();
    const plan = await planTranslationOverlayWrites(tx, plannedRows);

    if (committed) {
      const snapshot = committed.afterSnapshot as Record<string, unknown> | null;
      const bindingMatches = committed.actorId === approver.id
        && committed.reason === options.reason
        && snapshot?.overlaySha256 === loaded.sha256;
      if (!bindingMatches) fail("request_id_conflict", "the request id is already committed for different overlay input");
      return overlayReport({
        mode: "apply",
        outcome: "replayed",
        requestId: options.requestId,
        wrote: false,
        auditId: committed.id.toString(),
        databaseBefore,
        databaseAfter: databaseBefore,
        ...countBase,
      }, plan);
    }

    if (plan.exception > 0) {
      fail(
        plan.exceptionSamples[0]?.code === "slug_mismatch" ? "artifact_invariant_violation" : "canonical_tag_missing",
        `overlay apply blocked: ${plan.exception} row(s) missing CanonicalTag or slug mismatch; no writes were attempted`,
      );
    }

    for (const write of plan.writes) {
      await tx.canonicalTagTranslation.upsert({
        where: { canonicalTagId_locale: { canonicalTagId: write.tagId, locale: write.row.locale } },
        create: { canonicalTagId: write.tagId, locale: write.row.locale, displayName: write.row.displayName },
        update: { displayName: write.row.displayName },
      });
    }

    const databaseAfter = await tx.canonicalTagTranslation.count();
    const audit = await tx.operationAudit.create({
      data: {
        actorType: "system",
        actorId: approver.id,
        action: TRANSLATION_OVERLAY_AUDIT_ACTION,
        entityType: "CanonicalTagTranslation",
        entityId: "canonical-tag-translations-v1",
        requestId: options.requestId,
        reason: options.reason,
        beforeSnapshot: {
          translationCount: databaseBefore,
          insert: plan.insert,
          update: plan.update,
          unchanged: plan.unchanged,
        } as Prisma.InputJsonValue,
        afterSnapshot: {
          translationCount: databaseAfter,
          overlaySha256: loaded.sha256,
          canonicalV1Sha256: loaded.artifact.canonical_v1_sha256,
          planned: plannedRows.length,
          insert: plan.insert,
          update: plan.update,
          unchanged: plan.unchanged,
          skippedZh,
          overwriteZh: options.overwriteZh,
          requestId: options.requestId,
          reason: options.reason,
          approverUsername: approver.username,
        } as Prisma.InputJsonValue,
      },
      select: { id: true },
    });

    return overlayReport({
      mode: "apply",
      outcome: "applied",
      requestId: options.requestId,
      wrote: plan.writes.length > 0,
      auditId: audit.id.toString(),
      databaseBefore,
      databaseAfter,
      ...countBase,
    }, plan);
  });
}

async function main(): Promise<void> {
  const options = parseTranslationOverlayCliOptions(process.argv.slice(2));
  const loaded = loadTranslationOverlayArtifact();
  const target = describeOverlayDatabaseTarget(process.env.DATABASE_URL);
  console.log(JSON.stringify({ target }, null, 2));
  if (!target.configured) {
    console.error("No DATABASE_URL configured; refusing to guess a database. Dry-run/apply stopped.");
    process.exitCode = 2;
    return;
  }
  const prisma = new PrismaClient();
  try {
    const report = await runTranslationOverlayCli(prisma, options, loaded);
    if (report.mode === "dry-run") {
      console.log("[DRY RUN — no changes written; pass --apply --approver <adminIdentity> to overlay translations]");
    }
    console.log(JSON.stringify(report, (_key, value) => (typeof value === "bigint" ? value.toString() : value), 2));
  } finally {
    await prisma.$disconnect();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
