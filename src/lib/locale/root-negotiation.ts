/**
 * Root-path (`/`) locale negotiation — L10N P4 (矩阵 #9).
 *
 * `COPY` from CPS `3a76877:src/i18n/root-negotiation.ts` (the whole file:
 * `parseAcceptLanguage`, `matchHeaderLocale`, `negotiateRootLocale` — bot UA
 * exclusion, `NEXT_LOCALE` cookie priority, `@formatjs/intl-localematcher`
 * fallback, 307 redirect + `Set-Cookie`). Adapted only where this project's
 * locale plumbing has different names than CPS's `next-intl`-routing-based
 * one: `isSupportedLocale`/`locales`/`routing.defaultLocale`
 * (`3a76877:src/i18n/routing.ts`) become `SITE_LOCALES` membership /
 * `SITE_LOCALES` / `PUBLIC_SITE_LOCALE`. Cookie `maxAge`/`path`/`sameSite`
 * are copied verbatim from `3a76877:src/i18n/routing.ts:6-25`'s
 * `localeCookie` config (`{ maxAge: 60 * 60 * 24 * 365, path: "/", sameSite:
 * "lax" }`) — this project has no `next-intl` `routing` object to read that
 * config from directly, so the three literal values are reproduced here
 * instead.
 *
 * Only ever called from `src/proxy.ts`, and only when the request's host is
 * the PUBLIC site host (never the admin host) — `proxy.ts` itself enforces
 * that gate before calling in, this module has no host awareness of its own.
 */
import { match } from "@formatjs/intl-localematcher";
import { NextResponse, type NextRequest } from "next/server";

import { SITE_LOCALES, type SiteLocale } from "./locale-canonical";
import { PUBLIC_SITE_LOCALE } from "@/lib/site/locale-label";

const BOT_UA_RE = /bot|crawler|spider/i;
const COOKIE_NAME = "NEXT_LOCALE";
const COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

function isSiteLocale(value: string | undefined | null): value is SiteLocale {
  return typeof value === "string" && (SITE_LOCALES as readonly string[]).includes(value);
}

function parseAcceptLanguage(header: string): string[] {
  return header
    .split(",")
    .map((part) => {
      const [tag, ...params] = part.trim().split(";");
      const q = params.find((param) => param.trim().startsWith("q="));
      return { tag, q: q ? Number(q.split("=")[1]) : 1 };
    })
    .filter(({ tag, q }) => tag && tag !== "*" && Number.isFinite(q) && q > 0)
    .sort((a, b) => b.q - a.q)
    .map(({ tag }) => tag);
}

function matchHeaderLocale(header: string | null): SiteLocale | null {
  if (!header) return null;
  try {
    const locale = match(parseAcceptLanguage(header), [...SITE_LOCALES], PUBLIC_SITE_LOCALE);
    return isSiteLocale(locale) ? locale : null;
  } catch {
    return null;
  }
}

/**
 * Returns a redirect response for the root path when negotiation resolves a
 * non-default locale, or `null` when the caller should fall through to
 * normal routing (not the root path, a bot UA, no signal, or the resolved
 * locale is already the default `en`).
 */
export function negotiateRootLocale(request: NextRequest): NextResponse | null {
  if (request.nextUrl.pathname !== "/") return null;
  if (BOT_UA_RE.test(request.headers.get("user-agent") ?? "")) return null;

  const cookieLocale = request.cookies.get(COOKIE_NAME)?.value;
  const locale = isSiteLocale(cookieLocale)
    ? cookieLocale
    : matchHeaderLocale(request.headers.get("accept-language"));

  if (!locale || locale === PUBLIC_SITE_LOCALE) return null;

  const url = request.nextUrl.clone();
  url.pathname = `/${locale}`;
  const response = NextResponse.redirect(url, 307);
  response.cookies.set(COOKIE_NAME, locale, {
    path: "/",
    maxAge: COOKIE_MAX_AGE,
    sameSite: "lax",
  });
  return response;
}
