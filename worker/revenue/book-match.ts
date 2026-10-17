/**
 * v0.6.2 按书归因：把上游书行的 seriesId 匹配到本站来源条目（`novel_source_item`）。
 *
 * 键是 `novel_source_item.raw_payload->>'seriesId'`，**不是** `external_book_id`（10-17 主控生产只读实测：
 * 例如报表 `1_20125409` 对应 external_book_id=1181311785、raw_payload.seriesId="20125409"；
 * 99,470 个来源条目里有 99,465 个不同的 seriesId，只有 5 个 seriesId 对应多本）。
 * web 对 `raw_payload` 没有读权限（infra/postgres/grants.sql），所以匹配只能在 worker 同步时做，
 * 结果连同剧场（`channel_app_id`）写进 `revenue_book_daily_stat`，页面只按外键读。
 *
 * 范围：只在该渠道账号所在 channel 下、projectType=1（网文）的剧场里找——同一畅读账号下的
 * MoboReader / PlotNovel 都算；别的渠道、短剧不算。
 *
 * 规则（纯函数 `decideRevenueBookMatch`，便于单测）：
 *   - 优先看未软删除的候选；全部都软删除了才退回看已删除的（书被下架过，收入仍应归到它）；
 *   - 恰好一个候选 → matched；多个 → ambiguous（不替运营挑），候选同属一个剧场时仍记剧场；
 *   - 没有候选 → unmatched（页面保留上游书名，标“未匹配”）。
 *
 * 性能：`raw_payload->>'seriesId'` 没有表达式索引，这是一次全表扫描（约 10 万行 JSONB）。只在后台
 * 手动同步时跑一次、按 seriesId 去重后一次查完，不在页面读路径上。
 *
 * 放在 `worker/revenue/` 而不是 `worker/handlers/`：它不是任务处理器（`worker/handlers/*.ts` 里凡依赖上游
 * 适配器的文件都必须导出 `create*WorkerHandlers`，见 `tests/backend/tasks/worker-lanes.test.ts`）。
 */
import type { PrismaClient } from "@prisma/client";

import { NOVEL_REVENUE_PROJECT_TYPE } from "../../src/lib/adapters/moboreader-revenue-constants";
import type { RevenueBookMatchStatus } from "../../src/domain/database-statuses";

export interface RevenueBookMatch {
  readonly status: RevenueBookMatchStatus;
  readonly novelSourceItemId: string | null;
  readonly channelAppId: string | null;
}

export interface RevenueBookMatchCandidate {
  readonly id: string;
  readonly channelAppId: string;
  readonly deleted: boolean;
}

export const UNMATCHED_REVENUE_BOOK: RevenueBookMatch = Object.freeze({
  status: "unmatched",
  novelSourceItemId: null,
  channelAppId: null,
});

export function decideRevenueBookMatch(candidates: readonly RevenueBookMatchCandidate[]): RevenueBookMatch {
  if (candidates.length === 0) return UNMATCHED_REVENUE_BOOK;
  const live = candidates.filter((candidate) => !candidate.deleted);
  const pool = live.length > 0 ? live : candidates;
  if (pool.length === 1) {
    return { status: "matched", novelSourceItemId: pool[0]!.id, channelAppId: pool[0]!.channelAppId };
  }
  const apps = new Set(pool.map((candidate) => candidate.channelAppId));
  return { status: "ambiguous", novelSourceItemId: null, channelAppId: apps.size === 1 ? pool[0]!.channelAppId : null };
}

/** 一次查询的 seriesId 上限（单个数组绑定参数；按书的上游行在百本量级，正常只需一次）。 */
const SERIES_ID_CHUNK = 1000;

export type ResolveRevenueBookMatches = (
  db: PrismaClient,
  channelAccountId: string,
  seriesIds: readonly string[],
) => Promise<Map<string, RevenueBookMatch>>;

export const resolveRevenueBookMatches: ResolveRevenueBookMatches = async (db, channelAccountId, seriesIds) => {
  const unique = [...new Set(seriesIds)];
  const candidates = new Map<string, RevenueBookMatchCandidate[]>();
  for (let start = 0; start < unique.length; start += SERIES_ID_CHUNK) {
    const chunk = unique.slice(start, start + SERIES_ID_CHUNK);
    const rows = await db.$queryRaw<Array<{ id: string; channelAppId: string; seriesId: string; deleted: boolean }>>`
      SELECT s.id::text AS "id",
             s.channel_app_id::text AS "channelAppId",
             s.raw_payload->>'seriesId' AS "seriesId",
             (s.deleted_at IS NOT NULL) AS "deleted"
        FROM novel_source_item s
        JOIN channel_app a ON a.id = s.channel_app_id
        JOIN channel_account acc ON acc.channel_id = a.channel_id
       WHERE acc.id = ${channelAccountId}::uuid
         AND a.project_type = ${NOVEL_REVENUE_PROJECT_TYPE}
         AND s.raw_payload->>'seriesId' = ANY(${chunk}::text[])`;
    for (const row of rows) {
      const list = candidates.get(row.seriesId) ?? [];
      list.push({ id: row.id, channelAppId: row.channelAppId, deleted: row.deleted });
      candidates.set(row.seriesId, list);
    }
  }
  return new Map(unique.map((seriesId) => [seriesId, decideRevenueBookMatch(candidates.get(seriesId) ?? [])]));
};
