/**
 * Generic PostgreSQL retry/error-classification helpers. Ported from CPS
 * `src/lib/db-retry.ts` (122 lines, B/90% reuse per the P2-07~12 transplant
 * audit) and adapted from CPS's SQLite-era transient-message allowlist to
 * PostgreSQL error codes.
 *
 * `isUniqueConstraintViolation` and `isSerializationFailure` are the single
 * source of truth for P2002/P2034 (and their raw-SQL `$queryRaw`/`$executeRaw`
 * equivalents, P2010 wrapping Postgres SQLSTATE 23505/40001) classification —
 * `src/server/credentials/service.ts` previously defined its own local copies
 * of this logic; it now imports from here instead. Do not re-implement this
 * classification a second time anywhere in the codebase.
 */
import { Prisma } from "@prisma/client";

export type DbRetryLogEntry = {
  op: string;
  attempt: number;
  delay: number;
  itemId?: string;
  idempotencyKey?: string;
  page?: number;
  sourceKey?: string;
  sourceItemId?: string;
  sourceLanguageCode?: string;
  sourceLocale?: string | null;
  itemIndex?: number;
  error: string;
};

export type DbRetryOptions = {
  delaysMs?: number[];
  jitterMs?: number;
  sleep?: (delayMs: number) => Promise<void>;
  logger?: (entry: DbRetryLogEntry) => void;
};

export type DbRetryContext = {
  op: string;
  itemId?: string;
  idempotencyKey?: string;
  page?: number;
  sourceKey?: string;
  sourceItemId?: string;
  sourceLanguageCode?: string;
  sourceLocale?: string | null;
  itemIndex?: number;
};

const DEFAULT_DELAYS_MS = [500, 1500, 3000] as const;
const DEFAULT_JITTER_MS = 100;

/**
 * Transient PostgreSQL/connection failure messages that are not surfaced as a
 * structured Prisma error code (e.g. driver-level socket resets during
 * connection-pool churn). This is deliberately narrow: it must never match
 * business-rule failures.
 */
const TRANSIENT_MESSAGE_RE =
  /Socket timeout|Connection reset|ECONNRESET|ETIMEDOUT|timed out|Server has closed the connection|Can't reach database server/i;

function errorCode(error: unknown): string {
  if (!error || typeof error !== "object" || !("code" in error)) return "";
  return String((error as { code?: unknown }).code ?? "");
}

function rawSqlErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("meta" in error)) return undefined;
  const meta = (error as { meta?: unknown }).meta;
  if (!meta || typeof meta !== "object" || !("code" in meta)) return undefined;
  const code = (meta as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in error) {
    return String((error as { message?: unknown }).message ?? "");
  }
  return String(error);
}

export function summarizeDbError(error: unknown): string {
  const code = errorCode(error);
  const message = errorMessage(error).replace(/\s+/g, " ").trim();
  const firstLine = message.split("\n")[0]?.slice(0, 240) || "unknown database error";
  return code ? `${code}: ${firstLine}` : firstLine;
}

/**
 * True for a Postgres unique-violation (SQLSTATE 23505), reached either via
 * Prisma's structured P2002 (query builder) or P2010 wrapping a raw
 * `$queryRaw`/`$executeRaw` unique-violation.
 */
export function isUniqueConstraintViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    (error.code === "P2002" || (error.code === "P2010" && rawSqlErrorCode(error) === "23505"))
  );
}

/**
 * True for a Postgres serialization failure (SQLSTATE 40001) under
 * `Serializable` isolation, reached either via Prisma's structured P2034 or
 * P2010 wrapping a raw `$queryRaw`/`$executeRaw` serialization failure. The
 * caller should retry the whole transaction from scratch.
 */
export function isSerializationFailure(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    (error.code === "P2034" || (error.code === "P2010" && rawSqlErrorCode(error) === "40001"))
  );
}

/**
 * True for a Postgres foreign-key violation (SQLSTATE 23503) via Prisma's
 * structured P2003. Never transient — the referenced row genuinely does not
 * exist (or was deleted concurrently); retrying without changing the write
 * cannot succeed.
 */
export function isForeignKeyViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2003";
}

/**
 * Whether `withDbRetry` should transparently retry the failed operation.
 * Business-rule failures (unique/FK violations) are never transient.
 * Lock-wait timeouts (P1008) and serialization failures (P2034) are.
 */
export function isTransientDbError(error: unknown): boolean {
  if (isUniqueConstraintViolation(error) || isForeignKeyViolation(error)) return false;
  if (errorCode(error) === "P1008" || isSerializationFailure(error)) return true;
  return TRANSIENT_MESSAGE_RE.test(errorMessage(error));
}

async function defaultSleep(delayMs: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, delayMs));
}

function jitteredDelay(baseDelayMs: number, jitterMs: number): number {
  if (jitterMs <= 0) return baseDelayMs;
  return baseDelayMs + Math.floor(Math.random() * jitterMs);
}

/**
 * Retries `operation` with bounded exponential-ish backoff (caller-supplied
 * delay schedule) whenever the failure is classified transient by
 * `isTransientDbError`. Non-transient failures (including unique/FK
 * violations) are rethrown immediately on the first attempt.
 */
export async function withDbRetry<T>(
  operation: () => Promise<T>,
  context: DbRetryContext,
  options: DbRetryOptions = {},
): Promise<T> {
  const delaysMs = options.delaysMs ?? [...DEFAULT_DELAYS_MS];
  const sleep = options.sleep ?? defaultSleep;
  const jitterMs = options.jitterMs ?? DEFAULT_JITTER_MS;

  for (let index = 0; ; index += 1) {
    try {
      return await operation();
    } catch (error) {
      if (!isTransientDbError(error) || index >= delaysMs.length) {
        throw error;
      }

      const delay = jitteredDelay(delaysMs[index] ?? DEFAULT_DELAYS_MS.at(-1)!, jitterMs);
      const entry: DbRetryLogEntry = {
        op: context.op,
        attempt: index + 1,
        delay,
        error: summarizeDbError(error),
      };
      if (context.itemId !== undefined) entry.itemId = context.itemId;
      if (context.idempotencyKey !== undefined) entry.idempotencyKey = context.idempotencyKey;
      if (context.page !== undefined) entry.page = context.page;
      if (context.sourceKey !== undefined) entry.sourceKey = context.sourceKey;
      if (context.sourceItemId !== undefined) entry.sourceItemId = context.sourceItemId;
      if (context.sourceLanguageCode !== undefined) {
        entry.sourceLanguageCode = context.sourceLanguageCode;
      }
      if (context.sourceLocale !== undefined) entry.sourceLocale = context.sourceLocale;
      if (context.itemIndex !== undefined) entry.itemIndex = context.itemIndex;
      if (options.logger) {
        options.logger(entry);
      } else {
        console.warn("[db-retry]", JSON.stringify(entry));
      }
      await sleep(delay);
    }
  }
}
