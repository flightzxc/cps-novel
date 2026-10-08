import "./setup-cleanup";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

import { SITE_LOCALES, type SiteLocale } from "@/lib/locale/locale-canonical";
import { CATALOGS, getPublicT } from "@/lib/locale/messages";
import { en } from "@/lib/locale/messages/en";
import type { NovelCardView } from "@/features/public-ui/types";

/**
 * 前台分类页标题 = 分类名 + Novels（运营 2026-10-08 反馈，Owner 确认范围含
 * H1 / `<title>` / og:title / twitter:title / 面包屑；**有意偏离 CPS**，CPS 分类页是纯分类名）。
 *
 * 本文件守三件事：
 *  1. `collection.categoryHeading` 这个新键在 15 个语种目录里都在、占位符只有 `{name}`、
 *     非英语语种不是英文 "Novels"，并且对"分类名是短语"的语种带分隔符（见下方注释）；
 *  2. 页面层：H1、`<title>`、og/twitter 标题、CollectionPage.name、面包屑第 2 项是同一个值，
 *     且描述兜底句仍用**纯分类名**（否则会变 "Discover Romance Novels novels…"）；
 *  3. 范围守卫：浏览页 `/browse?category=` 仍用 `collection.categoryTitle`，不在本次范围。
 *
 * 标题/描述的逐条文案断言（第 2 页后缀、ja 后缀本地化等）在
 * `tests/ui/seo/category-title-description.test.ts`。
 */

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
}));

vi.mock("@/app/_lib/public-load", () => ({
  loadChrome: vi.fn(),
  loadActiveLocales: vi.fn(),
  loadBrowseNovels: vi.fn(),
}));

vi.mock("@/lib/site/category-queries", () => ({
  getPublicCategoryPage: vi.fn(),
}));

const publicLoad = await import("@/app/_lib/public-load");
const loadChrome = vi.mocked(publicLoad.loadChrome);
const loadActiveLocales = vi.mocked(publicLoad.loadActiveLocales);
const loadBrowseNovels = vi.mocked(publicLoad.loadBrowseNovels);
const categoryQueries = await import("@/lib/site/category-queries");
const getPublicCategoryPage = vi.mocked(categoryQueries.getPublicCategoryPage);
const { CategoryBody, buildCategoryMetadata } = await import("@/app/_pages/category");
const { BrowseBody, buildBrowseMetadata } = await import("@/app/_pages/browse");

const SETTINGS = {
  siteName: "PulseNovel",
  siteDescription: "ADMIN-SITE-DESCRIPTION",
  homeMetaTitle: "",
  homeMetaDescription: "",
  defaultOgImage: "https://example.test/og-default.png",
  googleSearchConsoleVerification: "",
  footerCopyrightText: "",
  footerDisclaimerText: "",
  friendLinks: [],
  indexNowHost: "",
  indexNowKey: "",
  indexNowKeyLocation: "",
  ga4MeasurementId: null,
  yandexVerification: "",
  yandexMetricaId: null,
  updatedAt: new Date("2026-10-08T00:00:00Z"),
};
const CHROME = { brandHref: "/", navItems: [], footerNote: "© test" };
const CARD: NovelCardView = { id: "biz-1", title: "A Book", coverUrl: "/c.jpg", tags: [], href: "/novel/a-book-pabc123" };

function categoryPage(page: number, name: string, slug = "romance") {
  return {
    novels: [CARD],
    page,
    totalPages: 3,
    totalCount: 45,
    category: {
      id: "cat-1",
      slug,
      name,
      description: null,
      sortOrder: 0,
      updatedAt: new Date("2026-09-10T00:00:00Z"),
    },
  };
}

function titleOf(metadata: { title?: unknown }): string {
  if (typeof metadata.title !== "string") throw new Error(`expected a plain string title, got ${JSON.stringify(metadata.title)}`);
  return metadata.title;
}

beforeEach(() => {
  process.env.SITE_URL = "https://example.test";
  loadChrome.mockResolvedValue({ settings: SETTINGS, chrome: CHROME });
  loadActiveLocales.mockResolvedValue(["en"] as never);
  loadBrowseNovels.mockResolvedValue([CARD]);
});

afterEach(() => {
  delete process.env.SITE_URL;
  vi.clearAllMocks();
});

