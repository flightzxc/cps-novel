/**
 * 站内搜索服务层（PN-15）。
 *
 * 结果是"列表可见的小说文章"——和"全部作品"页上能看到的那些书是同一把尺子（`search-query.ts` 复用
 * B-38 的列表筛选，卡片补全与复核复用 `hydratePublicListCards`，推广链接可用的程序复核、不变量违例日志
 * 都自动沿用）。
 *
 * 与 CPS v8.7.2 的服务层的对应与差异：
 *   - 归一 → 语种校验 → 查询 → 补卡片 → 返回；归一失败 / 语种不认识 **不执行搜索 SQL，也不进缓存**；
 *   - 数据库出错降级为 `unavailable`，不抛 500、不写缓存、日志**不记搜索词**；
 *   - 进程内有界缓存 60 秒 / 200 条（复用 `@/lib/site/bounded-ttl-cache`），零结果也缓存（爬虫随机词最爱打
 *     零结果，条目最小、收益最大），`unavailable` 不缓存（否则一次抖动会被固化 60 秒）；
 *   - 差异：数值是代码常量不加环境变量；没有探针/三桶/大小写变体（那是 SQLite 的兼容层）；有分页。
 */
import type { Prisma, PrismaClient } from "@prisma/client";

import { SITE_LOCALES, type SiteLocale } from "@/lib/locale/locale-canonical";
import { prisma } from "@/lib/db/web-prisma";
import { createBoundedTtlCache, type BoundedTtlCache } from "@/lib/site/bounded-ttl-cache";
import { hydratePublicListCards } from "@/lib/site/public-list";

import { normalizeSearchInput } from "./query-normalizer";
import { querySiteSearchPage } from "./search-query";
import {
  SITE_SEARCH_CACHE_MAX_ENTRIES,
  SITE_SEARCH_CACHE_TTL_SECONDS,
  SITE_SEARCH_PAGE_SIZE,
  SITE_SEARCH_SLOW_QUERY_MS,
  buildSiteSearchCacheKey,
  type SiteSearchInput,
  type SiteSearchResponse,
  type SiteSearchStatus,
} from "./types";

type Db = PrismaClient | Prisma.TransactionClient;

export type SiteSearchOptions = Readonly<{
  env?: NodeJS.ProcessEnv;
  /** 测试缝：注入假时钟量数据库耗时。 */
  now?: () => number;
}>;

// 非正整数按第 1 页；"装不进安全整数"的巨大页码保持原值往下走——`querySiteSearchPage` 看到 offset 不是安全整数
// 会只数总数、不发编号查询，页面据此判 404（同 `listPublicNovelPage`）。
function toPositivePage(page: number | undefined): number {
  return typeof page === "number" && Number.isInteger(page) && page > 0 ? page : 1;
}

function totalPagesFor(totalCount: number, pageSize: number): number {
  return totalCount === 0 ? 1 : Math.max(1, Math.ceil(totalCount / pageSize));
}

function emptyResponse(status: SiteSearchStatus, displayQuery: string, page: number): SiteSearchResponse {
  return {
    status,
    displayQuery,
    items: [],
    totalCount: 0,
    page,
    totalPages: 1,
    pageSize: SITE_SEARCH_PAGE_SIZE,
  };
}

function isSiteLocale(value: string): value is SiteLocale {
  return (SITE_LOCALES as readonly string[]).includes(value);
}

type Prepared =
  | { ok: false; response: SiteSearchResponse }
  | { ok: true; locale: SiteLocale; query: string; displayQuery: string; page: number };

// 归一 + 语种校验 + 页码兜底。任何 ok:false 分支都不执行搜索 SQL，也不进缓存。
// 语种校验放在长度门槛之后：too_short 先于"不认识的语种 → idle"判出，与 CPS 逐位一致；
// 不认识的语种不享受 CJK 单字放行。
function prepareSearch(input: SiteSearchInput): Prepared {
  const page = toPositivePage(input.page);
  const localeSupported = isSiteLocale(input.locale);
  const normalized = normalizeSearchInput(input.query, localeSupported ? input.locale : undefined);
  if (!normalized.ok) {
    return { ok: false, response: emptyResponse(normalized.reason, normalized.displayQuery, page) };
  }
  if (!localeSupported) {
    return { ok: false, response: emptyResponse("idle", normalized.displayQuery, page) };
  }
  return { ok: true, locale: input.locale as SiteLocale, query: normalized.query, displayQuery: normalized.displayQuery, page };
}

