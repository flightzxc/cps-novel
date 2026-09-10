import { describe, expect, it, vi, beforeEach } from "vitest";

const revalidatePath = vi.fn();
const revalidateTag = vi.fn();
vi.mock("next/cache", () => ({
  revalidatePath: (...args: unknown[]) => revalidatePath(...args),
  revalidateTag: (...args: unknown[]) => revalidateTag(...args),
}));

import {
  revalidatePublicArticlePaths,
  revalidatePublicArticleSet,
  revalidatePublicBlogPaths,
  revalidatePublicListings,
} from "@/server/publication/revalidate";
import { ACTIVE_LOCALES_CACHE_TAG } from "@/lib/locale/active-locales-tag";

describe("revalidatePublicListings", () => {
  beforeEach(() => {
    revalidatePath.mockClear();
    revalidateTag.mockClear();
  });

  it("revalidates the home page and the browse listing, nothing else", () => {
    revalidatePublicListings();
    expect(revalidatePath.mock.calls).toEqual([["/"], ["/browse"]]);
  });

  it("L10N P4: also revalidates the active-locales cache tag — the existing publish-state broadcast point, not a new mechanism", () => {
    revalidatePublicListings();
    expect(revalidateTag).toHaveBeenCalledExactlyOnceWith(ACTIVE_LOCALES_CACHE_TAG, { expire: 0 });
    expect(ACTIVE_LOCALES_CACHE_TAG).toBe("active-locales");
  });
});

describe("revalidatePublicArticlePaths", () => {
  beforeEach(() => {
    revalidatePath.mockClear();
    revalidateTag.mockClear();
  });

  it("revalidates listings, the article detail page, and the whole chapter subtree as a layout", () => {
    revalidatePublicArticlePaths({ locale: "en", slug: "dragon-throne", shortId: "abc123" });
    expect(revalidatePath.mock.calls).toEqual([
      ["/"],
      ["/browse"],
      ["/novel/dragon-throne-pabc123"],
      ["/novel/dragon-throne-pabc123/chapter", "layout"],
    ]);
    expect(revalidateTag).toHaveBeenCalledExactlyOnceWith(ACTIVE_LOCALES_CACHE_TAG, { expire: 0 });
  });

  it("URL-encodes a slug that needs it, matching buildArticleRoutePath", () => {
    revalidatePublicArticlePaths({ locale: "en", slug: "a b", shortId: "xyz" });
    expect(revalidatePath).toHaveBeenCalledWith("/novel/a%20b-pxyz");
    expect(revalidatePath).toHaveBeenCalledWith("/novel/a%20b-pxyz/chapter", "layout");
  });
});

// L10N P4 review fix (n3): `revalidatePublicBlogPaths` used to always
// construct the `en` path (`buildBlogPath({ locale: PUBLIC_SITE_LOCALE, ...
// })`) regardless of the post's own locale, even though blog creation
// (`src/server/content-creation/blog.ts`'s `requireLocale`) accepts every
// `SITE_LOCALES` member. It now reads `locale` off its input.
describe("revalidatePublicBlogPaths", () => {
  beforeEach(() => {
    revalidatePath.mockClear();
    revalidateTag.mockClear();
  });

  it("invalidates /{locale}/blog/{slug} and the /blog list page for a ru post", () => {
    revalidatePublicBlogPaths({ slug: "a-blog-post", locale: "ru" });
    expect(revalidatePath.mock.calls).toEqual([["/ru/blog/a-blog-post"], ["/blog"]]);
  });

  it("invalidates the bare /blog/{slug} path for an en post", () => {
    revalidatePublicBlogPaths({ slug: "a-blog-post", locale: "en" });
    expect(revalidatePath.mock.calls).toEqual([["/blog/a-blog-post"], ["/blog"]]);
  });

  // Sole production caller today (`publish-gate/service.ts:507`, out of this
  // round's edit surface — see this function's own doc comment) still omits
  // `locale` entirely; this must keep behaving exactly as it did before this
  // fix (en) rather than throwing or drifting, until that one-line follow-up
  // lands.
  it("falls back to en when locale is omitted, matching the pre-fix default", () => {
    revalidatePublicBlogPaths({ slug: "a-blog-post" });
    expect(revalidatePath.mock.calls).toEqual([["/blog/a-blog-post"], ["/blog"]]);
  });
});

describe("revalidatePublicArticleSet", () => {
  beforeEach(() => {
    revalidatePath.mockClear();
    revalidateTag.mockClear();
  });

  it("revalidates listings exactly once regardless of how many articles are affected", () => {
    revalidatePublicArticleSet([
      { locale: "en", slug: "one", shortId: "aaa" },
      { locale: "en", slug: "two", shortId: "bbb" },
    ]);
    const homeCalls = revalidatePath.mock.calls.filter((call) => call[0] === "/");
    const browseCalls = revalidatePath.mock.calls.filter((call) => call[0] === "/browse");
    expect(homeCalls).toHaveLength(1);
    expect(browseCalls).toHaveLength(1);
    expect(revalidatePath).toHaveBeenCalledWith("/novel/one-paaa");
    expect(revalidatePath).toHaveBeenCalledWith("/novel/one-paaa/chapter", "layout");
    expect(revalidatePath).toHaveBeenCalledWith("/novel/two-pbbb");
    expect(revalidatePath).toHaveBeenCalledWith("/novel/two-pbbb/chapter", "layout");
    expect(revalidateTag).toHaveBeenCalledExactlyOnceWith(ACTIVE_LOCALES_CACHE_TAG, { expire: 0 });
  });

  it("still revalidates listings when the article list is empty (a Novel-level change with no affected Articles)", () => {
    revalidatePublicArticleSet([]);
    expect(revalidatePath.mock.calls).toEqual([["/"], ["/browse"]]);
    expect(revalidateTag).toHaveBeenCalledExactlyOnceWith(ACTIVE_LOCALES_CACHE_TAG, { expire: 0 });
  });
});

describe("isolation: revalidatePath throwing outside a request-scoped context", () => {
  beforeEach(() => {
    revalidatePath.mockClear();
    revalidateTag.mockClear();
  });

  it("swallows a throw from any individual revalidatePath call and still attempts the rest", () => {
    revalidatePath.mockImplementation((path: string) => {
      if (path === "/") {
        throw new Error("Invariant: static generation store missing (simulated out-of-request-scope call)");
      }
    });
    expect(() =>
      revalidatePublicArticlePaths({ locale: "en", slug: "s", shortId: "id1" }),
    ).not.toThrow();
    // The "/" call threw and was swallowed, but every subsequent call in the
    // same broadcast still ran — one thrown path must not skip the rest.
    expect(revalidatePath.mock.calls).toEqual([
      ["/"],
      ["/browse"],
      ["/novel/s-pid1"],
      ["/novel/s-pid1/chapter", "layout"],
    ]);
  });

  it("swallows a throw from revalidateTag too, without blocking the path revalidations", () => {
    revalidateTag.mockImplementation(() => {
      throw new Error("Invariant: static generation store missing (simulated out-of-request-scope call)");
    });
    expect(() => revalidatePublicListings()).not.toThrow();
    expect(revalidatePath.mock.calls).toEqual([["/"], ["/browse"]]);
  });
});
