/**
 * RC-10 — global switch for whether the admin backend enforces two-factor
 * authentication at all.
 *
 * Owner decision (2026-09-04): local UAT (`X8_LEVEL=uat`) does not use 2FA —
 * an operator can log in and drive the whole backend on a password-only
 * session. Production (`X8_LEVEL=r` and every real deploy) must keep 2FA
 * required, unchanged from the pre-RC-10 behaviour. See
 * `docs/p2/V020_RELEASE_CHECKLIST.md` §2/§3 (Level UAT / Level R) and
 * `docs/operations/OWNER_LOCAL_UAT_RUNBOOK_2026-09-03.md` step 1.
 *
 * This module only reads `process.env` — no Node built-ins beyond that, no
 * Prisma, no session/store dependency — so it can be imported from both the
 * Codex-owned guard layer (`@/lib/auth/capabilities.ts`,
 * `@/server/auth/guards.ts`) and the Claude-owned page/login layer
 * (`@/app/(admin)/_lib/page-guard.ts`, `@/app/(admin-auth)/**`) without
 * pulling either side into the other's dependency graph.
 *
 * Fail-closed by construction: `readTwoFactorEnforcement` only returns
 * `"disabled"` for the exact (trimmed, case-insensitive) value `false` —
 * the canonical off value — or its accepted alias `disabled`. Unset, `true`
 * (the canonical on value), `required` (its alias), a typo (`Disable`,
 * `off`, `0`, `no`), an empty string, or any other value all resolve to
 * `"required"` — the safe side a misconfigured environment falls back to.
 *
 * Owner correction (2026-09-04, same day as the initial cut): the canonical
 * values are `true`/`false`, matching this repo's other boolean-shaped env
 * flags (`src/lib/flags/feature-flags.ts`'s exact `=== "true"` pattern);
 * `required`/`disabled` remain accepted synonyms so existing config/docs
 * that already spell it out in words keep working.
 */

export const ADMIN_TWO_FACTOR_ENFORCEMENT_ENV = "ADMIN_TWO_FACTOR_ENFORCEMENT";

export type TwoFactorEnforcementMode = "required" | "disabled";

/** Trimmed, lower-cased values that turn enforcement off. `false` is
 * canonical; `disabled` is an accepted synonym. */
const DISABLED_VALUES = new Set(["false", "disabled"]);

/**
 * Only the exact (trimmed, case-insensitive) value `"false"` — or its
 * accepted synonym `"disabled"` — turns 2FA off. Everything else — unset,
 * `"true"`, `"required"`, a typo, an unrelated truthy string like
 * `"1"`/`"yes"`/`"on"` — resolves to `"required"`. This is the inverse
 * failure direction from most flags in `src/lib/flags/feature-flags.ts`:
 * those are *enable* flags that fail safe by staying off on an unrecognized
 * value; this is an *enforcement* flag that must fail safe by staying ON
 * (required) on an unrecognized value.
 */
export function readTwoFactorEnforcement(
  env: NodeJS.ProcessEnv = process.env,
): TwoFactorEnforcementMode {
  const raw = env[ADMIN_TWO_FACTOR_ENFORCEMENT_ENV];
  const normalized = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (DISABLED_VALUES.has(normalized)) {
    return "disabled";
  }
  return "required";
}

export function isTwoFactorEnforced(env: NodeJS.ProcessEnv = process.env): boolean {
  return readTwoFactorEnforcement(env) === "required";
}

let hasWarnedTwoFactorDisabled = false;

/**
 * Logs the disabled-2FA warning at most once per process. Intended to run
 * from a startup path — see `scripts/two-factor-enforcement-preflight.ts`,
 * invoked by `scripts/start-web.sh` before `node server.js` — not from a
 * per-request guard, which would either spam the log on every admin action
 * or (if also latched) make the "once" behaviour depend on which request
 * happened to run first.
 */
export function warnTwoFactorDisabledOnce(env: NodeJS.ProcessEnv = process.env): void {
  if (hasWarnedTwoFactorDisabled) return;
  if (readTwoFactorEnforcement(env) !== "disabled") return;
  hasWarnedTwoFactorDisabled = true;
  console.error(
    "[auth] ADMIN_TWO_FACTOR_ENFORCEMENT=disabled — 2FA 未强制，仅允许本地 UAT；生产必须 required",
  );
}

/** Test-only: resets the once-per-process warning latch between test cases. */
export function resetTwoFactorDisabledWarningForTests(): void {
  hasWarnedTwoFactorDisabled = false;
}
