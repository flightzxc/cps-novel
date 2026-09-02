import {
  evaluateBackupStatus,
  type BackupStatusValue,
} from "@/server/health/backup-status";

/**
 * `/api/health/backup`（RC-7b，直搬 CPS `v8.3.6` `src/app/api/health/backup/
 * route.ts`，`baseline_commit 16f2e4cfca51f46af0dede899ecf6242a770bbd0`）。
 *
 * 为什么 unconfigured 返回 200：部署这一刻备份目录里可能还没有任何匹配产物
 * （全新环境、还没跑过第一次备份、或本仓的 Postgres 备份状态文件/输出目录尚未
 * 配置）——如果这时端点返回 503，创建监控会立刻误报。调用方必须看
 * `backupStatus` 字段，不能只看 HTTP 状态码。
 *
 * ⚠️ 这条对外部监控的配置方式有硬性要求：必须用 **Keyword 类型**（判据＝响应体
 * 里找不到 `"backupStatus":"ok"` 就报警）。Keyword 类型下 unconfigured / failed /
 * stale 三种都会触发报警，因为它们的 backupStatus 都不是 ok。但如果有人把监控
 * 改成**纯 HTTP 状态码**类型，unconfigured 的 200 会被判为健康，这个端点就退化
 * 成又一个"会骗人的监控点"——与 CPS 2026-08-19 事故里 `/api/health` 扮演的角色
 * 相同（不碰数据库，全站死透期间一路返回 200）。改监控类型前先读这段。
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const HTTP_STATUS_BY_BACKUP_STATUS: Record<BackupStatusValue, number> = {
  ok: 200,
  unconfigured: 200,
  failed: 503,
  stale: 503,
};

export async function GET(): Promise<Response> {
  const result = await evaluateBackupStatus();

  return Response.json(result, {
    status: HTTP_STATUS_BY_BACKUP_STATUS[result.backupStatus],
    headers: { "Cache-Control": "no-store" },
  });
}
