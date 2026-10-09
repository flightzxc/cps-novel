/**
 * 站内搜索的一条原生 SQL（PN-15，方案附录 B）。
 *
 * ## 可见性：只复用，不复制
 *
 * `FROM`/`JOIN` 段与 `WHERE` 里的"列表可见"条件**原样**取自 `@/lib/site/public-list`
 * （`PUBLIC_LIST_FROM_SQL` / `publicListWhereSql` / `singleLocale`，与"全部作品"页、分类页、页脚计数同一段），
 * 本文件只在它后面追加一个"书名包含搜索词"的条件。推广链接可用判断、seo_only / hidden、下架、软删、
 * 他语种、博客文章的排除，全部由那段条件负责——**不得在这里复制或改写任何一条**。
 * 真实库用例逐类构造反例，断言 搜索结果 ⊆ 列表可见集合。
 *
 * ## 比较：两边归一，转义在归一之后
 *
 * - 搜索词与书名都在数据库里做 `lower(normalize(x, NFKC))` 后比较。只归一一边会漏：泰语元音 "ำ"（U+0E33）
 *   NFKC 后拆成两个字符，书名里没拆，照着书名打字搜不到（生产实测 "ทำ" 只归一搜索词 0 本，两边归一 8 本）。
 * - LIKE 元字符 `\`、`%`、`_` 在**归一之后**转义（全角 "％" 归一后才变成 "%"，必须先归一再转义），
 *   所以数据库返回的就是字面匹配结果——要分页、要准确总数，就不能像 CPS 那样事后在程序里丢行。
 * - 只搜 `a.title`（卡片上显示的书名），不搜作者、简介。
 *
 * ## 分档
 *
 * 全等 → 1，以搜索词开头 → 2，其余包含 → 3；同档 `published_at DESC, id ASC`（与列表页同一个次序，翻页才稳定）。
 * 比较前去掉书名两端的空白（`JS_TRIM_WHITESPACE_CHARACTERS`）和方向/零宽控制符（生产 12 本阿语书名首尾带这类
 * 不可见字符，不去掉就永远进不了 1、2 档）；这个字符集作为**绑定参数**传入，SQL 文本里不出现原始字符。
 * 只影响排序分档，不影响命中与否（命中看的是不去空白的书名）。
 *
 * ## 反斜杠
 *
 * `Prisma.sql` 是普通模板字符串，`'\'` 会被 JS 当转义吞掉；含反斜杠的 SQL 片段一律用 `String.raw` +
 * `Prisma.raw` 构造，final SQL 文本由用例逐字断言。
 */
import { Prisma, type PrismaClient } from "@prisma/client";

import { PUBLIC_LIST_FROM_SQL, publicListWhereSql, singleLocale } from "@/lib/site/public-list";
import { JS_TRIM_WHITESPACE_CHARACTERS } from "@/server/publication/visibility";

type Db = PrismaClient | Prisma.TransactionClient;

function codePointRange(from: number, to: number): string {
  let out = "";
  for (let codePoint = from; codePoint <= to; codePoint += 1) out += String.fromCodePoint(codePoint);
  return out;
}

/**
 * 分档时从书名两端去掉的字符：JS `trim()` 认的空白（25 个）+ 方向/零宽控制符
 * （U+200B–U+200F 零宽与 LRM/RLM，U+202A–U+202E 方向嵌入/覆盖，U+2066–U+2069 方向隔离）。
 */
export const SEARCH_TITLE_TRIM_CHARACTERS: string =
  JS_TRIM_WHITESPACE_CHARACTERS + codePointRange(0x200b, 0x200f) + codePointRange(0x202a, 0x202e) + codePointRange(0x2066, 0x2069);

/** `ESCAPE '\'`：转义字符是单个反斜杠。 */
const ESCAPE_CLAUSE = Prisma.raw(String.raw`ESCAPE '\'`);

/** 把归一后的小写搜索词转义成 LIKE 模式体：先转义反斜杠自己，再转义 `%`、`_`。 */
const ESCAPE_EXPRESSION = Prisma.raw(String.raw`replace(replace(replace(v, '\', '\\'), '%', '\%'), '_', '\_')`);

/** 书名一侧：与搜索词同样 `lower(normalize(…, NFKC))` 之后再比较。 */
const TITLE_FOLDED = Prisma.raw("lower(normalize(a.title, NFKC))");

