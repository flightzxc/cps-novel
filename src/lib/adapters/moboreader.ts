const MOBOREADER_ORIGIN = "https://kocserver-cn.cdreader.com";

export const MOBOREADER_READ_ENDPOINTS = Object.freeze({
  getlistpc: "/api/v1/res/getlistpc",
  getbydataid: "/api/v1/material/getbydataid",
  getchapterinfo: "/api/v1/res/getchapterinfo",
});

export const MOBOREADER_DEFAULT_TIMEOUT_MS = 15_000;
export const MOBOREADER_MAX_READ_ATTEMPTS = 3;
const MAX_RETRY_AFTER_MS = 30_000;

export interface ListBooksRequest {
  name: string;
  orderType: number;
  pageIndex: number;
  pageSize: number;
  projectType: number;
}

export interface FetchBookMaterialRequest {
  agencyId: string | number;
  dataId: string | number;
  projectType: number;
  language: string | number;
  materialType: string | number;
}

export interface FetchPreviewChaptersRequest {
  agencyId: string | number;
  seriesId: string | number;
  projectType: number;
  language: string | number;
}

export const MOBOREADER_FALLBACK_MATERIAL_TYPE = 1;

export interface MoboreaderPreviewRequests {
  material: FetchBookMaterialRequest;
  chapters: FetchPreviewChaptersRequest;
  materialTypeSource: "getlistpc.materialType" | "fallback_1";
}

export type RawEvidence = Readonly<Record<string, unknown>> & {
  readonly __boundary: "approved_raw_evidence";
};

export interface MoboreaderBook {
  externalBookId: string;
  agencyId: string | null;
  agencyName: string | null;
  seriesId: string;
  materialType: string | number | null;
  title: string;
  description: string | null;
  coverUrl: string | null;
  projectType: number | null;
  language: string;
  languageName: string | null;
  allEpis: number | null;
  payEpisFrom: number | null;
  splitRatio: number | null;
  ttoSplitRatio: number | null;
  createTime: string | null;
  seriesTypeList: readonly string[];
  recommendList: readonly string[];
  labelSnapshotComplete: boolean;
  rawEvidence: RawEvidence;
}

export interface ListBooksResponse {
  items: readonly MoboreaderBook[];
  totalCount: number;
  rawEvidence: RawEvidence;
}

export interface BookMaterialResponse {
  dataId: string | null;
  seriesId: string | null;
  materialType: string | number | null;
  materialStatus: string | number | null;
  statusText: string | null;
  rawEvidence: RawEvidence;
}

export interface MoboreaderPreviewChapter {
  i: number;
  chapterID: string;
  chapterName: string | null;
  chapterShowName: string | null;
  chapterContent: string;
}

export interface PreviewChaptersResponse {
  bookId: string;
  currentLanguage: string;
  chapterList: readonly MoboreaderPreviewChapter[];
}

export interface MoboreaderReadAdapter {
  listBooks(request: ListBooksRequest, token: string, signal?: AbortSignal): Promise<ListBooksResponse>;
  fetchBookMaterial(request: FetchBookMaterialRequest, token: string, signal?: AbortSignal): Promise<BookMaterialResponse>;
  fetchPreviewChapters(request: FetchPreviewChaptersRequest, token: string, signal?: AbortSignal): Promise<PreviewChaptersResponse>;
}

export class MoboreaderAdapterError extends Error {
  constructor(
    readonly code:
      | "request_timeout"
      | "transport_error"
      | "upstream_http_error"
      | "malformed_payload",
    readonly retryable: boolean,
    readonly status: number | null = null,
    /**
     * Diagnostic-only detail (field name + received shape). Never derived from
     * raw upstream values — only from field names and `typeof`/emptiness, so
     * it cannot leak credentials, titles, or response bodies into logs.
     */
    readonly detail: string | null = null,
  ) {
    super(`MoboReader read failed: ${code}${status === null ? "" : ` (${status})`}${detail ? ` — ${detail}` : ""}`);
    this.name = "MoboreaderAdapterError";
  }
}

type Fetch = typeof fetch;

interface AdapterOptions {
  fetchImpl?: Fetch;
  timeoutMs?: number;
  maxAttempts?: number;
  sleep?: (milliseconds: number) => Promise<void>;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new MoboreaderAdapterError("malformed_payload", false);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new MoboreaderAdapterError("malformed_payload", false);
  }
  return value;
}

