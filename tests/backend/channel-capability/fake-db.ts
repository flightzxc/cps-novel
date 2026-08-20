/**
 * TEST_ONLY — a minimal hand-rolled in-memory double for exactly the Prisma
 * call shapes `src/server/channel-capability/service.ts` issues. Modeled on
 * `tests/backend/publish-gate/fake-db.ts`'s `FakePublishGateDb`: real
 * rollback-on-throw for `$transaction` via an undo log, not a general query
 * engine.
 */
import type { PrismaClient } from "@prisma/client";

export type FakeCapability = {
  id: string;
  channelAppId: string;
  capabilityKey: string;
  status: string;
};

export type FakeAudit = {
  id: bigint;
  actorType: string;
  actorId: string | null;
  action: string;
  entityType: string;
  entityId: string;
  requestId: string;
  reason?: string | null;
  beforeSnapshot?: unknown;
  afterSnapshot?: unknown;
};

export class FakeChannelCapabilityDb {
  readonly capabilities = new Map<string, FakeCapability>();
  readonly audits: FakeAudit[] = [];
  readonly calls: string[] = [];

  private nextAuditId = 1n;
  private undoLog: Array<() => void> | null = null;

  private logUndo(undo: () => void): void {
    this.undoLog?.push(undo);
  }

  seedCapability(capability: FakeCapability): this {
    this.capabilities.set(capability.id, { ...capability });
    return this;
  }

  private findByCompoundKey(channelAppId: string, capabilityKey: string): FakeCapability | undefined {
    for (const capability of this.capabilities.values()) {
      if (capability.channelAppId === channelAppId && capability.capabilityKey === capabilityKey) return capability;
    }
    return undefined;
  }

  private channelCapabilityFindUnique = async (args: {
    where: { id?: string; channelAppId_capabilityKey?: { channelAppId: string; capabilityKey: string } };
  }) => {
    this.calls.push("channelCapability.findUnique");
    if (args.where.id !== undefined) {
      const capability = this.capabilities.get(args.where.id);
      return capability ? { ...capability } : null;
    }
    const key = args.where.channelAppId_capabilityKey;
    if (key) {
      const capability = this.findByCompoundKey(key.channelAppId, key.capabilityKey);
      return capability ? { ...capability } : null;
    }
    return null;
  };

  private channelCapabilityUpdate = async (args: { where: { id: string }; data: { status: string } }) => {
    this.calls.push("channelCapability.update");
    const capability = this.capabilities.get(args.where.id);
    if (!capability) throw new Error(`channelCapability ${args.where.id} not found`);
    const prevStatus = capability.status;
    this.logUndo(() => {
      capability.status = prevStatus;
    });
    capability.status = args.data.status;
    return { ...capability };
  };

  private operationAuditFindFirst = async (args: {
    where: Pick<FakeAudit, "actorType" | "action" | "requestId">;
  }) => {
    this.calls.push("operationAudit.findFirst");
    const where = args.where;
    const found = this.audits.find(
      (audit) =>
        audit.actorType === where.actorType && audit.action === where.action && audit.requestId === where.requestId,
    );
    return found ? { ...found } : null;
  };

  private operationAuditCreate = async (args: { data: Omit<FakeAudit, "id"> }) => {
    this.calls.push("operationAudit.create");
    const audit: FakeAudit = { id: this.nextAuditId, ...args.data };
    this.nextAuditId += 1n;
    this.audits.push(audit);
    this.logUndo(() => {
      const index = this.audits.findIndex((entry) => entry.id === audit.id);
      if (index >= 0) this.audits.splice(index, 1);
    });
    return { ...audit };
  };

  private buildClient(): FakeClient {
    const client: FakeClient = {
      channelCapability: {
        findUnique: this.channelCapabilityFindUnique,
        update: this.channelCapabilityUpdate,
      },
      operationAudit: {
        findFirst: this.operationAuditFindFirst,
        create: this.operationAuditCreate,
      },
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
}

type FakeClient = {
  channelCapability: {
    findUnique: (args: {
      where: { id?: string; channelAppId_capabilityKey?: { channelAppId: string; capabilityKey: string } };
    }) => Promise<unknown>;
    update: (args: { where: { id: string }; data: { status: string } }) => Promise<unknown>;
  };
  operationAudit: {
    findFirst: (args: { where: Pick<FakeAudit, "actorType" | "action" | "requestId"> }) => Promise<unknown>;
    create: (args: { data: Omit<FakeAudit, "id"> }) => Promise<unknown>;
  };
  $transaction: <T>(callback: (tx: FakeClient) => Promise<T>) => Promise<T>;
};
