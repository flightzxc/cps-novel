import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { NovelDetailView } from "@/features/public-ui/types";
import { buildArticlePath, decodeSlugParam } from "@/lib/slug/article-path";

/**
 * X8 轮 2f 阻塞①②的回归覆盖（`l10n-uat-progress.md` 轮 2f 小节）。
 *
 * ① 非 ASCII slug 详情页 404：`src/app/[locale]/novel/[slugParam]/page.tsx`
 * 是 `force-dynamic`（非 SSG）App Router 页面。用固定的 `next@16.1.6`
 * （`output: "standalone"`）真实构建 + `node server.js` 直连实测确认：
 * Next 对这种非 SSG 动态段的解码不是"全都不做"：ASCII 百分号转义会被规范化
 * 解码，只有非 ASCII 转义原样到达——`params.slugParam`（本例的西里尔文
 * slug）到达页面时仍是百分号编码原文（例如 82 字符的 `%D1%82%D0%B0...`，
 * 而不是 57 字符的解码后西里尔文本）。`node_modules/next/dist/server/lib/
 * router-utils/decode-path-params.js` 自己的头注释印证了这一点："We only encode path
 * delimiters for path segments from getStaticPaths... TODO: investigate
 * adding this handling for non-SSG pages so non-ascii names also work
 * there."——这不是本仓库代码/nginx/DB 的缺陷，是这个 Next 版本对非 SSG 页面
 * 动态段的既有限制，此前从未暴露是因为此前从未有非 ASCII slug 的已发布文章
 * 走过真实 HTTP 详情页请求。
 *
 * CPS parity：`git show 3a76877:src/app/[locale]/(site)/drama/[slug]/
 * page.tsx:84-89` 的 `normalizeRouteSlug`（`try { return
 * decodeURIComponent(slug); } catch { return slug; }`），在
 * `generateMetadata`/页面 body 两个入口各自调用一次——`decodeSlugParam`
 * （`src/lib/slug/article-path.ts`）是同一模式的对应实现，调用位置也对齐
 * CPS：紧跟在 `await params` 解构之后，而不是塞进更深层的
 * `resolvePublicArticleBySlugParam`（那里的 `parseArticleSlugParam` 沿用
 * CPS `parseDramaArticleSlugParam` 的既有约定——不在内部解码，因为
 * `src/server/articles/service.ts`'s `extractSearchShortId` 早就是"先
 * decode，再调用 parseArticleSlugParam"的调用方，内部再解码一次会造成双重
 * 解码）。
 *
 * ② canonical/hreflang 自引用缺 locale 前缀：`novel-detail.tsx`/
 * `chapter.tsx` 原先用 locale 无关的 `buildArticleRoutePath`/
 * `buildChapterRoutePath` 构造 `canonicalPath`（进而喂给
 * `buildHreflangForArticle`/`buildHreflangForChapter` 的 `canonical`
 * 参数，成为该 locale 自己的 hreflang 自引用条目）。对 `en`
 * （`localePrefix("en") === ""`）这与带前缀的 `buildArticlePath`/
 * `buildChapterPath` 字面相同，所以直到本轮第一篇非 en 文章真正发布才第一次
 * 暴露。
 *
 * Mutation targets（本文件报告里逐条人工验证过，此处保留描述供复核对照）：
 *   - "novel-detail.tsx/chapter.tsx 删掉 decodeSlugParam 调用" → 本文件
 *     "①" 组的 `toHaveBeenCalledWith` 断言红（`loadArticleAccess` 收到的
 *     还是原样编码串，不等于期望的解码串）。
 *   - "canonical 改回 buildArticleRoutePath/buildChapterRoutePath" → 本文件
 *     "②" 组的 canonical/hreflang 断言红（缺 locale 前缀）。
 *   - "decodeSlugParam 调用两次" → 本文件 "③" 组的字面 % 用例红（第二次解码
 *     把 `%c3%b3` 当作合法转义静默解成 "ó"，不再等于原文）。
 */

const NOT_FOUND = Symbol("next-not-found");

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw NOT_FOUND;
  },
}));

