/**
 * 畅读 GetReport（网文 projectType=1 账号级每日汇总）上游行的纯函数解析与对账。
 * 接口是账号级的：每一行都是该畅读账号下全部网文应用的合计，行里没有应用字段（文件名里的 `moboreader-`
 * 只表示 kocserver 上游适配器家族）。
 *
 * 搬运自 CPS `src/lib/changdu-total-revenue/parser.ts`（tag v8.7.2，peeled commit
 * c8c7d4ed66c42395a44811262afdb84bf29a8405），逐符号登记在 docs/governance/port-registry.md。
 * 与 CPS 的刻意差异：
 *   1. 总计行不再只是被跳过——解析成 `total` 单独返回，用来和明细合计对账；
 *   2. 金额 / 比例一律用 Decimal 字符串，不经过 JS 浮点（CPS 用 `Number`）；
 *   3. 日期必须是真实存在的日历日（CPS 只校验形状）；坏日期的行丢弃并计数；
 *   4. 数值越界（会撞 numeric / integer 列宽）按「无法解析」处理为 null，原始行仍完整保留在 `raw`。
 *
 * 这里没有 I/O、没有时钟、没有数据库——只有「一行上游数据进，一个解析结果出」。
 *
 * 字段口径（来自生产只读实测，见 docs/governance/database-governance.md §3.7）：
 *   - `realDevNum` 激活用户、`newRealDevNum` 新用户、`realDevNumRate` 新用户比例（字符串
 *     如 "28.27%"，也可能是数字）、`realIncome` 分成收入 US$、`realDistribIncome`、`realProfit`；
 *   - 字段整个缺失 → null；"0" / 0 → 0。这两者在看板上含义不同，不得互相替代；
 *   - 激活用户数不可跨日相加，所以对账只对分成收入做。
 */
import { Prisma } from "@prisma/client";

const Decimal = Prisma.Decimal;
type Decimal = Prisma.Decimal;

/** numeric(18,4) 最多 14 位整数；超出按无法解析处理，避免一行脏数据撞坏整个批次的 finalize 事务。 */
const MAX_ABS_AMOUNT = new Decimal("100000000000000");
/** numeric(9,6) 最多 3 位整数。 */
const MAX_ABS_RATIO = new Decimal("1000");
const MAX_INT = 2_147_483_647;

const DECIMAL_LITERAL = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;
const DATE_SHAPE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** 对账容差：明细分成收入合计与总计行相差不超过 US$0.01 视为一致。 */
export const REVENUE_RECONCILIATION_TOLERANCE = "0.01";

export interface ParsedRevenueRowBase {
  /** 上游 dimensionKey（回落 dimensionValue）；总计行缺失时记 "total"。原样存档，不加工。 */
  readonly dimensionKey: string;
  readonly dimensionValue: string | null;
  readonly activeUsers: number | null;
  readonly newUsers: number | null;
  /** 小数形式的字符串："28.27%" → "0.2827"；数字原样；缺失 → null。 */
  readonly newUserRatio: string | null;
  /** 分成收入（US$），十进制字符串。 */
  readonly shareIncomeUsd: string | null;
  readonly distribIncomeUsd: string | null;
  readonly profitUsd: string | null;
  /** 上游整行（约 49 个字段）原样保留，仅防御性遮蔽 token 类键。 */
  readonly raw: Readonly<Record<string, unknown>>;
}

export interface ParsedRevenueDay extends ParsedRevenueRowBase {
  /** YYYY-MM-DD，北京时间日期。 */
  readonly date: string;
}

export type ParsedRevenueTotal = ParsedRevenueRowBase;

export interface ParsedNovelReport {
  readonly detail: readonly ParsedRevenueDay[];
  /** 第一条总计行；上游没有返回总计行时为 null。 */
  readonly total: ParsedRevenueTotal | null;
  /** 上游返回的总计行条数（正常为 0 或 1）。 */
  readonly totalRowCount: number;
  /** 被丢弃的明细行数：不是对象 / 日期缺失 / 日期不是真实存在的 YYYY-MM-DD。 */
  readonly droppedRowCount: number;
  /** 同一日期出现不止一次的多余行数（它们仍留在 detail 里并参与对账，让不一致可见）。 */
  readonly duplicateDateCount: number;
}

function text(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  }
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

/** 上游总计行标记：`isTotal` 为 1 / true / "1" / "true"（CPS `isTruthyTotalRow`）。 */
export function isTruthyTotalRow(value: unknown): boolean {
  if (value === true || value === 1) return true;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    return normalized === "1" || normalized === "true";
  }
  return false;
}

function toDecimal(value: unknown): Decimal | null {
  if (typeof value === "number") return Number.isFinite(value) ? new Decimal(value) : null;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || !DECIMAL_LITERAL.test(trimmed)) return null;
  try {
    const parsed = new Decimal(trimmed);
    return parsed.isFinite() ? parsed : null;
  } catch {
    return null;
  }
}

/** 分成收入 / 利润等金额：十进制字符串（不经浮点），越界 → null。 */
export function toAmountString(value: unknown): string | null {
  const parsed = toDecimal(value);
  if (!parsed || parsed.abs().gte(MAX_ABS_AMOUNT)) return null;
  return parsed.toFixed();
}

/** 用户数：取整（CPS `toIntegerOrNull`），越界 → null。 */
export function toIntegerOrNull(value: unknown): number | null {
  const parsed = toDecimal(value);
  if (!parsed) return null;
  const truncated = parsed.trunc();
  if (truncated.abs().gt(MAX_INT)) return null;
  return truncated.toNumber();
}

