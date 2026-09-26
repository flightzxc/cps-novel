import type { SitemapAdminState, SitemapRequestResult } from "@/contracts";
import type { PrismaClient } from "@prisma/client";
import type { AdminIdentityStore, SessionStore } from "@/lib/auth/ports";
import { isSitemapAutoRefreshEnabled, isSitemapAutoRefreshWriteAllowed } from "@/lib/flags";
import { readSitemapRefreshState } from "@/lib/seo/sitemap-refresh-state";
import { enqueueSitemapRefresh, lockSitemapRefreshScope, SITEMAP_REFRESH_TASK_TYPE, SITEMAP_REFRESH_OPERATION_SCOPE_HASH } from "@/lib/tasks/sitemap-refresh";
import { requireFreshAdminServiceMutation, type AdminServiceAuthorization } from "@/server/auth/guards";
import { SiteSettingValidationError } from "@/server/site-settings/service";

export const SITEMAP_ADMIN_ENTRY_ID = "admin.api.sitemap";
export const SITEMAP_ADMIN_AUDIT_ACTION = "sitemap.refresh.request";

export function sitemapManualEnabled(env: NodeJS.ProcessEnv = process.env) {
  return isSitemapAutoRefreshEnabled(env) && isSitemapAutoRefreshWriteAllowed(env);
}

export async function getAdminSitemapState(db: PrismaClient, rootDir?: string, env = process.env): Promise<SitemapAdminState> {
  const where = { taskType: SITEMAP_REFRESH_TASK_TYPE, operationScopeHash: SITEMAP_REFRESH_OPERATION_SCOPE_HASH };
  const [activeTask, latest, disk] = await Promise.all([
    db.genericTask.findFirst({ where: { ...where, status: { in: ["pending", "processing"] } }, orderBy: { createdAt: "asc" }, select: { id: true, status: true, createdAt: true, completedAt: true } }),
    db.genericTask.findFirst({ where, orderBy: { createdAt: "desc" }, select: { id: true, status: true, createdAt: true, completedAt: true } }),
    readSitemapRefreshState(rootDir),
  ]);
  const task = activeTask ?? latest;
  return {
    enabled: sitemapManualEnabled(env),
    task: task ? { ...task, createdAt: task.createdAt.toISOString(), completedAt: task.completedAt?.toISOString() ?? null } : null,
    lastGeneration: { status: disk.task.status, finishedAt: disk.task.finishedAt ?? null },
    published: disk.active ? { generatedAt: disk.active.generatedAt, urlCount: disk.active.urlCount } : null,
  };
}

/** CLI and HTTP share this transaction. No file generation is allowed here. */
export async function requestAuditedSitemapRefresh(input: {
  actorType: "admin" | "system"; actorId: string; requestId: string; reason: string;
}, db: PrismaClient, env: NodeJS.ProcessEnv = process.env): Promise<SitemapRequestResult> {
  if (!input.reason.trim() || input.reason.trim().length > 500) throw new SiteSettingValidationError("Refresh reason must contain 1-500 characters");
  if (!sitemapManualEnabled(env)) return { status: "disabled" };
  return db.$transaction(async (tx) => {
    await lockSitemapRefreshScope(tx);
    const prior = await tx.operationAudit.findFirst({ where: {
      action: SITEMAP_ADMIN_AUDIT_ACTION, entityType: "Sitemap", entityId: "global", requestId: input.requestId,
    }, select: { actorType: true, actorId: true, taskId: true, reason: true } });
    if (prior) {
      if (prior.actorType !== input.actorType || prior.actorId !== input.actorId || prior.reason !== input.reason.trim() || !prior.taskId) {
        throw new SiteSettingValidationError("Refresh request identity conflict");
      }
      return { status: "coalesced", taskId: prior.taskId };
    }
    const result = await enqueueSitemapRefresh({ reason: input.reason.trim(), triggeredBy: input.actorId }, tx, { env });
    if (result.status === "disabled") return result;
    await tx.operationAudit.create({ data: {
      actorType: input.actorType, actorId: input.actorId, action: SITEMAP_ADMIN_AUDIT_ACTION,
      entityType: "Sitemap", entityId: "global", requestId: input.requestId, reason: input.reason.trim(),
      taskType: SITEMAP_REFRESH_TASK_TYPE, taskId: result.taskId, afterSnapshot: result,
    } });
    return result;
  });
}

export async function requestAdminSitemapRefresh(input: {
  authorization: AdminServiceAuthorization; requestId: string; reason: unknown;
}, deps: { db: PrismaClient; identities: AdminIdentityStore; sessions: SessionStore; env?: NodeJS.ProcessEnv; now?: Date }) {
  const context = await requireFreshAdminServiceMutation(input.authorization, "settings:manage", {
    ...deps, entryId: SITEMAP_ADMIN_ENTRY_ID, requestId: input.requestId,
  });
  return requestAuditedSitemapRefresh({ actorType: "admin", actorId: context.identity.id, requestId: input.requestId,
    reason: typeof input.reason === "string" ? input.reason : "",
  }, deps.db, deps.env);
}
