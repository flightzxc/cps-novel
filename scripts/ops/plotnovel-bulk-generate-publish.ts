/** One-off orchestration, archived on ops/plotnovel-bulk-publish-20261015 only.
 * Production: docker exec -w /app <web> tsx --tsconfig /app/tsconfig.json
 * /tmp/plotnovel-bulk-generate-publish.ts <command> ... </dev/null
 * No alternate DATABASE_URL flag, business SQL writes, upstream calls or repair path.
 * plan/status reads are transaction READ ONLY; plan's only output write is its manifest.
 * The host operator supervises logs/backlog every 30s and authorizes each wave separately.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync, rmdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Prisma, PrismaClient } from "@prisma/client";

export const BASELINE = "cb255e0f1c93041eda6aefeefbb541d7eddfc15f";
export const FINAL = "cb255e0f1c93041eda6aefeefbb541d7eddfc15f";
export const OPERATION = "plotnovel-b47-republish-2026-10-16";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA = /^[0-9a-f]{64}$/;
const TERMINAL = ["completed", "completed_with_errors", "failed", "cancelled"];
export type Api = {
  admissions: typeof import("../../src/server/content-creation/eligibility").resolveArticleGenerateAdmissions;
  promos: typeof import("../../src/server/content-creation/promo").resolveReadyPromoLinksForNovels;
  generate: typeof import("../../src/lib/tasks/article-generate").enqueueArticleGenerateBatch;
  publish: typeof import("../../src/server/publish-gate/service").publishArticlesBatch;
  control: typeof import("../../src/lib/indexnow/delivery-control").getIndexNowDeliveryControlState;
  sitemap: typeof import("../../src/server/sitemap-admin/service").getAdminSitemapState;
};
export type Manifest = {
  schema: 1; operation: typeof OPERATION; baseline: typeof BASELINE; createdAt: string;
  actorId: string; appId: string; locale: "en"; manualReviewBaseline: number;
  publishedBaseline: number; existingPreviewNovelIds: string[]; eligibleCount: number; blockedReasons: Record<string, number>;
  waves: { wave: number; chunks: { chunk: number; novelIds: string[] }[] }[];
};
export class OpsError extends Error { constructor(readonly code: string) { super(code); } }
function requireThat(condition: unknown, code: string): asserts condition { if (!condition) throw new OpsError(code); }
export function sha256(bytes: string | Buffer) { return createHash("sha256").update(bytes).digest("hex"); }
const record = (x: unknown): Record<string, unknown> => x && typeof x === "object" && !Array.isArray(x) ? x as Record<string, unknown> : {};
export function generationFailurePolicy(errors: readonly unknown[], expected: number) {
  // worker/runtime/worker.ts persists the error class in this exact redacted message.
  // finalize_failed alone also covers database/permission failures and is never sufficient.
  const knownTemplateFailures = errors.filter(error => {
    const e = record(error);
    return e.code === "finalize_failed" && e.message === "Item finalize failed: TemplateRenderError";
  }).length;
  const otherFailures = errors.length - knownTemplateFailures;
  return { knownTemplateFailures, otherFailures,
    allowed: Number.isSafeInteger(expected) && expected > 0 && otherFailures === 0 && knownTemplateFailures === 0 };
}
const equalIds = (a: readonly string[], b: readonly string[]) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
export function chunksFor(ids: readonly string[]): Manifest["waves"] {
  const sorted = [...new Set(ids)].sort();
  return Array.from({ length: Math.ceil(sorted.length / 500) }, (_, w) => ({ wave: w + 1,
    chunks: Array.from({ length: Math.ceil(Math.min(500, sorted.length - w * 500) / 200) }, (_, c) => ({
      chunk: c + 1, novelIds: sorted.slice(w * 500 + c * 200, Math.min(w * 500 + (c + 1) * 200, (w + 1) * 500)),
    })),
  }));
}
export function validateManifest(x: Manifest): void {
  requireThat(x && x.schema === 1 && x.operation === OPERATION && x.baseline === BASELINE && x.locale === "en", "manifest_identity_invalid");
  requireThat(UUID.test(x.actorId) && UUID.test(x.appId) && Number.isFinite(Date.parse(x.createdAt)), "manifest_metadata_invalid");
  requireThat(Number.isSafeInteger(x.manualReviewBaseline) && x.manualReviewBaseline >= 0 && Number.isSafeInteger(x.publishedBaseline) && x.publishedBaseline >= 0, "manifest_baseline_invalid");
  requireThat(Array.isArray(x.waves) && Number.isSafeInteger(x.eligibleCount) && x.eligibleCount >= 0, "manifest_waves_invalid");
  const ids = x.waves.flatMap(w => w.chunks.flatMap(c => c.novelIds));
  requireThat(ids.length === x.eligibleCount && ids.every(id => typeof id === "string" && UUID.test(id)) && new Set(ids).size === ids.length, "manifest_ids_invalid");
  requireThat(Array.isArray(x.existingPreviewNovelIds) && new Set(x.existingPreviewNovelIds).size === x.existingPreviewNovelIds.length && x.existingPreviewNovelIds.every(id => ids.includes(id)), "manifest_preview_baseline_invalid");
  requireThat(JSON.stringify(x.waves) === JSON.stringify(chunksFor(ids)), "manifest_partition_invalid");
}
export type Args = { command: "plan" | "generate" | "publish" | "status"; actorId: string; output?: string; manifest?: string; digest?: string; wave?: number; confirm?: string };
export function parseArgs(argv: readonly string[]): Args {
  const [command, ...rest] = argv;
  requireThat(["plan", "generate", "publish", "status"].includes(command), "usage_command_required");
  const values: Record<string, string> = {};
  for (let i = 0; i < rest.length; i += 2) {
    const flag = rest[i];
    requireThat(["--actor-id", "--output", "--manifest", "--manifest-sha256", "--wave", "--confirm"].includes(flag) && !values[flag] && !!rest[i + 1] && !rest[i + 1].startsWith("--"), "usage_invalid_argument");
    values[flag] = rest[i + 1];
  }
  const actorId = values["--actor-id"];
  requireThat(typeof actorId === "string" && UUID.test(actorId), "actor_id_required");
  if (command === "plan") requireThat(values["--output"] && Object.keys(values).length === 2, "plan_arguments_invalid");
  else {
    requireThat(values["--manifest"] && SHA.test(values["--manifest-sha256"] ?? "") && /^[1-9][0-9]*$/.test(values["--wave"] ?? ""), "manifest_digest_wave_required");
    requireThat(Object.keys(values).length === (command === "status" ? 4 : 5), "command_arguments_invalid");
    if (command !== "status") requireThat(values["--confirm"] === `PLOTNOVEL_BULK_${command.toUpperCase()}`, "confirmation_refused");
  }
  return { command: command as Args["command"], actorId, output: values["--output"], manifest: values["--manifest"], digest: values["--manifest-sha256"], wave: Number(values["--wave"]), confirm: values["--confirm"] };
}
export function loadManifest(file: string, digest: string): Manifest {
  const bytes = readFileSync(file); requireThat(SHA.test(digest) && sha256(bytes) === digest, "manifest_sha256_mismatch");
  const x = JSON.parse(bytes.toString("utf8")) as Manifest; validateManifest(x); return x;
}
export const generationRequest = (w: number, c: number) => `${OPERATION}-w${w}-c${c}`;
export const publicationRequest = (w: number, c: number) => `plotnovel-b47-republish-publish-2026-10-16-w${w}-c${c}`;
export async function readOnly<T>(db: PrismaClient, f: (tx: Prisma.TransactionClient) => Promise<T>) {
  return db.$transaction(async tx => { await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY"); return f(tx); }, { isolationLevel: "RepeatableRead", timeout: 120_000 });
}
async function context(tx: Prisma.TransactionClient, actorId: string) {
  const [identity] = await tx.$queryRaw<Array<{ role: string; db: string; readonly: string }>>`SELECT current_user::text role,current_database()::text db,current_setting('transaction_read_only') readonly`;
  requireThat(identity.role === "web_app" && identity.readonly === "on", "web_app_readonly_required");
  requireThat(identity.db === "cps_novel" || identity.db.startsWith("cps_novel_plotnovel_"), "database_refused");
  if (identity.db === "cps_novel") {
    const meta = JSON.parse(readFileSync("/app/.build-metadata.json", "utf8"));
    requireThat(process.cwd() === "/app" && meta.commit === FINAL && meta.version === "0.6.1", "production_identity_mismatch");
  }
  const admin = await tx.adminIdentity.findUnique({ where: { id: actorId }, select: { id: true, username: true, role: true, status: true } });
  requireThat(admin?.username === "admin" && admin.role === "super_admin" && admin.status === "active", "owner_admin_refused");
  const apps = await tx.channelApp.findMany({ where: { sourceApp: { code: "plotnovel" } }, select: { id: true, status: true } });
  requireThat(apps.length === 1 && apps[0].status === "active", "plotnovel_app_refused");
  const appId = apps[0].id;
  const claim = await tx.channelCapability.findUnique({ where: { channelAppId_capabilityKey: { channelAppId: appId, capabilityKey: "claimPromo" } }, select: { status: true } });
  requireThat(claim?.status === "registered_disabled", "claim_must_remain_disabled");
  const manualReview = await tx.sideEffectIntent.count({ where: { channelAppId: appId, status: "manual_review_required" } });
  return { actor: admin, databaseRole: identity.role, transactionReadOnly: identity.readonly, appId, manualReview };
}
const novelSelect = { id: true, title: true, locale: true, businessId: true, updatedAt: true, deletedAt: true, articles: { select: { id: true, locale: true, deletedAt: true } } } as const;
function plotWhere(appId: string): Prisma.NovelWhereInput {
  return { locale: "en", deletedAt: null, sourceItems: { some: { channelAppId: appId, sourceLocale: "en", deletedAt: null, status: "linked" } } };
}
// Passed explicitly rather than a mutable process-global dependency.
async function scopeWithApi(tx: Prisma.TransactionClient, m: Manifest, api: Api) {
  const ctx = await context(tx, m.actorId);
  requireThat(ctx.appId === m.appId && ctx.manualReview === m.manualReviewBaseline, "protected_baseline_changed");
  const ids = m.waves.flatMap(w => w.chunks.flatMap(c => c.novelIds));
  const found = await tx.novel.findMany({ where: { ...plotWhere(m.appId), id: { in: ids } }, select: { id: true } });
  requireThat(equalIds(found.map(x => x.id), ids), "manifest_foreign_or_missing_novel");
  const globalPublished = await tx.article.count({ where: { status: "published", deletedAt: null, promoLink: { channelAppId: m.appId } } });
  const manifestPublished = await tx.article.count({ where: { status: "published", deletedAt: null, novelId: { in: ids }, promoLink: { channelAppId: m.appId } } });
  requireThat(globalPublished === m.publishedBaseline + manifestPublished, "published_baseline_interference");
  const resolutions = await api.promos(tx, ids);
  const readyIds = [...resolutions.values()].flatMap(x => x.outcome === "ready" ? [x.promo.id] : []);
  requireThat(readyIds.length === ids.length && await tx.promoLink.count({ where: { id: { in: readyIds }, channelAppId: m.appId } }) === ids.length, "resolved_promo_scope_changed");
  return ctx;
}
async function validPreviewIds(tx: Prisma.TransactionClient, ids: string[]): Promise<Set<string>> {
  if (!ids.length) return new Set();
  const rows = await tx.$queryRawUnsafe<Array<{ novel_id: string }>>(`SELECT DISTINCT c.novel_id FROM novel_chapter c JOIN novel_chapter_content cc ON cc.novel_chapter_id=c.id JOIN novel_preview_policy p ON p.novel_id=c.novel_id WHERE c.novel_id=ANY($1::uuid[]) AND c.status='preview' AND c.deleted_at IS NULL AND btrim(cc.body)<>'' AND p.display_authorized AND p.materialized_chapter_count>0`, ids);
  return new Set(rows.map(x => x.novel_id));
}
async function createPlan(db: PrismaClient, api: Api, actorId: string) {
  return readOnly(db, async tx => {
    const ctx = await context(tx, actorId);
    const candidates = await tx.novel.findMany({ where: plotWhere(ctx.appId), select: novelSelect, orderBy: { id: "asc" } });
    const eligible: string[] = [], blockedReasons: Record<string, number> = {};
    for (let i = 0; i < candidates.length; i += 200) {
      const rows = candidates.slice(i, i + 200), ids = rows.map(x => x.id);
      const admissions = await api.admissions(tx, ids, rows), promos = await api.promos(tx, ids);
      const promoIds = [...promos.values()].flatMap(x => x.outcome === "ready" ? [x.promo.id] : []);
      const ownPromos = new Set((await tx.promoLink.findMany({ where: { id: { in: promoIds }, channelAppId: ctx.appId }, select: { id: true } })).map(x => x.id));
      for (const id of ids) {
        const a = admissions.get(id)!, p = promos.get(id);
        const reason = !a.canGenerate ? a.blockedReason! : p?.outcome !== "ready" || !ownPromos.has(p.promo.id) ? "resolved_promo_outside_plotnovel" : null;
        if (reason) blockedReasons[reason] = (blockedReasons[reason] ?? 0) + 1; else eligible.push(id);
      }
    }
    const publishedBaseline = await tx.article.count({ where: { status: "published", deletedAt: null, promoLink: { channelAppId: ctx.appId } } });
    const manifest: Manifest = { schema: 1, operation: OPERATION, baseline: BASELINE, createdAt: new Date().toISOString(), actorId, appId: ctx.appId, locale: "en", manualReviewBaseline: ctx.manualReview, publishedBaseline, existingPreviewNovelIds: [...await validPreviewIds(tx, eligible)].sort(), eligibleCount: eligible.length, blockedReasons, waves: chunksFor(eligible) };
    return { manifest, context: ctx, population: candidates.length };
  });
}
async function taskFor(tx: Prisma.TransactionClient, m: Manifest, w: number, c: number) {
  const tasks = await tx.genericTask.findMany({ where: { taskType: "article.generate.v1", params: { path: ["requestId"], equals: generationRequest(w, c) } }, select: {
    id: true, params: true, status: true, totalCount: true, items: { select: { id: true, targetId: true, status: true, result: true, error: true } },
  } });
  requireThat(tasks.length <= 1, "generation_task_ambiguous");
  const t = tasks[0];
  if (t) {
    const p = record(t.params), chunk = m.waves[w - 1].chunks[c - 1];
    requireThat(p.actorId === m.actorId && Array.isArray(p.novelIds) && equalIds(p.novelIds as string[], chunk.novelIds), "generation_task_scope_mismatch");
    requireThat(t.items.length === chunk.novelIds.length && equalIds(t.items.map(i => i.targetId), chunk.novelIds), "generation_item_count_mismatch");
  }
  return t;
}
async function waveRows(tx: Prisma.TransactionClient, m: Manifest, w: number) {
  const blocks = m.waves[w - 1]; requireThat(blocks, "wave_out_of_range");
  const tasks = await Promise.all(blocks.chunks.map(c => taskFor(tx, m, w, c.chunk)));
  const items = tasks.flatMap(t => t?.items ?? []), ids = blocks.chunks.flatMap(c => c.novelIds);
  const articles = await tx.article.findMany({ where: { novelId: { in: ids }, locale: "en" }, select: { id: true, novelId: true, status: true, deletedAt: true, publishedAt: true, promoLink: { select: { channelAppId: true } } } });
  const owned = new Set(items.filter(i => i.status === "success" && record(i.result).outcome === "created").map(i => record(i.result).articleId));
  requireThat(articles.every(a => !a.deletedAt && a.promoLink?.channelAppId === m.appId && owned.has(a.id)), "foreign_or_changed_article");
  const generation = { expected: ids.length, notSubmitted: blocks.chunks.filter((_, i) => !tasks[i]).reduce((n, c) => n + c.novelIds.length, 0), pending: 0, success: 0, failed: 0, skipped: 0 };
  for (const i of items) {
    if (i.status === "success") { requireThat(record(i.result).outcome === "created" && articles.some(a => a.id === record(i.result).articleId && a.novelId === i.targetId), "generation_result_mismatch"); generation.success++; }
    else if (i.status === "failed") generation.failed++;
    else if (i.status === "skipped") generation.skipped++;
    else { requireThat(["pending", "processing"].includes(i.status), "generation_item_state_refused"); generation.pending++; }
  }
  requireThat(Object.entries(generation).filter(([k]) => k !== "expected").reduce((n, [, v]) => n + v, 0) === ids.length, "generation_accounting_mismatch");
  const failurePolicy = generationFailurePolicy(items.filter(i => i.status === "failed").map(i => i.error), ids.length);
  return { blocks, tasks, articles, generation, failurePolicy, tasksTerminal: tasks.every(t => t && TERMINAL.includes(t.status)) };
}
async function downstream(tx: Prisma.TransactionClient, api: Api) {
  const control = await api.control(tx);
  const failures = await tx.indexNowOutbox.groupBy({ by: ["status"], where: { status: { in: ["dead_letter", "permanent_failed", "retry_wait"] } }, _count: { _all: true } });
  return { breakerOpen: control.breaker.open, rateLimitWaiting: control.rateLimit.waiting, deadLetters: failures.find(x => x.status === "dead_letter")?._count._all ?? 0, blockedUrls: failures.reduce((n, x) => n + x._count._all, 0) };
}
async function statusInTx(tx: Prisma.TransactionClient, m: Manifest, w: number, api: Api) {
  const rows = await waveRows(tx, m, w), published = rows.articles.filter(a => a.status === "published"), articleIds = published.map(a => a.id);
  const outbox = await tx.indexNowOutbox.findMany({ where: { articleId: { in: articleIds } }, select: { articleId: true, status: true } });
  const accepted = published.filter(a => outbox.some(o => o.articleId === a.id && o.status === "accepted") && !outbox.some(o => o.articleId === a.id && o.status !== "accepted")).length;
  const novelIds = published.map(a => a.novelId!);
  const fresh = await validPreviewIds(tx, novelIds);
  const previews = await tx.channelSyncTaskItem.findMany({ where: { novelSourceItem: { novelId: { in: novelIds }, channelAppId: m.appId }, task: { taskType: "moboreader.preview_refresh.v1", mode: "apply" } }, select: { status: true, createdAt: true, taskId: true, novelSourceItem: { select: { novelId: true } } }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
  const latest = new Map<string, typeof previews[number]>(); for (const i of previews) if (!latest.has(i.novelSourceItem.novelId!)) latest.set(i.novelSourceItem.novelId!, i);
  const preview = { expected: published.length, alreadyValid: novelIds.filter(id => m.existingPreviewNovelIds.includes(id) && fresh.has(id)).length, completed: fresh.size, failed: 0, pending: 0, missing: 0, taskIds: [...new Set(previews.map(p => p.taskId))] };
  for (const id of novelIds) if (!fresh.has(id)) { const i = latest.get(id); if (!i) preview.missing++; else if (i.status === "failed") { preview.failed++; preview.completed++; } else if (["success", "skipped"].includes(i.status)) preview.missing++; else preview.pending++; }
  const backlog = await tx.channelSyncTaskItem.groupBy({ by: ["status"], where: { task: { taskType: "moboreader.preview_refresh.v1", mode: "apply" }, status: { in: ["pending", "processing", "success", "failed", "skipped"] } }, _count: { _all: true } });
  // getAdminSitemapState only uses genericTask reads; the transaction enforces RO.
  const sitemap = await api.sitemap(tx as PrismaClient);
  const controls = await downstream(tx, api), g = rows.generation;
  const latestPublish = published.reduce((n, a) => Math.max(n, a.publishedAt?.getTime() ?? 0), 0);
  const missingOutbox = published.filter(a => !outbox.some(o => o.articleId === a.id)).length;
  const stopReasons: string[] = [];
  if (missingOutbox) stopReasons.push("indexnow_outbox_missing");
  if (controls.breakerOpen || controls.rateLimitWaiting || controls.blockedUrls) stopReasons.push("indexnow_control_stop");
  if (outbox.some(o => !["accepted", "pending", "processing"].includes(o.status))) stopReasons.push("indexnow_nonaccepted_failure");
  if (!rows.failurePolicy.allowed || g.skipped > 0) stopReasons.push("generation_failure_or_skipped");
  if (preview.missing > 0) stopReasons.push("preview_dispatch_or_content_missing");
  if (preview.failed / preview.expected > .1) stopReasons.push("preview_failure_rate");
  const readyForNextWave = stopReasons.length === 0 && rows.tasksTerminal && g.notSubmitted === 0 && g.pending === 0 && g.skipped === 0 && rows.failurePolicy.allowed && published.length === g.success && accepted === published.length && !controls.breakerOpen && !controls.rateLimitWaiting && controls.blockedUrls === 0 && preview.expected > 0 && preview.missing === 0 && preview.completed / preview.expected >= .95 && preview.failed / preview.expected <= .1 && sitemap.lastGeneration.status === "success" && Date.parse(sitemap.lastGeneration.finishedAt ?? "") >= latestPublish && !!sitemap.task && TERMINAL.includes(sitemap.task.status) && sitemap.task.status === "completed";
  return { wave: w, generation: g, generationFailurePolicy: rows.failurePolicy, generationTasks: rows.tasks.map(t => t ? { id: t.id, status: t.status, total: t.totalCount } : null), drafts: rows.articles.filter(a => a.status === "draft").length, published: published.length, indexnow: { accepted, pending: published.length - accepted - missingOutbox, missing: missingOutbox, ...controls }, preview, mainPreviewBacklog: Object.fromEntries(backlog.map(x => [x.status, x._count._all])), sitemap, stopReasons, readyForNextWave };
}
function assertDownstream(x: Awaited<ReturnType<typeof downstream>>) { requireThat(!x.breakerOpen && !x.rateLimitWaiting && x.blockedUrls === 0, "indexnow_stop_condition"); }
function safeError(error: unknown) { const c = record(error).code; return typeof c === "string" && /^[a-zA-Z0-9_]{1,100}$/.test(c) ? c : "unexpected_error"; }
export async function runCommand(args: Args, db: PrismaClient, api: Api, emit: (x: unknown) => void = x => console.log(JSON.stringify(x))) {
  if (args.command === "plan") {
    const p = await createPlan(db, api, args.actorId); validateManifest(p.manifest);
    const bytes = JSON.stringify(p.manifest, null, 2) + "\n";
    writeFileSync(args.output!, bytes, { flag: "wx", mode: 0o600 });
    const result = { command: "plan", actor: p.context.actor, databaseRole: p.context.databaseRole, transactionReadOnly: p.context.transactionReadOnly, appId: p.context.appId, population: p.population, eligibleCount: p.manifest.eligibleCount, blockedReasons: p.manifest.blockedReasons, manualReview: p.context.manualReview, publishedBaseline: p.manifest.publishedBaseline, manifest: args.output, manifestSha256: sha256(bytes), waves: p.manifest.waves.map(w => ({ wave: w.wave, count: w.chunks.flatMap(c => c.novelIds).length, chunks: w.chunks.map(c => c.novelIds.length) })) };
    emit(result); return result;
  }
  const m = loadManifest(args.manifest!, args.digest!); requireThat(args.actorId === m.actorId && !!m.waves[args.wave! - 1], "manifest_actor_or_wave_mismatch");
  await readOnly(db, tx => scopeWithApi(tx, m, api));
  if (args.command === "status") { const result = await readOnly(db, tx => statusInTx(tx, m, args.wave!, api)); emit(result); return result; }
  requireThat(args.confirm === `PLOTNOVEL_BULK_${args.command.toUpperCase()}`, "confirmation_refused");
  const journal = args.manifest! + ".execution.jsonl", lock = args.manifest! + ".lock";
  mkdirSync(lock, { mode: 0o700 });
  const event = (x: Record<string, unknown>) => { const row = { at: new Date().toISOString(), manifestSha256: args.digest, ...x }; appendFileSync(journal, JSON.stringify(row) + "\n", { mode: 0o600 }); emit(row); };
  let interrupted = false; const stop = () => { interrupted = true; };
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
  try {
    if (existsSync(journal)) for (const line of readFileSync(journal, "utf8").trim().split("\n")) { const r = JSON.parse(line); requireThat(r.manifestSha256 === args.digest && r.event !== "stop", "prior_stop_or_journal_mismatch"); }
    assertDownstream(await readOnly(db, tx => downstream(tx, api)));
    if (args.wave! > 1) requireThat((await readOnly(db, tx => statusInTx(tx, m, args.wave! - 1, api))).readyForNextWave, "previous_wave_not_ready");
    if (args.command === "publish") {
      const rows = await readOnly(db, tx => waveRows(tx, m, args.wave!)), g = rows.generation;
      requireThat(rows.tasksTerminal && g.notSubmitted === 0 && g.pending === 0 && g.skipped === 0 && rows.failurePolicy.allowed, "generation_not_publishable");
    }
    for (const c of m.waves[args.wave! - 1].chunks) {
      requireThat(!interrupted, "operator_interrupted");
      await readOnly(db, tx => scopeWithApi(tx, m, api)); assertDownstream(await readOnly(db, tx => downstream(tx, api)));
      const requestId = args.command === "generate" ? generationRequest(args.wave!, c.chunk) : publicationRequest(args.wave!, c.chunk);
      if (args.command === "generate") {
        const existing = await readOnly(db, tx => taskFor(tx, m, args.wave!, c.chunk));
        if (!existing) await readOnly(db, async tx => {
          const rows = await tx.novel.findMany({ where: { id: { in: c.novelIds } }, select: novelSelect });
          const a = await api.admissions(tx, c.novelIds, rows); requireThat(c.novelIds.every(id => a.get(id)?.canGenerate), "admission_changed");
        });
        const r = await api.generate(db, { novelIds: c.novelIds, actorId: m.actorId, requestId });
        event({ event: "generate", wave: args.wave, chunk: c.chunk, requestId, ...r });
        requireThat(r.admission.blockedCount === 0 && r.admission.submittedCount === c.novelIds.length, "generation_admission_changed");
        await readOnly(db, tx => taskFor(tx, m, args.wave!, c.chunk));
      } else {
        const rows = await readOnly(db, tx => waveRows(tx, m, args.wave!));
        const blockArticles = rows.articles.filter(a => c.novelIds.includes(a.novelId!));
        for (const a of blockArticles.filter(a => a.status === "published")) {
          const audit = await readOnly(db, tx => tx.operationAudit.count({ where: { actorType: "admin", actorId: m.actorId, action: "article.publish", entityId: a.id, requestId: `${requestId}:${a.id}` } }));
          requireThat(audit === 1, "foreign_publication_refused");
        }
        requireThat(blockArticles.every(a => ["draft", "published"].includes(a.status)), "article_state_changed");
        const articleIds = blockArticles.filter(a => a.status === "draft").map(a => a.id).sort();
        if (!articleIds.length) { event({ event: "publish_noop", wave: args.wave, chunk: c.chunk, requestId, alreadyPublished: blockArticles.length }); continue; }
        const r = await api.publish(db, { articleIds, requestId, actor: { type: "admin", adminId: m.actorId } });
        const counts = { published: 0, rejected: 0, conflict: 0, not_found: 0 };
        for (const item of r.results) counts[item.result.outcome]++;
        const unexpectedRepublications = r.results.filter(i => i.result.outcome === "published" && !i.result.firstPublish).length;
        event({ event: "publish", wave: args.wave, chunk: c.chunk, requestId, ...counts, unexpectedRepublications, aborted: !!r.aborted, notProcessed: r.aborted ? 1 + r.aborted.notProcessedArticleIds.length : 0 });
        requireThat(!r.aborted && unexpectedRepublications === 0 && counts.rejected === 0 && counts.conflict === 0 && counts.not_found === 0 && counts.published === articleIds.length, "publish_stopped");
      }
    }
    requireThat(!interrupted, "operator_interrupted");
    return { command: args.command, wave: args.wave, completed: true };
  } catch (error) { event({ event: "stop", command: args.command, wave: args.wave, code: safeError(error) }); throw error; }
  finally { process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop); rmdirSync(lock); }
}
export function loadApi(root = process.cwd()): Api {
  const req = createRequire(path.join(root, "package.json"));
  return { admissions: req("./src/server/content-creation/eligibility.ts").resolveArticleGenerateAdmissions, promos: req("./src/server/content-creation/promo.ts").resolveReadyPromoLinksForNovels, generate: req("./src/lib/tasks/article-generate.ts").enqueueArticleGenerateBatch, publish: req("./src/server/publish-gate/service.ts").publishArticlesBatch, control: req("./src/lib/indexnow/delivery-control.ts").getIndexNowDeliveryControlState, sitemap: req("./src/server/sitemap-admin/service.ts").getAdminSitemapState };
}
async function main() {
  const args = parseArgs(process.argv.slice(2));
  const req = createRequire(path.join(process.cwd(), "package.json")), { PrismaClient: Client } = req("@prisma/client") as typeof import("@prisma/client");
  const db = new Client();
  try { await runCommand(args, db, loadApi()); } finally { await db.$disconnect(); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(JSON.stringify({ status: "STOP", code: safeError(error) })); process.exitCode = 1; });
