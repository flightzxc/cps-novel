/**
 * B-36 — a diagnosable, content-free reason for a failed Preview upstream read.
 *
 * Before this, `createMoboreaderPreviewHandler` wrapped both upstream calls in a
 * bare `catch {}` and answered every failure with the same generic
 * `upstream_material_read_failed` / `upstream_preview_read_failed`. On
 * 2026-10-07, 34 books failed that way deterministically with HTTP 200 on both
 * endpoints (so the adapter's own *validation* had rejected a well-delivered
 * response) and there was nothing — in the item row or in the logs — to say
 * which rule had fired.
 *
 * `describePreviewReadFailure` turns whatever was thrown into two projections of
 * the same facts:
 *
 *   - `detail` — flat primitives, at most eight keys, persisted on the failed
 *     item's `error.detail` through the existing `sanitizePersistedTaskError`
 *     path (C-10's mechanism; no new column, grant, migration or env var).
 *   - `log` — a superset (adds `retryable`, string length, chapter id, …) for
 *     one structured log line.
 *
 * ── The redaction rule (this is the part that must not regress) ──────────
 * NOTHING that leaves this module is copied from `error.message`, `error.detail`
 * (the adapter's free-text diagnostic string), a response body, a title, a URL,
 * a header or the credential. Every value is rebuilt from scratch through one of
 * three gates:
 *
 *   `member`     — the value must be a literal member of a closed vocabulary
 *                  defined in code (failure kind, received-type, adapter code);
 *   `count`      — a non-negative safe integer (positions, lengths, statuses);
 *   `identifier` — a short token matching `^[A-Za-z0-9_.:-]+$` (an upstream
 *                  chapter/book id, or a class name), nothing with whitespace
 *                  or punctuation that prose or JSON would need.
 *
 * Anything that fails its gate is dropped, not escaped or truncated: a body
 * fragment that somehow reached a field is simply not recorded. The thrown
 * error's own message is never an input, so an upstream text embedded in it
 * (a `JSON.parse` SyntaxError quotes the body, for one) cannot ride along.
 */
import {
  MOBOREADER_PARSE_FAILURE_KINDS,
  MOBOREADER_RECEIVED_KINDS,
  MoboreaderAdapterError,
  MoboreaderRateLimitedError,
} from "../../src/lib/adapters";
import type { PersistedTaskErrorDetail } from "../../src/lib/tasks/errors";
import type { TaskOutcome } from "../../src/lib/tasks/types";

/** Which upstream call failed — the handler knows this, the adapter error does not. */
export type PreviewReadStage = "getbydataid" | "getchapterinfo";

/**
 * Every value `kind` can take. The parse kinds come from the adapter (one per
 * rejection site); the rest are derived here from the error's class/code.
 */
export const PREVIEW_READ_FAILURE_KINDS = [
  ...MOBOREADER_PARSE_FAILURE_KINDS,
  "transport_error",
  "request_timeout",
  "http_status",
  "rate_limited",
  /** `malformed_payload` thrown from a site that has no diagnostic (should not exist for the preview endpoints). */
  "malformed_unspecified",
  /** Not a `MoboreaderAdapterError` / `MoboreaderRateLimitedError` at all. */
  "unclassified_error",
] as const;

export type PreviewReadFailureKind = (typeof PREVIEW_READ_FAILURE_KINDS)[number];

const PREVIEW_READ_STAGES: readonly PreviewReadStage[] = ["getbydataid", "getchapterinfo"];
const ADAPTER_CODES = ["request_timeout", "transport_error", "upstream_http_error", "malformed_payload"] as const;
const RATE_LIMIT_REASONS = ["budget_exhausted", "max_attempts"] as const;

const IDENTIFIER_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;
const CLASS_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const ERRNO_CODE_PATTERN = /^[A-Z][A-Z0-9_]{1,63}$/;
const CHAPTER_ID_MAX_LENGTH = 64;
const COUNT_MAX = 100_000_000;

// ── the three gates ──────────────────────────────────────────────────────

function member<T extends string>(allowed: readonly T[], value: unknown): T | undefined {
  return typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : undefined;
}

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= COUNT_MAX
    ? value
    : undefined;
}

function identifier(value: unknown, maxLength = 128): string | undefined {
  return typeof value === "string" && value.length <= maxLength && IDENTIFIER_PATTERN.test(value)
    ? value
    : undefined;
}

function httpStatus(value: unknown): number | undefined {
  const status = count(value);
  return status !== undefined && status >= 100 && status <= 599 ? status : undefined;
}

