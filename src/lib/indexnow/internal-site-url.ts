/**
 * Absolute-URL helper, private to `src/lib/indexnow/`.
 *
 * Ported ADAPT from CPS `src/lib/site-url.ts` (26 lines, `getSiteUrl`/
 * `toAbsoluteUrl`). The P2-11 audit flags `site-url.ts` as a
 * SHARED_PORT_CANDIDATE owned by Stream C/P2-09 (`P2-07-12-移植审计-2026-08-12/
 * P2-11.md` §9), and Stream C has not landed in this worktree yet. Rather
 * than create `src/lib/seo/site-url.ts` (a directory this Stream does not
 * own and Stream C has not shipped) or block on Stream C, this file is a
 * deliberately narrow, private duplicate scoped to exactly what IndexNow URL
 * construction needs. **Do not import this from outside `src/lib/indexnow/`
 * — when Stream C's shared `site-url.ts` lands, `outbox.ts`/`eligibility.ts`
 * should switch to it and this file should be deleted; that consolidation is
 * flagged to the round's integrator, not done here (`不改...其他 Stream 的任何
 * 文件`).**
 *
 * 🔴 Merge-review correction (`scratchpad/reports/E-REVIEW.md` §4c, the
 * round's one CHANGES_REQUIRED item): this file's validation now matches,
 * field-for-field, the already-merged Stream B/D version
 * (`src/lib/seo/seo-templates/_shared.ts`'s `getSiteUrl`, integration branch
 * `a0148cf`) rather than CPS's original `getSiteUrl`/`toAbsoluteUrl`. The
 * original CPS-parity version (a) accepted `NEXT_PUBLIC_SITE_URL` as a
 * fallback, and (b) fell back to a hardcoded default when neither env var
 * was set — CPS's own production domain, `https://enpulsedrama.com`, which
 * this project does not own. That fallback value flows straight into
 * `buildIndexNowCanonicalUrl` and from there into `indexnow_outbox.url`,
 * which is half of this table's `(url, revision)` idempotent identity
 * (`docs/governance/database-governance.md` §6). A worker environment
 * missing `SITE_URL` would have silently submitted
 * `https://enpulsedrama.com/novel/...` to IndexNow using *this* project's
 * key — a live external request naming a domain this project does not
 * control — and, once discovered, fixing `SITE_URL` afterward would not
 * self-heal: the already-submitted rows keep their wrong `url`, and the
 * correctly-configured retry produces a *different* row rather than
 * correcting the old one. Stream B already made and registered the decision
 * this file must match: no default domain, `SITE_URL` only, fail closed.
 */

export class IndexNowSiteUrlConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IndexNowSiteUrlConfigurationError";
  }
}

/**
 * Semantics deliberately identical to Stream B's `getSiteUrl`
 * (`src/lib/seo/seo-templates/_shared.ts`): only `SITE_URL` (no
 * `NEXT_PUBLIC_SITE_URL` fallback), must parse as an absolute HTTP(S) origin
 * with no credentials/path/query/fragment, and throws rather than
 * substituting any default when missing or malformed. No env var configured
 * (or a malformed one) must be a loud, immediate failure here — never a
 * silently-wrong URL that gets written into `indexnow_outbox`.
 */
function siteUrlOrigin(env: Readonly<{ SITE_URL?: string }> = { SITE_URL: process.env.SITE_URL }): string {
  const raw = env.SITE_URL?.trim();
  if (!raw) {
    throw new IndexNowSiteUrlConfigurationError("SITE_URL must be configured");
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new IndexNowSiteUrlConfigurationError("SITE_URL must be an absolute HTTP(S) origin");
  }

  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  ) {
    throw new IndexNowSiteUrlConfigurationError(
      "SITE_URL must be an absolute HTTP(S) origin without credentials, path, query, or fragment",
    );
  }

  return parsed.origin;
}

/** Absolutizes a site-relative path (`/novel/...`). Already-absolute `http(s)://` input passes through unchanged (still requires a configured `SITE_URL` for the relative-path branch). */
export function toAbsoluteSiteUrl(path: string, env: NodeJS.ProcessEnv = process.env): string {
  if (/^https?:\/\//i.test(path)) return path;
  const normalized = path.startsWith("/") ? path : `/${path}`;
  return `${siteUrlOrigin({ SITE_URL: env.SITE_URL })}${normalized}`;
}
