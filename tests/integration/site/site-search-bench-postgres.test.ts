/**
 * PN-15 站内搜索·本机规模测量（真实库，接近生产规模的合成数据）。
 *
 * 只在 `PN15_SEARCH_BENCH=1` 时运行（默认的验证运行器不带它）；入口：
 *   bash scripts/run-site-search-postgres-verification.sh --bench
 * 数据：用 `tests/integration/tasks/fixtures/bulk-public-articles.ts` 一条 SQL 一张表灌 14,000 本英语列表可见书
 * （生产 2026-10-09 实测英语 13,774 本），再把文章标题改写成 "The Billionaire's Secret Love" 这类
 * 英文书名（高命中词 "the" 约占一半，对齐生产实测 6,718 / 13,774），然后 ANALYZE。
 * 输出（每个场景先预热 1 次，再取 5 次的中位数 / 最小 / 最大）：
 *   PN15_SEARCH_BENCH name=<场景> median_ms=<毫秒> min_ms=<> max_ms=<> total=<命中本数>
 * 场景：SQL 层（高命中 "the" 第 1 页 / 深页、中等命中 "love"、多词、零命中），以及服务层端到端（含补全卡片）。
 * 数值是**本机**数字（本机磁盘 / 内存 / 并发负载与生产不同，仅作量级参照）；不设耗时断言，只断言结果正确。
 */
import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { querySiteSearchPage } from "@/lib/site-search/search-query";
import { clearSiteSearchCacheForTest, searchSite } from "@/lib/site-search/site-search-service";
import {
  assertIsolatedDatabase,
  connectRoles,
  disconnectRoles,
  enabled,
  resetDatabase,
} from "../tagging/effective-tag-fixtures";
import { createChannelFixture, seedBulkPublicArticles } from "../tasks/fixtures/bulk-public-articles";
import { envFor } from "./site-fixtures";

const benchEnabled = enabled && process.env.PN15_SEARCH_BENCH === "1";
const roles = connectRoles();
const { owner, web } = roles;
const env = envFor({ seoVisibility: true });

const BOOKS = 14_000;
const RUNS = 5;

async function measure(name: string, run: () => Promise<{ total: number }>): Promise<number> {
  await run(); // 预热
  const samples: number[] = [];
  let total = 0;
  for (let index = 0; index < RUNS; index += 1) {
    const startedAt = performance.now();
    total = (await run()).total;
    samples.push(performance.now() - startedAt);
  }
  samples.sort((a, b) => a - b);
  const median = samples[Math.floor(samples.length / 2)]!;
  console.log(
    `PN15_SEARCH_BENCH name=${name} median_ms=${median.toFixed(1)} min_ms=${samples[0]!.toFixed(1)} max_ms=${samples[samples.length - 1]!.toFixed(1)} total=${total}`,
  );
  return median;
}

async function retitle(db: PrismaClient): Promise<void> {
  // 书名 = [The ]形容词 名词[ of 名词]，词表里有 "Love"、"Alpha"、"King"、"Billionaire" 等生产里的高频词。
  await db.$executeRawUnsafe(`
    WITH words AS (
      SELECT
        ARRAY['Billionaire','Alpha','Hidden','Cruel','Lost','Secret','Forbidden','Sweet','Dark','Golden','Silent','Broken','Crimson','Eternal','Wild','Frozen','Savage','Gentle','Rebel','Lucky']::text[] AS adj,
        ARRAY['Love','King','Heir','Bride','Queen','Wolf','Promise','Marriage','Mafia','Contract','Moon','Empire','Heart','Duke','Luna','Rose','Storm','Vow','Throne','Sister']::text[] AS noun,
        ARRAY['Brother','Mother','Weather','Other','Together','Night','Fire','Ocean','Winter','City']::text[] AS tail
    ), hashed AS (
      SELECT a.id, abs(hashtext(a.id::text)) AS h FROM article a WHERE a.locale = 'en'
    )
    UPDATE article a SET title =
      (CASE WHEN h.h % 2 = 0 THEN 'The ' ELSE '' END) ||
      w.adj[1 + (h.h / 3) % 20] || ' ' || w.noun[1 + (h.h / 7) % 20] ||
      (CASE WHEN h.h % 5 = 0 THEN ' of the ' || w.tail[1 + (h.h / 11) % 10] ELSE '' END)
    FROM hashed h, words w WHERE a.id = h.id`);
}