/** The error's class name, or a fixed placeholder — never anything free-form. */
function errorClassOf(error: unknown): string {
  if (!(error instanceof Error)) return "NonError";
  const candidates: unknown[] = [error.constructor?.name, error.name];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate !== "Error" && CLASS_NAME_PATTERN.test(candidate)) {
      return candidate;
    }
  }
  return "Error";
}

// ── the projection ───────────────────────────────────────────────────────

export interface PreviewReadFailureLogFields {
  readonly kind: PreviewReadFailureKind;
  readonly stage: PreviewReadStage;
  readonly errorClass: string;
  readonly adapterCode?: string;
  readonly retryable?: boolean;
  readonly httpStatus?: number;
  readonly receivedType?: string;
  readonly valueLength?: number;
  readonly chapterIndex?: number;
  readonly chapterOrdinal?: number;
  readonly chapterId?: string;
  readonly chapterCount?: number;
  readonly errorCode?: string;
  readonly rateLimitAttempts?: number;
  readonly rateLimitReason?: string;
  readonly elapsedMs?: number;
}

export interface PreviewReadFailureReport {
  readonly kind: PreviewReadFailureKind;
  /** Persisted on the failed item. Flat, primitives only, never more than eight keys. */
  readonly detail: PersistedTaskErrorDetail;
  /** What goes in the structured log line (a superset of `detail`). */
  readonly log: PreviewReadFailureLogFields;
}

/** Mirrors `PERSISTED_TASK_ERROR_DETAIL_MAX_KEYS` in `src/lib/tasks/errors.ts`, which is not exported. */
const PERSISTED_DETAIL_MAX_KEYS = 8;

/** Drops `undefined` members so "absent" really is absent in the persisted JSON and the log line. */
function compact<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}

function reportFrom(input: PreviewReadFailureLogFields): PreviewReadFailureReport {
  const fields = compact(input);
  // Insertion order IS the priority order: the most diagnostic keys come first
  // and the cap below trims from the end, so if a future kind ever carries more
  // than eight the loss is deliberate (and visible here) instead of whatever
  // `sanitizePersistedTaskError` happens to drop. Real kinds stay within eight
  // (pinned by a test).
  const detail: Record<string, string | number> = {
    kind: fields.kind,
    stage: fields.stage,
    errorClass: fields.errorClass,
  };
  if (fields.adapterCode !== undefined) detail.adapterCode = fields.adapterCode;
  if (fields.httpStatus !== undefined) detail.httpStatus = fields.httpStatus;
  if (fields.receivedType !== undefined) detail.receivedType = fields.receivedType;
  if (fields.chapterIndex !== undefined) detail.chapterIndex = fields.chapterIndex;
  if (fields.chapterOrdinal !== undefined) detail.chapterOrdinal = fields.chapterOrdinal;
  if (fields.chapterCount !== undefined) detail.chapterCount = fields.chapterCount;
  if (fields.errorCode !== undefined) detail.errorCode = fields.errorCode;
  if (fields.rateLimitAttempts !== undefined) detail.attempts = fields.rateLimitAttempts;
  if (fields.rateLimitReason !== undefined) detail.limitReason = fields.rateLimitReason;
  return {
    kind: fields.kind,
    detail: Object.freeze(Object.fromEntries(Object.entries(detail).slice(0, PERSISTED_DETAIL_MAX_KEYS))),
    log: fields,
  };
}

