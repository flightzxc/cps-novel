import type { TaskFamily } from "../../src/lib/tasks";

export const DEFAULT_WORKER_FAILURE_WEBHOOK_TIMEOUT_MS = 5_000;
export const MAX_WORKER_FAILURE_WEBHOOK_TIMEOUT_MS = 60_000;
export const DEFAULT_WORKER_FAILURE_WEBHOOK_COOLDOWN_SECONDS = 1_800;
export const MAX_WORKER_FAILURE_WEBHOOK_COOLDOWN_SECONDS = 7 * 24 * 60 * 60;

/**
 * D-7 (`施工工单_PhaseE返工2_坏页不崩worker与免费书归一_2026-09-07.md`) adds
 * `"finalize"`: a `finalizeTaskItem` write transaction itself failing (as
 * opposed to `"handler"`, the task handler's own reported outcome, or
 * `"lease_recovery"`, an expired-lease sweep).
 */
export type WorkerTaskFailureSource = "handler" | "lease_recovery" | "finalize";

export interface WorkerTaskFailureEvent {
  family: TaskFamily;
  taskType: string;
  taskId: string;
  itemId: string;
  workerId: string;
  errorKind: string;
  attempt: number;
  source: WorkerTaskFailureSource;
  occurredAt: string;
}

export interface WorkerTaskFailureReporter {
  onTaskFailure(event: WorkerTaskFailureEvent): Promise<void> | void;
}

export interface WorkerFailureWebhookConfig {
  webhookUrl: URL | null;
  timeoutMs: number;
  cooldownSeconds: number;
}

export interface WorkerFailureWebhookDependencies {
  fetchImpl?: typeof fetch;
  nowMs?: () => number;
}

export class WorkerFailureWebhookConfigError extends Error {
  readonly code = "WORKER_FAILURE_WEBHOOK_CONFIG_INVALID";

  constructor(readonly variable: string) {
    super(`${variable} is invalid`);
    this.name = "WorkerFailureWebhookConfigError";
  }
}

function parsePositiveInteger(
  raw: string | undefined,
  fallback: number,
  maximum: number,
  variable: string,
): number {
  if (raw === undefined) return fallback;
  if (!/^[1-9]\d*$/.test(raw)) throw new WorkerFailureWebhookConfigError(variable);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value > maximum) {
    throw new WorkerFailureWebhookConfigError(variable);
  }
  return value;
}

function parseWebhookUrl(raw: string | undefined): URL | null {
  if (raw === undefined || raw.trim() === "") return null;
  try {
    const url = new URL(raw);
    if (
      (url.protocol !== "https:" && url.protocol !== "http:")
      || url.username !== ""
      || url.password !== ""
    ) {
      throw new Error("unsupported webhook URL");
    }
    return url;
  } catch {
    throw new WorkerFailureWebhookConfigError("WORKER_FAILURE_WEBHOOK_URL");
  }
}

export function resolveWorkerFailureWebhookConfig(
  env: NodeJS.ProcessEnv = process.env,
): WorkerFailureWebhookConfig {
  return {
    webhookUrl: parseWebhookUrl(env.WORKER_FAILURE_WEBHOOK_URL),
    timeoutMs: parsePositiveInteger(
      env.WORKER_FAILURE_WEBHOOK_TIMEOUT_MS,
      DEFAULT_WORKER_FAILURE_WEBHOOK_TIMEOUT_MS,
      MAX_WORKER_FAILURE_WEBHOOK_TIMEOUT_MS,
      "WORKER_FAILURE_WEBHOOK_TIMEOUT_MS",
    ),
    cooldownSeconds: parsePositiveInteger(
      env.WORKER_FAILURE_WEBHOOK_COOLDOWN_SECONDS,
      DEFAULT_WORKER_FAILURE_WEBHOOK_COOLDOWN_SECONDS,
      MAX_WORKER_FAILURE_WEBHOOK_COOLDOWN_SECONDS,
      "WORKER_FAILURE_WEBHOOK_COOLDOWN_SECONDS",
    ),
  };
}

/** Project an event onto the frozen public schema before either log or HTTP IO. */
export function projectWorkerTaskFailureEvent(
  event: WorkerTaskFailureEvent,
): WorkerTaskFailureEvent {
  return {
    family: event.family,
    taskType: event.taskType,
    taskId: event.taskId,
    itemId: event.itemId,
    workerId: event.workerId,
    errorKind: event.errorKind,
    attempt: event.attempt,
    source: event.source,
    occurredAt: event.occurredAt,
  };
}

export function serializeWorkerTaskFailureEvent(event: WorkerTaskFailureEvent): string {
  return JSON.stringify(projectWorkerTaskFailureEvent(event));
}

export function workerFailureCooldownKey(event: WorkerTaskFailureEvent): string {
  return [event.source, event.family, event.taskType, event.errorKind].join("|");
}

/**
 * Best-effort webhook delivery with process-local cooldown. A delivery error
 * is deliberately swallowed: the durable task row/Audit and stderr event are
 * the facts; the webhook is only an auxiliary notification channel.
 */
export function createWorkerFailureWebhookReporter(
  config: WorkerFailureWebhookConfig,
  dependencies: WorkerFailureWebhookDependencies = {},
): WorkerTaskFailureReporter | undefined {
  if (!config.webhookUrl) return undefined;
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const nowMs = dependencies.nowMs ?? Date.now;
  const successfulAt = new Map<string, number>();
  const pending = new Map<string, Promise<void>>();
  const cooldownMs = config.cooldownSeconds * 1_000;

  const deliver = async (event: WorkerTaskFailureEvent): Promise<void> => {
    const key = workerFailureCooldownKey(event);
    const previous = pending.get(key);
    if (previous) await previous;
    const lastSuccess = successfulAt.get(key);
    if (lastSuccess !== undefined && nowMs() - lastSuccess < cooldownMs) return;

    const request = (async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
      try {
        const response = await fetchImpl(config.webhookUrl!.toString(), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: serializeWorkerTaskFailureEvent(event),
          signal: controller.signal,
        });
        if (response.status >= 200 && response.status < 300) {
          successfulAt.set(key, nowMs());
        }
      } catch {
        // The next event for this key retries because no cooldown is recorded.
      } finally {
        clearTimeout(timeout);
      }
    })();
    pending.set(key, request);
    try {
      await request;
    } finally {
      if (pending.get(key) === request) pending.delete(key);
    }
  };

  return { onTaskFailure: deliver };
}

export function createWorkerFailureWebhookReporterFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  dependencies: WorkerFailureWebhookDependencies = {},
): WorkerTaskFailureReporter | undefined {
  return createWorkerFailureWebhookReporter(
    resolveWorkerFailureWebhookConfig(env),
    dependencies,
  );
}
