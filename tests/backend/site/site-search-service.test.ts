/**
 * PN-15 站内搜索服务层（假数据库）：状态、出错降级不缓存、零结果缓存、慢查询日志不含搜索词、缓存键区分页码。
 * 真实 SQL 的行为由真实库用例证明（`tests/integration/site/site-search-postgres.test.ts`）。
 */
import type { Prisma } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { NovelCardView } from "@/features/public-ui/types";

vi.mock("@/lib/db/web-prisma", () => ({ prisma: {} }));
vi.mock("@/lib/site/public-list", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/site/public-list")>();
  return {
    ...actual,
    hydratePublicListCards: vi.fn(async (_db: unknown, ids: readonly string[]): Promise<NovelCardView[]> =>
      ids.map((id) => ({ id, title: `card ${id}`, tags: [], href: `/novel/${id}` }))),
  };
});

const { hydratePublicListCards } = await import("@/lib/site/public-list");
const {
  clearSiteSearchCacheForTest,
  redactSearchQuery,
  searchSite,
  searchSiteCached,
} = await import("@/lib/site-search/site-search-service");

type Call = { kind: "page" | "count"; sql: string; values: unknown[] };

/** 假数据库：`$queryRaw` 按 SQL 文本区分"本页编号 + 总数"与"只数总数"。 */
function fakeDb(options: {
  total?: number;
  /** 页面 SQL 的行数（默认按 total 与 offset 推出）。 */
  rowsForOffset?: (offset: number) => number;
  failWith?: Error;
} = {}) {
  const calls: Call[] = [];
  const total = options.total ?? 0;
  const db = {
    $queryRaw: vi.fn(async (sql: Prisma.Sql) => {
      if (options.failWith) throw options.failWith;
      const isPage = sql.sql.includes("count(*) OVER ()");
      calls.push({ kind: isPage ? "page" : "count", sql: sql.sql, values: [...sql.values] });
      if (!isPage) return [{ total }];
      const limit = sql.values[sql.values.length - 2] as number;
      const offset = sql.values[sql.values.length - 1] as number;
      const count = options.rowsForOffset ? options.rowsForOffset(offset) : Math.max(0, Math.min(limit, total - offset));
      return Array.from({ length: count }, (_, index) => ({ id: `id-${offset + index}`, total }));
    }),
  };
  return { db: db as never, calls, queryRaw: db.$queryRaw };
}

beforeEach(() => {
  clearSiteSearchCacheForTest();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(hydratePublicListCards).mockClear();
});

describe("被拒绝的输入：不执行搜索 SQL，也不进缓存", () => {
  it.each([
    ["空串", { query: "", locale: "en" }, "idle"],
    ["纯空白", { query: "  \n ", locale: "en" }, "idle"],
    ["缺 q", { query: undefined, locale: "en" }, "idle"],
    ["太短", { query: "a", locale: "en" }, "too_short"],
    ["纯通配符", { query: "%_", locale: "en" }, "too_short"],
    ["太长", { query: "a".repeat(501), locale: "en" }, "too_long"],
    ["不认识的语种", { query: "alpha", locale: "xx" }, "idle"],
    ["不认识的语种不享受 CJK 单字放行", { query: "愛", locale: "xx" }, "too_short"],
    ["en 单个汉字", { query: "愛", locale: "en" }, "too_short"],
  ] as const)("%s → %s", async (_name, input, status) => {
    const { db, queryRaw } = fakeDb({ total: 5 });
    const direct = await searchSite(input, db);
    const cached = await searchSiteCached(input, db);
    for (const response of [direct, cached]) {
      expect(response.status).toBe(status);
      expect(response.items).toEqual([]);
      expect(response.totalCount).toBe(0);
      expect(response.totalPages).toBe(1);
    }
    expect(queryRaw).not.toHaveBeenCalled();
    expect(hydratePublicListCards).not.toHaveBeenCalled();
  });

  it("日语单个汉字放行并执行查询", async () => {
    const { db, queryRaw } = fakeDb({ total: 3 });
    const response = await searchSite({ query: "愛", locale: "ja" }, db);
    expect(response.status).toBe("ok");
    expect(queryRaw).toHaveBeenCalledTimes(1);
  });
});

