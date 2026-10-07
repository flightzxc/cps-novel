import "./setup-cleanup";

import { render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  books,
  makeFakeDb,
  slugParamOf,
  TAXONOMY_KEY,
  WINDOW_KEY,
  type Category,
  type FakeDb,
} from "../fixtures/in-memory-public-db";

/**
 * B-38 第二部分（2026-10-07）：站内分类链接只指向页面确实返回 200 的分类。
 *
 * 这份用例走**真实**的 `@/app/_pages/novel-detail`（`generateMetadata` 与页面本体）→ 真实的
 * `@/app/_lib/public-load` → 真实的 `queries` / `category-queries` / `public-taxonomy` / 推荐候选池，
 * 只把数据库换成一个**遵守 `take` / 排序**的内存 db（en 300 本，最新 240 本 = 序号 61..300），并把
 * `React.cache` 换成"一次请求一个作用域"的记忆化实现（vitest 里的 `react` 是客户端构建，`cache` 是直通，
 * 不换就测不出请求内去重）。它同时做四件事：
 *   1. 页面上每一个 `/category/{slug}` 链接，用 `getPublicCategoryPage`（同一个 db、同一套谓词）查都不为 null；
 *      页面列表窗口之外的分类（页面会 404）只渲染成没有 href 的纯文字；
 *   2. 数一次详情页渲染（`generateMetadata` + 页面本体，同一个请求）实际发了几次页面的列表查询
 *      （`article.findMany`，`take = PUBLIC_LIST_CAP`——`listPublicArticles` / `listPublicCategories` 的等价查询）；
 *   3. 标签数量增加时查询次数不增加（不是每个标签各查一次）；
 *   4. 章节页、推荐区、首页主推位同口径：章节页（每本书的每个试读章都会被收录）的页脚分类同样只查一次，
 *      推荐卡片的标签（候选池 500 本，比窗口大）按同一规则收口，主推位的标签恒为空（没有分类链接可出）。
 */

const NOT_FOUND = Symbol("next-not-found");

const h = vi.hoisted(() => {
  const ids = new WeakMap<object, number>();
  let nextId = 0;
  const part = (value: unknown): string =>
    value !== null && (typeof value === "object" || typeof value === "function")
      ? `o${ids.get(value as object) ?? (ids.set(value as object, ++nextId), nextId)}`
      : `${typeof value}:${String(value)}`;
  return {
    stores: [] as Array<Map<string, unknown>>,
    part,
    db: { current: null as unknown },
  };
});

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  // 与 React 的 `cache` 同一语义：同一请求内、同一组实参（按引用，且实参个数也是键的一部分）只执行一次。
  const cache = <A extends unknown[], R>(fn: (...args: A) => R) => {
    const store = new Map<string, unknown>();
    h.stores.push(store);
    return (...args: A): R => {
      const key = `${args.length}|${args.map(h.part).join("|")}`;
      if (!store.has(key)) store.set(key, fn(...args));
      return store.get(key) as R;
    };
  };
  return { ...actual, cache };
});

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw NOT_FOUND;
  },
  permanentRedirect: () => {
    throw new Error("unexpected redirect");
  },
  usePathname: () => "/",
  useRouter: () => ({ push: () => {}, replace: () => {} }),
}));

vi.mock("@/app/_lib/public-deps", () => ({
  prisma: new Proxy({}, { get: (_target, key) => Reflect.get(h.db.current as object, key) }),
}));

vi.mock("@/lib/locale/active-locales", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/locale/active-locales")>()),
  getActiveLocales: async () => ["en"],
}));

const novelDetail = await import("@/app/_pages/novel-detail");
const chapterPage = await import("@/app/_pages/chapter");
const publicLoad = await import("@/app/_lib/public-load");
const { getHomeCarouselItems } = await import("@/lib/site/home-carousel-service");
const { getPublicCategoryPage } = await import("@/lib/site/category-queries");
const { clearRelatedNovelsPoolCacheForTest } = await import("@/lib/site/related-novels");
const { invalidateSiteSettingCache } = await import("@/server/site-settings/service");

// ---------------------------------------------------------------------------
// en 300 本（内存 db 见 `tests/fixtures/in-memory-public-db.ts`）：序号 g 的发布时间 = BASE + g 秒，
// 最新 240 本 = 序号 61..300。
// ---------------------------------------------------------------------------

