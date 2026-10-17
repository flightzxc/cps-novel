/**
 * 畅读收益接口适配器：`POST https://kocserver-cn.cdreader.com/api/Report/GetReport`，
 * 取海阅（网文，projectType=1）账号级每日汇总。
 *
 * 文件名里的 `moboreader-` 指 kocserver 上游适配器家族（与 `moboreader-rate-limit` 等同族），不代表只覆盖
 * MoboReader 这一个应用：**接口是账号级的，覆盖该畅读账号下全部网文应用**（响应里没有应用字段）。以后同一账号
 * 下增加别的网文应用时，这里取到的就是它们的合计——按应用拆分的前提见 `src/server/revenue/account.ts` 文件头
 * 的“多剧场扩展路径”。
 *
 * ── 为什么所有请求必须固定带 projectType=1 ──────────────────────────────────
 * 海阅与 CPS 短剧共用同一个畅读上游账号。上游靠请求体里的 `projectType` 区分网文(1)/短剧(2)，
 * **不带 projectType 时返回两者合计**（已在生产只读实测证实）。所以请求体由
 * `buildNovelGetReportBody` 无条件写入 `projectType: 1`，本模块不接受外部传入 projectType——
 * 没有任何入口能发出一个不带（或带别的）projectType 的请求。
 *
 * ── 合同（已实证，照此实现，不要猜别的字段）────────────────────────────────
 * 请求：Bearer = 渠道账号当前 active 凭证明文；headers 只有 `authorization` 与 `content-type`
 * （与 `./moboreader.ts` 的读接口一致）；`redirect: "error"`。
 *   { beginTime, endTime, dimensions: ["1"], pageIndex, pageSize: 999, projectType: 1 }
 * 响应信封：`{ status: true, code: 200, message, data: { headers: [...], list: [...] } }`。
 *   - `status === false` 或 `code` 存在且 ≠ 200 → `upstream_envelope_error`；
 *   - `data.list` 不是数组（含 `data` 缺失 / 为 null）→ `upstream_envelope_error`。宁可让一次异常的
 *     响应显式失败，也不把它当成“空区间”写出一批静默的 0；
 *   - 上游**不返回没有活动的日期**（不是返回 0 行）；空列表是合法结果，由调用方记为 completed；
 *   - 分页：响应没有 totalCount，按“本页明细行数（不含总计行）< pageSize 即停止”循环，
 *     最多 10 页，超限 `upstream_page_limit_exceeded`；页与页之间严格串行，不并发。
 *
 * ── 错误码（稳定）─────────────────────────────────────────────────────────
 *   upstream_http_error / upstream_rate_limited(HTTP 429) / upstream_envelope_error /
 *   upstream_page_limit_exceeded / transport_error（网络 / 超时 / 取消 / 重定向 / 非 JSON），
 *   外加本地参数校验失败的 invalid_request。
 *   **错误信息里绝不带 token**：message 只由错误码与 HTTP 状态拼成；detail 里的上游文本先经
 *   `scrubSecretText`（遮蔽传入的 token 本身、Bearer、JWT 形状），再截断。
 *
 * 复用 `./moboreader-rate-limit` 的限速闸（`rateGate`，默认 no-op，生产接入共享单例）与
 * `./upstream-observation` 的观测事件（endpoint 记为 "getreport"，事件里没有 token / body）。
 *
 * ── v0.6.2 按书与国家（10-17 主控在生产 worker 内只读实测，合同照此实现）─────────────────
 *   - 按书：同一个 `GetReport`，`breakdown: "book"` → 维度 `["1","8"]`。顶层仍是总计行 + 日期行，
 *     书行在日期行的 `subItems` 里（dimension 8，dimensionKey=书名原文，dimensionValue="1_<seriesId>"）。
 *   - 国家：`POST /api/Report/GetCountryReport`，对某一个日期行下钻（`fetchNovelCountryReport`），
 *     `reportType` 取 `active_users`（countryReportType=0）或 `new_users`（=1），
 *     响应 `data: { total, list: [{ name: "巴西(BR)", value }] }`。观测名 "getcountryreport"。
 *   - 口令维度（7）永远不取，见 `./moboreader-revenue-constants` 的说明。
 */