vi.mock("@/app/_lib/public-load", () => ({
  loadChrome: vi.fn(),
  loadActiveLocales: vi.fn(),
  loadArticleAccess: vi.fn(),
  loadNovelDetail: vi.fn(),
  loadChapterView: vi.fn(),
  loadHreflangSiblings: vi.fn(),
}));

const publicLoad = await import("@/app/_lib/public-load");
const loadChrome = vi.mocked(publicLoad.loadChrome);
const loadActiveLocales = vi.mocked(publicLoad.loadActiveLocales);
const loadArticleAccess = vi.mocked(publicLoad.loadArticleAccess);
const loadNovelDetail = vi.mocked(publicLoad.loadNovelDetail);
const loadChapterView = vi.mocked(publicLoad.loadChapterView);
const loadHreflangSiblings = vi.mocked(publicLoad.loadHreflangSiblings);

const { buildNovelMetadata, NovelBody } = await import("@/app/_pages/novel-detail");
const { buildChapterMetadata, ChapterBody } = await import("@/app/_pages/chapter");

const ORIGIN = "https://example.test";

const SETTINGS = {
  siteName: "cps-novel",
  siteDescription: "Overseas novels.",
  homeMetaTitle: "cps-novel",
  homeMetaDescription: "Read overseas novels.",
  defaultOgImage: "https://example.test/og.png",
  googleSearchConsoleVerification: "",
  footerCopyrightText: "© test",
  footerDisclaimerText: "",
  friendLinks: [],
  indexNowHost: "",
  indexNowKey: "",
  indexNowKeyLocation: "",
  ga4MeasurementId: null,
  updatedAt: new Date("2026-08-18T00:00:00Z"),
};

const CHROME = {
  brandHref: "/",
  navItems: [{ label: "Home", href: "/", current: true }],
  footerNote: "© test",
};

const DETAIL: NovelDetailView = {
  id: "biz-1",
  title: "The Lantern Keeper's Daughter",
  coverUrl: "/covers/lantern.jpg",
  description: "A coastal town keeps one lantern burning.",
  locale: { code: "ru", label: "Русский" },
  totalChapterCount: 12,
  tags: [],
  previewChapters: [],
};

const CHAPTER = {
  number: 1,
  title: "The Harbour",
  paragraphs: ["The tide came in early that year."],
  novel: {
    id: "biz-1",
    title: "The Lantern Keeper's Daughter",
    href: "/ru/novel/lantern-keepers-daughter-pabc123",
    coverUrl: "/covers/lantern.jpg",
  },
  previewPosition: { index: 1, total: 3 },
};

beforeEach(() => {
  process.env.SITE_URL = ORIGIN;
  loadChrome.mockReset();
  loadChrome.mockResolvedValue({ settings: SETTINGS, chrome: CHROME });
  loadActiveLocales.mockReset();
  loadActiveLocales.mockResolvedValue(["en", "ru"] as never);
  loadArticleAccess.mockReset();
  loadNovelDetail.mockReset();
  loadChapterView.mockReset();
  loadHreflangSiblings.mockReset();
  loadHreflangSiblings.mockResolvedValue([]);
});

afterEach(() => {
  delete process.env.SITE_URL;
  vi.clearAllMocks();
});

describe("decodeSlugParam（纯函数单测，不依赖页面/mock）", () => {
  it("解码一个百分号编码的非 ASCII 段", () => {
    expect(decodeSlugParam("%D1%82%D0%B0%D0%B8%D0%BD-pabc123")).toBe("таин-pabc123");
  });

  it("纯 ASCII 输入是 no-op（不含 % 时 decodeURIComponent 本就恒等）", () => {
    expect(decodeSlugParam("simple-slug-pabc123")).toBe("simple-slug-pabc123");
  });

  it("非法转义（% 后不是两位十六进制）不抛出，原样回落", () => {
    expect(() => decodeSlugParam("bad%zzslug-pabc123")).not.toThrow();
    expect(decodeSlugParam("bad%zzslug-pabc123")).toBe("bad%zzslug-pabc123");
  });

  it("孤立的 % （末尾截断）不抛出，原样回落", () => {
    expect(() => decodeSlugParam("truncated%")).not.toThrow();
    expect(decodeSlugParam("truncated%")).toBe("truncated%");
  });

  it("空字符串是 no-op", () => {
    expect(decodeSlugParam("")).toBe("");
  });
});

