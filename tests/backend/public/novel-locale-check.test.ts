import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

/**
 * 2026-09-30：语言切换器的"这本书在目标语种有没有对应页面"接口
 * （`/api/novel-locale-check`，移植自 CPS `drama-locale-check`，`v8.5.1`）。
 *
 * 分两层测：`checkNovelLocaleMatch`（查询本体，用假库）与路由的 HTTP 边界
 * （参数校验、缓存头、出错时 503 + no-store）。查询本体**必须复用**
 * `loadNovelHreflangSiblings`——"哪些语种有这本书的公开页"只有 hreflang 那一份
 * 判定，这里不另写第二份可见性 where；"复用"本身也是一条被断言的事实。
 */

const prismaStub = vi.hoisted(() => ({ prisma: {} as unknown }));
vi.mock("@/app/_lib/public-deps", () => prismaStub);

const { checkNovelLocaleMatch } = await import("@/lib/site/novel-locale-check");
const route = await import("@/app/api/novel-locale-check/route");

function siblingRow(overrides: Record<string, unknown> = {}) {
  return {
    locale: "en",
    slug: "the-lantern-keepers-daughter",
    publicPageShortId: "en123456",
    status: "published",
    deletedAt: null,
    novel: { status: "published", deletedAt: null },
    promoLink: { status: "fetched", webUrl: "https://upstream.example/en", appUrl: null, deletedAt: null },
    ...overrides,
  };
}

function fakeDb(options: { source?: { novelId: string | null } | null; siblings?: ReturnType<typeof siblingRow>[] }) {
  return {
    article: {
      findFirst: vi.fn().mockResolvedValue(options.source === undefined ? { novelId: "novel-1" } : options.source),
      findMany: vi.fn().mockResolvedValue(options.siblings ?? []),
    },
  };
}

beforeEach(() => {
  process.env.SITE_URL = "https://novel.example";
});

afterEach(() => {
  delete process.env.SITE_URL;
  delete process.env.FEATURE_ARTICLE_SEO_VISIBILITY;
});

describe("checkNovelLocaleMatch", () => {
  it("目标语种有这本书的公开页 → hasMatch + 带目标语种前缀的规范路径（en 无前缀）", async () => {
    const db = fakeDb({
      siblings: [
        siblingRow(),
        siblingRow({ locale: "ko", slug: "deungdae", publicPageShortId: "ko123456" }),
      ],
    });

    await expect(checkNovelLocaleMatch(db as never, { slugParam: "deungdae-pko123456", target: "en" })).resolves.toEqual({
      hasMatch: true,
      path: "/novel/the-lantern-keepers-daughter-pen123456",
    });
    await expect(checkNovelLocaleMatch(db as never, { slugParam: "the-lantern-keepers-daughter-pen123456", target: "ko" })).resolves.toEqual({
      hasMatch: true,
      path: "/ko/novel/deungdae-pko123456",
    });
  });

  it("按 URL 里的短码找源文章（不是按 slug、也不是按语种），源文章要求是公开可见的", async () => {
    const db = fakeDb({ siblings: [siblingRow()] });
    await checkNovelLocaleMatch(db as never, { slugParam: "deungdae-pko123456", target: "en" });

    const query = db.article.findFirst.mock.calls[0]![0];
    expect(JSON.stringify(query.where)).toContain('"publicPageShortId":"ko123456"');
    expect(JSON.stringify(query.where)).toContain('"status":"published"'); // buildPublicArticleWhere 的粗过滤
    expect(query.select).toEqual({ novelId: true });
  });

  it("兄弟查询复用 loadNovelHreflangSiblings：同一个 novelId、同一份 SITE_LOCALES 约束，没有第二份可见性 where", async () => {
    const db = fakeDb({ siblings: [siblingRow()] });
    await checkNovelLocaleMatch(db as never, { slugParam: "deungdae-pko123456", target: "en" });

    expect(db.article.findMany).toHaveBeenCalledTimes(1);
    const query = db.article.findMany.mock.calls[0]![0];
    expect(JSON.stringify(query.where)).toContain('"novelId":"novel-1"');
    expect(JSON.stringify(query.where)).toContain('"locale":{"in":');
  });

  it("目标语种没有这本书 → hasMatch:false，不带 path", async () => {
    const db = fakeDb({ siblings: [siblingRow({ locale: "ko", slug: "deungdae", publicPageShortId: "ko123456" })] });
    await expect(checkNovelLocaleMatch(db as never, { slugParam: "deungdae-pko123456", target: "en" })).resolves.toEqual({
      hasMatch: false,
    });
  });

  it("目标语种的版本不是公开可见的（草稿 / 下架 / 撤回 / 推广链接不可用）→ 视为没有，不把用户送去 404 或下架页", async () => {
    const db = fakeDb({
      siblings: [
        siblingRow({ status: "draft" }),
        siblingRow({ publicPageShortId: "en2", status: "unpublished" }),
        siblingRow({ publicPageShortId: "en3", novel: { status: "takedown", deletedAt: null } }),
        siblingRow({ publicPageShortId: "en4", promoLink: { status: "fetched", webUrl: "  ", appUrl: null, deletedAt: null } }),
        siblingRow({ publicPageShortId: "en5", deletedAt: new Date() }),
      ],
    });
    await expect(checkNovelLocaleMatch(db as never, { slugParam: "deungdae-pko123456", target: "en" })).resolves.toEqual({
      hasMatch: false,
    });
  });

  it("短码解析不出来 → hasMatch:false，且一次库都不查", async () => {
    const db = fakeDb({});
    await expect(checkNovelLocaleMatch(db as never, { slugParam: "no-short-code", target: "en" })).resolves.toEqual({
      hasMatch: false,
    });
    expect(db.article.findFirst).not.toHaveBeenCalled();
    expect(db.article.findMany).not.toHaveBeenCalled();
  });

  it("源文章不是公开可见的 / 找不到 → hasMatch:false，不去查兄弟（不泄露“别的语种有没有”）", async () => {
    const db = fakeDb({ source: null });
    await expect(checkNovelLocaleMatch(db as never, { slugParam: "deungdae-pko123456", target: "en" })).resolves.toEqual({
      hasMatch: false,
    });
    expect(db.article.findMany).not.toHaveBeenCalled();
  });
});