import { NOOP_MOBOREADER_RATE_GATE, type MoboreaderRateGate } from "./moboreader-rate-limit";
import {
  NOOP_UPSTREAM_OBSERVATION,
  NO_GATEWAY_OBSERVATION_HEADERS,
  extractGatewayObservationHeaders,
  safeObserve,
  type OnUpstreamObservation,
} from "./upstream-observation";
import { isTruthyTotalRow, isValidCalendarDate } from "./moboreader-revenue-parser";
import {
  NOVEL_REVENUE_BOOK_DIMENSIONS,
  NOVEL_REVENUE_COUNTRY_ENDPOINT,
  NOVEL_REVENUE_COUNTRY_REPORT_PATH,
  NOVEL_REVENUE_COUNTRY_REPORT_TYPE_ACTIVE_USERS,
  NOVEL_REVENUE_COUNTRY_REPORT_TYPE_NEW_USERS,
  NOVEL_REVENUE_DIMENSION_DATE,
  NOVEL_REVENUE_DIMENSIONS,
  NOVEL_REVENUE_ENDPOINT,
  NOVEL_REVENUE_MAX_PAGES,
  NOVEL_REVENUE_ORIGIN,
  NOVEL_REVENUE_PAGE_SIZE,
  NOVEL_REVENUE_PROJECT_TYPE,
  NOVEL_REVENUE_REPORT_PATH,
} from "./moboreader-revenue-constants";

export {
  NOVEL_REVENUE_BOOK_DIMENSIONS,
  NOVEL_REVENUE_COUNTRY_ENDPOINT,
  NOVEL_REVENUE_COUNTRY_REPORT_PATH,
  NOVEL_REVENUE_COUNTRY_REPORT_TYPE_ACTIVE_USERS,
  NOVEL_REVENUE_COUNTRY_REPORT_TYPE_NEW_USERS,
  NOVEL_REVENUE_DIMENSIONS,
  NOVEL_REVENUE_ENDPOINT,
  NOVEL_REVENUE_MAX_PAGES,
  NOVEL_REVENUE_ORIGIN,
  NOVEL_REVENUE_PAGE_SIZE,
  NOVEL_REVENUE_PROJECT_TYPE,
  NOVEL_REVENUE_REPORT_PATH,
};
export const NOVEL_REVENUE_DEFAULT_TIMEOUT_MS = 30_000;
/** 观测事件里使用的短逻辑名（不是完整 URL）。按日与按书两种维度走的是同一个上游端点，共用这个名字与限速队列。 */
export const NOVEL_REVENUE_OBSERVATION_ENDPOINT = "getreport";
/** v0.6.2：国家下钻端点的观测名。限速闸对它没有单独调参，与其它未单列的端点共用主机级间隔。 */
export const NOVEL_REVENUE_COUNTRY_OBSERVATION_ENDPOINT = "getcountryreport";

/**
 * 日报的拆分口径：`date` = 按日（维度 ["1"]，账号级，v0.5.11 起的原有请求）；`book` = 按日再按书
 * （维度 ["1","8"]，v0.6.2）。只接受这两个名字，不接受任意维度数组——维度 7（口令）因此无从拼出。
 */
export type NovelReportBreakdown = "date" | "book";

function dimensionsFor(breakdown: NovelReportBreakdown): NovelGetReportBody["dimensions"] {
  if (breakdown === "date") return NOVEL_REVENUE_DIMENSIONS;
  if (breakdown === "book") return NOVEL_REVENUE_BOOK_DIMENSIONS;
  throw new NovelRevenueAdapterError("invalid_request", null, "breakdown_invalid");
}

const DETAIL_MAX_LENGTH = 160;

