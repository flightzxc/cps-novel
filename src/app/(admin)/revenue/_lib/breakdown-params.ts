/**
 * `/revenue` 按书区块的 URL 状态：`?theater=`（全部 / 剧场 id / unmatched）、`?bookPage=`（页码）、
 * `?book=`（单书按日明细，上游 seriesKey `1_<数字>`）；国家矩阵口径 `?countryMetric=active`（缺省新用户）。
 * 与区间参数 `from` / `to` 同一个约定——URL 就是状态，
 * 筛选与翻页都是普通链接，不需要 JS。
 *
 * 这里只做形状层面的取值（重复参数 / 非法页码 → 忽略）；剧场 id 是否属于本账号由读服务判定。
 */

export type RevenueBreakdownParams = {
  readonly theater?: string | string[];
  readonly bookPage?: string | string[];
  readonly book?: string | string[];
  readonly countryMetric?: string | string[];
};

export type ResolvedBreakdownParams = {
  readonly theater: string | null;
  readonly bookPage: number | null;
  readonly book: string | null;
  /** 只认 "active"；其它一律 null（= 新用户）。 */
  readonly countryMetric: "active" | null;
};

function single(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return null;
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

export function resolveBreakdownParams(params: RevenueBreakdownParams): ResolvedBreakdownParams {
  const page = single(params.bookPage);
  const parsedPage = page !== null && /^\d{1,6}$/.test(page) ? Number(page) : null;
  return {
    theater: single(params.theater),
    bookPage: parsedPage !== null && parsedPage > 0 ? parsedPage : null,
    book: single(params.book),
    countryMetric: single(params.countryMetric) === "active" ? "active" : null,
  };
}

/** 生成 `/revenue` 链接：始终带上当前区间，其余参数为 null 时省略。 */
export function revenueHref(input: {
  dateFrom: string;
  dateTo: string;
  theater?: string | null;
  bookPage?: number | null;
  book?: string | null;
  countryMetric?: "active" | null;
  hash?: string;
}): string {
  const search = new URLSearchParams({ from: input.dateFrom, to: input.dateTo });
  if (input.theater) search.set("theater", input.theater);
  if (input.bookPage && input.bookPage > 1) search.set("bookPage", String(input.bookPage));
  if (input.book) search.set("book", input.book);
  if (input.countryMetric === "active") search.set("countryMetric", "active");
  return `/revenue?${search.toString()}${input.hash ? `#${input.hash}` : ""}`;
}
