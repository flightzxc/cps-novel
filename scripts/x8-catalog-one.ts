/** Operator entry point: consume exactly one fixed Path-A catalog page. */
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { PrismaClient } from "@prisma/client";

import { createMoboreaderReadAdapter } from "../src/lib/adapters/moboreader";
import { isNovelCatalogSyncEnabled, isNovelCatalogSyncWriteAllowed } from "../src/lib/flags";
import {
  buildWorkerAllowlist,
  createHandlerRegistry,
  MOBOREADER_TASK_TYPES,
  validateTaskClaimTarget,
  type TaskHandlerRegistry,
} from "../src/lib/tasks";
import { createMoboreaderCatalogHandler } from "../worker/handlers/moboreader";
import { parseShutdownDrainTimeoutEnv, processOneWorkerCycle } from "../worker/runtime";

export const PATH_A_CATALOG_COORDINATES = Object.freeze({
  page: 1,
  pageSize: 20,
  projectType: 1,
  maxAttempts: 1,
});

export interface CatalogOneOptions {
  taskId: string;
  itemId: string;
  actor: string;
}

export interface CatalogOneResult {
  outcome: "blocked" | "not_consumed" | "success" | "failed" | "skipped";
  reason: string;
  attemptCount?: number;
  returnedCount?: number;
  promoCapture?: {
    fetched: number;
    deferredUntilLinked: number;
    incomplete: number;
    articlesBound: number;
    articlesConflicted: number;
  };
}

function validateOptions(options: CatalogOneOptions): void {
  validateTaskClaimTarget({ family: "catalog_scan", taskId: options.taskId, itemId: options.itemId });
  if (typeof options.actor !== "string" || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(options.actor)) {
    throw new Error("catalog_one_actor_invalid");
  }
}

export function parseCatalogOneArgs(argv: readonly string[]): CatalogOneOptions {
  const names = new Map([["--task-id", "taskId"], ["--item-id", "itemId"], ["--actor", "actor"]] as const);
  const parsed: Partial<CatalogOneOptions> = {};
  for (let i = 0; i < argv.length; i += 2) {
    const field = names.get(argv[i] as "--task-id" | "--item-id" | "--actor");
    if (!field || parsed[field] !== undefined || !argv[i + 1] || argv[i + 1].startsWith("--")) {
      throw new Error("catalog_one_arguments_invalid");
    }
    parsed[field] = argv[i + 1];
  }
  const options = { taskId: parsed.taskId ?? "", itemId: parsed.itemId ?? "", actor: parsed.actor ?? "" };
  validateOptions(options);
  return options;
}

function fixedRegistry(db: PrismaClient, env: NodeJS.ProcessEnv): TaskHandlerRegistry {
  const adapter = createMoboreaderReadAdapter({ maxAttempts: PATH_A_CATALOG_COORDINATES.maxAttempts });
  return createHandlerRegistry({
    [MOBOREADER_TASK_TYPES.catalogScan]: {
      family: "catalog_scan",
      maxAttempts: PATH_A_CATALOG_COORDINATES.maxAttempts,
      handler: createMoboreaderCatalogHandler(db, { adapter, env }),
    },
  });
}

function promoCapture(value: unknown): CatalogOneResult["promoCapture"] | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = (value as Record<string, unknown>).promoCapture;
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return undefined;
  const row = candidate as Record<string, unknown>;
  const fields = ["fetched", "deferredUntilLinked", "incomplete", "articlesBound", "articlesConflicted"] as const;
  if (fields.some((field) => !Number.isSafeInteger(row[field]) || (row[field] as number) < 0)) return undefined;
  return Object.freeze(Object.fromEntries(fields.map((field) => [field, row[field]]))) as CatalogOneResult["promoCapture"];
}

