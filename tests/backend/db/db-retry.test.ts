import { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import {
  isForeignKeyViolation,
  isSerializationFailure,
  isTransientDbError,
  isUniqueConstraintViolation,
  summarizeDbError,
  withDbRetry,
} from "@/lib/db/db-retry";

function prismaError(code: string, meta?: Record<string, unknown>): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError(`simulated ${code}`, {
    code,
    clientVersion: "6.19.2",
    ...(meta ? { meta } : {}),
  });
}

describe("isUniqueConstraintViolation", () => {
  it("is true for structured P2002", () => {
    expect(isUniqueConstraintViolation(prismaError("P2002"))).toBe(true);
  });

  it("is true for P2010 wrapping raw-SQL SQLSTATE 23505", () => {
    expect(isUniqueConstraintViolation(prismaError("P2010", { code: "23505" }))).toBe(true);
  });

  it("is false for P2010 wrapping an unrelated SQLSTATE", () => {
    expect(isUniqueConstraintViolation(prismaError("P2010", { code: "40001" }))).toBe(false);
  });

  it("is false for a plain Error", () => {
    expect(isUniqueConstraintViolation(new Error("boom"))).toBe(false);
  });
});

describe("isSerializationFailure", () => {
  it("is true for structured P2034", () => {
    expect(isSerializationFailure(prismaError("P2034"))).toBe(true);
  });

  it("is true for P2010 wrapping raw-SQL SQLSTATE 40001", () => {
    expect(isSerializationFailure(prismaError("P2010", { code: "40001" }))).toBe(true);
  });

  it("is false for P2010 wrapping an unrelated SQLSTATE", () => {
    expect(isSerializationFailure(prismaError("P2010", { code: "23505" }))).toBe(false);
  });
});

describe("isForeignKeyViolation", () => {
  it("is true for structured P2003", () => {
    expect(isForeignKeyViolation(prismaError("P2003"))).toBe(true);
  });

  it("is false for P2002", () => {
    expect(isForeignKeyViolation(prismaError("P2002"))).toBe(false);
  });
});

describe("isTransientDbError", () => {
  it("treats unique violations as non-transient", () => {
    expect(isTransientDbError(prismaError("P2002"))).toBe(false);
  });

  it("treats foreign-key violations as non-transient", () => {
    expect(isTransientDbError(prismaError("P2003"))).toBe(false);
  });

  it("treats serialization failures (P2034) as transient", () => {
    expect(isTransientDbError(prismaError("P2034"))).toBe(true);
  });

  it("treats lock-wait timeouts (P1008) as transient", () => {
    expect(isTransientDbError(prismaError("P1008"))).toBe(true);
  });

  it("treats connection-reset messages as transient", () => {
    expect(isTransientDbError(new Error("read ECONNRESET"))).toBe(true);
  });

  it("treats an ordinary business error as non-transient", () => {
    expect(isTransientDbError(new Error("account_inactive"))).toBe(false);
  });
});

describe("summarizeDbError", () => {
  it("prefixes the Prisma error code when present", () => {
    expect(summarizeDbError(prismaError("P2002"))).toMatch(/^P2002: /);
  });

  it("falls back to the bare message for non-Prisma errors", () => {
    expect(summarizeDbError(new Error("plain failure"))).toBe("plain failure");
  });

  it("truncates to the first line and 240 characters", () => {
    const long = `first line\n${"x".repeat(500)}`;
    const summary = summarizeDbError(new Error(long));
    expect(summary).not.toContain("\n");
    expect(summary.length).toBeLessThanOrEqual(240);
  });
});

describe("withDbRetry", () => {
  it("returns the result on first success without sleeping", async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const result = await withDbRetry(async () => "ok", { op: "test.op" }, { sleep });
    expect(result).toBe("ok");
    expect(sleep).not.toHaveBeenCalled();
  });

  it("retries transient errors up to the delay schedule and then succeeds", async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    let attempts = 0;
    const result = await withDbRetry(
      async () => {
        attempts += 1;
        if (attempts < 3) throw prismaError("P1008");
        return "recovered";
      },
      { op: "test.op" },
      { sleep, delaysMs: [10, 20, 30] },
    );
    expect(result).toBe("recovered");
    expect(attempts).toBe(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("rethrows immediately without retrying a non-transient error", async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    let attempts = 0;
    await expect(
      withDbRetry(
        async () => {
          attempts += 1;
          throw prismaError("P2002");
        },
        { op: "test.op" },
        { sleep, delaysMs: [10, 20, 30] },
      ),
    ).rejects.toThrow();
    expect(attempts).toBe(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("gives up and rethrows once the delay schedule is exhausted", async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    let attempts = 0;
    await expect(
      withDbRetry(
        async () => {
          attempts += 1;
          throw prismaError("P1008");
        },
        { op: "test.op" },
        { sleep, delaysMs: [10, 20] },
      ),
    ).rejects.toThrow();
    // 1 initial attempt + 2 retries (matching delaysMs.length) = 3 total.
    expect(attempts).toBe(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("passes a structured log entry to a custom logger on retry", async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const logger = vi.fn();
    let attempts = 0;
    await withDbRetry(
      async () => {
        attempts += 1;
        if (attempts < 2) throw prismaError("P1008");
        return "ok";
      },
      { op: "test.op", itemId: "item-1", sourceItemId: "src-1" },
      { sleep, logger, delaysMs: [5] },
    );
    expect(logger).toHaveBeenCalledTimes(1);
    const entry = logger.mock.calls[0]![0];
    expect(entry.op).toBe("test.op");
    expect(entry.attempt).toBe(1);
    expect(entry.itemId).toBe("item-1");
    expect(entry.sourceItemId).toBe("src-1");
    expect(entry.error).toMatch(/^P1008: /);
  });
});
