import { pathToFileURL } from "node:url";
import { Prisma, PrismaClient } from "@prisma/client";

import { setTransactionReadOnly } from "../lib/set-transaction-read-only";
import { LEGACY_TAG_CLASSIFIER_CONFIG_V2, PRODUCTION_TAG_CLASSIFIER_CONFIG } from "../../src/lib/tagging/classifier-config";
import { TAGGING_ALL_APPLY_CONFIRMATION, TAGGING_TASK_LIFECYCLES, type TaggingTaskLifecycle } from "../../src/lib/tagging/task-contract";
import { resolveAutoClassificationAuthorities } from "../../src/server/tagging/auto-classification";
import { summarizeRuleImpact } from "../../src/server/tagging/rule-impact";
import { createTaggingAutoClassifyTask, type CreateTaggingAutoClassifyTaskInput, type TaggingTaskScope } from "../../src/server/tagging/tasks";

export interface TaggingBackfillCliOptions {
  lifecycle: TaggingTaskLifecycle;
  requestId: string;
  mode: "dry_run" | "apply";
  /** B-23: print the read-only per-locale rule-change report instead of creating a task. */
  impactReport?: boolean;
  scope: TaggingTaskScope;
  confirmAll?: string;
  taxonomySha256?: string;
  keywordFingerprint?: string;
  classifierConfigFingerprint?: string;
}

function value(args: string[], index: number, flag: string): string {
  const next = args[index + 1];
  if (!next || next.startsWith("--")) throw new Error(`${flag} requires a value`);
  return next;
}

export function parseTaggingBackfillArgs(args: string[]): TaggingBackfillCliOptions {
  let lifecycle: TaggingTaskLifecycle | undefined;
  let requestId: string | undefined;
  let mode: "dry_run" | "apply" = "dry_run";
  let explicitMode = false;
  let novelId: string | undefined;
  let locale: string | undefined;
  let all = false;
  let impactReport = false;
  let confirmAll: string | undefined;
  let taxonomySha256: string | undefined;
  let keywordFingerprint: string | undefined;
  let classifierConfigFingerprint: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === "--lifecycle") lifecycle = value(args, index++, flag) as TaggingTaskLifecycle;
    else if (flag === "--request-id") requestId = value(args, index++, flag);
    else if (flag === "--novel-id") novelId = value(args, index++, flag);
    else if (flag === "--locale") locale = value(args, index++, flag);
    else if (flag === "--all") all = true;
    else if (flag === "--impact-report") impactReport = true;
    else if (flag === "--dry-run" || flag === "--apply") {
      if (explicitMode) throw new Error("Specify only one of --dry-run or --apply");
      explicitMode = true;
      mode = flag === "--apply" ? "apply" : "dry_run";
    } else if (flag === "--confirm-all") confirmAll = value(args, index++, flag);
    else if (flag === "--taxonomy-sha256") taxonomySha256 = value(args, index++, flag);
    else if (flag === "--keyword-fingerprint") keywordFingerprint = value(args, index++, flag);
    else if (flag === "--config-fingerprint") classifierConfigFingerprint = value(args, index++, flag);
    else throw new Error(`Unknown argument: ${flag}`);
  }
  if (!impactReport) {
    if (!lifecycle || !TAGGING_TASK_LIFECYCLES.includes(lifecycle)) throw new Error("--lifecycle must be initialize_missing or reclassify_existing");
    if (!requestId) throw new Error("--request-id is required");
  }
  const scopes = Number(Boolean(novelId)) + Number(Boolean(locale)) + Number(all);
  if (scopes !== 1) throw new Error("Specify exactly one of --novel-id, --locale, or --all");
  const scope: TaggingTaskScope = novelId
    ? { kind: "novel", novelId }
    : locale ? { kind: "locale", locale } : { kind: "all" };
  if (impactReport) {
    // Read-only report: no task, no lifecycle, no request id, never an apply.
    if (explicitMode && mode === "apply") throw new Error("--impact-report is read-only and cannot be combined with --apply");
    if (lifecycle || requestId || confirmAll || taxonomySha256 || keywordFingerprint || classifierConfigFingerprint) {
      throw new Error("--impact-report takes only a scope (--novel-id, --locale or --all)");
    }
    return { lifecycle: "reclassify_existing", requestId: "impact-report", mode: "dry_run", impactReport: true, scope };
  }
  if (mode === "apply" && all && (
    confirmAll !== TAGGING_ALL_APPLY_CONFIRMATION
    || !taxonomySha256
    || !keywordFingerprint
    || !classifierConfigFingerprint
  )) {
    throw new Error("--all --apply requires exact confirmation and all three authority fingerprints");
  }
  return {
    lifecycle: lifecycle!, // validated above on every non-report path
    requestId: requestId!,
    mode,
    scope,
    confirmAll,
    taxonomySha256,
    keywordFingerprint,
    classifierConfigFingerprint,
  };
}

