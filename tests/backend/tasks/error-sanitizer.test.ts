import { describe, expect, it } from "vitest";
import {
  PERSISTED_TASK_ERROR_MESSAGE_MAX_LENGTH,
  sanitizePersistedTaskError,
} from "@/lib/tasks";

describe("P1-07R persisted task error boundary", () => {
  it.each([
    new Error("Authorization: Bearer abc-secret"),
    "JWT eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.signature-secret",
    { code: "UPSTREAM_FAILURE", message: "api_key=abc-secret password=abc-secret" },
    { message: "cookie: session=abc-secret token abc-secret credential=abc-secret" },
    { message: "postgresql://worker:abc-secret@db.invalid/tasks" },
  ])("redacts common secret patterns from %j", (error) => {
    const safe = sanitizePersistedTaskError(error);
    expect(JSON.stringify(safe)).not.toContain("abc-secret");
    expect(safe.message).toContain("[REDACTED]");
    expect(Object.keys(safe).sort()).toEqual(["code", "message"]);
  });

  it("bounds messages after redaction and never persists stack or cause", () => {
    const error = new Error(`password=abc-secret ${"x".repeat(4_096)}`);
    Object.assign(error, { cause: { responseBody: "private" } });
    const safe = sanitizePersistedTaskError(error);
    expect(safe.message.length).toBeLessThanOrEqual(PERSISTED_TASK_ERROR_MESSAGE_MAX_LENGTH);
    expect(JSON.stringify(safe)).not.toContain("abc-secret");
    expect(safe).not.toHaveProperty("stack");
    expect(safe).not.toHaveProperty("cause");
  });

  it("maps string and unknown object throws to a stable safe shape", () => {
    expect(sanitizePersistedTaskError("token abc-secret")).toEqual({
      code: "handler_failed",
      message: "token [REDACTED]",
    });
    expect(sanitizePersistedTaskError({ arbitrary: "abc-secret", stack: "private" })).toEqual({
      code: "handler_failed",
      message: "Task handler failed",
    });
  });

  it("does not persist raw database connection failures", () => {
    const error = Object.assign(
      new Error("Database connection failed at postgresql://worker:abc-secret@db.invalid/tasks"),
      { code: "P1001" },
    );
    expect(sanitizePersistedTaskError(error)).toEqual({
      code: "p1001",
      message: "Task handler failed",
    });
  });

  // C-10 (Phase E rework, 2026-09-07): `detail` is a narrow, opt-in escape
  // hatch for a handler to persist a few structured, non-secret diagnostic
  // primitives (e.g. `worker/handlers/moboreader.ts`'s adapter code/HTTP
  // status/retryable flag/page index) alongside the redacted `message`.
  describe("detail passthrough", () => {
    it("passes through primitive detail fields, omitting the key entirely when there is none", () => {
      const withDetail = sanitizePersistedTaskError({
        code: "upstream_error",
        message: "MoboReader catalog read failed: upstream_http_error (HTTP 401) at page 1",
        detail: { adapterCode: "upstream_http_error", httpStatus: 401, retryable: false, pageIndex: 1 },
      });
      expect(withDetail.detail).toEqual({
        adapterCode: "upstream_http_error", httpStatus: 401, retryable: false, pageIndex: 1,
      });

      const withoutDetail = sanitizePersistedTaskError({ code: "upstream_error", message: "no detail here" });
      expect(withoutDetail).not.toHaveProperty("detail");
      expect(Object.keys(withoutDetail).sort()).toEqual(["code", "message"]);
    });

    it("redacts secret-shaped string values inside detail, same as message", () => {
      const safe = sanitizePersistedTaskError({
        code: "upstream_error",
        message: "ok",
        detail: { note: "Authorization: Bearer abc-secret" },
      });
      expect(JSON.stringify(safe)).not.toContain("abc-secret");
      expect(safe.detail?.note).toContain("[REDACTED]");
    });

    it("drops non-primitive detail values (nested object/array) instead of persisting them", () => {
      const safe = sanitizePersistedTaskError({
        code: "upstream_error",
        message: "ok",
        detail: {
          httpStatus: 401,
          upstreamBody: { secret: "abc-secret" },
          headers: ["Authorization: Bearer abc-secret"],
        },
      });
      expect(safe.detail).toEqual({ httpStatus: 401 });
      expect(JSON.stringify(safe)).not.toContain("abc-secret");
    });

    it("caps the number of detail keys", () => {
      const manyKeys = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`k${i}`, i]));
      const safe = sanitizePersistedTaskError({ code: "upstream_error", message: "ok", detail: manyKeys });
      expect(Object.keys(safe.detail ?? {}).length).toBeLessThanOrEqual(8);
    });

    it("ignores a non-object detail value (string/array/null) without throwing", () => {
      expect(sanitizePersistedTaskError({ code: "c", message: "m", detail: "not-an-object" })).not.toHaveProperty("detail");
      expect(sanitizePersistedTaskError({ code: "c", message: "m", detail: ["a", "b"] })).not.toHaveProperty("detail");
      expect(sanitizePersistedTaskError({ code: "c", message: "m", detail: null })).not.toHaveProperty("detail");
    });
  });
});
