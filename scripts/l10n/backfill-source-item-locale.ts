/**
 * L10N P1 backfill CLI — recomputes `NovelSourceItem.sourceLocale` from the
 * `channel-language.ts` moboreader registry
 * (`施工提示词_Sonnet_L10N_P1_语言归一与存量重算_2026-09-10.md` §1.F).
 *
 * ADAPT of CPS `3a76877:scripts/backfill-drama-source-item-locale.ts`:
 * default dry-run, `--re-resolve` (re-resolve every row, not just the
 * default target set below), `--batch-size`, cursor pagination on `id`
 * (`orderBy: { id: "asc" }`, `id: { gt: lastId }` — same shape as the CPS
 * original). What changed from the CPS original:
 *
 * - CPS derives a per-row `channelAppKey` from `channelApp.channel.code` /
 *   `channelApp.sourceApp.code` because it has multiple channels/source
 *   apps. This repo has exactly one upstream source app (`moboreader`), so
 *   that derivation step is dropped — `resolveChannelLanguage` is called
 *   with no `sourceAppCode` (defaults to `moboreader`).
 * - CPS's `--apply` has no approval gate at all. This repo's governance
 *   model (`scripts/p2-06-5-production/tagging-bootstrap.ts`) requires an
 *   `--approver` (an active `AdminIdentity`, by UUID or username) for any
 *   `--apply`, and records an `OperationAudit` row — "审计 provenance 走
 *   tagging-bootstrap.ts 同款方式" per the construction prompt. `--reason`/
 *   `--request-id` are optional (unlike tagging-bootstrap, which requires
 *   both unconditionally): this script's dry-run is meant to be run freely
 *   for reporting, so only `--apply` pulls in the approval/audit machinery;
 *   a `--request-id` is used for replay-dedup only when supplied.
 * - `NovelSourceItem` has no CPS-equivalent mapping-version DB column —
 *   checked `3a76877:prisma/schema.prisma`'s `DramaSourceItem`, it has none
 *   either (§1.F's "有则加同名同义列，没有则不加" check) — so
 *   `MAPPING_VERSION` is recorded only in this report / the
 *   `OperationAudit.afterSnapshot`, never as a DB column. No migration.
 *
 * Default target set (post-复核修复, 2026-09-10): X8 只读实测证明生产/X8 库
 * `source_locale` 从来没有 SQL `NULL` 过（`WHERE source_locale IS NULL` = 0
 * 行）——P0-S15 之前的旧 worker 把"解析不出 locale"写成字面串 `'unknown'`，
 * 不是 `NULL`。原实现默认只扫 `sourceLocale IS NULL`，在真实数据上恒等于
 * 扫 0 行（Opus 复核 BLOCKING #1）。默认目标集改为 `sourceLocale IS NULL OR
 * sourceLocale = 'unknown'`（`LEGACY_UNKNOWN_LOCALE_LITERAL`，旧 worker 遗留
 * 的字面串）——两者都是"这行的 locale 从未被 L10N P1 新码表重算过"的证据。
 * `--re-resolve` 才重算已经有真实（非 NULL、非遗留字面串）取值的行。重算后
 * 解不出 locale 的行统一写 `NULL`（`resolveChannelLanguage` 从不返回字面串
 * `"unknown"`），字面串 `'unknown'` 在这条路径上被顺带清除，不会重新写回。
 *
 * Idempotent: `resolveChannelLanguage` is a pure function of
 * `(sourceLanguageCode, sourceLanguageName)`, so a second `--apply` run
 * (with or without `--re-resolve`) computes the exact same `nextLocale` for
 * every row and writes nothing (`changed: 0`) — no separate replay
 * mechanism is needed at the row level, only at the audit-log level (a
 * repeated `--request-id` does not create a second `OperationAudit` row).
 * Each row write is itself a conditional `updateMany` re-asserting the
 * previously-read `sourceLocale`, so a row changed by a concurrent writer
 * between read and write is left alone rather than clobbered.
 *
 * Zero-scan / zero-change audit discipline (Opus 复核 BLOCKING #2): a
 * `scanned === 0` run (nothing matched the target set — e.g. `--apply` was
 * invoked when every row is already resolved and `--re-resolve` was not
 * given) prints an explicit CLI warning and never writes an `OperationAudit`
 * row — an audit row whose snapshot says `scanned: 0, changed: 0` would be
 * a provenance record for work that provably did not happen. A
 * `scanned > 0, changed === 0` run (every scanned row already held its
 * correct resolved value) DOES still write an audit row — that is a real,
 * auditable "verified, no drift" outcome, not a no-op.
 *
 * Usage:
 *   npx tsx scripts/l10n/backfill-source-item-locale.ts [--re-resolve] [--batch-size N]
 *   npx tsx scripts/l10n/backfill-source-item-locale.ts --apply --approver <AdminIdentity uuid|username> \
 *     [--reason "<text>"] [--request-id <id>] [--re-resolve] [--batch-size N]
 *
 * P1 does NOT execute `--apply` against X8 — dry-run output only, see the
 * construction prompt §1.F/§3.
 */