const ROWS = books(300);
const CATEGORIES: Category[] = [
  { slug: "adventure", sortOrder: 1, ordinals: [[5, 50]] }, // 书全在窗口（61..300）之外：页面 404
  { slug: "fantasy", sortOrder: 2, ordinals: [[70, 114], [10, 40]] }, // 窗口之内 45 本 + 之外 31 本：页面 200
  { slug: "romance", sortOrder: 3, ordinals: [[30, 30], [200, 200]] }, // 一外一内：页面 200
  { slug: "mystery", sortOrder: 4, ordinals: [[250, 252]] }, // 全在窗口之内：页面 200
];

function startRequest(categories: readonly Category[] = CATEGORIES, rows: typeof ROWS = ROWS) {
  for (const store of h.stores) store.clear();
  invalidateSiteSettingCache();
  clearRelatedNovelsPoolCacheForTest();
  const fake = makeFakeDb(rows, categories);
  h.db.current = fake.db;
  return fake;
}

type Fake = FakeDb;

/** 一次详情页渲染 = 同一个请求里的 `generateMetadata` 与页面本体（Next 并行解析两者）。 */
async function renderDetail(ordinal: number, fake: Fake, locale: "en" | "ko" = "en") {
  const params = Promise.resolve({ slugParam: slugParamOf(ordinal, locale) });
  const [metadata, tree] = await Promise.all([
    novelDetail.buildNovelMetadata(locale, params),
    novelDetail.NovelBody({ locale, params }),
  ]);
  const { container } = render(tree);
  return { metadata, container, counts: { ...fake.counts } };
}

/** 章节页同理：`generateMetadata` 与页面本体在同一个请求里。 */
async function renderChapter(ordinal: number, fake: Fake) {
  const params = Promise.resolve({ slugParam: slugParamOf(ordinal), chapterNumber: "1" });
  const [metadata, tree] = await Promise.all([
    chapterPage.buildChapterMetadata("en", params),
    chapterPage.ChapterBody({ locale: "en", params }),
  ]);
  const { container } = render(tree);
  return { metadata, container, counts: { ...fake.counts } };
}

function categoryAnchors(root: ParentNode): Array<{ slug: string; text: string }> {
  return [...root.querySelectorAll<HTMLAnchorElement>('a[href*="/category/"]')].map((anchor) => ({
    slug: anchor.getAttribute("href")!.split("/category/")[1]!,
    text: anchor.textContent ?? "",
  }));
}

function detailTags(container: HTMLElement) {
  return [...container.querySelectorAll<HTMLElement>('[data-testid="tag-list"] li > *')].map((node) => ({
    text: node.textContent ?? "",
    tag: node.tagName.toLowerCase(),
    href: node.getAttribute("href"),
  }));
}

function sum(counts: Record<string, number>) {
  return Object.values(counts).reduce((total, value) => total + value, 0);
}

beforeEach(() => {
  process.env.SITE_URL = "https://novel.example";
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.SITE_URL;
});

describe("详情页的分类标签只在分类页确实返回 200 时才是链接", () => {
  it("书在最新 240 本之外：窗口里一本都没有的分类（页面 404）渲染成没有 href 的纯文字，其余照常是链接", async () => {
    const fake = startRequest();
    // 夹具自检：book-30 在窗口之外，adventure 页面是 404，fantasy / romance 页面是 200。
    expect(await getPublicCategoryPage(fake.db, "en", "adventure", 1)).toBeNull();
    expect(await getPublicCategoryPage(fake.db, "en", "fantasy", 1)).not.toBeNull();
    expect(await getPublicCategoryPage(fake.db, "en", "romance", 1)).not.toBeNull();

    const { container } = await renderDetail(30, startRequest());

    expect(detailTags(container)).toEqual([
      { text: "Adventure", tag: "span", href: null },
      { text: "Fantasy", tag: "a", href: "/category/fantasy" },
      { text: "Romance", tag: "a", href: "/category/romance" },
    ]);
    expect(container.querySelector('a[href="/category/adventure"]')).toBeNull();
  });

  it("书在最新 240 本之内：它的分类（页面 200）照常是链接", async () => {
    const { container } = await renderDetail(250, startRequest());
    expect(detailTags(container)).toEqual([{ text: "Mystery", tag: "a", href: "/category/mystery" }]);
  });

  it("全页核对：详情页上出现的每一个 /category/{slug} 链接，getPublicCategoryPage 都不为 null（含页脚）", async () => {
    for (const ordinal of [30, 45, 250]) {
      const fake = startRequest();
      const { container } = await renderDetail(ordinal, fake);
      const anchors = categoryAnchors(container);
      expect(anchors.length, `book-${ordinal}`).toBeGreaterThan(0);
      for (const { slug } of anchors) {
        expect(await getPublicCategoryPage(fake.db, "en", slug, 1), `book-${ordinal} → /category/${slug}`).not.toBeNull();
      }
    }
  });
});

