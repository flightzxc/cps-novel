import type { Prisma, PrismaClient } from "@prisma/client";

import {
  isAutoTaggingEnabled,
  isAutoTagWriteAuthorized,
  isTaggingEnabled,
} from "../../src/lib/flags/feature-flags";
import { TaggingError } from "../../src/lib/tagging/contracts";
import {
  parseTaggingAutoClassifyTaskPayload,
  TAGGING_AUTO_CLASSIFY_TASK_TYPE,
  type TaggingAutoClassifyTaskPayload,
} from "../../src/lib/tagging/task-contract";
import { createHandlerRegistry, type ProtectedWriteResult, type TaskHandler } from "../../src/lib/tasks";
import {
  classifyNovelForAuto,
  type AutoClassificationDependencies,
  type NovelAutoClassification,
} from "../../src/server/tagging/auto-classification";
import { replaceAutoTagSnapshotInTransaction } from "../../src/server/tagging/service";

export interface TaggingWorkerDependencies extends AutoClassificationDependencies {
  env?: NodeJS.ProcessEnv;
}

function staleReason(
  payload: TaggingAutoClassifyTaskPayload,
  classification: NovelAutoClassification,
): string | null {
  if (classification.snapshot.contentSha256 !== payload.expectedContentSha256) return "content_changed";
  if (classification.snapshot.entityFingerprint !== payload.expectedEntityFingerprint) return "entity_changed";
  if (
    classification.artifact.taxonomyVersion !== payload.taxonomyVersion
    || classification.artifact.taxonomySha256 !== payload.taxonomySha256
    || classification.artifact.keywordLexiconVersion !== payload.keywordLexiconVersion
    || classification.artifact.keywordFingerprint !== payload.keywordFingerprint
    || classification.config.version !== payload.classifierConfigVersion
    || classification.config.fingerprint !== payload.classifierConfigFingerprint
  ) return "authority_changed";
  return null;
}

function resultSummary(classification: NovelAutoClassification) {
  return {
    contentSha256: classification.snapshot.contentSha256,
    entityFingerprint: classification.snapshot.entityFingerprint,
    rawEligibleCount: classification.result.rawEligibleCount,
    selectedCount: classification.result.selectedCount,
    truncatedCount: classification.result.truncatedCount,
    tags: classification.result.candidates.map((candidate) => ({
      canonicalTagId: candidate.canonicalTagId,
      score: candidate.score,
    })),
  };
}

function gateFailure(mode: "dry_run" | "apply", env: NodeJS.ProcessEnv): TaggingError | null {
  if (!isTaggingEnabled(env)) return new TaggingError("TAGGING_DISABLED");
  if (mode === "apply" && !isAutoTaggingEnabled(env)) return new TaggingError("TAGGING_DISABLED");
  if (mode === "apply" && !isAutoTagWriteAuthorized(env)) return new TaggingError("AUTO_WRITE_NOT_AUTHORIZED");
  return null;
}

function failed(error: TaggingError): ProtectedWriteResult {
  return { status: "failed", error: { code: error.code, message: error.message } };
}

export function createNovelTagBackfillHandler(
  db: PrismaClient,
  dependencies: TaggingWorkerDependencies = {},
): TaskHandler {
  return async ({ lease, mode }) => {
    const payload = parseTaggingAutoClassifyTaskPayload(lease.payload);
    const env = dependencies.env ?? process.env;
    const preGate = gateFailure(mode, env);
    if (preGate) return failed(preGate);
    const classification = await classifyNovelForAuto(db, payload.novelId, dependencies);
    if (classification.snapshot.mode === "manual") {
      return { status: "skipped", result: { code: "manual_mode" } };
    }
    if (payload.lifecycle === "initialize_missing" && classification.snapshot.currentAutoRunId !== null) {
      return { status: "skipped", result: { code: "already_initialized" } };
    }
    const stale = staleReason(payload, classification);
    if (stale) return { status: "skipped", result: { code: stale } };
    const preview = resultSummary(classification);
    if (mode === "dry_run") return { status: "success", result: { code: "dry_run", ...preview } };

    return {
      status: "success",
      result: { code: "apply_pending", ...preview },
      protectedWrite: async (tx: Prisma.TransactionClient): Promise<ProtectedWriteResult> => {
        const writeGate = gateFailure("apply", dependencies.env ?? process.env);
        if (writeGate) return failed(writeGate);
        const current = await classifyNovelForAuto(tx, payload.novelId, dependencies);
        if (current.snapshot.mode === "manual") return { status: "skipped", result: { code: "manual_mode" } };
        if (payload.lifecycle === "initialize_missing" && current.snapshot.currentAutoRunId !== null) {
          return { status: "skipped", result: { code: "already_initialized" } };
        }
        const currentStale = staleReason(payload, current);
        if (currentStale) return { status: "skipped", result: { code: currentStale } };
        const mutation = await replaceAutoTagSnapshotInTransaction(tx, {
          novelId: payload.novelId,
          tags: current.result.candidates,
          runMetadata: {
            ...current.runMetadata,
            taskType: lease.taskType,
            taskId: lease.taskId,
          },
          contentSha: current.snapshot.contentSha256,
          requestId: payload.classificationRequestId,
        });
        if (mutation.skipped) return { status: "skipped", result: { code: "manual_mode" } };
        return {
          status: "success",
          result: {
            code: mutation.replayed ? "replayed" : "applied",
            ...resultSummary(current),
            currentAutoRunId: mutation.currentAutoRunId,
          },
        };
      },
    };
  };
}

export function createTaggingWorkerHandlers(
  db: PrismaClient,
  dependencies: TaggingWorkerDependencies = {},
) {
  return createHandlerRegistry({
    [TAGGING_AUTO_CLASSIFY_TASK_TYPE]: {
      family: "generic",
      maxAttempts: 3,
      handler: createNovelTagBackfillHandler(db, dependencies),
    },
  });
}

