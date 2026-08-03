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
});
