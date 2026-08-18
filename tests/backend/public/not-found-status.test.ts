import { describe, expect, it } from "vitest";
import { notFound } from "next/navigation";
import {
  getAccessFallbackHTTPStatus,
  isHTTPAccessFallbackError,
} from "next/dist/client/components/http-access-fallback/http-access-fallback";

describe("public novel notFound() HTTP status", () => {
  it("Next maps notFound() to HTTP 404 (the V1 takedown/withdrawn status)", () => {
    try {
      notFound();
    } catch (error) {
      // Test-only import of Next internals (http-access-fallback): if the
      // internal path/shape changes on upgrade, this fails loudly at import
      // time instead of silently regressing production status codes.
      if (!isHTTPAccessFallbackError(error)) {
        throw new Error("notFound() did not throw an HTTP access fallback error");
      }
      expect(getAccessFallbackHTTPStatus(error)).toBe(404);
      return;
    }
    throw new Error("notFound() did not throw");
  });
});
