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
 * `<LocaleSwitcher />` renders NOTHING. That is what makes "the English
 * site's visible header structure is unchanged by this work order" true.
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
