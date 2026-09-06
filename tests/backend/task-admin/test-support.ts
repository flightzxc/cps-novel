import { randomUUID } from "node:crypto";

import { Prisma, type PrismaClient } from "@prisma/client";

import { P2_04_ADMIN_REGISTRY } from "@/app/api/admin/_lib/registry";
import { ADMIN_ABSOLUTE_TIMEOUT_MS, hashAdminSessionToken } from "@/lib/auth/session";
import type { AdminIdentity, AdminSessionRecord } from "@/lib/auth/types";
import type { TaskFamily } from "@/lib/tasks";
import { requireAdminRouteAccess, type AdminServiceAuthorization } from "@/server/auth/guards";

import { TestOnlyInMemoryAuthStores } from "../auth/test-only-in-memory-stores";

export const NOW = new Date("2026-08-26T03:00:00.000Z");
export const ORIGIN = "https://admin.cps-novel.test";
export const TASK_ID = "10000000-0000-4000-8000-000000000001";
export const INTENT_ID = "20000000-0000-4000-8000-000000000001";

export function seedTaskAdmin(
  stores: TestOnlyInMemoryAuthStores,
  options: { identityId?: string; role?: string; twoFactorCompleted?: boolean } = {},
): { identity: AdminIdentity; session: AdminSessionRecord; token: string } {
  const identityId = options.identityId ?? "admin-1";
  const token = `task-token-${identityId}`;
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
    id: `task-session-${identityId}`,
    tokenHash: hashAdminSessionToken(token),
    identityId,
    sessionVersion: 1,
    issuedAt,
    lastSeenAt: NOW,
    absoluteExpiresAt: new Date(issuedAt.getTime() + ADMIN_ABSOLUTE_TIMEOUT_MS),
    twoFactorCompletedAt: (options.twoFactorCompleted ?? true) ? NOW : null,
    revokedAt: null,
  };
  stores.identities.set(identity.id, identity);
  stores.sessions.set(session.id, session);
  return { identity, session, token };
}

export async function issueTaskAuthorization(
  stores: TestOnlyInMemoryAuthStores,
  input: {
    token: string;
    pathname: "/api/admin/tasks/retry-failed" | "/api/admin/tasks/manual-reviews/resolve";
    requestId?: string;
    env?: NodeJS.ProcessEnv;
  },
): Promise<{ authorization: AdminServiceAuthorization; requestId: string }> {
  const requestId = input.requestId ?? randomUUID();
  const result = await requireAdminRouteAccess(
    {
      pathname: input.pathname,
      method: "POST",
      sessionToken: input.token,
      origin: ORIGIN,
      canonicalOrigin: ORIGIN,
      requestId,
    },
    {
      identities: stores,
      sessions: stores,
      registry: P2_04_ADMIN_REGISTRY,
      env: input.env,
      now: NOW,
    },
  );
  if (!result.serviceAuthorization) throw new Error("expected service authorization");
  return { authorization: result.serviceAuthorization, requestId };
}

export type FakeItem = {
  id: string;
  taskId: string;
  status: string;
  attemptCount: number;
  leaseEpoch: bigint;
  executionToken: string | null;
  lockedBy: string | null;
  lockedUntil: Date | null;
  heartbeatAt: Date | null;
  result: unknown;
  error: unknown;
  finishedAt: Date | null;
  returnedCount?: number | null;
  novelSourceItemId?: string;
  targetType?: string;
  targetId?: string;
  // Phase C step C-7: `createGenericRetryTask` copies this onto the new
  // sibling task's item so the worker can actually reprocess it (see the
  // doc comment on that function in service.ts for why).
  payload?: Prisma.JsonValue;
};

type FakeParent = {
  id: string;
  status: string;
  channelAccountId: string | null;
  channelAppId: string | null;
  totalCount: number;
  successCount: number;
  failedCount: number;
  skippedCount: number;
  completedAt: Date | null;
  result: unknown;
  error: unknown;
  // Phase C step C-7: read by `lockParent`'s SELECT (service.ts) so the
  // `generic`-family retry path can stand up a full sibling `GenericTask`.
  taskType: string;
  operationScopeHash: string;
  mode: string;
  params: Prisma.JsonValue;
};

