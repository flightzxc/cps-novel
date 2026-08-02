/**
 * MOCK_ONLY —— 仅供开发预览的假数据。
 *
 * 🔴 本文件的一切都是编造的，不来自任何接口、数据库或上游内容。
 * 它存在的唯一目的是让 P1-10 的页面壳在没有后端的情况下可以被看见和被测试。
 *
 * 🔴 字段范围严格等于 src/features/public-ui/types.ts 允许的字段。
 * 这里不得出现作者、评分、阅读量、完结状态、国家、章节发布日期等——
 * 这些字段分销接口不提供，在假数据里造出来会让页面看起来「本来就该有」。
 */

import type {
  ChapterView,
  NovelCardView,
  NovelDetailView,
  SiteTag,
} from "@/features/public-ui/types";

/** 生成一张内联占位封面。用于演示「封面是全站唯一高饱和元素」这条方向定调。 */
function mockCover(from: string, to: string, seed: number): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 400">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
<stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/>
</linearGradient></defs>
<rect width="300" height="400" fill="url(#g)"/>
<circle cx="${60 + seed * 37}" cy="${120 + seed * 23}" r="${70 + seed * 11}" fill="#ffffff" opacity="0.14"/>
<circle cx="${230 - seed * 19}" cy="${300 - seed * 17}" r="${50 + seed * 9}" fill="#000000" opacity="0.18"/>
</svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

const TAGS: Record<string, SiteTag> = {
  modern: { slug: "modern", label: "都市", href: "/dev-preview/collection" },
  romance: { slug: "romance", label: "言情", href: "/dev-preview/collection" },
  fantasy: { slug: "fantasy", label: "奇幻", href: "/dev-preview/collection" },
  suspense: { slug: "suspense", label: "悬疑", href: "/dev-preview/collection" },
};

const EN = { code: "en", label: "English" };

/** 详情页地址在 URL 结构冻结前一律指向开发预览路由 */
const DETAIL_HREF = "/dev-preview/novel";
const CHAPTER_HREF = "/dev-preview/chapter";

export const MOCK_NOVEL_CARDS: NovelCardView[] = [
  {
    id: "mock-1",
    title: "The Lantern Keeper's Daughter",
    coverUrl: mockCover("#8b3a62", "#2b1d4a", 1),
    tags: [TAGS.romance, TAGS.modern],
    locale: EN,
    href: DETAIL_HREF,
  },
  {
    id: "mock-2",
    title: "Salt, Smoke and Second Chances",
    coverUrl: mockCover("#c2703a", "#4a2415", 2),
    tags: [TAGS.romance],
    locale: EN,
    href: DETAIL_HREF,
  },
  {
    id: "mock-3",
    // 标签为空的一本：用来验证标签区块整体消失，而不是留下空位
    title: "Nine Winters in the Glass House",
    coverUrl: mockCover("#2f6d7a", "#12303a", 3),
    tags: [],
    locale: EN,
    href: DETAIL_HREF,
  },
  {
    id: "mock-4",
    title: "The Cartographer of Small Regrets",
    coverUrl: mockCover("#6b4ea8", "#241a44", 4),
    tags: [TAGS.fantasy],
    locale: EN,
    href: DETAIL_HREF,
  },
  {
    id: "mock-5",
    // 无封面的一本：用来验证缺图时渲染占位块，卡片版面不塌
    title: "Every Door Was Once a Wall",
    tags: [TAGS.suspense],
    locale: EN,
    href: DETAIL_HREF,
  },
  {
    id: "mock-6",
    title: "A Quiet Inheritance",
    coverUrl: mockCover("#a8434a", "#3a1218", 5),
    tags: [TAGS.modern, TAGS.suspense],
    locale: EN,
    href: DETAIL_HREF,
  },
  {
    id: "mock-7",
    title: "The Weight of Borrowed Names",
    coverUrl: mockCover("#3f7d55", "#16301f", 6),
    tags: [TAGS.fantasy, TAGS.romance],
    locale: EN,
    href: DETAIL_HREF,
  },
  {
    id: "mock-8",
    title: "Letters to the Harbor Master",
    coverUrl: mockCover("#b07d2a", "#3d2a0d", 7),
    tags: [TAGS.romance],
    locale: EN,
    href: DETAIL_HREF,
  },
  {
    id: "mock-9",
    title: "Where the Tide Keeps Score",
    coverUrl: mockCover("#4a5b9c", "#181f3c", 8),
    tags: [TAGS.suspense],
    locale: EN,
    href: DETAIL_HREF,
  },
  {
    id: "mock-10",
    title: "The Orchard That Remembers",
    coverUrl: mockCover("#8f5a2b", "#2e1c0e", 9),
    tags: [TAGS.fantasy],
    locale: EN,
    href: DETAIL_HREF,
  },
];

