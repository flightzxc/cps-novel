/**
 * TEST_ONLY — minimal hand-rolled in-memory double for exactly the Prisma
 * call shapes `src/lib/tasks/promo-link-claim.ts`'s `createPromoLinkClaimTask`
 * issues. Same design as `tests/backend/publish-gate/fake-db.ts`.
 */
import type { PrismaClient } from "@prisma/client";

export type FakeGenericTask = {
  id: string;
  taskType: string;
  channelAccountId: string | null;
  channelAppId: string | null;
  operationScopeHash: string;
  mode: string;
  status: string;
  requestToken: string;
  createdAt: Date;
};
export type FakeGenericTaskItem = { id: string; taskId: string; targetType: string; targetId: string; payload: unknown };
export type FakeChannelApp = { id: string; status: string; channelId: string; channelStatus: string };
export type FakeChannelAccount = { id: string; channelId: string; status: string; deletedAt: Date | null };
export type FakeNovelSourceItem = { id: string; channelAppId: string; novelId: string | null; status: string; deletedAt: Date | null };

let idCounter = 0;
function nextItemId(): string {
  idCounter += 1;
  return `item-${idCounter}`;
}

function prismaUniqueError(target: string): Error & { code: string; meta: { target: string[] } } {
  const error = new Error(`Unique constraint failed on ${target}`) as Error & { code: string; meta: { target: string[] } };
  error.code = "P2002";
  error.meta = { target: [target] };
  return error;
}

export class FakePromoLinkClaimTaskDb {
  readonly tasks = new Map<string, FakeGenericTask>();
  readonly items: FakeGenericTaskItem[] = [];
  readonly channelApps = new Map<string, FakeChannelApp>();
  readonly channelAccounts = new Map<string, FakeChannelAccount>();
  readonly sourceItems = new Map<string, FakeNovelSourceItem>();
  readonly audits: unknown[] = [];
  readonly calls: string[] = [];

  seedChannelApp(app: FakeChannelApp): this {
    this.channelApps.set(app.id, app);
    return this;
  }

  seedChannelAccount(account: FakeChannelAccount): this {
    this.channelAccounts.set(account.id, account);
    return this;
  }

  seedSourceItem(item: FakeNovelSourceItem): this {
    this.sourceItems.set(item.id, item);
    return this;
  }

  /** Seeds a pre-existing active GenericTask + one item, for overlap/active-conflict tests. */
  seedActiveTask(task: FakeGenericTask, items: Array<{ targetType: string; targetId: string }>): this {
    this.tasks.set(task.id, task);
    for (const item of items) this.items.push({ id: nextItemId(), taskId: task.id, ...item, payload: {} });
    return this;
  }

  private genericTaskFindUnique = async (args: { where: { requestToken?: string; id?: string } }) => {
    this.calls.push("genericTask.findUnique");
    if (args.where.requestToken !== undefined) {
      const found = [...this.tasks.values()].find((task) => task.requestToken === args.where.requestToken);
      return found ? { ...found } : null;
    }
    const found = this.tasks.get(args.where.id as string);
    return found ? { ...found } : null;
  };

  private genericTaskFindFirst = async (args: {
    where: {
      taskType: string;
      channelAccountId: string;
      channelAppId: string;
      operationScopeHash: string;
      status: { in: string[] };
    };
  }) => {
    this.calls.push("genericTask.findFirst");
    const candidates = [...this.tasks.values()]
      .filter(
        (task) =>
          task.taskType === args.where.taskType &&
          task.channelAccountId === args.where.channelAccountId &&
          task.channelAppId === args.where.channelAppId &&
          task.operationScopeHash === args.where.operationScopeHash &&
          args.where.status.in.includes(task.status),
      )
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    return candidates[0] ? { id: candidates[0].id } : null;
  };

  private genericTaskCreate = async (args: {
    data: FakeGenericTask & { items?: { create: Array<{ targetType: string; targetId: string; payload: unknown }> } };
  }) => {
    this.calls.push("genericTask.create");
    const { items, ...taskData } = args.data;
    if ([...this.tasks.values()].some((task) => task.requestToken === taskData.requestToken)) {
      throw prismaUniqueError("generic_task_request_token_key");
    }
    if (["pending", "processing"].includes(taskData.status)) {
      const clash = [...this.tasks.values()].some(
        (task) =>
          ["pending", "processing"].includes(task.status) &&
          task.taskType === taskData.taskType &&
          task.channelAccountId === taskData.channelAccountId &&
          task.channelAppId === taskData.channelAppId &&
          task.operationScopeHash === taskData.operationScopeHash,
      );
      if (clash) throw prismaUniqueError("generic_task_active_scope_uidx");
    }
    this.tasks.set(taskData.id, { ...taskData, createdAt: new Date() });
    for (const item of items?.create ?? []) {
      this.items.push({ id: nextItemId(), taskId: taskData.id, ...item });
    }
    return { id: taskData.id };
  };

  private genericTaskItemFindMany = async (args: {
    where: { targetType: string; targetId: { in: string[] }; task: { taskType: string; status: { in: string[] } } };
  }) => {
    this.calls.push("genericTaskItem.findMany");
    const results = this.items.filter((item) => {
      if (item.targetType !== args.where.targetType) return false;
      if (!args.where.targetId.in.includes(item.targetId)) return false;
      const task = this.tasks.get(item.taskId);
      if (!task) return false;
      return task.taskType === args.where.task.taskType && args.where.task.status.in.includes(task.status);
    });
    return results.map((item) => ({ targetId: item.targetId }));
  };

  private channelAppFindFirst = async (args: { where: { id: string } }) => {
    this.calls.push("channelApp.findFirst");
    const app = this.channelApps.get(args.where.id);
    if (!app || app.status !== "active" || app.channelStatus !== "active") return null;
    return { id: app.id };
  };

  private novelSourceItemFindMany = async (args: { where: { id: { in: string[] }; channelAppId: string } }) => {
    this.calls.push("novelSourceItem.findMany");
    return args.where.id.in
      .map((id) => this.sourceItems.get(id))
      .filter((item): item is FakeNovelSourceItem => Boolean(item) && item!.channelAppId === args.where.channelAppId)
      .map((item) => ({ id: item.id, novelId: item.novelId, status: item.status, deletedAt: item.deletedAt }));
  };

  private operationAuditCreate = async (args: { data: unknown }) => {
    this.calls.push("operationAudit.create");
    this.audits.push(args.data);
    return args.data;
  };

  private buildClient(): FakeClient {
    const client: FakeClient = {
      genericTask: { findUnique: this.genericTaskFindUnique, findFirst: this.genericTaskFindFirst, create: this.genericTaskCreate },
      genericTaskItem: { findMany: this.genericTaskItemFindMany },
      channelApp: { findFirst: this.channelAppFindFirst },
      novelSourceItem: { findMany: this.novelSourceItemFindMany },
      operationAudit: { create: this.operationAuditCreate },
      $transaction: async (callback) => callback(client),
    };
    return client;
  }

  private readonly client: FakeClient = this.buildClient();

  asPrismaClient(): PrismaClient {
    return this.client as unknown as PrismaClient;
  }
}

type FakeClient = Record<string, any> & { $transaction: <T>(callback: (tx: FakeClient) => Promise<T>) => Promise<T> };