describe("正常查询", () => {
  it("返回状态、归一后的词、卡片、总数、页码、总页数、页大小", async () => {
    const { db, calls } = fakeDb({ total: 45 });
    const response = await searchSite({ query: "  Alpha   King ", locale: "en", page: 2 }, db);
    expect(response).toMatchObject({
      status: "ok",
      displayQuery: "Alpha King",
      totalCount: 45,
      page: 2,
      totalPages: 3,
      pageSize: 20,
    });
    expect(response.items).toHaveLength(20);
    expect(response.items[0]!.id).toBe("id-20");
    // 绑定参数：归一后的搜索词（保留大小写）、语种、页大小、偏移。
    expect(calls).toHaveLength(1);
    expect(calls[0]!.kind).toBe("page");
    expect(calls[0]!.values[0]).toBe("Alpha King");
    expect(calls[0]!.values).toContain("en");
    expect(calls[0]!.values.slice(-2)).toEqual([20, 20]);
    expect(hydratePublicListCards).toHaveBeenCalledTimes(1);
  });

  it("最后一页只有余数本", async () => {
    const { db } = fakeDb({ total: 45 });
    const response = await searchSite({ query: "alpha", locale: "en", page: 3 }, db);
    expect(response.items).toHaveLength(5);
    expect(response.totalPages).toBe(3);
  });

  it("总数恰好整除页大小：40 本 = 2 页", async () => {
    const { db } = fakeDb({ total: 40 });
    expect((await searchSite({ query: "alpha", locale: "en" }, db)).totalPages).toBe(2);
  });

  it("零结果：ok、总数 0、总页数 1，不再多发计数查询", async () => {
    const { db, calls } = fakeDb({ total: 0 });
    const response = await searchSite({ query: "zzzxqv", locale: "en" }, db);
    expect(response).toMatchObject({ status: "ok", totalCount: 0, totalPages: 1, page: 1, items: [] });
    expect(calls.map((call) => call.kind)).toEqual(["page"]);
  });

  it("页码越界（本页无行、offset>0）：补一条计数拿总数，页面据此判 404", async () => {
    const { db, calls } = fakeDb({ total: 45 });
    const response = await searchSite({ query: "alpha", locale: "en", page: 9 }, db);
    expect(response).toMatchObject({ status: "ok", totalCount: 45, totalPages: 3, page: 9, items: [] });
    expect(calls.map((call) => call.kind)).toEqual(["page", "count"]);
    // 计数那条不带排序与分页。
    expect(calls[1]!.sql).not.toMatch(/ORDER BY|LIMIT|OFFSET/);
  });

  it("越界页且结果为 0：第 2 页的总数仍是 0（只有第 1 页合法）", async () => {
    const { db, calls } = fakeDb({ total: 0 });
    const response = await searchSite({ query: "alpha", locale: "en", page: 2 }, db);
    expect(response).toMatchObject({ status: "ok", totalCount: 0, totalPages: 1, page: 2 });
    expect(calls.map((call) => call.kind)).toEqual(["page", "count"]);
  });

  it("页码大到装不进安全整数：不发编号查询，只数总数", async () => {
    const { db, calls } = fakeDb({ total: 45 });
    const response = await searchSite({ query: "alpha", locale: "en", page: 10 ** 19 }, db);
    expect(calls.map((call) => call.kind)).toEqual(["count"]);
    expect(response.totalCount).toBe(45);
    expect(response.page).toBe(10 ** 19);
    expect(response.items).toEqual([]);
  });

  it.each([0, -3, 1.5, Number.NaN, Infinity, undefined])("非法页码 %s 按第 1 页", async (page) => {
    const { db, calls } = fakeDb({ total: 45 });
    const response = await searchSite({ query: "alpha", locale: "en", page }, db);
    expect(response.page).toBe(1);
    expect(calls[0]!.values.slice(-2)).toEqual([20, 0]);
  });
});

describe("数据库出错：降级为 unavailable，不抛、不缓存，日志不记搜索词", () => {
  it("unavailable 不缓存：第二次仍然去查库", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const failing = fakeDb({ failWith: new Error("connection refused") });
    const first = await searchSiteCached({ query: "secret-term-xyz", locale: "en" }, failing.db);
    expect(first).toMatchObject({ status: "unavailable", displayQuery: "secret-term-xyz", items: [], totalCount: 0 });
    await searchSiteCached({ query: "secret-term-xyz", locale: "en" }, failing.db);
    expect(failing.queryRaw).toHaveBeenCalledTimes(2);

    // 库恢复后立刻能搜到（没有把一次抖动固化 60 秒）。
    const healthy = fakeDb({ total: 2 });
    expect((await searchSiteCached({ query: "secret-term-xyz", locale: "en" }, healthy.db)).status).toBe("ok");
    expect(error).toHaveBeenCalledTimes(2);
  });

  it("日志只记语种、页码、错误消息；错误消息里万一带着搜索词也会被抹掉", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const failing = fakeDb({ failWith: new Error('invalid input near "Secret Term Xyz" (Secret Term Xyz)') });
    await searchSite({ query: "  Secret   Term Xyz ", locale: "ja", page: 3 }, failing.db);
    expect(error).toHaveBeenCalledTimes(1);
    const line = String(error.mock.calls[0]![0]);
    const payload = JSON.parse(line) as Record<string, unknown>;
    expect(payload).toMatchObject({ schemaVersion: 1, event: "site_search_failed", level: "error", locale: "ja", page: 3 });
    expect(Object.keys(payload).sort()).toEqual(["event", "level", "locale", "message", "page", "schemaVersion"]);
    expect(line).not.toContain("Secret Term Xyz");
    expect(line).not.toContain("Secret   Term Xyz");
    expect(payload.message).toContain("[query]");
  });

  it("redactSearchQuery：多个词、空串、不含时原样", () => {
    expect(redactSearchQuery("a x b x", "x")).toBe("a [query] b [query]");
    expect(redactSearchQuery("nothing here", "x", "")).toBe("nothing here");
  });

  it("补全卡片出错同样降级", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(hydratePublicListCards).mockRejectedValueOnce(new Error("boom"));
    const { db } = fakeDb({ total: 3 });
    expect((await searchSite({ query: "alpha", locale: "en" }, db)).status).toBe("unavailable");
  });
});

