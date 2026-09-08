import "./setup-cleanup";
import { describe, expect, it } from "vitest";

import {
  buildLocaleSwitchHref,
  LocaleSwitcher,
  sanitizePathOnlyHref,
  stripLocalePrefix,
} from "@/features/public-ui/layout/LocaleSwitcher";
import { renderWithMessages } from "./render-with-messages";

/**
 * WO-2 (`施工工单_WO1-3_多语种公开站地基_2026-09-08.md` §8.3): the public-site
 * language switcher. Ported from CPS `src/components/site/locale-switcher.tsx`
 * — same pure strip/build/sanitize functions, same same-origin href guard,
 * same menu semantics. Multi-locale rendering behavior (the dropdown, aria
 * semantics, Esc/click-outside) lives in the sibling file
 * `locale-switcher-multi-locale.test.tsx`, which needs to mock
 * `listPublishableLocales()` — `vi.mock` is hoisted to the top of its whole
 * file regardless of which `describe` block it's textually written in, so
 * that mock cannot coexist in the same file as this one's "renders nothing
 * against the REAL open locale set" assertion below without silently
 * applying to it too.
 *
 * 🔴 The single most load-bearing assertion in this file is the first one:
 * with the real (unmocked) `listPublishableLocales()` — today `["en"]` —
 * `<LocaleSwitcher />` itself renders NOTHING. That is what makes the
 * English site's rendered CONTENT unchanged by this work order.
 *
 * Accepted DOM change (part of the WO-2 commit message's own accepted-DOM-
 * change list, alongside `<html dir="ltr">`): `SiteHeader.tsx` now
 * unconditionally wraps its desktop `<nav>` and this switcher's slot (empty
 * here) in one `<div className="flex items-center gap-3">`, which replaces
 * `<nav>` as `Container`'s direct flex child. A div wrapping a single child
 * changes no visible layout — `Container`'s own `justify-between` still
 * sees the same three top-level items (brand, this wrapper, the mobile
 * toggle) — but it IS a real, permanent addition to the DOM tree, present
 * regardless of how many locales are open, not something this file's
 * "renders NOTHING" assertion covers or contradicts.
 */
describe("LocaleSwitcher — renders null while only one locale is open", () => {
  it("renders no DOM at all against the real, unmocked open locale set", () => {
    const { container } = renderWithMessages(<LocaleSwitcher />);
    expect(container.innerHTML).toBe("");
  });
});

describe("stripLocalePrefix / sanitizePathOnlyHref / buildLocaleSwitchHref — pure functions", () => {
  it("strips a recognized locale-shaped prefix", () => {
    expect(stripLocalePrefix("/es/browse")).toBe("/browse");
    expect(stripLocalePrefix("/pt-BR/novel/x-pabc123")).toBe("/novel/x-pabc123");
    expect(stripLocalePrefix("/es")).toBe("/");
    expect(stripLocalePrefix("/es/")).toBe("/");
  });

  it("leaves a bare path untouched", () => {
    expect(stripLocalePrefix("/browse")).toBe("/browse");
    expect(stripLocalePrefix("/")).toBe("/");
    expect(stripLocalePrefix("")).toBe("/");
  });

  it("does not strip a path that merely resembles a locale prefix", () => {
    expect(stripLocalePrefix("/enterprise")).toBe("/enterprise");
  });

  it("treats a malformed percent-escape as no prefix, rather than throwing", () => {
    // `decodeURIComponent("%zz")` throws a `URIError` ("URI malformed") —
    // this must not crash the switcher on render; it falls back to the
    // normalized, unstripped path, same as any other unrecognized segment.
    expect(stripLocalePrefix("/%zz")).toBe("/%zz");
    expect(stripLocalePrefix("/%zz/browse")).toBe("/%zz/browse");
    expect(() => stripLocalePrefix("/%zz")).not.toThrow();

    // A truncated escape sequence at the end of the segment throws for the
    // same reason ("%E0" needs two more hex digits after it).
    expect(stripLocalePrefix("/%E0%A4%A")).toBe("/%E0%A4%A");
    // `buildLocaleSwitchHref` composes on top of `stripLocalePrefix`, so the
    // malformed segment is treated as ordinary path content, not a prefix
    // to replace — it survives, prefixed with the target locale.
    expect(buildLocaleSwitchHref("/%zz", "es")).toBe("/es/%zz");
    expect(() => buildLocaleSwitchHref("/%zz", "es")).not.toThrow();
  });

  it("sanitizePathOnlyHref collapses anything off-origin or non-path-relative to /", () => {
    expect(sanitizePathOnlyHref("/browse")).toBe("/browse");
    expect(sanitizePathOnlyHref("//evil.com")).toBe("/");
    expect(sanitizePathOnlyHref("javascript:alert(1)")).toBe("/");
    expect(sanitizePathOnlyHref("https://evil.com")).toBe("/");
    expect(sanitizePathOnlyHref("/go?x=http://localhost/y")).toBe("/");
    expect(sanitizePathOnlyHref("http://example.com:3000/y")).toBe("/");
    expect(sanitizePathOnlyHref("browse")).toBe("/");
  });

  it("buildLocaleSwitchHref prefixes for a non-default target and strips any existing prefix first", () => {
    expect(buildLocaleSwitchHref("/browse", "es")).toBe("/es/browse");
    expect(buildLocaleSwitchHref("/es/browse", "fr")).toBe("/fr/browse");
    expect(buildLocaleSwitchHref("/es/browse", "en")).toBe("/browse");
  });

  it("special-cases the root path so switching locale never doubles the slash", () => {
    expect(buildLocaleSwitchHref("/", "es")).toBe("/es");
    expect(buildLocaleSwitchHref("/", "en")).toBe("/");
    expect(buildLocaleSwitchHref("/es", "en")).toBe("/");
  });

  it("preserves the query string", () => {
    expect(buildLocaleSwitchHref("/browse", "es", "?page=2")).toBe("/es/browse?page=2");
  });
});