type FakeGenericTaskRow = {
  id: string;
  taskType: string;
  originTaskId: string;
  requestToken: string;
};

type FakeIntent = {
  id: string;
  status: string;
  responseShape: Prisma.JsonValue | null;
  confirmedAt: Date | null;
};

type FakeAudit = {
  id: bigint;
  actorId: string | null;
  entityId: string;
  taskType: string | null;
  reason: string | null;
  afterSnapshot: Prisma.JsonValue | null;
  actorType: string;
  action: string;
  requestId: string | null;
  data: Record<string, unknown>;
};

function item(id: string, status: string, targetId?: string): FakeItem {
  return {
    id,
    taskId: TASK_ID,
    status,
    attemptCount: status === "failed" ? 7 : 2,
    leaseEpoch: status === "failed" ? 11n : 3n,
    executionToken: status === "failed" ? "30000000-0000-4000-8000-000000000001" : null,
    lockedBy: status === "failed" ? "worker-secret-name" : null,
    lockedUntil: status === "failed" ? NOW : null,
    heartbeatAt: status === "failed" ? NOW : null,
    result: status === "failed" ? { raw: "secret result" } : null,
    error: status === "failed" ? { upstreamCode: "secret-code", message: "secret" } : null,
    finishedAt: status === "failed" ? NOW : null,
    returnedCount: status === "failed" ? 99 : null,
    novelSourceItemId: targetId,
    targetType: targetId ? "novel_source_item" : undefined,
    targetId,
    payload: targetId ? { seededFrom: targetId } : undefined,
  };
}

export class TaskAdminFakeDb {
  readonly parents = new Map<TaskFamily, FakeParent>();
  readonly items = new Map<TaskFamily, FakeItem[]>();
  readonly intents = new Map<string, FakeIntent>();
  readonly audits: FakeAudit[] = [];
  unresolvedStatus: string | null = null;
  genericUnlinkedBlocked = false;
  manualReadBarrier = false;
  readonly itemUpdateCalls = new Map<TaskFamily, number>();
  readonly parentUpdateCalls = new Map<TaskFamily, number>();
  promoMutationCalls = 0;
  // Phase C step C-7: created `GenericTask` rows from `createGenericRetryTask`
  // (`genericTask.create` below), including their own items, plus a
  // `(taskType, originTaskId)` index that simulates the real
  // `generic_task_origin_key` UNIQUE constraint -- a second `create` for the
  // same pair throws the same `PrismaClientKnownRequestError` (P2002) shape
  // a live Postgres would, so `retryFailedTask`'s existing
  // `isUniqueConstraintViolation` catch is exercised for real, not stubbed.
  readonly createdGenericTasks: FakeGenericTaskRow[] = [];
  readonly createdGenericTaskItems = new Map<string, FakeItem[]>();
  private readonly genericOriginKeys = new Set<string>();

  private manualReads = 0;
  private releaseManualReads: (() => void) | null = null;
  private readonly manualReadsReady = new Promise<void>((resolve) => {
    this.releaseManualReads = resolve;
  });

  constructor() {
    for (const family of ["channel_sync", "generic"] as const) {
      this.parents.set(family, {
        id: TASK_ID,
        status: "completed_with_errors",
        channelAccountId: "40000000-0000-4000-8000-000000000001",
        channelAppId: "50000000-0000-4000-8000-000000000001",
        totalCount: 2,
        successCount: 1,
        failedCount: 1,
        skippedCount: 0,
        completedAt: NOW,
        result: { raw: "parent result" },
        error: { raw: "parent error" },
        taskType: family === "generic" ? "catalog_scan" : "moboreader.preview_refresh.v1",
        operationScopeHash: "a".repeat(64),
        mode: "apply",
        params: { seed: true },
      });
      this.items.set(family, [
        item("60000000-0000-4000-8000-000000000001", "failed", "source-1"),
        item("60000000-0000-4000-8000-000000000002", "failed", "source-2"),
        item("60000000-0000-4000-8000-000000000003", "success", "source-3"),
      ]);
    }
    this.intents.set(INTENT_ID, {
      id: INTENT_ID,
      status: "manual_review_required",
      responseShape: { safePriorMarker: true },
      confirmedAt: null,
    });
  }