export type NovelRevenueAdapterErrorCode =
  | "upstream_http_error"
  | "upstream_rate_limited"
  | "upstream_envelope_error"
  | "upstream_page_limit_exceeded"
  | "transport_error"
  | "invalid_request";

export class NovelRevenueAdapterError extends Error {
  /** 失败前已向上游发起的请求数（`fetchNovelDailyReport` 在抛出前补上；本地参数校验失败为 0）。 */
  requestCount = 0;

  constructor(
    readonly code: NovelRevenueAdapterErrorCode,
    readonly status: number | null = null,
    /** 已脱敏、已截断的诊断文本；绝不含 token。 */
    readonly detail: string | null = null,
  ) {
    super(`Novel revenue report failed: ${code}${status === null ? "" : ` (${status})`}${detail ? ` — ${detail}` : ""}`);
    this.name = "NovelRevenueAdapterError";
  }
}

/**
 * 从任何将进入错误信息 / 日志的文本里去掉凭证：传入的 token 本身、`Bearer xxx`、JWT 形状。
 * 纯函数，导出供测试直接断言。
 */
export function scrubSecretText(text: string, token?: string): string {
  let scrubbed = text;
  const secret = token?.trim();
  if (secret) scrubbed = scrubbed.split(secret).join("[redacted]");
  return scrubbed
    .replace(/\bbearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g, "[redacted]");
}

function boundedDetail(text: string, token: string): string {
  return scrubSecretText(text, token).replace(/\s+/g, " ").trim().slice(0, DETAIL_MAX_LENGTH);
}

/**
 * 只放行 `https://kocserver-cn.cdreader.com` 下的两个路径：`/api/Report/GetReport` 与（v0.6.2）
 * `/api/Report/GetCountryReport`。协议、主机、端口、路径逐一精确比较，不允许 query / hash / 凭证。
 * 思路来自 CPS `assertAllowedTotalRevenueEndpoint`，这里收窄为这两个端点。
 */
export function assertAllowedNovelRevenueEndpoint(endpoint: string): void {
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new NovelRevenueAdapterError("invalid_request", null, "endpoint_invalid");
  }
  if (parsed.origin !== NOVEL_REVENUE_ORIGIN || parsed.username || parsed.password) {
    throw new NovelRevenueAdapterError("invalid_request", null, "endpoint_origin_not_allowed");
  }
  if (parsed.search || parsed.hash) {
    throw new NovelRevenueAdapterError("invalid_request", null, "endpoint_query_not_allowed");
  }
  if (parsed.pathname !== NOVEL_REVENUE_REPORT_PATH && parsed.pathname !== NOVEL_REVENUE_COUNTRY_REPORT_PATH) {
    throw new NovelRevenueAdapterError("invalid_request", null, "endpoint_path_not_allowed");
  }
}

export interface NovelGetReportBody {
  readonly beginTime: string;
  readonly endTime: string;
  readonly dimensions: readonly ["1"] | readonly ["1", "8"];
  readonly pageIndex: number;
  readonly pageSize: 999;
  readonly projectType: 1;
}

/**
 * 唯一的请求体构造点：`projectType: 1`、`pageSize: 999` 无条件写入，维度只能是 `breakdown`
 * 对应的两组冻结值之一（缺省 = 按日 `["1"]`）；入参里没有 projectType，也没有任意维度数组——无从传错。
 */
export function buildNovelGetReportBody(input: {
  beginDate: string;
  endDate: string;
  pageIndex: number;
  breakdown?: NovelReportBreakdown;
}): NovelGetReportBody {
  const dimensions = dimensionsFor(input.breakdown ?? "date");
  if (!isValidCalendarDate(input.beginDate) || !isValidCalendarDate(input.endDate)) {
    throw new NovelRevenueAdapterError("invalid_request", null, "date_invalid");
  }
  if (input.beginDate > input.endDate) {
    throw new NovelRevenueAdapterError("invalid_request", null, "date_range_invalid");
  }
  if (!Number.isSafeInteger(input.pageIndex) || input.pageIndex < 1) {
    throw new NovelRevenueAdapterError("invalid_request", null, "page_index_invalid");
  }
  return {
    beginTime: input.beginDate,
    endTime: input.endDate,
    dimensions,
    pageIndex: input.pageIndex,
    pageSize: NOVEL_REVENUE_PAGE_SIZE,
    projectType: NOVEL_REVENUE_PROJECT_TYPE,
  };
}

