/**
 * 按 `id` 游标分块读取「一个条件下的全部行」（站点地图规模缺陷修复，2026-10-06）。
 *
 * 为什么不能一次 `findMany` 读完：只要 select 里带了**组合外键**关系（例如
 * `Article.[promoLinkId, novelId] → PromoLink.[id, novelId]` 的 `promoLink`），Prisma 加载关系时
 * 会生成「元组 IN」：`(id, novel_id) IN (($1,$2),($3,$4),…)`，每行占 2 个绑定变量。实测（PostgreSQL 16.14，
 * `max_stack_depth` 2048kB，`article.findMany({ take: N, select: { promoLink } })` 二分）有两道墙：
 *   - 元组数 ≥ 约 7,281：PostgreSQL 报 54001 `stack depth limit exceeded`（7,250 仍通过；元组 IN 被展开成
 *     很深的表达式树）。2026-10-06 预生产事故现场失败的那条语句是 6,835 组（`$13670` 个参数），说明生产门槛
 *     比本机略低——所以块大小要比本机门槛再留出一个数量级的余量；
 *   - 元组数 ≥ 16,384（2 × 16,384 > 32,767）：Prisma 在客户端直接拒绝，
 *     `too many bind variables in prepared statement, expected maximum of 32767`。
 * 两者都只取决于「一次取回多少行」，与数据内容无关；规模一上来每次都失败，没有"偶发"。
 *
 * 解法是每次只取一块（`take` + `id > 上一块最后一个 id`，按 `id` 升序），把每条查询的元组数钉死在块大小以内，
 * 各块按顺序首尾相接，**结果与一次读完逐行相同**（同样的过滤、同样的 `id` 升序）。
 * 单列外键关系的 `id IN (…)` 是扁平列表，没有这个问题，所以只有带组合外键关系的查询才需要走这里。
 */

/** 一块的行数上限必须是正整数；其它值直接抛错，免得默默退化成「一次读完」或死循环。 */
function assertChunkSize(chunkSize: number): void {
  if (!Number.isSafeInteger(chunkSize) || chunkSize < 1) {
    throw new RangeError(`id cursor chunk size must be a positive safe integer, got ${chunkSize}`);
  }
}

/**
 * 给第 2 块及以后的查询条件加上「id 大于游标」；第 1 块（没有游标）原样返回，
 * 所以小规模（一块读完）时发出的查询与改前只差一个 `take`。
 */
export function whereAfterId<Where extends object>(
  where: Where,
  after: string | undefined,
): Where | { AND: [Where, { id: { gt: string } }] } {
  return after === undefined ? where : { AND: [where, { id: { gt: after } }] };
}

/**
 * 反复调用 `fetchPage` 直到取到一块不满为止，返回全部行（按 `fetchPage` 保证的 `id` 升序首尾相接）。
 * `fetchPage` 必须按 `id` 升序返回、最多 `take` 行、且只返回 `id` 大于 `after` 的行。
 */
export async function loadAllByIdCursor<Row extends { id: string }>(
  chunkSize: number,
  fetchPage: (page: { take: number; after: string | undefined }) => Promise<readonly Row[]>,
): Promise<Row[]> {
  assertChunkSize(chunkSize);
  const rows: Row[] = [];
  let after: string | undefined;
  for (;;) {
    const page = await fetchPage({ take: chunkSize, after });
    for (const row of page) rows.push(row);
    // 一块不满 = 已经读到末尾；恰好满块则再读一块（可能是空块），不靠「总数」猜。
    if (page.length < chunkSize) return rows;
    const last = page[page.length - 1]!.id;
    // 游标必须前进。真数据库不会违反（`id > after` 的行里取最小的 N 个）；这里挡的是忽略 `after` / `take`
    // 的替身，免得它们把调用方拖进死循环、把内存吃光，而不是给一个清楚的报错。
    if (last === after) throw new Error(`id cursor did not advance past ${last}: fetchPage must honor "after" and "take"`);
    after = last;
  }
}
