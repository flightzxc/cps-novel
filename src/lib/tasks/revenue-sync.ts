/**
 * 收益同步任务 `changdu.revenue_sync.v1` 的参数、日期口径与幂等键——web（入队）与 worker（执行）
 * 共用的**单一真源**（账号级：上游 `GetReport` 返回该畅读账号下全部网文应用的合计，任务不属于某一个应用）。
 *
 * 为什么必须是单一真源（CPS `src/lib/changdu-total-revenue/task-params.ts` 的教训）：CPS 的另一条
 * 收益同步链路曾出现“创建端用 `JSON.stringify` 写 `{ sourceEndpoint, sourceReportType }`，消费端用裸
 * `JSON.parse` 读 `{ endpoint, reportType }`”的契约漂移——两个字段静默变成 `undefined`，每次真实
 * 运行都带着空值。这里的做法是：创建与消费**都只能**经 `serializeRevenueSyncTaskParams` /
 * `parseRevenueSyncTaskParams`，字段改名是一处改动、两侧同时生效；并且 parse 不信任任何上游调用方，
 * 每次都重新校验（日期格式、begin ≤ end、跨度 ≤ 92 天、end ≤ 上海时区今天、projectType 必须为 1）。
 *
 * 日期口径：一律是北京时间（Asia/Shanghai，UTC+8，无夏令时）日期，和上游 `dimensionValue` 一致。
 */
import { createHash } from "node:crypto";

import { NOVEL_REVENUE_PROJECT_TYPE } from "../adapters/moboreader-revenue-constants";
import { isValidCalendarDate } from "../adapters/moboreader-revenue-parser";

/**
 * 收益同步任务类型（**唯一定义点**；`src/lib/tasks/worker-lanes.mjs` 是无依赖的部署侧策略文件，
 * 不能 import 本文件，所以那里手抄了同一个字符串，由 `tests/backend/revenue/revenue-sync-worker-lane.test.ts` 对拍）。
 *
 * 命名为 `changdu.`（而不是 `moboreader.`）的原因：上游 `GetReport` 是**畅读账号级**的——同一账号同一
 * `projectType` 下所有网文应用合计，响应里没有应用字段。这个任务属于畅读渠道账号，不属于 MoboReader 这一个
 * 应用；以后同一账号下再增加别的网文应用时，`moboreader.` 前缀会误导，而且一旦进了生产白名单再改名就要动生产 env。
 * 只调用上游、不设定时任务，所以只能进主通道白名单（见 `worker-lanes.mjs` 的 `MOBOREADER_UPSTREAM_TASK_TYPES`）。
 */
export const REVENUE_SYNC_TASK_TYPE = "changdu.revenue_sync.v1";
/** `generic_task_item.target_type`：一个收益同步任务只有一个条目。 */
export const REVENUE_SYNC_TARGET_TYPE = "revenue_sync";
export const REVENUE_SYNC_AUDIT_ACTION_QUEUED = "revenue.sync.queued";
export const REVENUE_SYNC_AUDIT_ACTION_COMPLETED = "revenue.sync.completed";
export const REVENUE_SYNC_AUDIT_ACTION_FAILED = "revenue.sync.failed";
/** 单次同步最多覆盖的天数（含首尾）。 */
export const REVENUE_SYNC_MAX_SPAN_DAYS = 92;
export const REVENUE_SYNC_REQUESTED_BY_MAX_LENGTH = 128;
export const REVENUE_SYNC_REQUEST_TOKEN_MAX_LENGTH = 160;

const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type RevenueSyncParamsErrorCode = "invalid_date_range" | "invalid_params";

export class RevenueSyncParamsError extends Error {
  constructor(
    readonly code: RevenueSyncParamsErrorCode,
    /** 出问题的字段或规则名（不含任何取值）。 */
    readonly reason: string,
  ) {
    super(`revenue_sync_params_invalid: ${code}: ${reason}`);
    this.name = "RevenueSyncParamsError";
  }
}

export interface RevenueSyncTaskParams {
  readonly channelAccountId: string;
  /** 恒为 1（网文）。放进参数里只是为了让任务行自描述、让 parse 能拒绝篡改。 */
  readonly projectType: typeof NOVEL_REVENUE_PROJECT_TYPE;
  readonly beginDate: string;
  readonly endDate: string;
  readonly requestedBy: string;
}

/** 上海时区的“今天”（YYYY-MM-DD）。 */
export function shanghaiToday(now: Date = new Date()): string {
  return new Date(now.getTime() + SHANGHAI_OFFSET_MS).toISOString().slice(0, 10);
}

/** YYYY-MM-DD 加减天数（纯日历运算，不涉及时区）。 */
export function addDaysToDate(date: string, days: number): string {
  if (!isValidCalendarDate(date)) throw new RevenueSyncParamsError("invalid_date_range", "date_format");
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, day) + days * DAY_MS).toISOString().slice(0, 10);
}

/** 区间覆盖的天数（含首尾）。两端必须是合法日期。 */
export function inclusiveDaySpan(beginDate: string, endDate: string): number {
  const [by, bm, bd] = beginDate.split("-").map(Number) as [number, number, number];
  const [ey, em, ed] = endDate.split("-").map(Number) as [number, number, number];
  return Math.round((Date.UTC(ey, em - 1, ed) - Date.UTC(by, bm - 1, bd)) / DAY_MS) + 1;
}

/**
 * 区间校验（入队与 parse 共用）：两端是真实存在的 YYYY-MM-DD、begin ≤ end、跨度 ≤ 92 天、
 * end 不晚于上海时区的今天。失败抛 `RevenueSyncParamsError("invalid_date_range", reason)`。
 */
