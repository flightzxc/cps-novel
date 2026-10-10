/**
 * Applies a signed IndexNow backfill manifest, gated behind CPS's two-gate
 * safety mechanism, in chunks of 500 with a global stop check before every
 * chunk (B-41).
 *
 * Ported from CPS `scripts/indexnow-backfill-apply.ts`
 * (`assertBackfillWriteGates`/`assertBackfillStopConditions`,
 * `P2-07-12-移植审计-2026-08-12/P2-11.md` §7). The `main()` flow is
 * COPY_THEN_ADAPT: manifest read + SHA-256 verify + `release_commit` match
 * are unchanged; the candidate verification and enqueue calls are retargeted
 * at this codebase's eligibility/outbox modules; the CPS "look at this page's
 * backfill rows" stop conditions became GLOBAL ones (see below).
 * `docs/governance/port-registry.md` has the per-symbol registration.
 *
 * ## Two independent gates, both must be satisfied to write
 *
 *   Gate 1 (manifest integrity) — SHA-256 match, `count === expected_count`,
 *     `release_commit` equals the running `GIT_COMMIT`.
 *   Gate 2 — `--confirm` AND `INDEXNOW_BACKFILL_ALLOW_WRITE=true`, AND this
 *     process's own environment has the outbox pair (`outbox_disabled`) and
 *     the delivery pair (`delivery_disabled_cannot_wait`) switched on — a
 *     write run waits for each chunk to be delivered, so it can only work
 *     with delivery enabled.
 *
 * ## De-duplication is per article
 *
 * An entry whose article already has ANY `indexnow_outbox` row (any status,
 * source or revision) is counted as `alreadyHasDeliveryUrls` and skipped. The
 * database unique key is still `(url, revision)` — unchanged, so a future
 * substantive update could be pushed again — but this tool adds no update-push
 * path. That also makes the run repeatable: re-running the same manifest skips
 * everything already enqueued (including a `--canary-locales` trial run).
 *
 * ## Global stop conditions (checked before EVERY chunk, including the first)
 *
 *   (a) the delivery breaker is open — i.e. any HTTP 400/403/422 anywhere on
 *       the site since the last manual resume (Owner amendment 2: no more
 *       "more than 3 × 422"); a resume re-opens the run, history does not
 *       stall it forever;
 *   (b) a global HTTP 429 wait is active;
 *   (c) terminal-failure ratio over ALL `source = 'backfill'` rows above 5 %
 *       (SQL aggregate, never rows in memory);
 *   (d) any `indexnow_delivery` task that delivered backfill rows is `failed`;
 *   (e) write mode, from the second chunk on: the previous chunk is not fully
 *       accepted (accepted = HTTP 200 or 202; `cancelled` rows are tolerated);
 *   (f) ANY row site-wide is `dead_letter` — dead letters go to the Owner;
 *   (g) ANY row site-wide was cancelled for `url_invalid` / `url_host_mismatch`.
 *
 * Usage:
 *   tsx scripts/indexnow-backfill-apply.ts --help
 *   tsx scripts/indexnow-backfill-apply.ts --manifest <path> [--offset N] [--limit N] [--canary-locales a,b] [--confirm]
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { PrismaClient } from "@prisma/client";

import {
  INDEXNOW_BACKFILL_SUPPORTED_SCHEMA_VERSIONS,
  verifyManifestSha256,
  type IndexNowBackfillEntry,
  type IndexNowBackfillManifest,
} from "../src/lib/indexnow/backfill-manifest";
import { getIndexNowDeliveryControlState } from "../src/lib/indexnow/delivery-control";
import {
  INDEXNOW_BACKFILL_POLL_MS,
  INDEXNOW_BACKFILL_SETTLE_TIMEOUT_MS,
  INDEXNOW_HTTP_BATCH_SIZE,
} from "../src/lib/indexnow/delivery-primitives";
import {
  buildIndexNowCanonicalUrl,
  isNovelIndexNowEligible,
  loadIndexNowCandidateArticles,
  type IndexNowEligibilityOptions,
} from "../src/lib/indexnow/eligibility";
import { articleHasAnyIndexNowOutbox, enqueueIndexNowFirstPublish } from "../src/lib/indexnow/outbox";
import {
  isIndexNowDeliveryEnabled,
  isIndexNowDeliveryWriteAllowed,
  isIndexNowOutboxEnabled,
  isIndexNowOutboxWriteAllowed,
} from "../src/lib/flags";

export const APPLY_USAGE = `Usage:
  tsx scripts/indexnow-backfill-apply.ts --help
  tsx scripts/indexnow-backfill-apply.ts --manifest <path> [--offset N] [--limit N] [--canary-locales a,b,...] [--confirm]

  Without --confirm this is a dry run: it writes nothing, waits for nothing, and prints how many entries are
  eligible / drifted / already have a delivery record.
  With --confirm (and INDEXNOW_BACKFILL_ALLOW_WRITE=true, and outbox + delivery switched on in this process) it
  enqueues the entries in chunks of ${INDEXNOW_HTTP_BATCH_SIZE}, waits for each chunk to be delivered, and runs the global stop
  check before every chunk.

  --offset N / --limit N   integers; offset >= 0, limit >= 1; no upper cap. Without --limit: from the offset to the
                           end of the manifest.
  --canary-locales a,b,..  trial sample: round-robin over the given locales (>= 2, each present in the manifest), each
                           locale's entries in ascending article_id; needs --limit; deterministic. The main run
                           (--offset 0) later skips the entries already pushed.
`;

function flagValue(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

export interface ApplyCliArgs {
  help: boolean;
  manifest?: string;
  confirm: boolean;
  offset: number;
  limit?: number;
  canaryLocales?: string[];
}

function parseStrictInteger(name: string, raw: string, minimum: number): number {
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) < minimum) {
    throw new Error(`${name} must be an integer >= ${minimum}: ${raw}`);
  }
  return Number(raw);
}

export function parseApplyArgs(argv: readonly string[] = process.argv.slice(2)): ApplyCliArgs {
  if (argv.includes("--help") || argv.includes("-h")) return { help: true, confirm: false, offset: 0 };
  const manifest = flagValue(argv, "--manifest");
  if (!manifest) throw new Error("--manifest <path> is required");
  const rawOffset = flagValue(argv, "--offset");
  const rawLimit = flagValue(argv, "--limit");
  const rawCanary = flagValue(argv, "--canary-locales");
  const args: ApplyCliArgs = {
    help: false,
    manifest,
    confirm: argv.includes("--confirm"),
    offset: rawOffset === undefined ? 0 : parseStrictInteger("--offset", rawOffset, 0),
    limit: rawLimit === undefined ? undefined : parseStrictInteger("--limit", rawLimit, 1),
  };
  if (rawCanary !== undefined) {
    const locales = rawCanary.split(",").map((value) => value.trim());
    if (locales.some((value) => value.length === 0)) throw new Error("--canary-locales must not contain an empty item");
    if (new Set(locales).size !== locales.length) throw new Error("--canary-locales must not contain a duplicate locale");
    if (locales.length < 2) throw new Error("--canary-locales needs at least 2 locales");
    if (args.limit === undefined) throw new Error("--canary-locales requires --limit (the trial sample size)");
    if (args.offset !== 0) throw new Error("--canary-locales cannot be combined with --offset");
    args.canaryLocales = locales;
  }
  return args;
}

// ---------------------------------------------------------------------------
// Gate 2
// ---------------------------------------------------------------------------

export function assertBackfillWriteGates(confirm: boolean, allowWrite: string | undefined): void {
  if (!confirm || allowWrite !== "true") {
    throw new Error("write requires both --confirm and INDEXNOW_BACKFILL_ALLOW_WRITE=true");
  }
}

/** Write mode waits for delivery, so both switch pairs must be on in THIS process. */
export function assertBackfillRuntimeFlags(env: NodeJS.ProcessEnv = process.env): void {
  if (!isIndexNowOutboxEnabled(env) || !isIndexNowOutboxWriteAllowed(env)) {
    throw new Error(
      "outbox_disabled: FEATURE_INDEXNOW_OUTBOX and INDEXNOW_OUTBOX_ALLOW_WRITE must both be true in this process",
    );
  }
  if (!isIndexNowDeliveryEnabled(env) || !isIndexNowDeliveryWriteAllowed(env)) {
    throw new Error(
      "delivery_disabled_cannot_wait: FEATURE_INDEXNOW_DELIVERY and INDEXNOW_DELIVERY_ALLOW_WRITE must both be true; a write run waits for each chunk to be delivered",
    );
  }
}