function requestScalar(value: unknown): string | number {
  if (typeof value === "string" && value.trim()) return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  throw new MoboreaderAdapterError("malformed_payload", false);
}

function optionalIdentifier(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

/** Diagnostic-only shape description. Reports type/emptiness, never the raw value. */
function describeReceivedShape(value: unknown): string {
  if (value === null) return "typeof object (null)";
  if (value === undefined) return "typeof undefined";
  if (typeof value === "string") return value.trim() ? "typeof string (non-empty)" : "typeof string (empty)";
  if (typeof value === "number") return Number.isFinite(value) ? "typeof number (finite)" : "typeof number (non-finite)";
  return `typeof ${typeof value}`;
}

function requiredIdentifier(field: string, value: unknown): string {
  const identifier = optionalIdentifier(value);
  if (identifier === null) {
    throw new MoboreaderAdapterError(
      "malformed_payload",
      false,
      null,
      `${field}: expected a non-empty string or a finite number, received ${describeReceivedShape(value)}`,
    );
  }
  return identifier;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function optionalNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function integer(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new MoboreaderAdapterError("malformed_payload", false);
  }
  return value as number;
}

interface ParsedLabelValues {
  values: string[];
  complete: boolean;
}

function parsedLabelValue(value: unknown): string | null {
  if (typeof value === "string") return value.trim() ? value : null;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const candidate = row.value ?? row.name ?? row.label ?? row.id;
  if (typeof candidate === "string") return candidate.trim() ? candidate : null;
  if (typeof candidate === "number" && Number.isFinite(candidate)) return String(candidate);
  return null;
}

function labelValues(value: unknown): ParsedLabelValues {
  if (!Array.isArray(value)) return { values: [], complete: false };
  const labels: string[] = [];
  for (const item of value) {
    const label = parsedLabelValue(item);
    if (label === null) return { values: [], complete: false };
    labels.push(label);
  }
  return { values: labels, complete: true };
}

const REDACTED_EVIDENCE_KEYS = new Set([
  "token", "authorization", "jwt", "secret", "chaptercontent", "koccode",
  "publicurl", "homelink", "onlineurl", "promourl", "promocode",
]);

/**
 * Single source of truth for the sentinel this adapter substitutes for any
 * `REDACTED_EVIDENCE_KEYS` field. `NovelSourceItem.rawPayload` (the only
 * place `toApprovedRawEvidence`'s output is persisted — see
 * `worker/handlers/moboreader.ts`'s `persistCatalogPage`) therefore carries
 * this literal, never the real upstream value, for `kocCode`/`publicUrl`/
 * `homeLink`/`onlineUrl`/`promoUrl`/`promoCode` on every synced row. Any
 * downstream reader of `rawPayload` that treats a promo-shaped field as
 * usable evidence (e.g. `worker/handlers/promo-link-claim.ts`'s §3.9
 * pre-read) must compare against this constant — not a locally re-typed
 * `"[redacted]"` literal — so the two can never drift apart.
 */
export const REDACTED_EVIDENCE_SENTINEL = "[redacted]" as const;

function safeEvidenceValue(value: unknown, depth: number): unknown {
  if (depth > 5) return "[depth-limited]";
  if (Array.isArray(value)) return value.map((item) => safeEvidenceValue(item, depth + 1));
  if (value && typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      output[key] = REDACTED_EVIDENCE_KEYS.has(key.toLowerCase())
        ? REDACTED_EVIDENCE_SENTINEL
        : safeEvidenceValue(item, depth + 1);
    }
    return output;
  }
  return value;
}

/** The only boundary at which unknown upstream fields may be retained. */
export function toApprovedRawEvidence(value: unknown): RawEvidence {
  const sanitized = safeEvidenceValue(record(value), 0) as Record<string, unknown>;
  return Object.freeze({ ...sanitized, __boundary: "approved_raw_evidence" as const });
}

function responseData(value: unknown): Record<string, unknown> {
  const envelope = record(value);
  return record(envelope.data);
}

/**
 * Frozen Owner contract for constructing both Preview reads from one original
 * getlistpc row. In particular, `id` is never a fallback for `dataId`, and a
 * present materialType (including zero) is never replaced by the fallback.
 */
