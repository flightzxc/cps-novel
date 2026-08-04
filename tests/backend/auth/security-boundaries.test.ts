import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  ADMIN_LOGIN_LOCK_WINDOW_MS,
  clearFailedLogins,
  getLoginRateLimitStatus,
  hashLoginAttemptIdentifier,
  recordFailedLogin,
} from "@/lib/auth/login-attempts";
import { ADMIN_ABSOLUTE_TIMEOUT_MS } from "@/lib/auth/session";
import {
  ADMIN_SESSION_COOKIE_CONTRACT,
  ADMIN_SESSION_COOKIE_NAME,
  ADMIN_TWO_FACTOR_COOKIE_CONTRACT,
} from "@/server/auth/cookie-contract";
import { requireMutationRequestId, requireSameOrigin } from "@/server/auth/origin";
import { ADMIN_PAGE_ROOTS, resolveAdminPage } from "@/server/auth/registry";

import { TestOnlyInMemoryAuthStores } from "./test-only-in-memory-stores";

const NOW = new Date("2026-08-03T12:00:00.000Z");

describe("login attempts", () => {
  it("locks both username and IP dimensions on the fifth failure", async () => {
    const memory = new TestOnlyInMemoryAuthStores();
    for (let index = 0; index < 4; index += 1) {
      expect((await recordFailedLogin(memory, " Admin ", "203.0.113.1", NOW)).locked).toBe(false);
    }
    const locked = await recordFailedLogin(memory, "admin", "203.0.113.1", NOW);
    expect(locked.locked).toBe(true);
    expect(locked.remainingMs).toBe(ADMIN_LOGIN_LOCK_WINDOW_MS);
    await clearFailedLogins(memory, "admin");
    expect(memory.attempts.has(hashLoginAttemptIdentifier("user", "admin"))).toBe(false);
    expect(memory.attempts.has(hashLoginAttemptIdentifier("ip", "203.0.113.1"))).toBe(true);
    expect((await getLoginRateLimitStatus(memory, "admin", "203.0.113.1", NOW)).locked).toBe(true);
  });

  it("atomically records concurrent failures without losing counts", async () => {
    const memory = new TestOnlyInMemoryAuthStores();
    await Promise.all(
      Array.from({ length: 20 }, () =>
        recordFailedLogin(memory, "admin", "203.0.113.2", NOW),
      ),
    );
    expect(memory.attempts.get(hashLoginAttemptIdentifier("user", "admin"))?.failureCount).toBe(20);
    expect(memory.attempts.get(hashLoginAttemptIdentifier("ip", "203.0.113.2"))?.failureCount).toBe(20);
  });
});

describe("origin, request id, cookies, and page registry", () => {
  it("requires an exact same origin", () => {
    expect(() => requireSameOrigin("https://admin.example.com", "https://admin.example.com/")).not.toThrow();
    expect(() => requireSameOrigin(null, "https://admin.example.com")).toThrowError(
      expect.objectContaining({ code: "admin_origin_denied", status: 403 }),
    );
    expect(() => requireSameOrigin("https://evil.example", "https://admin.example.com")).toThrow();
    expect(() => requireSameOrigin("https://admin.example.com", "")).toThrowError(
      expect.objectContaining({ code: "admin_origin_denied", status: 403 }),
    );
    expect(() => requireSameOrigin("https://admin.example.com", "not-a-url")).toThrowError(
      expect.objectContaining({ code: "admin_origin_denied", status: 403 }),
    );
  });

  it("requires ADMIN_CANONICAL_ORIGIN instead of deriving it from Host", async () => {
    const source = await readFile(
      path.resolve(process.cwd(), "src/app/api/admin/_lib/deps.ts"),
      "utf8",
    );
    expect(source).toContain("process.env.ADMIN_CANONICAL_ORIGIN?.trim() ?? \"\"");
    expect(source).not.toMatch(/headers\(\)|get\(["']host["']\)|localhost/);
  });

  it("requires a UUID mutation request id", () => {
    expect(requireMutationRequestId("550e8400-e29b-41d4-a716-446655440000")).toBe(
      "550e8400-e29b-41d4-a716-446655440000",
    );
    expect(() => requireMutationRequestId("request-1")).toThrowError(
      expect.objectContaining({ code: "admin_mutation_request_id_invalid", status: 403 }),
    );
  });

  it("freezes secure host-only cookie attributes", () => {
    expect(ADMIN_SESSION_COOKIE_NAME.startsWith("__Host-")).toBe(true);
    expect(ADMIN_SESSION_COOKIE_CONTRACT).toEqual({
      httpOnly: true,
      secure: true,
      sameSite: "strict",
      path: "/",
      maxAge: ADMIN_ABSOLUTE_TIMEOUT_MS / 1000,
    });
    expect("domain" in ADMIN_SESSION_COOKIE_CONTRACT).toBe(false);
    expect(ADMIN_TWO_FACTOR_COOKIE_CONTRACT.maxAge).toBe(300);
  });

  it("registers exactly the 14 frozen page roots with segment-safe matching", () => {
    expect(ADMIN_PAGE_ROOTS).toHaveLength(14);
    expect(resolveAdminPage("/settings/security")).toBe("/settings");
    expect(resolveAdminPage("/dashboarding")).toBeNull();
    expect(resolveAdminPage("/api/admin/unknown")).toBeNull();
  });
});
