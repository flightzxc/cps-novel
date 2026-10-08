import "./setup-cleanup";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

import { SITE_LOCALES, type SiteLocale } from "@/lib/locale/locale-canonical";
import { CATALOGS, getPublicT } from "@/lib/locale/messages";
import { en } from "@/lib/locale/messages/en";
import type { NovelCardView } from "@/features/public-ui/types";
import { pagedNovels } from "../fixtures/paged-results";

/**
 * 前台分类页标题 = 分类名 + Novels（运营 2026-10-08 反馈，Owner 确认范围含
 * H1 / `<title>` / og:title / twitter:title / 面包屑；**有意偏离 CPS**，CPS 分类页是纯分类名）。
 *
 * 本文件守三件事：
 *  1. `collection.categoryHeading` 这个新键在 15 个语种目录里都在、占位符只有 `{name}`、
 *     非英语语种不是英文 "Novels"，并且对"分类名是短语"的语种带分隔符（见下方注释）；
 *  2. 页面层：H1、`<title>`、og/twitter 标题、CollectionPage.name、面包屑第 2 项是同一个值，
 *     且描述兜底句仍用**纯分类名**（否则会变 "Discover Romance Novels novels…"）；
 *  3. 范围守卫：浏览页 `/browse?category=` 仍用 `collection.categoryTitle`（en 不动）；
 *  4. Owner 2026-10-08 追加：非英语语种的 `collection.categoryTitle`（只用于 /browse?category= 标题）
 *     与 `collection.categoryHeading` 同值，`meta.categoryDescriptionFallback` 在短语型分类名下
 *     也要通顺——用该语种的引号把分类名隔开；en 两个键一字不动。
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
  loadBrowsePage: vi.fn(),
  loadCategoryPage: vi.fn(),
}));

// B-38：分类页第 1 页的 hreflang 现在读每语种每分类本数矩阵（`listCategoryPublicLocales`，真实实现会连数据库）。
// 这里替成"每个候选语种都有内容"——与这些用例此前 mock 掉的 `getPublicCategoryPage`（对任何语种都返回同一页）等价；
// 矩阵本身与 hreflang 的一致性由 `tests/integration/site/consistency-invariants-postgres.test.ts` 证明。
vi.mock("@/lib/site/category-locales", () => ({
  listCategoryPublicLocales: vi.fn(async (_db: unknown, _slug: string, candidates: readonly string[]) => [...candidates]),
}));

const publicLoad = await import("@/app/_lib/public-load");
const loadChrome = vi.mocked(publicLoad.loadChrome);
const loadActiveLocales = vi.mocked(publicLoad.loadActiveLocales);
const loadBrowsePage = vi.mocked(publicLoad.loadBrowsePage);
const loadCategoryPage = vi.mocked(publicLoad.loadCategoryPage);
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
  loadBrowsePage.mockImplementation(async (_locale, page) => pagedNovels([CARD], page));
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
   * 这条守卫防止以后有人为了"更自然"改回无分隔形式。无分隔的语种只剩 th（泰语名词+名词结构成立）。
   * 2026-10-09 第三方（GPT）验收 + Owner 裁定：ru（«…» 会被读成书名）、ko、zh-Hant 也改成冒号隔开，
   * 所以 ru/ko 进了半角冒号清单，zh-Hant 用全角冒号（U+FF1A）单独断言。
   */
  it.each(["es", "pt-BR", "id", "vi", "ar", "fr", "de", "pl", "cs", "ru", "ko"] as const)("%s：分类名与通用词之间用冒号隔开", (locale) => {
    const text = (CATALOGS[locale] as { collection: { categoryHeading: string } }).collection.categoryHeading;
    expect(text).toMatch(/^[^{}:：]+ ?: \{name\}$/);
  });

  it("zh-Hant：分类名与通用词之间用全角冒号（U+FF1A）隔开", () => {
    const text = (CATALOGS["zh-Hant"] as { collection: { categoryHeading: string } }).collection.categoryHeading;
    expect(text).toMatch(/^[^{}:：]+\uFF1A\{name\}$/);
  });

  it("ja：分类名被「」括起来", () => {
    const text = (CATALOGS.ja as { collection: { categoryHeading: string } }).collection.categoryHeading;
    expect(text).toContain("「{name}」");
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
    loadCategoryPage.mockResolvedValue(categoryPage(1, "Romance"));
    const tree = await CategoryBody({ locale: "en", params: Promise.resolve({ slug: "romance" }), searchParams: Promise.resolve({}) });
    render(tree);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Romance Novels");

    const metadata = await buildCategoryMetadata("en", Promise.resolve({ slug: "romance" }), Promise.resolve({}));
    expect(titleOf(metadata)).toBe("Romance Novels");
    expect(metadata.openGraph?.title).toBe("Romance Novels");
    expect((metadata.twitter as { title?: string }).title).toBe("Romance Novels");
  });

  it("en 第 2 页：H1 仍是 'Romance Novels'（后缀只进 <title>/og/twitter），标题 = 'Romance Novels - Page 2'", async () => {
    loadCategoryPage.mockResolvedValue(categoryPage(2, "Romance"));
    const tree = await CategoryBody({ locale: "en", params: Promise.resolve({ slug: "romance" }), searchParams: Promise.resolve({ page: "2" }) });
    render(tree);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Romance Novels");

    const metadata = await buildCategoryMetadata("en", Promise.resolve({ slug: "romance" }), Promise.resolve({ page: "2" }));
    expect(titleOf(metadata)).toBe("Romance Novels - Page 2");
    expect(metadata.openGraph?.title).toBe("Romance Novels - Page 2");
    expect((metadata.twitter as { title?: string }).title).toBe("Romance Novels - Page 2");
  });

  it("ja：H1 / 标题用日语译文，不含英文 Novels", async () => {
    loadCategoryPage.mockResolvedValue(categoryPage(1, "Romance"));
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
    loadCategoryPage.mockResolvedValue(categoryPage(1, "Romance"));
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
    loadCategoryPage.mockResolvedValue(categoryPage(1, "Romance"));
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
      loadCategoryPage.mockResolvedValue(categoryPage(1, name, slug));
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
    loadCategoryPage.mockResolvedValue(categoryPage(1, "Fantasy", "fantasy"));
    const metadata = await buildBrowseMetadata("en", Promise.resolve({ category: "fantasy" }));
    expect(titleOf(metadata)).toBe("Fantasy novels");
    const tree = await BrowseBody({ locale: "en", searchParams: Promise.resolve({ category: "fantasy" }) });
    render(tree);
    expect(screen.getByRole("heading", { level: 1 }).textContent).not.toContain("Novels");
  });
});

