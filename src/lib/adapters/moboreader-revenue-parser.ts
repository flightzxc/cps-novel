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

/**
 * v0.6.2 起也遮蔽口令类键（`kocCode` / `promoCode` / `upstreamCode` / `code`）：按书 / 国家的上游行实测
 * 都不含口令码（维度 7 从不请求），这里同样只是纵深防御——PlotNovel 的 6 位口令码不得落库。
 */
const REDACTED_RAW_KEYS = new Set([
  "token", "authorization", "jwt", "secret", "cookie", "password",
  "koccode", "promocode", "upstreamcode", "code",
]);

/**
 * 原样存档，只做两件事：丢掉 undefined（JSON 序列化本来也会丢）、对 token / 口令类键防御性遮蔽。
 * 上游汇总行本来不含这些键；这里是纵深防御，保证“任何落库内容里都不出现 token 或口令码”。
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

// ── v0.6.2 按书（GetReport 维度 ["1","8"]）──────────────────────────────────────────────────

/** 书行 `dimensionValue` 形如 `1_<seriesId>`：前缀 1 = projectType 网文。其它前缀（如 2 = 短剧）一律丢弃。 */
const BOOK_SERIES_KEY = /^1_(\d{1,30})$/;
const BOOK_DIMENSION = "8";
const BOOK_NAME_MAX_LENGTH = 500;

export interface ParsedRevenueBookDay {
  /** 所在日期行的日期（北京时间 YYYY-MM-DD）。 */
  readonly date: string;
  /** 上游 `dimensionValue` 原文，如 `1_20125409`；与日期一起构成书日行的身份。 */
  readonly seriesKey: string;
  /** 去掉 projectType 前缀后的 seriesId（对应 `novel_source_item.raw_payload->>'seriesId'`，不是 external_book_id）。 */
  readonly seriesId: string;
  /** 上游 `dimensionKey`：书名原文（各语种）；缺失为空串。 */
  readonly bookName: string;
  readonly activeUsers: number | null;
  readonly newUsers: number | null;
  readonly newUserRatio: string | null;
  readonly shareIncomeUsd: string | null;
}

export interface ParsedNovelBookReport {
  /**
   * 顶层日期行（与按日口径同一套字段），用于和书行合计对账。它们的 `raw` **保留 `subItems`**（逐层遮蔽），
   * 原始行存档一天一行就是该日按书的完整上游数据，书行本身不再逐行存档。
   */
  readonly dates: readonly ParsedRevenueDay[];
  readonly books: readonly ParsedRevenueBookDay[];
  readonly total: ParsedRevenueTotal | null;
  readonly totalRowCount: number;
  /** 被丢弃的顶层行（不是对象 / 日期不合法）。 */
  readonly droppedRowCount: number;
  /** 被丢弃的书行：不是对象、维度不是 8、`dimensionValue` 不是 `1_<数字>`。 */
  readonly droppedBookRowCount: number;
  /** 同一日期同一 seriesKey 出现不止一次的多余行（只保留第一行）。 */
  readonly duplicateBookRowCount: number;
}

/** 逐层（对象 / 数组）做 `toRawPayload` 同样的处理：丢 undefined、遮蔽 token / 口令类键。 */
function toRawPayloadDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => toRawPayloadDeep(entry));
  if (!value || typeof value !== "object") return value;
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (child === undefined) continue;
    output[key] = REDACTED_RAW_KEYS.has(key.toLowerCase()) ? "[redacted]" : toRawPayloadDeep(child);
  }
  return output;
}

/** 按书口径的日期行 / 总计行：数值字段同 `baseFields`，`raw` 换成连同 `subItems` 的逐层遮蔽版本。 */
function baseFieldsDeep(row: Record<string, unknown>): ReturnType<typeof baseFields> {
  return { ...baseFields(row), raw: toRawPayloadDeep(row) as Record<string, unknown> };
}

/**
 * 解析按书口径的 `data.list`：总计行（`isTotal`）单独返回；日期行（日期合法）进 `dates`，其 `subItems`
 * 里维度 8、`dimensionValue` 为 `1_<seriesId>` 的书行进 `books`。日期行的 `subItems` 缺失或为空是合法的
 * （当天没有可归到书的数据）。
 */
export function parseNovelBookReportRows(list: readonly unknown[]): ParsedNovelBookReport {
  const dates: ParsedRevenueDay[] = [];
  const books: ParsedRevenueBookDay[] = [];
  const seen = new Set<string>();
  let total: ParsedRevenueTotal | null = null;
  let totalRowCount = 0;
  let droppedRowCount = 0;
  let droppedBookRowCount = 0;
  let duplicateBookRowCount = 0;

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
          ...baseFieldsDeep(row),
        };
      }
      continue;
    }

    const date = dimensionValueText ?? dimensionKeyText;
    if (!date || !isValidCalendarDate(date)) {
      droppedRowCount += 1;
      continue;
    }
    dates.push({
      date,
      dimensionKey: (dimensionKeyText ?? dimensionValueText ?? date).slice(0, 64),
      dimensionValue: dimensionValueText === null ? null : dimensionValueText.slice(0, 128),
      ...baseFieldsDeep(row),
    });

    const subItems = Array.isArray(row.subItems) ? row.subItems : [];
    for (const child of subItems) {
      if (!child || typeof child !== "object" || Array.isArray(child)) {
        droppedBookRowCount += 1;
        continue;
      }
      const bookRow = child as Record<string, unknown>;
      const seriesKey = text(bookRow.dimensionValue);
      const match = seriesKey === null ? null : BOOK_SERIES_KEY.exec(seriesKey);
      if (text(bookRow.dimension) !== BOOK_DIMENSION || !seriesKey || !match) {
        droppedBookRowCount += 1;
        continue;
      }
      const identity = `${date}|${seriesKey}`;
      if (seen.has(identity)) {
        duplicateBookRowCount += 1;
        continue;
      }
      seen.add(identity);
      books.push({
        date,
        seriesKey,
        seriesId: match[1]!,
        bookName: (text(bookRow.dimensionKey) ?? "").slice(0, BOOK_NAME_MAX_LENGTH),
        activeUsers: toIntegerOrNull(bookRow.realDevNum),
        newUsers: toIntegerOrNull(bookRow.newRealDevNum),
        newUserRatio: parseRatioFraction(bookRow.realDevNumRate),
        shareIncomeUsd: toAmountString(bookRow.realIncome),
      });
    }
  }

  return { dates, books, total, totalRowCount, droppedRowCount, droppedBookRowCount, duplicateBookRowCount };
}

