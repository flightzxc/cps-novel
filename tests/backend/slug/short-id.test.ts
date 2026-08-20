import { Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";

import {
  PUBLIC_PAGE_SHORT_ID_ALPHABET,
  PUBLIC_PAGE_SHORT_ID_LENGTH,
  createWithPublicPageShortIdRetry,
  generatePublicPageShortIdCandidate,
  isPublicPageShortIdConflict,
} from "@/lib/slug/short-id";

function uniqueViolation(target: string | string[]): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
    code: "P2002",
    clientVersion: "test",
    meta: { target: Array.isArray(target) ? target : [target] },
  });
}

describe("generatePublicPageShortIdCandidate", () => {
  it("produces a lowercase alphanumeric string of the registered length", () => {
    const value = generatePublicPageShortIdCandidate();
    expect(value).toHaveLength(PUBLIC_PAGE_SHORT_ID_LENGTH);
    expect(value).toMatch(/^[a-z0-9]+$/);
    for (const char of value) {
      expect(PUBLIC_PAGE_SHORT_ID_ALPHABET).toContain(char);
    }
  });

  it("always contains at least one digit", () => {
    for (let i = 0; i < 200; i += 1) {
      expect(generatePublicPageShortIdCandidate()).toMatch(/\d/);
    }
  });

  it("is not constant across calls", () => {
    const values = new Set(Array.from({ length: 50 }, () => generatePublicPageShortIdCandidate()));
    expect(values.size).toBeGreaterThan(1);
  });
});

describe("isPublicPageShortIdConflict", () => {
  it("recognizes the camelCase field name target", () => {
    expect(isPublicPageShortIdConflict(uniqueViolation("publicPageShortId"))).toBe(true);
  });

  it("recognizes the snake_case column name target", () => {
    expect(isPublicPageShortIdConflict(uniqueViolation("public_page_short_id"))).toBe(true);
  });

  it("recognizes the DB constraint name target", () => {
    expect(isPublicPageShortIdConflict(uniqueViolation("article_public_page_short_id_key"))).toBe(true);
  });

  it("returns false for a P2002 on an unrelated field", () => {
    expect(isPublicPageShortIdConflict(uniqueViolation("business_id"))).toBe(false);
  });

  it("returns false for a non-P2002 error", () => {
    expect(isPublicPageShortIdConflict(new Error("boom"))).toBe(false);
  });

  it("returns false for a plain object shaped like an error but not a real PrismaClientKnownRequestError", () => {
    expect(isPublicPageShortIdConflict({ code: "P2002", meta: { target: ["publicPageShortId"] } })).toBe(false);
  });
});

describe("createWithPublicPageShortIdRetry", () => {
  it("returns on the first attempt when there is no conflict", async () => {
    const seen: string[] = [];
    const result = await createWithPublicPageShortIdRetry(async (candidate) => {
      seen.push(candidate);
      return `ok:${candidate}`;
    });
    expect(seen).toHaveLength(1);
    expect(result).toBe(`ok:${seen[0]}`);
  });

  it("regenerates and retries past a bounded number of collisions", async () => {
    let attempts = 0;
    const result = await createWithPublicPageShortIdRetry(async (candidate) => {
      attempts += 1;
      if (attempts <= 2) throw uniqueViolation("publicPageShortId");
      return candidate;
    }, 5);
    expect(attempts).toBe(3);
    expect(result).toHaveLength(PUBLIC_PAGE_SHORT_ID_LENGTH);
  });

  it("does not retry a unique violation on a different field — propagates immediately", async () => {
    let attempts = 0;
    await expect(
      createWithPublicPageShortIdRetry(async () => {
        attempts += 1;
        throw uniqueViolation("business_id");
      }, 5),
    ).rejects.toMatchObject({ code: "P2002" });
    expect(attempts).toBe(1);
  });

  it("does not retry a non-conflict error — propagates immediately", async () => {
    let attempts = 0;
    await expect(
      createWithPublicPageShortIdRetry(async () => {
        attempts += 1;
        throw new Error("some other failure");
      }, 5),
    ).rejects.toThrow("some other failure");
    expect(attempts).toBe(1);
  });

  it("rethrows the real error once attempts are exhausted", async () => {
    let attempts = 0;
    await expect(
      createWithPublicPageShortIdRetry(async () => {
        attempts += 1;
        throw uniqueViolation("publicPageShortId");
      }, 3),
    ).rejects.toMatchObject({ code: "P2002" });
    expect(attempts).toBe(3);
  });
});