import { fileURLToPath } from "node:url";
import path from "node:path";

import { PrismaClient } from "@prisma/client";

import { MAPPING_VERSION, resolveChannelLanguage } from "../../src/lib/locale/channel-language";

export const BACKFILL_SOURCE_LOCALE_DEFAULT_BATCH_SIZE = 500;
/** `in` 列表/单批规模纪律上限（`reference_cps_novel_repo_conventions.md`：`in` 列表 ≤5000 分块）。 */
export const BACKFILL_SOURCE_LOCALE_MAX_BATCH_SIZE = 5000;

export const BACKFILL_SOURCE_ITEM_LOCALE_AUDIT_ACTION = "novel_source_item.source_locale.backfill";

/**
 * Pre-P1 worker's literal write for "could not resolve" — never `NULL`
 * (`docs/governance/L10N_UPSTREAM_LANGUAGE_EVIDENCE_2026-09-10.md`'s X8
 * evidence: `WHERE source_locale IS NULL` = 0 rows, `= 'unknown'` = 50 625
 * rows). Part of the default (non-`--re-resolve`) target set alongside SQL
 * `NULL` — see this file's header comment.
 */
export const LEGACY_UNKNOWN_LOCALE_LITERAL = "unknown";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type BackfillSourceItemLocaleErrorCode =
  | "approver_required"
  | "approver_not_found"
  | "approver_inactive"
  | "invalid_batch_size";

export class BackfillSourceItemLocaleError extends Error {
  constructor(
    readonly code: BackfillSourceItemLocaleErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "BackfillSourceItemLocaleError";
  }
}

function fail(code: BackfillSourceItemLocaleErrorCode, message: string): never {
  throw new BackfillSourceItemLocaleError(code, message);
}

export type BackfillSourceItemLocaleRow = {
  id: string;
  sourceLanguageCode: string;
  sourceLanguageName: string | null;
  sourceLocale: string | null;
};

export type AdminIdentityLookupRow = { id: string; username: string; status: string };

export type OperationAuditLookupRow = { id: bigint | string; actorId: string | null };

/**
 * Injectable-db shape so the core loop can run against a fake in unit tests
 * (`tests/backend/locale/channel-language.test.ts`) and against a real
 * `PrismaClient` from the CLI entrypoint.
 */
export type BackfillSourceItemLocaleDb = {
  novelSourceItem: {
    findMany(args: {
      where: Record<string, unknown>;
      orderBy: { id: "asc" };
      take: number;
      select: {
        id: true;
        sourceLanguageCode: true;
        sourceLanguageName: true;
        sourceLocale: true;
      };
    }): Promise<BackfillSourceItemLocaleRow[]>;
    updateMany(args: {
      where: { id: string; sourceLocale: string | null };
      data: { sourceLocale: string | null };
    }): Promise<{ count: number }>;
  };
  adminIdentity: {
    findFirst(args: {
      where: Record<string, unknown>;
      select: { id: true; username: true; status: true };
    }): Promise<AdminIdentityLookupRow | null>;
  };
  operationAudit: {
    findFirst(args: {
      where: Record<string, unknown>;
      select: { id: true; actorId: true };
    }): Promise<OperationAuditLookupRow | null>;
    create(args: { data: Record<string, unknown> }): Promise<{ id: bigint | string }>;
  };
};

export type BackfillSourceItemLocaleOptions = {
  apply?: boolean;
  reResolve?: boolean;
  batchSize?: number;
  approver?: string;
  reason?: string;
  requestId?: string;
};

/** Per-`sourceLanguageCode` before/after `sourceLocale` value → row-count histogram. `null` is bucketed under the literal key `"null"`. */
export type LocaleCountHistogram = Record<string, number>;

export type BackfillSourceItemLocaleCodeStats = {
  total: number;
  before: LocaleCountHistogram;
  after: LocaleCountHistogram;
  changed: number;
};