/**
 * 按书对账（只作提示，不判失败）：每个有书行的日期，书行新用户合计 vs 日期行新用户、书行分成收入合计 vs
 * 日期行分成收入（容差 US$0.01）。上游没有承诺「全部收入都能归到书」，所以不一致只进批次备注，
 * 让运营知道按书合计 ≠ 当日合计。返回不一致的日期（升序）。
 */
export function reconcileBookBreakdown(
  dates: readonly Pick<ParsedRevenueDay, "date" | "newUsers" | "shareIncomeUsd">[],
  books: readonly Pick<ParsedRevenueBookDay, "date" | "newUsers" | "shareIncomeUsd">[],
  tolerance: string = REVENUE_RECONCILIATION_TOLERANCE,
): string[] {
  const sums = new Map<string, { newUsers: number; income: Decimal }>();
  for (const book of books) {
    const current = sums.get(book.date) ?? { newUsers: 0, income: new Decimal(0) };
    current.newUsers += book.newUsers ?? 0;
    if (book.shareIncomeUsd !== null) current.income = current.income.plus(book.shareIncomeUsd);
    sums.set(book.date, current);
  }
  const mismatched: string[] = [];
  for (const day of dates) {
    const sum = sums.get(day.date);
    if (!sum) continue;
    const incomeDiff = sum.income.minus(day.shareIncomeUsd ?? "0").abs();
    if (sum.newUsers !== (day.newUsers ?? 0) || incomeDiff.gt(tolerance)) mismatched.push(day.date);
  }
  return mismatched.sort();
}

// ── v0.6.2 新增用户国家（GetCountryReport）─────────────────────────────────────────────────

/** 上游国家名形如 `巴西(BR)`：中文国名 + 半角括号里的 ISO 3166-1 二字码。 */
const COUNTRY_LABEL = /^(.*?)\s*\(\s*([A-Za-z]{2})\s*\)\s*$/;
const COUNTRY_LABEL_MAX_LENGTH = 128;

export interface ParsedRevenueCountry {
  /** 上游 `name` 原文（截断到 128），作为国家行的身份。 */
  readonly label: string;
  /** 拆出的 ISO 二字码（大写）；上游名称不是 `名称(XX)` 形状时为 null。 */
  readonly code: string | null;
  /** 去掉二字码后的国名；拆不出时等于 label。 */
  readonly name: string;
  readonly newUsers: number;
}

export interface ParsedNovelCountryReport {
  readonly date: string;
  /** 上游 `data.total`（该日新用户总数）；缺失 / 无法解析为 null。 */
  readonly total: number | null;
  readonly countries: readonly ParsedRevenueCountry[];
  /** 国家行新用户合计。 */
  readonly countrySum: number;
  /** 被丢弃的行：不是对象、`name` 为空、`value` 不是非负整数。 */
  readonly droppedRowCount: number;
  /** 同名国家出现不止一次的多余行（数值并入第一行）。 */
  readonly duplicateRowCount: number;
  /** `data` 原样（防御性遮蔽 token / 口令类键），存档用。 */
  readonly raw: Readonly<Record<string, unknown>>;
}

export function parseNovelCountryReport(date: string, data: Readonly<Record<string, unknown>>): ParsedNovelCountryReport {
  const list = Array.isArray(data.list) ? data.list : [];
  const byLabel = new Map<string, { code: string | null; name: string; newUsers: number }>();
  let droppedRowCount = 0;
  let duplicateRowCount = 0;

  for (const entry of list) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      droppedRowCount += 1;
      continue;
    }
    const row = entry as Record<string, unknown>;
    const label = text(row.name)?.slice(0, COUNTRY_LABEL_MAX_LENGTH) ?? null;
    const value = toIntegerOrNull(row.value);
    if (!label || value === null || value < 0) {
      droppedRowCount += 1;
      continue;
    }
    const existing = byLabel.get(label);
    if (existing) {
      duplicateRowCount += 1;
      existing.newUsers += value;
      continue;
    }
    const match = COUNTRY_LABEL.exec(label);
    byLabel.set(label, {
      code: match ? match[2]!.toUpperCase() : null,
      name: match && match[1]!.trim() ? match[1]!.trim() : label,
      newUsers: value,
    });
  }

  const countries = [...byLabel.entries()].map(([label, value]) => ({ label, ...value }));
  return {
    date,
    total: toIntegerOrNull(data.total),
    countries,
    countrySum: countries.reduce((sum, country) => sum + country.newUsers, 0),
    droppedRowCount,
    duplicateRowCount,
    raw: toRawPayload(data as Record<string, unknown>),
  };
}
