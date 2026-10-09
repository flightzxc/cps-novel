import { describe, expect, it } from "vitest";

import { isNextRedirect } from "@/app/(admin-auth)/_lib/next-redirect";

/**
 * B-9 — `isNextRedirect` moved out of `two-factor/setup/_components/setup-flow.tsx`
 * into `(admin-auth)/_lib/next-redirect.ts` so the login and challenge forms
 * share it. Behaviour is unchanged: it is true exactly when the thrown value is
 * an object whose `digest` stringifies to something starting with
 * `NEXT_REDIRECT`.
 */
describe("isNextRedirect", () => {
  it.each([
    ["a replace redirect", "NEXT_REDIRECT;replace;/login;307;"],
    ["a push redirect", "NEXT_REDIRECT;push;/two-factor/setup;303;"],
    ["a bare marker", "NEXT_REDIRECT"],
  ])("is true for %s", (_label, digest) => {
    expect(isNextRedirect(Object.assign(new Error("x"), { digest }))).toBe(true);
    expect(isNextRedirect({ digest })).toBe(true);
  });

  it.each([
    ["a plain network error", new TypeError("Failed to fetch")],
    ["a not-found digest", Object.assign(new Error("x"), { digest: "NEXT_NOT_FOUND" })],
    ["a digest that merely contains the marker", { digest: "x;NEXT_REDIRECT" }],
    ["a numeric digest", { digest: 307 }],
    ["an undefined digest", { digest: undefined }],
    ["null", null],
    ["undefined", undefined],
    ["a string", "NEXT_REDIRECT;replace;/login;307;"],
    ["a number", 307],
  ])("is false for %s", (_label, value) => {
    expect(isNextRedirect(value)).toBe(false);
  });
});
