import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_WORKER_FAILURE_WEBHOOK_COOLDOWN_SECONDS,
  DEFAULT_WORKER_FAILURE_WEBHOOK_TIMEOUT_MS,
  WorkerFailureWebhookConfigError,
  createWorkerFailureWebhookReporter,
  createWorkerFailureWebhookReporterFromEnv,
  projectWorkerTaskFailureEvent,
  resolveWorkerFailureWebhookConfig,
  serializeWorkerTaskFailureEvent,
  workerFailureCooldownKey,
  type WorkerTaskFailureEvent,
} from "../../../worker/runtime";

const EVENT: WorkerTaskFailureEvent = {
  family: "generic",
  taskType: "promo_link.claim.v1",
  taskId: "task-1",
  itemId: "item-1",
  workerId: "worker-1",
  errorKind: "upstream_failed",
  attempt: 2,
  source: "handler",
  occurredAt: "2026-08-26T00:00:00.000Z",
};

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("X10 worker failure event contract", () => {
  it("projects exactly the frozen non-sensitive schema", () => {
    const polluted = {
      ...EVENT,
      message: "Bearer secret",
      stack: "private stack",
      payload: { token: "secret" },
      url: "https://secret.example/hook?token=secret",
      credential: "secret",
    } as WorkerTaskFailureEvent;
    const projected = projectWorkerTaskFailureEvent(polluted);
    expect(Object.keys(projected)).toEqual([
      "family",
      "taskType",
      "taskId",
      "itemId",
      "workerId",
      "errorKind",
      "attempt",
      "source",
      "occurredAt",
    ]);
    expect(serializeWorkerTaskFailureEvent(polluted)).not.toMatch(/secret|message|stack|payload|url|credential/i);
  });

  it("uses exactly source|family|taskType|errorKind as the cooldown key", () => {
    expect(workerFailureCooldownKey(EVENT)).toBe(
      "handler|generic|promo_link.claim.v1|upstream_failed",
    );
  });
});

describe("X10 worker failure webhook configuration", () => {
  it("uses the frozen timeout/cooldown defaults and no reporter without a URL", () => {
    expect(resolveWorkerFailureWebhookConfig({} as NodeJS.ProcessEnv)).toEqual({
      webhookUrl: null,
      timeoutMs: DEFAULT_WORKER_FAILURE_WEBHOOK_TIMEOUT_MS,
      cooldownSeconds: DEFAULT_WORKER_FAILURE_WEBHOOK_COOLDOWN_SECONDS,
    });
    expect(createWorkerFailureWebhookReporterFromEnv({} as NodeJS.ProcessEnv)).toBeUndefined();
  });

  it.each([
    ["WORKER_FAILURE_WEBHOOK_TIMEOUT_MS", ""],
    ["WORKER_FAILURE_WEBHOOK_TIMEOUT_MS", "0"],
    ["WORKER_FAILURE_WEBHOOK_TIMEOUT_MS", "1.5"],
    ["WORKER_FAILURE_WEBHOOK_TIMEOUT_MS", "60001"],
    ["WORKER_FAILURE_WEBHOOK_COOLDOWN_SECONDS", ""],
    ["WORKER_FAILURE_WEBHOOK_COOLDOWN_SECONDS", "0"],
    ["WORKER_FAILURE_WEBHOOK_COOLDOWN_SECONDS", "1e3"],
    ["WORKER_FAILURE_WEBHOOK_COOLDOWN_SECONDS", "604801"],
    ["WORKER_FAILURE_WEBHOOK_URL", "not-a-url"],
    ["WORKER_FAILURE_WEBHOOK_URL", "file:///tmp/hook"],
    ["WORKER_FAILURE_WEBHOOK_URL", "https://user:password@example.test/hook"],
  ])("fails startup for invalid configured %s", (variable, value) => {
    const secretValue = `${value}-must-not-leak`;
    const env = { [variable]: variable === "WORKER_FAILURE_WEBHOOK_URL" ? secretValue : value };
    try {
      resolveWorkerFailureWebhookConfig(env as NodeJS.ProcessEnv);
      throw new Error("expected config rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(WorkerFailureWebhookConfigError);
      expect(String(error)).not.toContain(secretValue);
    }
  });
});

describe("X10 worker failure webhook delivery", () => {
  function reporter(fetchImpl: typeof fetch, nowMs: () => number = () => 0) {
    return createWorkerFailureWebhookReporter({
      webhookUrl: new URL("https://hooks.example.test/private?token=must-not-log"),
      timeoutMs: 5_000,
      cooldownSeconds: 1_800,
    }, { fetchImpl, nowMs })!;
  }

  it("advances cooldown only after 2xx and sends only the projected event", async () => {
    let now = 0;
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValue(new Response(null, { status: 204 })) as unknown as typeof fetch;
    const hook = reporter(fetchImpl, () => now);

    await hook.onTaskFailure(EVENT);
    await hook.onTaskFailure(EVENT);
    await hook.onTaskFailure(EVENT);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const init = vi.mocked(fetchImpl).mock.calls[1][1];
    expect(init?.body).toBe(JSON.stringify(EVENT));

    now = 1_800_000;
    await hook.onTaskFailure(EVENT);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("retries on the next event after network failure without throwing", async () => {
    const fetchImpl = vi.fn()
      .mockRejectedValueOnce(new Error("network failed at https://secret.example/hook"))
      .mockResolvedValueOnce(new Response(null, { status: 200 })) as unknown as typeof fetch;
    const hook = reporter(fetchImpl);
    await expect(hook.onTaskFailure(EVENT)).resolves.toBeUndefined();
    await expect(hook.onTaskFailure(EVENT)).resolves.toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("times out safely and retries the following event", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn((_: string | URL | Request, init?: RequestInit) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    })) as unknown as typeof fetch;
    const hook = reporter(fetchImpl);
    const timedOut = hook.onTaskFailure(EVENT);
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(timedOut).resolves.toBeUndefined();

    vi.mocked(fetchImpl).mockResolvedValueOnce(new Response(null, { status: 200 }));
    await hook.onTaskFailure(EVENT);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("isolates cooldown by the exact four-field key", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 200 })) as unknown as typeof fetch;
    const hook = reporter(fetchImpl);
    await hook.onTaskFailure(EVENT);
    await hook.onTaskFailure({ ...EVENT, source: "lease_recovery" });
    await hook.onTaskFailure({ ...EVENT, family: "channel_sync" });
    await hook.onTaskFailure({ ...EVENT, taskType: "catalog_scan" });
    await hook.onTaskFailure({ ...EVENT, errorKind: "stale_processing" });
    expect(fetchImpl).toHaveBeenCalledTimes(5);
  });

  it("accepts a duplicate after process-local cooldown state is restarted", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 200 })) as unknown as typeof fetch;
    const firstProcess = reporter(fetchImpl);
    await firstProcess.onTaskFailure(EVENT);
    await firstProcess.onTaskFailure(EVENT);

    const restartedProcess = reporter(fetchImpl);
    await restartedProcess.onTaskFailure(EVENT);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