describe("进程内缓存（60 秒 / 200 条，复用有界缓存）", () => {
  it("同语种同词同页：第二次不查库；零结果也缓存", async () => {
    const hit = fakeDb({ total: 5 });
    await searchSiteCached({ query: "alpha", locale: "en" }, hit.db);
    await searchSiteCached({ query: "alpha", locale: "en" }, hit.db);
    expect(hit.queryRaw).toHaveBeenCalledTimes(1);

    const zero = fakeDb({ total: 0 });
    await searchSiteCached({ query: "zzzxqv", locale: "en" }, zero.db);
    await searchSiteCached({ query: "zzzxqv", locale: "en" }, zero.db);
    expect(zero.queryRaw).toHaveBeenCalledTimes(1);
  });

  it("缓存键按归一后的词：空白不同、写法不同但归一后相同的词共用一条", async () => {
    const { db, queryRaw } = fakeDb({ total: 5 });
    await searchSiteCached({ query: "Alpha King", locale: "en" }, db);
    await searchSiteCached({ query: "  Alpha\u00a0\u00a0King  ", locale: "en" }, db);
    await searchSiteCached({ query: "Ａlpha King", locale: "en" }, db);
    expect(queryRaw).toHaveBeenCalledTimes(1);
    // 大小写不同是另一条（canonical 保留大小写，照 CPS）。
    await searchSiteCached({ query: "alpha king", locale: "en" }, db);
    expect(queryRaw).toHaveBeenCalledTimes(2);
  });

  it("缓存键区分页码与语种", async () => {
    const { db, queryRaw } = fakeDb({ total: 45 });
    await searchSiteCached({ query: "alpha", locale: "en", page: 1 }, db);
    await searchSiteCached({ query: "alpha", locale: "en", page: 2 }, db);
    await searchSiteCached({ query: "alpha", locale: "ja", page: 1 }, db);
    expect(queryRaw).toHaveBeenCalledTimes(3);
    await searchSiteCached({ query: "alpha", locale: "en", page: 2 }, db);
    expect(queryRaw).toHaveBeenCalledTimes(3);
  });

  it("非缓存入口 searchSite 每次都查库", async () => {
    const { db, queryRaw } = fakeDb({ total: 5 });
    await searchSite({ query: "alpha", locale: "en" }, db);
    await searchSite({ query: "alpha", locale: "en" }, db);
    expect(queryRaw).toHaveBeenCalledTimes(2);
  });

  it("并发的相同请求只查一次（in-flight 去重）", async () => {
    const { db, queryRaw } = fakeDb({ total: 5 });
    await Promise.all([1, 2, 3].map(() => searchSiteCached({ query: "alpha", locale: "en" }, db)));
    expect(queryRaw).toHaveBeenCalledTimes(1);
  });

  it("清缓存后重新查库", async () => {
    const { db, queryRaw } = fakeDb({ total: 5 });
    await searchSiteCached({ query: "alpha", locale: "en" }, db);
    clearSiteSearchCacheForTest();
    await searchSiteCached({ query: "alpha", locale: "en" }, db);
    expect(queryRaw).toHaveBeenCalledTimes(2);
  });
});

describe("慢查询告警 site_search_slow（超过 1000 毫秒；不含搜索词）", () => {
  function clock(deltaMs: number) {
    let calls = 0;
    return () => (calls++ === 0 ? 0 : deltaMs);
  }

  it("1001 毫秒记一条结构化告警，字段固定，不含搜索词", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { db } = fakeDb({ total: 7 });
    await searchSite({ query: "private-query-text", locale: "fr", page: 1 }, db, { now: clock(1001) });
    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0]![0]);
    expect(JSON.parse(line)).toEqual({
      schemaVersion: 1,
      event: "site_search_slow",
      level: "warn",
      locale: "fr",
      page: 1,
      durationMs: 1001,
      total: 7,
    });
    expect(line).not.toContain("private-query-text");
  });

  it("恰好 1000 毫秒不告警（严格大于）", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { db } = fakeDb({ total: 7 });
    await searchSite({ query: "alpha", locale: "en" }, db, { now: clock(1000) });
    expect(warn).not.toHaveBeenCalled();
  });

  it("缓存命中不告警也不重复查库", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { db } = fakeDb({ total: 7 });
    await searchSiteCached({ query: "alpha", locale: "en" }, db, { now: clock(5000) });
    await searchSiteCached({ query: "alpha", locale: "en" }, db, { now: clock(5000) });
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