  private familyDelegate(family: TaskFamily) {
    return {
      findMany: async (args: { where: { taskId: string; status?: string } }) =>
        (this.items.get(family) ?? []).filter((row) =>
          row.taskId === args.where.taskId && (!args.where.status || row.status === args.where.status)),
      updateMany: async (args: { where: { taskId: string; status: string }; data: Record<string, unknown> }) => {
        let count = 0;
        for (const row of this.items.get(family) ?? []) {
          if (row.taskId !== args.where.taskId || row.status !== args.where.status) continue;
          Object.assign(row, args.data);
          count += 1;
        }
        this.itemUpdateCalls.set(family, (this.itemUpdateCalls.get(family) ?? 0) + 1);
        return { count };
      },
      count: async (args: { where: { taskId: string; status?: string } }) =>
        (this.items.get(family) ?? []).filter((row) =>
          row.taskId === args.where.taskId && (!args.where.status || row.status === args.where.status)).length,
    };
  }

  private parentDelegate(family: TaskFamily) {
    return {
      update: async (args: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = this.parents.get(family);
        if (!row || row.id !== args.where.id) throw new Error("missing parent");
        Object.assign(row, args.data);
        this.parentUpdateCalls.set(family, (this.parentUpdateCalls.get(family) ?? 0) + 1);
        return row;
      },
    };
  }