// ---------------------------------------------------------------------------
// Global stop conditions
// ---------------------------------------------------------------------------

export interface BackfillGlobalSummary {
  breakerOpen: boolean;
  breakerTrippedBy: { httpStatus: number | null; requestBatchId: string | null } | null;
  /** ISO deadline when a global 429 wait is active, else null. */
  rateLimitedUntil: string | null;
  /** Rows with `source = 'backfill'`. */
  backfillUrls: { total: number; permanentFailed: number; deadLetter: number };
  /** `failed` `indexnow_delivery` tasks that delivered backfill rows. */
  failedDeliveryTasks: number;
  /** Rows in `dead_letter`, any source. */
  deadLetterUrls: number;
  /** Rows cancelled for `url_invalid` / `url_host_mismatch`, any source. */
  invalidUrlCancelledUrls: number;
}

export interface BackfillPreviousChunk {
  urls: number;
  /** Rows of the previous chunk that are neither `accepted` nor `cancelled`. */
  notAcceptedUrls: number;
}

/** One round of SQL aggregates (groupBy / count) over the whole table; never loads rows. */
export async function collectBackfillGlobalSummary(db: PrismaClient): Promise<BackfillGlobalSummary> {
  const control = await getIndexNowDeliveryControlState(db);
  const byStatus = await db.indexNowOutbox.groupBy({
    by: ["status"],
    where: { source: "backfill" },
    _count: { _all: true },
  });
  const countOf = (status: string) => byStatus.find((row) => row.status === status)?._count._all ?? 0;
  const total = byStatus.reduce((sum, row) => sum + row._count._all, 0);

  const taskGroups = await db.indexNowOutbox.groupBy({
    by: ["deliveryTaskId"],
    where: { source: "backfill", deliveryTaskId: { not: null } },
    _count: { _all: true },
  });
  const taskIds = taskGroups.flatMap((row) => (row.deliveryTaskId ? [row.deliveryTaskId] : []));
  const failedDeliveryTasks = taskIds.length === 0 ? 0 : await db.genericTask.count({ where: { id: { in: taskIds }, status: "failed" } });

  return {
    breakerOpen: control.breaker.open,
    breakerTrippedBy: control.breaker.open
      ? { httpStatus: control.breaker.trippedBy.httpStatus, requestBatchId: control.breaker.trippedBy.requestBatchId }
      : null,
    rateLimitedUntil: control.rateLimit.waiting ? control.rateLimit.until.toISOString() : null,
    backfillUrls: { total, permanentFailed: countOf("permanent_failed"), deadLetter: countOf("dead_letter") },
    failedDeliveryTasks,
    deadLetterUrls: await db.indexNowOutbox.count({ where: { status: "dead_letter" } }),
    invalidUrlCancelledUrls: await db.indexNowOutbox.count({
      where: { status: "cancelled", lastErrorKind: { in: ["url_invalid", "url_host_mismatch"] } },
    }),
  };
}