/**
 * Owner 2026-10-08 追加：`meta.categoryDescriptionFallback`（分类页无自身描述时的 meta description /
 * og / twitter / CollectionPage 描述，调用方传纯分类名）与 `collection.categoryTitle`（/browse?category= 标题）
 * 在短语型分类名下不通顺——es "Descubre novelas de Para lectoras en PulseNovel."、de "Entdecke Für
 * Leserinnen-Romane auf PulseNovel."、fr "Découvrez des romans Public féminin sur PulseNovel."、
 * pl "…z kategorii Od nienawiści do miłości na PulseNovel."（分类名与后文连成一片）。
 * 2026-10-08 追加单只改了 es/pt-BR/id/vi/ja/ar/fr/de/pl/cs；th/ko/zh-Hant/ru 当时判断为已通顺、保持原值。
 * 2026-10-09 第三方（GPT）验收 + Owner 裁定后，ru/th/ko/zh-Hant 共 10 条按 GPT 模板逐字替换
 * （en 与其它语种不动），见下方"逐字钉住"用例。
 */
const NON_EN = SITE_LOCALES.filter((locale) => locale !== "en");

/**
 * 描述兜底句里分类名两侧的引号（与该语种习惯一致；ja 与 categoryHeading 同为「」）。
 * 2026-10-09 起含 ko（‘ ’）、zh-Hant（「」）、ru（«»）；th 不用引号，单独断言。
 */