describe("章节页、推荐区、首页主推位的分类链接同口径", () => {
  const WITH_COZY: Category[] = [...CATEGORIES, { slug: "cozy", sortOrder: 5, ordinals: [[298, 300]] }];

  it("推荐卡片（候选池 500 本 > 窗口 240 本）：窗口之外的分类去掉 href，窗口之内的保留；每个保留 href 的标签页面都是 200、每个去掉的页面都是 404", async () => {
    // 随机采样固定取候选池最前面的（`sampleEntries` 的 Math.random() = 0 → 不换位）：
    // book-45 只有 adventure，"相关推荐"取共享 adventure 的最新几本（序号 50..46，标签都是窗口之外的 adventure），
    // "新书推荐"取最新几本（序号 300..295，其中 298..300 有窗口之内的 cozy）。
    vi.spyOn(Math, "random").mockReturnValue(0);
    const fake = startRequest(WITH_COZY);
    const { related, newReleases } = await publicLoad.loadRelatedAndNewReleases("en", "article-en-0045", "novel-en-45");

    const cards = [...related, ...newReleases];
    const tags = cards.flatMap((card) => card.tags);
    expect(related.length).toBeGreaterThan(0);
    expect(newReleases.length).toBeGreaterThan(0);
    // 非空洞：两种标签都出现过。
    expect(tags.some((tag) => tag.href === undefined)).toBe(true);
    expect(tags.some((tag) => tag.href !== undefined)).toBe(true);
    expect(tags.filter((tag) => tag.href === undefined).map((tag) => tag.slug)).toContain("adventure");
    expect(tags.filter((tag) => tag.href !== undefined).map((tag) => tag.slug)).toContain("cozy");
    for (const tag of tags) {
      const pageOk = (await getPublicCategoryPage(fake.db, "en", tag.slug, 1)) !== null;
      expect(tag.href !== undefined, `${tag.slug}: 页面 200=${pageOk}`).toBe(pageOk);
      if (tag.href !== undefined) expect(tag.href).toBe(`/category/${tag.slug}`);
    }
  });

  it("章节页：页脚分类只查一次（改前 2 次），页面上的每个 /category/{slug} 链接页面都是 200", async () => {
    const fake = startRequest();
    const { container, counts } = await renderChapter(30, fake);
    expect(counts[WINDOW_KEY]).toBe(1);
    // 改前 14 条语句（列表窗口 2 次、标签投影 5 次）；改后 12 条。
    expect(sum(counts)).toBeLessThanOrEqual(12);
    const anchors = categoryAnchors(container);
    expect(anchors.length).toBeGreaterThan(0);
    for (const { slug } of anchors) {
      expect(await getPublicCategoryPage(fake.db, "en", slug, 1), `/category/${slug}`).not.toBeNull();
    }
  });

  it("首页主推位：条目的标签恒为空（主推位不渲染分类链接）", async () => {
    const fake = startRequest();
    const items = await getHomeCarouselItems("en", fake.db);
    expect(items.length).toBeGreaterThan(0);
    // 主推位取的是详情视图，但 `toFeatured` 不加载标签；有人给它加标签时，必须同时给它过 `restrictViewTagLinks`。
    expect(items.every((item) => item.novel.tags.length === 0)).toBe(true);
  });
});