/** 语种顺序同 `scripts/p2-06-5-production/build-canonical-tag-translation-overlay.py`：en es pt-BR id vi th ja ko zh-Hant ar fr de pl cs ru。 */
const OVERLAY_COLUMNS: readonly SiteLocale[] = ["en", "es", "pt-BR", "id", "vi", "th", "ja", "ko", "zh-Hant", "ar", "fr", "de", "pl", "cs", "ru"];

/**
 * 三个真实分类名（同一份译名资产，逐字取自上面那个脚本）。分类名常常是**短语**而不是名词
 * （"Para lectoras" / "Del odio al amor"），标题模板必须对两类都通顺：
 * 例如 de 旧的 "{name}-Romane" 套 "Für Leserinnen" 得到 "Für Leserinnen-Romane"。
 */
const REAL_NAMES: Readonly<Record<string, readonly string[]>> = {
  "female-audience": ["Female Audience", "Para lectoras", "Para leitoras", "Untuk pembaca wanita", "Dành cho nữ", "สำหรับผู้อ่านหญิง", "女性向け", "여성향", "女性向", "موجه للنساء", "Public féminin", "Für Leserinnen", "Dla czytelniczek", "Pro čtenářky", "Для женской аудитории"],
  fantasy: ["Fantasy", "Fantasía", "Fantasia", "Fantasi", "Kỳ ảo", "แฟนตาซี", "ファンタジー", "판타지", "奇幻", "فانتازيا", "Fantasy", "Fantasy", "Fantasy", "Fantasy", "Фэнтези"],
  "from-hate-to-love": ["From Hate to Love", "Del odio al amor", "Do ódio ao amor", "Dari benci jadi cinta", "Từ hận thành yêu", "จากเกลียดกลายเป็นรัก", "嫌いから愛へ", "미움에서 사랑으로", "由恨生愛", "من الكراهية إلى الحب", "De la haine à l’amour", "Vom Hass zur Liebe", "Od nienawiści do miłości", "Z nenávisti k lásce", "От ненависти к любви"],
};

function headingOf(locale: SiteLocale, name: string): string {
  return getPublicT(locale)("collection.categoryHeading", { name });
}

describe("collection.categoryHeading 目录（15 语）", () => {
  it("en 是 '{name} Novels'（标题大小写），既有 categoryTitle / 描述兜底句的值没动", () => {
    expect(en.collection.categoryHeading).toBe("{name} Novels");
    expect(en.collection.categoryTitle).toBe("{name} novels");
    expect(en.meta.categoryDescriptionFallback).toBe("Discover {name} novels on PulseNovel.");
  });

  it("目录里 15 个语种都登记了", () => {
    expect([...SITE_LOCALES].sort()).toEqual([...OVERLAY_COLUMNS].sort());
  });

  it.each(SITE_LOCALES)("%s：存在、含 {name}、占位符只有 {name}、不含 # 与 plural", (locale) => {
    const value = (CATALOGS[locale] as { collection: { categoryHeading?: unknown } }).collection.categoryHeading;
    expect(typeof value, `${locale} 缺 collection.categoryHeading`).toBe("string");
    const text = value as string;
    expect(text).toContain("{name}");
    expect(Array.from(text.matchAll(/\{([^}]*)\}/g), (m) => m[1])).toEqual(["name"]);
    expect(text).not.toContain("#");
    expect(text).not.toMatch(/plural/i);
    expect(text.trim()).toBe(text);
    // 是标题不是句子：不以句号收尾。
    expect(text).not.toMatch(/[.。]$/);
  });

  it.each(SITE_LOCALES.filter((locale) => locale !== "en"))("%s：不是英文 'Novels'，也不等于 en 的值", (locale) => {
    const text = (CATALOGS[locale] as { collection: { categoryHeading: string } }).collection.categoryHeading;
    expect(text).not.toMatch(/\bNovels\b/i);
    expect(text).not.toBe(en.collection.categoryHeading);
  });

  /**
   * 对"分类名是短语"的语种，译文必须把分类名和通用词隔开（冒号 / 引号 / 括号），不能把短语直接
   * 拼进名词短语里：es "Novelas de Para lectoras"、de "Für Leserinnen-Romane"、fr "Romans Public féminin"、
   * pl "Powieści Dla czytelniczek"、ja "全員から愛されるの小説" 都是旧 `categoryTitle` 套短语名的实际结果。
   * 这条守卫防止以后有人为了"更自然"改回无分隔形式。无分隔的语种（th/ko/zh-Hant）靠语言本身的
   * 名词+名词结构成立，不在此列。
   */
  it.each(["es", "pt-BR", "id", "vi", "ar", "fr", "de", "pl", "cs"] as const)("%s：分类名与通用词之间用冒号隔开", (locale) => {
    const text = (CATALOGS[locale] as { collection: { categoryHeading: string } }).collection.categoryHeading;
    expect(text).toMatch(/^[^{}:：]+ ?: \{name\}$/);
  });

  it.each([["ja", "「", "」"], ["ru", "«", "»"]] as const)("%s：分类名被引号括起来", (locale, open, close) => {
    const text = (CATALOGS[locale] as { collection: { categoryHeading: string } }).collection.categoryHeading;
    expect(text).toContain(`${open}{name}${close}`);
  });

  it.each(Object.entries(REAL_NAMES))("真实分类名 %s：15 语渲染结果都含该语种的分类名原文，且不是光秃秃的分类名", (_slug, names) => {
    OVERLAY_COLUMNS.forEach((locale, index) => {
      const name = names[index]!;
      const heading = headingOf(locale, name);
      expect(heading, locale).toContain(name);
      expect(heading, locale).not.toBe(name);
      expect(heading, locale).not.toContain("{");
    });
  });
});