describe("① 非 ASCII slugParam：decodeSlugParam 在解析前解码一次", () => {
  const plainParam = "таинственный-миллиардер-pyt79x8mn";
  // 与站点自身 buildArticleRoutePath 的 encodeURIComponent 完全同形——这正是
  // Next 交给页面的原始 params.slugParam（未解码，见文件头注释的实测证据）。
  const rawEncodedParam = encodeURIComponent(plainParam);

  const ACCESS = {
    kind: "published" as const,
    articleId: "article-1",
    novelId: "novel-1",
    slugPart: "таинственный-миллиардер",
    shortId: "yt79x8mn",
    title: "Таинственный миллиардер",
  };

  it("novel 详情页：loadArticleAccess 收到解码后的明文，而不是原样编码串", async () => {
    loadArticleAccess.mockResolvedValue(ACCESS);
    loadNovelDetail.mockResolvedValue({ ...DETAIL, title: ACCESS.title });

    const metadata = await buildNovelMetadata("ru", Promise.resolve({ slugParam: rawEncodedParam }));

    expect(loadArticleAccess).toHaveBeenCalledWith(plainParam, "ru");
    expect(loadArticleAccess).not.toHaveBeenCalledWith(rawEncodedParam, "ru");
    expect(metadata.title).toBe(ACCESS.title);

    const tree = await NovelBody({ locale: "ru", params: Promise.resolve({ slugParam: rawEncodedParam }) });
    expect(tree).toBeTruthy();
  });

  it("chapter 页：loadArticleAccess 同样收到解码后的明文", async () => {
    loadArticleAccess.mockResolvedValue(ACCESS);
    loadChapterView.mockResolvedValue(CHAPTER);

    const metadata = await buildChapterMetadata(
      "ru",
      Promise.resolve({ slugParam: rawEncodedParam, chapterNumber: "1" }),
    );

    expect(loadArticleAccess).toHaveBeenCalledWith(plainParam, "ru");
    expect(metadata.title).toContain(CHAPTER.title);

    const tree = await ChapterBody({
      locale: "ru",
      params: Promise.resolve({ slugParam: rawEncodedParam, chapterNumber: "1" }),
    });
    expect(tree).toBeTruthy();
  });

  it("ja（多字节 CJK）非 ASCII slug 同样成功解码解析", async () => {
    const jaPlain = "私の吐息を奪って-pkaa9b78f";
    const jaEncoded = encodeURIComponent(jaPlain);
    loadArticleAccess.mockResolvedValue({
      kind: "published" as const,
      articleId: "article-2",
      novelId: "novel-2",
      slugPart: "私の吐息を奪って",
      shortId: "kaa9b78f",
      title: "私の吐息を奪って",
    });
    loadNovelDetail.mockResolvedValue({ ...DETAIL, title: "私の吐息を奪って", locale: { code: "ja", label: "日本語" } });

    await buildNovelMetadata("ja", Promise.resolve({ slugParam: jaEncoded }));
    expect(loadArticleAccess).toHaveBeenCalledWith(jaPlain, "ja");
  });

  it("ar（阿拉伯文，另一个非拉丁字母表）非 ASCII slug 同样成功解码解析", async () => {
    const arPlain = "روايتي-الأولى-pnaa1b2c3";
    const arEncoded = encodeURIComponent(arPlain);
    loadArticleAccess.mockResolvedValue({
      kind: "published" as const,
      articleId: "article-3",
      novelId: "novel-3",
      slugPart: "روايتي-الأولى",
      shortId: "naa1b2c3",
      title: "روايتي الأولى",
    });
    loadNovelDetail.mockResolvedValue({ ...DETAIL, title: "روايتي الأولى", locale: { code: "ar", label: "العربية" } });

    const metadata = await buildNovelMetadata("ar", Promise.resolve({ slugParam: arEncoded }));
    expect(loadArticleAccess).toHaveBeenCalledWith(arPlain, "ar");
    expect(loadArticleAccess).not.toHaveBeenCalledWith(arEncoded, "ar");
    expect(metadata.title).toBe("روايتي الأولى");
  });

  it("非 ASCII slugPart 的 canonical：slug 段是百分号编码，与 buildArticlePath 直接调用的输出字节一致（不是原样非 ASCII 字符）", async () => {
    loadArticleAccess.mockResolvedValue(ACCESS);
    loadNovelDetail.mockResolvedValue({ ...DETAIL, title: ACCESS.title });

    const metadata = await buildNovelMetadata("ru", Promise.resolve({ slugParam: rawEncodedParam }));

    const canonicalStr = String(metadata.alternates?.canonical);
    const expected = `${ORIGIN}${buildArticlePath({ locale: "ru", slug: ACCESS.slugPart, shortId: ACCESS.shortId })}`;
    expect(canonicalStr).toBe(expected);
    expect(canonicalStr).toBe(`${ORIGIN}/ru/novel/${encodeURIComponent(`${ACCESS.slugPart}-p${ACCESS.shortId}`)}`);
    // 反证：canonical 里不能出现原样未编码的西里尔字符。
    expect(canonicalStr).not.toContain("таинственный");
    expect(canonicalStr).toContain("%D1%82%D0%B0");
  });
});