export function assertValidRevenueSyncRange(beginDate: unknown, endDate: unknown, now: Date = new Date()): void {
  if (typeof beginDate !== "string" || typeof endDate !== "string" || !isValidCalendarDate(beginDate) || !isValidCalendarDate(endDate)) {
    throw new RevenueSyncParamsError("invalid_date_range", "date_format");
  }
  if (beginDate > endDate) throw new RevenueSyncParamsError("invalid_date_range", "begin_after_end");
  if (inclusiveDaySpan(beginDate, endDate) > REVENUE_SYNC_MAX_SPAN_DAYS) {
    throw new RevenueSyncParamsError("invalid_date_range", "span_exceeded");
  }
  if (endDate > shanghaiToday(now)) throw new RevenueSyncParamsError("invalid_date_range", "end_in_future");
}

function validateShape(value: unknown, now: Date): RevenueSyncTaskParams {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RevenueSyncParamsError("invalid_params", "shape");
  }
  const candidate = value as Record<string, unknown>;
  const { channelAccountId, projectType, beginDate, endDate, requestedBy } = candidate;
  if (typeof channelAccountId !== "string" || !UUID_PATTERN.test(channelAccountId)) {
    throw new RevenueSyncParamsError("invalid_params", "channelAccountId");
  }
  if (projectType !== NOVEL_REVENUE_PROJECT_TYPE) {
    throw new RevenueSyncParamsError("invalid_params", "projectType");
  }
  if (typeof requestedBy !== "string" || !requestedBy.trim() || requestedBy.length > REVENUE_SYNC_REQUESTED_BY_MAX_LENGTH) {
    throw new RevenueSyncParamsError("invalid_params", "requestedBy");
  }
  assertValidRevenueSyncRange(beginDate, endDate, now);
  return {
    channelAccountId: channelAccountId.toLowerCase(),
    projectType: NOVEL_REVENUE_PROJECT_TYPE,
    beginDate: beginDate as string,
    endDate: endDate as string,
    requestedBy: requestedBy.trim(),
  };
}

/**
 * 序列化任务参数（写入 `generic_task.params` 与唯一条目的 `payload`，两处同一个对象）。
 * 先校验再写，所以畸形参数永远写不进去；入参里的 `projectType` 即使缺省也会被固定为 1——
 * 调用方不需要、也不能指定别的值。
 */
export function serializeRevenueSyncTaskParams(
  input: Omit<RevenueSyncTaskParams, "projectType"> & { projectType?: unknown },
  now: Date = new Date(),
): RevenueSyncTaskParams {
  return validateShape({ ...input, projectType: input.projectType === undefined ? NOVEL_REVENUE_PROJECT_TYPE : input.projectType }, now);
}

/** 解析任务参数（`lease.payload` / `generic_task.params`）。每次都重新校验，不信任存量数据。 */
export function parseRevenueSyncTaskParams(value: unknown, now: Date = new Date()): RevenueSyncTaskParams {
  return validateShape(value, now);
}

function digest(parts: readonly (string | number)[]): string {
  return createHash("sha256").update(parts.join("|")).digest("hex");
}

/**
 * `generic_task.operation_scope_hash`：revenue_sync 的作用域哈希，**把 `projectType` 折进去**（照
 * `catalog_scan` 的做法，见 `src/lib/tasks/moboreader.ts` 的 `catalogScanOperationScopeHash`）。
 *
 * 收益同步是账号级任务，`generic_task.channel_app_id` 写 NULL（不属于某一个应用）。
 * `generic_task_active_scope_uidx`（task_type + channel_account_id + channel_app_id + 此哈希，仅
 * pending/processing）是 `NULLS NOT DISTINCT`，所以 channel_app_id 为 NULL 时仍然成立“同一账号同一
 * `projectType` 同一时刻只有一个活跃的收益同步任务”；`projectType` 在哈希里，将来同账号接别的业务线
 * （如短剧 projectType）的同类任务时互不挤占。
 */
export function revenueSyncOperationScopeHash(projectType: number = NOVEL_REVENUE_PROJECT_TYPE): string {
  return createHash("sha256")
    .update(JSON.stringify({ scope: "revenue_sync", projectType }))
    .digest("hex");
}

/**
 * `revenue_sync_batch.request_fingerprint` = sha256(scopeId|projectType|begin|end|genericTaskId)：
 * 同一任务重试幂等（worker 对它 upsert）；不同任务重拉同一区间指纹不同——允许，上游会回补近几天。
 */
export function revenueBatchFingerprint(input: {
  scopeId: string;
  projectType: number;
  beginDate: string;
  endDate: string;
  genericTaskId: string;
}): string {
  return digest([input.scopeId, input.projectType, input.beginDate, input.endDate, input.genericTaskId]);
}

/**
 * `revenue_raw_snapshot.dedupe_key`：明细行 = sha256(scopeId|projectType|dimension|<日期>|detail)；
 * 总计行 = sha256(scopeId|projectType|dimension|<dimensionKey>|total:<begin>~<end>)。
 *
 * 明细行的身份取**解析出的日期**，而不是上游的 `dimensionKey` 原文：两者在已实证的形态里相同，
 * 但如果上游哪天把 `dimensionKey` 换成与日期无关的值（例如维度编号），按它去重会把整个区间塌缩成一行。
 */
export function revenueRawDedupeKey(input:
  | { kind: "detail"; scopeId: string; projectType: number; dimension: string; date: string }
  | { kind: "total"; scopeId: string; projectType: number; dimension: string; dimensionKey: string; beginDate: string; endDate: string }): string {
  if (input.kind === "detail") {
    return digest([input.scopeId, input.projectType, input.dimension, input.date, "detail"]);
  }
  return digest([input.scopeId, input.projectType, input.dimension, input.dimensionKey, `total:${input.beginDate}~${input.endDate}`]);
}
