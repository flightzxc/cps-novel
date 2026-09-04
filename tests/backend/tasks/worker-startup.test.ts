import type { PrismaClient } from "@prisma/client";
import { describe, expect, it } from "vitest";

import { createHandlerRegistry } from "@/lib/tasks";
import {
  createWorkerHandlers,
  resolveWorkerStartupAllowlist,
  WorkerStartupConfigurationError,
  type WorkerStartupLogger,
} from "../../../worker";

const noop = async () => ({ status: "success" as const });

function recordingLogger() {
  const info: string[] = [];
  const error: string[] = [];
  const logger: WorkerStartupLogger = {
    info: (message) => info.push(message),
    error: (message) => error.push(message),
  };
  return { logger, info, error };
}

describe("X1 worker startup allowlist", () => {
  const handlers = createHandlerRegistry({
    alpha: { family: "generic", handler: noop },
    beta: { family: "generic", handler: noop },
  });

  it.each([undefined, "", "  ,  "])("fails startup when the effective set is empty (%s)", (raw) => {
    const output = recordingLogger();
    expect(() => resolveWorkerStartupAllowlist(raw, handlers, output.logger)).toThrow(
      WorkerStartupConfigurationError,
    );
    expect(JSON.parse(output.info[0])).toMatchObject({
      event: "worker_task_allowlist",
      level: "info",
      requested: [],
      effective: [],
      invalid: [],
    });
  });

  it("prints requested/effective/invalid at error level for unknown task types", () => {
    const output = recordingLogger();
    expect(resolveWorkerStartupAllowlist("alpha typo beta", handlers, output.logger)).toMatchObject({
      requested: ["alpha", "typo", "beta"],
      effective: ["alpha", "beta"],
      invalid: ["typo"],
      willConsume: true,
    });
    expect(output.info).toEqual([]);
    expect(JSON.parse(output.error[0])).toEqual({
      schemaVersion: 1,
      event: "worker_task_allowlist",
      level: "error",
      requested: ["alpha", "typo", "beta"],
      effective: ["alpha", "beta"],
      invalid: ["typo"],
    });
  });

  it("prints the effective allowlist at info level when every task type is registered", () => {
    const output = recordingLogger();
    resolveWorkerStartupAllowlist("beta,alpha", handlers, output.logger);
    expect(output.error).toEqual([]);
    expect(JSON.parse(output.info[0])).toMatchObject({
      event: "worker_task_allowlist",
      level: "info",
      requested: ["beta", "alpha"],
      effective: ["beta", "alpha"],
      invalid: [],
    });
  });

  it("registers the governed executable handlers and keeps promo-link-binding as a library", () => {
    const registered = Object.keys(createWorkerHandlers({} as PrismaClient)).sort();
    expect(registered).toEqual([
      "catalog_scan",
      "credential.supersede.v1",
      "credential.validate.v1",
      "home_carousel.compute.v1",
      "indexnow_delivery",
      "moboreader.preview_refresh.v1",
      "promo_link.claim.v1",
      "sitemap_refresh",
      "tagging.auto_classify",
    ]);
    expect(registered).not.toContain("promo-link-binding");
  });
});
