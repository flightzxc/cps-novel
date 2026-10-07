import { isIP } from "node:net";

import { readAdminCanonicalOrigin, resolveAdminHost } from "@/lib/site/admin-origin";

import { AdminAccessError } from "./errors";

/**
 * B-39 — Cloudflare Turnstile on the admin login (`/login`).
 *
 * Ported from the short-drama sister site's login Turnstile (`src/lib/turnstile.ts`
 * at CPS commit `35cd113`, see `docs/governance/port-registry.md`), restructured
 * for this repo's shape: an explicit, default-off switch with a strictly
 * validated config; a verifier that is fail-closed on every path; and a gate
 * that plugs into `authenticateAdminLogin` (`./login.ts`) instead of a NextAuth
 * `authorize` callback.
 *
 * ## Switch and fail directions
 *
 * `ADMIN_LOGIN_TURNSTILE_ENABLED` follows this repo's exact-`"true"` enable-flag
 * parsing (`src/lib/flags/feature-flags.ts`): unset / `"false"` / anything else
 * means OFF, and OFF is byte-for-byte today's login — no Cloudflare script is
 * loaded, `siteverify` is never called, `authenticateAdminLogin` receives no
 * gate. The deployment preflight (`scripts/preproduction/lib.sh`,
 * `preprod_assert_admin_login_turnstile_config`) is stricter than this reader
 * on purpose: it rejects every value other than `true` / `false` / unset, so a
 * typo cannot reach a host. Once ON, everything fails closed: a missing or
 * malformed site key, secret key or admin origin, a missing/overlong token,
 * Cloudflare rejecting the token, a hostname other than the admin host, a
 * network error, a timeout, a non-2xx answer or an unparsable body all refuse
 * the login. Nothing here ever lets a login through because verification could
 * not be performed.
 *
 * ## Keys
 *
 * The site key is public (it is rendered into the page) and comes straight from
 * `ADMIN_LOGIN_TURNSTILE_SITE_KEY`. The secret key follows the repo's secret
 * convention: `ADMIN_LOGIN_TURNSTILE_SECRET_KEY_FILE` -> `scripts/start-web.sh`
 * (`load_runtime_secret`) -> `ADMIN_LOGIN_TURNSTILE_SECRET_KEY` in the web
 * process only. This module reads the already-loaded value and never reads a
 * file, never logs the secret, the token or the Cloudflare response body, and
 * never puts any of them into an error message.
 */

export const ADMIN_LOGIN_TURNSTILE_ENV = Object.freeze({
  enabled: "ADMIN_LOGIN_TURNSTILE_ENABLED",
  siteKey: "ADMIN_LOGIN_TURNSTILE_SITE_KEY",
  secretKey: "ADMIN_LOGIN_TURNSTILE_SECRET_KEY",
  secretKeyFile: "ADMIN_LOGIN_TURNSTILE_SECRET_KEY_FILE",
} as const);

/**
 * Name of the secret file under `<PREPROD_SHARED_ROOT>/secrets/` AND of the
 * Compose secret that mounts it at `/run/secrets/<name>` — the three places that
 * must agree (overlay, `secrets-preflight.sh`, `lib.sh`) are pinned to this
 * constant by `tests/backend/runtime/admin-login-turnstile-config-contract.test.ts`.
 */
export const ADMIN_LOGIN_TURNSTILE_SECRET_NAME = "admin_login_turnstile_secret_key";

export const TURNSTILE_SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
export const TURNSTILE_SCRIPT_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

/** Upper bound on the whole `siteverify` round trip. Past it the login is refused. */
export const TURNSTILE_VERIFY_TIMEOUT_MS = 5_000;
/** Cloudflare documents tokens as at most 2048 characters; longer is rejected without a network call. */
export const TURNSTILE_TOKEN_MAX_LENGTH = 2_048;
/**
 * Shape of a Turnstile site key (real keys look like `0x4AAAAAAA…`; Cloudflare's
 * published test keys like `1x00000000000000000000AA`). Mirrored letter for
 * letter in the deployment preflight (`lib.sh`).
 */
export const TURNSTILE_SITE_KEY_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;

export type AdminLoginTurnstileConfigIssue =
  | "site_key_missing"
  | "site_key_invalid"
  | "secret_missing"
  | "admin_origin_invalid";

/** Carries a stable issue code only — never a configured value. */
export class AdminLoginTurnstileConfigError extends Error {
  readonly issue: AdminLoginTurnstileConfigIssue;

  constructor(issue: AdminLoginTurnstileConfigIssue) {
    super(`Admin login Turnstile is enabled but misconfigured: ${issue}`);
    this.name = "AdminLoginTurnstileConfigError";
    this.issue = issue;
  }
}

export type AdminLoginTurnstileConfig =
  | { readonly enabled: false }
  | {
      readonly enabled: true;
      readonly siteKey: string;
      readonly secretKey: string;
      /** Lowercase hostname of `ADMIN_CANONICAL_ORIGIN`; `siteverify` must echo exactly this. */
      readonly expectedHostname: string;
    };