export function describePreviewReadFailure(error: unknown, stage: PreviewReadStage): PreviewReadFailureReport {
  // `stage` is a compile-time literal at every call site; the gate is for the
  // day someone threads a string through.
  const safeStage = member(PREVIEW_READ_STAGES, stage) ?? "getchapterinfo";
  const errorClass = errorClassOf(error);

  if (error instanceof MoboreaderRateLimitedError) {
    return reportFrom({
      kind: "rate_limited",
      stage: safeStage,
      errorClass,
      httpStatus: httpStatus(error.status),
      rateLimitAttempts: count(error.attempts),
      rateLimitReason: member(RATE_LIMIT_REASONS, error.reason),
      elapsedMs: count(error.elapsedMs),
    });
  }

  if (error instanceof MoboreaderAdapterError) {
    const adapterCode = member(ADAPTER_CODES, error.code);
    const retryable = typeof error.retryable === "boolean" ? error.retryable : undefined;
    const status = httpStatus(error.status);
    switch (adapterCode) {
      case "transport_error":
      case "request_timeout":
        return reportFrom({ kind: adapterCode, stage: safeStage, errorClass, adapterCode, retryable });
      case "upstream_http_error":
        return reportFrom({ kind: "http_status", stage: safeStage, errorClass, adapterCode, retryable, httpStatus: status });
      case "malformed_payload": {
        // Only a `malformed_payload` carries a parse diagnostic; one attached to
        // any other code is ignored rather than trusted.
        const diagnostic = error.diagnostic;
        const kind = member(MOBOREADER_PARSE_FAILURE_KINDS, diagnostic?.kind) ?? "malformed_unspecified";
        return reportFrom({
          kind,
          stage: safeStage,
          errorClass,
          adapterCode,
          retryable,
          httpStatus: status,
          receivedType: member(MOBOREADER_RECEIVED_KINDS, diagnostic?.receivedType),
          valueLength: count(diagnostic?.valueLength),
          chapterIndex: count(diagnostic?.chapterIndex),
          chapterOrdinal: count(diagnostic?.chapterOrdinal),
          chapterId: identifier(diagnostic?.chapterId, CHAPTER_ID_MAX_LENGTH),
          chapterCount: count(diagnostic?.chapterCount),
        });
      }
      default:
        break;
    }
  }

  const rawErrorCode: unknown = error instanceof Error ? (error as { code?: unknown }).code : undefined;
  const errorCode = typeof rawErrorCode === "string" && ERRNO_CODE_PATTERN.test(rawErrorCode) ? rawErrorCode : undefined;
  return reportFrom({ kind: "unclassified_error", stage: safeStage, errorClass, errorCode });
}

// ── handler wiring ───────────────────────────────────────────────────────

/** Where in the pipeline the failure happened — all already-persisted business keys. */
export interface PreviewReadFailureContext {
  readonly taskId: string;
  readonly itemId: string;
  readonly mode: string;
  readonly attempt: number;
  readonly novelId: string;
  readonly novelSourceItemId: string;
  readonly seriesId: string | number;
  readonly dataId: string | number;
  readonly agencyId: string | number;
  readonly language: string | number;
}

/**
 * One log line. The business keys (task/item/novel/series/data/language) are
 * what lets an operator go from this line to the book; each is gated through
 * `identifier` so a malformed key is omitted instead of echoed.
 */
export type PreviewReadFailureLogEvent = PreviewReadFailureLogFields & {
  readonly outcomeCode: string;
  readonly taskId?: string;
  readonly itemId?: string;
  readonly mode?: string;
  readonly attempt?: number;
  readonly novelId?: string;
  readonly novelSourceItemId?: string;
  readonly seriesId?: string;
  readonly dataId?: string;
  readonly agencyId?: string;
  readonly language?: string;
};

function businessKey(value: string | number): string | undefined {
  return identifier(typeof value === "number" ? String(value) : value);
}

export function buildPreviewReadFailureLogEvent(
  report: PreviewReadFailureReport,
  outcomeCode: string,
  context: PreviewReadFailureContext,
): PreviewReadFailureLogEvent {
  return compact({
    ...report.log,
    outcomeCode,
    taskId: identifier(context.taskId),
    itemId: identifier(context.itemId),
    mode: member(["dry_run", "apply"], context.mode),
    attempt: count(context.attempt),
    novelId: identifier(context.novelId),
    novelSourceItemId: identifier(context.novelSourceItemId),
    seriesId: businessKey(context.seriesId),
    dataId: businessKey(context.dataId),
    agencyId: businessKey(context.agencyId),
    language: businessKey(context.language),
  });
}

/**
 * The failed outcome for one Preview upstream read. Same status, same top-level
 * `code` and same `message` the handler returned before B-36 — `detail` is the
 * only addition, and the admin task page's safe-failure projection only ever
 * reads `detail` for the codes it lists, so that page renders identically.
 */
export function previewReadFailureOutcome(input: {
  readonly error: unknown;
  readonly stage: PreviewReadStage;
  readonly code: "upstream_material_read_failed" | "upstream_preview_read_failed";
  readonly message: string;
  readonly context: PreviewReadFailureContext;
  readonly sink: (event: PreviewReadFailureLogEvent) => void;
}): TaskOutcome {
  const report = describePreviewReadFailure(input.error, input.stage);
  try {
    input.sink(buildPreviewReadFailureLogEvent(report, input.code, input.context));
  } catch {
    // A broken log sink must never change what the item records or whether it
    // fails — the persisted `detail` below is the durable copy of this report.
  }
  return {
    status: "failed",
    error: { code: input.code, message: input.message, detail: report.detail },
  };
}