export async function runCatalogOne(
  db: PrismaClient,
  options: CatalogOneOptions,
  dependencies: {
    env?: NodeJS.ProcessEnv;
    signal?: AbortSignal;
    logger?: (event: Record<string, unknown>) => void;
    handlers?: TaskHandlerRegistry;
  } = {},
): Promise<CatalogOneResult> {
  validateOptions(options);
  const env = dependencies.env ?? process.env;
  const logger = dependencies.logger ?? ((event) => console.info(JSON.stringify(event)));
  const workerId = `catalog-one-${randomUUID()}`;
  const identity = {
    schemaVersion: 1,
    event: "catalog_one",
    trigger: "operator_cli",
    actor: options.actor,
    taskType: MOBOREADER_TASK_TYPES.catalogScan,
    taskId: options.taskId,
    itemId: options.itemId,
    workerId,
    ...PATH_A_CATALOG_COORDINATES,
  };
  const finish = (result: CatalogOneResult) => {
    logger({ ...identity, phase: "finished", ...result });
    return result;
  };
  logger({ ...identity, phase: "requested" });
  if (env.P1_12_COMPOSE_PROJECT !== "cps-novel-x8-local" || env.SITE_URL !== "https://novel.test") {
    return finish({ outcome: "blocked", reason: "local_topology_required" });
  }
  if (!isNovelCatalogSyncEnabled(env) || !isNovelCatalogSyncWriteAllowed(env)) {
    return finish({ outcome: "blocked", reason: "catalog_write_gates_closed" });
  }
  const handlers = dependencies.handlers ?? fixedRegistry(db, env);
  const allowlist = buildWorkerAllowlist(env.WORKER_TASK_ALLOWLIST, handlers);
  if (allowlist.invalid.length > 0 || allowlist.effective.length !== 1
    || allowlist.effective[0] !== MOBOREADER_TASK_TYPES.catalogScan) {
    return finish({ outcome: "blocked", reason: "catalog_only_allowlist_required" });
  }
  try {
    const [role] = await db.$queryRaw<Array<{ role: string }>>`SELECT current_user::text AS role`;
    if (role?.role !== "worker_app") return finish({ outcome: "blocked", reason: "worker_role_required" });
    const before = await db.catalogScanTaskItem.findUnique({
      where: { id: options.itemId },
      select: {
        taskId: true,
        pageIndex: true,
        status: true,
        task: { select: { mode: true, status: true, pageStart: true, pageEnd: true, pageSize: true, projectType: true } },
      },
    });
    if (!before || before.taskId !== options.taskId || before.status !== "pending"
      || before.pageIndex !== PATH_A_CATALOG_COORDINATES.page
      || before.task.mode !== "apply" || !["pending", "processing"].includes(before.task.status)
      || before.task.pageStart !== PATH_A_CATALOG_COORDINATES.page
      || before.task.pageEnd !== PATH_A_CATALOG_COORDINATES.page
      || before.task.pageSize !== PATH_A_CATALOG_COORDINATES.pageSize
      || before.task.projectType !== PATH_A_CATALOG_COORDINATES.projectType) {
      return finish({ outcome: "not_consumed", reason: "target_or_coordinates_not_eligible" });
    }
    await processOneWorkerCycle({
      prisma: db,
      workerId,
      handlers,
      allowlist,
      signal: dependencies.signal ?? new AbortController().signal,
      shutdownDrainTimeoutMs: parseShutdownDrainTimeoutEnv(env.WORKER_SHUTDOWN_DRAIN_TIMEOUT_MS),
      claimTarget: { family: "catalog_scan", taskId: options.taskId, itemId: options.itemId },
    });
    const after = await db.catalogScanTaskItem.findUnique({
      where: { id: options.itemId },
      select: { status: true, attemptCount: true, returnedCount: true, result: true },
    });
    const status = after?.status;
    if (!after || (status !== "success" && status !== "failed" && status !== "skipped")) {
      return finish({ outcome: "not_consumed", reason: "target_not_finalized" });
    }
    const committed = await db.operationAudit.findFirst({
      where: {
        actorType: "worker", actorId: workerId,
        action: `task_item.${status}`, entityType: "catalog_scan_task_item",
        entityId: options.itemId, taskId: options.taskId,
      },
      select: { id: true },
    });
    if (!committed) return finish({ outcome: "not_consumed", reason: "target_finalized_elsewhere" });
    if (after.attemptCount !== 1) return finish({ outcome: "failed", reason: "attempt_budget_violated" });
    return finish({
      outcome: status,
      reason: "target_terminal",
      attemptCount: after.attemptCount,
      returnedCount: after.returnedCount ?? undefined,
      promoCapture: promoCapture(after.result),
    });
  } catch {
    return finish({ outcome: "failed", reason: "catalog_one_execution_error" });
  }
}

async function main(): Promise<void> {
  const options = parseCatalogOneArgs(process.argv.slice(2));
  const db = new PrismaClient();
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    const result = await runCatalogOne(db, options, { signal: controller.signal });
    if (result.outcome !== "success") process.exitCode = 1;
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    await db.$disconnect();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    console.error(JSON.stringify({ event: "catalog_one", outcome: "blocked", reason: "catalog_one_startup_error" }));
    process.exitCode = 1;
  });
}