/** 校验响应信封并取出 `data.list`；任何不符都是 `upstream_envelope_error`。 */
export function extractNovelReportList(json: unknown, token: string): unknown[] {
  if (!json || typeof json !== "object" || Array.isArray(json)) {
    throw new NovelRevenueAdapterError("upstream_envelope_error", null, "response_not_object");
  }
  const envelope = json as Record<string, unknown>;
  const code = envelope.code;
  const codeNumber = typeof code === "number" ? code : typeof code === "string" && code.trim() ? Number(code) : null;
  if (envelope.status === false || (codeNumber !== null && codeNumber !== 200)) {
    const message = typeof envelope.message === "string" ? ` ${boundedDetail(envelope.message, token)}` : "";
    throw new NovelRevenueAdapterError(
      "upstream_envelope_error",
      null,
      `business_error code=${codeNumber === null ? "unknown" : String(codeNumber)}${message}`,
    );
  }
  const data = envelope.data;
  if (!data || typeof data !== "object" || Array.isArray(data) || !Array.isArray((data as Record<string, unknown>).list)) {
    throw new NovelRevenueAdapterError("upstream_envelope_error", null, "data_list_missing");
  }
  return (data as { list: unknown[] }).list;
}

export interface FetchNovelDailyReportInput {
  /** 渠道账号当前 active 凭证明文（JWT）。永远不进日志 / 错误 / 返回值。 */
  readonly token: string;
  readonly beginDate: string;
  readonly endDate: string;
  /** 缺省 `date`（账号级按日）；`book` = 按日再按书（v0.6.2）。 */
  readonly breakdown?: NovelReportBreakdown;
  readonly fetchImpl?: typeof fetch;
  readonly signal?: AbortSignal;
  /** 每次请求的超时（默认 30s）。 */
  readonly timeoutMs?: number;
  /** 默认 no-op；生产接入 `moboreaderUpstreamRateGate`（与其它 MoboReader 接口共用主机级间隔）。 */
  readonly rateGate?: MoboreaderRateGate;
  readonly onUpstreamObservation?: OnUpstreamObservation;
  /** 仅用于观测事件的耗时计时，不参与任何限速 / 重试决策。 */
  readonly now?: () => number;
}

export interface NovelDailyReport {
  /** 全部页的 `data.list` 原样拼接（明细行 + 总计行），交给解析器。 */
  readonly rows: readonly unknown[];
  /** 实际向上游发起的请求数（= 取了多少页）。 */
  readonly requestCount: number;
}

function countDetailRows(list: readonly unknown[]): number {
  let count = 0;
  for (const entry of list) {
    if (entry && typeof entry === "object" && !Array.isArray(entry) && isTruthyTotalRow((entry as Record<string, unknown>).isTotal)) continue;
    count += 1;
  }
  return count;
}

/**
 * 取 [beginDate, endDate] 的账号级每日汇总。分页串行、最多 10 页；没有重试——任务是后台手动触发、
 * `maxAttempts: 1`，失败直接作为批次失败原因呈现给运营，由人决定是否重来。
 */
