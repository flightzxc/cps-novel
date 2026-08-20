/**
 * TEST_ONLY — a minimal hand-rolled in-memory double for exactly the Prisma
 * call shapes `worker/handlers/promo-link-claim.ts` and
 * `src/lib/tasks/side-effect-intent.ts` issue. Same design as
 * `tests/backend/publish-gate/fake-db.ts` (see that file's header for the
 * `$transaction`/`undoLog` reasoning) — not a general query engine, one
 * method per real call shape.
 */
import type { PrismaClient } from "@prisma/client";

export type FakeNovelSourceItem = {
  id: string;
  channelAppId: string;
  novelId: string | null;
  status: string;
  deletedAt: Date | null;
  rawPayload: unknown;
};
export type FakeChannelApp = { id: string; status: string; channelId: string; channelStatus: string; projectType: number };
export type FakeChannelAccount = { id: string; channelId: string; status: string; deletedAt: Date | null };
export type FakeChannelCapability = { channelAppId: string; capabilityKey: string; status: string; sideEffecting: boolean };
export type FakeChannelCredential = {
  id: string;
  channelAccountId: string;
  status: string;
  encryptedSecret: Uint8Array;
  keyVersion: number;
  expiresAt: Date | null;
};
export type FakePromoLink = {
  id: string;
  novelId: string;
  novelSourceItemId: string;
  channelAppId: string;
  channelAccountId: string;
  offerType: string;
  origin: string;
  upstreamCode: string | null;
  publicRedirectCode: string;
  webUrl: string | null;
  appUrl: string | null;
  idempotencyKey: string;
  status: string;
  errorKind: string | null;
  errorMessage: string | null;
  fetchedAt: Date | null;
  lastAttemptedAt: Date | null;
};
export type FakeSideEffectIntent = {
  id: string;
  effectKey: string;
  operationType: string;
  idempotencyKey: string;
  targetType: string;
  targetId: string;
  channelAccountId: string | null;
  channelAppId: string | null;
  status: string;
  requestSummary: unknown;
  responseShape: unknown;
  createdAt: Date;
};
export type FakeAudit = { actorType: string; actorId: string; action: string; entityType: string; entityId: string; requestId: string; afterSnapshot?: unknown };

let idCounter = 0;
function nextId(prefix: string): string {
  idCounter += 1;
  return `${prefix}-${idCounter}`;
}

export class FakePromoLinkClaimHandlerDb {
  readonly sourceItems = new Map<string, FakeNovelSourceItem>();
  readonly channelApps = new Map<string, FakeChannelApp>();
  readonly channelAccounts = new Map<string, FakeChannelAccount>();
  readonly capabilities = new Map<string, FakeChannelCapability>();
  readonly credentials: FakeChannelCredential[] = [];
  readonly promoLinks = new Map<string, FakePromoLink>();
  readonly intents = new Map<string, FakeSideEffectIntent>();
  readonly audits: FakeAudit[] = [];
  readonly calls: string[] = [];
  private undoLog: Array<() => void> | null = null;

  private logUndo(undo: () => void): void {
    this.undoLog?.push(undo);
  }

  seedSourceItem(item: FakeNovelSourceItem): this {
    this.sourceItems.set(item.id, item);
    return this;
  }

  seedChannelApp(app: FakeChannelApp): this {
    this.channelApps.set(app.id, app);
    return this;
  }

  seedChannelAccount(account: FakeChannelAccount): this {
    this.channelAccounts.set(account.id, account);
    return this;
  }

  seedCapability(capability: FakeChannelCapability): this {
    this.capabilities.set(`${capability.channelAppId}\n${capability.capabilityKey}`, capability);
    return this;
  }

  seedCredential(credential: FakeChannelCredential): this {
    this.credentials.push(credential);
    return this;
  }

  promoLinkByIdempotencyKey(idempotencyKey: string): FakePromoLink | undefined {
    return [...this.promoLinks.values()].find((row) => row.idempotencyKey === idempotencyKey);
  }

  private novelSourceItemFindUnique = async (args: { where: { id: string } }) => {
    this.calls.push("novelSourceItem.findUnique");
    return this.sourceItems.get(args.where.id) ? { ...this.sourceItems.get(args.where.id)! } : null;
  };

  private channelAppFindFirst = async (args: { where: { id: string } }) => {
    this.calls.push("channelApp.findFirst");
    const app = this.channelApps.get(args.where.id);
    if (!app || app.status !== "active" || app.channelStatus !== "active") return null;
    return { id: app.id, channelId: app.channelId, projectType: app.projectType };
  };

