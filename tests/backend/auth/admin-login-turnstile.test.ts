import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ADMIN_LOGIN_TURNSTILE_ENV,
  AdminLoginTurnstileConfigError,
  TURNSTILE_SITEVERIFY_URL,
  TURNSTILE_TOKEN_MAX_LENGTH,
  createAdminLoginHumanVerification,
  describeAdminLoginTurnstileStartup,
  isAdminLoginTurnstileEnabled,
  readAdminLoginTurnstilePublicState,
  resolveAdminLoginTurnstileConfig,
  verifyAdminLoginTurnstileToken,
} from "@/lib/auth/admin-login-turnstile";
import { AdminAccessError, isAdminAccessError } from "@/lib/auth/errors";
import { authenticateAdminLogin } from "@/lib/auth/login";
import { hashAdminPassword } from "@/lib/auth/password";

import { TestOnlyInMemoryAuthStores } from "./test-only-in-memory-stores";

/**
 * B-39 — admin login Turnstile.
 *
 * Only Cloudflare's PUBLISHED dummy keys ever appear here (site key
 * `1x00000000000000000000AA`, secret `1x0000000000000000000000000000000AA`
 * "always passes"; `2x…` "always fails"). `fetch` is always a stub — nothing in
 * this file reaches Cloudflare. The sentinel token / hostnames are test data.
 */

const TEST_SITE_KEY_PASS = "1x00000000000000000000AA";
const TEST_SECRET_PASS = "1x0000000000000000000000000000000AA";
const TEST_SITE_KEY_FAIL = "2x00000000000000000000AB";
const TEST_SECRET_FAIL = "2x0000000000000000000000000000000AA";
const ADMIN_HOST = "zbcwf.example.test";

function onEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "test",
    ADMIN_CANONICAL_ORIGIN: `https://${ADMIN_HOST}`,
    [ADMIN_LOGIN_TURNSTILE_ENV.enabled]: "true",
    [ADMIN_LOGIN_TURNSTILE_ENV.siteKey]: TEST_SITE_KEY_PASS,
    [ADMIN_LOGIN_TURNSTILE_ENV.secretKey]: TEST_SECRET_PASS,
    ...overrides,
  } as NodeJS.ProcessEnv;
}

function siteverify(body: unknown, init: { status?: number } = {}): typeof fetch {
  return vi.fn(async () => new Response(JSON.stringify(body), { status: init.status ?? 200 })) as unknown as typeof fetch;
}

const config = resolveAdminLoginTurnstileConfig(onEnv());
if (!config.enabled) throw new Error("fixture config must be enabled");
const enabledConfig = config;