export type BackfillSourceItemLocaleReport = {
  mode: "dry-run" | "apply";
  mappingVersion: string;
  reResolve: boolean;
  batchSize: number;
  scanned: number;
  changed: number;
  byCode: Record<string, BackfillSourceItemLocaleCodeStats>;
  approverId: string | null;
  auditId: string | null;
  wrote: boolean;
  /**
   * `true` when the target-set scan matched zero rows (`scanned === 0`) —
   * the CLI prints an explicit warning for this and, under `--apply`, no
   * `OperationAudit` row is written for the run (see this file's header
   * comment, "Zero-scan / zero-change audit discipline").
   */
  scannedZero: boolean;
};

const NULL_BUCKET_KEY = "null";

function bumpHistogram(histogram: LocaleCountHistogram, value: string | null): void {
  const key = value ?? NULL_BUCKET_KEY;
  histogram[key] = (histogram[key] ?? 0) + 1;
}

function emptyCodeStats(): BackfillSourceItemLocaleCodeStats {
  return { total: 0, before: {}, after: {}, changed: 0 };
}

async function resolveApprover(
  db: Pick<BackfillSourceItemLocaleDb, "adminIdentity">,
  approver: string,
): Promise<AdminIdentityLookupRow> {
  const where = UUID_PATTERN.test(approver) ? { id: approver.toLowerCase() } : { username: approver };
  const identity = await db.adminIdentity.findFirst({ where, select: { id: true, username: true, status: true } });
  if (!identity) fail("approver_not_found", `approver ${approver} does not resolve to any admin_identity row`);
  if (identity.status !== "active") fail("approver_inactive", `approver ${approver} is not active`);
  return identity;
}

/**
 * Core loop. Dry-run by default — reports per-`sourceLanguageCode`
 * before/after `sourceLocale` histograms and how many rows would change,
 * without writing anything. `--apply` requires a resolved, active
 * `--approver` and writes both the rows (idempotent conditional
 * `updateMany`) and one `OperationAudit` row — skipped (`wrote: false`) on a
 * replayed `--request-id`, and also skipped (no prior `--request-id` match)
 * when `scanned === 0` (see `scannedZero` on the report / this file's header
 * comment).
 */