  private channelAccountFindFirst = async (args: { where: { id: string; channelId: string } }) => {
    this.calls.push("channelAccount.findFirst");
    const account = this.channelAccounts.get(args.where.id);
    if (!account || account.channelId !== args.where.channelId || account.status !== "active" || account.deletedAt !== null) {
      return null;
    }
    return { id: account.id };
  };

  private channelCapabilityFindUnique = async (args: {
    where: { channelAppId_capabilityKey: { channelAppId: string; capabilityKey: string } };
  }) => {
    this.calls.push("channelCapability.findUnique");
    const key = `${args.where.channelAppId_capabilityKey.channelAppId}\n${args.where.channelAppId_capabilityKey.capabilityKey}`;
    const capability = this.capabilities.get(key);
    return capability ? { status: capability.status, sideEffecting: capability.sideEffecting } : null;
  };

  private channelAccountCredentialFindMany = async (args: { where: { channelAccountId: string; status: string } }) => {
    this.calls.push("channelAccountCredential.findMany");
    return this.credentials
      .filter((row) => row.channelAccountId === args.where.channelAccountId && row.status === args.where.status)
      .map((row) => ({ id: row.id, encryptedSecret: row.encryptedSecret, keyVersion: row.keyVersion, expiresAt: row.expiresAt }));
  };

  private promoLinkFindUnique = async (args: { where: { idempotencyKey: string }; select?: unknown }) => {
    this.calls.push("promoLink.findUnique");
    const row = this.promoLinkByIdempotencyKey(args.where.idempotencyKey);
    return row ? { ...row } : null;
  };

  private promoLinkUpsert = async (args: {
    where: { idempotencyKey: string };
    create: Omit<FakePromoLink, "id" | "status" | "errorKind" | "errorMessage" | "fetchedAt" | "lastAttemptedAt" | "upstreamCode" | "webUrl" | "appUrl" | "origin"> & Partial<FakePromoLink>;
    update: Record<string, never>;
  }) => {
    this.calls.push("promoLink.upsert");
    const existing = this.promoLinkByIdempotencyKey(args.where.idempotencyKey);
    if (existing) return { id: existing.id, publicRedirectCode: existing.publicRedirectCode };
    if ([...this.promoLinks.values()].some((row) => row.publicRedirectCode === args.create.publicRedirectCode)) {
      const error = new Error("Unique constraint failed on publicRedirectCode") as Error & { code: string; meta: { target: string[] } };
      error.code = "P2002";
      error.meta = { target: ["promo_link_public_redirect_code_key"] };
      throw error;
    }
    const id = nextId("promo-link");
    const row: FakePromoLink = {
      id,
      novelId: args.create.novelId as string,
      novelSourceItemId: args.create.novelSourceItemId as string,
      channelAppId: args.create.channelAppId as string,
      channelAccountId: args.create.channelAccountId as string,
      offerType: args.create.offerType as string,
      origin: (args.create.origin as string) ?? "upstream_existing",
      upstreamCode: args.create.upstreamCode ?? null,
      publicRedirectCode: args.create.publicRedirectCode as string,
      webUrl: args.create.webUrl ?? null,
      appUrl: args.create.appUrl ?? null,
      idempotencyKey: args.create.idempotencyKey as string,
      status: (args.create.status as string) ?? "pending",
      errorKind: args.create.errorKind ?? null,
      errorMessage: args.create.errorMessage ?? null,
      fetchedAt: args.create.fetchedAt ?? null,
      lastAttemptedAt: args.create.lastAttemptedAt ?? null,
    };
    this.promoLinks.set(id, row);
    this.logUndo(() => this.promoLinks.delete(id));
    return { id, publicRedirectCode: row.publicRedirectCode };
  };

  private promoLinkUpdate = async (args: { where: { idempotencyKey: string }; data: Partial<FakePromoLink> }) => {
    this.calls.push("promoLink.update");
    const row = this.promoLinkByIdempotencyKey(args.where.idempotencyKey);
    if (!row) throw new Error(`promo_link ${args.where.idempotencyKey} not found`);
    const before = { ...row };
    this.logUndo(() => Object.assign(row, before));
    Object.assign(row, args.data);
    return { ...row };
  };

  private sideEffectIntentFindUnique = async (args: { where: { effectKey: string } }) => {
    this.calls.push("sideEffectIntent.findUnique");
    const row = this.intents.get(args.where.effectKey);
    return row ? { ...row } : null;
  };

  private sideEffectIntentFindUniqueOrThrow = async (args: { where: { id: string } }) => {
    this.calls.push("sideEffectIntent.findUniqueOrThrow");
    const row = [...this.intents.values()].find((intent) => intent.id === args.where.id);
    if (!row) throw new Error(`side_effect_intent ${args.where.id} not found`);
    return { ...row };
  };

