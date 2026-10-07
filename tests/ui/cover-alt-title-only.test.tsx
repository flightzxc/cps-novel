import "./setup-cleanup";
import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BookCard } from "@/features/public-ui/book/BookCard";
import { FeaturedNovel } from "@/features/public-ui/home/FeaturedNovel";
import { HomeScreen } from "@/features/public-ui/home/HomeScreen";
import { NovelDetailScreen } from "@/features/public-ui/novel/NovelDetailScreen";
import {
  MOCK_FEATURED_LIST,
  MOCK_NOVEL_CARDS,
  MOCK_NOVEL_DETAIL,
} from "@/features/public-ui/fixtures/mock-content";
import type { NovelCardView } from "@/features/public-ui/types";
import { SITE_LOCALES, type SiteLocale } from "@/lib/locale/locale-canonical";
import { loadMessages, t } from "@/lib/locale/messages";

/**
 * 书封 alt 只保留书名（Owner 2026-10-07）。
 *
 * 此前 15 个语种的 `novel.coverAlt` 各带一个前缀（en "Cover of {title}"、de
 * "Cover von {title}"、ja「{title}」の表紙、zh-Hant《{title}》封面……），读屏时
 * 与紧挨着的书名标题重复。现在整条文案就是 `{title}`。
 *
 * 两层断言：
 *   1. 目录层：15 个语种渲染出来的 alt **恰好等于**书名（含带引号/CJK/本身就含
 *      "Cover of" 的书名——后者能识别出"前缀被悄悄加回去"这种回归）；
 *   2. 组件层：四个使用点（BookCard / FeaturedHero / FeaturedNovel /
 *      NovelDetailScreen）在 en 与非 en 语种下，封面 `<img>` 的 alt 等于书名本身，
 *      且不为空。
 */

/** 非 en 语种取三个书写体系各异的：日文（旧文案是「」…の表紙）、俄文（«»）、繁体中文（《》…封面）。 */
const NON_EN_SAMPLE: readonly SiteLocale[] = ["ja", "ru", "zh-Hant"];
const COMPONENT_CASES: readonly SiteLocale[] = ["en", ...NON_EN_SAMPLE];

const TITLES = [
  "The Lantern Keeper's Daughter",
  "夜航船",
  "Обложка книги",
  // 书名里本身就含旧前缀的字样：alt 必须原样等于书名，而不是再叠一层前缀
  "Cover of the Moon",
] as const;

beforeEach(() => {
  // HomeScreen 的 Hero 用 matchMedia 判断是否停自动播放；jsdom 没有。
  vi.stubGlobal(
    "matchMedia",
    vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
      onchange: null,
    })),
  );
});

afterEach(() => vi.unstubAllGlobals());

describe("novel.coverAlt · 目录层（15 个语种）", () => {
  it.each(SITE_LOCALES)("%s: 渲染结果恰好等于书名，没有任何语种前缀/引号/后缀", (locale) => {
    const messages = loadMessages(locale);
    for (const title of TITLES) {
      const alt = t(messages, "novel.coverAlt", locale, { title });
      expect(alt).toBe(title);
      expect(alt.length).toBeGreaterThan(0);
    }
  });
});

describe("书封 alt · 组件层（en 与非 en 语种）", () => {
  const card = (title: string): NovelCardView => ({
    ...MOCK_NOVEL_CARDS[0]!,
    title,
  });

  it.each(COMPONENT_CASES)("BookCard（%s）：封面 alt 等于书名本身", (locale) => {
    for (const title of TITLES) {
      const { container, unmount } = render(<BookCard locale={locale} novel={card(title)} />);
      const img = container.querySelector("img");
      expect(img, `BookCard 没有渲染封面 <img>（title=${title}）`).not.toBeNull();
      expect(img!.getAttribute("alt")).toBe(title);
      unmount();
    }
  });

  it.each(COMPONENT_CASES)("NovelDetailScreen（%s）：主封面 alt 等于书名本身", (locale) => {
    for (const title of TITLES) {
      const { container, unmount } = render(
        <NovelDetailScreen locale={locale} novel={{ ...MOCK_NOVEL_DETAIL, title }} />,
      );
      const img = container.querySelector("img");
      expect(img, `详情页没有渲染主封面 <img>（title=${title}）`).not.toBeNull();
      expect(img!.getAttribute("alt")).toBe(title);
      unmount();
    }
  });

  it.each(COMPONENT_CASES)("FeaturedNovel（%s）：封面 alt 等于书名本身", (locale) => {
    const { container } = render(
      <FeaturedNovel
        locale={locale}
        novel={{ ...MOCK_NOVEL_DETAIL, title: TITLES[1] }}
        eyebrow="Featured"
        detailHref="/dev-preview/novel"
        startReadingHref="/dev-preview/chapter"
      />,
    );
    const img = container.querySelector("img");
    expect(img).not.toBeNull();
    expect(img!.getAttribute("alt")).toBe(TITLES[1]);
  });

  it.each(COMPONENT_CASES)("FeaturedHero（%s）：当前主推的封面 alt 等于该书书名", (locale) => {
    const entries = MOCK_FEATURED_LIST.map((novel) => ({
      novel,
      detailHref: "/dev-preview/novel",
      startReadingHref: "/dev-preview/chapter",
    }));
    render(<HomeScreen locale={locale} featuredList={entries} novels={MOCK_NOVEL_CARDS} />);

    const cover = screen.getByTestId("featured-hero-cover");
    const img = cover.querySelector("img");
    expect(img, "Hero 当前项没有渲染封面 <img>").not.toBeNull();
    expect(img!.getAttribute("alt")).toBe(MOCK_FEATURED_LIST[0]!.title);
  });
});