const REWRITTEN_DESCRIPTION_QUOTES: ReadonlyArray<readonly [SiteLocale, string, string]> = [
  ["es", "«", "»"],
  ["pt-BR", "“", "”"],
  ["id", "“", "”"],
  ["vi", "“", "”"],
  ["ja", "「", "」"],
  ["ar", "«", "»"],
  ["fr", "« ", " »"],
  ["de", "„", "“"],
  ["pl", "„", "”"],
  ["cs", "„", "“"],
  ["ko", "\u2018", "\u2019"],
  ["zh-Hant", "\u300C", "\u300D"],
  ["ru", "«", "»"],
];

function descriptionOf(locale: SiteLocale, name: string): string {
  return getPublicT(locale)("meta.categoryDescriptionFallback", { name });
}

describe("追加：meta.categoryDescriptionFallback / collection.categoryTitle", () => {
  it("en 两个键逐字等于原值（en 没被动）", () => {
    expect(en.collection.categoryTitle).toBe("{name} novels");
    expect(en.meta.categoryDescriptionFallback).toBe("Discover {name} novels on PulseNovel.");
  });

  it.each(SITE_LOCALES)("%s：两个键占位符只有 {name}，不含 # 与 plural，描述是带品牌名的单句", (locale) => {
    const catalog = CATALOGS[locale] as { collection: { categoryTitle: string }; meta: { categoryDescriptionFallback: string } };
    for (const text of [catalog.collection.categoryTitle, catalog.meta.categoryDescriptionFallback]) {
      expect(Array.from(text.matchAll(/\{([^}]*)\}/g), (m) => m[1])).toEqual(["name"]);
      expect(text).not.toContain("#");
      expect(text).not.toMatch(/plural/i);
      expect(text.trim()).toBe(text);
    }
    const description = catalog.meta.categoryDescriptionFallback;
    expect(description).toContain("PulseNovel");
    // 单句：句末标点（若有）至多一个，且只出现在末尾（th 无句末标点惯例）。
    const terminators = Array.from(description.matchAll(/[.!?。！？]/g)).map((m) => m.index!);
    expect(terminators.length).toBeLessThanOrEqual(1);
    if (terminators.length === 1) expect(terminators[0]).toBe(description.length - 1);
  });

  it.each(NON_EN)("%s：collection.categoryTitle 与 collection.categoryHeading 同值（防以后只改一边）", (locale) => {
    const collection = (CATALOGS[locale] as { collection: { categoryTitle: string; categoryHeading: string } }).collection;
    expect(collection.categoryTitle).toBe(collection.categoryHeading);
  });

  it.each(REWRITTEN_DESCRIPTION_QUOTES)("%s：描述兜底句套短语型分类名后，分类名两侧有引号分隔", (locale, open, close) => {
    for (const [slug, names] of Object.entries(REAL_NAMES)) {
      const name = names[OVERLAY_COLUMNS.indexOf(locale)]!;
      const description = descriptionOf(locale, name);
      expect(description, `${locale}/${slug}`).toContain(`${open}${name}${close}`);
      // 描述里分类名只出现一次，且句子仍含品牌名。
      expect(description.split(name).length - 1, `${locale}/${slug}`).toBe(1);
      expect(description, `${locale}/${slug}`).toContain("PulseNovel");
      expect(description, `${locale}/${slug}`).not.toContain("{");
    }
  });

  it("ja 以动词结尾的分类名（全員から愛される 等）：标题与描述都把它括在「」里，不拼成 '全員から愛されるの小説'", () => {
    for (const name of ["全員から愛される", "ゆっくり恋に落ちる", "夫を取り戻す"]) {
      const t = getPublicT("ja");
      expect(t("collection.categoryTitle", { name })).toBe(`「${name}」の小説`);
      expect(t("collection.categoryHeading", { name })).toBe(`「${name}」の小説`);
      expect(t("meta.categoryDescriptionFallback", { name })).toBe(`PulseNovelで「${name}」の小説を見つけよう。`);
    }
  });

  /**
   * 第三方（GPT）验收（45 条中 13 条 NEEDS_CHANGE）+ Owner 2026-10-09 裁定：en 3 条不改，其余 10 条
   * 按 GPT 模板逐字替换。期望值写成字面量（特殊字符用码点转义），必须与源码逐字相等：
   * ‘ ’ = U+2018/U+2019（不是 ASCII 撇号），： = U+FF1A，「」= U+300C/U+300D，空格 = U+0020。
   */
  describe("2026-10-09 第三方验收：4 个语种 10 条值逐字钉住", () => {
    const catalog = (locale: SiteLocale) =>
      CATALOGS[locale] as { collection: { categoryTitle: string; categoryHeading: string }; meta: { categoryDescriptionFallback: string } };

    it("ru：标题/标题形式 'Романы: {name}'，描述 'Откройте для себя …'", () => {
      expect(catalog("ru").collection.categoryHeading).toBe("Романы: {name}");
      expect(catalog("ru").collection.categoryTitle).toBe("Романы: {name}");
      expect(catalog("ru").meta.categoryDescriptionFallback).toBe("Откройте для себя романы в категории «{name}» на PulseNovel.");
    });

    it("th：描述只在 บน 前加一个普通空格；两个标题键不动", () => {
      expect(catalog("th").meta.categoryDescriptionFallback).toBe("ค้นพบนิยาย{name} บน PulseNovel");
      expect(catalog("th").collection.categoryHeading).toBe("นิยาย{name}");
      expect(catalog("th").collection.categoryTitle).toBe("นิยาย{name}");
    });

    it("ko：'소설: {name}'，描述用 U+2018/U+2019 括分类名并补 카테고리", () => {
      expect(catalog("ko").collection.categoryHeading).toBe("소설: {name}");
      expect(catalog("ko").collection.categoryTitle).toBe("소설: {name}");
      const description = catalog("ko").meta.categoryDescriptionFallback;
      expect(description).toBe("PulseNovel에서 \u2018{name}\u2019 카테고리의 소설을 만나보세요.");
      expect(description).not.toContain("'");
    });

    it("zh-Hant：'小說：{name}'（全角冒号），描述 PulseNovel 两侧各一个半角空格", () => {
      expect(catalog("zh-Hant").collection.categoryHeading).toBe("小說\uFF1A{name}");
      expect(catalog("zh-Hant").collection.categoryTitle).toBe("小說\uFF1A{name}");
      const description = catalog("zh-Hant").meta.categoryDescriptionFallback;
      expect(description).toBe("在 PulseNovel 探索\u300C{name}\u300D分類的小說。");
      expect(description).toContain("\u0020PulseNovel\u0020");
      expect(description).not.toMatch(/[\u00A0\u3000]/);
    });

    it("渲染：ko/zh-Hant/ru 套 female-audience / fantasy / from-hate-to-love", () => {
      const ko = ["여성향", "판타지", "미움에서 사랑으로"];
      const zh = ["女性向", "奇幻", "由恨生愛"];
      const ru = ["Для женской аудитории", "Фэнтези", "От ненависти к любви"];
      ko.forEach((name) => {
        expect(headingOf("ko", name)).toBe(`소설: ${name}`);
        expect(descriptionOf("ko", name)).toBe(`PulseNovel에서 \u2018${name}\u2019 카테고리의 소설을 만나보세요.`);
      });
      zh.forEach((name) => {
        expect(headingOf("zh-Hant", name)).toBe(`小說\uFF1A${name}`);
        expect(descriptionOf("zh-Hant", name)).toBe(`在 PulseNovel 探索\u300C${name}\u300D分類的小說。`);
      });
      ru.forEach((name) => {
        expect(headingOf("ru", name)).toBe(`Романы: ${name}`);
        expect(descriptionOf("ru", name)).toBe(`Откройте для себя романы в категории «${name}» на PulseNovel.`);
      });
      ["แฟนตาซี", "สำหรับผู้อ่านหญิง", "จากเกลียดกลายเป็นรัก"].forEach((name) => {
        expect(descriptionOf("th", name)).toBe(`ค้นพบนิยาย${name} บน PulseNovel`);
      });
    });
  });

  it("/browse?category= 的 <title>：非英语语种与分类页 H1 是同一个形式（ja/de/fr）", async () => {
    loadCategoryPage.mockResolvedValue(categoryPage(1, "Fantasy", "fantasy"));
    for (const locale of ["ja", "de", "fr"] as const) {
      const metadata = await buildBrowseMetadata(locale, Promise.resolve({ category: "fantasy" }));
      expect(titleOf(metadata), locale).toBe(headingOf(locale, "Fantasy"));
    }
  });
});
