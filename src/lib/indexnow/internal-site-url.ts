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
 */

const DEFAULT_SITE_URL = "https://enpulsedrama.com";

function siteUrlBase(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.SITE_URL?.trim() || env.NEXT_PUBLIC_SITE_URL?.trim() || DEFAULT_SITE_URL;
  return raw.endsWith("/") ? raw.slice(0, -1) : raw;
}

/** Absolutizes a site-relative path (`/novel/...`). Already-absolute `http(s)://` input passes through unchanged. */
export function toAbsoluteSiteUrl(path: string, env: NodeJS.ProcessEnv = process.env): string {
  if (/^https?:\/\//i.test(path)) return path;
  const normalized = path.startsWith("/") ? path : `/${path}`;
  return `${siteUrlBase(env)}${normalized}`;
}