/** Exact `"true"` only — the repo's enable-flag parsing. Never throws. */
export function isAdminLoginTurnstileEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[ADMIN_LOGIN_TURNSTILE_ENV.enabled] === "true";
}

/**
 * Resolve the full config. OFF returns `{ enabled: false }` without looking at
 * any other variable (so a half-filled config cannot affect an OFF host); ON
 * requires site key, secret key and a valid admin origin or throws
 * {@link AdminLoginTurnstileConfigError}.
 */
export function resolveAdminLoginTurnstileConfig(
  env: NodeJS.ProcessEnv = process.env,
): AdminLoginTurnstileConfig {
  if (!isAdminLoginTurnstileEnabled(env)) return { enabled: false };

  const siteKey = env[ADMIN_LOGIN_TURNSTILE_ENV.siteKey]?.trim() ?? "";
  if (!siteKey) throw new AdminLoginTurnstileConfigError("site_key_missing");
  if (!TURNSTILE_SITE_KEY_PATTERN.test(siteKey)) throw new AdminLoginTurnstileConfigError("site_key_invalid");

  const secretKey = env[ADMIN_LOGIN_TURNSTILE_ENV.secretKey]?.trim() ?? "";
  if (!secretKey) throw new AdminLoginTurnstileConfigError("secret_missing");

  const adminHost = resolveAdminHost(readAdminCanonicalOrigin({ ADMIN_CANONICAL_ORIGIN: env.ADMIN_CANONICAL_ORIGIN }));
  if (!adminHost.ok) throw new AdminLoginTurnstileConfigError("admin_origin_invalid");

  return { enabled: true, siteKey, secretKey, expectedHostname: adminHost.host };
}

/** What the login page is allowed to know. Serializable; carries the public site key only. */
export type AdminLoginTurnstilePublicState =
  | { readonly state: "off" }
  | { readonly state: "ready"; readonly siteKey: string }
  | { readonly state: "misconfigured" };

/**
 * Server-side projection for `login/page.tsx`. A misconfigured ON switch is
 * surfaced as its own state (the form then shows the "unavailable" copy and
 * cannot submit) rather than as a widget that could never succeed.
 */
export function readAdminLoginTurnstilePublicState(
  env: NodeJS.ProcessEnv = process.env,
): AdminLoginTurnstilePublicState {
  if (!isAdminLoginTurnstileEnabled(env)) return { state: "off" };
  try {
    const config = resolveAdminLoginTurnstileConfig(env);
    return config.enabled ? { state: "ready", siteKey: config.siteKey } : { state: "off" };
  } catch {
    return { state: "misconfigured" };
  }
}

export type AdminLoginTurnstileFailureReason =
  | "missing_token"
  | "rejected"
  | "hostname_mismatch"
  | "service_error";

export type AdminLoginTurnstileVerdict =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: AdminLoginTurnstileFailureReason;
      /** Cloudflare `error-codes`, filtered to a safe token shape; for logs only. */
      readonly errorCodes: readonly string[];
    };

type SiteverifyResponse = {
  success?: unknown;
  hostname?: unknown;
  "error-codes"?: unknown;
};

/**
 * Cloudflare error codes that mean "this deployment cannot verify" (wrong or
 * missing secret, Cloudflare-side fault, malformed request we built) rather
 * than "this visitor's token is bad". They map to the *unavailable* copy so an
 * administrator is not told to retry a challenge that can never pass.
 */
const SERVICE_SIDE_ERROR_CODES: ReadonlySet<string> = new Set([
  "missing-input-secret",
  "invalid-input-secret",
  "bad-request",
  "internal-error",
]);

const SAFE_ERROR_CODE = /^[a-z0-9-]{1,64}$/;

function safeErrorCodes(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((code): code is string => typeof code === "string" && SAFE_ERROR_CODE.test(code)).slice(0, 8);
}

function refusal(reason: AdminLoginTurnstileFailureReason, errorCodes: readonly string[] = []): AdminLoginTurnstileVerdict {
  return { ok: false, reason, errorCodes };
}

/**
 * Ask Cloudflare whether `token` is a valid, unspent solution for our site and
 * was issued for the admin host. Fail-closed: only a 2xx JSON body with
 * `success === true` AND `hostname === config.expectedHostname` returns `ok`.
 * Never throws.
 */
