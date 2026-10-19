import type { PrismaClient } from "@prisma/client";

import { PROMO_LINK_CLAIM_CAPABILITY_KEY } from "@/lib/tasks/promo-link-claim-limits";

import { prisma } from "@/app/api/admin/_lib/deps";

/**
 * Read side for the "新建目录扫描任务" trigger block on `/catalog-sync`
 * (PR-C2; regrouped by Phase B for CPS `changdu-sync-panel.tsx` parity —
 * 渠道 → 剧场 chips → 语种 chips → 渠道账号, see
 * `施工工单_PhaseB_实体订正与运营表单Parity_2026-09-06.md` §三).
 *
 * There is no `src/server/**` query for "active channels, grouped with their
 * active channel apps and active channel accounts" — this is a brand-new
 * read, not one P2-04's content-read kernel ever covered, and adding one to
 * `src/server/**` is Codex's territory, out of this task's write scope. This
 * follows the exact precedent `./read-source-items.ts` already set (itself
 * following `src/app/(admin)/channel-accounts/page.tsx`'s `readRows`): a
 * page-local Prisma read straight off the shared client
 * (`@/app/api/admin/_lib/deps`), scoped to exactly the columns this form
 * renders. Nothing here writes — `createMoboreaderCatalogScanTask`
 * (`@/lib/tasks/moboreader`, Codex-owned) is the only write path, and it
 * stays entirely inside the Server Action (`../_actions.ts`).
 *
 * Grouped by `Channel`, not flattened per `ChannelApp`, because the CPS
 * reference panel has a channel-account picker plus a *separate* "剧场"
 * (ChannelApp) chip row scoped to that channel — the flat one-row-per-app
 * shape this used to return duplicated `channelAccounts` once per app,
 * which only happened to look right because there was exactly one channel
 * app in every environment this ran against. `channelAccounts` now lives at
 * the channel level, once, matching the schema (`ChannelAccount.channelId`
 * — accounts belong to a channel, never to a specific channel app).
 *
 * Scoped to combinations `createMoboreaderCatalogScanTask` can actually
 * accept: the factory's own `binding` lookup requires
 * `channelApp.status === "active"` AND `channelApp.channel.status ===
 * "active"` AND at least one `channelAccount` under that channel with
 * `status === "active"` and `deletedAt: null` — see
 * `src/lib/tasks/moboreader.ts`'s `createMoboreaderCatalogScanTask`.
 *
 * The WHERE clause deliberately does *not* also require
 * `channelAccounts: { some: … } }` (unlike the nested `select` below, which
 * still does) — a channel that is registered and has an active `ChannelApp`
 * but zero `ChannelAccount` rows would otherwise vanish from this list
 * entirely, looking identical to "no such channel" in the UI. That is the
 * same "visible but disabled, say why" convention `P1_ADMIN_PARITY_SPEC.md`
 * §6 already uses for 北斗, and the one `readClaimEligibleChannelAppOptions`
 * below already follows for `ChannelApp`-level capability gating. The
 * channel is still returned in that case, just with an empty
 * `channelAccounts` array and `hasActiveChannelAccounts: false` — the
 * consumer form surfaces that explicitly ("未配置渠道账号") and disables
 * submission for it, rather than the option quietly not existing. Every
 * option this read returns still passes `channelApp.status`/`channel.status`
 * — only the account-existence requirement moved from "hide the row" to
 * "show the row, flag it, and let the client-side + factory-side gates do
 * the rest" (the factory's own runtime check still catches a page-render/
 * submit race via `active_channel_binding_required`).
 */

export type ChannelAppChipOption = {
  readonly id: string;
  readonly sourceAppCode: string;
  readonly sourceAppName: string;
};

export type ChannelScanOption = {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly channelApps: readonly ChannelAppChipOption[];
  /**
   * Explicit "does this channel have at least one usable channel account"
   * signal, computed here so the consumer never has to infer it from
   * `channelAccounts.length` itself. Always `channelAccounts.length > 0`
   * (the nested `select` below is already scoped to `status: "active",
   * deletedAt: null`), but named for what it means rather than left as an
   * implicit array-length check at the call site.
   */
  readonly hasActiveChannelAccounts: boolean;
  readonly channelAccounts: readonly {
    readonly id: string;
    readonly businessId: string;
    readonly accountName: string;
  }[];
};

export async function readActiveChannelScanOptions(): Promise<readonly ChannelScanOption[]> {
  const rows = await prisma.channel.findMany({
    where: {
      status: "active",
      channelApps: { some: { status: "active" } },
    },
    orderBy: { name: "asc" },
    select: {
      id: true,
      code: true,
      name: true,
      channelAccounts: {
        where: { status: "active", deletedAt: null },
        orderBy: { accountName: "asc" },
        select: { id: true, businessId: true, accountName: true },
      },
      channelApps: {
        where: { status: "active" },
        orderBy: { sourceApp: { name: "asc" } },
        select: { id: true, sourceApp: { select: { code: true, name: true } } },
      },
    },
  });

  return rows.map((row) => ({
    id: row.id,
    code: row.code,
    name: row.name,
    channelApps: row.channelApps.map((app) => ({
      id: app.id,
      sourceAppCode: app.sourceApp.code,
      sourceAppName: app.sourceApp.name,
    })),
    hasActiveChannelAccounts: row.channelAccounts.length > 0,
    channelAccounts: row.channelAccounts.map((account) => ({
      id: account.id,
      businessId: account.businessId,
      accountName: account.accountName,
    })),
  }));
}

