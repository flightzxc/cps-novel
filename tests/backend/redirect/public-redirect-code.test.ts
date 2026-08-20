import { describe, expect, it } from "vitest";
import {
  createPublicRedirectCode,
  createWithPublicRedirectCodeRetry,
  isPublicRedirectCodeFormatValid,
  isPublicRedirectCodeUniqueConflict,
  PUBLIC_REDIRECT_CODE_LENGTH,
} from "@/lib/redirect";

describe("P0-S5 public redirect code — generator", () => {
  it("always produces the fixed-length lowercase-alnum format with at least one digit", () => {
    for (let i = 0; i < 500; i += 1) {
      const code = createPublicRedirectCode();
      expect(code).toHaveLength(PUBLIC_REDIRECT_CODE_LENGTH);
      expect(isPublicRedirectCodeFormatValid(code)).toBe(true);
      expect(/\d/.test(code)).toBe(true);
      expect(/^[a-z0-9]+$/.test(code)).toBe(true);
    }
  });

  it("is practically unique across a large batch (no collisions in 5,000 draws)", () => {
    const codes = new Set<string>();
    for (let i = 0; i < 5_000; i += 1) codes.add(createPublicRedirectCode());
    expect(codes.size).toBe(5_000);
  });

  it("rejects malformed values (length and charset only — the forced-digit rule belongs to the generator, not this defensive format check)", () => {
    expect(isPublicRedirectCodeFormatValid("TOOSHORT")).toBe(false);
    expect(isPublicRedirectCodeFormatValid("UPPERCASE1")).toBe(false);
    expect(isPublicRedirectCodeFormatValid("has-dash12")).toBe(false);
    expect(isPublicRedirectCodeFormatValid("a".repeat(PUBLIC_REDIRECT_CODE_LENGTH))).toBe(true);
    expect(isPublicRedirectCodeFormatValid("a".repeat(PUBLIC_REDIRECT_CODE_LENGTH - 1))).toBe(false);
  });
});

describe("P0-S5 public redirect code — conflict detection and bounded retry", () => {
  function conflictError(target: string) {
    return { code: "P2002", meta: { target: [target] } };
  }

  it("recognizes this column's own unique-violation target names", () => {
    expect(isPublicRedirectCodeUniqueConflict(conflictError("publicRedirectCode"))).toBe(true);
    expect(isPublicRedirectCodeUniqueConflict(conflictError("public_redirect_code"))).toBe(true);
    expect(isPublicRedirectCodeUniqueConflict(conflictError("promo_link_public_redirect_code_key"))).toBe(true);
  });

  it("does not treat an unrelated unique violation (e.g. idempotency_key) as its own conflict", () => {
    expect(isPublicRedirectCodeUniqueConflict(conflictError("promo_link_idempotency_key_key"))).toBe(false);
    expect(isPublicRedirectCodeUniqueConflict({ code: "P2003" })).toBe(false);
    expect(isPublicRedirectCodeUniqueConflict(null)).toBe(false);
  });

  it("retries with a fresh candidate only on its own conflict, succeeding once the caller reports no collision", async () => {
    let attempts = 0;
    const seenCodes: string[] = [];
    const result = await createWithPublicRedirectCodeRetry(async (code) => {
      attempts += 1;
      seenCodes.push(code);
      if (attempts < 3) throw conflictError("promo_link_public_redirect_code_key");
      return code;
    }, 5);
    expect(attempts).toBe(3);
    expect(result).toBe(seenCodes.at(-1));
    // Every retry drew a fresh candidate rather than reusing the same one.
    expect(new Set(seenCodes).size).toBe(seenCodes.length);
  });

  it("does not retry a non-conflict error, even mid-loop", async () => {
    let attempts = 0;
    await expect(
      createWithPublicRedirectCodeRetry(async () => {
        attempts += 1;
        throw new Error("unrelated failure");
      }, 5),
    ).rejects.toThrow("unrelated failure");
    expect(attempts).toBe(1);
  });

  it("gives up after maxAttempts and surfaces the last conflict", async () => {
    let attempts = 0;
    await expect(
      createWithPublicRedirectCodeRetry(async () => {
        attempts += 1;
        throw conflictError("promo_link_public_redirect_code_key");
      }, 3),
    ).rejects.toMatchObject({ code: "P2002" });
    expect(attempts).toBe(3);
  });
});

describe("P0-S5 public redirect code — immutability by construction", () => {
  it("exposes no update/regenerate function at all — only a fresh-candidate generator and a create-time retry wrapper", async () => {
    const redirectModule = await import("@/lib/redirect");
    const exportedNames = Object.keys(redirectModule);
    for (const name of exportedNames) {
      expect(name.toLowerCase()).not.toMatch(/update|regenerate|reassign|rotate/);
    }
  });
});
