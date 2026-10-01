import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";

import {
  isAutoTaggingEnabled,
  isAutoTagWriteAuthorized,
  isTaggingEnabled,
} from "@/lib/flags/feature-flags";
import { TaggingError } from "@/lib/tagging/contracts";
import { fingerprint } from "@/lib/tagging/stable-json";
import {
  TAGGING_ALL_APPLY_CONFIRMATION,
  TAGGING_AUTO_CLASSIFY_TASK_TYPE,
  type TaggingAutoClassifyTaskPayload,
  type TaggingTaskLifecycle,
} from "@/lib/tagging/task-contract";
import {
  iterateNovelClassificationSnapshotPages,
  readNovelClassificationSnapshot,
  resolveAutoClassificationAuthorities,
  type AutoClassificationDependencies,
} from "./auto-classification";

import { normalizeTaggingNovelIds } from "@/lib/tagging/novel-id-scope";

export type TaggingTaskScope =
  | { kind: "novels"; novelIds: readonly string[] }
  | { kind: "novel"; novelId: string }
  | { kind: "locale"; locale: string }
  | { kind: "all" };

export interface TaggingAllApplyAuthorityConfirmation {
  literal: string;
  taxonomySha256: string;
  keywordFingerprint: string;
  classifierConfigFingerprint: string;
}

export interface CreateTaggingAutoClassifyTaskInput {
  db: PrismaClient;
  lifecycle: TaggingTaskLifecycle;
  mode?: "dry_run" | "apply";
  scope: TaggingTaskScope;
  requestId: string;
  env?: NodeJS.ProcessEnv;
  allApplyConfirmation?: TaggingAllApplyAuthorityConfirmation;
  dependencies?: AutoClassificationDependencies;
}

export type TaggingTaskCreationResult =
  | { status: "enqueued"; taskId: string; taskStatus: "pending"; eligibleCount: number }
  | { status: "duplicate"; taskId: string; eligibleCount: number }
  | { status: "no_eligible_novels"; eligibleCount: 0 }
  | { status: "skipped"; reason: "tagging_gates_closed"; eligibleCount: 0 };