/**
 * RC-1: read side for the "领取推广链接" trigger on `/catalog-sync`.
 *
 * Not touched by Phase B's 渠道 → 剧场 → 语种 regrouping above — this trigger
 * still lists one flat row per `ChannelApp` (each carrying its own
 * `channelAccounts`), unrelated to the catalog-scan trigger form's own
 * grouping choice.
 *
 * Same active-scope filter the catalog-scan read above used before Phase B
 * (the factory's own `binding` lookup in `createPromoLinkClaimTask`
 * (`@/lib/tasks/promo-link-claim`) requires the identical
 * `channelApp.status === "active"` AND `channel.status === "active"` AND at
 * least one active, non-deleted `channelAccount` shape) — so every option
 * this trigger offers is guaranteed to pass that lookup, barring the same
 * page-render/submit race `active_channel_binding_required` still catches.
 *
 * The one addition is `claimCapabilityEnabled`: `ChannelCapability` is keyed
 * by `(channelAppId, capabilityKey)`, not by account — there is no per-
 * account claim capability in this schema, only a per-channel-app one. The
 * factory itself never reads `ChannelCapability` at all (that enforcement
 * lives in the worker handler), so without this flag an operator could
 * submit a claim task against a channel app the worker will never process,
 * and only find out from `/tasks` later. Channel apps are still returned
 * even when disabled — hiding the row would look identical to "no such
 * channel app", the same "visible but disabled, say why" convention
 * `P1_ADMIN_PARITY_SPEC.md` §6 already uses for 北斗.
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

export type ClaimChannelAppOption = ChannelAppScanOption & {
  readonly claimCapabilityEnabled: boolean;
};

export async function readClaimEligibleChannelAppOptions(): Promise<readonly ClaimChannelAppOption[]> {
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
      capabilities: {
        where: { capabilityKey: PROMO_LINK_CLAIM_CAPABILITY_KEY },
        select: { status: true },
      },
    },
  });

  return rows.map((row) => ({
    id: row.id,
    channelCode: row.channel.code,
    channelName: row.channel.name,
    sourceAppCode: row.sourceApp.code,
    sourceAppName: row.sourceApp.name,
    claimCapabilityEnabled: row.capabilities[0]?.status === "enabled",
    channelAccounts: row.channel.channelAccounts.map((account) => ({
      id: account.id,
      businessId: account.businessId,
      accountName: account.accountName,
    })),
  }));
}

/**
 * B-44（v0.6.4）：目录同步页"剧场"筛选的选项——每个 `channel_app`（渠道 × 来源 App）一项，
 * 例如 MoboReader、PlotNovel。不按状态或能力过滤：停用的剧场下也可能有书，隐藏它只会让运营以为
 * "没有这个剧场"（与上面 `readClaimEligibleChannelAppOptions` 注释里"看得见但标明原因"同一约定），
 * 所以照列并标"（已停用）"。领取能力开没开不在这里表达——那由领取对话框按服务端算好的
 * `claimCapabilityEnabled` 处理（B-44 第 3 条）。
 *
 * `db` 可注入，供真实 Postgres 用例以 `web_app` 角色跑同一条查询（channel / source_app /
 * channel_app 三表的 SELECT 早已授给 web_app，见 `infra/postgres/grants.sql`）。
 */
export type CatalogTheaterOption = { readonly id: string; readonly label: string };

export type CatalogTheaterRow = {
  readonly id: string;
  readonly status: string;
  readonly channel: { readonly name: string };
  readonly sourceApp: { readonly name: string };
};

/** 只有一个渠道时标签就是剧场名（"PlotNovel"）；多个渠道时加渠道名前缀，免得同名剧场分不清。 */
export function buildCatalogTheaterOptions(rows: readonly CatalogTheaterRow[]): readonly CatalogTheaterOption[] {
  const multipleChannels = new Set(rows.map((row) => row.channel.name)).size > 1;
  return rows.map((row) => ({
    id: row.id,
    label: `${multipleChannels ? `${row.channel.name} · ` : ""}${row.sourceApp.name}${row.status === "active" ? "" : "（已停用）"}`,
  }));
}

export async function readCatalogTheaterOptions(
  db: Pick<PrismaClient, "channelApp"> = prisma,
): Promise<readonly CatalogTheaterOption[]> {
  const rows = await db.channelApp.findMany({
    orderBy: [{ channel: { name: "asc" } }, { sourceApp: { name: "asc" } }, { id: "asc" }],
    select: { id: true, status: true, channel: { select: { name: true } }, sourceApp: { select: { name: true } } },
  });
  return buildCatalogTheaterOptions(rows);
}
