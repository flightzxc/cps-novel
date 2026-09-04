import { createHash, randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";

import type { AdminIdentityStore, SessionStore } from "@/lib/auth/ports";
import { requireFreshAdminServiceMutation, type AdminServiceAuthorization } from "@/server/auth/guards";
import { enqueueScheduledTask, type TaskHandlerRegistry } from "@/lib/tasks";

/** CPS v8.3.6 config/compute/merge parity, adapted to Novel/PostgreSQL. */
export const HOME_CAROUSEL_TASK_TYPE = "home_carousel.compute.v1";
export const HOME_CAROUSEL_SCAN_LIMIT = 500;
export type HomeCarouselConfig = {
  slotCount: number; newSlotCount: number; newNovelWindowDays: number;
  cronSchedule: string; cronTimezone: string; cronEnabled: boolean; revenueEnabled: false;
};
export const DEFAULT_HOME_CAROUSEL_CONFIG: HomeCarouselConfig = Object.freeze({
  slotCount: 5,
  newSlotCount: 1,
  newNovelWindowDays: 14,
  cronSchedule: "0 3 * * *",
  cronTimezone: "Asia/Tokyo",
  cronEnabled: true,
  revenueEnabled: false,
});

export type HomeCarouselDependencies = { db: PrismaClient; identities: AdminIdentityStore; sessions: SessionStore; env?: NodeJS.ProcessEnv; now?: Date };

export function normalizeHomeCarouselConfig(value: unknown): HomeCarouselConfig {
  const raw = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  return {
    slotCount: 5,
    newSlotCount: 1,
    newNovelWindowDays: 14,
    cronSchedule: typeof raw.cronSchedule === "string" && raw.cronSchedule.trim() ? raw.cronSchedule.trim() : DEFAULT_HOME_CAROUSEL_CONFIG.cronSchedule,
    cronTimezone: typeof raw.cronTimezone === "string" && raw.cronTimezone.trim() ? raw.cronTimezone.trim() : DEFAULT_HOME_CAROUSEL_CONFIG.cronTimezone,
    cronEnabled: typeof raw.cronEnabled === "boolean" ? raw.cronEnabled : DEFAULT_HOME_CAROUSEL_CONFIG.cronEnabled,
    // The scoring branch is intentionally retained as configuration shape but cannot be enabled in Novel V1.
    revenueEnabled: false,
  };
}

export async function getHomeCarouselConfig(db: PrismaClient) {
  const row = await db.siteSetting.findUnique({ where: { id: 1 }, select: { carouselConfigJson: true } });
  return normalizeHomeCarouselConfig(row?.carouselConfigJson);
}

export function homeCarouselBusinessDate(now: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

type CarouselTx = Prisma.TransactionClient;

export async function computeHomeCarouselInTx(tx: CarouselTx, input: { locale: string; source: "manual" | "cron"; actorId?: string; now?: Date }) {
  const now = input.now ?? new Date();
  const configRow = await tx.siteSetting.findUnique({ where: { id: 1 }, select: { carouselConfigJson: true } });
  const config = normalizeHomeCarouselConfig(configRow?.carouselConfigJson);
  const businessDate = homeCarouselBusinessDate(now, config.cronTimezone);
  const uniqueKey = input.source === "cron" ? `cron:${businessDate}` : `manual:${randomUUID()}`;
  let batch;
  try {
    batch = await tx.homeCarouselAutoBatch.create({ data: {
      uniqueKey, runDate: new Date(`${businessDate}T00:00:00.000Z`), triggerSource: input.source,
      localeScope: input.locale, algorithmVersion: "novel-recency-v1", params: config,
      status: "pending", startedAt: now, createdBy: input.actorId ?? null,
    } });
  } catch (error) {
    if (input.source === "cron" && error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") return { status: "skipped_duplicate" as const };
    throw error;
  }
  const rows = await tx.article.findMany({
    where: { locale: input.locale, status: "published", deletedAt: null, novel: { status: "published", deletedAt: null, coverUrl: { not: null } } },
    orderBy: [{ updatedAt: "desc" }, { publishedAt: "desc" }, { id: "asc" }],
    take: HOME_CAROUSEL_SCAN_LIMIT,
    select: { id: true, novelId: true, publishedAt: true, updatedAt: true, novel: { select: { coverUrl: true } } },
  });
  const byNovel = new Map<string, typeof rows[number]>();
  for (const row of rows) if (row.novel.coverUrl?.trim() && !byNovel.has(row.novelId)) byNovel.set(row.novelId, row);
  const cutoff = now.valueOf() - 14 * 86_400_000;
  const pool = [...byNovel.values()];
  const newest = pool.filter((row) => (row.publishedAt?.valueOf() ?? 0) >= cutoff).slice(0, 1);
  const selectedIds = new Set(newest.map((row) => row.novelId));
  const selected = [...newest, ...pool.filter((row) => !selectedIds.has(row.novelId)).slice(0, 5 - newest.length)];
  if (selected.length > 0) await tx.homeCarouselAutoCandidate.createMany({ data: selected.map((row, index) => ({ batchId: batch.id, locale: input.locale, novelId: row.novelId, articleId: row.id, source: index < newest.length ? "new_novel" : "recency", rank: index + 1, reason: { updatedAt: row.updatedAt.toISOString() } })) });
  const manual = await tx.homeCarouselManualSlot.findMany({ where: { locale: input.locale, enabled: true, deletedAt: null, OR: [{ startsAt: null }, { startsAt: { lte: now } }], AND: [{ OR: [{ endsAt: null }, { endsAt: { gt: now } }] }] }, orderBy: { position: "asc" }, take: 5 });
  const merged: Array<{ novelId: string; articleId: string; source: string; manualSlotId: string | null; batchId: string | null }> = [];
  const seen = new Set<string>();
  for (const row of manual) if (!seen.has(row.novelId)) { seen.add(row.novelId); merged.push({ novelId: row.novelId, articleId: row.articleId, source: "manual", manualSlotId: row.id, batchId: null }); }
  for (const row of selected) if (merged.length < 5 && !seen.has(row.novelId)) { seen.add(row.novelId); merged.push({ novelId: row.novelId, articleId: row.id, source: newest.some((item) => item.id === row.id) ? "new_novel" : "recency", manualSlotId: null, batchId: batch.id }); }
  await tx.homeCarouselServing.deleteMany({ where: { locale: input.locale } });
  if (merged.length > 0) await tx.homeCarouselServing.createMany({ data: merged.map((row, index) => ({ ...row, locale: input.locale, position: index + 1, mergedAt: now })) });
  await tx.homeCarouselAutoBatch.update({ where: { id: batch.id }, data: { status: "success", finishedAt: now } });
  await tx.homeCarouselChangeLog.create({ data: { locale: input.locale, action: "serving.compute", actorType: input.source === "cron" ? "system" : "admin", actorId: input.actorId ?? null, afterState: { batchId: batch.id, count: merged.length } } });
  return { status: "success" as const, batchId: batch.id, count: merged.length };
}

async function auth(authorization: AdminServiceAuthorization, entryId: string, requestId: string, deps: HomeCarouselDependencies) {
  return requireFreshAdminServiceMutation(authorization, "settings:manage", { identities: deps.identities, sessions: deps.sessions, env: deps.env, now: deps.now, entryId, requestId });
}

export async function updateHomeCarouselConfig(input: { authorization: AdminServiceAuthorization; requestId: string; cronSchedule: string; cronTimezone: string; cronEnabled: boolean }, deps: HomeCarouselDependencies) {
  const context = await auth(input.authorization, "admin.home_carousel.config", input.requestId, deps);
  const config = normalizeHomeCarouselConfig(input);
  return deps.db.$transaction(async (tx) => {
    await tx.siteSetting.upsert({ where: { id: 1 }, create: { id: 1, carouselConfigJson: config }, update: { carouselConfigJson: config } });
    await tx.operationAudit.create({ data: { actorType: "admin", actorId: context.identity.id, action: "home_carousel.config", entityType: "SiteSetting", entityId: "1", requestId: input.requestId, afterSnapshot: config } });
    return config;
  });
}

export async function upsertHomeCarouselManualSlot(input: { authorization: AdminServiceAuthorization; requestId: string; id?: string; locale: string; position: number; articleId: string; enabled: boolean }, deps: HomeCarouselDependencies) {
  const context = await auth(input.authorization, "admin.home_carousel.manual_upsert", input.requestId, deps);
  if (!Number.isInteger(input.position) || input.position < 1 || input.position > 5) throw new Error("carousel_position_invalid");
  const article = await deps.db.article.findFirst({ where: { id: input.articleId, locale: input.locale, status: "published", deletedAt: null, novel: { status: "published", deletedAt: null, coverUrl: { not: null } } }, select: { id: true, novelId: true } });
  if (!article) throw new Error("carousel_article_ineligible");
  return deps.db.$transaction(async (tx) => {
    const data = { locale: input.locale, position: input.position, articleId: article.id, novelId: article.novelId, enabled: input.enabled, updatedBy: context.identity.id };
    const row = input.id ? await tx.homeCarouselManualSlot.update({ where: { id: input.id }, data }) : await tx.homeCarouselManualSlot.create({ data: { ...data, createdBy: context.identity.id } });
    await tx.homeCarouselChangeLog.create({ data: { locale: input.locale, action: input.id ? "manual.update" : "manual.create", manualSlotId: row.id, actorType: "admin", actorId: context.identity.id, afterState: { position: row.position, articleId: row.articleId, enabled: row.enabled } } });
    return row;
  });
}

export async function enqueueHomeCarouselCompute(input: { authorization: AdminServiceAuthorization; requestId: string; locale: string }, deps: HomeCarouselDependencies) {
  const context = await auth(input.authorization, "admin.home_carousel.compute", input.requestId, deps);
  const operationScopeHash = createHash("sha256").update(`home-carousel\n${input.locale}`).digest("hex");
  const active = await deps.db.genericTask.findFirst({ where: { taskType: HOME_CAROUSEL_TASK_TYPE, operationScopeHash, status: { in: ["pending", "processing"] } }, select: { id: true } });
  if (active) return { status: "active_conflict" as const, taskId: active.id };
  const task = await deps.db.genericTask.create({ data: { taskType: HOME_CAROUSEL_TASK_TYPE, operationScopeHash, mode: "apply", requestToken: input.requestId, totalCount: 1, params: { locale: input.locale }, items: { create: [{ targetType: "home_carousel", targetId: input.locale, payload: { locale: input.locale, source: "manual", actorId: context.identity.id } }] } } });
  return { status: "enqueued" as const, taskId: task.id };
}

export async function enqueueHomeCarouselCron(db: PrismaClient, registry: TaskHandlerRegistry, scheduledFor: Date) {
  const config = await getHomeCarouselConfig(db);
  if (!config.cronEnabled) return { status: "skipped_disabled" as const };
  return enqueueScheduledTask(db, registry, { scheduleKey: "home-carousel-daily", scheduleRevision: 1, scheduledFor, timezone: config.cronTimezone, taskType: HOME_CAROUSEL_TASK_TYPE, params: { locale: "en" }, items: [{ targetType: "home_carousel", targetId: homeCarouselBusinessDate(scheduledFor, config.cronTimezone), payload: { locale: "en", source: "cron" } }] });
}
