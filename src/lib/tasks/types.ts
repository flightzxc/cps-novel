import type { Prisma } from "@prisma/client";

/**
 * Phase C (`施工工单_PhaseC_任务模型迁移与ImportProgress_2026-09-06.md`):
 * `TASK_ARCHITECTURE_DECISION = MIGRATE_TO_CPS_TASK_MODEL` folded
 * `CatalogScanTask`/`CatalogScanTaskItem` into `GenericTask`/`GenericTaskItem`
 * (`taskType = "catalog_scan"`, item `targetType = "catalog_page"`).
 * `"catalog_scan"` is no longer a physical family — it is one `taskType`
 * value among many under the `"generic"` family, exactly like every other
 * GenericTask taskType.
 */
export const TASK_FAMILIES = ["channel_sync", "generic"] as const;

export type TaskFamily = (typeof TASK_FAMILIES)[number];

/** Optional narrowing of pending candidates; never a lease or gate override. */
export interface TaskClaimTarget {
  family: TaskFamily;
  taskId: string;
  itemId: string;
}
export type TaskMode = "dry_run" | "apply";
export type TerminalItemStatus = "success" | "skipped" | "failed";

export interface TaskLease {
  family: TaskFamily;
  taskType: string;
  mode: TaskMode;
  itemId: string;
  taskId: string;
  workerId: string;
  executionToken: string;
  leaseEpoch: bigint;
  attemptCount: number;
  lockedUntil: Date;
  payload: unknown;
}

export interface ProtectedWriteResult {
  status: TerminalItemStatus;
  result?: unknown;
  error?: unknown;
}

export type ProtectedWrite = (
  transaction: Prisma.TransactionClient,
) => Promise<void | ProtectedWriteResult>;

export interface TaskOutcome {
  status: TerminalItemStatus;
  result?: unknown;
  error?: unknown;
  protectedWrite?: ProtectedWrite;
}

export interface TaskHandlerContext {
  lease: TaskLease;
  mode: TaskMode;
  signal: AbortSignal;
  heartbeat: () => Promise<boolean>;
}

export type TaskHandler = (context: TaskHandlerContext) => Promise<TaskOutcome>;

export interface TaskHandlerRegistration {
  family: TaskFamily;
  handler: TaskHandler;
  maxAttempts?: number;
}

export type TaskHandlerRegistry = Readonly<Record<string, TaskHandlerRegistration>>;

export interface WorkerAllowlistConfig {
  requested: string[];
  effective: string[];
  invalid: string[];
  willConsume: boolean;
}

export type ParentTaskStatus =
  | "processing"
  | "completed"
  | "completed_with_errors"
  | "failed";

export interface TaskItemCounts {
  pending: number;
  processing: number;
  success: number;
  failed: number;
  skipped: number;
}

export interface RecoveryResult {
  family: TaskFamily;
  taskType: string;
  itemId: string;
  taskId: string;
  action: "requeued" | "failed";
  attemptCount: number;
  leaseEpoch: bigint;
}
