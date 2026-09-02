import { isPublicTrackingWriteDisabled } from "@/lib/flags";

/**
 * Bot user-agent filter for `/go` redirect tracking. Copied verbatim from CPS
 * `isObviousBotUserAgent` (`src/lib/cps-tracking.ts:287-291`, v8.3.6
 * `16f2e4cfca51f46af0dede899ecf6242a770bbd0`) — identical regex, identical
 * case-insensitive flag, identical token list. It only catches obvious,
 * self-identifying bots (crawlers, previewers, CLI fetchers); it is not a
 * general bot classifier and makes no attempt to catch UA-spoofing scrapers.
 */
const BOT_USER_AGENT_PATTERN =
  /bot|crawler|spider|slurp|bingpreview|facebookexternalhit|whatsapp|telegrambot|curl|wget/i;

export function isObviousBotUserAgent(userAgent: string): boolean {
  return BOT_USER_AGENT_PATTERN.test(userAgent);
}

export interface ShouldRecordGoRedirectInput {
  /** Defaults to `process.env`; injectable for tests. */
  env?: NodeJS.ProcessEnv;
  userAgent: string | null;
}

/**
 * RC-6: decides whether `GET /go/[code]` should attempt a `TrackingEvent`
 * write for this request. Ported from the write-gate + bot-UA checks at the
 * top of CPS `safeRecordTrackingEvent` (`src/lib/cps-tracking.ts:108-127`,
 * v8.3.6 `16f2e4cfca51f46af0dede899ecf6242a770bbd0`): write gate is checked
 * first, then the bot user-agent. CPS's other checks in that function
 * (accepted event types, rate limiting) and its cookie/session/visitor
 * identity model are explicitly out of scope for RC-6 — see
 * `docs/governance/port-registry.md`.
 *
 * This function only ever decides *whether a write is attempted* — it has no
 * say in the redirect's 302/404 outcome or target URL, which the caller
 * already resolved before this is consulted. A missing user-agent is treated
 * like CPS treats it (`meta.userAgent ?? ""`): the empty string never matches
 * the bot pattern, so an absent UA is not filtered.
 */
export function shouldRecordGoRedirect({ env = process.env, userAgent }: ShouldRecordGoRedirectInput): boolean {
  if (isPublicTrackingWriteDisabled(env)) return false;
  if (isObviousBotUserAgent(userAgent ?? "")) return false;
  return true;
}
