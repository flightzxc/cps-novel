import { prisma } from "@/app/api/admin/_lib/deps";

/**
 * Read side for the "新建目录扫描任务" trigger block on `/catalog-sync`
 * (PR-C2).
 *
 * There is no `src/server/**` query for "active channel apps with their
 * active channel accounts" — this is a brand-new read, not one P2-04's
 * content-read kernel ever covered, and adding one to `src/server/**` is
 * Codex's territory, out of this task's write scope. This follows the exact
 * precedent `./read-source-items.ts` already set (itself following
 * `src/app/(admin)/channel-accounts/page.tsx`'s `readRows`): a page-local
 * Prisma read straight off the shared client (`@/app/api/admin/_lib/deps`),
 * scoped to exactly the columns this form renders. Nothing here writes —
 * `createMoboreaderCatalogScanTask` (`@/lib/tasks/moboreader`, Codex-owned)
 * is the only write path, and it stays entirely inside the Server Action
 * (`../_actions.ts`).
 *
 * Scoped to combinations `createMoboreaderCatalogScanTask` can actually
 * accept: the factory's own `binding` lookup requires
 * `channelApp.status === "active"` AND `channelApp.channel.status ===
 * "active"` AND at least one `channelAccount` under that channel with
 * `status === "active"` and `deletedAt: null` — see
 * `src/lib/tasks/moboreader.ts`'s `createMoboreaderCatalogScanTask`. Filtering
 * to the same shape here means every option this form offers is guaranteed
 * to pass that lookup (barring a race between page render and submit, which
 * the factory itself still catches via `active_channel_binding_required`).
 */

export type ChannelAppScanOption = {
  readonly id: string;
  readonly channelCode: string;
  readonly channelName: string;
  readonly sourceAppCode: string;
  readonly sourceAppName: string;
  readonly channelAccounts: readonly {
    readonly id: string;
    readonly businessId: string;
    readonly accountName: string;
  }[];
};

export async function readActiveChannelAppOptions(): Promise<readonly ChannelAppScanOption[]> {
  const rows = await prisma.channelApp.findMany({
    where: {
      status: "active",
      channel: {
        status: "active",
        channelAccounts: { some: { status: "active", deletedAt: null } },
      },
    },
    orderBy: [{ channel: { name: "asc" } }, { sourceApp: { name: "asc" } }],
    select: {
      id: true,
      channel: {
        select: {
          code: true,
          name: true,
          channelAccounts: {
            where: { status: "active", deletedAt: null },
            orderBy: { accountName: "asc" },
            select: { id: true, businessId: true, accountName: true },
          },
        },
      },
      sourceApp: { select: { code: true, name: true } },
    },
  });

  return rows.map((row) => ({
    id: row.id,
    channelCode: row.channel.code,
    channelName: row.channel.name,
    sourceAppCode: row.sourceApp.code,
    sourceAppName: row.sourceApp.name,
    channelAccounts: row.channel.channelAccounts.map((account) => ({
      id: account.id,
      businessId: account.businessId,
      accountName: account.accountName,
    })),
  }));
}
