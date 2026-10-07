import { describeAdminLoginTurnstileStartup } from "../src/lib/auth/admin-login-turnstile";

// B-39: runs once when the web container starts, before it begins serving
// traffic (see scripts/start-web.sh). Non-fatal by design -- the same shape as
// two-factor-enforcement-preflight.ts, and unlike credential-secret-preflight.ts
// it never blocks startup: web also serves the public site, and a Turnstile
// misconfiguration must degrade only the admin login (which then refuses every
// attempt, fail-closed, see src/lib/auth/admin-login-turnstile.ts), never take
// the public pages down. The deployment preflight
// (scripts/preproduction/preflight.sh) is where a bad config is meant to be
// caught; this line only makes the state visible in the boot log.
//
// Silent when ADMIN_LOGIN_TURNSTILE_ENABLED is not exactly "true", so a host
// with the switch off boots with an unchanged log. Never prints a key value.
const line = describeAdminLoginTurnstileStartup();
if (line) console.error(line);
