/**
 * 收益看板对应的渠道账号：入队与读服务共用同一条选账号规则，不会出现“页面显示的是 A 账号、
 * 同步的是 B 账号”。
 *
 * ── 规则（账号级，按账号去重） ────────────────────────────────────────────────
 * 找出所有“至少挂着一个 active、projectType=1（网文）、且 channel 与 source_app 都 active 的 channel_app”
 * 的 channel；这些 channel 下 `status = active` 且未软删除的 channel_account，**按账号 id 去重**后：
 *   - 恰好 1 个 → `ok`；
 *   - 0 个 → `channel_account_unavailable`；
 *   - ≥ 2 个**不同账号** → `channel_account_ambiguous`。
 * 宁可让运营看到明确的错误，也不替他们“挑一个”：收益是按账号汇总的，挑错账号就是错的数字。
 *
 * 为什么按账号去重而不是按“应用 × 账号”计数：上游收益接口 `GetReport` 是**账号级**的（同一账号同一
 * projectType 下所有应用合计，响应里没有应用字段）。同一个畅读账号下以后给海阅再增加别的网文应用时，
 * 候选“应用 × 账号”会变成 2 条，但账号仍然只有 1 个——那不是歧义，不能因此把同步卡死。
 * 返回的 `novelAppCount` 是该账号所在 channel 下 active 的网文应用数，页面口径说明用它写“当前 N 个应用”。
 * 返回值**不含** `channelAppId`：账号级任务不属于某一个应用（`generic_task.channel_app_id` 写 NULL）。
 *
 * ── 多剧场（多应用）扩展路径 ──────────────────────────────────────────────────
 *   1. 同账号多应用：现状即可工作——看板显示该账号下全部网文应用的合计。
 *   2. 按应用拆分：需先由 Owner 在上游后台日报页选“授权产品”维度并抓取一次真实请求，拿到维度编码；
 *      原始行表已有 `dimension` 列可容纳非日期维度，按应用的日汇总另建一张表（只新增），不改现有表。
 *   3. 多个畅读账号：数据模型已支持（作用域 = 账号 × projectType），但当前页面与入队只支持唯一账号，
 *      多账号时会明确返回 `channel_account_ambiguous`，届时再加账号选择器。
 *
 * 只读，且只用 web_app 有权限的表（channel_app / channel / channel_account）。
 */
import type { PrismaClient } from "@prisma/client";

import { NOVEL_REVENUE_PROJECT_TYPE } from "@/lib/adapters/moboreader-revenue-constants";

export type RevenueAccountResolution =
  | {
      readonly status: "ok";
      readonly channelAccountId: string;
      readonly accountName: string;
      /** 该账号所在 channel 下 active 的网文应用数（≥ 1）。口径说明与“合计”提示用。 */
      readonly novelAppCount: number;
    }
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

  // 按账号去重：同一个账号可能被同一 channel 下的多个应用“看到”，它仍然只是一个账号。
  const accounts = new Map<string, { accountName: string; appIds: Set<string> }>();
  for (const app of apps) {
    for (const account of app.channel.channelAccounts) {
      const entry = accounts.get(account.id) ?? { accountName: account.accountName, appIds: new Set<string>() };
      entry.appIds.add(app.id);
      accounts.set(account.id, entry);
    }
  }
  if (accounts.size === 0) return { status: "unavailable" };
  if (accounts.size > 1) return { status: "ambiguous" };
  const [channelAccountId, only] = Array.from(accounts)[0]!;
  return { status: "ok", channelAccountId, accountName: only.accountName, novelAppCount: only.appIds.size };
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