export async function verifyAdminLoginTurnstileToken(input: {
  token: unknown;
  remoteIp?: string;
  config: Extract<AdminLoginTurnstileConfig, { enabled: true }>;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<AdminLoginTurnstileVerdict> {
  const token = typeof input.token === "string" ? input.token.trim() : "";
  if (!token) return refusal("missing_token");
  if (token.length > TURNSTILE_TOKEN_MAX_LENGTH) return refusal("rejected");

  const body = new URLSearchParams({ secret: input.config.secretKey, response: token });
  // Only forward something that actually is an IP address: `remoteip` is
  // optional for Cloudflare and the value originates from a request header.
  if (input.remoteIp && isIP(input.remoteIp) !== 0) body.set("remoteip", input.remoteIp);

  let data: SiteverifyResponse;
  try {
    const response = await (input.fetchImpl ?? fetch)(TURNSTILE_SITEVERIFY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      cache: "no-store",
      signal: AbortSignal.timeout(input.timeoutMs ?? TURNSTILE_VERIFY_TIMEOUT_MS),
    });
    if (!response.ok) return refusal("service_error");
    const parsed: unknown = await response.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return refusal("service_error");
    data = parsed as SiteverifyResponse;
  } catch {
    // Network failure, timeout (AbortError) or an unparsable body. The error
    // object is deliberately not inspected or logged: undici error messages can
    // echo request details.
    return refusal("service_error");
  }

  if (data.success !== true) {
    const errorCodes = safeErrorCodes(data["error-codes"]);
    return errorCodes.some((code) => SERVICE_SIDE_ERROR_CODES.has(code))
      ? refusal("service_error", errorCodes)
      : refusal("rejected", errorCodes);
  }

  const hostname = typeof data.hostname === "string" ? data.hostname.trim().toLowerCase() : "";
  if (hostname !== input.config.expectedHostname) return refusal("hostname_mismatch");

  return { ok: true };
}

/**
 * The gate `authenticateAdminLogin` runs after the lockout check and before any
 * identity lookup or password work. Returns `undefined` when the switch is OFF,
 * so the OFF path hands the login core nothing at all.
 *
 * ON: resolves the config lazily (a misconfiguration is a refusal at login
 * time, not a crash at import or page-render time), verifies, and throws an
 * `AdminAccessError` on anything but a clean pass:
 *   - `admin_human_verification_failed`      the token is bad / missing / for another host
 *   - `admin_human_verification_unavailable` misconfigured deployment or Cloudflare unreachable
 * Only a stable code and a generic message leave this function.
 */
export function createAdminLoginHumanVerification(input: {
  token: unknown;
  remoteIp?: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): (() => Promise<void>) | undefined {
  const env = input.env ?? process.env;
  if (!isAdminLoginTurnstileEnabled(env)) return undefined;

  return async () => {
    let config: AdminLoginTurnstileConfig;
    try {
      config = resolveAdminLoginTurnstileConfig(env);
    } catch (error) {
      const issue = error instanceof AdminLoginTurnstileConfigError ? error.issue : "unknown";
      console.error(`[admin-login-turnstile] enabled but misconfigured (${issue}); refusing admin login (fail-closed)`);
      throw new AdminAccessError(
        "admin_human_verification_unavailable",
        403,
        "Admin login human verification is misconfigured",
      );
    }
    if (!config.enabled) {
      // Unreachable (the switch was just read as ON) — refuse rather than pass.
      throw new AdminAccessError(
        "admin_human_verification_unavailable",
        403,
        "Admin login human verification is misconfigured",
      );
    }

    const verdict = await verifyAdminLoginTurnstileToken({
      token: input.token,
      remoteIp: input.remoteIp,
      config,
      fetchImpl: input.fetchImpl,
      timeoutMs: input.timeoutMs,
    });
    if (verdict.ok) return;

    const codes = verdict.errorCodes.length > 0 ? ` codes=${verdict.errorCodes.join(",")}` : "";
    console.warn(`[admin-login-turnstile] verification refused reason=${verdict.reason}${codes}`);
    if (verdict.reason === "service_error") {
      throw new AdminAccessError(
        "admin_human_verification_unavailable",
        403,
        "Admin login human verification service error",
      );
    }
    throw new AdminAccessError("admin_human_verification_failed", 403, "Admin login human verification failed");
  };
}

/**
 * One boot-log line for `scripts/admin-login-turnstile-preflight.ts`. Silent
 * (returns `null`) when the switch is OFF so an OFF host's boot log is
 * unchanged. Never includes a key value.
 */
export function describeAdminLoginTurnstileStartup(env: NodeJS.ProcessEnv = process.env): string | null {
  if (!isAdminLoginTurnstileEnabled(env)) return null;
  try {
    const config = resolveAdminLoginTurnstileConfig(env);
    return config.enabled
      ? `[auth] ${ADMIN_LOGIN_TURNSTILE_ENV.enabled}=true — admin login requires Turnstile (hostname=${config.expectedHostname}, site key and secret present)`
      : null;
  } catch (error) {
    const issue = error instanceof AdminLoginTurnstileConfigError ? error.issue : "unknown";
    return `[auth] ${ADMIN_LOGIN_TURNSTILE_ENV.enabled}=true but misconfigured (${issue}) — every admin login will be refused (fail-closed) until fixed`;
  }
}