export async function fetchNovelDailyReport(input: FetchNovelDailyReportInput): Promise<NovelDailyReport> {
  assertAllowedNovelRevenueEndpoint(NOVEL_REVENUE_ENDPOINT);
  const token = input.token?.trim();
  if (!token) throw new NovelRevenueAdapterError("invalid_request", null, "credential_required");
  // 先把请求体全部校验一遍，再发任何请求。
  buildNovelGetReportBody({ beginDate: input.beginDate, endDate: input.endDate, pageIndex: 1, breakdown: input.breakdown });
  const timeoutMs = input.timeoutMs ?? NOVEL_REVENUE_DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1) {
    throw new NovelRevenueAdapterError("invalid_request", null, "timeout_invalid");
  }

  const progress = { requestCount: 0 };
  try {
    return await fetchAllPages(input, token, timeoutMs, progress);
  } catch (error) {
    // 失败也要告诉调用方“已经向上游发了几次请求”（批次行的 request_count）。
    if (error instanceof NovelRevenueAdapterError) error.requestCount = progress.requestCount;
    throw error;
  }
}

interface UpstreamCallContext {
  readonly token: string;
  readonly timeoutMs: number;
  readonly fetchImpl: typeof fetch;
  readonly rateGate: MoboreaderRateGate;
  readonly onUpstreamObservation: OnUpstreamObservation;
  readonly now: () => number;
  readonly signal?: AbortSignal;
  readonly progress: { requestCount: number };
}

function upstreamCallContext(
  input: Pick<FetchNovelDailyReportInput, "fetchImpl" | "rateGate" | "onUpstreamObservation" | "now" | "signal">,
  token: string,
  timeoutMs: number,
  progress: { requestCount: number },
): UpstreamCallContext {
  return {
    token,
    timeoutMs,
    fetchImpl: input.fetchImpl ?? fetch,
    rateGate: input.rateGate ?? NOOP_MOBOREADER_RATE_GATE,
    onUpstreamObservation: input.onUpstreamObservation ?? NOOP_UPSTREAM_OBSERVATION,
    now: input.now ?? Date.now,
    signal: input.signal,
    progress,
  };
}

/**
 * 发一次 POST 并取回 JSON（限速闸 → 计数 → 请求 → 观测 → HTTP 状态 → 解析 JSON）。
 * 按日 / 按书的分页请求与国家下钻共用这一段，行为与 v0.5.11 的单端点实现逐步一致。
 */
