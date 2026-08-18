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
      expect(isHTTPAccessFallbackError(error)).toBe(true);
      expect(getAccessFallbackHTTPStatus(error)).toBe(404);
      return;
    }
    throw new Error("notFound() did not throw");
  });
});
