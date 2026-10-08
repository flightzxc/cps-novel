import { checkRangeShape, rangeProblemCopy, type RangeProblem } from "./dates";

/**
 * `/revenue?from=&to=` 的解析。
 *
 * 读服务对非法区间会**抛** `RevenueDashboardQueryError`，所以页面必须先在这里校验再调用——
 * 一个手改过的 URL 不该把整页打成错误边界。非法（缺一端、格式不对、反向、跨度 > 92 天、
 * 结束日期晚于今天）一律回落到后端给的默认区间，并把原因写给运营看，而不是静默换一个区间。
 *
 * "结束日期晚于今天"是页面层多加的一条：读服务本身允许，但未来的日子永远只会是"未同步"，
 * 展示出来只会让"区间内有 K 天未同步"的提示失真。
 */

export type RevenueRangeParams = {
  readonly from?: string | string[];
  readonly to?: string | string[];
};

export type ResolvedRevenueRange = {
  readonly dateFrom: string;
  readonly dateTo: string;
  /** 回落到默认区间时给运营看的原因；用了所选区间则为 null。 */
  readonly fallbackNotice: string | null;
};

function single(value: string | string[] | undefined): string | undefined {
  // 同一参数在 URL 里重复出现时运行时是数组：当作非法输入，不猜哪一个有效。
  if (Array.isArray(value)) return "";
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

export function resolveRevenueRange(
  params: RevenueRangeParams,
  today: string,
  fallback: { readonly dateFrom: string; readonly dateTo: string },
): ResolvedRevenueRange {
  const from = single(params.from);
  const to = single(params.to);
  const fallbackTo = (reason: string): ResolvedRevenueRange => ({
    dateFrom: fallback.dateFrom,
    dateTo: fallback.dateTo,
    fallbackNotice: `所选区间无效（${reason}），已回落到默认的最近 30 天（${fallback.dateFrom} ~ ${fallback.dateTo}）。`,
  });

  if (from === undefined && to === undefined) {
    return { dateFrom: fallback.dateFrom, dateTo: fallback.dateTo, fallbackNotice: null };
  }
  if (from === undefined || to === undefined) return fallbackTo("开始日期和结束日期需要同时给出");

  const shape = checkRangeShape(from, to);
  if (!shape.ok) return fallbackTo(rangeProblemCopy(shape.problem));
  if (to > today) {
    const problem: RangeProblem = "future";
    return fallbackTo(rangeProblemCopy(problem));
  }
  return { dateFrom: from, dateTo: to, fallbackNotice: null };
}
