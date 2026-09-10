import { createHash, randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";

import type { AdminIdentityStore, SessionStore } from "@/lib/auth/ports";
import { requireFreshAdminServiceMutation, type AdminServiceAuthorization } from "@/server/auth/guards";
import { enqueueScheduledTask, type ScheduleDefinition, type ScheduledTaskInput, type TaskHandlerRegistry } from "@/lib/tasks";
import { buildPublicListArticleWhere } from "@/server/publication/visibility";

/** CPS v8.3.6 config/compute/merge parity, adapted to Novel/PostgreSQL. */
export const HOME_CAROUSEL_TASK_TYPE = "home_carousel.compute.v1";
export const HOME_CAROUSEL_SCAN_LIMIT = 500;
export const HOME_CAROUSEL_SCHEDULE_KEY = "home-carousel-daily";
export type HomeCarouselConfig = {
  slotCount: number; newSlotCount: number; newNovelWindowDays: number;
  cronSchedule: string; cronTimezone: string; cronEnabled: boolean; revenueEnabled: false;
};
export const DEFAULT_HOME_CAROUSEL_CONFIG: HomeCarouselConfig = Object.freeze({
  slotCount: 5,
  newSlotCount: 1,
  newNovelWindowDays: 14,
  cronSchedule: "0 3 * * *",
  // PR6 fix (B-1 #2): CPS/spec default is Asia/Shanghai; this was Asia/Tokyo
  // with no port-registry deviation entry, i.e. an undocumented drift.
  cronTimezone: "Asia/Shanghai",
  cronEnabled: true,
  revenueEnabled: false,
});

export type HomeCarouselDependencies = { db: PrismaClient; identities: AdminIdentityStore; sessions: SessionStore; env?: NodeJS.ProcessEnv; now?: Date };

/**
 * Reads an integer config field within `[min, max]`; anything missing,
 * non-integer or out of range silently falls back to `fallback` (mirrors
 * CPS `home-carousel-config.ts`'s `readInteger`: warn-and-fallback, not
 * throw, since this runs on every read of a JSONB column an operator can
 * hand-edit).
 */
function readBoundedInt(raw: Record<string, unknown>, field: string, fallback: number, min: number, max?: number): number {
  const value = raw[field];
  if (typeof value !== "number" || !Number.isInteger(value)) return fallback;
  if (value < min) return fallback;
  if (max !== undefined && value > max) return fallback;
  return value;
}

export function normalizeHomeCarouselConfig(value: unknown): HomeCarouselConfig {
  const raw = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  return {
    // PR6 fix (B-1 #3): these were read into a local variable and then
    // discarded in favor of literals 5/1/14 everywhere below. Bounds mirror
    // CPS `home-carousel-config.ts`'s `normalizeCarouselConfig`: slotCount
    // integer >= 1 (no upper bound there either); newSlotCount integer 0-2;
    // newNovelWindowDays (CPS: newDramaWindowDays) integer >= 0.
    slotCount: readBoundedInt(raw, "slotCount", DEFAULT_HOME_CAROUSEL_CONFIG.slotCount, 1),
    newSlotCount: readBoundedInt(raw, "newSlotCount", DEFAULT_HOME_CAROUSEL_CONFIG.newSlotCount, 0, 2),
    newNovelWindowDays: readBoundedInt(raw, "newNovelWindowDays", DEFAULT_HOME_CAROUSEL_CONFIG.newNovelWindowDays, 0),
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

export async function computeHomeCarouselInTx(tx: CarouselTx, input: { locale: string; source: "manual" | "cron"; actorId?: string; now?: Date; env?: NodeJS.ProcessEnv }) {
  const now = input.now ?? new Date();
  // C-25 review fix: `env` (default `process.env`) threads
  // `FEATURE_ARTICLE_SEO_VISIBILITY` down to `buildPublicListArticleWhere`
  // below — an explicit override lets tests exercise the flag-on path
  // without mutating global `process.env`, same convention as
  // `createSitemapFamilyBuilder`/`isNovelIndexNowEligible`.
  const env = input.env ?? process.env;
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
  // C-25 review fix: the carousel is a list surface (candidate pool and
  // serving snapshot alike — see `buildPublicListArticleWhere`'s own doc
  // comment), so candidate selection uses the same stricter "list" fragment
  // as `src/lib/site/home-carousel-service.ts`'s `fallbackRows`, excluding
  // both `hidden` and `seo_only` Articles from ever being written into
  // `home_carousel_serving`. While `FEATURE_ARTICLE_SEO_VISIBILITY` is off
  // this degrades to exactly the pre-C-25 where-shape below.
  const rawRows = await tx.article.findMany({
    where: { ...buildPublicListArticleWhere({ locale: input.locale }, env), novel: { status: "published", deletedAt: null, coverUrl: { not: null } } },
    orderBy: [{ updatedAt: "desc" }, { publishedAt: "desc" }, { id: "asc" }],
    take: HOME_CAROUSEL_SCAN_LIMIT,
    select: { id: true, novelId: true, publishedAt: true, updatedAt: true, novel: { select: { coverUrl: true } } },
  });
  type CarouselCandidateRow = (typeof rawRows)[number];
  // C-27: `novelId`/`novel` are nullable at the type level (blog articles),
  // but the `novel: { status: "published", ... }` filter above can only
  // ever match a row whose `novel` relation actually resolves — a null
  // relation cannot satisfy an `is`-style nested filter — so `novelId` is
  // structurally non-null in every row this query returns too (the two are
  // always in sync per `article_novel_id_by_type_check`). Narrowed here so
  // the rest of this function can keep reading `row.novelId`/`row.novel.*`
  // without a `!` assertion; the carousel stays Novel-only until a future
  // round gives blog its own candidate source.
  type CarouselCandidateRowWithNovel = CarouselCandidateRow & {
    novelId: string;
    novel: NonNullable<CarouselCandidateRow["novel"]>;
  };
  const rows = rawRows.filter(
    (row): row is CarouselCandidateRowWithNovel => row.novelId !== null && row.novel !== null,
  );
  const byNovel = new Map<string, CarouselCandidateRowWithNovel>();
  for (const row of rows) if (row.novel.coverUrl?.trim() && !byNovel.has(row.novelId)) byNovel.set(row.novelId, row);
  // PR6 fix (B-1 #3): slotCount/newSlotCount/newNovelWindowDays now drive the
  // reserved new_novel slot count and the recency fill, instead of the
  // literals 14/1/5 that ignored whatever was stored in carouselConfigJson.
  const cutoff = now.valueOf() - config.newNovelWindowDays * 86_400_000;
  const pool = [...byNovel.values()];
  const newDramaLimit = Math.max(Math.min(config.newSlotCount, config.slotCount), 0);
  const newest = pool.filter((row) => (row.publishedAt?.valueOf() ?? 0) >= cutoff).slice(0, newDramaLimit);
  const selectedIds = new Set(newest.map((row) => row.novelId));
  const selected = [...newest, ...pool.filter((row) => !selectedIds.has(row.novelId)).slice(0, Math.max(config.slotCount - newest.length, 0))];
  if (selected.length > 0) await tx.homeCarouselAutoCandidate.createMany({ data: selected.map((row, index) => ({ batchId: batch.id, locale: input.locale, novelId: row.novelId, articleId: row.id, source: index < newest.length ? "new_novel" : "recency", rank: index + 1, reason: { updatedAt: row.updatedAt.toISOString() } })) });
  const manual = await tx.homeCarouselManualSlot.findMany({ where: { locale: input.locale, enabled: true, deletedAt: null, OR: [{ startsAt: null }, { startsAt: { lte: now } }], AND: [{ OR: [{ endsAt: null }, { endsAt: { gt: now } }] }] }, orderBy: { position: "asc" }, take: config.slotCount });
  const merged: Array<{ novelId: string; articleId: string; source: string; manualSlotId: string | null; batchId: string | null }> = [];
  const seen = new Set<string>();
  for (const row of manual) if (!seen.has(row.novelId)) { seen.add(row.novelId); merged.push({ novelId: row.novelId, articleId: row.articleId, source: "manual", manualSlotId: row.id, batchId: null }); }
  for (const row of selected) if (merged.length < config.slotCount && !seen.has(row.novelId)) { seen.add(row.novelId); merged.push({ novelId: row.novelId, articleId: row.id, source: newest.some((item) => item.id === row.id) ? "new_novel" : "recency", manualSlotId: null, batchId: batch.id }); }
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
  const config = await getHomeCarouselConfig(deps.db);
  if (!Number.isInteger(input.position) || input.position < 1 || input.position > config.slotCount) throw new Error("carousel_position_invalid");
  const article = await deps.db.article.findFirst({ where: { id: input.articleId, locale: input.locale, status: "published", deletedAt: null, novel: { status: "published", deletedAt: null, coverUrl: { not: null } } }, select: { id: true, novelId: true } });
  // C-27: `novelId` is nullable at the type level, but the `novel: {
  // status: "published", ... }` filter above can only match a row whose
  // novel relation resolves (same reasoning as `computeHomeCarouselInTx`'s
  // `CarouselCandidateRowWithNovel` above) — this manual slot feature is
  // Novel-only, same as the auto-candidate path.
  if (!article || article.novelId === null) throw new Error("carousel_article_ineligible");
  // Captured into its own `const` (rather than reading `article.novelId`
  // inside the transaction closure below) so its non-null narrowing from the
  // guard above survives crossing the closure boundary — TS narrows a
  // property access, not the declared type of the object it came from, once
  // that access is re-evaluated inside a nested function.
  const novelId = article.novelId;
  return deps.db.$transaction(async (tx) => {
    const data = { locale: input.locale, position: input.position, articleId: article.id, novelId, enabled: input.enabled, updatedBy: context.identity.id };
    const row = input.id ? await tx.homeCarouselManualSlot.update({ where: { id: input.id }, data }) : await tx.homeCarouselManualSlot.create({ data: { ...data, createdBy: context.identity.id } });
    await tx.homeCarouselChangeLog.create({ data: { locale: input.locale, action: input.id ? "manual.update" : "manual.create", manualSlotId: row.id, actorType: "admin", actorId: context.identity.id, afterState: { position: row.position, articleId: row.articleId, enabled: row.enabled } } });
    return row;
  });
}

/**
 * N-5: manual-slot CRUD was create/update/toggle only. Soft-deletes (writes
 * `deletedAt`, matching the schema's existing column) so a deleted slot
 * drops out of `computeHomeCarouselInTx`'s `deletedAt: null` filter and the
 * next compute falls back to auto candidates for that position. Reuses the
 * `settings:manage` capability but is registered as its own action id,
 * `admin.home_carousel.manual_delete` (PR6 integration): the lane that added
 * this function could not touch `src/app/api/admin/_lib/registry.ts` (shared
 * across the concurrent fix lanes) and so temporarily reused
 * `admin.home_carousel.manual_upsert`. Reusing an id would have made the
 * `operation_audit`/rate-limit entry id of a destructive slot removal
 * indistinguishable from an upsert; the integration pass registered the
 * dedicated id instead. The capability is unchanged.
 */
export async function deleteHomeCarouselManualSlot(input: { authorization: AdminServiceAuthorization; requestId: string; id: string; locale: string }, deps: HomeCarouselDependencies) {
  const context = await auth(input.authorization, "admin.home_carousel.manual_delete", input.requestId, deps);
  return deps.db.$transaction(async (tx) => {
    const row = await tx.homeCarouselManualSlot.update({ where: { id: input.id }, data: { enabled: false, deletedAt: deps.now ?? new Date(), updatedBy: context.identity.id } });
    await tx.homeCarouselChangeLog.create({ data: { locale: input.locale, action: "manual.delete", manualSlotId: row.id, actorType: "admin", actorId: context.identity.id, afterState: { deletedAt: row.deletedAt?.toISOString() ?? null } } });
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

// --- B-1: scheduler wiring -------------------------------------------------
//
// `ScheduleDefinition.dueInstants`/`.build` (src/lib/tasks/scheduler.ts) are
// both synchronous and take no db handle, by contract. `scheduler/index.ts`
// refreshes a closed-over config snapshot from `carouselConfigJson` once per
// tick (before calling `runSchedulerOnce`), and the pure helpers below read
// that snapshot through a `getConfig()` accessor — this is the only way to
// honor a DB-stored cron expression/timezone/enabled flag without changing
// the shared scheduler framework itself.

function parseCronField(field: string, min: number, max: number): Set<number> {
  const values = new Set<number>();
  for (const part of field.split(",")) {
    const trimmed = part.trim();
    if (!trimmed) throw new Error(`empty cron field segment in "${field}"`);
    const [rangePart, stepPart] = trimmed.split("/");
    const step = stepPart !== undefined ? Number.parseInt(stepPart, 10) : 1;
    let start = min;
    let end = max;
    if (rangePart !== "*") {
      const [a, b] = rangePart.split("-");
      start = Number.parseInt(a, 10);
      end = b !== undefined ? Number.parseInt(b, 10) : start;
    }
    if (!Number.isFinite(start) || !Number.isFinite(end) || !Number.isFinite(step) || step <= 0 || start < min || end > max || start > end) {
      throw new Error(`invalid cron field: "${field}"`);
    }
    for (let v = start; v <= end; v += step) values.add(v);
  }
  return values;
}

const CRON_WEEKDAY_INDEX: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/**
 * Minimal 5-field crontab matcher (minute hour day-of-month month
 * day-of-week), evaluated in `timezone` at minute precision. Supports `*`,
 * exact numbers, `a-b` ranges, `*\/n`/`a-b/n` steps, and comma lists of any
 * of those — enough for the default `"0 3 * * *"` and any admin-edited cron
 * string of the same shape. Minute precision matches the scheduler process's
 * own tick cadence (`SCHEDULER_INTERVAL_SECONDS`, default 60s; see
 * scripts/run-scheduler-loop.sh). An unparseable expression is treated as
 * never-due rather than throwing, so a bad admin edit silently stops the
 * cron instead of crashing the scheduler process.
 */
export function isHomeCarouselCronDue(cronSchedule: string, cronTimezone: string, at: Date): boolean {
  const fields = cronSchedule.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  let minutes: Set<number>, hours: Set<number>, days: Set<number>, months: Set<number>, weekdays: Set<number>;
  try {
    minutes = parseCronField(fields[0], 0, 59);
    hours = parseCronField(fields[1], 0, 23);
    days = parseCronField(fields[2], 1, 31);
    months = parseCronField(fields[3], 1, 12);
    weekdays = parseCronField(fields[4], 0, 6);
  } catch {
    return false;
  }
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: cronTimezone, hour12: false, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", weekday: "short",
    }).formatToParts(at).map((part) => [part.type, part.value] as const),
  );
  const weekday = CRON_WEEKDAY_INDEX[parts.weekday];
  if (weekday === undefined) return false;
  const hour = Number.parseInt(parts.hour, 10) % 24;
  return (
    minutes.has(Number.parseInt(parts.minute, 10))
    && hours.has(hour)
    && days.has(Number.parseInt(parts.day, 10))
    && months.has(Number.parseInt(parts.month, 10))
    && weekdays.has(weekday)
  );
}

function floorToMinute(date: Date): Date {
  return new Date(Math.floor(date.getTime() / 60_000) * 60_000);
}

/** Pure builder shared by the `ScheduleDefinition.build` path and `enqueueHomeCarouselCron`, so both produce byte-identical `ScheduledTaskInput`s. */
export function buildHomeCarouselCronTaskInput(config: HomeCarouselConfig, scheduledFor: Date): ScheduledTaskInput {
  const businessDate = homeCarouselBusinessDate(scheduledFor, config.cronTimezone);
  return {
    scheduleKey: HOME_CAROUSEL_SCHEDULE_KEY,
    scheduleRevision: 1,
    scheduledFor,
    timezone: config.cronTimezone,
    taskType: HOME_CAROUSEL_TASK_TYPE,
    params: { locale: "en" },
    items: [{ targetType: "home_carousel", targetId: businessDate, payload: { locale: "en", source: "cron" } }],
  };
}

/**
 * B-1 #1: the first production `ScheduleDefinition` registered into
 * `scheduler/index.ts`'s `SCHEDULES`. `cronEnabled=false` makes
 * `dueInstants` return no instants at all, so `runSchedulerOnce` never
 * reaches `enqueueScheduledTask` for this schedule — no ScheduleRun,
 * CronRun, or GenericTask row is created (nothing to skip after the fact).
 */
export function buildHomeCarouselScheduleDefinition(getConfig: () => HomeCarouselConfig): ScheduleDefinition {
  return {
    scheduleKey: HOME_CAROUSEL_SCHEDULE_KEY,
    dueInstants(now: Date): Date[] {
      const config = getConfig();
      if (!config.cronEnabled) return [];
      const tick = floorToMinute(now);
      return isHomeCarouselCronDue(config.cronSchedule, config.cronTimezone, tick) ? [tick] : [];
    },
    build(scheduledFor: Date): ScheduledTaskInput {
      return buildHomeCarouselCronTaskInput(getConfig(), scheduledFor);
    },
  };
}

/**
 * Async convenience wrapper for ops runbooks and tests that need to
 * force-enqueue the cron task without waiting for the scheduler's next
 * minute tick. Reads config itself (rather than requiring a caller to fetch
 * it first) and honors the same `cronEnabled` gate as `dueInstants` above;
 * shares `buildHomeCarouselCronTaskInput` so the two paths can never drift.
 */
export async function enqueueHomeCarouselCron(db: PrismaClient, registry: TaskHandlerRegistry, scheduledFor: Date) {
  const config = await getHomeCarouselConfig(db);
  if (!config.cronEnabled) return { status: "skipped_disabled" as const };
  return enqueueScheduledTask(db, registry, buildHomeCarouselCronTaskInput(config, scheduledFor));
}

// --- N-6: admin page read models -------------------------------------------

/** Most recent auto batch's candidates, ranked — the "最新批候选" block. */
export async function listLatestHomeCarouselCandidates(db: PrismaClient, locale: string, take = 20) {
  const latestBatch = await db.homeCarouselAutoBatch.findFirst({
    where: { localeScope: locale },
    orderBy: { createdAt: "desc" },
    select: { id: true, status: true, triggerSource: true, createdAt: true, finishedAt: true },
  });
  if (!latestBatch) return { batch: null, candidates: [] as const };
  const candidates = await db.homeCarouselAutoCandidate.findMany({
    where: { batchId: latestBatch.id },
    orderBy: { rank: "asc" },
    take,
    select: { id: true, rank: true, source: true, novelId: true, articleId: true, novel: { select: { title: true } } },
  });
  return { batch: latestBatch, candidates };
}

/** Current serving snapshot, positioned — the "serving 预览" block; source distinguishes manual/new_novel/recency. */
export async function listHomeCarouselServing(db: PrismaClient, locale: string) {
  return db.homeCarouselServing.findMany({
    where: { locale },
    orderBy: { position: "asc" },
    select: { id: true, position: true, source: true, novelId: true, articleId: true, manualSlotId: true, batchId: true, mergedAt: true, novel: { select: { title: true } } },
  });
}

/** Most recent change-log entries — append-only, read-only "change log" block. */
export async function listHomeCarouselChangeLog(db: PrismaClient, locale: string, take = 50) {
  return db.homeCarouselChangeLog.findMany({
    where: { locale },
    orderBy: { createdAt: "desc" },
    take,
    select: { id: true, action: true, actorType: true, actorId: true, manualSlotId: true, afterState: true, createdAt: true },
  });
}
