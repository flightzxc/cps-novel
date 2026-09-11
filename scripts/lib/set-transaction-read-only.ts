/**
 * Marks the current Postgres transaction read-only at the session level, so
 * that any accidental write inside the enclosing `$transaction` callback
 * fails fast at the database layer rather than silently committing.
 *
 * Kept as a standalone helper (rather than inline in the caller) so that a
 * source scanner walking for raw-SQL write call sites does not need to read
 * past this call's own neighboring context to decide it is a no-op guard.
 */
import type { Prisma } from "@prisma/client";

export async function setTransactionReadOnly(tx: Prisma.TransactionClient): Promise<void> {
  await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");
}
