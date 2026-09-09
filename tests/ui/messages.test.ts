import { afterEach, describe, expect, it, vi } from "vitest";

// WO-3 §10.1/§10.4 (Owner 修正一): `loadMessages` deep-merges onto English
// instead of throwing on an incomplete catalog. The real `es.ts` shipped in
// this repo is now a complete 98-key catalog (see `tests/ui/messages-
// completeness.test.ts`), so to exercise the *fallback* path itself — a
// missing key, and a key whose value is an empty/whitespace string — this
// mocks the `es` catalog module with a small, deliberately incomplete
// fixture. This only affects this test file's module graph.
vi.mock("@/lib/locale/messages/es", () => ({
  default: {
    nav: {
      home: "Inicio",
      // "browse" intentionally omitted → falls back to English "All works".
      footerNote: "   ", // whitespace-only → treated as missing, not as a value.
    },
    // Every other namespace (novel, chapter, collection, ...) is entirely
    // absent from this fixture → every leaf under them falls back to English.
  },
}));

import {
  loadMessages,
  MissingMessagesError,
  resetMessagesCacheForTests,
  t,
} from "@/lib/locale/messages";
import { en } from "@/lib/locale/messages/en";

describe("loadMessages", () => {
  it("loads the complete English catalog", () => {
    expect(loadMessages("en")).toBe(en);
    expect(t(loadMessages("en"), "nav.home")).toBe("Home");
  });

  it("interpolates dotted keys", () => {
    expect(t(loadMessages("en"), "novel.coverAlt", { title: "Lantern" })).toBe("Cover of Lantern");
    expect(t(loadMessages("en"), "home.slideStatus", { n: 2, count: 4, title: "Lantern" })).toBe(
      "Work 2 of 4: Lantern",
    );
  });

  it("throws on a missing key instead of returning the key", () => {
    expect(() => t(loadMessages("en"), "nav.missing" as never)).toThrow(MissingMessagesError);
  });

  it("loadMessages(\"en\") returns the en module object itself (reference equality)", () => {
    expect(loadMessages("en")).toBe(en);
  });

  it("deep-merges an incomplete locale onto English instead of throwing (Owner 修正一)", () => {
    // A complete catalog's own values win.
    expect(() => loadMessages("es")).not.toThrow();
    const es = loadMessages("es");
    expect(t(es, "nav.home")).toBe("Inicio");
  });

  it("falls back to English for a key missing from the target locale, keeping the rest of the locale", () => {
    const es = loadMessages("es");
    expect(t(es, "nav.browse")).toBe("All works");
    // Sibling key from the same namespace still uses the target locale.
    expect(t(es, "nav.home")).toBe("Inicio");
  });

  it("treats an empty/whitespace-only value in the target locale as missing and falls back to English", () => {
    const es = loadMessages("es");
    expect(t(es, "nav.footerNote")).toBe(
      "This site offers free preview chapters. The full story is on the original platform.",
    );
  });

  it("falls back wholesale to English for a namespace the target locale never touched", () => {
    const es = loadMessages("es");
    expect(t(es, "chapter.theme")).toBe("Theme");
    expect(t(es, "collection.workCount", { count: 3 })).toBe("3 works");
  });
});

/**
 * 低危清扫第 1 批 · item D-③: `mergedMessagesCache` only memoizes under
 * `NODE_ENV === "production"` — everywhere else (this test file's ambient
 * `NODE_ENV=test` included) `loadMessages` recomputes on every call, so a
 * locale file edited during `next dev` shows up without a server restart.
 * `resetMessagesCacheForTests` is the escape hatch for a test that needs to
 * exercise the memoized branch without leaking a production-stubbed merge
 * into whichever test runs next.
 */
describe("loadMessages caching (低危清扫第 1 批, item D-③)", () => {
  afterEach(() => {
    resetMessagesCacheForTests();
    vi.unstubAllEnvs();
  });

  it("outside production (the ambient test env), every call recomputes — no shared cache entry", () => {
    expect(process.env.NODE_ENV).not.toBe("production");
    const first = loadMessages("es");
    const second = loadMessages("es");
    expect(first).not.toBe(second); // distinct objects — not served from a cache
    expect(first).toEqual(second); // same merged content regardless
  });

  it("under NODE_ENV=production, repeated calls are served from the memoized cache", () => {
    vi.stubEnv("NODE_ENV", "production");
    resetMessagesCacheForTests();
    const first = loadMessages("es");
    const second = loadMessages("es");
    expect(first).toBe(second); // same object — the memoized fast path
  });

  it("resetMessagesCacheForTests clears a production-memoized entry instead of leaking it", () => {
    vi.stubEnv("NODE_ENV", "production");
    const cachedBefore = loadMessages("es");
    resetMessagesCacheForTests();
    const afterReset = loadMessages("es");
    expect(afterReset).not.toBe(cachedBefore); // recomputed, not the stale cached object
    expect(afterReset).toEqual(cachedBefore); // content is still identical
  });

  it("loadMessages(\"en\") always returns the en module object itself, in production or not", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(loadMessages("en")).toBe(en);
  });
});
