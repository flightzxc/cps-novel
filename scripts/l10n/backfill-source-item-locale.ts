/**
 * L10N P1 backfill CLI — recomputes `NovelSourceItem.sourceLocale` from the
 * `channel-language.ts` moboreader registry
 * (`施工提示词_Sonnet_L10N_P1_语言归一与存量重算_2026-09-10.md` §1.F).
 *
 * ADAPT of CPS `3a76877:scripts/backfill-drama-source-item-locale.ts`:
 * default dry-run, `--re-resolve` (re-resolve every row, not just currently
 * `NULL` ones), `--batch-size`, cursor pagination on `id` (`orderBy: { id:
 * "asc" }`, `id: { gt: lastId }` — same shape as the CPS original). What
 * changed from the CPS original:
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

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type BackfillSourceItemLocaleErrorCode =
  | "approver_required"
  | "approver_not_found"
  | "approver_inactive";

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
 * `updateMany`) and one `OperationAudit` row (skipped, `wrote: false`, on a
 * replayed `--request-id`).
 */
export async function backfillSourceItemLocale(
  db: BackfillSourceItemLocaleDb,
  options: BackfillSourceItemLocaleOptions = {},
): Promise<BackfillSourceItemLocaleReport> {
  const apply = options.apply === true;
  const reResolve = options.reResolve === true;
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
        ...(reResolve ? {} : { sourceLocale: null }),
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

  let auditId: string | null = null;
  let wrote = false;
  if (apply) {
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
    } else {
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