/**
 * 语种错配（主控复核补的盲区）：判定集合必须按**这本书自己的语种**取。
 * 若误用别的语种（例如固定取 en）的集合，非 en 的书会按 en 的窗口决定是否保留链接：一个分类在 en 窗口里有书、
 * 在 ko 窗口里没有时，ko 详情页就会给它留下 `/ko/category/x`，而这个页面是 404；反向，只在 ko 窗口里有书的分类
 * 在 ko 详情页上反而会被去掉链接。夹具里同一个分类在两个语种的窗口里情况相反，两个方向都钉住。
 */
describe("语种错配：判定集合按书自己的语种取，不能串用别的语种的窗口", () => {
  // en、ko 各 300 本：各自最新 240 本 = 序号 61..300。
  const LOCALE_ROWS = [...books(300), ...books(300, "ko")];
  const MISMATCH: Category[] = [
    // sci-fi：en 窗口里有书（250..252）→ en 页面 200；ko 的书只有序号 30、31（ko 窗口之外）→ ko 页面 404。
    { slug: "sci-fi", sortOrder: 1, locale: "en", ordinals: [[250, 252]] },
    { slug: "sci-fi", sortOrder: 2, locale: "ko", ordinals: [[30, 31]] },
    // wuxia：ko 窗口里有书（250..252，另有窗口之外的 30）→ ko 页面 200；en 只有窗口之外的序号 30 → en 页面 404。
    { slug: "wuxia", sortOrder: 3, locale: "ko", ordinals: [[30, 30], [250, 252]] },
    { slug: "wuxia", sortOrder: 4, locale: "en", ordinals: [[30, 30]] },
    // mecha：只有 ko，最新的 11 本（ko 窗口之内）→ ko 页面 200，en 一本都没有。推荐区的"最新几本"都带它。
    { slug: "mecha", sortOrder: 5, locale: "ko", ordinals: [[290, 300]] },
  ];

  it("夹具自检：同一个分类在 en 与 ko 的页面状态相反", async () => {
    const { db } = startRequest(MISMATCH, LOCALE_ROWS);
    expect(await getPublicCategoryPage(db, "en", "sci-fi", 1)).not.toBeNull();
    expect(await getPublicCategoryPage(db, "ko", "sci-fi", 1)).toBeNull();
    expect(await getPublicCategoryPage(db, "ko", "wuxia", 1)).not.toBeNull();
    expect(await getPublicCategoryPage(db, "en", "wuxia", 1)).toBeNull();
  });

  it("ko 详情页：en 窗口里有书、ko 窗口里没有的分类无 href；只在 ko 窗口里有书的分类有 href（含 /ko 前缀）", async () => {
    // ko 序号 30（ko 窗口之外）同时挂 sci-fi（ko 页面 404）与 wuxia（ko 页面 200）。
    const { container } = await renderDetail(30, startRequest(MISMATCH, LOCALE_ROWS), "ko");
    expect(detailTags(container)).toEqual([
      { text: "Sci-fi", tag: "span", href: null },
      { text: "Wuxia", tag: "a", href: "/ko/category/wuxia" },
    ]);
    expect(container.querySelector('a[href*="/category/sci-fi"]')).toBeNull();
  });

  it("ko 详情页：书在 ko 窗口之内、分类只在 ko 窗口里有书 → 仍是链接", async () => {
    const { container } = await renderDetail(250, startRequest(MISMATCH, LOCALE_ROWS), "ko");
    expect(detailTags(container)).toEqual([{ text: "Wuxia", tag: "a", href: "/ko/category/wuxia" }]);
  });

  it("en 详情页对称：只看 en 窗口——sci-fi 是链接、窗口之外才有书的 wuxia 无 href", async () => {
    expect(detailTags((await renderDetail(250, startRequest(MISMATCH, LOCALE_ROWS), "en")).container))
      .toEqual([{ text: "Sci-fi", tag: "a", href: "/category/sci-fi" }]);
    expect(detailTags((await renderDetail(30, startRequest(MISMATCH, LOCALE_ROWS), "en")).container))
      .toEqual([{ text: "Wuxia", tag: "span", href: null }]);
  });

  it("ko 全页核对：页面上出现的每个 /ko/category/{slug} 链接，ko 的 getPublicCategoryPage 都不为 null（含页脚）", async () => {
    const fake = startRequest(MISMATCH, LOCALE_ROWS);
    const { container } = await renderDetail(30, fake, "ko");
    const anchors = categoryAnchors(container);
    expect(anchors.length).toBeGreaterThan(0);
    for (const { slug } of anchors) {
      expect(await getPublicCategoryPage(fake.db, "ko", slug, 1), `/ko/category/${slug}`).not.toBeNull();
    }
  });

  it("ko 推荐卡片（数据层同一个函数，相关推荐与新书推荐两处都走）：每个标签有 href ⟺ ko 页面 200；两个方向都出现", async () => {
    // Math.random() = 0：随机采样取候选池最前面的。当前书 = ko 序号 31（只有 sci-fi）：
    //   相关推荐 = 共享 sci-fi 的 ko 序号 30（标签 sci-fi：ko 页面 404、en 页面 200；wuxia：ko 页面 200、en 页面 404），
    //             再用最新的无共享标签的书（序号 300..296，标签 mecha：只有 ko 有，ko 页面 200）补齐；
    //   新书推荐 = 其后最新的几本（序号 295..290，标签同为 mecha）。
    vi.spyOn(Math, "random").mockReturnValue(0);
    const fake = startRequest(MISMATCH, LOCALE_ROWS);
    const { related, newReleases } = await publicLoad.loadRelatedAndNewReleases("ko", "article-ko-0031", "novel-ko-31");

    const tagsOf = (cards: typeof related) => cards.flatMap((card) => card.tags);
    expect(tagsOf(related).filter((tag) => tag.slug === "sci-fi").map((tag) => tag.href)).toEqual([undefined]);
    expect(tagsOf(related).filter((tag) => tag.slug === "wuxia").map((tag) => tag.href)).toEqual(["/ko/category/wuxia"]);
    // 两个推荐区各自都带 mecha（只有 ko 有）：若判定误用 en 的集合，两处都会被去掉链接。
    for (const [name, cards] of [["相关推荐", related], ["新书推荐", newReleases]] as const) {
      const mecha = tagsOf(cards).filter((tag) => tag.slug === "mecha");
      expect(mecha.length, name).toBeGreaterThan(0);
      expect(mecha.map((tag) => tag.href), name).toEqual(mecha.map(() => "/ko/category/mecha"));
    }
    for (const tag of [...tagsOf(related), ...tagsOf(newReleases)]) {
      const pageOk = (await getPublicCategoryPage(fake.db, "ko", tag.slug, 1)) !== null;
      expect(tag.href !== undefined, `${tag.slug}: ko 页面 200=${pageOk}`).toBe(pageOk);
    }
  });
});

