import { Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";

import {
  createNovelWithBusinessIdRetry,
  generateNovelBusinessIdCandidate,
  isNovelBusinessIdConflict,
} from "@/server/content-creation/business-id";
import { PUBLIC_PAGE_SHORT_ID_ALPHABET } from "@/lib/slug/short-id";

function uniqueViolation(target: string): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
    code: "P2002",
    clientVersion: "test",
    meta: { target: [target] },
  });
}

describe("generateNovelBusinessIdCandidate", () => {
  it("is prefixed and lowercase alphanumeric", () => {
    const value = generateNovelBusinessIdCandidate();
    expect(value.startsWith("nv-")).toBe(true);
    expect(value).toMatch(/^nv-[a-z0-9]+$/);
  });

  it("is not constant across calls", () => {
    const values = new Set(Array.from({ length: 50 }, () => generateNovelBusinessIdCandidate()));
    expect(values.size).toBeGreaterThan(1);
  });

  it("uses a source text distinct from the publicPageShortId alphabet (independence, not shared identity)", async () => {
    const { readFile } = await import("node:fs/promises");
    const path = await import("node:path");
    const source = await readFile(path.resolve(process.cwd(), "src/server/content-creation/business-id.ts"), "utf8");
    expect(source.includes(PUBLIC_PAGE_SHORT_ID_ALPHABET)).toBe(false);
  });
});

describe("isNovelBusinessIdConflict", () => {
  it("recognizes all three known target forms", () => {
    expect(isNovelBusinessIdConflict(uniqueViolation("businessId"))).toBe(true);
    expect(isNovelBusinessIdConflict(uniqueViolation("business_id"))).toBe(true);
    expect(isNovelBusinessIdConflict(uniqueViolation("novel_business_id_key"))).toBe(true);
  });

  it("returns false for an unrelated P2002 target", () => {
    expect(isNovelBusinessIdConflict(uniqueViolation("publicPageShortId"))).toBe(false);
  });
});

describe("createNovelWithBusinessIdRetry", () => {
  it("retries past a bounded number of collisions and returns", async () => {
    let attempts = 0;
    const result = await createNovelWithBusinessIdRetry(async (candidate) => {
      attempts += 1;
      if (attempts <= 2) throw uniqueViolation("novel_business_id_key");
      return candidate;
    }, 5);
    expect(attempts).toBe(3);
    expect(result).toMatch(/^nv-[a-z0-9]+$/);
  });

  it("does not retry an unrelated unique violation", async () => {
    let attempts = 0;
    await expect(
      createNovelWithBusinessIdRetry(async () => {
        attempts += 1;
        throw uniqueViolation("publicPageShortId");
      }, 5),
    ).rejects.toMatchObject({ code: "P2002" });
    expect(attempts).toBe(1);
  });
});