describe.skipIf(!benchEnabled).sequential("PN-15 站内搜索规模测量（接近生产规模的合成数据）", () => {
  let theTotal = 0;

  beforeAll(async () => {
    await assertIsolatedDatabase(owner);
    await resetDatabase(owner);
    const channel = await createChannelFixture(owner);
    const seededAt = performance.now();
    await seedBulkPublicArticles(owner, { prefix: "pn15bench", locale: "en", count: BOOKS, channel, baseUpdatedAt: new Date("2026-01-01T00:00:00Z") });
    await retitle(owner);
    await owner.$executeRawUnsafe("ANALYZE article");
    await owner.$executeRawUnsafe("ANALYZE novel");
    await owner.$executeRawUnsafe("ANALYZE promo_link");
    console.log(`PN15_SEARCH_BENCH name=seed_ms median_ms=${(performance.now() - seededAt).toFixed(0)} books=${BOOKS}`);
    const [{ n }] = await owner.$queryRaw<Array<{ n: number }>>`SELECT count(*)::int AS n FROM article WHERE locale = 'en' AND status = 'published'`;
    expect(n).toBe(BOOKS);
    const [{ t }] = await owner.$queryRaw<Array<{ t: number }>>`SELECT count(*)::int AS t FROM article WHERE lower(normalize(title, NFKC)) LIKE '%the%'`;
    theTotal = t;
    console.log(`PN15_SEARCH_BENCH name=scale visible_en=${n} the_hits=${t} (${Math.round((t / n) * 100)}%)`);
  }, 900_000);

  afterAll(async () => {
    await disconnectRoles(roles);
  });

  const sql = (query: string, offset = 0) => querySiteSearchPage(web, { query, locale: "en", limit: 20, offset, env });

  it("SQL 层：高命中 'the'（第 1 页）、深页、中等命中 'love'、多词（库里真实存在的两词组合）、零命中、越界页", async () => {
    expect(theTotal).toBeGreaterThan(BOOKS * 0.4);
    await measure("sql_the_page1", async () => ({ total: (await sql("the")).total }));
    const lastOffset = Math.floor((theTotal - 1) / 20) * 20;
    await measure("sql_the_deep_last_page", async () => {
      const page = await sql("the", lastOffset);
      expect(page.ids.length).toBeGreaterThan(0);
      return { total: page.total };
    });
    await measure("sql_love_page1", async () => ({ total: (await sql("love")).total }));
    // 多词：取库里真实存在的一个"形容词 名词"组合（词表里两个词由同一个哈希决定，随便拼的组合可能一本都没有）。
    const [{ title: sample }] = await owner.$queryRaw<Array<{ title: string }>>`SELECT title FROM article WHERE locale = 'en' ORDER BY id LIMIT 1`;
    const phrase = sample.replace(/^The /, "").split(" ").slice(0, 2).join(" ").toLowerCase();
    await measure("sql_multiword_real_phrase", async () => {
      const page = await sql(phrase);
      expect(page.total).toBeGreaterThan(0);
      return { total: page.total };
    });
    await measure("sql_zero_hit", async () => {
      const page = await sql("zzqxvkjw");
      expect(page.total).toBe(0);
      return { total: page.total };
    });
    await measure("sql_the_out_of_range_page", async () => {
      const page = await sql("the", theTotal + 4000);
      expect(page.ids).toEqual([]);
      expect(page.total).toBe(theTotal);
      return { total: page.total };
    });
  }, 600_000);

  it("服务层端到端（归一 + 查询 + 补全卡片），不走进程缓存", async () => {
    const run = (query: string, page: number) => async () => {
      const result = await searchSite({ query, locale: "en", page }, web, { env });
      expect(result.status).toBe("ok");
      return { total: result.totalCount };
    };
    clearSiteSearchCacheForTest();
    await measure("service_the_page1", run("the", 1));
    await measure("service_the_deep_last_page", run("the", Math.ceil(theTotal / 20)));
    await measure("service_love_page1", run("love", 1));
    await measure("service_zero_hit", run("zzqxvkjw", 1));
  }, 600_000);

  it("执行计划：页 SQL 在 article 上的顶层节点与顺序扫描（仅打印）", async () => {
    const { buildSiteSearchPageSql } = await import("@/lib/site-search/search-query");
    const { Prisma } = await import("@prisma/client");
    const statement = buildSiteSearchPageSql({ query: "the", locale: "en", limit: 20, offset: 0, env });
    const rows = await web.$queryRaw<Array<Record<string, string>>>(Prisma.sql`EXPLAIN (ANALYZE, BUFFERS) ${statement}`);
    console.log(`PN15_SEARCH_BENCH_EXPLAIN name=sql_the_page1\n${rows.map((row) => row["QUERY PLAN"]).join("\n")}\nPN15_SEARCH_BENCH_EXPLAIN_END`);
    expect(rows.length).toBeGreaterThan(0);
  }, 120_000);
});