describe("详情页一次渲染的查询次数（cold：站点设置缓存与推荐候选池都未命中）", () => {
  it("页面的列表查询（take = PUBLIC_LIST_CAP）一次渲染只发 1 次：页脚与分类链接判定共用同一份，不再因 loadChrome 实参列表不同重复查", async () => {
    const { counts } = await renderDetail(30, startRequest());
    expect(counts[WINDOW_KEY]).toBe(1);
    // 标签投影（`$queryRaw`）：页脚分类 1 + 本书 1 + 推荐候选池 1 + 推荐的"当前书"1 = 4（改前 5）。
    expect(counts[TAXONOMY_KEY]).toBeLessThanOrEqual(4);
    // 一次渲染共 ≤ 11 条数据库语句（改前 13 条：列表窗口 2 次、标签投影 5 次）。
    expect(sum(counts)).toBeLessThanOrEqual(11);
  });

  it("标签从 1 个增加到 13 个，查询次数不变（不是每个标签各查一次）", async () => {
    // 额外 12 个分类全部只挂在 book-45 上（序号 45 在窗口之外：这些分类页面都是 404）。
    const many: Category[] = [
      ...CATEGORIES,
      ...Array.from({ length: 12 }, (_, index) => ({
        slug: `extra-${index + 1}`, sortOrder: 10 + index, ordinals: [[45, 45]] as const,
      })),
    ];
    const one = await renderDetail(250, startRequest(CATEGORIES));
    const thirteen = await renderDetail(45, startRequest(many));
    expect(detailTags(one.container)).toHaveLength(1);
    expect(detailTags(thirteen.container)).toHaveLength(13);
    expect(thirteen.counts).toEqual(one.counts);
    expect(thirteen.counts["canonicalTag.findFirst"] ?? 0).toBe(0);
  });
});