  private sideEffectIntentFindFirst = async (args: {
    where: { targetType: string; targetId: string; status: { in: string[] } };
    orderBy: { createdAt: "desc" | "asc" };
  }) => {
    this.calls.push("sideEffectIntent.findFirst");
    const rows = [...this.intents.values()]
      .filter((row) => row.targetType === args.where.targetType && row.targetId === args.where.targetId && args.where.status.in.includes(row.status))
      .sort((a, b) => (args.orderBy.createdAt === "desc" ? b.createdAt.getTime() - a.createdAt.getTime() : a.createdAt.getTime() - b.createdAt.getTime()));
    return rows[0] ? { ...rows[0] } : null;
  };

  private sideEffectIntentCreate = async (args: { data: Omit<FakeSideEffectIntent, "id" | "createdAt" | "status"> & Partial<FakeSideEffectIntent> }) => {
    this.calls.push("sideEffectIntent.create");
    const id = nextId("intent");
    const row: FakeSideEffectIntent = {
      id,
      effectKey: args.data.effectKey,
      operationType: args.data.operationType,
      idempotencyKey: args.data.idempotencyKey,
      targetType: args.data.targetType,
      targetId: args.data.targetId,
      channelAccountId: args.data.channelAccountId ?? null,
      channelAppId: args.data.channelAppId ?? null,
      status: "prepared",
      requestSummary: args.data.requestSummary ?? {},
      responseShape: null,
      createdAt: new Date(),
    };
    this.intents.set(row.effectKey, row);
    this.logUndo(() => this.intents.delete(row.effectKey));
    return { ...row };
  };

  private sideEffectIntentUpdateMany = async (args: {
    where: { id: string; status: string };
    data: { status: string; responseShape?: unknown; confirmedAt?: Date };
  }) => {
    this.calls.push("sideEffectIntent.updateMany");
    const row = [...this.intents.values()].find((intent) => intent.id === args.where.id);
    if (!row || row.status !== args.where.status) return { count: 0 };
    const before = { ...row };
    this.logUndo(() => Object.assign(row, before));
    row.status = args.data.status;
    if (args.data.responseShape !== undefined) row.responseShape = args.data.responseShape;
    return { count: 1 };
  };

  private operationAuditCreate = async (args: { data: FakeAudit }) => {
    this.calls.push("operationAudit.create");
    this.audits.push({ ...args.data });
    this.logUndo(() => {
      this.audits.pop();
    });
    return { ...args.data };
  };

  private buildClient(): FakeClient {
    const client: FakeClient = {
      novelSourceItem: { findUnique: this.novelSourceItemFindUnique },
      channelApp: { findFirst: this.channelAppFindFirst },
      channelAccount: { findFirst: this.channelAccountFindFirst },
      channelCapability: { findUnique: this.channelCapabilityFindUnique },
      channelAccountCredential: { findMany: this.channelAccountCredentialFindMany },
      promoLink: { findUnique: this.promoLinkFindUnique, upsert: this.promoLinkUpsert, update: this.promoLinkUpdate },
      sideEffectIntent: {
        findUnique: this.sideEffectIntentFindUnique,
        findUniqueOrThrow: this.sideEffectIntentFindUniqueOrThrow,
        findFirst: this.sideEffectIntentFindFirst,
        create: this.sideEffectIntentCreate,
        updateMany: this.sideEffectIntentUpdateMany,
      },
      operationAudit: { create: this.operationAuditCreate },
      $transaction: async (callback) => {
        const previousLog = this.undoLog;
        this.undoLog = [];
        const thisLog = this.undoLog;
        try {
          const result = await callback(client);
          this.undoLog = previousLog;
          return result;
        } catch (error) {
          for (let i = thisLog.length - 1; i >= 0; i -= 1) thisLog[i]();
          this.undoLog = previousLog;
          throw error;
        }
      },
    };
    return client;
  }

  private readonly client: FakeClient = this.buildClient();

  asPrismaClient(): PrismaClient {
    return this.client as unknown as PrismaClient;
  }

  /** Test-only helper: runs `fn` as a `protectedWrite`-shaped call directly against the (non-transactional) top-level client, for assertions that don't need transactional isolation. */
  async runProtectedWrite(fn: (tx: PrismaClient) => Promise<void>): Promise<void> {
    await fn(this.asPrismaClient());
  }
}

type FakeClient = Record<string, any> & { $transaction: <T>(callback: (tx: FakeClient) => Promise<T>) => Promise<T> };