/**
 * "28.27%" → "0.2827"；裸数字 "28.27" / 28.27 原样返回（不隐含除以 100，与 CPS 一致）；
 * 空 / 无法解析 / 越界 → null。
 */
export function parseRatioFraction(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  let parsed: Decimal | null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const isPercent = trimmed.includes("%");
    const numeric = toDecimal(trimmed.replace("%", "").trim());
    parsed = numeric && isPercent ? numeric.div(100) : numeric;
  } else {
    parsed = toDecimal(value);
  }
  if (!parsed || parsed.abs().gte(MAX_ABS_RATIO)) return null;
  return parsed.toFixed();
}

/** 真实存在的 YYYY-MM-DD 日历日（形状正确但 2026-02-30 之类也拒绝）。 */
export function isValidCalendarDate(value: string): boolean {
  const match = DATE_SHAPE.exec(value);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

const REDACTED_RAW_KEYS = new Set(["token", "authorization", "jwt", "secret", "cookie", "password"]);

/**
 * 原样存档，只做两件事：丢掉 undefined（JSON 序列化本来也会丢）、对 token 类键防御性遮蔽。
 * 上游汇总行本来不含这些键；这里是纵深防御，保证“任何落库内容里都不出现 token”。
 */
function toRawPayload(row: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (value === undefined) continue;
    output[key] = REDACTED_RAW_KEYS.has(key.toLowerCase()) ? "[redacted]" : value;
  }
  return output;
}

function baseFields(row: Record<string, unknown>): Omit<ParsedRevenueRowBase, "dimensionKey" | "dimensionValue"> {
  return {
    activeUsers: toIntegerOrNull(row.realDevNum),
    newUsers: toIntegerOrNull(row.newRealDevNum),
    newUserRatio: parseRatioFraction(row.realDevNumRate),
    shareIncomeUsd: toAmountString(row.realIncome),
    distribIncomeUsd: toAmountString(row.realDistribIncome),
    profitUsd: toAmountString(row.realProfit),
    raw: toRawPayload(row),
  };
}

/**
 * 解析 `data.list`：总计行（`isTotal`）单独返回、**不进明细**；其余按日明细行，日期取
 * `dimensionValue`（回落 `dimensionKey`），必须是真实存在的 YYYY-MM-DD，否则丢弃并计数。
 */
export function parseNovelReportRows(list: readonly unknown[]): ParsedNovelReport {
  const detail: ParsedRevenueDay[] = [];
  let total: ParsedRevenueTotal | null = null;
  let totalRowCount = 0;
  let droppedRowCount = 0;
  let duplicateDateCount = 0;
  const seenDates = new Set<string>();

  for (const entry of list) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      droppedRowCount += 1;
      continue;
    }
    const row = entry as Record<string, unknown>;
    const dimensionKeyText = text(row.dimensionKey);
    const dimensionValueText = text(row.dimensionValue);

    if (isTruthyTotalRow(row.isTotal)) {
      totalRowCount += 1;
      if (total === null) {
        total = {
          dimensionKey: (dimensionKeyText ?? dimensionValueText ?? "total").slice(0, 64),
          dimensionValue: dimensionValueText === null ? null : dimensionValueText.slice(0, 128),
          ...baseFields(row),
        };
      }
      continue;
    }

    const date = dimensionValueText ?? dimensionKeyText;
    if (!date || !isValidCalendarDate(date)) {
      droppedRowCount += 1;
      continue;
    }
    if (seenDates.has(date)) duplicateDateCount += 1;
    seenDates.add(date);
    detail.push({
      date,
      dimensionKey: (dimensionKeyText ?? dimensionValueText ?? date).slice(0, 64),
      dimensionValue: dimensionValueText === null ? null : dimensionValueText.slice(0, 128),
      ...baseFields(row),
    });
  }

  return { detail, total, totalRowCount, droppedRowCount, duplicateDateCount };
}

export type RevenueReconciliationOutcome = "matched" | "mismatched" | "not_applicable";

export interface RevenueReconciliation {
  readonly status: RevenueReconciliationOutcome;
  /** 明细分成收入合计（缺失的明细金额按 0 计）；无总计行 / 总计行无金额时为 null。 */
  readonly detailIncomeSum: string | null;
  readonly totalIncome: string | null;
  /** |合计 − 总计行|，十进制字符串。 */
  readonly difference: string | null;
}

/**
 * 对账：明细 `shareIncomeUsd` 合计 vs 总计行 `shareIncomeUsd`，差 ≤ 0.01 → matched，否则
 * mismatched；上游没有总计行（或总计行没有金额字段）→ not_applicable。激活用户不可相加，不对账。
 * 全程 Decimal，不走 JS 浮点求和。
 */
export function reconcileNovelRevenue(
  detail: readonly Pick<ParsedRevenueDay, "shareIncomeUsd">[],
  total: Pick<ParsedRevenueTotal, "shareIncomeUsd"> | null,
  tolerance: string = REVENUE_RECONCILIATION_TOLERANCE,
): RevenueReconciliation {
  if (!total || total.shareIncomeUsd === null) {
    return { status: "not_applicable", detailIncomeSum: null, totalIncome: null, difference: null };
  }
  let sum = new Decimal(0);
  for (const day of detail) {
    if (day.shareIncomeUsd !== null) sum = sum.plus(day.shareIncomeUsd);
  }
  const totalIncome = new Decimal(total.shareIncomeUsd);
  const difference = sum.minus(totalIncome).abs();
  return {
    status: difference.lte(tolerance) ? "matched" : "mismatched",
    detailIncomeSum: sum.toFixed(),
    totalIncome: totalIncome.toFixed(),
    difference: difference.toFixed(),
  };
}