/**
 * 详情页假数据。
 *
 * 刻意保留一个真实存在的落差：总章数 265，可试读只有 3 章。
 * 这正是我们要面对的版面与诚实性问题，假数据里不许把它抹平。
 */
export const MOCK_NOVEL_DETAIL: NovelDetailView = {
  id: "mock-1",
  title: "The Lantern Keeper's Daughter",
  coverUrl: mockCover("#8b3a62", "#2b1d4a", 1),
  description:
    "港口的灯塔守了四十年，最后一任守塔人留下的不是航海日志，是一本写满陌生人名字的账簿。\n" +
    "女儿回到岛上处理遗物时，发现账簿上最新的一笔记在她自己名下，日期是三天后。\n" +
    "她决定留下来，等那一天到来——同时也等那个每晚准点出现在防波堤尽头、却从不上岸的人。",
  locale: EN,
  totalChapterCount: 265,
  tags: [TAGS.romance, TAGS.modern, TAGS.suspense],
  previewChapters: [
    { number: 1, title: "The Ledger of Strangers", href: CHAPTER_HREF },
    { number: 2, title: "Three Days from Now", href: CHAPTER_HREF },
    { number: 3, title: "The Man Who Never Comes Ashore", href: CHAPTER_HREF },
  ],
  readOnUpstreamHref: "/dev-preview/novel#mock-go-link",
};

/** 标签为空、无封面、且没有可试读章节的极端情况——版面必须仍然成立 */
export const MOCK_NOVEL_DETAIL_SPARSE: NovelDetailView = {
  id: "mock-3",
  title: "Nine Winters in the Glass House",
  description: "九个冬天里，玻璃房只开过一次门。",
  locale: EN,
  totalChapterCount: 88,
  tags: [],
  previewChapters: [],
};

const MOCK_PARAGRAPHS = [
  "灯塔的门锁了四十年，钥匙一直挂在门边的钉子上。这是岛上人尽皆知的矛盾，也是没有人去追究的那一种。",
  "她把行李放在门口的台阶上，先没有进去。海风从防波堤那头灌过来，带着咸味和一点点柴油的气息，和她记忆里的那股味道分毫不差。",
  "屋里比想象中干净。桌上摊着一本账簿，纸页被潮气泡得发软，边角却整整齐齐。她翻开第一页，看见的不是数字，是名字。",
  "一个接一个的名字，每个后面跟着一个日期，再后面是一个她看不懂的符号。有些符号重复出现，有些只出现过一次。",
  "她一页页往后翻，翻到最后一页时停住了。最后一行写着她自己的名字，日期是三天之后。",
  "窗外，防波堤的尽头站着一个人。潮水已经涨到那人的膝盖，他没有动，也没有要上岸的意思。",
  "她合上账簿，把它抱在怀里，走到窗边。那个人抬起头，隔着一整片正在退去的天光看过来。",
  "她忽然明白了那些符号是什么意思。不是记账，是记时间——记每个人还剩下多少。",
];

export const MOCK_CHAPTER: ChapterView = {
  number: 1,
  title: "The Ledger of Strangers",
  paragraphs: MOCK_PARAGRAPHS,
  novel: {
    title: MOCK_NOVEL_DETAIL.title,
    href: DETAIL_HREF,
    coverUrl: MOCK_NOVEL_DETAIL.coverUrl,
  },
  previewPosition: { index: 1, total: 3 },
  nextHref: CHAPTER_HREF,
  readOnUpstreamHref: "/dev-preview/novel#mock-go-link",
};

/** 最后一章试读：没有下一章，且正式阅读按钮升为主动作 */
export const MOCK_CHAPTER_LAST: ChapterView = {
  ...MOCK_CHAPTER,
  number: 3,
  title: "The Man Who Never Comes Ashore",
  previewPosition: { index: 3, total: 3 },
  previousHref: CHAPTER_HREF,
  nextHref: undefined,
};
