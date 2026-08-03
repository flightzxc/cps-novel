export const PERSISTED_TASK_ERROR_MESSAGE_MAX_LENGTH = 1_024;
export const PERSISTED_TASK_ERROR_CODE_MAX_LENGTH = 64;

export interface PersistedTaskError {
  code: string;
  message: string;
}

const DEFAULT_ERROR_CODE = "handler_failed";
const DEFAULT_ERROR_MESSAGE = "Task handler failed";

function sanitizeCode(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9_.-]+/g, "_");
  return normalized.slice(0, PERSISTED_TASK_ERROR_CODE_MAX_LENGTH) || fallback;
}

function redactSecrets(message: string): string {
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

export function sanitizePersistedTaskError(
  error: unknown,
  fallbackCode = DEFAULT_ERROR_CODE,
): PersistedTaskError {
  let code: unknown;
  let message: unknown;

  if (error instanceof Error) {
    const candidate = error as Error & { code?: unknown };
    code = candidate.code;
    message = error.message;
  } else if (typeof error === "string") {
    message = error;
  } else if (error && typeof error === "object") {
    const candidate = error as { code?: unknown; message?: unknown };
    code = candidate.code;
    message = candidate.message;
  }

  const safeCode = sanitizeCode(code, sanitizeCode(fallbackCode, DEFAULT_ERROR_CODE));
  const databaseFailure = error instanceof Error && (
    (typeof code === "string" && /^(?:P\d{4}|E(?:CONN|HOST|PIPE|AI_))/i.test(code))
    || /\b(?:database server|database connection|ECONN(?:REFUSED|RESET)|DATABASE_URL)\b/i.test(error.message)
  );
  const rawMessage = !databaseFailure && typeof message === "string" && message.trim()
    ? message.trim()
    : DEFAULT_ERROR_MESSAGE;

  return {
    code: safeCode,
    message: truncateMessage(redactSecrets(rawMessage)),
  };
}
