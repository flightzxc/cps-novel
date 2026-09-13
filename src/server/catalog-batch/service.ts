import type { Prisma, PrismaClient } from "@prisma/client";
import { deriveCatalogBatchPhase, type CatalogBatchContext, type CatalogBatchSummary, type NormalizedCatalogSelection } from "@/domain/catalog-batch";
import { CATALOG_BATCH_CHUNK_SIZE, CATALOG_BATCH_TASK_TYPE } from "@/lib/tasks/catalog-batch";

const UNKNOWN_LOCALE = "__unknown";

export function catalogSelectionWhere(selection: NormalizedCatalogSelection): Prisma.NovelSourceItemWhereInput {
  if (selection.scope === "explicit_ids") return { id: { in: [...selection.ids] }, deletedAt: null };
  const { status, search, sourceLocale } = selection.filter;
  return {
    deletedAt: null, status,
    ...(search ? { title: { contains: search, mode: "insensitive" } } : {}),
    ...(sourceLocale ? { sourceLocale: sourceLocale === UNKNOWN_LOCALE ? null : sourceLocale } : {}),
  };
}

async function eachExplicitSelected(
  db: PrismaClient,
  selection: NormalizedCatalogSelection,
  visit: (rows: readonly { id: string; channelAppId: string; sourceLocale: string | null; status: string; novelId: string | null }[]) => Promise<void> | void,
): Promise<number> {
  let count = 0;
  if (selection.scope === "explicit_ids") {
    for (let i = 0; i < selection.ids.length; i += CATALOG_BATCH_CHUNK_SIZE) {
      const rows = await db.novelSourceItem.findMany({
        where: { id: { in: selection.ids.slice(i, i + CATALOG_BATCH_CHUNK_SIZE) }, deletedAt: null },
        orderBy: { id: "asc" }, select: { id: true, channelAppId: true, sourceLocale: true, status: true, novelId: true },
      });
      count += rows.length; await visit(rows);
    }
    return count;
  }
  throw new Error("all_filtered_must_use_aggregate_queries");
}

export async function readCatalogBatchContext(db: PrismaClient, selection: NormalizedCatalogSelection): Promise<CatalogBatchContext> {
  const channelCounts = new Map<string, number>();
  const localeCounts = new Map<string, number>();
  let submittedCount: number;
  if (selection.scope === "all_filtered") {
    const where = catalogSelectionWhere(selection);
    const [total, channels, locales] = await Promise.all([
      db.novelSourceItem.count({ where }),
      db.novelSourceItem.groupBy({
        by: ["channelAppId"], where: { AND: [where, { status: "linked", novelId: { not: null } }] }, _count: { _all: true },
      }),
      db.novelSourceItem.groupBy({
        by: ["sourceLocale"], where: { AND: [where, { status: "pending", novelId: null }] }, _count: { _all: true },
      }),
    ]);
    submittedCount = total;
    for (const row of channels) channelCounts.set(row.channelAppId, row._count._all);
    for (const row of locales) localeCounts.set(row.sourceLocale ?? UNKNOWN_LOCALE, row._count._all);
  } else {
    submittedCount = await eachExplicitSelected(db, selection, (rows) => {
      for (const row of rows) {
        if (row.status === "linked" && row.novelId) channelCounts.set(row.channelAppId, (channelCounts.get(row.channelAppId) ?? 0) + 1);
        if (row.status === "pending" && !row.novelId) {
          const locale = row.sourceLocale ?? UNKNOWN_LOCALE;
          localeCounts.set(locale, (localeCounts.get(locale) ?? 0) + 1);
        }
      }
    });
  }
  const channelIds = [...channelCounts.keys()];
  const channels: Array<{ id: string; status: string; capabilities: Array<{ status: string }>; channel: {
    code: string; name: string; status: string; channelAccounts: Array<{ id: string; accountName: string }>;
  } }> = [];
  for (let i = 0; i < channelIds.length; i += CATALOG_BATCH_CHUNK_SIZE) {
    channels.push(...await db.channelApp.findMany({
      where: { id: { in: channelIds.slice(i, i + CATALOG_BATCH_CHUNK_SIZE) } },
      select: { id: true, status: true, capabilities: { where: { capabilityKey: "claimPromo" }, select: { status: true } }, channel: { select: { code: true, name: true, status: true, channelAccounts: {
        where: { status: "active", deletedAt: null }, orderBy: { createdAt: "asc" }, select: { id: true, accountName: true },
      } } } },
    }));
  }
  return {
    submittedCount,
    channelGroups: channels.map((row) => ({
      channelAppId: row.id, channelCode: row.channel.code, channelName: row.channel.name,
      active: row.status === "active" && row.channel.status === "active",
      claimCapabilityEnabled: row.capabilities.some((capability) => capability.status === "enabled"),
      eligibleCount: channelCounts.get(row.id) ?? 0,
      accounts: row.channel.channelAccounts.map((account) => ({ id: account.id, name: account.accountName })),
    })),
    locales: [...localeCounts].sort(([a], [b]) => a.localeCompare(b)).map(([locale, eligibleCount]) => ({
      locale, eligibleCount,
      templates: [],
    })),
  };
}

export async function readCatalogBatchSummary(db: PrismaClient, taskId: string, actorId: string): Promise<CatalogBatchSummary | null> {
  const parent = await db.genericTask.findFirst({
    where: { id: taskId, taskType: CATALOG_BATCH_TASK_TYPE },
    select: { id: true, status: true, params: true, result: true, items: { select: { status: true }, take: 1 },
      childTasks: { select: { status: true, totalCount: true, successCount: true, failedCount: true, skippedCount: true } } },
  });
  if (!parent) return null;
  const params = parent.params && typeof parent.params === "object" && !Array.isArray(parent.params) ? parent.params as Record<string, unknown> : {};
  if (params.actorId !== actorId) return null;
  const result = parent.result && typeof parent.result === "object" && !Array.isArray(parent.result) ? parent.result as Record<string, unknown> : {};
  const submittedCount = typeof result.submittedCount === "number" ? result.submittedCount : null;
  const ineligibleCount = typeof result.ineligibleCount === "number" ? result.ineligibleCount : null;
  const enumeration = result.enumerationStatus;
  const blockedCount = result.blockedReasonCounts && typeof result.blockedReasonCounts === "object"
    ? Object.values(result.blockedReasonCounts as Record<string, unknown>).reduce<number>((sum, value) => sum + (typeof value === "number" && value > 0 ? value : 0), 0) : 0;
  const phase = deriveCatalogBatchPhase({ parentStatus: parent.status, enumerationStatus: enumeration,
    childStatuses: parent.childTasks.map((task) => task.status), blockedCount });
  return { taskId, phase, submittedCount, ineligibleCount };
}