export function buildMoboreaderPreviewRequestsFromCatalogRow(value: unknown): MoboreaderPreviewRequests {
  const row = record(value);
  const agencyId = requestScalar(row.agencyId);
  const seriesId = requestScalar(row.seriesId);
  const language = requestScalar(row.language);
  const projectType = integer(row.projectType);
  const hasMaterialType = row.materialType !== null && row.materialType !== undefined;
  const materialType = hasMaterialType
    ? requestScalar(row.materialType)
    : MOBOREADER_FALLBACK_MATERIAL_TYPE;
  return {
    material: {
      agencyId,
      dataId: seriesId,
      projectType,
      language,
      materialType,
    },
    chapters: {
      agencyId,
      seriesId,
      projectType,
      language,
    },
    materialTypeSource: hasMaterialType ? "getlistpc.materialType" : "fallback_1",
  };
}

export function parseListBooksResponse(value: unknown): ListBooksResponse {
  const data = responseData(value);
  if (!Array.isArray(data.list)) throw new MoboreaderAdapterError("malformed_payload", false);
  const items = data.list.map((value): MoboreaderBook => {
    const row = record(value);
    const seriesId = requiredIdentifier("seriesId", row.seriesId);
    const agencyId = optionalIdentifier(row.agencyId);
    const seriesTypeList = labelValues(row.seriesTypeList);
    const recommendList = labelValues(row.recommendList);
    const agencyIdentityComplete = Object.hasOwn(row, "agencyId")
      && (row.agencyId === null || agencyId !== null);
    return {
      externalBookId: requiredIdentifier("externalBookId", row.id ?? row.seriesId),
      agencyId,
      agencyName: optionalString(row.agencyName),
      seriesId,
      materialType: typeof row.materialType === "string" || typeof row.materialType === "number" ? row.materialType : null,
      title: requiredString(row.seriesName),
      description: optionalString(row.description),
      coverUrl: optionalString(row.coverUrl ?? row.logo),
      projectType: optionalNumber(row.projectType),
      language: requiredString(typeof row.language === "number" ? String(row.language) : row.language),
      languageName: optionalString(row.languageName),
      allEpis: optionalNumber(row.allEpis),
      payEpisFrom: optionalNumber(row.payEpisFrom),
      splitRatio: optionalNumber(row.splitRatio),
      ttoSplitRatio: optionalNumber(row.ttoSplitRatio),
      createTime: optionalString(row.createTime),
      seriesTypeList: seriesTypeList.values,
      recommendList: recommendList.values,
      labelSnapshotComplete: agencyIdentityComplete && seriesTypeList.complete && recommendList.complete,
      rawEvidence: toApprovedRawEvidence(row),
    };
  });
  return { items, totalCount: integer(data.totalCount), rawEvidence: toApprovedRawEvidence(data) };
}

export function parseBookMaterialResponse(value: unknown): BookMaterialResponse {
  const data = responseData(value);
  const item = Array.isArray(data.list) && data.list.length > 0 ? record(data.list[0]) : data;
  return {
    dataId: optionalIdentifier(item.dataId ?? item.id),
    seriesId: optionalIdentifier(item.seriesId),
    materialType: typeof item.materialType === "string" || typeof item.materialType === "number" ? item.materialType : null,
    materialStatus: typeof item.materialStatus === "string" || typeof item.materialStatus === "number" ? item.materialStatus : null,
    statusText: optionalString(item.statusText),
    rawEvidence: toApprovedRawEvidence(data),
  };
}

export function parsePreviewChaptersResponse(value: unknown): PreviewChaptersResponse {
  const data = responseData(value);
  if (!Array.isArray(data.chapterList)) throw new MoboreaderAdapterError("malformed_payload", false);
  const chapterList = data.chapterList.map((value): MoboreaderPreviewChapter => {
    const row = record(value);
    const i = integer(row.i);
    if (i < 1) throw new MoboreaderAdapterError("malformed_payload", false);
    return {
      i,
      chapterID: requiredIdentifier("chapterID", row.chapterID),
      chapterName: optionalString(row.chapterName),
      chapterShowName: optionalString(row.chapterShowName),
      chapterContent: requiredString(row.chapterContent),
    };
  });
  const identities = new Set<string>();
  for (const chapter of chapterList) {
    const identity = `${chapter.i}\n${chapter.chapterID}`;
    if (identities.has(identity)) throw new MoboreaderAdapterError("malformed_payload", false);
    identities.add(identity);
  }
  return {
    bookId: requiredString(data.bookId),
    currentLanguage: requiredString(typeof data.currentLanguage === "number" ? String(data.currentLanguage) : data.currentLanguage),
    chapterList,
  };
}