/** Pure decision over the global summary; throws on the first stop condition that holds. */
export function assertBackfillStopConditions(summary: BackfillGlobalSummary, previousChunk?: BackfillPreviousChunk): void {
  if (summary.breakerOpen) {
    const by = summary.breakerTrippedBy;
    throw new Error(
      `backfill stop condition: delivery breaker is open (HTTP 400/403/422 since the last manual resume${
        by?.httpStatus ? `, first status ${by.httpStatus}` : ""
      }); read indexnow-status, fix the cause, then run indexnow-delivery-resume`,
    );
  }
  if (summary.rateLimitedUntil) {
    throw new Error(`backfill stop condition: global HTTP 429 wait active until ${summary.rateLimitedUntil}`);
  }
  if (summary.deadLetterUrls > 0) {
    throw new Error(
      `backfill stop condition: ${summary.deadLetterUrls} dead_letter row(s) site-wide; 死信必须交 Owner；原样重跑回填会跳过已有记录，不能代替重排`,
    );
  }
  if (summary.invalidUrlCancelledUrls > 0) {
    throw new Error(
      `backfill stop condition: ${summary.invalidUrlCancelledUrls} row(s) cancelled for url_invalid / url_host_mismatch; check the canonical URL and the configured IndexNow host`,
    );
  }
  if (summary.failedDeliveryTasks > 0) {
    throw new Error("backfill stop condition: delivery worker task failed or crashed");
  }
  const { total, permanentFailed, deadLetter } = summary.backfillUrls;
  if (total > 0 && (permanentFailed + deadLetter) / total > 0.05) {
    throw new Error("backfill stop condition: terminal failure ratio exceeds 5% of all backfill rows");
  }
  if (previousChunk && previousChunk.notAcceptedUrls > 0) {
    throw new Error(
      `backfill stop condition: previous chunk not fully accepted (accepted means HTTP 200 或 202): ${previousChunk.notAcceptedUrls} of ${previousChunk.urls} url(s) are not accepted`,
    );
  }
}