describe("非法/损坏的百分号编码：优雅降级到 notFound()，不抛未捕获异常", () => {
  it("decodeSlugParam 遇到非法转义（%zz）不抛出，回落原文，随后按 not_found 走 notFound()", async () => {
    const malformed = "bad%zzslug-pabc123";
    loadArticleAccess.mockResolvedValue({ kind: "not_found" });

    await expect(
      NovelBody({ locale: "ru", params: Promise.resolve({ slugParam: malformed }) }),
    ).rejects.toBe(NOT_FOUND);

    // 走到了 loadArticleAccess（证明 decodeSlugParam 内部的 try/catch 吞掉了
    // URIError、没有向上抛出未捕获异常），且收到的是回落后的原文。
    expect(loadArticleAccess).toHaveBeenCalledWith(malformed, "ru");
  });

  it("chapter 页同样优雅降级", async () => {
    const malformed = "bad%zzslug-pabc123";
    loadArticleAccess.mockResolvedValue({ kind: "not_found" });

    await expect(
      ChapterBody({ locale: "ru", params: Promise.resolve({ slugParam: malformed, chapterNumber: "1" }) }),
    ).rejects.toBe(NOT_FOUND);
    expect(loadArticleAccess).toHaveBeenCalledWith(malformed, "ru");
  });
});

describe("② canonical / hreflang 自引用：非 en locale 必须带 /{locale} 前缀", () => {
  const ACCESS = {
    kind: "published" as const,
    articleId: "article-1",
    novelId: "novel-1",
    slugPart: "lantern-keepers-daughter",
    shortId: "abc123",
    title: DETAIL.title,
  };

  it("novel 详情页：canonical 与 hreflang 自引用都带 /ru 前缀（非裸 /novel/...)", async () => {
    loadArticleAccess.mockResolvedValue(ACCESS);
    loadNovelDetail.mockResolvedValue(DETAIL);

    const metadata = await buildNovelMetadata(
      "ru",
      Promise.resolve({ slugParam: "lantern-keepers-daughter-pabc123" }),
    );

    const expectedCanonical = `${ORIGIN}/ru/novel/lantern-keepers-daughter-pabc123`;
    expect(metadata.alternates?.canonical).toBe(expectedCanonical);
    expect(metadata.alternates?.languages).toMatchObject({ ru: expectedCanonical });
    // 裸路径（缺前缀）绝不能出现在任何一处。
    const canonicalStr = String(metadata.alternates?.canonical);
    expect(canonicalStr.startsWith(`${ORIGIN}/novel/`)).toBe(false);
  });

  it("chapter 页：canonical 与 hreflang 自引用也带 /ru 前缀", async () => {
    loadArticleAccess.mockResolvedValue(ACCESS);
    loadChapterView.mockResolvedValue(CHAPTER);

    const metadata = await buildChapterMetadata(
      "ru",
      Promise.resolve({ slugParam: "lantern-keepers-daughter-pabc123", chapterNumber: "1" }),
    );

    const expectedCanonical = `${ORIGIN}/ru/novel/lantern-keepers-daughter-pabc123/chapter/1`;
    expect(metadata.alternates?.canonical).toBe(expectedCanonical);
    expect(metadata.alternates?.languages).toMatchObject({ ru: expectedCanonical });
    const canonicalStr = String(metadata.alternates?.canonical);
    expect(canonicalStr.startsWith(`${ORIGIN}/novel/`)).toBe(false);
  });

  it("en 不回归：前缀为空，novel 详情页 canonical 与旧行为字节一致", async () => {
    loadArticleAccess.mockResolvedValue(ACCESS);
    loadNovelDetail.mockResolvedValue({ ...DETAIL, locale: { code: "en", label: "English" } });

    const metadata = await buildNovelMetadata(
      "en",
      Promise.resolve({ slugParam: "lantern-keepers-daughter-pabc123" }),
    );

    expect(metadata.alternates?.canonical).toBe(`${ORIGIN}/novel/lantern-keepers-daughter-pabc123`);
  });

  it("de 不回归：ASCII-only slug（非默认 locale，有真实前缀）解码是 no-op，canonical 带 /de 前缀", async () => {
    loadArticleAccess.mockResolvedValue(ACCESS);
    loadNovelDetail.mockResolvedValue({ ...DETAIL, locale: { code: "de", label: "Deutsch" } });

    const metadata = await buildNovelMetadata(
      "de",
      Promise.resolve({ slugParam: "lantern-keepers-daughter-pabc123" }),
    );

    expect(loadArticleAccess).toHaveBeenCalledWith("lantern-keepers-daughter-pabc123", "de");
    expect(metadata.alternates?.canonical).toBe(`${ORIGIN}/de/novel/lantern-keepers-daughter-pabc123`);
  });
});

