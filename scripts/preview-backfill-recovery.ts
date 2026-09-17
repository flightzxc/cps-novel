/**
 * Operator CLI for the preview backfill described in
 * `src/server/preview-recovery/backfill.ts` — the recovery path a Novel whose
 * one and only `moboreader.preview_refresh.v1` task failed otherwise has none
 * of. Read-only by default; `--apply` additionally requires an explicit
 * confirmation phrase, an explicit `--limit`, and a credential pre-flight that
 * passes.
 *
 * Run it from the worker tier: `novel_source_item` carries no `web_app` grant
 * (see `prisma/migrations/**` grant statements), and the credential pre-flight
 * needs the worker's keyring, so `DATABASE_URL` must be the `worker_app` one.
 *
 * Survey (default, writes nothing):
 *   npx tsx scripts/preview-backfill-recovery.ts \
 *     --channel-app-id <uuid> --request-id <stable-id> --limit 2000
 *
 * Narrow a run (survey or apply) to specific source items — the single-book
 * retry, and the way to rehearse before a catalog-wide run:
 *   npx tsx scripts/preview-backfill-recovery.ts \
 *     --channel-app-id <uuid> --request-id <stable-id> --limit 1 \
 *     --source-item-ids <uuid>[,<uuid>...]
 *
 * Apply after reviewing the survey output:
 *   npx tsx scripts/preview-backfill-recovery.ts \
 *     --channel-app-id <uuid> --request-id <same-stable-id> --limit 2000 \
 *     --apply --confirm APPLY_PREVIEW_BACKFILL
 *
 * Re-running `--apply` with the same `--request-id` is safe: each batch's
 * `request_token` is deterministic and `channel_sync_task.request_token` is
 * `UNIQUE`, so an already-created batch is refused rather than duplicated.
 */
import { fileURLToPath } from "node:url";
import path from "node:path";

import { PrismaClient } from "@prisma/client";

import { resolveContentPreviewAccount } from "../src/server/content-creation";
import {
  PREVIEW_BACKFILL_DEFAULT_BATCH_SIZE,
  PREVIEW_BACKFILL_MAX_BATCH_SIZE,
  PREVIEW_BACKFILL_MAX_LIMIT,
  runPreviewBackfill,
} from "../src/server/preview-recovery/backfill";
import { decryptCredentialSecretForWorker } from "../worker/credentials/crypto";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const PREVIEW_BACKFILL_CONFIRM_PHRASE = "APPLY_PREVIEW_BACKFILL";

/** Audit actor recorded on every task this tool enqueues, so an operator run is never mistaken for the automatic post-creation enqueue. */
export const PREVIEW_BACKFILL_ACTOR_ID = "preview-backfill-recovery";

export type PreviewBackfillArgs = Readonly<{
  channelAppId: string;
  requestId: string;
  limit: number;
  batchSize: number;
  onlySourceItemIds: readonly string[];
  apply: boolean;
}>;