// ---------------------------------------------------------------------------
// Canary sample
// ---------------------------------------------------------------------------

export interface CanarySelection {
  entries: IndexNowBackfillEntry[];
  perLocaleUrls: Record<string, number>;
}

/**
 * Deterministic trial sample: round-robin over `locales` in the given order,
 * each locale's entries in ascending `article_id`, until `limit` entries are
 * picked or every locale is exhausted. The even split falls out of the
 * round-robin: the remainder goes to the earlier-listed locales, and a locale
 * with too few entries simply drops out so the others take its share.
 */
export function selectCanaryEntries(
  entries: readonly IndexNowBackfillEntry[],
  locales: readonly string[],
  limit: number,
): CanarySelection {
  if (locales.length < 2) throw new Error("--canary-locales needs at least 2 locales");
  const lists = new Map<string, IndexNowBackfillEntry[]>(locales.map((locale) => [locale, []]));
  for (const entry of entries) lists.get(entry.locale)?.push(entry);
  const missing = locales.filter((locale) => lists.get(locale)!.length === 0);
  if (missing.length > 0) {
    throw new Error(`--canary-locales not present in the manifest: [${missing.join(",")}]`);
  }
  for (const list of lists.values()) list.sort((a, b) => (a.article_id < b.article_id ? -1 : a.article_id > b.article_id ? 1 : 0));

  const picked: IndexNowBackfillEntry[] = [];
  const perLocaleUrls: Record<string, number> = Object.fromEntries(locales.map((locale) => [locale, 0]));
  const cursor = new Map<string, number>(locales.map((locale) => [locale, 0]));
  let progressed = true;
  while (picked.length < limit && progressed) {
    progressed = false;
    for (const locale of locales) {
      if (picked.length >= limit) break;
      const list = lists.get(locale)!;
      const position = cursor.get(locale)!;
      if (position >= list.length) continue;
      picked.push(list[position]!);
      cursor.set(locale, position + 1);
      perLocaleUrls[locale]!++;
      progressed = true;
    }
  }
  return { entries: picked, perLocaleUrls };
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

export interface ApplyBackfillOptions {
  write: boolean;
  offset: number;
  limit?: number;
  canaryLocales?: string[];
  /** Test seam; production is always `INDEXNOW_HTTP_BATCH_SIZE`. */
  chunkSize?: number;
}

export interface ApplyBackfillDeps {
  env?: NodeJS.ProcessEnv;
  eligibilityOptions?: IndexNowEligibilityOptions;
  log?: (line: Record<string, unknown>) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Replaces the default "poll until the chunk left pending/processing" wait (tests drive the delivery by hand). */
  waitForChunk?: (db: PrismaClient, outboxIds: readonly string[]) => Promise<void>;
}

export interface ApplyBackfillReport {
  mode: "apply" | "dry-run";
  selectedUrls: number;
  chunks: number;
  eligibleUrls: number;
  driftedUrls: number;
  alreadyHasDeliveryUrls: number;
  enqueuedUrls: number;
  duplicateUrls: number;
  ineligibleUrls: number;
  disabledUrls: number;
  acceptedUrls: number;
  accepted200Urls: number;
  accepted202Urls: number;
  notAcceptedUrls: number;
  cancelledUrls: number;
  httpRequests: number;
  canary?: Record<string, number>;
}

const KEY_VALIDATION_NOTICE = "协议已接收，密钥验证待完成";

/** Polls until none of the chunk's rows is `pending`/`processing`; `delivery_stalled` after 10 minutes. */
export async function waitForIndexNowChunkSettled(
  db: PrismaClient,
  outboxIds: readonly string[],
  deps: { sleep?: (ms: number) => Promise<void>; now?: () => number } = {},
): Promise<void> {
  if (outboxIds.length === 0) return;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = deps.now ?? Date.now;
  const startedAt = now();
  for (;;) {
    const open = await db.indexNowOutbox.count({
      where: { id: { in: [...outboxIds] }, status: { in: ["pending", "processing"] } },
    });
    if (open === 0) return;
    if (now() - startedAt >= INDEXNOW_BACKFILL_SETTLE_TIMEOUT_MS) {
      throw new Error(`delivery_stalled: ${open} url(s) of the chunk still pending/processing after ${INDEXNOW_BACKFILL_SETTLE_TIMEOUT_MS / 60_000} minutes`);
    }
    await sleep(INDEXNOW_BACKFILL_POLL_MS);
  }
}

async function chunkOutcome(db: PrismaClient, outboxIds: readonly string[]) {
  const byStatus = await db.indexNowOutbox.groupBy({
    by: ["status"],
    where: { id: { in: [...outboxIds] } },
    _count: { _all: true },
  });
  const countOf = (status: string) => byStatus.find((row) => row.status === status)?._count._all ?? 0;
  const attempts = await db.indexNowOutboxAttempt.findMany({
    where: { outboxId: { in: [...outboxIds] }, attemptState: "completed" },
    select: { requestBatchId: true, httpStatus: true, outcome: true },
  });
  const accepted = attempts.filter((attempt) => attempt.outcome === "accepted");
  return {
    acceptedUrls: countOf("accepted"),
    accepted200Urls: accepted.filter((attempt) => attempt.httpStatus === 200).length,
    accepted202Urls: accepted.filter((attempt) => attempt.httpStatus === 202).length,
    cancelledUrls: countOf("cancelled"),
    notAcceptedUrls: byStatus.reduce((sum, row) => sum + (row.status === "accepted" || row.status === "cancelled" ? 0 : row._count._all), 0),
    httpRequests: new Set(attempts.map((attempt) => attempt.requestBatchId)).size,
  };
}

export async function applyBackfill(
  db: PrismaClient,
  manifest: IndexNowBackfillManifest,
  options: ApplyBackfillOptions,
  deps: ApplyBackfillDeps = {},
): Promise<ApplyBackfillReport> {
  const env = deps.env ?? process.env;
  const log = deps.log ?? ((line: Record<string, unknown>) => console.log(JSON.stringify(line)));
  const now = deps.now ?? Date.now;
  const chunkSize = options.chunkSize ?? INDEXNOW_HTTP_BATCH_SIZE;
  if (options.write) assertBackfillRuntimeFlags(env);

  let selected: IndexNowBackfillEntry[];
  let canary: Record<string, number> | undefined;
  if (options.canaryLocales) {
    if (options.limit === undefined) throw new Error("--canary-locales requires --limit (the trial sample size)");
    const picked = selectCanaryEntries(manifest.entries, options.canaryLocales, options.limit);
    selected = picked.entries;
    canary = picked.perLocaleUrls;
    log({ canary: picked.perLocaleUrls, selectedUrls: selected.length });
  } else {
    const limit = options.limit ?? Math.max(0, manifest.entries.length - options.offset);
    selected = manifest.entries.slice(options.offset, options.offset + limit);
  }

  const report: ApplyBackfillReport = {
    mode: options.write ? "apply" : "dry-run",
    selectedUrls: selected.length,
    chunks: 0,
    eligibleUrls: 0,
    driftedUrls: 0,
    alreadyHasDeliveryUrls: 0,
    enqueuedUrls: 0,
    duplicateUrls: 0,
    ineligibleUrls: 0,
    disabledUrls: 0,
    acceptedUrls: 0,
    accepted200Urls: 0,
    accepted202Urls: 0,
    notAcceptedUrls: 0,
    cancelledUrls: 0,
    httpRequests: 0,
    ...(canary ? { canary } : {}),
  };

  let previousChunk: BackfillPreviousChunk | undefined;
  for (let start = 0, chunkIndex = 0; start < selected.length; start += chunkSize, chunkIndex++) {
    const chunk = selected.slice(start, start + chunkSize);
    const startedAt = now();

    // Global stop check BEFORE the chunk — including the first one.
    assertBackfillStopConditions(await collectBackfillGlobalSummary(db), options.write ? previousChunk : undefined);

    const articles = await loadIndexNowCandidateArticles(
      db,
      chunk.map((entry) => entry.article_id),
    );
    const line = { eligibleUrls: 0, driftedUrls: 0, alreadyHasDeliveryUrls: 0, enqueuedUrls: 0, duplicateUrls: 0, ineligibleUrls: 0, disabledUrls: 0 };
    const enqueuedIds: string[] = [];
    for (const entry of chunk) {
      const article = articles.get(entry.article_id);
      // C-29b: this manifest format is `novel_article`-only (`novel_id` is
      // non-null) — narrow explicitly rather than casting, so a hand-edited or
      // stale entry pointing at a blog Article is treated as drifted.
      const novelArticle = article && article.articleType === "novel_article" ? article : null;
      const eligible = novelArticle
        ? isNovelIndexNowEligible(novelArticle, novelArticle.novel, novelArticle.promoLink, deps.eligibilityOptions)
        : false;
      const canonical = eligible && novelArticle ? buildIndexNowCanonicalUrl(novelArticle) : null;
      if (!canonical || canonical !== entry.canonical_url) {
        line.driftedUrls++;
        continue;
      }
      if (await articleHasAnyIndexNowOutbox(db, entry.article_id)) {
        line.alreadyHasDeliveryUrls++;
        continue;
      }
      line.eligibleUrls++;
      if (!options.write) continue;
      const result = await enqueueIndexNowFirstPublish(
        db,
        { articleId: entry.article_id, source: "backfill", eventType: "article_first_publish" },
        env,
        deps.eligibilityOptions,
      );
      if (result.outcome === "enqueued" || result.outcome === "deferred") {
        line.enqueuedUrls++;
        if (result.outboxId) enqueuedIds.push(result.outboxId);
      } else if (result.outcome === "duplicate") line.duplicateUrls++;
      else if (result.outcome === "ineligible") line.ineligibleUrls++;
      else line.disabledUrls++;
    }

    let outcome = { acceptedUrls: 0, accepted200Urls: 0, accepted202Urls: 0, cancelledUrls: 0, notAcceptedUrls: 0, httpRequests: 0 };
    if (options.write) {
      await (deps.waitForChunk ?? ((client, ids) => waitForIndexNowChunkSettled(client, ids, { sleep: deps.sleep, now: deps.now })))(db, enqueuedIds);
      if (enqueuedIds.length > 0) outcome = await chunkOutcome(db, enqueuedIds);
      previousChunk = { urls: enqueuedIds.length, notAcceptedUrls: outcome.notAcceptedUrls };
    }

    report.chunks++;
    for (const key of ["eligibleUrls", "driftedUrls", "alreadyHasDeliveryUrls", "enqueuedUrls", "duplicateUrls", "ineligibleUrls", "disabledUrls"] as const) {
      report[key] += line[key];
    }
    for (const key of ["acceptedUrls", "accepted200Urls", "accepted202Urls", "notAcceptedUrls", "cancelledUrls", "httpRequests"] as const) {
      report[key] += outcome[key];
    }
    log({
      chunkIndex,
      urls: chunk.length,
      ...line,
      ...outcome,
      ...(outcome.accepted202Urls > 0 ? { notice: KEY_VALIDATION_NOTICE } : {}),
      elapsedMs: now() - startedAt,
    });
  }

  // After the last chunk: a failing last chunk must fail the run too, not
  // only the chunk after it (there is none).
  if (options.write && previousChunk) {
    assertBackfillStopConditions(await collectBackfillGlobalSummary(db), previousChunk);
  }
  log({ summary: report, ...(report.accepted202Urls > 0 ? { notice: KEY_VALIDATION_NOTICE } : {}) });
  return report;
}

async function main(): Promise<void> {
  const args = parseApplyArgs();
  if (args.help) {
    console.log(APPLY_USAGE);
    return;
  }
  const manifest = JSON.parse(await fs.readFile(path.resolve(args.manifest!), "utf8")) as IndexNowBackfillManifest;
  if (!INDEXNOW_BACKFILL_SUPPORTED_SCHEMA_VERSIONS.includes(manifest.schema_version)) {
    throw new Error(`unsupported manifest schema_version: ${String(manifest.schema_version)}`);
  }
  if (!verifyManifestSha256(manifest)) throw new Error("manifest SHA-256 mismatch; file was modified");
  if (manifest.count !== manifest.expected_count) {
    throw new Error(`candidate count mismatch: actual=${manifest.count} expected=${manifest.expected_count}`);
  }
  const currentCommit = process.env.GIT_COMMIT?.trim() || "unknown-local-commit";
  if (manifest.release_commit !== currentCommit) {
    throw new Error(`release commit mismatch: manifest=${manifest.release_commit} current=${currentCommit}`);
  }

  if (args.confirm) assertBackfillWriteGates(true, process.env.INDEXNOW_BACKFILL_ALLOW_WRITE);

  const prisma = new PrismaClient();
  try {
    await applyBackfill(prisma, manifest, {
      write: args.confirm,
      offset: args.offset,
      limit: args.limit,
      canaryLocales: args.canaryLocales,
    });
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