describe("③ 只解码一次：含字面 % 的 slug 不能被二次解码腐化", () => {
  // text-to-slug.ts 的字符集（\p{L}\p{N}\p{M}）永远不会真产出带 "%" 的 slug
  // （D-8/LOCALE_SEGMENTATION_RULES 冻结决策），这里按任务要求人工构造一个
  // 含字面 "%" 的 slugPart，专门压双重解码这条边。
  //   plainParam 里的 "%c3%b3" 是纯字面文本，不是转义——
  //   encodeURIComponent 只会转掉这两个 "%" 本身（-> "%25"），其余字符不变。
  //   单次解码必须原样复原；再解码一次会把 "%c3%b3" 当成合法的 UTF-8
  //   百分号转义，静默解出 "ó"（0xC3 0xB3），不抛错也不等于原文——比抛错更
  //   危险，因为不会被 decodeSlugParam 自身的 try/catch 挡住。
  const plainParam = "a%c3%b3b-pabc123";
  const rawEncodedParam = encodeURIComponent(plainParam);

  it("encodeURIComponent 往返自检：单次解码等于原文，两次解码会腐化成别的字符串", () => {
    expect(decodeURIComponent(rawEncodedParam)).toBe(plainParam);
    // 有意演示二次解码的腐化后果（不是生产代码路径）：
    expect(decodeURIComponent(decodeURIComponent(rawEncodedParam))).not.toBe(plainParam);
  });

  it("novel 详情页只解码一次：loadArticleAccess 收到的明文字面保留两个 %", async () => {
    loadArticleAccess.mockResolvedValue({ kind: "not_found" });

    await expect(
      NovelBody({ locale: "ru", params: Promise.resolve({ slugParam: rawEncodedParam }) }),
    ).rejects.toBe(NOT_FOUND);

    expect(loadArticleAccess).toHaveBeenCalledWith(plainParam, "ru");
    expect(loadArticleAccess).not.toHaveBeenCalledWith("aób-pabc123", "ru");
  });

  it("chapter 页只解码一次：同上", async () => {
    loadArticleAccess.mockResolvedValue({ kind: "not_found" });

    await expect(
      ChapterBody({ locale: "ru", params: Promise.resolve({ slugParam: rawEncodedParam, chapterNumber: "1" }) }),
    ).rejects.toBe(NOT_FOUND);

    expect(loadArticleAccess).toHaveBeenCalledWith(plainParam, "ru");
    expect(loadArticleAccess).not.toHaveBeenCalledWith("aób-pabc123", "ru");
  });
});
