/**
 * `/revenue` 页面层的日期工具：纯函数，**不依赖任何服务端模块**，所以 client 组件（区间筛选、同步表单）
 * 与 server 组件（页面、searchParams 解析）共用同一份。
 *
 * 为什么不直接复用后端的 `assertValidRevenueSyncRange`：它所在的 `@/lib/tasks/revenue-sync` 引了
 * `node:crypto`，client 组件不能 import。这里只复制它的**规则**（不复制实现的依赖），并由
 * `tests/ui/revenue-dashboard.test.tsx` 的"与后端校验一致"用例逐项对拍——后端规则变了，这里不跟就会变红。
 *
 * 日期一律是北京时间（Asia/Shanghai）的日历日，格式 `YYYY-MM-DD`；这里只做日历运算，不涉及时区。
 */

/** 与后端 `REVENUE_SYNC_MAX_SPAN_DAYS` 一致：一次最多覆盖 92 天（含首尾）。 */
export const REVENUE_MAX_SPAN_DAYS = 92;
/** 同步表单的默认区间：最近 7 天（含今天）。上游会回补最近几天，所以不建议更短。 */
export const REVENUE_SYNC_DEFAULT_DAYS = 7;
/** 区间筛选的快捷项（天数含今天）。 */
export const REVENUE_QUICK_RANGE_DAYS: readonly number[] = Object.freeze([7, 30, 90]);

const DAY_MS = 24 * 60 * 60 * 1000;
const DATE_SHAPE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** 真实存在的 YYYY-MM-DD 日历日（2026-02-30 之类也拒绝）。 */
export function isCalendarDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = DATE_SHAPE.exec(value);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/** YYYY-MM-DD 加减天数。入参必须是合法日期（调用方先用 `isCalendarDate` 校验）。 */
export function addDays(date: string, days: number): string {
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, day) + days * DAY_MS).toISOString().slice(0, 10);
}

/** 区间覆盖的天数（含首尾）。两端必须是合法日期。 */
export function inclusiveSpanDays(begin: string, end: string): number {
  const [by, bm, bd] = begin.split("-").map(Number) as [number, number, number];
  const [ey, em, ed] = end.split("-").map(Number) as [number, number, number];
  return Math.round((Date.UTC(ey, em - 1, ed) - Date.UTC(by, bm - 1, bd)) / DAY_MS) + 1;
}

export type RangeProblem = "format" | "order" | "span" | "future";

export type RangeCheck = { readonly ok: true } | { readonly ok: false; readonly problem: RangeProblem };

/**
 * 区间形状：两端是真实日期、begin ≤ end、跨度 ≤ 92 天。与后端读服务 `loadRevenueDashboard`
 * 的入参校验同口径——**读取看板**只要求这三条。
 */
export function checkRangeShape(begin: unknown, end: unknown): RangeCheck {
  if (!isCalendarDate(begin) || !isCalendarDate(end)) return { ok: false, problem: "format" };
  if (begin > end) return { ok: false, problem: "order" };
  if (inclusiveSpanDays(begin, end) > REVENUE_MAX_SPAN_DAYS) return { ok: false, problem: "span" };
  return { ok: true };
}

/**
 * 同步区间 = 区间形状 + 结束日期不得晚于北京时间今天（与后端入队校验同口径；
 * 页面上的校验只是为了少一次往返，**最终以服务端返回为准**）。
 */
export function checkSyncRange(begin: unknown, end: unknown, today: string): RangeCheck {
  const shape = checkRangeShape(begin, end);
  if (!shape.ok) return shape;
  if ((end as string) > today) return { ok: false, problem: "future" };
  return { ok: true };
}

const PROBLEM_COPY: Readonly<Record<RangeProblem, string>> = Object.freeze({
  format: "日期格式不正确（需要真实存在的 YYYY-MM-DD）",
  order: "开始日期不能晚于结束日期",
  span: `区间不能超过 ${REVENUE_MAX_SPAN_DAYS} 天`,
  future: "结束日期不能晚于今天（北京时间）",
});

export function rangeProblemCopy(problem: RangeProblem): string {
  return PROBLEM_COPY[problem];
}

/** 以 `today` 结束、共 `days` 天（含今天）的区间。 */
export function trailingRange(today: string, days: number): { dateFrom: string; dateTo: string } {
  return { dateFrom: addDays(today, -(days - 1)), dateTo: today };
}
