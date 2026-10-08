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
  NOVEL_REVENUE_DIMENSIONS,
  NOVEL_REVENUE_ENDPOINT,
  NOVEL_REVENUE_MAX_PAGES,
  NOVEL_REVENUE_ORIGIN,
  NOVEL_REVENUE_PAGE_SIZE,
  NOVEL_REVENUE_PROJECT_TYPE,
  NOVEL_REVENUE_REPORT_PATH,
} from "./moboreader-revenue-constants";

export {
  NOVEL_REVENUE_DIMENSIONS,
  NOVEL_REVENUE_ENDPOINT,
  NOVEL_REVENUE_MAX_PAGES,
  NOVEL_REVENUE_ORIGIN,
  NOVEL_REVENUE_PAGE_SIZE,
  NOVEL_REVENUE_PROJECT_TYPE,
  NOVEL_REVENUE_REPORT_PATH,
};
export const NOVEL_REVENUE_DEFAULT_TIMEOUT_MS = 30_000;
/** 观测事件里使用的短逻辑名（不是完整 URL）。 */
export const NOVEL_REVENUE_OBSERVATION_ENDPOINT = "getreport";

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
 * 只放行 `https://kocserver-cn.cdreader.com/api/Report/GetReport`：协议、主机、端口、路径逐一精确比较，
 * 不允许 query / hash / 凭证。思路来自 CPS `assertAllowedTotalRevenueEndpoint`，这里收窄为单一端点。
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
  if (parsed.pathname !== NOVEL_REVENUE_REPORT_PATH) {
    throw new NovelRevenueAdapterError("invalid_request", null, "endpoint_path_not_allowed");
  }
}

export interface NovelGetReportBody {
  readonly beginTime: string;
  readonly endTime: string;
  readonly dimensions: readonly ["1"];
  readonly pageIndex: number;
  readonly pageSize: 999;
  readonly projectType: 1;
}

/**
 * 唯一的请求体构造点：`projectType: 1`、`dimensions: ["1"]`、`pageSize: 999` 无条件写入，
 * 入参里没有 projectType——也就无从传错。
 */
export function buildNovelGetReportBody(input: {
  beginDate: string;
  endDate: string;
  pageIndex: number;
}): NovelGetReportBody {
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
    dimensions: NOVEL_REVENUE_DIMENSIONS,
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
  buildNovelGetReportBody({ beginDate: input.beginDate, endDate: input.endDate, pageIndex: 1 });
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

async function fetchAllPages(
  input: FetchNovelDailyReportInput,
  token: string,
  timeoutMs: number,
  progress: { requestCount: number },
): Promise<NovelDailyReport> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const rateGate = input.rateGate ?? NOOP_MOBOREADER_RATE_GATE;
  const onUpstreamObservation = input.onUpstreamObservation ?? NOOP_UPSTREAM_OBSERVATION;
  const observationNow = input.now ?? Date.now;
  const endpoint = NOVEL_REVENUE_OBSERVATION_ENDPOINT;
  const rows: unknown[] = [];

  for (let pageIndex = 1; pageIndex <= NOVEL_REVENUE_MAX_PAGES; pageIndex += 1) {
    const body = buildNovelGetReportBody({ beginDate: input.beginDate, endDate: input.endDate, pageIndex });

    const gateWaitStartedAt = observationNow();
    const gateWaitInfo = await rateGate.wait(endpoint);
    const gateWaitMs = observationNow() - gateWaitStartedAt;
    const endpointGateWaitMs = gateWaitInfo ? gateWaitInfo.endpointGateWaitMs : null;
    const hostGateWaitMs = gateWaitInfo ? gateWaitInfo.hostGateWaitMs : null;
    const remainingBeforeDispatch = gateWaitInfo ? gateWaitInfo.remainingBeforeDispatch : null;
    // 限速闸可能让出几十秒；等完发现调用方已取消，就不要再发请求。
    if (input.signal?.aborted) throw new NovelRevenueAdapterError("transport_error", null, "aborted");

    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signal = input.signal ? AbortSignal.any([input.signal, timeoutSignal]) : timeoutSignal;
    const dispatchStartedAt = observationNow();
    progress.requestCount += 1;

    let response: Response;
    try {
      response = await fetchImpl(NOVEL_REVENUE_ENDPOINT, {
        method: "POST",
        redirect: "error",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
        signal,
      });
    } catch (error) {
      const timedOut = timeoutSignal.aborted && !input.signal?.aborted;
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
      const reason = input.signal?.aborted ? "aborted" : timedOut ? "timeout" : error instanceof Error ? boundedDetail(error.name, token) : "unknown";
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
    let json: unknown;
    try {
      json = await response.json();
    } catch {
      throw new NovelRevenueAdapterError("transport_error", response.status, "response_not_json");
    }

    const list = extractNovelReportList(json, token);
    rows.push(...list);
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
