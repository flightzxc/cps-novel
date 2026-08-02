import { describe, expect, it } from "vitest";
import {
  UnregisteredTaskTypeError,
  buildWorkerAllowlist,
  createHandlerRegistry,
  requireHandler,
} from "@/lib/tasks";

const noop = async () => ({ status: "success" as const });

describe("P1-07 handler registry guardrails", () => {
  const handlers = createHandlerRegistry({
    alpha: { family: "generic", handler: noop },
    catalog_scan: { family: "catalog_scan", handler: noop },
  });

  it("consumes only allowlist intersect handlers", () => {
    expect(buildWorkerAllowlist("alpha unknown alpha", handlers)).toEqual({
      requested: ["alpha", "unknown"],
      effective: ["alpha"],
      invalid: ["unknown"],
      willConsume: true,
    });
  });

  it("treats an empty allowlist as zero consumption", () => {
    expect(buildWorkerAllowlist("", handlers)).toEqual({
      requested: [],
      effective: [],
      invalid: [],
      willConsume: false,
    });
  });

  it("fails explicitly for an unregistered task type", () => {
    expect(() => requireHandler(handlers, "missing")).toThrow(UnregisteredTaskTypeError);
  });
});
