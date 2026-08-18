import { describe, expect, it } from "vitest";

import { GONE_DIGEST, gone, isGoneError } from "@/app/_lib/http";

describe("gone()", () => {
  it("throws an HTTP-interrupt error whose digest is 410", () => {
    try {
      gone();
    } catch (error) {
      expect(isGoneError(error)).toBe(true);
      expect((error as Error & { digest: string }).digest).toBe(GONE_DIGEST);
      expect(GONE_DIGEST).toBe("NEXT_HTTP_ERROR_FALLBACK;410");
      return;
    }
    throw new Error("gone() did not throw");
  });
});
