/** Real roles/grants and fixture shape from promo-claim-batch-control-postgres.
 * CLI is run through tsx, including the production runtime module resolution.
 * No business service mocks and no network adapter/getcode are invoked.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { truncateCatalogDatabase } from "../catalog-batch/support";
import { seedBooks } from "./promo-reclaim-fixture-support";
import { hashAdminPassword } from "@/lib/auth/password";

const enabled = process.env.PROMO_RECLAIM_DATABASE_TEST === "1";
const owner = new PrismaClient({ datasourceUrl: process.env.PROMO_RECLAIM_OWNER_DATABASE_URL ?? process.env.DATABASE_URL });
const root = process.cwd();
const script = path.join(root, "scripts/ops/promo-reclaim-53.ts");
const source = readFileSync(script, "utf8");
const prefixes = source.match(/PREFIXES = `([^`]+)`/)![1].split(/\s+/).sort();
const app = "85c2fb3e-28f8-476a-83f2-9647e2206192";
const plotApp = "00de5521-d075-4472-87eb-cc5d1732f4d0";
const actor = "71f0e655-0640-4f07-bcbb-041f027fa7cb";
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
let dir: string, account: string, channel: string, otherChannel: string, ids: string[], m: { ids: string[]; allIds: string[]; accountId: string };
const env = () => ({ ...process.env, DATABASE_URL: process.env.PROMO_RECLAIM_WEB_DATABASE_URL,
  FEATURE_PROMO_LINK_CLAIM: "true", PROMO_LINK_CLAIM_ALLOW_WRITE: "true", PROMO_CLAIM_LIFECYCLE_V1_ENABLED: "true" });
function processResult(args: string[]) {
  const p = spawnSync("npm", ["exec", "--offline", "--yes", "--package=tsx@4.21.0", "--", "tsx", ...args], { cwd: root, env: env(), encoding: "utf8", timeout: 30_000 });
  expect(p.stdout + p.stderr).not.toMatch(/42501|permission_denied_stop/);
  const lines = (p.stdout + "\n" + p.stderr).trim().split("\n").filter(x => x.startsWith("{"));
  return { exit: p.status, data: lines.length ? JSON.parse(lines.at(-1)!) : null };
}
function cli(args: string[]) { return processResult([script, ...args]); }
function inline(code: string) {
  const js = `import {PrismaClient} from '@prisma/client'; import * as ops from ${JSON.stringify(script)};
    const db=new PrismaClient(); (async()=>{try{const value=await (async()=>{${code}})();console.log(JSON.stringify(value));}
    catch(e){console.log(JSON.stringify({code:e.code??'unexpected_test_failure',sqlState:e.meta?.code,databaseError:e.meta?.message}));process.exitCode=64;}finally{await db.$disconnect();}})();`;
  return processResult([`--tsconfig=${path.join(root, "tsconfig.json")}`, "-e", js]);
}
function manifest() { const s = readFileSync(path.join(dir, "manifest.json"), "utf8"); return { file: path.join(dir, "manifest.json"), digest: hash(s) }; }
function submitArgs() { const x = manifest(); return ["submit", "--actor-id", actor, "--manifest", x.file, "--manifest-sha256", x.digest, "--confirm", "PROMO_RECLAIM_48"]; }
async function seed() {
  await truncateCatalogDatabase(owner);
  account = randomUUID(); channel = randomUUID(); otherChannel = randomUUID();
  for (const [id, ch, code] of [[app, channel, "moboreader"], [plotApp, otherChannel, "plotnovel"]]) {
    const sourceApp = await owner.sourceApp.create({ data: { code, name: code } });
    await owner.channel.create({ data: { id: ch, code, name: code } });
    await owner.channelApp.create({ data: { id, channelId: ch, sourceAppId: sourceApp.id, externalAppId: code, projectType: 1 } });
  }
  await owner.adminIdentity.create({ data: { id: actor, username: "admin", role: "super_admin", passwordHash: hashAdminPassword(randomUUID()) } });
  await owner.channelAccount.create({ data: { id: account, channelId: channel, businessId: "ops-fixture", accountName: "ops fixture" } });
  await owner.channelAccountCredential.create({ data: { channelAccountId: account, encryptedSecret: Buffer.from("disposable-fixture"), keyVersion: 1, secretFingerprint: hash("fixture"), fingerprintPrefix: "fixture", status: "active", lastValidatedAt: new Date(), expiresAt: new Date(Date.now() + 3_600_000) } });
  // Reuse the original claim runner's complete source-row fixture, then pin
  // only the operation-specific IDs/title and MINE's production series ID.
  const seeded = await seedBooks(owner, app, prefixes.length, "ops-reclaim");
  ids = [];
  for (let n = 0; n < prefixes.length; n++) {
    const prefix = prefixes[n];
    const id = prefix + seeded[n].slice(8); ids.push(id);
    await owner.novelSourceItem.update({ where: { id: seeded[n] }, data: {
      id, title: prefix === "c838c281" ? "MINE" : prefix,
      ...(prefix === "c838c281" ? { rawPayload: { agencyId: 3366, seriesId: "131539322", language: 3 } } : {}),
    } });
  }
  const [foreignId] = await seedBooks(owner, plotApp, 1, "ops-contract");
  const foreign = await owner.novelSourceItem.update({ where: { id: foreignId }, data: { title: "Contract" } });
  const shapes = await owner.novelSourceItem.findMany({ where: { id: { in: [...ids, foreign.id] } }, select: { description: true, rawPayload: true } });
  expect(shapes).toHaveLength(54);
  expect(shapes.every(row => {
    const raw = row.rawPayload as Record<string, unknown>;
    return row.description.length > 0 && typeof raw.agencyId === "number" && typeof raw.seriesId === "string" && raw.seriesId.length > 0 && typeof raw.language === "number";
  })).toBe(true);
  await owner.genericTask.create({ data: { taskType: "promo_link.claim.v1", operationScopeHash: hash("failed"), requestToken: "historical-failed", status: "failed", items: { create: [...ids, foreign.id].map(id => ({ targetType: "novel_source_item", targetId: id, status: "failed", payload: { novelSourceItemId: id }, error: { code: "claim_readback_ambiguous", message: "candidate_set_incomplete totalCount=228" }, finishedAt: new Date() })) } } });
  await owner.genericTask.create({ data: { taskType: "batch.materialize.v1", operationScopeHash: hash("recent"), requestToken: "recent-operator-batch", status: "completed", params: { actorId: actor, operation: "promo_claim", channelAccounts: { [app]: account } } } });
  await owner.sideEffectIntent.createMany({ data: Array.from({ length: 635 }, (_, i) => ({ effectKey: hash("plot-effect-" + i), operationType: "promo_link.claim_promo", idempotencyKey: hash("plot-idem-" + i), targetType: "promo_link", targetId: "fixture-" + i, channelAppId: plotApp, status: "manual_review_required", requestSummary: {}, responseShape: { fixture: true } })) });
  const captured = inline(`return ops.captureBaseline(db,${JSON.stringify(actor)});`);
  expect(captured.exit, JSON.stringify(captured.data)).toBe(0); expect(captured.data).not.toBeNull(); expect(captured.data.allIds).toHaveLength(53);
  const baseline = JSON.stringify(captured.data, null, 2) + "\n";
  writeFileSync(path.join(dir, "baseline.json"), baseline);
  const planned = cli(["plan", "--actor-id", actor, "--baseline", path.join(dir, "baseline.json"), "--baseline-sha256", hash(baseline), "--output", path.join(dir, "manifest.json")]);
  expect(planned.exit).toBe(0); expect(planned.data.count).toBe(48);
  m = JSON.parse(readFileSync(path.join(dir, "manifest.json"), "utf8"));
}
async function addCode(id: string) {
  const book = await owner.novelSourceItem.findUniqueOrThrow({ where: { id }, select: { novelId: true } });
  await owner.promoLink.create({ data: { novelId: book.novelId!, novelSourceItemId: id, channelAppId: app, channelAccountId: account,
    offerType: "upstream_existing", idempotencyKey: hash(id), publicRedirectCode: "fixture" + id.slice(0, 8), upstreamCode: "fixture-not-printed", webUrl: "https://example.invalid/fixture", status: "fetched" } });
}

describe.runIf(enabled)("promo reclaim real web_app CLI", () => {
  beforeAll(async () => {
    const [d] = await owner.$queryRawUnsafe<Array<{ db: string; version: string }>>("SELECT current_database() db,current_setting('server_version') version");
    if (!d.db.startsWith("cps_novel_promo_reclaim_") || !d.version.startsWith("16.14")) throw new Error("disposable_database_required");
    dir = mkdtempSync(path.join(tmpdir(), "promo-reclaim-test-"));
  });
  beforeEach(async () => { if (dir) { rmSync(dir, { recursive: true, force: true }); dir = mkdtempSync(path.join(tmpdir(), "promo-reclaim-test-")); } await seed(); }, 60_000);
  afterAll(async () => { await owner.$disconnect(); if (dir) rmSync(dir, { recursive: true, force: true }); });

  it("plan excludes foreign theater and five canaries; submit replay preserves the batch; status is read-only", async () => {
    expect(m.allIds).toHaveLength(53); expect(m.ids).toHaveLength(48); expect(m.ids.some(x => x.startsWith("c838c281"))).toBe(false);
    const first = cli(submitArgs()); expect(first.exit).toBe(0); expect(first.data.duplicate).toBe(false); expect(first.data.enabled).toBe(true);
    const again = cli(submitArgs()); expect(again.exit).toBe(0); expect(again.data.duplicate).toBe(true); expect(again.data.taskId).toBe(first.data.taskId);
    expect(await owner.genericTask.count({ where: { params: { path: ["requestId"], equals: "promo-reclaim-53-2026-10-20" } } })).toBe(1);
    expect(await owner.operationAudit.count({ where: { action: "promo_link_claim.credential_expiring_soon" } })).toBe(1);
    const before = await owner.operationAudit.count();
    const result = cli(["status", "--actor-id", actor, "--manifest", manifest().file]);
    expect(result.exit).toBe(0); expect(result.data.databaseRole).toBe("web_app"); expect(result.data.transactionReadOnly).toBe("on");
    expect(result.data.rows).toHaveLength(48); expect(result.data.rows.every((x: { getcodeUpperBoundByIntent: number }) => x.getcodeUpperBoundByIntent === 0)).toBe(true);
    expect(await owner.operationAudit.count()).toBe(before);
    // Root tasks have parentTaskId=null. Replay/status must still detect them.
    await owner.genericTask.create({ data: { taskType: "promo_link.claim.v1", operationScopeHash: hash("foreign-root"), requestToken: "foreign-root-inflight" } });
    expect(cli(submitArgs()).data.code).toBe("other_claim_inflight");
    expect(cli(["status", "--actor-id", actor, "--manifest", manifest().file]).data.code).toBe("other_claim_inflight");
  });
  it("uses genuine read-only web_app transactions and rejects another role", () => {
    const ro = inline("return ops.readOnly(db,async tx=>{await tx.$executeRawUnsafe(\"CREATE TABLE forbidden_ops_write (id int)\");return true;});");
    expect(ro.exit).toBe(64);
    const alternate = `import {PrismaClient} from '@prisma/client';import * as ops from ${JSON.stringify(script)};const db=new PrismaClient({datasourceUrl:process.env.PROMO_RECLAIM_OWNER_DATABASE_URL});(async()=>{try{await ops.captureBaseline(db,${JSON.stringify(actor)});}catch(e){console.log(JSON.stringify({code:e.code}));process.exitCode=64;}finally{await db.$disconnect();}})();`;
    const result = processResult([`--tsconfig=${path.join(root, "tsconfig.json")}`, "-e", alternate]);
    expect(result.exit).toBe(64); expect(result.data.code).toBe("web_app_readonly_required");
  });
  it("locates MINE only by theater, exact title and appendix prefix; raw payload is Web-inaccessible", async () => {
    const mineId = ids.find(id => id.startsWith("c838c281-"))!;
    const privilege = inline("const rows=await db.$queryRawUnsafe(\"SELECT has_column_privilege(current_user,'novel_source_item','raw_payload','SELECT') AS allowed\");return {allowed:rows[0].allowed};");
    expect(privilege.exit).toBe(0); expect(privilege.data.allowed).toBe(false);
    expect(source).not.toMatch(/raw_payload|rawPayload/);
    await owner.novelSourceItem.update({ where: { id: mineId }, data: { title: "MINE " } });
    const mismatch = inline(`return ops.captureBaseline(db,${JSON.stringify(actor)});`);
    expect(mismatch.exit).toBe(64); expect(mismatch.data.code).toBe("mine_identity_mismatch");
    await owner.novelSourceItem.update({ where: { id: mineId }, data: { title: "MINE", rawPayload: {} } });
    const withoutIdentity = inline(`return ops.captureBaseline(db,${JSON.stringify(actor)});`);
    expect(withoutIdentity.exit).toBe(0); // Identity validation belongs to the worker.
  });
  it("existing code is excluded and causes the exact 48 plan to fail closed", async () => {
    await addCode(m.ids[0]);
    const x = inline(`return ops.plan(db,JSON.parse(require('fs').readFileSync(${JSON.stringify(path.join(dir, "baseline.json"))},'utf8')),${JSON.stringify(hash(readFileSync(path.join(dir, "baseline.json"), "utf8")))},${JSON.stringify(actor)});`);
    expect(x.exit).toBe(64); expect(x.data.code).toBe("remaining_48_preconditions_failed");
    expect(cli(submitArgs()).data.code).toBe("submit_preconditions_failed");
  });
  it.each(["theater_disabled", "channel_disabled", "account_unbound", "account_disabled", "credential_never_validated"])("uses the button error for %s without creating a batch", async kind => {
    if (kind === "theater_disabled") await owner.channelApp.update({ where: { id: app }, data: { status: "inactive" } });
    if (kind === "channel_disabled") await owner.channel.update({ where: { id: channel }, data: { status: "inactive" } });
    if (kind === "account_unbound") await owner.channelAccount.update({ where: { id: account }, data: { channelId: otherChannel } });
    if (kind === "account_disabled") await owner.channelAccount.update({ where: { id: account }, data: { status: "disabled" } });
    if (kind === "credential_never_validated") await owner.channelAccountCredential.updateMany({ where: { channelAccountId: account }, data: { lastValidatedAt: null } });
    const x = cli(submitArgs()); expect(x.exit).toBe(64); expect(x.data.code).toBe(kind === "credential_never_validated" ? "credential_never_validated" : "channel_account_binding_invalid");
    expect(await owner.genericTask.count({ where: { params: { path: ["requestId"], equals: "promo-reclaim-53-2026-10-20" } } })).toBe(0);
  });
  it("rejects wrong manifest hash, phrase and actor before connecting", () => {
    const a = submitArgs(); a[a.indexOf("--manifest-sha256") + 1] = "0".repeat(64); expect(cli(a).data.code).toBe("manifest_sha256_mismatch");
    const b = submitArgs(); b[b.indexOf("--confirm") + 1] = "wrong"; expect(cli(b).data.code).toBe("confirmation_refused");
    const c = submitArgs(); c[c.indexOf("--actor-id") + 1] = randomUUID(); expect(cli(c).data.code).toBe("owner_actor_mismatch");
  });
  it("rejects a scope row moved to another theater", async () => {
    await owner.novelSourceItem.update({ where: { id: m.ids[0] }, data: { channelAppId: plotApp } });
    expect(cli(submitArgs()).data.code).toBe("manifest_theater_mismatch");
  });
  it("rejects historical intents and other in-flight claims", async () => {
    await owner.sideEffectIntent.create({ data: { effectKey: hash("one-intent"), idempotencyKey: hash("one-intent-idem"), operationType: "promo_link.claim_promo", targetType: "promo_link", targetId: "fixture", channelAppId: app, status: "confirmed", requestSummary: { novelSourceItemId: m.ids[0] } } });
    expect(cli(submitArgs()).data.code).toBe("submit_preconditions_failed");
    await owner.genericTask.create({ data: { taskType: "promo_link.claim.v1", operationScopeHash: hash("other"), requestToken: "other-inflight" } });
    expect(cli(submitArgs()).data.code).toBe("other_claim_inflight");
  });
  it("reports terminal classifications, boolean readiness and the intent upper bound", async () => {
    const submitted = cli(submitArgs()); expect(submitted.exit).toBe(0);
    await owner.genericTask.update({ where: { id: submitted.data.taskId }, data: { status: "completed" } });
    await owner.genericTaskItem.updateMany({ where: { taskId: submitted.data.taskId }, data: { status: "success" } });
    await owner.genericTask.create({ data: { parentTaskId: submitted.data.taskId, taskType: "promo_link.claim.v1", operationScopeHash: hash("terminal"), requestToken: "terminal-shard", status: "completed", items: { create: m.ids.map((id, i) => ({ targetType: "novel_source_item", targetId: id, payload: { novelSourceItemId: id }, status: i === 2 ? "failed" : "success", result: i === 2 ? undefined : { decision: i === 0 ? "already_available" : "claimed" }, error: i === 2 ? { code: "claim_readback_ambiguous", message: "identity_mismatch" } : undefined })) } } });
    await addCode(m.ids[0]);
    await owner.sideEffectIntent.create({ data: { effectKey: hash("claimed"), idempotencyKey: hash("claimed-idem"), operationType: "promo_link.claim_promo", targetType: "promo_link", targetId: "fixture", channelAppId: app, status: "confirmed", requestSummary: { novelSourceItemId: m.ids[1] } } });
    const x = cli(["status", "--actor-id", actor, "--manifest", manifest().file]); expect(x.exit).toBe(0);
    expect(x.data.counts).toEqual({ success: 46, already_available: 1, failed: 1 });
    expect(x.data.rows[0].promoCodePresent).toBe(true); expect(x.data.rows[1].getcodeUpperBoundByIntent).toBe(1); expect(x.data.rows[2].reason).toBe("identity_mismatch");
    expect(JSON.stringify(x.data)).not.toContain("fixture-not-printed");
    // A replay must not shrink the manifest after progress.
    const replay = cli(submitArgs()); expect(replay.exit).toBe(0); expect(replay.data.duplicate).toBe(true);
  });
  it("stops on >1 intent and on manual review; preserves the 635-row baseline", async () => {
    await owner.sideEffectIntent.createMany({ data: [1, 2].map(i => ({ effectKey: hash("dup" + i), idempotencyKey: hash("dup-idem" + i), operationType: "promo_link.claim_promo", targetType: "promo_link", targetId: "dup-" + i, channelAppId: app, status: "confirmed", requestSummary: { novelSourceItemId: m.ids[0] } })) });
    expect(cli(["status", "--actor-id", actor, "--manifest", manifest().file]).data.code).toBe("intent_count_exceeds_one");
    await owner.sideEffectIntent.deleteMany({ where: { channelAppId: app } });
    await owner.sideEffectIntent.create({ data: { effectKey: hash("orphan"), idempotencyKey: hash("orphan-idem"), operationType: "promo_link.claim_promo", targetType: "promo_link", targetId: "orphan", channelAppId: app, status: "prepared", requestSummary: { novelSourceItemId: m.ids[0] } } });
    expect(cli(["status", "--actor-id", actor, "--manifest", manifest().file]).data.code).toBe("unresolved_intent");
    await owner.sideEffectIntent.deleteMany({ where: { channelAppId: app } });
    await owner.sideEffectIntent.create({ data: { effectKey: hash("manual"), idempotencyKey: hash("manual-idem"), operationType: "promo_link.claim_promo", targetType: "promo_link", targetId: "manual", channelAppId: app, status: "manual_review_required", requestSummary: { novelSourceItemId: m.ids[0] } } });
    expect(cli(["status", "--actor-id", actor, "--manifest", manifest().file]).data.code).toBe("manual_review_required");
    await owner.sideEffectIntent.updateMany({ where: { channelAppId: plotApp }, data: { responseShape: { changed: true } } });
    expect(cli(submitArgs()).data.code).toBe("plotnovel_manual_review_changed");
  });
});