  asPrismaClient(): PrismaClient {
    const channelItems = this.familyDelegate("channel_sync");
    const genericItems = this.familyDelegate("generic");
    const client = {
      $transaction: async (run: (tx: unknown) => Promise<unknown>) => run(client),
      $queryRaw: async (query: { strings: readonly string[]; values: readonly unknown[] }) => {
        const sql = query.strings.join("?");
        if (sql.includes("pg_advisory_xact_lock")) return [];
        for (const family of ["channel_sync", "generic"] as const) {
          const table = family === "channel_sync" ? "channel_sync_task" : "generic_task";
          if (sql.includes(`FROM ${table} WHERE id`)) {
            const row = this.parents.get(family);
            if (!row || row.id !== query.values[0]) return [];
            return [{
              id: row.id,
              status: row.status,
              channel_account_id: row.channelAccountId,
              channel_app_id: row.channelAppId,
              task_type: row.taskType,
              operation_scope_hash: row.operationScopeHash,
              mode: row.mode,
              params: row.params,
            }];
          }
        }
        if (sql.includes("SELECT EXISTS") && sql.includes("side_effect_intent")) {
          return [{ blocked: this.genericUnlinkedBlocked }];
        }
        throw new Error(`unexpected query: ${sql}`);
      },
      channelSyncTaskItem: channelItems,
      genericTaskItem: {
        ...genericItems,
        // Phase C step C-7: `createGenericRetryTask`'s sibling-task items.
        // Stored under the NEW task's own id (`createdGenericTaskItems`),
        // separate from `this.items.get("generic")` (the origin task's
        // fixture rows), the same separation two distinct `generic_task`
        // rows would have in real Postgres.
        createMany: async (args: { data: Array<Record<string, unknown>> }) => {
          for (const row of args.data) {
            const taskId = String(row.taskId);
            const list = this.createdGenericTaskItems.get(taskId) ?? [];
            list.push({
              id: randomUUID(),
              taskId,
              status: String(row.status),
              attemptCount: 0,
              leaseEpoch: 0n,
              executionToken: null,
              lockedBy: null,
              lockedUntil: null,
              heartbeatAt: null,
              result: null,
              error: null,
              finishedAt: null,
              targetType: String(row.targetType),
              targetId: String(row.targetId),
              payload: row.payload as Prisma.JsonValue,
            });
            this.createdGenericTaskItems.set(taskId, list);
          }
          return { count: args.data.length };
        },
      },
      channelSyncTask: this.parentDelegate("channel_sync"),
      genericTask: {
        ...this.parentDelegate("generic"),
        // Phase C step C-7: simulates `generic_task_origin_key`
        // (`@@unique([taskType, originTaskId])`) -- a second `create` for
        // the same `(taskType, originTaskId)` pair throws the same
        // `PrismaClientKnownRequestError` shape (P2002) a live Postgres
        // unique-violation would, so `retryFailedTask`'s existing
        // `isUniqueConstraintViolation` catch is exercised for real.
        create: async (args: { data: Record<string, unknown> }) => {
          const taskType = String(args.data.taskType);
          const originTaskId = args.data.originTaskId as string | undefined;
          if (originTaskId) {
            const key = `${taskType}:${originTaskId}`;
            if (this.genericOriginKeys.has(key)) {
              throw new Prisma.PrismaClientKnownRequestError(
                "Unique constraint failed on the fields: (`task_type`,`origin_task_id`)",
                { code: "P2002", clientVersion: "test", meta: { target: ["task_type", "origin_task_id"] } },
              );
            }
            this.genericOriginKeys.add(key);
          }
          const id = randomUUID();
          this.createdGenericTasks.push({
            id,
            taskType,
            originTaskId: originTaskId ?? "",
            requestToken: String(args.data.requestToken),
          });
          return { id };
        },
      },
      sideEffectIntent: {
        findFirst: async () => this.unresolvedStatus ? { id: "blocked-intent" } : null,
        findUnique: async (args: { where: { id: string } }) => {
          const row = this.intents.get(args.where.id) ?? null;
          if (this.manualReadBarrier) {
            this.manualReads += 1;
            if (this.manualReads === 2) this.releaseManualReads?.();
            await this.manualReadsReady;
          }
          return row ? { ...row } : null;
        },
        updateMany: async (args: {
          where: { id: string; status: string };
          data: { status: string; responseShape: Prisma.JsonValue; confirmedAt: Date };
        }) => {
          const row = this.intents.get(args.where.id);
          if (!row || row.status !== args.where.status) return { count: 0 };
          row.status = args.data.status;
          row.responseShape = args.data.responseShape;
          row.confirmedAt = args.data.confirmedAt;
          return { count: 1 };
        },
      },
      operationAudit: {
        findFirst: async (args: { where: { actorType: string; action: string; requestId: string } }) => {
          const row = this.audits.find((audit) => audit.actorType === args.where.actorType
            && audit.action === args.where.action && audit.requestId === args.where.requestId);
          return row ? {
            id: row.id,
            actorId: row.actorId,
            entityId: row.entityId,
            taskType: row.taskType,
            reason: row.reason,
            afterSnapshot: row.afterSnapshot,
          } : null;
        },
        create: async (args: { data: Record<string, unknown> }) => {
          const audit: FakeAudit = {
            id: BigInt(this.audits.length + 1),
            actorId: typeof args.data.actorId === "string" ? args.data.actorId : null,
            entityId: String(args.data.entityId),
            taskType: typeof args.data.taskType === "string" ? args.data.taskType : null,
            reason: typeof args.data.reason === "string" ? args.data.reason : null,
            afterSnapshot: (args.data.afterSnapshot ?? null) as Prisma.JsonValue | null,
            actorType: String(args.data.actorType),
            action: String(args.data.action),
            requestId: typeof args.data.requestId === "string" ? args.data.requestId : null,
            data: args.data,
          };
          this.audits.push(audit);
          return { id: audit.id };
        },
      },
      promoLink: {
        create: async () => { this.promoMutationCalls += 1; },
        update: async () => { this.promoMutationCalls += 1; },
        updateMany: async () => { this.promoMutationCalls += 1; return { count: 1 }; },
      },
    };
    return client as unknown as PrismaClient;
  }
}

export function newStores(): TestOnlyInMemoryAuthStores {
  return new TestOnlyInMemoryAuthStores();
}
