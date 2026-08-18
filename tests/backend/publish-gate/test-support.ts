/**
 * TEST_ONLY support for `tests/backend/publish-gate/**`.
 *
 * Reuses `tests/backend/auth/test-only-in-memory-stores.ts` (the same
 * in-memory `AdminIdentityStore`/`SessionStore` pair `tests/backend/auth/
 * session-capabilities.test.ts` uses) rather than mocking
 * `requireFreshAdminServiceMutation` away — issuing a real
 * `AdminServiceAuthorization` through the real `requireAdminActionAccess`
 * guard is what proves the admin-facing wrappers in
 * `src/server/publish-gate/service.ts` are actually wired to capability
 * enforcement, not just shaped like they are.
 */
import { randomUUID } from "node:crypto";

import { ADMIN_ABSOLUTE_TIMEOUT_MS, hashAdminSessionToken } from "@/lib/auth/session";
import type { AdminIdentity, AdminSessionRecord } from "@/lib/auth/types";
import { requireAdminActionAccess, type AdminServiceAuthorization } from "@/server/auth/guards";
import type { AdminRegistry } from "@/server/auth/registry";

import { TestOnlyInMemoryAuthStores } from "../auth/test-only-in-memory-stores";

export const NOW = new Date("2026-08-18T00:00:00.000Z");
export const ORIGIN = "https://admin.cps-novel.test";

/**
 * Mirrors `src/server/credentials/registry.ts`'s shape for the actions this
 * PR's admin wrappers resolve against
 * (`publishArticleAsAdmin`/`publishArticlesBatchAsAdmin`/`withdrawNovel`/
 * `takedownNovel`/`restoreNovel`). Not the production registry — this PR
 * deliberately does not wire these into `src/app/api/admin/_lib/deps.ts`
 * (frozen; see `service.ts`'s module header) since no admin screen calls
 * them yet.
 */
const TEST_ACTIONS = [
  { id: "admin.article.publish", capability: "content:publish", mutation: true },
  { id: "admin.article.publish_batch", capability: "content:publish", mutation: true },
  { id: "admin.novel.withdraw", capability: "content:publish", mutation: true },
  { id: "admin.novel.takedown", capability: "content:takedown", mutation: true },
  { id: "admin.novel.restore", capability: "content:takedown", mutation: true },
] as const satisfies AdminRegistry["actions"];

export const TEST_PUBLISH_GATE_REGISTRY: AdminRegistry = Object.freeze({
  pageRoots: Object.freeze([]),
  routes: Object.freeze([]),
  actions: TEST_ACTIONS,
});

export function seedAdmin(
  stores: TestOnlyInMemoryAuthStores,
  options: { identityId?: string; role?: string; twoFactorCompleted?: boolean } = {},
): { identity: AdminIdentity; session: AdminSessionRecord; token: string } {
  const identityId = options.identityId ?? "admin-1";
  const token = `token-${identityId}`;
  const identity: AdminIdentity = {
    id: identityId,
    username: identityId,
    role: options.role ?? "super_admin",
    status: "active",
    sessionVersion: 1,
    twoFactorEnabled: true,
  };
  const issuedAt = new Date(NOW.getTime() - 60_000);
  const session: AdminSessionRecord = {
    id: `session-${identityId}`,
    tokenHash: hashAdminSessionToken(token),
    identityId,
    sessionVersion: 1,
    issuedAt,
    lastSeenAt: NOW,
    // Must not exceed issuedAt + ADMIN_ABSOLUTE_TIMEOUT_MS — validateAdminSession
    // treats a later value as a malformed record, not merely "expired".
    absoluteExpiresAt: new Date(issuedAt.getTime() + ADMIN_ABSOLUTE_TIMEOUT_MS),
    twoFactorCompletedAt: (options.twoFactorCompleted ?? true) ? NOW : null,
    revokedAt: null,
  };
  stores.identities.set(identity.id, identity);
  stores.sessions.set(session.id, session);
  return { identity, session, token };
}

/**
 * Issues a real, guard-checked `AdminServiceAuthorization` for `actionId`,
 * exactly the way a Server Action would via `requireAdminActionAccess`.
 * Returns the `requestId` alongside it because
 * `requireFreshAdminServiceMutation` binds the two together — the caller
 * must pass the same `requestId` through to the service call.
 */
export async function issueAuthorization(
  stores: TestOnlyInMemoryAuthStores,
  actionId: string,
  token: string,
): Promise<{ authorization: AdminServiceAuthorization; requestId: string }> {
  const requestId = randomUUID();
  const { serviceAuthorization } = await requireAdminActionAccess(
    { actionId, sessionToken: token, origin: ORIGIN, canonicalOrigin: ORIGIN, requestId },
    { identities: stores, sessions: stores, registry: TEST_PUBLISH_GATE_REGISTRY, now: NOW },
  );
  if (!serviceAuthorization) throw new Error(`expected a serviceAuthorization for ${actionId}`);
  return { authorization: serviceAuthorization, requestId };
}

export function newStores(): TestOnlyInMemoryAuthStores {
  return new TestOnlyInMemoryAuthStores();
}