/** 错误消息里万一带着搜索词（数据库回显等），在落日志前抹掉。 */
export function redactSearchQuery(message: string, ...queries: readonly string[]): string {
  let out = message;
  for (const query of queries) {
    if (query) out = out.split(query).join("[query]");
  }
  return out;
}

async function executeSearch(
  db: Db,
  prepared: Extract<Prepared, { ok: true }>,
  options: SiteSearchOptions,
  rawQuery: unknown,
): Promise<SiteSearchResponse> {
  const env = options.env ?? process.env;
  const now = options.now ?? (() => performance.now());
  const { locale, query, displayQuery, page } = prepared;
  try {
    const startedAt = now();
    const result = await querySiteSearchPage(db, {
      query,
      locale,
      limit: SITE_SEARCH_PAGE_SIZE,
      offset: (page - 1) * SITE_SEARCH_PAGE_SIZE,
      env,
    });
    const durationMs = Math.round(now() - startedAt);
    if (durationMs > SITE_SEARCH_SLOW_QUERY_MS) {
      // 结构化告警，**不含搜索词**（用户输入不进日志）。
      console.warn(JSON.stringify({
        schemaVersion: 1,
        event: "site_search_slow",
        level: "warn",
        locale,
        page,
        durationMs,
        total: result.total,
      }));
    }
    const items = await hydratePublicListCards(db, result.ids, locale, env);
    return {
      status: "ok",
      displayQuery,
      items,
      totalCount: result.total,
      page,
      totalPages: totalPagesFor(result.total, SITE_SEARCH_PAGE_SIZE),
      pageSize: SITE_SEARCH_PAGE_SIZE,
    };
  } catch (error) {
    // 数据库出错时降级，绝不向页面抛异常（搜索页 500 比"稍后再试"差得多），也绝不写缓存。
    // 日志只记 语种 / 页码 / 错误消息，不记搜索词。
    const message = error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify({
      schemaVersion: 1,
      event: "site_search_failed",
      level: "error",
      locale,
      page,
      message: redactSearchQuery(message, query, displayQuery, typeof rawQuery === "string" ? rawQuery : ""),
    }));
    return emptyResponse("unavailable", displayQuery, page);
  }
}

export async function searchSite(
  input: SiteSearchInput,
  db: Db = prisma,
  options: SiteSearchOptions = {},
): Promise<SiteSearchResponse> {
  const prepared = prepareSearch(input);
  if (!prepared.ok) return prepared.response;
  return executeSearch(db, prepared, options, input.query);
}

// 惰性实例化：测试清缓存后能重建。
let cacheInstance: BoundedTtlCache<SiteSearchResponse> | null = null;

function getCache(): BoundedTtlCache<SiteSearchResponse> {
  if (!cacheInstance) {
    cacheInstance = createBoundedTtlCache<SiteSearchResponse>({
      maxEntries: SITE_SEARCH_CACHE_MAX_ENTRIES,
      ttlMs: SITE_SEARCH_CACHE_TTL_SECONDS * 1000,
      // 只缓存正常结果（含零结果）；unavailable 不缓存。
      shouldCache: (value) => value.status === "ok",
    });
  }
  return cacheInstance;
}

export function clearSiteSearchCacheForTest(): void {
  cacheInstance?.clear();
  cacheInstance = null;
}

export async function searchSiteCached(
  input: SiteSearchInput,
  db: Db = prisma,
  options: SiteSearchOptions = {},
): Promise<SiteSearchResponse> {
  const prepared = prepareSearch(input);
  if (!prepared.ok) return prepared.response;
  // 键 = 语种 + 页码 + 归一后的搜索词（`\u0000` 分隔）。
  const key = buildSiteSearchCacheKey(prepared.locale, prepared.page, prepared.query);
  try {
    return await getCache().getOrLoad(key, () => executeSearch(db, prepared, options, input.query));
  } catch (error) {
    // 缓存永远是可选加速，不是正确性依赖：缓存层任何异常直接回落到未缓存路径。
    const message = error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify({
      schemaVersion: 1,
      event: "site_search_cache_failed",
      level: "error",
      locale: prepared.locale,
      page: prepared.page,
      message: redactSearchQuery(message, prepared.query, prepared.displayQuery),
    }));
    return executeSearch(db, prepared, options, input.query);
  }
}
