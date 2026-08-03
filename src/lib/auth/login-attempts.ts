import { createHash } from "node:crypto";

import type { LoginAttemptStore } from "./ports";
import type { LoginAttemptRecord } from "./types";

export const ADMIN_LOGIN_MAX_FAILURES = 5;
export const ADMIN_LOGIN_LOCK_WINDOW_MS = 15 * 60 * 1000;

export type LoginRateLimitStatus = {
  locked: boolean;
  lockedUntil: Date | null;
  remainingMs: number;
};

export function normalizeAdminUsername(username: string): string {
  return username.trim().toLowerCase();
}

export function hashLoginAttemptIdentifier(kind: "user" | "ip", value: string): string {
  return createHash("sha256").update(`${kind}:${value.trim().toLowerCase()}`).digest("hex");
}

function activeRecord(record: LoginAttemptRecord | null, now: Date): LoginAttemptRecord | null {
  if (!record) return null;
  if (record.lockedUntil && record.lockedUntil.getTime() > now.getTime()) return record;
  if (now.getTime() - record.updatedAt.getTime() >= ADMIN_LOGIN_LOCK_WINDOW_MS) return null;
  return record.lockedUntil ? null : record;
}

function status(records: Array<LoginAttemptRecord | null>, now: Date): LoginRateLimitStatus {
  const lockedUntilMs = Math.max(
    0,
    ...records.map((record) => {
      const active = activeRecord(record, now);
      return active?.lockedUntil?.getTime() ?? 0;
    }),
  );
  return {
    locked: lockedUntilMs > now.getTime(),
    lockedUntil: lockedUntilMs ? new Date(lockedUntilMs) : null,
    remainingMs: Math.max(lockedUntilMs - now.getTime(), 0),
  };
}

function identifiers(username: string, ip: string): [string, string] {
  return [
    hashLoginAttemptIdentifier("user", normalizeAdminUsername(username)),
    hashLoginAttemptIdentifier("ip", ip || "unknown"),
  ];
}

export async function getLoginRateLimitStatus(
  store: LoginAttemptStore,
  username: string,
  ip: string,
  now = new Date(),
): Promise<LoginRateLimitStatus> {
  const keys = identifiers(username, ip);
  return status(await Promise.all(keys.map((key) => store.find(key))), now);
}

export async function recordFailedLogin(
  store: LoginAttemptStore,
  username: string,
  ip: string,
  now = new Date(),
): Promise<LoginRateLimitStatus> {
  const keys = identifiers(username, ip);
  await Promise.all(
    keys.map((identifierHash) =>
      store.recordFailure({
        identifierHash,
        now,
        windowMs: ADMIN_LOGIN_LOCK_WINDOW_MS,
        maxFailures: ADMIN_LOGIN_MAX_FAILURES,
      }),
    ),
  );
  return getLoginRateLimitStatus(store, username, ip, now);
}

export async function clearFailedLogins(
  store: LoginAttemptStore,
  username: string,
): Promise<void> {
  await store.clear(
    hashLoginAttemptIdentifier("user", normalizeAdminUsername(username)),
  );
}
