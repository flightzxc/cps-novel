import { warnTwoFactorDisabledOnce } from "../src/lib/auth/two-factor-enforcement";

// RC-10: runs once when the web container starts, before it begins serving
// traffic (see scripts/start-web.sh). Non-fatal -- unlike
// credential-secret-preflight.ts this never blocks startup, it only makes
// the disabled-2FA state visible in the boot log exactly once per process,
// mirroring warnTwoFactorDisabledOnce's own once-per-process latch. Logs
// nothing when enforcement is "required" (the fail-closed default).
warnTwoFactorDisabledOnce();