async function postOnce(
  context: UpstreamCallContext,
  target: { readonly url: string; readonly observationEndpoint: string },
  body: unknown,
): Promise<unknown> {
  const { rateGate, onUpstreamObservation, token } = context;
  const observationNow = context.now;
  const endpoint = target.observationEndpoint;

  const gateWaitStartedAt = observationNow();
  const gateWaitInfo = await rateGate.wait(endpoint);
  const gateWaitMs = observationNow() - gateWaitStartedAt;
  const endpointGateWaitMs = gateWaitInfo ? gateWaitInfo.endpointGateWaitMs : null;
  const hostGateWaitMs = gateWaitInfo ? gateWaitInfo.hostGateWaitMs : null;
  const remainingBeforeDispatch = gateWaitInfo ? gateWaitInfo.remainingBeforeDispatch : null;
  // 限速闸可能让出几十秒；等完发现调用方已取消，就不要再发请求。
  if (context.signal?.aborted) throw new NovelRevenueAdapterError("transport_error", null, "aborted");

  const timeoutSignal = AbortSignal.timeout(context.timeoutMs);
  const signal = context.signal ? AbortSignal.any([context.signal, timeoutSignal]) : timeoutSignal;
  const dispatchStartedAt = observationNow();
  context.progress.requestCount += 1;

  let response: Response;
  try {
    response = await context.fetchImpl(target.url, {
      method: "POST",
      redirect: "error",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
  } catch (error) {
    const timedOut = timeoutSignal.aborted && !context.signal?.aborted;
    safeObserve(onUpstreamObservation, () => ({
      endpoint,
      httpStatus: null,
      outcome: timedOut ? "timeout" : "transport_error",
      latencyMs: observationNow() - dispatchStartedAt,
      gateWaitMs,
      endpointGateWaitMs,
      hostGateWaitMs,
      remainingBeforeDispatch,
      gatewayHeaders: NO_GATEWAY_OBSERVATION_HEADERS,
    }));
    // 底层错误（fetch failed / redirect / abort）可能带 URL 或 cause，一律不透传其 message。
    const reason = context.signal?.aborted ? "aborted" : timedOut ? "timeout" : error instanceof Error ? boundedDetail(error.name, token) : "unknown";
    throw new NovelRevenueAdapterError("transport_error", null, reason);
  }

  const gatewayHeaders = extractGatewayObservationHeaders(response.headers);
  rateGate.observe?.(endpoint, { httpStatus: response.status, gatewayHeaders });
  const observe = (outcome: "ok" | "http_error") =>
    safeObserve(onUpstreamObservation, () => ({
      endpoint,
      httpStatus: response.status,
      outcome,
      latencyMs: observationNow() - dispatchStartedAt,
      gateWaitMs,
      endpointGateWaitMs,
      hostGateWaitMs,
      remainingBeforeDispatch,
      gatewayHeaders,
    }));

  if (!response.ok) {
    observe("http_error");
    if (response.status === 429) throw new NovelRevenueAdapterError("upstream_rate_limited", 429);
    throw new NovelRevenueAdapterError("upstream_http_error", response.status);
  }

  // 2xx 就是线路层面的 ok（响应体能不能解析是下一步的事，见 UpstreamCallOutcome 的说明）。
  observe("ok");
  try {
    return await response.json();
  } catch {
    throw new NovelRevenueAdapterError("transport_error", response.status, "response_not_json");
  }
}

async function fetchAllPages(
  input: FetchNovelDailyReportInput,
  token: string,
  timeoutMs: number,
  progress: { requestCount: number },
): Promise<NovelDailyReport> {
  const context = upstreamCallContext(input, token, timeoutMs, progress);
  const target = { url: NOVEL_REVENUE_ENDPOINT, observationEndpoint: NOVEL_REVENUE_OBSERVATION_ENDPOINT };
  const rows: unknown[] = [];

  for (let pageIndex = 1; pageIndex <= NOVEL_REVENUE_MAX_PAGES; pageIndex += 1) {
    const body = buildNovelGetReportBody({ beginDate: input.beginDate, endDate: input.endDate, pageIndex, breakdown: input.breakdown });
    const json = await postOnce(context, target, body);
    const list = extractNovelReportList(json, token);
    rows.push(...list);
    // 按书口径时顶层是日期行（书在日期行的 subItems 里），分页按顶层行数判断，与按日口径同一规则。
    if (countDetailRows(list) < NOVEL_REVENUE_PAGE_SIZE) {
      return { rows, requestCount: progress.requestCount };
    }
  }

  throw new NovelRevenueAdapterError(
    "upstream_page_limit_exceeded",
    null,
    `more than ${NOVEL_REVENUE_MAX_PAGES} pages of ${NOVEL_REVENUE_PAGE_SIZE} rows`,
  );
}

// ── v0.6.2：国家分布（GetCountryReport，对某一个日期行下钻；新用户 / 激活两种口径）────────────

/** 国家下钻口径：`new_users` → countryReportType 1；`active_users` → 0。收入（2）不取，没有入口。 */
export type NovelCountryReportType = "new_users" | "active_users";

function countryReportTypeCode(reportType: NovelCountryReportType): 0 | 1 {
  if (reportType === "new_users") return NOVEL_REVENUE_COUNTRY_REPORT_TYPE_NEW_USERS;
  if (reportType === "active_users") return NOVEL_REVENUE_COUNTRY_REPORT_TYPE_ACTIVE_USERS;
  throw new NovelRevenueAdapterError("invalid_request", null, "country_report_type_invalid");
}

export interface NovelCountryReportBody {
  readonly beginTime: string;
  readonly endTime: string;
  readonly dimensions: readonly ["1"];
  readonly pageIndex: 1;
  readonly pageSize: 999;
  readonly projectType: 1;
  readonly countryReportType: 0 | 1;
  readonly list: readonly [{ readonly dimension: 1; readonly dimensionValue: string }];
}

/**
 * 国家下钻的唯一请求体构造点：日报同一套筛选（`beginTime = endTime = 该日`、`dimensions: ["1"]`、
 * `projectType: 1`），再加 `countryReportType`（0 激活 / 1 新用户）与该日期行的维度路径。
 * 只能按「日期行」下钻：总计行（dimension 0）上游返回空列表，按书 / 口令的下钻本期不做。
 */
export function buildNovelCountryReportBody(input: { date: string; reportType: NovelCountryReportType }): NovelCountryReportBody {
  if (!isValidCalendarDate(input.date)) {
    throw new NovelRevenueAdapterError("invalid_request", null, "date_invalid");
  }
  return {
    beginTime: input.date,
    endTime: input.date,
    dimensions: NOVEL_REVENUE_DIMENSIONS,
    pageIndex: 1,
    pageSize: NOVEL_REVENUE_PAGE_SIZE,
    projectType: NOVEL_REVENUE_PROJECT_TYPE,
    countryReportType: countryReportTypeCode(input.reportType),
    list: [{ dimension: Number(NOVEL_REVENUE_DIMENSION_DATE) as 1, dimensionValue: input.date }],
  };
}

/**
 * 校验国家下钻的响应信封：`{ status, code, message, data: { total, list: [{ name, value }] } }`。
 * 业务失败 / `data.list` 不是数组 → `upstream_envelope_error`；`data` 原样返回交给解析器。
 */
export function extractNovelCountryReportData(json: unknown, token: string): Record<string, unknown> {
  // 信封规则与日报相同（status=false 或 code≠200 即业务失败），复用同一段校验。
  extractNovelReportList(json, token);
  return (json as { data: Record<string, unknown> }).data;
}

export interface FetchNovelCountryReportInput
  extends Pick<FetchNovelDailyReportInput, "token" | "fetchImpl" | "signal" | "timeoutMs" | "rateGate" | "onUpstreamObservation" | "now"> {
  /** 要下钻的日期行（北京时间 YYYY-MM-DD）。 */
  readonly date: string;
  readonly reportType: NovelCountryReportType;
}

export interface NovelCountryReport {
  readonly date: string;
  readonly reportType: NovelCountryReportType;
  /** 上游 `data` 原样（`total` + `list`），交给解析器。 */
  readonly data: Readonly<Record<string, unknown>>;
  readonly requestCount: number;
}

/** 取某一天的国家分布（新用户或激活）。单次请求、没有重试（同 `fetchNovelDailyReport`）。 */
export async function fetchNovelCountryReport(input: FetchNovelCountryReportInput): Promise<NovelCountryReport> {
  assertAllowedNovelRevenueEndpoint(NOVEL_REVENUE_COUNTRY_ENDPOINT);
  const token = input.token?.trim();
  if (!token) throw new NovelRevenueAdapterError("invalid_request", null, "credential_required");
  const body = buildNovelCountryReportBody({ date: input.date, reportType: input.reportType });
  const timeoutMs = input.timeoutMs ?? NOVEL_REVENUE_DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1) {
    throw new NovelRevenueAdapterError("invalid_request", null, "timeout_invalid");
  }

  const progress = { requestCount: 0 };
  try {
    const context = upstreamCallContext(input, token, timeoutMs, progress);
    const json = await postOnce(
      context,
      { url: NOVEL_REVENUE_COUNTRY_ENDPOINT, observationEndpoint: NOVEL_REVENUE_COUNTRY_OBSERVATION_ENDPOINT },
      body,
    );
    return { date: input.date, reportType: input.reportType, data: extractNovelCountryReportData(json, token), requestCount: progress.requestCount };
  } catch (error) {
    if (error instanceof NovelRevenueAdapterError) error.requestCount = progress.requestCount;
    throw error;
  }
}