function retryAfterMs(response: Response): number | null {
  const raw = response.headers.get("retry-after");
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
  const date = Date.parse(raw);
  if (!Number.isNaN(date)) return Math.min(Math.max(0, date - Date.now()), MAX_RETRY_AFTER_MS);
  return null;
}

function shouldRetryStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function composeSignal(parent: AbortSignal | undefined, timeoutMs: number) {
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const abort = () => controller.abort();
  parent?.addEventListener("abort", abort, { once: true });
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    cleanup: () => {
      clearTimeout(timeout);
      parent?.removeEventListener("abort", abort);
    },
  };
}

export function createMoboreaderReadAdapter(options: AdapterOptions = {}): MoboreaderReadAdapter {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? MOBOREADER_DEFAULT_TIMEOUT_MS;
  const maxAttempts = options.maxAttempts ?? MOBOREADER_MAX_READ_ATTEMPTS;
  const sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  if (timeoutMs < 1 || maxAttempts < 1 || maxAttempts > MOBOREADER_MAX_READ_ATTEMPTS) {
    throw new Error("Invalid MoboReader read safety limits");
  }

  async function post(path: string, body: Record<string, unknown>, token: string, signal?: AbortSignal): Promise<unknown> {
    if (!Object.values(MOBOREADER_READ_ENDPOINTS).includes(path as never)) throw new Error("Endpoint is not allowlisted");
    if (!token) throw new Error("MoboReader credential is required");
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const scoped = composeSignal(signal, timeoutMs);
      try {
        const response = await fetchImpl(`${MOBOREADER_ORIGIN}${path}`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify(body),
          signal: scoped.signal,
        });
        if (!response.ok) {
          const retryable = shouldRetryStatus(response.status);
          if (retryable && attempt < maxAttempts) {
            await sleep(retryAfterMs(response) ?? Math.min(250 * 2 ** (attempt - 1), 2_000));
            continue;
          }
          throw new MoboreaderAdapterError("upstream_http_error", retryable, response.status);
        }
        try {
          return await response.json();
        } catch {
          throw new MoboreaderAdapterError("malformed_payload", false, response.status);
        }
      } catch (error) {
        if (error instanceof MoboreaderAdapterError) throw error;
        if (signal?.aborted) throw new MoboreaderAdapterError("transport_error", false);
        const code = scoped.timedOut() ? "request_timeout" : "transport_error";
        if (attempt === maxAttempts) throw new MoboreaderAdapterError(code, true);
        await sleep(Math.min(250 * 2 ** (attempt - 1), 2_000));
      } finally {
        scoped.cleanup();
      }
    }
    throw new MoboreaderAdapterError("transport_error", true);
  }

  const adapter: MoboreaderReadAdapter = {
    async listBooks(request: ListBooksRequest, token: string, signal?: AbortSignal) {
      const payload = {
        name: request.name,
        orderType: request.orderType,
        pageIndex: request.pageIndex,
        pageSize: request.pageSize,
        projectType: request.projectType,
      };
      return parseListBooksResponse(await post(MOBOREADER_READ_ENDPOINTS.getlistpc, payload, token, signal));
    },
    async fetchBookMaterial(request: FetchBookMaterialRequest, token: string, signal?: AbortSignal) {
      const payload = {
        agencyId: request.agencyId,
        dataId: request.dataId,
        projectType: request.projectType,
        language: request.language,
        materialType: request.materialType,
      };
      return parseBookMaterialResponse(await post(MOBOREADER_READ_ENDPOINTS.getbydataid, payload, token, signal));
    },
    async fetchPreviewChapters(request: FetchPreviewChaptersRequest, token: string, signal?: AbortSignal) {
      const payload = {
        agencyId: request.agencyId,
        seriesId: request.seriesId,
        projectType: request.projectType,
        language: request.language,
      };
      return parsePreviewChaptersResponse(await post(MOBOREADER_READ_ENDPOINTS.getchapterinfo, payload, token, signal));
    },
  };
  return Object.freeze(adapter);
}
