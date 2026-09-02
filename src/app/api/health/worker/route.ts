import { evaluateWorkerStatus, type WorkerStatusValue } from "@/server/health/worker-status";

import { prisma } from "../../admin/_lib/deps";

/**
 * `/api/health/worker`（RC-7b）——同一套 Keyword 监控形态（见
 * `@/server/health/backup-status.ts` 与 `../backup/route.ts` 头注释里 CPS
 * 2026-08-19/08-22 事故的完整论证），判据取自本仓 `docs/operations/
 * LAUNCH_DAY_HEALTH_CHECKS.md` §2 与 `src/lib/tasks/store.ts` 的租约字段，
 * 详见 `@/server/health/worker-status.ts` 头注释。
 *
 * 外部监控必须配成 **Keyword 类型**，判据＝响应体里找不到 `"workerStatus":"ok"`
 * 就报警。degraded（存在过期未回收的处理锁）与 failed（探测查询本身失败或超时）
 * 都不是 ok，都会被 Keyword 判据捕捉；纯 HTTP 状态码类型下两者都映射到 503，
 * 结论一致，但 Keyword 类型是与 `/api/health/backup` 统一的配置纪律,不应该有
 * 一个端点用状态码、另一个用关键词。
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const HTTP_STATUS_BY_WORKER_STATUS: Record<WorkerStatusValue, number> = {
  ok: 200,
  degraded: 503,
  failed: 503,
};

export async function GET(): Promise<Response> {
  const result = await evaluateWorkerStatus(prisma);

  return Response.json(result, {
    status: HTTP_STATUS_BY_WORKER_STATUS[result.workerStatus],
    headers: { "Cache-Control": "no-store" },
  });
}
