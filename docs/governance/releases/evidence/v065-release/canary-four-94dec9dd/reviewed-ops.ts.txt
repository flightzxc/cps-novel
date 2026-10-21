/** One-off ops branch only; no upstream calls or alternate database connection.
 * Production: docker exec -w /app <web> tsx --tsconfig /app/tsconfig.json
 * /tmp/promo-reclaim-53.ts plan|submit|submit-canary|status ...
 * Owner approval + confirmation + externally pinned manifest + explicit Owner
 * actor replace the browser session/2FA (Owner decision 2026-10-20).
 * captureBaseline is used by the read-only phase-A evidence wrapper before canaries.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Prisma, PrismaClient } from "@prisma/client";
import type { PromoLinkClaimCredentialWarning } from "../../src/domain/catalog-batch";

export const FINAL = "b378910a8ec4b78029e71ad1bac92c742efb9f5b";
export const REQUEST_ID = "promo-reclaim-53-2026-10-20";
export const CANARY_REQUEST_ID = "promo-reclaim-53-2026-10-20-canary";
// Owner/controller 2026-10-21: catalog_scan 84a47861 resolved MINE; never submit it.
export const RESOLVED_MINE_ID = "c838c281-c9ba-482a-aa80-05792e8fdc4a";
export const APP = "85c2fb3e-28f8-476a-83f2-9647e2206192";
export const ACTOR = "71f0e655-0640-4f07-bcbb-041f027fa7cb";
export const PLOT_APP = "00de5521-d075-4472-87eb-cc5d1732f4d0";
export const PREFIXES = `419b62f9 3e82bd35 244d728f 1de3cb8d 14ceb128 4456a587
191da4c8 2bd7bbd6 29e12e67 004e61b4 514635fd 4ebd962b 3cb68965 0eb75634 1428d0e8
34a53d25 2ede37d3 4265a05f 50cdc502 14fb4ba6 51f07fe6 06385053 544ac759 19aac9d5
472acb5b 290c0772 2a116408 5305ceef c838c281 014e3a56 49e254d4 053c5b33 1252d311
182dc738 29eb1a73 374e5d3c 081bfcd3 022b9efe 33b86265 2439f2b1 2975ad34 35e28f43
38ff68bb 40c1c63c 3b727395 2bedc1f0 410119f1 44311f5e 33029497 3ff5573b 005dfe6a
1e47a937 17f20eb7`.split(/\s+/).sort();
export const CANARY_PREFIXES = ["c838c281", "17f20eb7", "49e254d4", "4265a05f", "191da4c8"].sort();
const SHA = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const root = process.cwd() === "/app" ? "/app" : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const load = createRequire(path.join(root, "package.json"));
const { PrismaClient: Client } = load("@prisma/client") as typeof import("@prisma/client");
const { normalizeCatalogSelection } = load(path.join(root, "src/domain/catalog-batch")) as typeof import("../../src/domain/catalog-batch");
const { enqueueCatalogBatch, CatalogBatchInputError } = load(path.join(root, "src/lib/tasks/catalog-batch")) as typeof import("../../src/lib/tasks/catalog-batch");
const { resolveClaimCredentialAdmission } = load(path.join(root, "src/lib/credentials/claim-readiness")) as typeof import("../../src/lib/credentials/claim-readiness");
const { isPromoLinkClaimEnabled, isPromoLinkClaimWriteAllowed } = load(path.join(root, "src/lib/flags")) as typeof import("../../src/lib/flags");
let prisma: PrismaClient;
export class OpsError extends Error { constructor(readonly code: string, readonly sourceItemId?: string) { super(code); } }
function check(condition: unknown, code: string): asserts condition { if (!condition) throw new OpsError(code); }
export const sha256 = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
export const idsSha = (ids: readonly string[]) => sha256([...ids].sort().join("\n") + "\n");
const object = (x: unknown): Record<string, unknown> => x && typeof x === "object" && !Array.isArray(x) ? x as Record<string, unknown> : {};
const same = (a: readonly string[], b: readonly string[]) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

// Verbatim copy: baseline 58cdb94da40e3103ddc4ebba7c267ce0c23b905e,
// src/app/(admin)/catalog-sync/_actions.ts:477-496. Owner-authorized duplication.
// Keep the original hook semantics and reset warnings on every transaction retry.
async function validatePromoAccountConfiguration(
  db: Pick<typeof prisma, "channelApp" | "channelAccountCredential">,
  accounts: Readonly<Record<string, string>>,
  now: Date,
): Promise<PromoLinkClaimCredentialWarning[]> {
  const warnings: PromoLinkClaimCredentialWarning[] = [];
  for (const [channelAppId, accountId] of Object.entries(accounts)) {
    const binding = await db.channelApp.findFirst({ where: {
      id: channelAppId, status: "active",
      channel: { status: "active", channelAccounts: { some: { id: accountId, status: "active", deletedAt: null } } },
    }, select: { id: true } });
    if (!binding) throw new CatalogBatchInputError("channel_account_binding_invalid");
    const admission = await resolveClaimCredentialAdmission(db, accountId, now);
    if (admission.status === "not_ready") throw new CatalogBatchInputError(admission.code);
    if (admission.expiringSoon && admission.expiresAt) {
      warnings.push({ channelAppId, channelAccountId: accountId, expiresAt: admission.expiresAt.toISOString() });
    }
  }
  return warnings;
}

export type Baseline = {
  schema: 1; final: typeof FINAL; requestId: typeof REQUEST_ID; capturedAt: string;
  actorId: typeof ACTOR; appId: typeof APP; accountId: string;
  allIds: string[]; canaryIds: string[]; remainingIdsSha256: string;
  manualReviewCount: number; manualReviewSha256: string;
};
export type Manifest = Baseline & { baselineSha256: string; plannedAt: string; ids: string[] };
function validateBaseline(b: Baseline) {
  check(b && b.schema === 1 && b.final === FINAL && b.requestId === REQUEST_ID && b.actorId === ACTOR && b.appId === APP, "baseline_identity_invalid");
  check(UUID.test(b.accountId) && Number.isFinite(Date.parse(b.capturedAt)), "baseline_metadata_invalid");
  check(Array.isArray(b.allIds) && b.allIds.length === 53 && b.allIds.every(x => typeof x === "string" && UUID.test(x)) && new Set(b.allIds).size === 53, "scope_53_invalid");
  check(same(b.allIds.map(x => x.slice(0, 8)), PREFIXES), "appendix_b_mismatch");
  check(Array.isArray(b.canaryIds) && b.canaryIds.length === 5 && b.canaryIds.every(x => b.allIds.includes(x)) && same(b.canaryIds.map(x => x.slice(0, 8)), CANARY_PREFIXES), "canary_scope_invalid");
  check(b.canaryIds.includes(RESOLVED_MINE_ID), "resolved_mine_baseline_missing");
  check(b.remainingIdsSha256 === idsSha(b.allIds.filter(x => !b.canaryIds.includes(x))), "phase_a_ids_sha256_mismatch");
  check(b.manualReviewCount === 635 && SHA.test(b.manualReviewSha256), "plotnovel_baseline_invalid");
}
function validateManifest(m: Manifest) {
  validateBaseline(m);
  check(SHA.test(m.baselineSha256) && Number.isFinite(Date.parse(m.plannedAt)), "manifest_metadata_invalid");
  check(Array.isArray(m.ids) && m.ids.length === 48 && new Set(m.ids).size === 48 && same(m.ids, m.allIds.filter(x => !m.canaryIds.includes(x))) && idsSha(m.ids) === m.remainingIdsSha256, "manifest_ids_invalid");
}
export async function readOnly<T>(db: PrismaClient, f: (tx: Prisma.TransactionClient) => Promise<T>) {
  return db.$transaction(async tx => { await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY"); return f(tx); }, { isolationLevel: "RepeatableRead", timeout: 120_000 });
}
async function context(tx: Prisma.TransactionClient, actorId: string) {
  check(actorId === ACTOR, "owner_actor_mismatch");
  const [d] = await tx.$queryRawUnsafe<Array<{ role: string; db: string; ro: string }>>("SELECT current_user::text role,current_database()::text db,current_setting('transaction_read_only') ro");
  check(d.role === "web_app" && d.ro === "on", "web_app_readonly_required");
  check(d.db === "cps_novel" || d.db.startsWith("cps_novel_promo_reclaim_"), "database_refused");
  if (d.db === "cps_novel") {
    check(process.cwd() === "/app", "web_container_required");
    const meta = JSON.parse(readFileSync("/app/.build-metadata.json", "utf8"));
    check(meta.commit === FINAL && meta.version === "0.6.5", "production_identity_mismatch");
  }
  const admin = await tx.adminIdentity.findUnique({ where: { id: actorId }, select: { id: true, username: true, role: true, status: true } });
  check(admin?.username === "admin" && admin.role === "super_admin" && admin.status === "active", "owner_admin_refused");
  return { actor: admin, databaseRole: d.role, transactionReadOnly: d.ro };
}
async function manualSnapshot(tx: Prisma.TransactionClient) {
  // Hash only the original 635 manual-review rows; never return response_shape.
  const [row] = await tx.$queryRawUnsafe<Array<{ count: number; digest: string }>>(`SELECT count(*)::int count,
    encode(sha256(convert_to(COALESCE(string_agg(id::text || '|' || status || '|' || COALESCE(response_shape::text,'null'), E'\\n' ORDER BY id),''),'UTF8')),'hex') digest
    FROM side_effect_intent WHERE channel_app_id='${PLOT_APP}'::uuid AND status='manual_review_required'`);
  return row;
}
async function checkManual(tx: Prisma.TransactionClient, b: Baseline) {
  const x = await manualSnapshot(tx);
  check(x.count === b.manualReviewCount && x.digest === b.manualReviewSha256, "plotnovel_manual_review_changed");
}
async function recentAccount(tx: Prisma.TransactionClient) {
  const rows = await tx.genericTask.findMany({ where: { taskType: "batch.materialize.v1", params: { path: ["operation"], equals: "promo_claim" } }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], select: { params: true } });
  const row = rows.find(r => object(r.params).actorId === ACTOR && typeof object(object(r.params).channelAccounts)[APP] === "string");
  const id = object(object(row?.params).channelAccounts)[APP];
  check(typeof id === "string" && UUID.test(id), "recent_operator_account_missing");
  return id;
}
async function candidateIds(tx: Prisma.TransactionClient) {
  // Appendix C (2026-10-20 proposal), narrowed to the approved MoboReader theater.
  const rows = await tx.$queryRawUnsafe<Array<{ id: string }>>(`WITH f AS (
    SELECT i.payload->>'novelSourceItemId' sid,i.finished_at FROM generic_task_item i
    JOIN generic_task t ON t.id=i.task_id WHERE t.task_type='promo_link.claim.v1'
    AND i.status='failed' AND i.error->>'code'='claim_readback_ambiguous'
    AND i.error->>'message' LIKE '%candidate_set_incomplete%'
    AND i.finished_at > now() - interval '30 days'
  ), latest AS (SELECT DISTINCT ON (sid) * FROM f ORDER BY sid,finished_at DESC)
  SELECT s.id::text FROM latest l JOIN novel_source_item s ON s.id=l.sid::uuid
  WHERE s.channel_app_id='${APP}'::uuid ORDER BY s.id`);
  return rows.map(r => r.id);
}
async function otherInflight(tx: Prisma.TransactionClient, ownTaskId?: string) {
  const rows = await tx.genericTask.findMany({ where: { OR: [
    { taskType: { startsWith: "promo_link.claim." } },
    { taskType: "batch.materialize.v1", params: { path: ["operation"], equals: "promo_claim" } },
  ], ...(ownTaskId ? { AND: [{ id: { not: ownTaskId } }, { OR: [{ parentTaskId: null }, { parentTaskId: { not: ownTaskId } }] }] } : {}),
  }, select: { id: true, status: true, items: { where: { status: { in: ["pending", "processing"] } }, select: { id: true }, take: 1 } } });
  return rows.filter(r => ["pending", "processing"].includes(r.status) || r.items.length > 0).map(r => r.id);
}
// Baseline keeps its original five canaries and SHA; only this execution scope changes.
function canarySubmissionIds(b: Baseline) { return b.canaryIds.filter(id => id !== RESOLVED_MINE_ID); }
function reconciliation(b: Baseline) {
  return { total: b.allIds.length, resolvedByCatalogScan: 1, canary: canarySubmissionIds(b).length,
    remaining: b.allIds.filter(id => !b.canaryIds.includes(id)).length, equation: "53 = 1 + 4 + 48" };
}
async function checkNoCatalogScan(tx: Prisma.TransactionClient) {
  const scans = await tx.genericTask.findMany({ where: { taskType: "catalog_scan", status: { in: ["pending", "processing"] } }, select: { id: true } });
  check(scans.length === 0, "catalog_scan_inflight");
}
async function checkResolvedMine(tx: Prisma.TransactionClient) {
  const mine = await tx.novelSourceItem.findFirst({ where: { id: RESOLVED_MINE_ID, channelAppId: APP }, select: { title: true, sourceLocale: true } });
  const links = await tx.promoLink.findMany({ where: { novelSourceItemId: RESOLVED_MINE_ID, upstreamCodePresent: true }, select: { origin: true, webUrl: true, appUrl: true } });
  const intents = await tx.sideEffectIntent.count({ where: { requestSummary: { path: ["novelSourceItemId"], equals: RESOLVED_MINE_ID } } });
  const active = await tx.genericTaskItem.count({ where: { status: { in: ["pending", "processing"] }, task: { taskType: { startsWith: "promo_link.claim." } },
    OR: [{ targetId: RESOLVED_MINE_ID }, { payload: { path: ["novelSourceItemId"], equals: RESOLVED_MINE_ID } }] } });
  check(mine?.title.trim() === "MINE" && mine.sourceLocale === "en" && links.length === 1 && links[0].origin === "upstream_existing" && intents === 0 && active === 0, "resolved_mine_preconditions_failed");
  return { id: RESOLVED_MINE_ID, status: "resolved_by_catalog_scan", origin: "upstream_existing", promoCodePresent: true,
    promoUrlPresent: !!links[0].webUrl || !!links[0].appUrl, getcodeUpperBoundByIntent: intents, unresolvedIntents: 0, inflightClaimItems: active };
}
async function eligibleIds(tx: Prisma.TransactionClient, ids: string[]) {
  const rows = await tx.novelSourceItem.findMany({ where: { id: { in: ids }, channelAppId: APP, status: "linked", novelId: { not: null },
    promoLinks: { none: { upstreamCodePresent: true } },
  }, select: { id: true } });
  const result: string[] = [];
  for (const r of rows) {
    const intentCount = await tx.sideEffectIntent.count({ where: { requestSummary: { path: ["novelSourceItemId"], equals: r.id } } });
    const active = await tx.genericTaskItem.count({ where: { status: { in: ["pending", "processing"] }, task: { taskType: { startsWith: "promo_link.claim." } }, OR: [{ targetId: r.id }, { payload: { path: ["novelSourceItemId"], equals: r.id } }] } });
    if (intentCount === 0 && active === 0) result.push(r.id);
  }
  return result.sort();
}
export async function captureBaseline(db: PrismaClient, actorId: string, now = new Date()): Promise<Baseline> {
  return readOnly(db, async tx => {
    await context(tx, actorId);
    const allIds = await candidateIds(tx);
    // Owner 2026-10-20 correction: trim title + English locale + appendix prefix,
    // within MoboReader, using only Web-readable columns. The worker
    // validates agencyId/seriesId/language before making any upstream call.
    const mine = await tx.novelSourceItem.findMany({ where: { channelAppId: APP, title: { contains: "MINE" } }, select: { id: true, title: true, sourceLocale: true } });
    const matchedMine = mine.filter(row => row.title.trim() === "MINE" && row.sourceLocale === "en" && row.id.startsWith("c838c281-"));
    check(matchedMine.length === 1 && allIds.includes(matchedMine[0].id), "mine_identity_mismatch");
    const canaryIds = allIds.filter(x => CANARY_PREFIXES.includes(x.slice(0, 8)));
    const manual = await manualSnapshot(tx);
    const b: Baseline = { schema: 1, final: FINAL, requestId: REQUEST_ID, capturedAt: now.toISOString(), actorId: ACTOR, appId: APP,
      accountId: await recentAccount(tx), allIds, canaryIds, remainingIdsSha256: idsSha(allIds.filter(x => !canaryIds.includes(x))), manualReviewCount: manual.count, manualReviewSha256: manual.digest };
    validateBaseline(b);
    check((await otherInflight(tx)).length === 0, "other_claim_inflight");
    check(same(await eligibleIds(tx, allIds), allIds), "phase_a_preconditions_failed");
    return b;
  });
}
export async function plan(db: PrismaClient, b: Baseline, baselineSha256: string, actorId: string, now = new Date()): Promise<Manifest> {
  validateBaseline(b); check(SHA.test(baselineSha256), "baseline_sha256_required");
  return readOnly(db, async tx => {
    await context(tx, actorId); await checkManual(tx, b);
    await checkNoCatalogScan(tx); await checkResolvedMine(tx);
    check(same(await candidateIds(tx), b.allIds), "scope_53_changed");
    check((await otherInflight(tx)).length === 0, "other_claim_inflight");
    const expected = b.allIds.filter(x => !b.canaryIds.includes(x));
    const ids = await eligibleIds(tx, expected);
    check(same(ids, expected), "remaining_48_preconditions_failed");
    return { ...b, baselineSha256, plannedAt: now.toISOString(), ids };
  });
}
export async function submit(db: PrismaClient, m: Manifest, actorId: string, confirm: string, now = new Date()) {
  check(confirm === "PROMO_RECLAIM_48", "confirmation_refused"); validateManifest(m);
  return submitSelection(db, m, m.ids, actorId, REQUEST_ID, now);
}
export async function submitCanary(db: PrismaClient, b: Baseline, ids: readonly string[], actorId: string, confirm: string, now = new Date()) {
  check(confirm === "PROMO_RECLAIM_CANARY_4", "confirmation_refused"); validateBaseline(b);
  check(Array.isArray(ids) && ids.length === 4 && new Set(ids).size === 4 && same(ids, canarySubmissionIds(b)) && same(ids.map(id => id.slice(0, 8)), CANARY_PREFIXES.filter(prefix => prefix !== RESOLVED_MINE_ID.slice(0, 8))), "canary_ids_invalid");
  return submitSelection(db, b, [...ids], actorId, CANARY_REQUEST_ID, now);
}
async function submitSelection(db: PrismaClient, b: Baseline, ids: string[], actorId: string, requestId: typeof REQUEST_ID | typeof CANARY_REQUEST_ID, now: Date) {
  const selection = normalizeCatalogSelection({ scope: "explicit_ids", ids });
  const channelAccounts = { [APP]: b.accountId };
  // Replay retains the original fixed scope even after some books have codes.
  const prior = await readOnly(db, async tx => {
    await context(tx, actorId); await checkManual(tx, b);
    await checkNoCatalogScan(tx); const resolvedByCatalogScan = await checkResolvedMine(tx);
    const token = `catalog_batch:${sha256(`promo_claim\n${actorId}\n${requestId}`)}`;
    const existing = await tx.genericTask.findUnique({ where: { requestToken: token }, select: { id: true } });
    check((await otherInflight(tx, existing?.id)).length === 0, "other_claim_inflight");
    const rows = await tx.novelSourceItem.findMany({ where: { id: { in: ids }, channelAppId: APP }, select: { id: true } });
    check(same(rows.map(r => r.id), ids), "manifest_theater_mismatch");
    if (!existing) check(same(await eligibleIds(tx, ids), ids), "submit_preconditions_failed");
    return { existing, resolvedByCatalogScan };
  });
  const enabled = isPromoLinkClaimEnabled() && isPromoLinkClaimWriteAllowed();
  let credentialWarnings: PromoLinkClaimCredentialWarning[] = [];
  const result = await enqueueCatalogBatch(db, {
    operation: "promo_claim", selection, actorId, requestId, channelAccounts,
  }, now, enabled, async (tx) => {
    await checkNoCatalogScan(tx);
    credentialWarnings = await validatePromoAccountConfiguration(tx, channelAccounts, now);
  });
  if (!result.duplicate && credentialWarnings.length > 0) {
    await db.operationAudit.create({ data: {
      actorType: "admin", actorId,
      action: "promo_link_claim.credential_expiring_soon",
      entityType: "GenericTask", entityId: result.taskId,
      requestId,
      afterSnapshot: { warnings: credentialWarnings },
    } });
  }
  check(!prior.existing || result.taskId === prior.existing.id, "replay_task_mismatch");
  return { ...result, requestId, actorId, channelAccounts, enabled, credentialWarningCount: credentialWarnings.length,
    resolvedByCatalogScan: prior.resolvedByCatalogScan, reconciliation: reconciliation(b), otherInflightCatalogScans: [] };
}
export async function status(db: PrismaClient, m: Baseline | Manifest, actorId: string, requestId: string = REQUEST_ID) {
  check(requestId === REQUEST_ID || requestId === CANARY_REQUEST_ID, "request_id_refused");
  if ("ids" in m) validateManifest(m); else validateBaseline(m);
  const ids = requestId === CANARY_REQUEST_ID ? canarySubmissionIds(m) : m.allIds.filter(id => !m.canaryIds.includes(id));
  return readOnly(db, async tx => {
    const ctx = await context(tx, actorId); await checkManual(tx, m);
    await checkNoCatalogScan(tx); const resolvedByCatalogScan = await checkResolvedMine(tx);
    const token = `catalog_batch:${sha256(`promo_claim\n${actorId}\n${requestId}`)}`;
    const task = await tx.genericTask.findUnique({ where: { requestToken: token }, select: { id: true, status: true } });
    const rows = [];
    for (const id of ids) {
      const items = task ? await tx.genericTaskItem.findMany({ where: { task: { parentTaskId: task.id, taskType: { startsWith: "promo_link.claim." } }, OR: [{ targetId: id }, { payload: { path: ["novelSourceItemId"], equals: id } }] }, select: { status: true, result: true, error: true } }) : [];
      check(items.length <= 1, "duplicate_claim_items");
      const item = items[0]; const decision = object(item?.result).decision;
      const intents = await tx.sideEffectIntent.findMany({ where: { operationType: "promo_link.claim_promo", requestSummary: { path: ["novelSourceItemId"], equals: id } }, select: { id: true, status: true } });
      if (intents.length > 1) throw new OpsError("intent_count_exceeds_one", id);
      const unresolved = intents.filter(x => !["confirmed", "failed"].includes(x.status)).length;
      check(!intents.some(x => x.status === "manual_review_required"), "manual_review_required");
      if (!item || !["pending", "processing"].includes(item.status)) check(unresolved === 0, "unresolved_intent");
      check(decision !== "manual_review_required", "manual_review_required");
      const outcome = !item ? "not_submitted" : item.status === "success" ? decision === "already_available" ? "already_available" : "success" : item.status === "failed" ? "failed" : item.status;
      const code = object(item?.error).code;
      const message = object(item?.error).message;
      const reason = typeof message === "string" ? message.match(/identity_field_missing|identity_mismatch|malformed_payload|candidate_set_incomplete/)?.[0] : undefined;
      const links = await tx.promoLink.findMany({ where: { novelSourceItemId: id }, select: { upstreamCodePresent: true, webUrl: true, appUrl: true } });
      rows.push({ id, status: outcome, promoCodePresent: links.some(x => x.upstreamCodePresent), promoUrlPresent: links.some(x => !!x.webUrl || !!x.appUrl), failureCode: typeof code === "string" && /^[a-z0-9_]+$/.test(code) ? code : null, reason: reason ?? null,
        getcodeUpperBoundByIntent: intents.length, unresolvedIntents: unresolved });
    }
    const counts = rows.reduce<Record<string, number>>((a, r) => { a[r.status] = (a[r.status] ?? 0) + 1; return a; }, { success: 0, already_available: 0, failed: 0 });
    const other = await otherInflight(tx, task?.id);
    check(other.length === 0, "other_claim_inflight");
    return { ...ctx, requestId, accountId: m.accountId, task, counts, rows, otherInflight: other,
      resolvedByCatalogScan, reconciliation: reconciliation(m), otherInflightCatalogScans: [],
      countLabel: "按意图记录推定的每本 getcode 上限", httpCountLabel: "窗口总调用数由宿主机日志单独交叉核对", manualReviewDigestUnchanged: true };
  });
}
export function loadPinned<T>(file: string, digest: string): T {
  check(SHA.test(digest), "sha256_required"); const bytes = readFileSync(file);
  check(sha256(bytes) === digest, "manifest_sha256_mismatch"); return JSON.parse(bytes.toString("utf8")) as T;
}
export async function main(argv: string[]) {
  const [command, ...rest] = argv;
  check(["plan", "submit", "submit-canary", "status"].includes(command), "command_invalid");
  const values: Record<string, string> = {};
  for (let i = 0; i < rest.length; i += 2) {
    const k = rest[i], v = rest[i + 1];
    check(["--actor-id", "--baseline", "--baseline-sha256", "--output", "--manifest", "--manifest-sha256", "--confirm", "--request-id"].includes(k) && !(k in values) && v && !v.startsWith("--"), "arguments_invalid");
    values[k] = v;
  }
  const baselineInput = command === "plan" || command === "submit-canary" || (command === "status" && "--baseline" in values);
  const allowed = command === "plan" ? ["--actor-id", "--baseline", "--baseline-sha256", "--output"] : command === "submit" ? ["--actor-id", "--manifest", "--manifest-sha256", "--confirm"] : command === "submit-canary" ? ["--actor-id", "--baseline", "--baseline-sha256", "--confirm"] : ["--actor-id", ...(baselineInput ? ["--baseline", "--baseline-sha256"] : ["--manifest"]), ...("--request-id" in values ? ["--request-id"] : [])];
  check(same(Object.keys(values), allowed), "arguments_invalid");
  check(values["--actor-id"] === ACTOR, "owner_actor_mismatch");
  if (command === "submit") check(values["--confirm"] === "PROMO_RECLAIM_48", "confirmation_refused");
  if (command === "submit-canary") check(values["--confirm"] === "PROMO_RECLAIM_CANARY_4", "confirmation_refused");
  const requestId = values["--request-id"] ?? REQUEST_ID;
  if (command === "status") check(requestId === REQUEST_ID || requestId === CANARY_REQUEST_ID, "request_id_refused");
  const input = baselineInput ? loadPinned<Baseline>(values["--baseline"], values["--baseline-sha256"]) : command === "submit" ? loadPinned<Manifest>(values["--manifest"], values["--manifest-sha256"]) : JSON.parse(readFileSync(values["--manifest"], "utf8")) as Manifest;
  prisma = new Client();
  try {
    if (command === "plan") {
      const m = await plan(prisma, input as Baseline, values["--baseline-sha256"], values["--actor-id"]);
      const bytes = JSON.stringify(m, null, 2) + "\n";
      writeFileSync(values["--output"], bytes, { mode: 0o600, flag: "wx" });
      console.log(JSON.stringify({ command, actorId: ACTOR, accountId: m.accountId, count: m.ids.length, idsSha256: idsSha(m.ids), manifestSha256: sha256(bytes) }));
    } else if (command === "submit") console.log(JSON.stringify(await submit(prisma, input as Manifest, values["--actor-id"], values["--confirm"])));
    else if (command === "submit-canary") console.log(JSON.stringify(await submitCanary(prisma, input, canarySubmissionIds(input), values["--actor-id"], values["--confirm"])));
    else console.log(JSON.stringify(await status(prisma, input, values["--actor-id"], requestId)));
  } finally { await prisma.$disconnect(); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2)).catch(error => {
  // Never print raw Prisma errors (connection details/SQL) or arbitrary upstream messages.
  const code = error instanceof OpsError || error instanceof CatalogBatchInputError ? error.code : /permission denied/i.test(String(error)) ? "permission_denied_stop" : "unexpected_error_stop";
  console.error(JSON.stringify({ stopped: true, code, ...(error instanceof OpsError && error.sourceItemId ? { sourceItemId: error.sourceItemId } : {}) })); process.exitCode = 64;
});
