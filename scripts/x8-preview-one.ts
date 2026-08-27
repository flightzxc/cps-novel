/** Operator entry point: one targeted preview through the ordinary worker lifecycle. */
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { isNovelCatalogSyncEnabled, isNovelCatalogSyncWriteAllowed } from "../src/lib/flags";
import {
  buildWorkerAllowlist,
  MOBOREADER_TASK_TYPES,
  validateTaskClaimTarget,
  type TaskHandlerRegistry,
} from "../src/lib/tasks";
import { createWorkerHandlers } from "../worker";
import { parseShutdownDrainTimeoutEnv, processOneWorkerCycle } from "../worker/runtime";

export interface PreviewOneOptions {
  taskId: string;
  itemId: string;
  actor: string;
}

export interface PreviewOneResult {
  outcome: "blocked" | "not_consumed" | "success" | "failed" | "skipped";
  reason: string;
  attemptCount?: number;
}

function validateOptions(options: PreviewOneOptions): void {
  validateTaskClaimTarget({ family: "channel_sync", taskId: options.taskId, itemId: options.itemId });
  // An operator handle, not free-form text or a credential-bearing audit blob.
  if (typeof options.actor !== "string" || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(options.actor)) {
    throw new Error("preview_one_actor_invalid");
  }
}

export function parsePreviewOneArgs(argv: readonly string[]): PreviewOneOptions {
  const names = new Map([["--task-id", "taskId"], ["--item-id", "itemId"], ["--actor", "actor"]] as const);
  const parsed: Partial<PreviewOneOptions> = {};
  for (let i = 0; i < argv.length; i += 2) {
    const field = names.get(argv[i] as "--task-id" | "--item-id" | "--actor");
    if (!field || parsed[field] !== undefined || !argv[i + 1] || argv[i + 1].startsWith("--")) {
      throw new Error("preview_one_arguments_invalid");
    }
    parsed[field] = argv[i + 1];
  }
  const options = { taskId: parsed.taskId ?? "", itemId: parsed.itemId ?? "", actor: parsed.actor ?? "" };
  validateOptions(options);
  return options;
}

export async function runPreviewOne(
  db: PrismaClient,
  options: PreviewOneOptions,
  dependencies: {
    env?: NodeJS.ProcessEnv;
    signal?: AbortSignal;
    logger?: (event: Record<string, unknown>) => void;
    /** Test injection only; the CLI always builds the production registry. */
    handlers?: TaskHandlerRegistry;
  } = {},
): Promise<PreviewOneResult> {
  validateOptions(options);
  const env = dependencies.env ?? process.env;
  const logger = dependencies.logger ?? ((event) => console.info(JSON.stringify(event)));
  const workerId = `preview-one-${randomUUID()}`;
  const identity = {
    schemaVersion: 1,
    event: "preview_one",
    trigger: "operator_cli",
    actor: options.actor,
    taskType: MOBOREADER_TASK_TYPES.previewRefresh,
    taskId: options.taskId,
    itemId: options.itemId,
    workerId,
  };
  const finish = (result: PreviewOneResult) => {
    logger({ ...identity, phase: "finished", ...result });
    return result;
  };
  logger({ ...identity, phase: "requested" });
  if (env.P1_12_COMPOSE_PROJECT !== "cps-novel-x8-local" || env.SITE_URL !== "https://novel.test") {
    return finish({ outcome: "blocked", reason: "local_topology_required" });
  }
  if (!isNovelCatalogSyncEnabled(env) || !isNovelCatalogSyncWriteAllowed(env)) {
    return finish({ outcome: "blocked", reason: "preview_write_gates_closed" });
  }
  const handlers = dependencies.handlers ?? createWorkerHandlers(db);
  const allowlist = buildWorkerAllowlist(env.WORKER_TASK_ALLOWLIST, handlers);
  if (allowlist.invalid.length > 0 || allowlist.effective.length !== 1
    || allowlist.effective[0] !== MOBOREADER_TASK_TYPES.previewRefresh) {
    return finish({ outcome: "blocked", reason: "preview_only_allowlist_required" });
  }
  try {
    const [role] = await db.$queryRaw<Array<{ role: string }>>`SELECT current_user::text AS role`;
    if (role?.role !== "worker_app") return finish({ outcome: "blocked", reason: "worker_role_required" });
    const before = await db.channelSyncTaskItem.findUnique({
      where: { id: options.itemId },
      select: { taskId: true, status: true, task: { select: { taskType: true, status: true, mode: true } } },
    });
    if (!before || before.taskId !== options.taskId
      || before.task.taskType !== MOBOREADER_TASK_TYPES.previewRefresh
      || before.task.mode !== "apply" || before.status !== "pending"
      || !["pending", "processing"].includes(before.task.status)) {
      return finish({ outcome: "not_consumed", reason: "target_not_eligible" });
    }
    await processOneWorkerCycle({
      prisma: db,
      workerId,
      handlers,
      allowlist,
      signal: dependencies.signal ?? new AbortController().signal,
      shutdownDrainTimeoutMs: parseShutdownDrainTimeoutEnv(env.WORKER_SHUTDOWN_DRAIN_TIMEOUT_MS),
      claimTarget: { family: "channel_sync", taskId: options.taskId, itemId: options.itemId },
    });
    const after = await db.channelSyncTaskItem.findUnique({
      where: { id: options.itemId },
      select: { status: true, attemptCount: true },
    });
    const status = after?.status;
    if (!after || (status !== "success" && status !== "failed" && status !== "skipped")) {
      // A normal recovery cycle or a competing lease can take precedence.
      // Never loop or claim a different pending item to make the command succeed.
      return finish({ outcome: "not_consumed", reason: "target_not_finalized" });
    }
    const committed = await db.operationAudit.findFirst({
      where: {
        actorType: "worker", actorId: workerId,
        action: `task_item.${status}`, entityType: "channel_sync_task_item",
        entityId: options.itemId, taskId: options.taskId,
      },
      select: { id: true },
    });
    if (!committed) return finish({ outcome: "not_consumed", reason: "target_finalized_elsewhere" });
    return finish({ outcome: status, reason: "target_terminal", attemptCount: after.attemptCount });
  } catch {
    // Database URLs, payloads, upstream bodies and arbitrary exception text stay out of logs.
    return finish({ outcome: "failed", reason: "preview_one_execution_error" });
  }
}

async function main(): Promise<void> {
  const options = parsePreviewOneArgs(process.argv.slice(2));
  const db = new PrismaClient();
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    const result = await runPreviewOne(db, options, { signal: controller.signal });
    if (result.outcome !== "success") process.exitCode = 1;
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    await db.$disconnect();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    console.error(JSON.stringify({ event: "preview_one", outcome: "blocked", reason: "preview_one_startup_error" }));
    process.exitCode = 1;
  });
}