function option(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

function boundedInteger(raw: string | undefined, max: number, code: string): number {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new Error(code);
  return value;
}

export function parsePreviewBackfillArgs(argv: readonly string[]): PreviewBackfillArgs {
  const channelAppId = option(argv, "--channel-app-id") ?? "";
  const requestId = option(argv, "--request-id") ?? "";
  const apply = argv.includes("--apply");
  if (!UUID.test(channelAppId)) throw new Error("channel_app_id_invalid");
  if (!requestId.trim() || requestId.length > 120) throw new Error("request_id_invalid");
  // `--limit` is mandatory rather than defaulted: the whole point of this tool
  // is that the candidate set can legitimately be the entire catalog, and an
  // operator must state how much of it this run is allowed to touch.
  const limit = boundedInteger(option(argv, "--limit"), PREVIEW_BACKFILL_MAX_LIMIT, "limit_invalid");
  const batchSizeRaw = option(argv, "--batch-size");
  const batchSize = batchSizeRaw === undefined
    ? PREVIEW_BACKFILL_DEFAULT_BATCH_SIZE
    : boundedInteger(batchSizeRaw, PREVIEW_BACKFILL_MAX_BATCH_SIZE, "batch_size_invalid");
  const onlyRaw = option(argv, "--source-item-ids");
  const onlySourceItemIds = onlyRaw === undefined
    ? []
    : onlyRaw.split(",").map((value) => value.trim()).filter((value) => value.length > 0);
  if (onlySourceItemIds.some((value) => !UUID.test(value))) throw new Error("source_item_ids_invalid");
  if (onlySourceItemIds.length > PREVIEW_BACKFILL_MAX_BATCH_SIZE) throw new Error("source_item_ids_invalid");
  if (apply && option(argv, "--confirm") !== PREVIEW_BACKFILL_CONFIRM_PHRASE) {
    throw new Error("apply_confirmation_invalid");
  }
  return { channelAppId, requestId, limit, batchSize, onlySourceItemIds, apply };
}

export type CredentialPreflight =
  | { readonly status: "usable"; readonly channelAccountId: string; readonly credentialId: string }
  | { readonly status: "unusable"; readonly code: string; readonly channelAccountId: string | null };

/**
 * The 2026-09-14 lesson, enforced before any write: re-enqueuing thousands of
 * preview tasks against a credential the worker cannot decrypt reproduces the
 * exact incident this tool exists to clean up (`maxAttempts: 1` turns every
 * one of them into a terminal `failed` at ~10ms each). This resolves the same
 * account `enqueueContentCreationPreview` will resolve and the same single
 * active credential row `loadMoboreaderPreviewScope` will select, then proves
 * it decrypts. It cannot prove upstream still accepts the token — only that
 * the failure mode which burned 79k tasks is not present right now.
 */
export async function preflightPreviewCredential(
  db: PrismaClient,
  channelAppId: string,
  now = new Date(),
  env: NodeJS.ProcessEnv = process.env,
): Promise<CredentialPreflight> {
  const channelAccountId = await resolveContentPreviewAccount(db, channelAppId, now);
  if (!channelAccountId) return { status: "unusable", code: "no_channel_account", channelAccountId: null };
  const account = await db.channelAccount.findFirst({
    where: { id: channelAccountId, status: "active", deletedAt: null },
    select: {
      id: true,
      credentials: {
        where: { status: "active", OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
        select: { id: true, encryptedSecret: true, keyVersion: true },
        orderBy: { createdAt: "desc" },
        take: 2,
      },
    },
  });
  if (!account) return { status: "unusable", code: "preview_account_unavailable", channelAccountId };
  if (account.credentials.length !== 1) {
    return {
      status: "unusable",
      code: account.credentials.length === 0 ? "credential_missing" : "credential_ambiguous",
      channelAccountId,
    };
  }
  const credential = account.credentials[0]!;
  try {
    const secret = decryptCredentialSecretForWorker(
      credential.encryptedSecret,
      account.id,
      credential.id,
      credential.keyVersion,
      env,
    );
    if (!secret.trim()) return { status: "unusable", code: "credential_validation_failed", channelAccountId };
  } catch {
    return { status: "unusable", code: "credential_validation_failed", channelAccountId };
  }
  return { status: "usable", channelAccountId, credentialId: credential.id };
}

export async function runPreviewBackfillCli(
  db: PrismaClient,
  args: PreviewBackfillArgs,
  now = new Date(),
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ readonly exitCode: number; readonly report: Record<string, unknown> }> {
  const preflight = await preflightPreviewCredential(db, args.channelAppId, now, env);
  if (args.apply && preflight.status !== "usable") {
    return {
      exitCode: 65,
      report: {
        mode: "apply",
        refused: "credential_preflight_failed",
        preflight,
        hint: "Fix the channel account credential first — applying now would re-burn every enqueued item exactly like 2026-09-14.",
      },
    };
  }
  const result = await runPreviewBackfill(db, {
    channelAppId: args.channelAppId,
    requestId: args.requestId,
    actorId: PREVIEW_BACKFILL_ACTOR_ID,
    limit: args.limit,
    batchSize: args.batchSize,
    onlySourceItemIds: args.onlySourceItemIds,
    apply: args.apply,
  });
  return {
    exitCode: 0,
    report: {
      mode: args.apply ? "apply" : "survey",
      preflight,
      channelAppId: args.channelAppId,
      requestId: args.requestId,
      limit: args.limit,
      batchSize: args.batchSize,
      onlySourceItemIds: args.onlySourceItemIds,
      candidateCount: result.survey.candidates.length,
      truncated: result.survey.truncated,
      failureBreakdown: result.survey.failureBreakdown,
      sampleCandidates: result.survey.candidates.slice(0, 5),
      batches: result.batches.map((batch) => ({
        batchIndex: batch.batchIndex,
        requestToken: batch.requestToken,
        itemCount: batch.novelSourceItemIds.length,
        enqueue: batch.enqueue,
      })),
    },
  };
}

async function main(): Promise<void> {
  const args = parsePreviewBackfillArgs(process.argv.slice(2));
  const db = new PrismaClient();
  try {
    const { exitCode, report } = await runPreviewBackfillCli(db, args);
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = exitCode;
  } finally {
    await db.$disconnect();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "preview_backfill_failed");
    process.exitCode = 64;
  });
}
