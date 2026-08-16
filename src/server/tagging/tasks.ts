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
  readNovelClassificationSnapshot,
  readNovelClassificationSnapshots,
  resolveAutoClassificationAuthorities,
  type AutoClassificationDependencies,
} from "./auto-classification";

export type TaggingTaskScope =
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
  | { status: "no_eligible_novels"; eligibleCount: 0 };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function requireInput(input: CreateTaggingAutoClassifyTaskInput) {
  const mode = input.mode ?? "dry_run";
  if (mode !== "dry_run" && mode !== "apply") throw new TaggingError("DATA_INVARIANT_VIOLATION", "Invalid Tagging task mode");
  if (!input.requestId.trim() || input.requestId.length > 120) throw new TaggingError("DATA_INVARIANT_VIOLATION", "requestId is required and must not exceed 120 characters");
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
  if (scope.kind === "novel") return { novelId: scope.novelId };
  if (scope.kind === "locale") return { locale: scope.locale };
  return { all: true as const };
}

function scopeSnapshot(scope: TaggingTaskScope) {
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
  const snapshots = await readNovelClassificationSnapshots(input.db, scopeForQuery(input.scope));
  const eligible = snapshots.filter((snapshot) => (
    snapshot.mode === "automatic"
    && (input.lifecycle === "reclassify_existing" || snapshot.currentAutoRunId === null)
  ));
  if (eligible.length === 0) return { status: "no_eligible_novels", eligibleCount: 0 };

  const itemRows = eligible.map((snapshot) => {
    const itemId = randomUUID();
    const payload: TaggingAutoClassifyTaskPayload = {
      schemaVersion: 1,
      lifecycle: input.lifecycle,
      novelId: snapshot.novelId,
      expectedContentSha256: snapshot.contentSha256,
      expectedEntityFingerprint: snapshot.entityFingerprint,
      taxonomyVersion: artifact.taxonomyVersion,
      taxonomySha256: artifact.taxonomySha256,
      keywordLexiconVersion: artifact.keywordLexiconVersion,
      keywordFingerprint: artifact.keywordFingerprint,
      classifierConfigVersion: config.version,
      classifierConfigFingerprint: config.fingerprint,
      classificationRequestId: fingerprint({ taskItemId: itemId, novelId: snapshot.novelId }),
    };
    return {
      id: itemId,
      targetType: "Novel",
      targetId: snapshot.novelId,
      payload: payload as unknown as Prisma.InputJsonObject,
    };
  });
  const payloadFingerprint = fingerprint({
    schemaVersion: 1,
    lifecycle: input.lifecycle,
    mode,
    scope: scopeSnapshot(input.scope),
    authority,
    novelIds: eligible.map((snapshot) => snapshot.novelId),
  });
  const taskId = randomUUID();
  try {
    await input.db.$transaction(async (tx) => {
      await tx.genericTask.create({ data: {
        id: taskId,
        taskType: TAGGING_AUTO_CLASSIFY_TASK_TYPE,
        operationScopeHash: fingerprint({ lifecycle: input.lifecycle, novelIds: eligible.map((snapshot) => snapshot.novelId) }),
        mode,
        status: "pending",
        requestToken,
        totalCount: itemRows.length,
        params: {
          schemaVersion: 1,
          lifecycle: input.lifecycle,
          scope: scopeSnapshot(input.scope),
          authority,
          requestFingerprint,
          payloadFingerprint,
        },
        items: { createMany: { data: itemRows } },
      } });
      await tx.operationAudit.create({ data: {
        actorType: "operator",
        action: "tag.auto_classify.queued",
        entityType: "GenericTask",
        entityId: taskId,
        requestId: input.requestId,
        taskType: TAGGING_AUTO_CLASSIFY_TASK_TYPE,
        taskId,
        afterSnapshot: { lifecycle: input.lifecycle, mode, scope: scopeSnapshot(input.scope), eligibleCount: itemRows.length, payloadFingerprint },
      } });
    });
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    const prior = await input.db.genericTask.findUnique({ where: { requestToken } });
    if (!prior) throw error;
    const params = prior.params as Record<string, unknown>;
    if (params.requestFingerprint !== requestFingerprint) throw new TaggingError("IDEMPOTENCY_CONFLICT");
    return { status: "duplicate", taskId: prior.id, eligibleCount: prior.totalCount };
  }
  return { status: "enqueued", taskId, taskStatus: "pending", eligibleCount: itemRows.length };
}

export interface InitializeNovelTagSnapshotDependencies extends AutoClassificationDependencies {
  db: PrismaClient;
  env?: NodeJS.ProcessEnv;
}

export async function initializeNovelTagSnapshot(
  novelId: string,
  dependencies: InitializeNovelTagSnapshotDependencies,
): Promise<TaggingTaskCreationResult> {
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