describe("GET /api/novel-locale-check", () => {
  function request(query: string): NextRequest {
    return { nextUrl: new URL(`https://novel.example/api/novel-locale-check${query}`) } as unknown as NextRequest;
  }

  const CACHE = "public, max-age=300, s-maxage=300";

  beforeEach(() => {
    prismaStub.prisma = fakeDb({
      siblings: [siblingRow({ locale: "en" }), siblingRow({ locale: "ko", slug: "deungdae", publicPageShortId: "ko123456" })],
    });
  });

  it("命中：200 + { hasMatch, path } + 与 CPS 相同的缓存头", async () => {
    const response = await route.GET(request("?slug=deungdae-pko123456&target=en"));
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe(CACHE);
    await expect(response.json()).resolves.toEqual({
      hasMatch: true,
      path: "/novel/the-lantern-keepers-daughter-pen123456",
    });
  });

  it.each([
    ["缺 slug", "?target=en"],
    ["缺 target", "?slug=deungdae-pko123456"],
    ["target 不是已登记语种", "?slug=deungdae-pko123456&target=xx"],
    ["target 是路径注入", "?slug=deungdae-pko123456&target=../../etc"],
    ["slug 只有空白", "?slug=%20%20&target=en"],
  ])("参数不合法（%s）→ 200 + { hasMatch:false }，一次库都不查", async (_label, query) => {
    const db = prismaStub.prisma as ReturnType<typeof fakeDb>;
    const response = await route.GET(request(query));
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe(CACHE);
    await expect(response.json()).resolves.toEqual({ hasMatch: false });
    expect(db.article.findFirst).not.toHaveBeenCalled();
  });

  it("数据库出错 → 503 + no-store + 不带任何错误细节（不把一次抖动缓存五分钟）", async () => {
    prismaStub.prisma = {
      article: { findFirst: vi.fn().mockRejectedValue(new Error("connection refused: secret-host:5432")), findMany: vi.fn() },
    };
    const response = await route.GET(request("?slug=deungdae-pko123456&target=en"));
    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const body = await response.text();
    expect(body).not.toContain("secret-host");
    expect(JSON.parse(body)).toEqual({ hasMatch: false });
  });
});
