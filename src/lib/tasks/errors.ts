export const PERSISTED_TASK_ERROR_MESSAGE_MAX_LENGTH = 1_024;
export const PERSISTED_TASK_ERROR_CODE_MAX_LENGTH = 64;
/**
 * C-10 (Phase E rework, 2026-09-07): `detail` is a narrow, opt-in escape
 * hatch for a handler to persist a few *structured, non-secret* diagnostic
 * values (an enumerated adapter code, an HTTP status, a boolean, a page
 * index) alongside the redacted `message` — e.g.
 * `worker/handlers/moboreader.ts`'s catalog-read failure, so an operator can
 * see "HTTP 401 at page 1" without reproducing the failure in a container.
 * Deliberately shallow and primitive-only (never an object/array value) so
 * it can never carry a response body, token, or URL — every string value
 * still passes through `redactSecrets` and a short length cap as defense in
 * depth, and the whole record is capped to a handful of keys.
 */
export type PersistedTaskErrorDetail = Readonly<Record<string, string | number | boolean | null>>;
const PERSISTED_TASK_ERROR_DETAIL_MAX_KEYS = 8;
const PERSISTED_TASK_ERROR_DETAIL_STRING_MAX_LENGTH = 128;

export interface PersistedTaskError {
  code: string;
  message: string;
  detail?: PersistedTaskErrorDetail;
}

const DEFAULT_ERROR_CODE = "handler_failed";
const DEFAULT_ERROR_MESSAGE = "Task handler failed";

function sanitizeCode(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9_.-]+/g, "_");
  return normalized.slice(0, PERSISTED_TASK_ERROR_CODE_MAX_LENGTH) || fallback;
}

/**
 * Exported for D-7b (`worker/runtime/worker.ts`'s `handleFinalizeFailure`
 * engineering-log line): the same redaction this module already applies to
 * every persisted `message`/`detail` string, reused so a log-only field can
 * carry more of the raw database error text without becoming a second,
 * unredacted secret-leak surface.
 */
export function redactSecrets(message: string): string {
  return message
    .replace(/\b(authorization\s*:\s*)bearer\s+[^\s,;]+/gi, "$1Bearer [REDACTED]")
    .replace(/\bbearer\s+[a-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/\beyJ[a-z0-9_-]+\.eyJ[a-z0-9_-]+\.[a-z0-9_-]+\b/gi, "[REDACTED]")
    .replace(/\bpostgres(?:ql)?:\/\/[^\s,;]+/gi, "[REDACTED]")
    .replace(
      /(\b(?:api[_-]?key|password|passwd|token|access[_-]?token|refresh[_-]?token|secret|credential|cookie)\b\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s&,;]+)/gi,
      "$1[REDACTED]",
    )
    .replace(
      /(\b(?:token|secret|credential|cookie)\b\s+)[^\s,;]+/gi,
      "$1[REDACTED]",
    );
}

function truncateMessage(message: string): string {
  if (message.length <= PERSISTED_TASK_ERROR_MESSAGE_MAX_LENGTH) return message;
  return `${message.slice(0, PERSISTED_TASK_ERROR_MESSAGE_MAX_LENGTH - 1)}…`;
}

/**
 * Shallow allowlist projection for `PersistedTaskError.detail`: only
 * string/number/boolean/null values on own enumerable keys survive: no
 * nested object or array is ever passed through (that would reopen exactly
 * the free-form channel this type deliberately closes), and every string
 * value is still redacted and length-capped. Returns `undefined` when the
 * input is not a plain object or has nothing safe to keep, so a caller with
 * no `detail` at all continues to omit the key entirely (unchanged output
 * shape from before this field existed).
 */
function sanitizeDetail(value: unknown): PersistedTaskErrorDetail | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const safe: Record<string, string | number | boolean | null> = {};
  let kept = 0;
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (kept >= PERSISTED_TASK_ERROR_DETAIL_MAX_KEYS) break;
    if (raw === null || typeof raw === "number" || typeof raw === "boolean") {
      safe[key] = raw;
      kept += 1;
    } else if (typeof raw === "string") {
      const redacted = redactSecrets(raw).slice(0, PERSISTED_TASK_ERROR_DETAIL_STRING_MAX_LENGTH);
      safe[key] = redacted;
      kept += 1;
    }
    // Any other type (object, array, function, undefined, symbol, bigint)
    // is silently dropped — never persisted.
  }
  return kept > 0 ? Object.freeze(safe) : undefined;
}

export function sanitizePersistedTaskError(
  error: unknown,
  fallbackCode = DEFAULT_ERROR_CODE,
): PersistedTaskError {
  let code: unknown;
  let message: unknown;
  let detail: unknown;

  if (error instanceof Error) {
    const candidate = error as Error & { code?: unknown; detail?: unknown };
    code = candidate.code;
    message = error.message;
    detail = candidate.detail;
  } else if (typeof error === "string") {
    message = error;
  } else if (error && typeof error === "object") {
    const candidate = error as { code?: unknown; message?: unknown; detail?: unknown };
    code = candidate.code;
    message = candidate.message;
    detail = candidate.detail;
  }

  const safeCode = sanitizeCode(code, sanitizeCode(fallbackCode, DEFAULT_ERROR_CODE));
  const databaseFailure = error instanceof Error && (
    (typeof code === "string" && /^(?:P\d{4}|E(?:CONN|HOST|PIPE|AI_))/i.test(code))
    || /\b(?:database server|database connection|ECONN(?:REFUSED|RESET)|DATABASE_URL)\b/i.test(error.message)
  );
  const rawMessage = !databaseFailure && typeof message === "string" && message.trim()
    ? message.trim()
    : DEFAULT_ERROR_MESSAGE;
  const safeDetail = sanitizeDetail(detail);

  return {
    code: safeCode,
    message: truncateMessage(redactSecrets(rawMessage)),
    ...(safeDetail ? { detail: safeDetail } : {}),
  };
}
