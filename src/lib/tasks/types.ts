import type { Prisma } from "@prisma/client";

export const TASK_FAMILIES = ["catalog_scan", "channel_sync", "generic"] as const;

export type TaskFamily = (typeof TASK_FAMILIES)[number];
export type TerminalItemStatus = "success" | "skipped" | "failed";

export interface TaskLease {
  family: TaskFamily;
  taskType: string;
  itemId: string;
  taskId: string;
  workerId: string;
  executionToken: string;
  leaseEpoch: bigint;
  attemptCount: number;
  lockedUntil: Date;
  payload: unknown;
}

export type ProtectedWrite = (transaction: Prisma.TransactionClient) => Promise<void>;

export interface TaskOutcome {
  status: TerminalItemStatus;
  result?: unknown;
  error?: unknown;
  protectedWrite?: ProtectedWrite;
}

export interface TaskHandlerContext {
  lease: TaskLease;
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
  itemId: string;
  taskId: string;
  action: "requeued" | "failed";
  attemptCount: number;
  leaseEpoch: bigint;
}