describe("switch and config resolution", () => {
  it("is OFF for unset, empty, false and every non-exact spelling of true", () => {
    for (const value of [undefined, "", "false", "TRUE", "True", "1", "yes", "on", " true", "true "]) {
      const env = onEnv({ [ADMIN_LOGIN_TURNSTILE_ENV.enabled]: value });
      expect(isAdminLoginTurnstileEnabled(env), `value=${JSON.stringify(value)}`).toBe(false);
      expect(resolveAdminLoginTurnstileConfig(env)).toEqual({ enabled: false });
      expect(readAdminLoginTurnstilePublicState(env)).toEqual({ state: "off" });
    }
    expect(isAdminLoginTurnstileEnabled({} as NodeJS.ProcessEnv)).toBe(false);
  });

  it("a half-filled config cannot affect an OFF host (nothing else is even read)", () => {
    const env = onEnv({
      [ADMIN_LOGIN_TURNSTILE_ENV.enabled]: "false",
      [ADMIN_LOGIN_TURNSTILE_ENV.siteKey]: "!!!",
      [ADMIN_LOGIN_TURNSTILE_ENV.secretKey]: undefined,
      ADMIN_CANONICAL_ORIGIN: undefined,
    });
    expect(resolveAdminLoginTurnstileConfig(env)).toEqual({ enabled: false });
  });

  it("ON with site key, secret and admin origin resolves, hostname lowercased and port-free", () => {
    const resolved = resolveAdminLoginTurnstileConfig(onEnv({ ADMIN_CANONICAL_ORIGIN: "https://ZBCWF.Example.TEST:8443" }));
    expect(resolved).toEqual({
      enabled: true,
      siteKey: TEST_SITE_KEY_PASS,
      secretKey: TEST_SECRET_PASS,
      expectedHostname: "zbcwf.example.test",
    });
  });

  it.each([
    ["site_key_missing", { [ADMIN_LOGIN_TURNSTILE_ENV.siteKey]: undefined }],
    ["site_key_missing", { [ADMIN_LOGIN_TURNSTILE_ENV.siteKey]: "   " }],
    ["site_key_invalid", { [ADMIN_LOGIN_TURNSTILE_ENV.siteKey]: "short" }],
    ["site_key_invalid", { [ADMIN_LOGIN_TURNSTILE_ENV.siteKey]: "has space in it" }],
    ["site_key_invalid", { [ADMIN_LOGIN_TURNSTILE_ENV.siteKey]: "a".repeat(129) }],
    ["secret_missing", { [ADMIN_LOGIN_TURNSTILE_ENV.secretKey]: undefined }],
    ["secret_missing", { [ADMIN_LOGIN_TURNSTILE_ENV.secretKey]: "  " }],
    ["admin_origin_invalid", { ADMIN_CANONICAL_ORIGIN: undefined }],
    ["admin_origin_invalid", { ADMIN_CANONICAL_ORIGIN: "not a url" }],
    ["admin_origin_invalid", { ADMIN_CANONICAL_ORIGIN: "https://zbcwf.example.test/some/path" }],
  ] as const)("ON but misconfigured (%s) throws a value-free config error", (issue, overrides) => {
    const env = onEnv(overrides);
    let thrown: unknown;
    try {
      resolveAdminLoginTurnstileConfig(env);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(AdminLoginTurnstileConfigError);
    expect((thrown as AdminLoginTurnstileConfigError).issue).toBe(issue);
    expect((thrown as Error).message).not.toContain(TEST_SECRET_PASS);
    expect((thrown as Error).message).not.toContain(TEST_SITE_KEY_PASS);
    expect(readAdminLoginTurnstilePublicState(env)).toEqual({ state: "misconfigured" });
  });

  it("the public projection carries the site key and never the secret", () => {
    const state = readAdminLoginTurnstilePublicState(onEnv());
    expect(state).toEqual({ state: "ready", siteKey: TEST_SITE_KEY_PASS });
    expect(JSON.stringify(state)).not.toContain(TEST_SECRET_PASS);
  });

  it("startup description is silent when OFF and never prints a key when ON", () => {
    expect(describeAdminLoginTurnstileStartup(onEnv({ [ADMIN_LOGIN_TURNSTILE_ENV.enabled]: "false" }))).toBeNull();
    expect(describeAdminLoginTurnstileStartup({} as NodeJS.ProcessEnv)).toBeNull();
    const ready = describeAdminLoginTurnstileStartup(onEnv());
    expect(ready).toContain(ADMIN_HOST);
    expect(ready).not.toContain(TEST_SECRET_PASS);
    expect(ready).not.toContain(TEST_SITE_KEY_PASS);
    const broken = describeAdminLoginTurnstileStartup(onEnv({ [ADMIN_LOGIN_TURNSTILE_ENV.secretKey]: undefined }));
    expect(broken).toContain("secret_missing");
    expect(broken).toContain("fail-closed");
  });
});

describe("verifyAdminLoginTurnstileToken — only success + the admin hostname passes", () => {
  it("accepts success:true with the admin hostname and sends the documented request", async () => {
    const fetchImpl = siteverify({ success: true, hostname: ADMIN_HOST, "error-codes": [] });
    const verdict = await verifyAdminLoginTurnstileToken({
      token: "XXXX.DUMMY.TOKEN.XXXX",
      remoteIp: "203.0.113.9",
      config: enabledConfig,
      fetchImpl,
    });
    expect(verdict).toEqual({ ok: true });

    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe(TURNSTILE_SITEVERIFY_URL);
    expect(url).toBe("https://challenges.cloudflare.com/turnstile/v0/siteverify");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/x-www-form-urlencoded");
    expect(init.cache).toBe("no-store");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    const body = init.body as URLSearchParams;
    expect(body.get("secret")).toBe(TEST_SECRET_PASS);
    expect(body.get("response")).toBe("XXXX.DUMMY.TOKEN.XXXX");
    expect(body.get("remoteip")).toBe("203.0.113.9");
  });

  it("compares the hostname case-insensitively but exactly", async () => {
    expect(
      await verifyAdminLoginTurnstileToken({
        token: "t",
        config: enabledConfig,
        fetchImpl: siteverify({ success: true, hostname: ADMIN_HOST.toUpperCase() }),
      }),
    ).toEqual({ ok: true });
    for (const hostname of ["example.test", `evil.${ADMIN_HOST}`, `${ADMIN_HOST}.evil.test`, "pulsenovels.com", "", undefined, null, 42]) {
      expect(
        await verifyAdminLoginTurnstileToken({
          token: "t",
          config: enabledConfig,
          fetchImpl: siteverify({ success: true, hostname }),
        }),
        `hostname=${JSON.stringify(hostname)}`,
      ).toEqual({ ok: false, reason: "hostname_mismatch", errorCodes: [] });
    }
  });

  it("only forwards a real IP as remoteip", async () => {
    for (const remoteIp of [undefined, "", "unknown", "not-an-ip", "1.2.3.4, 5.6.7.8"]) {
      const fetchImpl = siteverify({ success: true, hostname: ADMIN_HOST });
      await verifyAdminLoginTurnstileToken({ token: "t", remoteIp, config: enabledConfig, fetchImpl });
      const init = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![1] as RequestInit;
      expect((init.body as URLSearchParams).has("remoteip"), `remoteIp=${remoteIp}`).toBe(false);
    }
    const v6 = siteverify({ success: true, hostname: ADMIN_HOST });
    await verifyAdminLoginTurnstileToken({ token: "t", remoteIp: "2001:db8::1", config: enabledConfig, fetchImpl: v6 });
    const v6Init = (v6 as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![1] as RequestInit;
    expect((v6Init.body as URLSearchParams).get("remoteip")).toBe("2001:db8::1");
  });

  it("Cloudflare saying success:false is a rejection, with the error codes kept for logs", async () => {
    expect(
      await verifyAdminLoginTurnstileToken({
        token: "t",
        config: enabledConfig,
        fetchImpl: siteverify({ success: false, "error-codes": ["invalid-input-response"] }),
      }),
    ).toEqual({ ok: false, reason: "rejected", errorCodes: ["invalid-input-response"] });
    expect(
      await verifyAdminLoginTurnstileToken({
        token: "t",
        config: enabledConfig,
        fetchImpl: siteverify({ success: false, "error-codes": ["timeout-or-duplicate"] }),
      }),
    ).toEqual({ ok: false, reason: "rejected", errorCodes: ["timeout-or-duplicate"] });
  });

  it("anything other than the boolean true is not a pass (truthy strings, 1, missing)", async () => {
    for (const success of ["true", 1, "yes", {}, null, undefined]) {
      const verdict = await verifyAdminLoginTurnstileToken({
        token: "t",
        config: enabledConfig,
        fetchImpl: siteverify({ success, hostname: ADMIN_HOST }),
      });
      expect(verdict.ok, `success=${JSON.stringify(success)}`).toBe(false);
    }
  });

  it("a wrong/missing secret or a Cloudflare-side fault is a service error, not a visitor failure", async () => {
    for (const code of ["invalid-input-secret", "missing-input-secret", "bad-request", "internal-error"]) {
      expect(
        await verifyAdminLoginTurnstileToken({
          token: "t",
          config: enabledConfig,
          fetchImpl: siteverify({ success: false, "error-codes": [code] }),
        }),
        code,
      ).toEqual({ ok: false, reason: "service_error", errorCodes: [code] });
    }
  });

  it("filters error codes down to a log-safe shape", async () => {
    const verdict = await verifyAdminLoginTurnstileToken({
      token: "t",
      config: enabledConfig,
      fetchImpl: siteverify({
        success: false,
        "error-codes": ["invalid-input-response", "has space", "UPPER", "x\ny", 7, null, "a".repeat(65)],
      }),
    });
    expect(verdict).toEqual({ ok: false, reason: "rejected", errorCodes: ["invalid-input-response"] });
  });

  it.each([
    ["non-2xx", () => siteverify({ success: true, hostname: ADMIN_HOST }, { status: 503 })],
    ["non-2xx 4xx", () => siteverify({ success: true, hostname: ADMIN_HOST }, { status: 400 })],
    ["network error", () => vi.fn(async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch],
    ["invalid JSON", () => vi.fn(async () => new Response("<html>oops</html>", { status: 200 })) as unknown as typeof fetch],
    ["JSON null", () => vi.fn(async () => new Response("null", { status: 200 })) as unknown as typeof fetch],
    ["JSON array", () => vi.fn(async () => new Response("[true]", { status: 200 })) as unknown as typeof fetch],
  ])("%s is a service error, never a pass", async (_label, makeFetch) => {
    const verdict = await verifyAdminLoginTurnstileToken({ token: "t", config: enabledConfig, fetchImpl: makeFetch() });
    expect(verdict).toEqual({ ok: false, reason: "service_error", errorCodes: [] });
  });

  it("a hung siteverify call is cut off by the timeout and refused", async () => {
    const hanging = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
        }),
    ) as unknown as typeof fetch;
    const started = Date.now();
    const verdict = await verifyAdminLoginTurnstileToken({
      token: "t",
      config: enabledConfig,
      fetchImpl: hanging,
      timeoutMs: 30,
    });
    expect(verdict).toEqual({ ok: false, reason: "service_error", errorCodes: [] });
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("refuses a missing, blank, non-string or oversized token without calling Cloudflare", async () => {
    for (const token of [undefined, null, "", "   ", 123, {}]) {
      const fetchImpl = siteverify({ success: true, hostname: ADMIN_HOST });
      expect(await verifyAdminLoginTurnstileToken({ token, config: enabledConfig, fetchImpl })).toEqual({
        ok: false,
        reason: "missing_token",
        errorCodes: [],
      });
      expect(fetchImpl).not.toHaveBeenCalled();
    }
    const fetchImpl = siteverify({ success: true, hostname: ADMIN_HOST });
    expect(
      await verifyAdminLoginTurnstileToken({
        token: "x".repeat(TURNSTILE_TOKEN_MAX_LENGTH + 1),
        config: enabledConfig,
        fetchImpl,
      }),
    ).toMatchObject({ ok: false, reason: "rejected" });
    expect(fetchImpl).not.toHaveBeenCalled();
    // exactly at the limit is still sent
    expect(
      await verifyAdminLoginTurnstileToken({
        token: "x".repeat(TURNSTILE_TOKEN_MAX_LENGTH),
        config: enabledConfig,
        fetchImpl: siteverify({ success: true, hostname: ADMIN_HOST }),
      }),
    ).toEqual({ ok: true });
  });
});

describe("createAdminLoginHumanVerification — the gate handed to authenticateAdminLogin", () => {
  let warn: ReturnType<typeof vi.spyOn>;
  let error: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    error = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    warn.mockRestore();
    error.mockRestore();
  });

  async function refusalOf(gate: () => Promise<void>): Promise<AdminAccessError> {
    try {
      await gate();
    } catch (caught) {
      expect(isAdminAccessError(caught)).toBe(true);
      return caught as AdminAccessError;
    }
    throw new Error("gate unexpectedly passed");
  }

  it("is undefined when the switch is OFF — the OFF path hands the login core nothing", () => {
    const fetchImpl = siteverify({ success: true, hostname: ADMIN_HOST });
    for (const value of [undefined, "false", "TRUE"]) {
      expect(
        createAdminLoginHumanVerification({
          token: "t",
          env: onEnv({ [ADMIN_LOGIN_TURNSTILE_ENV.enabled]: value }),
          fetchImpl,
        }),
      ).toBeUndefined();
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("passes on a clean verification", async () => {
    const gate = createAdminLoginHumanVerification({
      token: "good",
      remoteIp: "198.51.100.7",
      env: onEnv(),
      fetchImpl: siteverify({ success: true, hostname: ADMIN_HOST }),
    });
    await expect(gate!()).resolves.toBeUndefined();
  });

  it("refuses with admin_human_verification_failed (403) for a rejected token, wrong hostname or missing token", async () => {
    for (const [token, body] of [
      ["bad", { success: false, "error-codes": ["invalid-input-response"] }],
      ["good", { success: true, hostname: "pulsenovels.com" }],
      [undefined, { success: true, hostname: ADMIN_HOST }],
    ] as const) {
      const refusal = await refusalOf(
        createAdminLoginHumanVerification({ token, env: onEnv(), fetchImpl: siteverify(body) })!,
      );
      expect(refusal.code).toBe("admin_human_verification_failed");
      expect(refusal.status).toBe(403);
    }
  });

  it("refuses with admin_human_verification_unavailable for Cloudflare errors, timeouts and a wrong secret", async () => {
    const cases: Array<typeof fetch> = [
      siteverify({}, { status: 500 }),
      vi.fn(async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch,
      siteverify({ success: false, "error-codes": ["invalid-input-secret"] }),
    ];
    for (const fetchImpl of cases) {
      const refusal = await refusalOf(createAdminLoginHumanVerification({ token: "t", env: onEnv(), fetchImpl })!);
      expect(refusal.code).toBe("admin_human_verification_unavailable");
      expect(refusal.status).toBe(403);
    }
  });

  it("ON but misconfigured refuses at login time without ever calling Cloudflare", async () => {
    for (const overrides of [
      { [ADMIN_LOGIN_TURNSTILE_ENV.secretKey]: undefined },
      { [ADMIN_LOGIN_TURNSTILE_ENV.siteKey]: undefined },
      { ADMIN_CANONICAL_ORIGIN: undefined },
    ]) {
      const fetchImpl = siteverify({ success: true, hostname: ADMIN_HOST });
      const gate = createAdminLoginHumanVerification({ token: "t", env: onEnv(overrides), fetchImpl });
      expect(gate).toBeTypeOf("function"); // creating it never throws, even when misconfigured
      const refusal = await refusalOf(gate!);
      expect(refusal.code).toBe("admin_human_verification_unavailable");
      expect(fetchImpl).not.toHaveBeenCalled();
    }
  });

  it("never lets the secret, the token or a Cloudflare body reach logs or error messages", async () => {
    const secretToken = "SENTINEL-TOKEN-ABCDEF";
    const cases: Array<[string, typeof fetch, NodeJS.ProcessEnv]> = [
      ["rejected", siteverify({ success: false, "error-codes": ["invalid-input-response"], echo: TEST_SECRET_PASS }), onEnv()],
      ["service", vi.fn(async () => { throw new Error(`boom ${TEST_SECRET_PASS} ${secretToken}`); }) as unknown as typeof fetch, onEnv()],
      ["misconfigured", siteverify({}), onEnv({ [ADMIN_LOGIN_TURNSTILE_ENV.siteKey]: undefined })],
    ];
    for (const [, fetchImpl, env] of cases) {
      const refusal = await refusalOf(createAdminLoginHumanVerification({ token: secretToken, env, fetchImpl })!);
      expect(refusal.message).not.toContain(TEST_SECRET_PASS);
      expect(refusal.message).not.toContain(secretToken);
      expect(JSON.stringify(refusal.details)).not.toContain(TEST_SECRET_PASS);
    }
    const logged = [...warn.mock.calls, ...error.mock.calls].flat().map(String).join("\n");
    expect(logged).not.toContain(TEST_SECRET_PASS);
    expect(logged).not.toContain(secretToken);
    expect(logged).not.toContain(TEST_SITE_KEY_PASS);
  });

  it("the always-fail dummy pair is just another rejection (Cloudflare answers success:false)", async () => {
    const env = onEnv({
      [ADMIN_LOGIN_TURNSTILE_ENV.siteKey]: TEST_SITE_KEY_FAIL,
      [ADMIN_LOGIN_TURNSTILE_ENV.secretKey]: TEST_SECRET_FAIL,
    });
    const fetchImpl = siteverify({ success: false, "error-codes": ["invalid-input-response"] });
    const refusal = await refusalOf(createAdminLoginHumanVerification({ token: "dummy", env, fetchImpl })!);
    expect(refusal.code).toBe("admin_human_verification_failed");
    const body = ((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![1] as RequestInit).body as URLSearchParams;
    expect(body.get("secret")).toBe(TEST_SECRET_FAIL);
  });
});

describe("authenticateAdminLogin with the human gate — order and lockout accounting", () => {
  const PASSWORD = "correct horse battery staple";
  const NOW = new Date("2026-10-07T00:00:00.000Z");
  const passwordHash = hashAdminPassword(PASSWORD, { cost: 1024 });

  function harness() {
    const memory = new TestOnlyInMemoryAuthStores();
    const findByNormalizedUsername = vi.fn(async (username: string) =>
      username === "admin"
        ? {
            id: "admin-1",
            username: "admin",
            role: "super_admin",
            status: "active" as const,
            sessionVersion: 1,
            twoFactorEnabled: false,
            passwordHash,
          }
        : null,
    );
    const sessionCreate = vi.spyOn(memory, "create");
    const recordFailure = vi.spyOn(memory, "recordFailure");
    return {
      memory,
      findByNormalizedUsername,
      sessionCreate,
      recordFailure,
      login: (overrides: { password?: string; username?: string; verifyHuman?: () => Promise<void> } = {}) =>
        authenticateAdminLogin({
          username: overrides.username ?? "admin",
          password: overrides.password ?? PASSWORD,
          ip: "203.0.113.9",
          identities: { findById: async () => null, findByNormalizedUsername },
          sessions: memory,
          attempts: memory,
          now: NOW,
          ...(overrides.verifyHuman ? { verifyHuman: overrides.verifyHuman } : {}),
        }),
    };
  }

  const refuse = () => {
    throw new AdminAccessError("admin_human_verification_failed", 403, "Admin login human verification failed");
  };

  it("without the gate the login is exactly the pre-B-39 behavior (success and wrong-password failure)", async () => {
    const h = harness();
    const ok = await h.login();
    expect(ok.context.identity.username).toBe("admin");
    await expect(h.login({ password: "wrong-password-value" })).rejects.toMatchObject({ code: "jwt_invalid", status: 401 });
    expect(h.recordFailure).toHaveBeenCalled();
  });

  it("a refused verification stops before any identity lookup, password check, session or failure record", async () => {
    const h = harness();
    await expect(h.login({ verifyHuman: async () => refuse() })).rejects.toMatchObject({
      code: "admin_human_verification_failed",
      status: 403,
    });
    expect(h.findByNormalizedUsername).not.toHaveBeenCalled();
    expect(h.sessionCreate).not.toHaveBeenCalled();
    expect(h.recordFailure).not.toHaveBeenCalled();
    expect(h.memory.attempts.size).toBe(0);
  });

  it("refused verifications are never counted toward the 5-failure lockout (CPS parity)", async () => {
    const h = harness();
    for (let i = 0; i < 12; i += 1) {
      await expect(h.login({ verifyHuman: async () => refuse() })).rejects.toMatchObject({
        code: "admin_human_verification_failed",
      });
    }
    expect(h.memory.attempts.size).toBe(0);
    // the real administrator is not locked out by the bot traffic
    const ok = await h.login({ verifyHuman: async () => {} });
    expect(ok.context.identity.username).toBe("admin");
  });

  it("an already-locked user/IP is refused as locked BEFORE the gate (and so before any Cloudflare call)", async () => {
    const h = harness();
    for (let i = 0; i < 5; i += 1) {
      await expect(h.login({ password: "wrong-password-value", verifyHuman: async () => {} })).rejects.toBeTruthy();
    }
    const verifyHuman = vi.fn(async () => {});
    await expect(h.login({ verifyHuman })).rejects.toMatchObject({ code: "admin_rate_limited", status: 429 });
    expect(verifyHuman).not.toHaveBeenCalled();
  });

  it("a verified-but-wrong password still counts: five of them lock the account", async () => {
    const h = harness();
    for (let i = 0; i < 4; i += 1) {
      await expect(h.login({ password: "wrong-password-value", verifyHuman: async () => {} })).rejects.toMatchObject({
        code: "jwt_invalid",
      });
    }
    await expect(h.login({ password: "wrong-password-value", verifyHuman: async () => {} })).rejects.toMatchObject({
      code: "jwt_invalid",
    });
    await expect(h.login({ verifyHuman: async () => {} })).rejects.toMatchObject({ code: "admin_rate_limited" });
  });

  it("a passing gate runs exactly once, before the credentials are looked at", async () => {
    const h = harness();
    const order: string[] = [];
    h.findByNormalizedUsername.mockImplementationOnce(async () => {
      order.push("identity");
      return {
        id: "admin-1", username: "admin", role: "super_admin", status: "active" as const,
        sessionVersion: 1, twoFactorEnabled: false, passwordHash,
      };
    });
    await h.login({ verifyHuman: async () => { order.push("human"); } });
    expect(order).toEqual(["human", "identity"]);
  });
});