export async function backfillSourceItemLocale(
  db: BackfillSourceItemLocaleDb,
  options: BackfillSourceItemLocaleOptions = {},
): Promise<BackfillSourceItemLocaleReport> {
  const apply = options.apply === true;
  const reResolve = options.reResolve === true;

  // Validate --batch-size before any DB call (fake or real) is issued — a
  // non-positive/non-integer value must fail closed, not silently clamp and
  // get handed to Prisma's `take` (Opus 复核 NON_BLOCKING c).
  if (options.batchSize !== undefined && (!Number.isInteger(options.batchSize) || options.batchSize <= 0)) {
    fail("invalid_batch_size", `--batch-size must be a positive integer, got ${options.batchSize}`);
  }
  const batchSize = Math.max(
    1,
    Math.min(options.batchSize ?? BACKFILL_SOURCE_LOCALE_DEFAULT_BATCH_SIZE, BACKFILL_SOURCE_LOCALE_MAX_BATCH_SIZE),
  );

  if (apply && (!options.approver || options.approver.trim().length === 0)) {
    fail("approver_required", "--approver is required for --apply");
  }
  const approver = apply ? await resolveApprover(db, options.approver!) : null;

  const byCode: Record<string, BackfillSourceItemLocaleCodeStats> = {};
  let scanned = 0;
  let changed = 0;
  let lastId = "";

  for (;;) {
    const rows = await db.novelSourceItem.findMany({
      where: {
        deletedAt: null,
        ...(lastId ? { id: { gt: lastId } } : {}),
        // Default target set: rows never touched by the L10N P1 registry —
        // SQL `NULL` (post-P1 worker writes this for an unresolved locale)
        // OR the legacy literal `'unknown'` (pre-P1 worker's write for the
        // same outcome; X8 evidence: `IS NULL` = 0 rows, `= 'unknown'` =
        // 50 625 rows — see this file's header). `--re-resolve` drops this
        // filter entirely and re-scans every row regardless of its current
        // value.
        ...(reResolve ? {} : { OR: [{ sourceLocale: null }, { sourceLocale: LEGACY_UNKNOWN_LOCALE_LITERAL }] }),
      },
      orderBy: { id: "asc" },
      take: batchSize,
      select: { id: true, sourceLanguageCode: true, sourceLanguageName: true, sourceLocale: true },
    });
    if (rows.length === 0) break;
    lastId = rows[rows.length - 1].id;
    scanned += rows.length;

    for (const row of rows) {
      const stats = (byCode[row.sourceLanguageCode] ??= emptyCodeStats());
      stats.total += 1;
      bumpHistogram(stats.before, row.sourceLocale);

      const resolution = resolveChannelLanguage({
        sourceLanguageCode: row.sourceLanguageCode,
        sourceLanguageName: row.sourceLanguageName,
      });
      const nextLocale = resolution.locale;
      bumpHistogram(stats.after, nextLocale);

      if (row.sourceLocale !== nextLocale) {
        stats.changed += 1;
        changed += 1;
        if (apply) {
          // Conditional write: re-asserts the previously-read `sourceLocale`
          // so a row changed by a concurrent writer between the read above
          // and this write is left alone rather than clobbered.
          await db.novelSourceItem.updateMany({
            where: { id: row.id, sourceLocale: row.sourceLocale },
            data: { sourceLocale: nextLocale },
          });
        }
      }
    }
    if (rows.length < batchSize) break; // last (short) page
  }

  const scannedZero = scanned === 0;

  let auditId: string | null = null;
  let wrote = false;
  if (apply) {
    // A `--request-id` replay is always honored first, independent of
    // `scannedZero` — this is a *read* (did this exact run already happen?),
    // not a new provenance write, so it must keep finding the prior run's
    // audit id even when this replay's own target set is now empty (e.g.
    // the first run already resolved every row the default filter would
    // have matched). Only *creating* a brand-new audit row is gated on
    // `!scannedZero` below.
    const existing = options.requestId
      ? await db.operationAudit.findFirst({
          where: {
            actorType: "system",
            action: BACKFILL_SOURCE_ITEM_LOCALE_AUDIT_ACTION,
            requestId: options.requestId,
          },
          select: { id: true, actorId: true },
        })
      : null;
    if (existing) {
      auditId = String(existing.id);
    } else if (!scannedZero) {
      // Zero-scan discipline (Opus 复核 BLOCKING #2): a run that matched
      // zero rows and has no prior audit to replay has nothing to attest
      // to — writing an `OperationAudit` row with `scanned: 0, changed: 0`
      // would be a provenance record for work that provably never touched
      // a row. `scanned > 0, changed === 0` is a different, real outcome
      // ("every scanned row already held its correct value") and still
      // gets an audit row here.
      const audit = await db.operationAudit.create({
        data: {
          actorType: "system",
          actorId: approver!.id,
          action: BACKFILL_SOURCE_ITEM_LOCALE_AUDIT_ACTION,
          entityType: "NovelSourceItem",
          entityId: MAPPING_VERSION,
          requestId: options.requestId ?? null,
          reason: options.reason ?? null,
          afterSnapshot: {
            mappingVersion: MAPPING_VERSION,
            reResolve,
            batchSize,
            scanned,
            changed,
            approverUsername: approver!.username,
            note: changed === 0 ? "verified_no_drift" : undefined,
          },
        },
      });
      auditId = String(audit.id);
      wrote = true;
    }
  }

  return {
    mode: apply ? "apply" : "dry-run",
    mappingVersion: MAPPING_VERSION,
    reResolve,
    batchSize,
    scanned,
    changed,
    byCode,
    approverId: approver?.id ?? null,
    auditId,
    wrote,
    scannedZero,
  };
}

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const reResolve = process.argv.includes("--re-resolve");
  const batchSizeArg = arg("--batch-size");
  const prisma = new PrismaClient();
  try {
    const report = await backfillSourceItemLocale(prisma, {
      apply,
      reResolve,
      batchSize: batchSizeArg ? Number(batchSizeArg) : undefined,
      approver: arg("--approver"),
      reason: arg("--reason"),
      requestId: arg("--request-id"),
    });
    if (report.mode === "dry-run") {
      console.log("[DRY RUN — no changes written; pass --apply --approver <AdminIdentity uuid|username> to backfill]");
    }
    if (report.scannedZero) {
      const targetSetDescription = reResolve
        ? "the full table (--re-resolve, no sourceLocale filter)"
        : `the default target set (sourceLocale IS NULL OR = '${LEGACY_UNKNOWN_LOCALE_LITERAL}')`;
      console.warn(
        `[WARNING] scanned=0 — ${targetSetDescription} matched zero rows. Nothing to backfill`
          + (apply ? "; no OperationAudit row was written for this run." : "."),
      );
    }
    console.log(JSON.stringify(report, null, 2));
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
