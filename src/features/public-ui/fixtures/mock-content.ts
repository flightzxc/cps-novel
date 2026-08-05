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
import { devPreviewChapterPath, devPreviewNovelPath } from "./preview-paths";

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

/**
 * 生成一张 16:9 内联横版主视觉，站位真实运营物料。
 *
 * 刻意做得比封面亮、比封面花——Hero 的对比度门槛必须在「图很亮」的情况下也成立，
 * 假数据如果全是暗图，就验证不出压黑层够不够。
 */
function mockHero(from: string, to: string, seed: number): string {
  const horizon = 560 + seed * 18;
  const sunX = 1040 + seed * 46;
  const sunY = horizon - 150 - seed * 12;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 900">
<defs>
<linearGradient id="sky" x1="0" y1="0" x2="0.3" y2="1">
<stop offset="0" stop-color="${to}"/><stop offset="0.55" stop-color="${from}"/><stop offset="1" stop-color="${to}"/>
</linearGradient>
<radialGradient id="glow" cx="${sunX / 1600}" cy="${sunY / 900}" r="0.42">
<stop offset="0" stop-color="#fff3dd" stop-opacity="0.9"/>
<stop offset="0.35" stop-color="#ffd9a8" stop-opacity="0.35"/>
<stop offset="1" stop-color="#ffd9a8" stop-opacity="0"/>
</radialGradient>
<linearGradient id="water" x1="0" y1="0" x2="0" y2="1">
<stop offset="0" stop-color="#000000" stop-opacity="0"/>
<stop offset="1" stop-color="#000000" stop-opacity="0.42"/>
</linearGradient>
</defs>
<rect width="1600" height="900" fill="url(#sky)"/>
<rect width="1600" height="900" fill="url(#glow)"/>
<circle cx="${sunX}" cy="${sunY}" r="${86 + seed * 6}" fill="#fff6e6" opacity="0.85"/>
<rect y="${horizon}" width="1600" height="${900 - horizon}" fill="url(#water)"/>
<path d="M0 ${horizon} L${300 + seed * 30} ${horizon - 120 - seed * 14} L${560 + seed * 20} ${horizon} Z" fill="#000000" opacity="0.42"/>
<path d="M${900 + seed * 25} ${horizon} L${1180 + seed * 18} ${horizon - 190 - seed * 10} L${1520} ${horizon} Z" fill="#000000" opacity="0.3"/>
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

/**
 * 详情页地址在 URL 结构冻结前一律指向开发预览路由。
 * 地址一律从 `./preview-paths` 取，本文件不自行拼任何路径。
 */
const DETAIL_HREF = devPreviewNovelPath();

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
  heroImageUrl: mockHero("#a8527d", "#241631", 1),
  description:
    "港口的灯塔守了四十年，最后一任守塔人留下的不是航海日志，是一本写满陌生人名字的账簿。\n" +
    "女儿回到岛上处理遗物时，发现账簿上最新的一笔记在她自己名下，日期是三天后。\n" +
    "她决定留下来，等那一天到来——同时也等那个每晚准点出现在防波堤尽头、却从不上岸的人。",
  locale: EN,
  totalChapterCount: 265,
  tags: [TAGS.romance, TAGS.modern, TAGS.suspense],
  previewChapters: [
    { number: 1, title: "The Ledger of Strangers", href: devPreviewChapterPath(1) },
    { number: 2, title: "Three Days from Now", href: devPreviewChapterPath(2) },
    { number: 3, title: "The Man Who Never Comes Ashore", href: devPreviewChapterPath(3) },
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

/**
 * 首页主推列表 —— 对应运营人工编排位（架构文档的 home_carousel_manual_slot）。
 *
 * 🔴 顺序是编排出来的，**不表示排名**。
 *
 * 第 4 本刻意**不带** heroImageUrl：用来验证首页只把有横版物料的放进轮播，
 * 不会拿一个空底图凑数。
 */
export const MOCK_FEATURED_LIST: NovelDetailView[] = [
  MOCK_NOVEL_DETAIL,
  {
    id: "mock-2",
    title: "Salt, Smoke and Second Chances",
    coverUrl: mockCover("#c2703a", "#4a2415", 2),
    heroImageUrl: mockHero("#d98a4a", "#3a1c0e", 2),
    description:
      "他在码头开了十七年的熏鱼铺，从不接受预订，也从不解释为什么每周三闭店。\n直到那个总在周三下午出现在对街长椅上的女人，某天没有出现。",
    locale: EN,
    totalChapterCount: 184,
    tags: [TAGS.romance],
    previewChapters: [
      { number: 1, title: "Closed on Wednesdays", href: devPreviewChapterPath(1) },
      { number: 2, title: "The Empty Bench", href: devPreviewChapterPath(2) },
    ],
    readOnUpstreamHref: "/dev-preview/novel#mock-go-link",
  },
  {
    id: "mock-4",
    title: "The Cartographer of Small Regrets",
    coverUrl: mockCover("#6b4ea8", "#241a44", 4),
    heroImageUrl: mockHero("#7d5fc4", "#1d1538", 4),
    description:
      "地图上有七个地方被人用铅笔轻轻圈住，又擦掉了。擦得很干净，但纸面留下了痕。\n她决定按着这七个痕迹走一遍，看看那个人当年到底想去、又最终没去哪里。",
    locale: EN,
    totalChapterCount: 312,
    tags: [TAGS.fantasy, TAGS.suspense],
    previewChapters: [
      { number: 1, title: "Seven Erased Circles", href: devPreviewChapterPath(1) },
      { number: 2, title: "The First Place He Didn't Go", href: devPreviewChapterPath(2) },
      { number: 3, title: "Graphite Never Really Leaves", href: devPreviewChapterPath(3) },
    ],
    readOnUpstreamHref: "/dev-preview/novel#mock-go-link",
  },
  {
    id: "mock-7",
    title: "The Weight of Borrowed Names",
    coverUrl: mockCover("#3f7d55", "#16301f", 6),
    heroImageUrl: mockHero("#4f9c6b", "#122a1a", 6),
    description:
      "这个镇子上有个不成文的规矩：谁家孩子夭折了，名字就借给下一个出生的孩子用。\n她今年二十四岁，用的是第三个人的名字。",
    locale: EN,
    totalChapterCount: 96,
    tags: [TAGS.fantasy, TAGS.romance],
    previewChapters: [{ number: 1, title: "The Third Name", href: devPreviewChapterPath(1) }],
    readOnUpstreamHref: "/dev-preview/novel#mock-go-link",
  },
  {
    // 无横版物料的一本：不会进轮播
    id: "mock-9",
    title: "Where the Tide Keeps Score",
    coverUrl: mockCover("#4a5b9c", "#181f3c", 8),
    description: "潮水每天涨落两次，而她已经数了四千三百次。",
    locale: EN,
    totalChapterCount: 58,
    tags: [TAGS.suspense],
    previewChapters: [
      { number: 1, title: "Four Thousand Three Hundred", href: devPreviewChapterPath(1) },
    ],
  },
];

/** 全部不带横版物料——用来验证首页整体回落到封面编排版 */
export const MOCK_FEATURED_LIST_NO_HERO: NovelDetailView[] = MOCK_FEATURED_LIST.map(
  (novel) => {
    const withoutHero = { ...novel };
    delete withoutHero.heroImageUrl;
    return withoutHero;
  },
);

const MOCK_PARAGRAPHS = [
  "灯塔的门锁了四十年，钥匙一直挂在门边的钉子上。这是岛上人尽皆知的矛盾，也是没有人去追究的那一种。",
  "她把行李放在门口的台阶上，先没有进去。海风从防波堤那头灌过来，带着咸味和一点点柴油的气息，和她记忆里的那股味道分毫不差。",
  "屋里比想象中干净。桌上摊着一本账簿，纸页被潮气泡得发软，边角却整整齐齐。她翻开第一页，看见的不是数字，是名字。",
  "一个接一个的名字，每个后面跟着一个日期，再后面是一个她看不懂的符号。有些符号重复出现，有些只出现过一次。",
  "她一页页往后翻，翻到最后一页时停住了。最后一行写着她自己的名字，日期是三天之后。",
  "窗外，防波堤的尽头站着一个人。潮水已经涨到那人的膝盖，他没有动，也没有要上岸的意思。",
  "她合上账簿，把它抱在怀里，走到窗边。那个人抬起头，隔着一整片正在退去的天光看过来。",
  "她忽然明白了那些符号是什么意思。不是记账，是记时间——记每个人还剩下多少。",
  "父亲的字迹在最后几页明显变了。前面几十年一笔一画，规规矩矩；最后这些，笔锋是抖的，收尾常常拖出一道长长的尾巴，像是写到一半手就不听使唤了。",
  "她翻回去数了数：抖的那部分，从第两百零七个名字开始。再往前一页，日期是四年前的深秋。",
  "四年前的深秋，她接到过一个电话。父亲说岛上起雾了，雾大得看不见灯塔的光，问她要不要回来看看。她说等忙完这阵。那阵一直没忙完。",
  "楼下的门被风撞了一下。她没有动。风又撞了一下，这次轻一些，像是在确认屋里有没有人。",
  "她把账簿翻到空白的那一页，找了支笔。笔尖悬在纸面上很久，最后什么也没写下去——她不知道该记谁的名字，也不知道该记什么日期。",
  "天完全黑下来的时候，她终于点亮了灯塔。四十年没通电的灯居然亮了，光柱扫过海面，扫过防波堤，扫过那个仍旧站在水里的人。",
  "光扫到他身上的那一瞬间，她看清了。那不是一个陌生人。",
  "账簿从她手里滑下去，摊开在地上，正好是最后一页。她的名字底下，不知什么时候多了一行字，墨迹还是湿的。",
  "写的是：别怕，我等你很久了。",
];

const MOCK_PARAGRAPHS_CH2 = [
  "第二天早上，岛上的杂货铺老板见她进门，手上正在称的糖停了一下，然后若无其事地继续称。",
  "「你父亲最后那几年，很少下来。」老板说，「东西都是我送上去的。他从不让我进门，钱放在台阶上，我把袋子放下就走。」",
  "她问他有没有见过防波堤尽头那个人。老板称糖的手又停了一下，这次停得久一些。",
  "「那儿站不了人，」老板说，「涨潮的时候水到胸口，退潮的时候全是石头缝，一脚下去能把腿卡断。没人往那儿去。」",
  "她没有争辩。回去的路上她绕到防波堤，从头走到尾，数了一百七十四步。石头缝确实很深，很难落脚。",
  "尽头处的石面上有一片颜色略深的痕迹，边缘规整，像是有什么东西长期压在那里。她蹲下去摸了摸，是干的。",
  "潮水离那里还有两米。按老板的说法，再过三个小时，这块石头就该在水下了。",
  "她在原地站到天黑。潮水涨上来，漫过她的鞋，漫过脚踝，然后停住了——比她算的位置低了整整一米。",
  "那天夜里她翻开账簿，发现最后一页的日期变了。不是三天后，是两天后。",
];

const MOCK_PARAGRAPHS_CH3 = [
  "第三天，她起得很早，把灯塔顶层的玻璃擦了一遍。四十年没人擦，抹布下去一道，就露出一道海。",
  "擦到第七块玻璃时，她看见防波堤尽头站着那个人。这次是白天，光很足，可她还是看不清他的脸。",
  "她下楼、出门、沿着防波堤走过去。一百七十四步，她数得很准，走到第一百七十四步时，人不见了。",
  "石面上那片深色痕迹还在，边缘依旧规整。她把手贴上去，这一次是湿的，而且温的。",
  "回到屋里，账簿摊在桌上，翻在最后一页。她记得自己昨晚合上了它。",
  "名字还是她的名字，日期变成了今天。后面那个符号她现在认得了——账簿里出现过十一次，每一次后面都再没有新的记录。",
  "她把账簿抱起来，走到门口，把钥匙从钉子上取下来，插进锁孔，转了一圈。",
  "锁开了。四十年来第一次，这扇门是从里面锁上的。",
];

/**
 * 章节语料。章名与 `MOCK_NOVEL_DETAIL.previewChapters` 逐条对应——
 * 详情页列出的可试读章节必须真的能点进去，不能列了却没有对应正文。
 */
const MOCK_CHAPTER_SOURCES: { title: string; paragraphs: string[] }[] = [
  { title: "The Ledger of Strangers", paragraphs: MOCK_PARAGRAPHS },
  { title: "Three Days from Now", paragraphs: MOCK_PARAGRAPHS_CH2 },
  { title: "The Man Who Never Comes Ashore", paragraphs: MOCK_PARAGRAPHS_CH3 },
];

/** 可试读章节总数。分母是实际可试读章数，不是 `totalChapterCount`。 */
export const MOCK_PREVIEW_CHAPTER_TOTAL = MOCK_CHAPTER_SOURCES.length;

/**
 * 章节页假数据的唯一构造入口。
 *
 * 上下章地址由章号推出来，不再是所有章共用一个静态地址——这是 P1-11 客户端
 * 切章能成立的前提。章号越界返回 null，由路由层决定怎么处理（走 notFound）。
 */
export function getMockChapterView(chapterNumber: number): ChapterView | null {
  const source = MOCK_CHAPTER_SOURCES[chapterNumber - 1];
  if (!source) {
    return null;
  }

  return {
    number: chapterNumber,
    title: source.title,
    paragraphs: source.paragraphs,
    novel: {
      // 稳定不透明标识，用于阅读位置按 novel + chapter 分键。永不渲染。
      id: MOCK_NOVEL_DETAIL.id,
      title: MOCK_NOVEL_DETAIL.title,
      href: DETAIL_HREF,
      coverUrl: MOCK_NOVEL_DETAIL.coverUrl,
    },
    previewPosition: { index: chapterNumber, total: MOCK_PREVIEW_CHAPTER_TOTAL },
    previousHref: chapterNumber > 1 ? devPreviewChapterPath(chapterNumber - 1) : undefined,
    nextHref:
      chapterNumber < MOCK_PREVIEW_CHAPTER_TOTAL
        ? devPreviewChapterPath(chapterNumber + 1)
        : undefined,
    readOnUpstreamHref: `${DETAIL_HREF}#mock-go-link`,
  };
}

/** 第 1 章：有下一章、没有上一章。 */
export const MOCK_CHAPTER: ChapterView = getMockChapterView(1)!;

/** 最后一章试读：没有下一章，且正式阅读按钮升为主动作 */
export const MOCK_CHAPTER_LAST: ChapterView = getMockChapterView(
  MOCK_PREVIEW_CHAPTER_TOTAL,
)!;
