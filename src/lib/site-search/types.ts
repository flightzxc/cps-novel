/**
 * 站内搜索（PN-15，v0.5.14）共享类型与常量。
 *
 * 移植自 CPS v8.7.2 `src/lib/site-search/types.ts`，去掉 SQLite 兼容层（大小写变体、三桶、探针）；
 * 数值全部是**代码常量，不加环境变量**（方案第三节"缓存"一行：同 B-38 与相关推荐的既有裁定——
 * 本仓规矩是 TS 解析、preflight、compose 透传三处一致，要调就改这里并发新版本）。
 */
import type { NovelCardView } from "@/features/public-ui/types";

/** 每页本数：与"全部作品"页同一个翻页组件、同一个页大小（`BROWSE_PAGE_SIZE`，用例钉住相等）。 */
export const SITE_SEARCH_PAGE_SIZE = 20;

/** 长度门槛按 Unicode 码点计（`[...s].length`），不是 UTF-16 的 `.length`。 */
export const SITE_SEARCH_MIN_QUERY_LENGTH = 2;

/**
 * 最长 500 个码点 = `Article.title` 的 `@db.VarChar(500)` 宽度：任何书名都放得下，读者粘贴完整书名不会被拒
 * （CPS 的 64 会拒掉海阅 420 本书的完整书名，生产实测）。
 * 🔴 `tests/backend/site/site-search-query-normalizer.test.ts` 读取 `prisma/schema.prisma` 断言本常量 ≥ 书名字段宽度：
 * 哪天加宽书名字段而没改这里，用例变红。
 */
export const SITE_SEARCH_MAX_QUERY_LENGTH = 500;

/** 允许单字符检索的语言（取 BCP-47 语言子标签，如 zh-Hant → zh）。 */
export const SITE_SEARCH_CJK_SINGLE_CHAR_LANGS = ["zh", "ja", "ko"] as const;

/** 进程内缓存：同一语种、同一搜索词、同一页 60 秒内只查一次库（零结果也缓存，出错不缓存）。 */
export const SITE_SEARCH_CACHE_TTL_SECONDS = 60;
export const SITE_SEARCH_CACHE_MAX_ENTRIES = 200;

/** 数据库耗时超过它记一条结构化告警 `site_search_slow`（不含搜索词）。 */
export const SITE_SEARCH_SLOW_QUERY_MS = 1000;

// ok         : 正常查询完成（含零结果）
// idle       : 没输入 / 全空白 / 语种不受支持 —— 不执行搜索 SQL
// too_short  : 归一后不足最短长度，或去掉 LIKE 通配符后没有字面字符 —— 不执行搜索 SQL
// too_long   : 归一后超过最大长度 —— 不执行搜索 SQL
// unavailable: 数据库出错的降级态，items 为空且不写缓存
export type SiteSearchStatus = "ok" | "idle" | "too_short" | "too_long" | "unavailable";

export type SiteSearchRejectReason = "idle" | "too_short" | "too_long";

export type NormalizedSearchQuery =
  | { ok: false; reason: SiteSearchRejectReason; displayQuery: string }
  | {
      ok: true;
      /** 送进 SQL 的搜索词：已 NFKC、空白折叠、去不可见字符，**保留大小写与 LIKE 元字符**（转义在数据库里做）。 */
      query: string;
      /** 回填输入框、文案插值与 canonical 用的串；永远是归一后的形态，不是原始输入。 */
      displayQuery: string;
    };

export interface SiteSearchInput {
  /** 原始用户输入（`?q=`）。归一全部由服务层负责，调用方不得预处理。 */
  query: unknown;
  locale: string;
  /** 页码（1 起）；非正整数按第 1 页。页面层已经把非法页码判 404，这里只是兜底。 */
  page?: number;
}

export interface SiteSearchResponse {
  status: SiteSearchStatus;
  /** 归一后的查询串；idle / 出错 / 各拒绝态下是已有的归一形态（可能为空串）。 */
  displayQuery: string;
  /** 当前页的卡片（复用列表页的 `NovelCardView`）。 */
  items: NovelCardView[];
  /** 全部命中本数（分页覆盖的总数）；非 ok 状态恒为 0。 */
  totalCount: number;
  page: number;
  /** 总页数；没有结果时恒为 1（同 `listPublicNovelPage`）。 */
  totalPages: number;
  pageSize: number;
}

/** 缓存键的唯一定义处：用 `\u0000` 分隔，避免 ("en","x y") 与 ("en x","y") 撞键；含页码，不同页不共用条目。 */
export function buildSiteSearchCacheKey(locale: string, page: number, query: string): string {
  return `${locale}\u0000${page}\u0000${query}`;
}
