"use client";

import { useEffect, useId, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";

import { useLocale, useT } from "@/lib/locale/messages/MessagesProvider";
import {
  listPublishableLocales,
  SITE_LOCALE_NATIVE_NAMES,
  SITE_LOCALES,
  type SiteLocale,
} from "@/lib/locale/locale-canonical";
import { localePrefix } from "@/lib/slug/article-path";

/**
 * Public-site language switcher.
 *
 * WO-2 (`施工工单_WO1-3_多语种公开站地基_2026-09-08.md` §8.3): ported from CPS
 * `src/components/site/locale-switcher.tsx` (297 lines) — same pure
 * strip/build/sanitize functions, same same-origin href guard, same menu
 * semantics (`role="menu"`/`menuitem`, `aria-current`, `aria-haspopup`,
 * `aria-expanded`, `useId()`-built `aria-controls`, Esc closes and returns
 * focus to the trigger, an outside click closes). Two things are
 * deliberately NOT ported, per the work order:
 *
 * - No `NEXT_LOCALE` cookie. This site has none today; adding one here
 *   would be a real behavior change to the English site and would touch
 *   the cache layer, neither of which this round is scoped to do.
 * - No `HIDDEN_LOCALES` second table and no drama/article same-page
 *   sibling lookup. The site's OPEN locale set (`listPublishableLocales()`)
 *   already *is* the "what's selectable" answer — building a second,
 *   narrower list on top of it would be exactly the kind of second gate
 *   Owner correction two forbids (`locale-canonical.ts`'s `PUBLISHABLE_LOCALES`
 *   / `isPublishableLocale` / `listPublishableLocales` is read by routing,
 *   sitemap, hreflang, IndexNow, and this switcher — one set, no bypass).
 *   A per-page "does the target locale even have this page" downgrade
 *   prompt is out of scope until a second locale actually opens.
 */

// Native self-names ("Français", "日本語", …) live in `locale-canonical.ts`
// as `SITE_LOCALE_NATIVE_NAMES` — not defined here — for two reasons that
// are both existing, pre-WO-2 repo guards, not new rules invented for this
// component: (1) `tests/ui/locale-canonical.test.ts`'s "no second locale
// mapping table" scan flags any other `const ...LOCALE... = {...}`-shaped
// declaration outside that one file; (2) `tests/ui/public-copy-cjk.test.ts`
// scans this whole `src/features/public-ui` tree for hardcoded non-English
// characters, which the ja/ko/zh-Hant native names would trip. Both guards
// exempt `locale-canonical.ts` by design.

const BLOCKED_HREF_PARTS = ["localhost", "127.0.0.1", "0.0.0.0", ":3000"];
/** Recognized path-prefix codes for `stripLocalePrefix` below — the full registered set (`SITE_LOCALES`), not the narrower open/publishable one; see that function's own doc comment for why. */
const RECOGNIZED_PATH_PREFIXES = new Set<string>(SITE_LOCALES);

function normalizePathname(pathname: string): string {
  if (!pathname) return "/";
  return pathname.startsWith("/") ? pathname : `/${pathname}`;
}

/**
 * Strips a recognized locale-shaped prefix off `pathname`, if present.
 * Recognition uses the full REGISTERED locale set (`SITE_LOCALES`, D-8's
 * URL shape for all 15), not the narrower open/publishable set — this is
 * parsing, not a servability decision, and a link built from the result is
 * always re-prefixed against the caller's OWN target locale afterward, so a
 * broader recognition set here cannot widen what ends up rendered.
 *
 * `decodeURIComponent` throws a `URIError` on a malformed percent-escape
 * (`/%zz`, a truncated `/%E0%A4%A`) — this runs on every render (`usePathname()`
 * feeds straight into `buildLocaleSwitchHref` below, called once per menu
 * item), so a malformed segment must never crash the switcher. Caught and
 * treated exactly like "not a recognized locale prefix": no prefix
 * stripped, the raw path passes through untouched.
 */
export function stripLocalePrefix(pathname: string): string {
  const normalized = normalizePathname(pathname);
  const [, firstSegment = "", ...rest] = normalized.split("/");
  let decodedFirstSegment: string;
  try {
    decodedFirstSegment = decodeURIComponent(firstSegment);
  } catch {
    return normalized;
  }
  if (!RECOGNIZED_PATH_PREFIXES.has(decodedFirstSegment)) {
    return normalized;
  }
  return rest.length > 0 ? `/${rest.join("/")}` : "/";
}

/**
 * Same-origin guard for a switcher href. Anything that isn't a bare
 * site-relative path — protocol-relative (`//host`), an explicit scheme
 * (`javascript:`, `https:`, ...), or containing one of the blocked
 * host/port substrings — collapses to `/` rather than being used verbatim.
 */
export function sanitizePathOnlyHref(href: string): string {
  const lowerHref = href.toLowerCase();
  const hasBlockedPart = BLOCKED_HREF_PARTS.some((part) => lowerHref.includes(part));
  if (!href.startsWith("/") || href.startsWith("//") || /^[a-z][a-z\d+\-.]*:/i.test(href) || hasBlockedPart) {
    return "/";
  }
  return href;
}

/**
 * Builds the switch-to-`target`-locale href for the current `pathname`
 * (+ optional `search`), reusing `localePrefix` (the site's sole
 * prefix-building rule) rather than re-deriving the as-needed scheme here.
 * The root path is special-cased so switching to a non-`en` target from
 * `/` produces `/{target}`, not `/{target}/` (`localePrefix` + a bare `/`
 * suffix would otherwise double up the slash).
 */
export function buildLocaleSwitchHref(pathname: string, target: SiteLocale, search?: string): string {
  const bare = stripLocalePrefix(pathname);
  const prefix = localePrefix(target);
  const withPrefix = bare === "/" ? prefix || "/" : `${prefix}${bare}`;
  return sanitizePathOnlyHref(`${withPrefix}${search ?? ""}`);
}

export function LocaleSwitcher() {
  // Deliberately checked BEFORE any hook runs (see the file-level comment on
  // why: `usePathname()` needs real App Router context, which existing
  // tests that render `SiteHeader`/`SiteShell` do not provide — and don't
  // need to, since `listPublishableLocales()` returns a single entry
  // (`["en"]"`) in every one of them today). Safe under the rules of hooks
  // because this early return does not change between renders of the same
  // mounted instance: `PUBLISHABLE_LOCALES` is a module-level constant.
  const selectable = listPublishableLocales();
  if (selectable.length <= 1) return null;
  return <LocaleSwitcherMenu selectable={selectable} />;
}

function LocaleSwitcherMenu({ selectable }: { selectable: readonly SiteLocale[] }) {
  const t = useT();
  const locale = useLocale();
  const pathname = usePathname();
  const router = useRouter();
  const menuId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [isOpen, setIsOpen] = useState(false);

  useEffect(() => {
    if (!isOpen) return;

    function handlePointerDown(event: MouseEvent) {
      if (!rootRef.current?.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setIsOpen(false);
        triggerRef.current?.focus();
      }
    }

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [isOpen]);

  /**
   * `window.location.search` is deliberately NOT read here, in the render
   * body — CPS's own switcher (`src/components/site/locale-switcher.tsx`'s
   * `switchLocale`) never touches `location` synchronously during render
   * either, only inside its click handler. Reading it here would also be a
   * real hydration bug: `window` is undefined during the server render (so
   * the SSR'd `href`s never carry a query string), but defined on the very
   * first CLIENT render of this "use client" component, so any real query
   * string would make that first client render's `href`s disagree with
   * what the server sent — a genuine markup mismatch, not just an SSR
   * fallback that later catches up. `handleSwitchClick` below reads it
   * fresh at click time instead, when there is no server/client value to
   * disagree with.
   */
  function handleSwitchClick(event: ReactMouseEvent<HTMLAnchorElement>, target: SiteLocale) {
    setIsOpen(false);
    // Let the browser handle its own default gesture (open in new tab/
    // window, "save link as", etc.) untouched — only a plain, unmodified
    // left click gets the query-string-preserving override below.
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
      return;
    }
    const search = window.location.search;
    if (!search) return; // the rendered href is already correct with no query string
    event.preventDefault();
    router.push(buildLocaleSwitchHref(pathname ?? "/", target, search));
  }

  return (
    <div ref={rootRef} className="relative inline-flex">
      <button
        ref={triggerRef}
        type="button"
        aria-label={t("nav.language")}
        aria-haspopup="menu"
        aria-expanded={isOpen}
        aria-controls={menuId}
        onClick={() => setIsOpen((open) => !open)}
        className="inline-flex items-center gap-1.5 rounded-novel-md border border-novel-border-strong bg-transparent px-3 py-1.5 text-sm text-novel-fg-muted transition-colors hover:bg-novel-bg-raised hover:text-novel-fg"
      >
        <span>{SITE_LOCALE_NATIVE_NAMES[locale]}</span>
        <svg
          width="12"
          height="12"
          viewBox="0 0 20 20"
          fill="none"
          aria-hidden="true"
          className={`transition-transform ${isOpen ? "rotate-180" : ""}`}
        >
          <path d="M5 7.5l5 5 5-5" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {isOpen ? (
        <div
          id={menuId}
          role="menu"
          aria-orientation="vertical"
          className="absolute right-0 top-full z-50 mt-2 min-w-[10rem] rounded-novel-md border border-novel-border bg-novel-bg-raised p-1 shadow-lg"
        >
          {selectable.map((item) => {
            const isCurrent = item === locale;
            return (
              <Link
                key={item}
                role="menuitem"
                aria-current={isCurrent ? "true" : undefined}
                href={buildLocaleSwitchHref(pathname ?? "/", item)}
                onClick={(event) => handleSwitchClick(event, item)}
                className={`block w-full rounded-novel-sm px-3 py-2 text-left text-sm transition-colors ${
                  isCurrent
                    ? "bg-novel-bg text-novel-primary"
                    : "text-novel-fg-muted hover:bg-novel-bg hover:text-novel-fg"
                }`}
              >
                {SITE_LOCALE_NATIVE_NAMES[item]}
              </Link>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