describe("分类页：H1 / <title> / og·twitter 标题 / CollectionPage.name / 面包屑第 2 项 同一个值", () => {
  it("en 第 1 页：H1 = 'Romance Novels'，metadata.title / og:title / twitter:title 同", async () => {
    getPublicCategoryPage.mockResolvedValue(categoryPage(1, "Romance"));
    const tree = await CategoryBody({ locale: "en", params: Promise.resolve({ slug: "romance" }), searchParams: Promise.resolve({}) });
    render(tree);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Romance Novels");

    const metadata = await buildCategoryMetadata("en", Promise.resolve({ slug: "romance" }), Promise.resolve({}));
    expect(titleOf(metadata)).toBe("Romance Novels");
    expect(metadata.openGraph?.title).toBe("Romance Novels");
    expect((metadata.twitter as { title?: string }).title).toBe("Romance Novels");
  });

  it("en 第 2 页：H1 仍是 'Romance Novels'（后缀只进 <title>/og/twitter），标题 = 'Romance Novels - Page 2'", async () => {
    getPublicCategoryPage.mockResolvedValue(categoryPage(2, "Romance"));
    const tree = await CategoryBody({ locale: "en", params: Promise.resolve({ slug: "romance" }), searchParams: Promise.resolve({ page: "2" }) });
    render(tree);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Romance Novels");

    const metadata = await buildCategoryMetadata("en", Promise.resolve({ slug: "romance" }), Promise.resolve({ page: "2" }));
    expect(titleOf(metadata)).toBe("Romance Novels - Page 2");
    expect(metadata.openGraph?.title).toBe("Romance Novels - Page 2");
    expect((metadata.twitter as { title?: string }).title).toBe("Romance Novels - Page 2");
  });

  it("ja：H1 / 标题用日语译文，不含英文 Novels", async () => {
    getPublicCategoryPage.mockResolvedValue(categoryPage(1, "Romance"));
    const expected = getPublicT("ja")("collection.categoryHeading", { name: "Romance" });
    const tree = await CategoryBody({ locale: "ja", params: Promise.resolve({ slug: "romance" }), searchParams: Promise.resolve({}) });
    render(tree);
    const h1 = screen.getByRole("heading", { level: 1 }).textContent;
    expect(h1).toBe(expected);
    expect(h1).not.toContain("Novels");

    const metadata = await buildCategoryMetadata("ja", Promise.resolve({ slug: "romance" }), Promise.resolve({}));
    expect(titleOf(metadata)).toBe(expected);
    expect(titleOf(metadata)).not.toContain("Novels");
  });

  it("en JSON-LD：CollectionPage.name 与 BreadcrumbList 第 2 项 name 都是 'Romance Novels'，描述兜底句仍是纯名（无 'Novels novels'）", async () => {
    getPublicCategoryPage.mockResolvedValue(categoryPage(1, "Romance"));
    const tree = await CategoryBody({ locale: "en", params: Promise.resolve({ slug: "romance" }), searchParams: Promise.resolve({}) });
    const { container } = render(tree);
    const script = container.querySelector('script[type="application/ld+json"]');
    expect(script).toBeTruthy();
    const [collection, breadcrumb] = JSON.parse(script!.textContent!) as Array<Record<string, unknown>>;
    expect(collection).toMatchObject({ "@type": "CollectionPage", name: "Romance Novels", description: "Discover Romance novels on PulseNovel." });
    const items = breadcrumb!.itemListElement as Array<{ position: number; name: string }>;
    expect(items.find((item) => item.position === 2)?.name).toBe("Romance Novels");

    const metadata = await buildCategoryMetadata("en", Promise.resolve({ slug: "romance" }), Promise.resolve({}));
    expect(metadata.description).toBe("Discover Romance novels on PulseNovel.");
    expect(metadata.description).not.toMatch(/novels novels/i);
  });

  it.each(OVERLAY_COLUMNS)("%s：H1 = metadata.title = og/twitter 标题 = CollectionPage.name = 面包屑第 2 项（第 1 页）", async (locale) => {
    getPublicCategoryPage.mockResolvedValue(categoryPage(1, "Romance"));
    const expected = headingOf(locale, "Romance");
    const tree = await CategoryBody({ locale, params: Promise.resolve({ slug: "romance" }), searchParams: Promise.resolve({}) });
    const { container } = render(tree);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(expected);
    const [collection, breadcrumb] = JSON.parse(container.querySelector('script[type="application/ld+json"]')!.textContent!) as Array<Record<string, unknown>>;
    expect(collection!.name).toBe(expected);
    expect((breadcrumb!.itemListElement as Array<{ position: number; name: string }>).find((item) => item.position === 2)?.name).toBe(expected);

    const metadata = await buildCategoryMetadata(locale, Promise.resolve({ slug: "romance" }), Promise.resolve({}));
    expect(titleOf(metadata)).toBe(expected);
    expect(metadata.openGraph?.title).toBe(expected);
    expect((metadata.twitter as { title?: string }).title).toBe(expected);
    // 描述兜底句走自己的键、用纯分类名，不是标题形式。
    expect(metadata.description).toBe(getPublicT(locale)("meta.categoryDescriptionFallback", { name: "Romance" }));
  });

  it.each(Object.entries(REAL_NAMES))("真实分类名 %s：15 语 H1 / 标题 / 描述兜底句各走各的键，分类名在标题里原样出现一次", async (slug, names) => {
    for (const [index, locale] of OVERLAY_COLUMNS.entries()) {
      const name = names[index]!;
      getPublicCategoryPage.mockResolvedValue(categoryPage(1, name, slug));
      const tree = await CategoryBody({ locale, params: Promise.resolve({ slug }), searchParams: Promise.resolve({}) });
      const { unmount } = render(tree);
      const h1 = screen.getByRole("heading", { level: 1 }).textContent!;
      expect(h1, `${locale}/${slug}`).toBe(headingOf(locale, name));
      expect(h1.split(name).length - 1, `${locale}/${slug}`).toBe(1);
      unmount();

      const metadata = await buildCategoryMetadata(locale, Promise.resolve({ slug }), Promise.resolve({}));
      expect(titleOf(metadata), `${locale}/${slug}`).toBe(h1);
      expect(metadata.description, `${locale}/${slug}`).toBe(getPublicT(locale)("meta.categoryDescriptionFallback", { name }));
    }
  });
});

describe("范围守卫：浏览页 /browse?category= 不在本次范围，仍用 collection.categoryTitle", () => {
  // 若将来决定浏览页也改成标题形式，应连同本用例一起改（那是另一个 Owner 决定）。
  it("浏览页 <title> 仍是 'Fantasy novels'（小写 novels），不是 'Fantasy Novels'", async () => {
    getPublicCategoryPage.mockResolvedValue(categoryPage(1, "Fantasy", "fantasy"));
    const metadata = await buildBrowseMetadata("en", Promise.resolve({ category: "fantasy" }));
    expect(titleOf(metadata)).toBe("Fantasy novels");
    const tree = await BrowseBody({ locale: "en", searchParams: Promise.resolve({ category: "fantasy" }) });
    render(tree);
    expect(screen.getByRole("heading", { level: 1 }).textContent).not.toContain("Novels");
  });
});
