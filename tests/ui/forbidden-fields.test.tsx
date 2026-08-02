import "./setup-cleanup";
import type { ReactElement } from "react";
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { ChapterScreen } from "@/features/public-ui/chapter/ChapterScreen";
import { CollectionScreen } from "@/features/public-ui/collection/CollectionScreen";
import { HomeScreen } from "@/features/public-ui/home/HomeScreen";
import { NovelDetailScreen } from "@/features/public-ui/novel/NovelDetailScreen";
import { UnavailableScreen } from "@/features/public-ui/status/UnavailableScreen";
import { mockChrome } from "@/features/public-ui/fixtures/mock-chrome";
import {
  MOCK_CHAPTER,
  MOCK_CHAPTER_LAST,
  MOCK_NOVEL_CARDS,
  MOCK_NOVEL_DETAIL,
  MOCK_NOVEL_DETAIL_SPARSE,
} from "@/features/public-ui/fixtures/mock-content";

/**
 * 全屏幕的禁用字段扫描。
 *
 * 这些字段在上游官网上存在，但分销接口不提供——它们的状态是
 * 「仅存在于上游官网 / 分销接口不提供 / 不是本期设计输入」。
 * 页面上不得出现，也不得留占位槽位。
 *
 * 口径见 docs/p1/P1_10_VISUAL_DIRECTION.md 第九节。
 */

const FORBIDDEN_ZH = [
  "作者",
  "评分",
  "打分",
  "阅读量",
  "播放量",
  "浏览量",
  "完结",
  "连载",
  "国家",
  "地区",
  "发布日期",
  "更新时间",
  "同作者",
  "全书进度",
  "完整目录",
  "全部章节",
  "分成",
  "推广码",
  "下载应用",
  "评论",
  "收藏",
  "登录",
  "注册",
  "会员",
];

const FORBIDDEN_EN = [
  "author",
  "rating",
  "views",
  "completed",
  "ongoing",
  "country",
  "released on",
  "word count",
  "app store",
  "google play",
  "sign in",
  "sign up",
  "favorite",
  "comment",
  "split ratio",
  "upstream code",
];

const SCREENS: [string, ReactElement][] = [
  [
    "首页",
    <HomeScreen
      key="home"
      chrome={mockChrome("home")}
      featured={MOCK_NOVEL_DETAIL}
      featuredDetailHref="/dev-preview/novel"
      featuredStartReadingHref="/dev-preview/chapter"
      novels={MOCK_NOVEL_CARDS}
      browseAllHref="/dev-preview/collection"
    />,
  ],
  [
    "小说详情",
    <NovelDetailScreen key="detail" chrome={mockChrome()} novel={MOCK_NOVEL_DETAIL} />,
  ],
  [
    "小说详情 · 稀疏",
    <NovelDetailScreen key="sparse" chrome={mockChrome()} novel={MOCK_NOVEL_DETAIL_SPARSE} />,
  ],
  ["章节阅读", <ChapterScreen key="chapter" chrome={mockChrome()} chapter={MOCK_CHAPTER} />],
  [
    "章节阅读 · 末章",
    <ChapterScreen key="last" chrome={mockChrome()} chapter={MOCK_CHAPTER_LAST} />,
  ],
  [
    "聚合",
    <CollectionScreen
      key="collection"
      chrome={mockChrome("collection")}
      title="言情"
      novels={MOCK_NOVEL_CARDS}
    />,
  ],
  [
    "下架",
    <UnavailableScreen key="unpublished" chrome={mockChrome()} reason="unpublished" />,
  ],
  ["撤回", <UnavailableScreen key="takedown" chrome={mockChrome()} reason="takedown" />],
];

describe("全屏幕禁用字段扫描", () => {
  it.each(SCREENS)("%s 的可见文本不含任何禁用字段", (_name, element) => {
    const { container } = render(element);
    const text = container.textContent ?? "";
    const lower = text.toLowerCase();

    const hits: string[] = [];
    for (const term of FORBIDDEN_ZH) {
      if (text.includes(term)) {
        hits.push(term);
      }
    }
    for (const term of FORBIDDEN_EN) {
      if (lower.includes(term)) {
        hits.push(term);
      }
    }

    expect(hits).toEqual([]);
  });

  it.each(SCREENS)("%s 的标记里不含禁用字段的数据属性", (_name, element) => {
    const { container } = render(element);
    const html = container.innerHTML;

    for (const pattern of [
      /data-[\w-]*author/i,
      /data-[\w-]*rating/i,
      /data-[\w-]*views/i,
      /split[_-]?ratio/i,
      /upstream[_-]?code/i,
    ]) {
      expect(html, `命中禁用属性 ${pattern}`).not.toMatch(pattern);
    }
  });

  it.each(SCREENS)("%s 不用 emoji 装饰区块标题", (_name, element) => {
    const { container } = render(element);

    for (const heading of container.querySelectorAll("h1, h2, h3")) {
      expect(heading.textContent ?? "").not.toMatch(/\p{Extended_Pictographic}/u);
    }
  });
});