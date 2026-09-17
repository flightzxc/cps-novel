import { describe, expect, it } from "vitest";

import { normalizeCredentialJwtInput } from "@/lib/credentials/jwt";

/**
 * D-6 (Phase E rework, 2026-09-07): an operator pasting a full
 * `Authorization: Bearer <jwt>` header, or a bare `Bearer <jwt>` prefix,
 * into the credential-intake form must resolve to the exact same bare
 * token that a plain paste of the token itself produces — otherwise the
 * adapter re-adds its own `Bearer ` prefix on top and the upstream call
 * fails with HTTP 401 (the C-10 root cause this work order also fixes
 * visibility for). Ported from CPS `normalizeJwtInput`
 * (`src/lib/channel-account/jwt.ts:40-53`): identical trim / regex /
 * case-insensitive semantics, renamed for this codebase's credential module.
 */
describe("normalizeCredentialJwtInput", () => {
  const BARE_TOKEN = "x";

  it.each<[string, string]>([
    ["Authorization header form", "Authorization: Bearer x"],
    ["bare Bearer-prefixed form", "Bearer x"],
    ["lowercase bearer prefix", "bearer x"],
    ["already-bare token", "x"],
    ["surrounding whitespace", "   x   "],
    ["Bearer followed by a non-breaking space (U+00A0)", "Bearer" + "\u00A0" + "x"],
  ])("normalizes %s to the bare token", (_label, input) => {
    expect(normalizeCredentialJwtInput(input)).toBe(BARE_TOKEN);
  });

  it("is case-insensitive on the Authorization/Bearer keywords", () => {
    expect(normalizeCredentialJwtInput("authorization: bearer x")).toBe(BARE_TOKEN);
    expect(normalizeCredentialJwtInput("AUTHORIZATION: BEARER x")).toBe(BARE_TOKEN);
    expect(normalizeCredentialJwtInput("BEARER x")).toBe(BARE_TOKEN);
  });

  it("trims the captured group independently of the outer trim", () => {
    expect(normalizeCredentialJwtInput("Bearer   x  ")).toBe(BARE_TOKEN);
    expect(normalizeCredentialJwtInput("  Authorization: Bearer   x  ")).toBe(BARE_TOKEN);
  });

  it("preserves a realistic three-segment JWT with only the prefix stripped", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0.c2lnbmF0dXJl";
    expect(normalizeCredentialJwtInput(`Bearer ${jwt}`)).toBe(jwt);
    expect(normalizeCredentialJwtInput(`Authorization: Bearer ${jwt}`)).toBe(jwt);
    expect(normalizeCredentialJwtInput(jwt)).toBe(jwt);
  });

  it("passes through a value that only contains 'Bearer' as a substring, not a prefix", () => {
    // Must not strip mid-string occurrences — only a leading `Bearer ` (or
    // `Authorization: Bearer `) prefix is recognized, matching CPS exactly.
    expect(normalizeCredentialJwtInput("not-a-Bearer-prefix-token")).toBe("not-a-Bearer-prefix-token");
  });

  it("returns an empty string unchanged (still invalid downstream, but normalization itself is a no-op)", () => {
    expect(normalizeCredentialJwtInput("")).toBe("");
    expect(normalizeCredentialJwtInput("   ")).toBe("");
  });
});
