/**
 * 收益看板对应的渠道账号：入队与读服务共用同一条选账号规则，不会出现“页面显示的是 A 账号、
 * 同步的是 B 账号”。
 *
 * 规则：projectType=1（网文）的 active channel_app 所在、且 channel / source_app 都是 active 的
 * channel 下，`status = active` 且未软删除的 channel_account——**必须恰好 1 个**（并且只有 1 个
 * 候选 channel_app）。0 个 → `channel_account_unavailable`；多于 1 个 → `channel_account_ambiguous`。
 * 宁可让运营看到明确的错误，也不替他们“挑一个”：收益是按账号汇总的，挑错账号就是错的数字。
 *
 * 只读，且只用 web_app 有权限的表（channel_app / channel / channel_account）。
 */
import type { PrismaClient } from "@prisma/client";

import { NOVEL_REVENUE_PROJECT_TYPE } from "@/lib/adapters/moboreader-revenue-constants";

export type RevenueAccountResolution =
  | { readonly status: "ok"; readonly channelAccountId: string; readonly channelAppId: string; readonly accountName: string }
  | { readonly status: "unavailable" }
  | { readonly status: "ambiguous" };

type AccountResolutionDb = Pick<PrismaClient, "channelApp">;

export async function resolveRevenueChannelAccount(db: AccountResolutionDb): Promise<RevenueAccountResolution> {
  const apps = await db.channelApp.findMany({
    where: {
      projectType: NOVEL_REVENUE_PROJECT_TYPE,
      status: "active",
      channel: { status: "active" },
      sourceApp: { status: "active" },
    },
    select: {
      id: true,
      channel: {
        select: {
          channelAccounts: {
            where: { status: "active", deletedAt: null },
            select: { id: true, accountName: true },
          },
        },
      },
    },
    orderBy: { createdAt: "asc" },
  });

  const candidates = apps.flatMap((app) =>
    app.channel.channelAccounts.map((account) => ({
      channelAppId: app.id,
      channelAccountId: account.id,
      accountName: account.accountName,
    })),
  );
  if (candidates.length === 0) return { status: "unavailable" };
  // 同一个账号挂在两个候选应用下，同样无法替运营决定用哪一个。
  if (candidates.length > 1) return { status: "ambiguous" };
  const only = candidates[0]!;
  return { status: "ok", ...only };
}

/**
 * 页面上展示用的账号标签：脱敏，不暴露完整登录名。邮箱形态 `chenweifeng@qq.com` → `ch***@qq.com`；
 * 其它形态保留前两个字符。
 */
export function maskRevenueAccountLabel(accountName: string): string {
  const name = accountName.trim();
  if (!name) return "***";
  const at = name.indexOf("@");
  const local = at > 0 ? name.slice(0, at) : name;
  const domain = at > 0 ? name.slice(at) : "";
  const visible = Array.from(local).slice(0, local.length > 2 ? 2 : 1).join("");
  return `${visible}***${domain}`;
}