/** 搜索词的两个派生值：`qq.v`（归一 + 小写，用于全等）与 `qq.esc`（再转义，用于 LIKE）。 */
function queryCtes(query: string): Prisma.Sql {
  return Prisma.sql`
    WITH q AS (
      SELECT lower(normalize(${query}::text, NFKC)) AS v
    ), qq AS (
      SELECT v, ${ESCAPE_EXPRESSION} AS esc FROM q
    )
  `;
}

function titleContainsQuery(): Prisma.Sql {
  return Prisma.sql`${TITLE_FOLDED} LIKE '%' || qq.esc || '%' ${ESCAPE_CLAUSE}`;
}

function titleTrimmedFolded(): Prisma.Sql {
  return Prisma.sql`lower(normalize(btrim(a.title, ${SEARCH_TITLE_TRIM_CHARACTERS}), NFKC))`;
}

function tierExpression(): Prisma.Sql {
  return Prisma.sql`CASE
      WHEN ${titleTrimmedFolded()} = qq.v THEN 1
      WHEN ${titleTrimmedFolded()} LIKE qq.esc || '%' ${ESCAPE_CLAUSE} THEN 2
      ELSE 3
    END`;
}

type PageRow = { id: string; total: number | bigint };
type CountRow = { total: number | bigint };

export type SiteSearchPageOptions = Readonly<{
  /** 已经归一过的搜索词（`normalizeSearchInput` 的 `query`）。 */
  query: string;
  locale: string;
  limit: number;
  offset: number;
  env?: NodeJS.ProcessEnv;
}>;

/** 当前页的编号 + 总数那条 SQL（不执行，供用例断言文本与 EXPLAIN）。 */
export function buildSiteSearchPageSql(options: SiteSearchPageOptions): Prisma.Sql {
  const env = options.env ?? process.env;
  return Prisma.sql`
    ${queryCtes(options.query)}
    SELECT a.id AS id, count(*) OVER ()::int AS total
    ${PUBLIC_LIST_FROM_SQL}
    CROSS JOIN qq
    WHERE ${publicListWhereSql(singleLocale(options.locale), env)}
      AND ${titleContainsQuery()}
    ORDER BY ${tierExpression()}, a.published_at DESC, a.id ASC
    LIMIT ${options.limit}::int OFFSET ${options.offset}::bigint
  `;
}

/** 同条件、不带排序与分页的总数那条 SQL（本页无行而 offset > 0 时用，判页码越界）。 */
export function buildSiteSearchCountSql(options: Pick<SiteSearchPageOptions, "query" | "locale" | "env">): Prisma.Sql {
  const env = options.env ?? process.env;
  return Prisma.sql`
    ${queryCtes(options.query)}
    SELECT count(*)::int AS total
    ${PUBLIC_LIST_FROM_SQL}
    CROSS JOIN qq
    WHERE ${publicListWhereSql(singleLocale(options.locale), env)}
      AND ${titleContainsQuery()}
  `;
}

export type SiteSearchPage = Readonly<{
  /** 当前页的文章编号（已按 分档 → 发布时间新→旧 → 编号升序 排好）。 */
  ids: string[];
  /** 全部命中本数。 */
  total: number;
}>;

async function countMatches(db: Db, options: SiteSearchPageOptions): Promise<number> {
  const rows = await db.$queryRaw<CountRow[]>(buildSiteSearchCountSql(options));
  return Number(rows[0]?.total ?? 0);
}

/**
 * 一页搜索结果的编号 + 总数。
 *
 * - 本页有行：总数来自窗口函数 `count(*) OVER ()`，一条 SQL 搞定；
 * - 本页无行且 `offset > 0`：再跑一条同条件的 `count(*)`（不带排序/分页）拿总数，页面据此判 404；
 * - `offset` 不是安全整数（页码大到 `(page - 1) * pageSize` 装不进数据库的 `OFFSET`）：不发编号查询
 *   （数据库会报错而不是返回空），只数总数——同 `listPublicNovelPage`。
 */
export async function querySiteSearchPage(db: Db, options: SiteSearchPageOptions): Promise<SiteSearchPage> {
  if (!Number.isSafeInteger(options.offset) || options.offset < 0) {
    return { ids: [], total: await countMatches(db, options) };
  }
  const rows = await db.$queryRaw<PageRow[]>(buildSiteSearchPageSql(options));
  if (rows.length > 0) return { ids: rows.map((row) => row.id), total: Number(rows[0]!.total) };
  if (options.offset === 0) return { ids: [], total: 0 };
  return { ids: [], total: await countMatches(db, options) };
}