/** The only per-novel fields a task item payload needs (B-21: no title/description). */
interface EligibleNovel {
  novelId: string;
  contentSha256: string;
  entityFingerprint: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Prisma's interactive-transaction default timeout is 5,000ms. Measured
// 2026-09-28: the genericTask create + nested createMany of all itemRows +
// operationAudit create took ~2.7s locally (PG 16.14 on Apple M5 Pro) for
// 43,431 items -- the English locale, the largest single locale in
// production. A read-only CPU benchmark run on both databases put the
// production VPS (AMD EPYC 9354P, 4 vCPU) at ~2.7-2.9x slower, i.e. ~8s
// there: over the default, so the default would fail with P2028. 120,000ms
// leaves ~15x headroom over that estimate (and still ~7x if the locale doubles).
export const TAGGING_TASK_TRANSACTION_TIMEOUT_MS = 120_000;
// maxWait bounds only the wait for a pooled connection before the transaction
// starts, not its runtime. The backfill CLI has its own idle client, but this
// function is also reached from web server actions and the worker's
// post-materialization hook, where a starved pool should fail within seconds
// rather than hold a request for the full timeout. 10,000ms is 5x Prisma's
// 2,000ms default.
export const TAGGING_TASK_TRANSACTION_MAX_WAIT_MS = 10_000;

// B-21: creating a locale/all task must not hold the whole locale in memory.
// Measured 2026-10-01 against 43,431 English novels (avg description ~900
// chars, PG 16.14, Prisma 6.19 library engine, process RSS incl. native memory):
//   - reading every snapshot into memory:            ~0.4 GiB
//   - ONE nested createMany of all 43,431 items:     ~2.7 GiB peak  <- the hog
// The JS heap stayed under 0.2 GiB throughout; the cost is the query engine
// materialising a single 43k-row nested write. So the items are written in
// bounded createMany chunks inside the SAME transaction (atomicity, the single
// task row, request-id idempotency and the item set are all unchanged), and the
// read keeps only the three per-novel fields the payload needs, never titles or
// descriptions. Smaller pages/chunks measurably lowered the peak further
// (RSS after a 43,431-row run: 5,000 -> ~0.55 GiB, 2,000 -> ~0.49 GiB,
// 1,000 -> ~0.41 GiB), so both stay at 1,000, well under the 5,000 hard cap.
export const TAGGING_TASK_READ_PAGE_SIZE = 1_000;
export const TAGGING_TASK_ITEM_INSERT_CHUNK_SIZE = 1_000;

function requireInput(input: CreateTaggingAutoClassifyTaskInput) {
  const mode = input.mode ?? "dry_run";
  if (mode !== "dry_run" && mode !== "apply") throw new TaggingError("DATA_INVARIANT_VIOLATION", "Invalid Tagging task mode");
  if (!input.requestId.trim() || input.requestId.length > 120) throw new TaggingError("DATA_INVARIANT_VIOLATION", "requestId is required and must not exceed 120 characters");
  if (input.scope.kind === "novels") normalizeTaggingNovelIds(input.scope.novelIds);
  if (input.scope.kind === "novel" && !UUID.test(input.scope.novelId)) throw new TaggingError("DATA_INVARIANT_VIOLATION", "novelId must be a UUID");
  if (input.scope.kind === "locale" && !input.scope.locale.trim()) throw new TaggingError("DATA_INVARIANT_VIOLATION", "locale must not be empty");
  return { mode };
}

function requireEnqueueGates(mode: "dry_run" | "apply", env: NodeJS.ProcessEnv): void {
  if (!isTaggingEnabled(env)) throw new TaggingError("TAGGING_DISABLED");
  if (mode === "apply" && !isAutoTaggingEnabled(env)) throw new TaggingError("TAGGING_DISABLED");
  if (mode === "apply" && !isAutoTagWriteAuthorized(env)) throw new TaggingError("AUTO_WRITE_NOT_AUTHORIZED");
}

function scopeForQuery(scope: TaggingTaskScope) {
  if (scope.kind === "novels") return { novelIds: normalizeTaggingNovelIds(scope.novelIds) };
  if (scope.kind === "novel") return { novelId: scope.novelId };
  if (scope.kind === "locale") return { locale: scope.locale };
  return { all: true as const };
}

function scopeSnapshot(scope: TaggingTaskScope) {
  if (scope.kind === "novels") return { kind: scope.kind, novelIds: normalizeTaggingNovelIds(scope.novelIds) };
  if (scope.kind === "novel") return { kind: scope.kind, novelId: scope.novelId };
  if (scope.kind === "locale") return { kind: scope.kind, locale: scope.locale };
  return { kind: scope.kind };
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

export async function createTaggingAutoClassifyTask(
  input: CreateTaggingAutoClassifyTaskInput,
): Promise<TaggingTaskCreationResult> {
  const { mode } = requireInput(input);
  const env = input.env ?? process.env;
  requireEnqueueGates(mode, env);
  const { config, artifact } = await resolveAutoClassificationAuthorities(input.db, input.dependencies);
  if (mode === "apply" && input.scope.kind === "all") {
    const confirmation = input.allApplyConfirmation;
    if (
      confirmation?.literal !== TAGGING_ALL_APPLY_CONFIRMATION
      || confirmation.taxonomySha256 !== artifact.taxonomySha256
      || confirmation.keywordFingerprint !== artifact.keywordFingerprint
      || confirmation.classifierConfigFingerprint !== config.fingerprint
    ) {
      throw new TaggingError("DATA_INVARIANT_VIOLATION", "All-scope apply authority confirmation mismatch");
    }
  }
  const authority = {
    taxonomyVersion: artifact.taxonomyVersion,
    taxonomySha256: artifact.taxonomySha256,
    keywordLexiconVersion: artifact.keywordLexiconVersion,
    keywordFingerprint: artifact.keywordFingerprint,
    classifierConfigVersion: config.version,
    classifierConfigFingerprint: config.fingerprint,
  };
  const requestFingerprint = fingerprint({
    schemaVersion: 1,
    lifecycle: input.lifecycle,
    mode,
    scope: scopeSnapshot(input.scope),
    authority,
  });
  const requestToken = `tagging:auto_classify:${input.requestId}`;
  const duplicate = await input.db.genericTask.findUnique({ where: { requestToken } });
  if (duplicate) {
    const params = duplicate.params as Record<string, unknown>;
    if (params.requestFingerprint !== requestFingerprint) throw new TaggingError("IDEMPOTENCY_CONFLICT");
    return { status: "duplicate", taskId: duplicate.id, eligibleCount: duplicate.totalCount };
  }
  // Keep only what the item payload needs. The full snapshot (title and
  // description) of a page is dropped as soon as the page has been filtered.
  const eligible: EligibleNovel[] = [];
  for await (const page of iterateNovelClassificationSnapshotPages(
    input.db,
    scopeForQuery(input.scope),
    { pageSize: TAGGING_TASK_READ_PAGE_SIZE },
  )) {
    for (const snapshot of page) {
      if (
        snapshot.mode === "automatic"
        && (input.lifecycle === "reclassify_existing" || snapshot.currentAutoRunId === null)
      ) {
        eligible.push({
          novelId: snapshot.novelId,
          contentSha256: snapshot.contentSha256,
          entityFingerprint: snapshot.entityFingerprint,
        });
      }
    }
  }
  if (eligible.length === 0) return { status: "no_eligible_novels", eligibleCount: 0 };

  const novelIds = eligible.map((novel) => novel.novelId);
  const payloadFingerprint = fingerprint({
    schemaVersion: 1,
    lifecycle: input.lifecycle,
    mode,
    scope: scopeSnapshot(input.scope),
    authority,
    novelIds,
  });
  const operationScopeHash = fingerprint({ lifecycle: input.lifecycle, novelIds });
  const taskId = randomUUID();
  const itemRowsFor = (novels: readonly EligibleNovel[]) => novels.map((novel) => {
    const itemId = randomUUID();
    const payload: TaggingAutoClassifyTaskPayload = {
      schemaVersion: 1,
      lifecycle: input.lifecycle,
      novelId: novel.novelId,
      expectedContentSha256: novel.contentSha256,
      expectedEntityFingerprint: novel.entityFingerprint,
      taxonomyVersion: artifact.taxonomyVersion,
      taxonomySha256: artifact.taxonomySha256,
      keywordLexiconVersion: artifact.keywordLexiconVersion,
      keywordFingerprint: artifact.keywordFingerprint,
      classifierConfigVersion: config.version,
      classifierConfigFingerprint: config.fingerprint,
      classificationRequestId: fingerprint({ taskItemId: itemId, novelId: novel.novelId }),
    };
    return {
      id: itemId,
      taskId,
      targetType: "Novel",
      targetId: novel.novelId,
      payload: payload as unknown as Prisma.InputJsonObject,
    };
  });
  try {
    await input.db.$transaction(async (tx) => {
      await tx.genericTask.create({ data: {
        id: taskId,
        taskType: TAGGING_AUTO_CLASSIFY_TASK_TYPE,
        operationScopeHash,
        mode,
        status: "pending",
        requestToken,
        totalCount: eligible.length,
        params: {
          schemaVersion: 1,
          lifecycle: input.lifecycle,
          scope: scopeSnapshot(input.scope),
          authority,
          requestFingerprint,
          payloadFingerprint,
        },
      } });
      // The task row is inserted first, exactly like the old nested create, so
      // a concurrent or replayed requestToken still fails here (P2002) before
      // any item is written. Item rows are built one chunk at a time.
      for (let offset = 0; offset < eligible.length; offset += TAGGING_TASK_ITEM_INSERT_CHUNK_SIZE) {
        await tx.genericTaskItem.createMany({
          data: itemRowsFor(eligible.slice(offset, offset + TAGGING_TASK_ITEM_INSERT_CHUNK_SIZE)),
        });
      }
      await tx.operationAudit.create({ data: {
        actorType: "operator",
        action: "tag.auto_classify.queued",
        entityType: "GenericTask",
        entityId: taskId,
        requestId: input.requestId,
        taskType: TAGGING_AUTO_CLASSIFY_TASK_TYPE,
        taskId,
        afterSnapshot: { lifecycle: input.lifecycle, mode, scope: scopeSnapshot(input.scope), eligibleCount: eligible.length, payloadFingerprint },
      } });
    }, { timeout: TAGGING_TASK_TRANSACTION_TIMEOUT_MS, maxWait: TAGGING_TASK_TRANSACTION_MAX_WAIT_MS });
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    const prior = await input.db.genericTask.findUnique({ where: { requestToken } });
    if (!prior) throw error;
    const params = prior.params as Record<string, unknown>;
    if (params.requestFingerprint !== requestFingerprint) throw new TaggingError("IDEMPOTENCY_CONFLICT");
    return { status: "duplicate", taskId: prior.id, eligibleCount: prior.totalCount };
  }
  return { status: "enqueued", taskId, taskStatus: "pending", eligibleCount: eligible.length };
}

export interface InitializeNovelTagSnapshotDependencies extends AutoClassificationDependencies {
  db: PrismaClient;
  env?: NodeJS.ProcessEnv;
}

export async function initializeNovelTagSnapshot(
  novelId: string,
  dependencies: InitializeNovelTagSnapshotDependencies,
): Promise<TaggingTaskCreationResult> {
  const env = dependencies.env ?? process.env;
  if (!isTaggingEnabled(env) || !isAutoTaggingEnabled(env) || !isAutoTagWriteAuthorized(env)) {
    console.info("[tagging-initialize]", { status: "skipped", reason: "tagging_gates_closed", novelId });
    return { status: "skipped", reason: "tagging_gates_closed", eligibleCount: 0 };
  }
  const snapshot = await readNovelClassificationSnapshot(dependencies.db, novelId);
  if (snapshot.currentAutoRunId !== null || snapshot.mode === "manual") {
    return { status: "no_eligible_novels", eligibleCount: 0 };
  }
  const authorities = await resolveAutoClassificationAuthorities(dependencies.db, dependencies);
  const requestId = fingerprint({
    operation: "initialize_missing",
    novelId,
    contentSha256: snapshot.contentSha256,
    entityFingerprint: snapshot.entityFingerprint,
    configFingerprint: authorities.config.fingerprint,
    keywordFingerprint: authorities.artifact.keywordFingerprint,
  });
  return createTaggingAutoClassifyTask({
    db: dependencies.db,
    lifecycle: "initialize_missing",
    mode: "apply",
    scope: { kind: "novel", novelId },
    requestId,
    env: dependencies.env,
    dependencies,
  });
}
