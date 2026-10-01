/**
 * B-21 等价性与内存测量的"修改前"参照实现（oracle）。
 *
 * 这是 `createTaggingAutoClassifyTask` 在 6bc6a11（v0.5.6 收官提交）时的函数体，
 * 逐行保留"一次性把整个范围读进内存、一次性嵌套 createMany 写入"的老做法，
 * 只做两处机械改动：函数改名为 `legacyCreateTaggingAutoClassifyTask`；
 * 它依赖的几个私有小函数（requireInput 等）原样抄进来，不再从 tasks.ts 导入。
 *
 * 用途只有两个，都不是生产路径：
 *  1. tests/integration/tagging/task-creation-postgres.test.ts 用它在同一份造数上
 *     先跑"修改前"、再跑"修改后"，逐条比较任务行与条目集合；
 *  2. scripts/measure-tagging-task-creation-memory.ts 的 `--impl legacy`，
 *     用来复现并对比 B-21 的内存峰值。
 *
 * 不要把它接进任何运行时代码，也不要"顺手优化"它：它存在的意义就是保持老行为。
 */
import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";

import {
  isAutoTaggingEnabled,
  isAutoTagWriteAuthorized,
  isTaggingEnabled,
} from "@/lib/flags/feature-flags";
import { TaggingError } from "@/lib/tagging/contracts";
import { normalizeTaggingNovelIds } from "@/lib/tagging/novel-id-scope";
import { fingerprint } from "@/lib/tagging/stable-json";
import {
  TAGGING_ALL_APPLY_CONFIRMATION,
  TAGGING_AUTO_CLASSIFY_TASK_TYPE,
  type TaggingAutoClassifyTaskPayload,
} from "@/lib/tagging/task-contract";
import {
  readNovelClassificationSnapshots,
  resolveAutoClassificationAuthorities,
} from "@/server/tagging/auto-classification";
import {
  TAGGING_TASK_TRANSACTION_MAX_WAIT_MS,
  TAGGING_TASK_TRANSACTION_TIMEOUT_MS,
  type CreateTaggingAutoClassifyTaskInput,
  type TaggingTaskCreationResult,
  type TaggingTaskScope,
} from "@/server/tagging/tasks";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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

export async function legacyCreateTaggingAutoClassifyTask(
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
    }, { timeout: TAGGING_TASK_TRANSACTION_TIMEOUT_MS, maxWait: TAGGING_TASK_TRANSACTION_MAX_WAIT_MS });
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