/**
 * B-23: what would reclassify_existing change if the current production
 * classifier config replaced the v0.5.6 one? Runs in ONE read-only database
 * transaction (a write of any kind is refused by PostgreSQL itself), creates no
 * task, and prints the per-locale counts plus the three authority fingerprints
 * a later `--all --apply` has to be given.
 */
export async function runImpactReport(db: PrismaClient, options: TaggingBackfillCliOptions) {
  return db.$transaction(async (tx) => {
    await setTransactionReadOnly(tx);
    const [{ current_user: databaseRole }] = await tx.$queryRaw<Array<{ current_user: string }>>(Prisma.sql`SELECT current_user`);
    const { artifact } = await resolveAutoClassificationAuthorities(tx);
    const scope = options.scope.kind === "novel" ? { novelId: options.scope.novelId }
      : options.scope.kind === "locale" ? { locale: options.scope.locale }
        : { all: true as const };
    const report = await summarizeRuleImpact(tx, {
      scope, artifact, baseline: LEGACY_TAG_CLASSIFIER_CONFIG_V2, candidate: PRODUCTION_TAG_CLASSIFIER_CONFIG,
    });
    return {
      report: "tagging-rule-impact",
      databaseRole,
      transactionMode: "READ_ONLY",
      scope: options.scope,
      ...report,
      applyAuthority: {
        taxonomySha256: artifact.taxonomySha256,
        keywordFingerprint: artifact.keywordFingerprint,
        classifierConfigFingerprint: PRODUCTION_TAG_CLASSIFIER_CONFIG.fingerprint,
      },
    };
  }, { maxWait: 30_000, timeout: 1_800_000 });
}

export async function main(args = process.argv.slice(2), env = process.env): Promise<void> {
  const options = parseTaggingBackfillArgs(args);
  const datasourceUrl = env.P2_06_5_TAGGING_TASK_DATABASE_URL;
  if (!datasourceUrl) throw new Error("P2_06_5_TAGGING_TASK_DATABASE_URL is required");
  const db = new PrismaClient({ datasourceUrl });
  try {
    if (options.impactReport) {
      process.stdout.write(`${JSON.stringify(await runImpactReport(db, options), null, 2)}\n`);
      return;
    }
    const input: CreateTaggingAutoClassifyTaskInput = {
      db,
      lifecycle: options.lifecycle,
      mode: options.mode,
      scope: options.scope,
      requestId: options.requestId,
      env,
      ...(options.mode === "apply" && options.scope.kind === "all" ? {
        allApplyConfirmation: {
          literal: options.confirmAll!,
          taxonomySha256: options.taxonomySha256!,
          keywordFingerprint: options.keywordFingerprint!,
          classifierConfigFingerprint: options.classifierConfigFingerprint!,
        },
      } : {}),
    };
    const result = await createTaggingAutoClassifyTask(input);
    process.stdout.write(`${JSON.stringify({ ...result, mode: options.mode, lifecycle: options.lifecycle, scope: options.scope })}\n`);
  } finally {
    await db.$disconnect();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    const value = error && typeof error === "object"
      ? { code: "code" in error ? error.code : "TAGGING_BACKFILL_FAILED", message: "message" in error ? error.message : String(error) }
      : { code: "TAGGING_BACKFILL_FAILED", message: String(error) };
    console.error(JSON.stringify(value));
    process.exitCode = 1;
  });
}

