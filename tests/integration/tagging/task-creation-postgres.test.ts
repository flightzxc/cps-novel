import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";

import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { LEGACY_TAG_CLASSIFIER_CONFIG_V2, PRODUCTION_TAG_CLASSIFIER_CONFIG } from "@/lib/tagging/classifier-config";
import { CANONICAL_TAG_V1_SHA256, validateKeywordRuleArtifact } from "@/lib/tagging/keyword-artifact";
import { TAGGING_AUTO_CLASSIFY_TASK_TYPE } from "@/lib/tagging/task-contract";
import { buildWorkerAllowlist } from "@/lib/tasks";
import { resolveEffectiveTags } from "@/server/tagging";
import { createTaggingAutoClassifyTask, TAGGING_TASK_ITEM_INSERT_CHUNK_SIZE } from "@/server/tagging/tasks";
import { createTaggingWorkerHandlers } from "../../../worker/handlers/novel-tag-backfill";
import { processOneWorkerCycle } from "../../../worker/runtime";
import {
  compareImplementations,
  createInput,
  seedLocale,
} from "../../../scripts/measure-tagging-task-creation-memory";

// B-21 on a real PostgreSQL 16.14 (run by scripts/run-tagging-public-auto-postgres-verification.sh):
// bounded chunked task creation must leave exactly the task row, item set and
// audit row the pre-fix implementation left, stay idempotent and atomic, work
// with the web_app role's real grants, and the measurement script must run.
// B-23: the last-but-one test pins what reclassify_existing really does to
// stored auto tags, manual tags and upstream-mapped tags when the rule changes.

const enabled = process.env.P2_06_5_DATABASE_TEST === "1";
const url = (name: string) => {
  const value = process.env[name];
  if (enabled && !value) throw new Error(`${name} is required`);
  return value ?? process.env.DATABASE_URL;
};
const owner = new PrismaClient({ datasourceUrl: url("P2_06_5_OWNER_DATABASE_URL") });
const web = new PrismaClient({ datasourceUrl: url("P2_06_5_WEB_DATABASE_URL") });
const worker = new PrismaClient({ datasourceUrl: url("P2_06_5_WORKER_DATABASE_URL") });

const LOCALE_A = "b21t-a";
const LOCALE_B = "b21t-b";
const LOCALE_C = "b21t-c"; // B-23 reclassification semantics
// 3.35 insert chunks and 4 read pages; initialize_missing still keeps more than two chunks.
const SEEDED = 3 * TAGGING_TASK_ITEM_INSERT_CHUNK_SIZE + 350;
const REQUEST_PREFIX = "b21t-";
const env = { ...process.env, FEATURE_P2_06_5_TAGGING: "true", FEATURE_NOVEL_TAG_AUTO: "true", AUTO_WRITE_AUTHORIZED: "YES" };

async function removeMyRows() {
  // Item rows go with their task. operation_audit is append-only (trigger), so
  // its rows stay; every assertion on it uses a request id unique to the test.
  await owner.$executeRawUnsafe(`DELETE FROM generic_task WHERE task_type = '${TAGGING_AUTO_CLASSIFY_TASK_TYPE}' AND request_token LIKE 'tagging:auto_classify:b21%'`);
}

async function removeMyData() {
  await removeMyRows();
  const locales = `'${LOCALE_A}', '${LOCALE_B}', '${LOCALE_C}'`;
  await owner.$executeRawUnsafe(`DELETE FROM novel_canonical_tag WHERE novel_id IN (SELECT id FROM novel WHERE locale IN (${locales}))`);
  await owner.$executeRawUnsafe(`DELETE FROM source_label_mapping WHERE raw_token LIKE 'b21t-%'`);
  await owner.$executeRawUnsafe(`DELETE FROM novel_source_item_label WHERE source_label_id IN (SELECT id FROM source_label WHERE external_label_value LIKE 'b21t-%')`);
  await owner.$executeRawUnsafe(`DELETE FROM source_label WHERE external_label_value LIKE 'b21t-%'`);
  await owner.$executeRawUnsafe(`DELETE FROM canonical_tag WHERE stable_id LIKE 'ct-v1-b21t-%'`);
  await owner.$executeRawUnsafe(`DELETE FROM admin_identity WHERE username LIKE 'b21t-%'`);
  await owner.$executeRawUnsafe(`DELETE FROM novel_tag_state WHERE novel_id IN (SELECT id FROM novel WHERE locale IN (${locales}))`);
  await owner.$executeRawUnsafe(`DELETE FROM tag_classification_run WHERE novel_id IN (SELECT id FROM novel WHERE locale IN (${locales}))`);
  await owner.$executeRawUnsafe(`DELETE FROM novel_source_item WHERE channel_app_id IN (SELECT ca.id FROM channel_app ca JOIN channel c ON c.id = ca.channel_id WHERE c.code = 'b21-measure')`);
  await owner.$executeRawUnsafe(`DELETE FROM novel WHERE locale IN (${locales})`);
  await owner.$executeRawUnsafe(`DELETE FROM channel_app WHERE channel_id IN (SELECT id FROM channel WHERE code = 'b21-measure')`);
  await owner.$executeRawUnsafe(`DELETE FROM channel WHERE code = 'b21-measure'`);
  await owner.$executeRawUnsafe(`DELETE FROM source_app WHERE code = 'b21-measure'`);
}

describe.skipIf(!enabled).sequential("B-21 chunked task creation and B-23 reclassification on PostgreSQL", () => {
  beforeAll(async () => {
    const [{ database_name: databaseName, version }] = await owner.$queryRawUnsafe<Array<{ database_name: string; version: string }>>(
      "SELECT current_database() AS database_name, current_setting('server_version') AS version",
    );
    if (!databaseName.includes("p2_06_5")) throw new Error(`Refusing B-21 tests against ${databaseName}`);
    if (!version.startsWith("16.14")) throw new Error(`PostgreSQL 16.14 required, got ${version}`);
    await removeMyData();
    await seedLocale(owner, { locale: LOCALE_A, count: SEEDED, seed: 21, descMedianChars: 200, manualRatio: 0.05, taggedRatio: 0.3 });
    await seedLocale(owner, { locale: LOCALE_B, count: 40, seed: 22, descMedianChars: 200, manualRatio: 0, taggedRatio: 0 });
  }, 60_000);

  afterAll(async () => {
    await removeMyData();
    await owner.$disconnect();
    await web.$disconnect();
    await worker.$disconnect();
  }, 60_000);

  it.each(["initialize_missing", "reclassify_existing"] as const)(
    "leaves the same task row, item set and audit row as the pre-fix implementation (%s)",
    async (lifecycle) => {
      const { equal, legacy, current } = await compareImplementations(owner, LOCALE_A, lifecycle);
      expect(current.itemCount).toBeGreaterThan(2 * TAGGING_TASK_ITEM_INSERT_CHUNK_SIZE);
      expect(current.itemCount).toBe(legacy.itemCount);
      expect(current.itemsFingerprint).toBe(legacy.itemsFingerprint);
      expect(current.task).toEqual(legacy.task);
      expect(current.audit).toEqual(legacy.audit);
      expect(current.derivationViolations).toBe(0);
      expect(legacy.derivationViolations).toBe(0);
      expect(equal).toBe(true);
      // The lifecycles differ in what they select: tagged novels only qualify for a reclassification.
      if (lifecycle === "initialize_missing") expect(current.itemCount).toBeLessThan(SEEDED);
    },
    60_000,
  );

  it("is idempotent per request id with web_app's real grants, including a concurrent replay", async () => {
    await removeMyRows();
    const requestId = `${REQUEST_PREFIX}idem-${randomUUID()}`;
    const input = () => createInput(web, LOCALE_A, "reclassify_existing", requestId);
    const first = await createTaggingAutoClassifyTask({ ...input(), env });
    expect(first.status).toBe("enqueued");
    if (first.status !== "enqueued") throw new Error("unreachable");
    const itemsAfterFirst = await owner.genericTaskItem.count({ where: { taskId: first.taskId } });
    expect(itemsAfterFirst).toBe(first.eligibleCount);

    expect(await createTaggingAutoClassifyTask({ ...input(), env })).toEqual({ status: "duplicate", taskId: first.taskId, eligibleCount: first.eligibleCount });
    await expect(createTaggingAutoClassifyTask({ ...createInput(web, LOCALE_A, "initialize_missing", requestId), env })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    expect(await owner.genericTaskItem.count({ where: { taskId: first.taskId } })).toBe(itemsAfterFirst);

    await removeMyRows();
    const racedRequest = `${REQUEST_PREFIX}race-${randomUUID()}`;
    const raced = await Promise.all([1, 2].map(() => createTaggingAutoClassifyTask({ ...createInput(web, LOCALE_A, "reclassify_existing", racedRequest), env })));
    expect(raced.map((result) => result.status).sort()).toEqual(["duplicate", "enqueued"]);
    const tasks = await owner.genericTask.findMany({ where: { requestToken: `tagging:auto_classify:${racedRequest}` } });
    expect(tasks).toHaveLength(1);
    expect(await owner.genericTaskItem.count({ where: { taskId: tasks[0]!.id } })).toBe(tasks[0]!.totalCount);
    expect(await owner.operationAudit.count({ where: { requestId: racedRequest } })).toBe(1);
  }, 60_000);

  it("rolls the task, every item chunk and the audit row back when a later chunk fails, and a retry succeeds", async () => {
    await removeMyRows();
    const requestId = `${REQUEST_PREFIX}atomic-${randomUUID()}`;
    let itemStatements = 0;
    const flaky = new Proxy(web, {
      get(target, property, receiver) {
        if (property !== "$transaction") return Reflect.get(target, property, receiver);
        return (fn: (tx: unknown) => Promise<unknown>, options: unknown) => (target.$transaction as (f: unknown, o: unknown) => Promise<unknown>)(
          (tx: Record<string, unknown>) => fn(new Proxy(tx, {
            get(txTarget, txProperty, txReceiver) {
              if (txProperty !== "genericTaskItem") return Reflect.get(txTarget, txProperty, txReceiver);
              const delegate = Reflect.get(txTarget, txProperty, txReceiver) as { createMany: (args: unknown) => unknown };
              return { createMany: (args: unknown) => {
                itemStatements += 1;
                if (itemStatements === 2) throw new Error("injected second-chunk failure");
                return delegate.createMany(args);
              } };
            },
          })),
          options,
        );
      },
    }) as PrismaClient;

    await expect(createTaggingAutoClassifyTask({ ...createInput(flaky, LOCALE_A, "reclassify_existing", requestId), env })).rejects.toThrow("injected second-chunk failure");
    expect(itemStatements).toBe(2);
    expect(await owner.genericTask.count({ where: { requestToken: `tagging:auto_classify:${requestId}` } })).toBe(0);
    expect(await owner.operationAudit.count({ where: { requestId } })).toBe(0);

    const retried = await createTaggingAutoClassifyTask({ ...createInput(web, LOCALE_A, "reclassify_existing", requestId), env });
    expect(retried.status).toBe("enqueued");
    if (retried.status !== "enqueued") throw new Error("unreachable");
    expect(await owner.genericTaskItem.count({ where: { taskId: retried.taskId } })).toBe(retried.eligibleCount);
  }, 60_000);

  it("B-23 reclassify_existing: description-triggered auto tags are replaced, manual and mapped tags are untouched, and no removal fuse trips", async () => {
    await removeMyRows();
    const tagIds = { royal: randomUUID(), soldier: randomUUID(), mapped: randomUUID() };
    await owner.canonicalTag.createMany({ data: [
      { id: tagIds.royal, stableId: "ct-v1-b21t-royal", slug: "b21t-royal", canonicalDefinition: "Royal", aliases: [], sortOrder: 1, taxonomyVersion: "v1" },
      { id: tagIds.soldier, stableId: "ct-v1-b21t-soldier", slug: "b21t-soldier", canonicalDefinition: "Soldier", aliases: [], sortOrder: 2, taxonomyVersion: "v1" },
      { id: tagIds.mapped, stableId: "ct-v1-b21t-mapped", slug: "b21t-mapped", canonicalDefinition: "Mapped", aliases: [], sortOrder: 3, taxonomyVersion: "v1" },
    ] });
    const artifact = validateKeywordRuleArtifact({
      schemaVersion: 1, taxonomyVersion: "v1", taxonomySha256: CANONICAL_TAG_V1_SHA256, keywordLexiconVersion: "b21t-lexicon",
      tags: [
        { canonicalTagId: tagIds.royal, stableId: "ct-v1-b21t-royal", textSelectionPriority: 0, keywords: [{ keywordId: "kw-royal", value: "royal", scriptBuckets: ["latin"], matchMode: "unicode_word", riskFlags: [] }] },
        { canonicalTagId: tagIds.soldier, stableId: "ct-v1-b21t-soldier", textSelectionPriority: 0, keywords: [{ keywordId: "kw-soldier", value: "soldier", scriptBuckets: ["latin"], matchMode: "unicode_word", riskFlags: [] }] },
      ],
    });

    await seedLocale(owner, { locale: LOCALE_C, count: 3, seed: 31, descMedianChars: 100, manualRatio: 0, taggedRatio: 0 });
    const [boilerplateNovel, manualNovel, plainNovel] = await owner.novel.findMany({ where: { locale: LOCALE_C }, orderBy: { id: "asc" } });
    const boilerplate = "This work has been selected by scholars as being culturally important and is part of the knowledge base of civilization as we know it.";
    await owner.novel.update({ where: { id: boilerplateNovel!.id }, data: { title: "Plain Title", description: `${boilerplate} A royal soldier.` } });
    await owner.novel.update({ where: { id: manualNovel!.id }, data: { title: "Plain Title", description: `${boilerplate} A royal soldier.` } });
    await owner.novel.update({ where: { id: plainNovel!.id }, data: { title: "Plain Title", description: "A royal soldier." } });
    const approver = await owner.adminIdentity.create({ data: { username: `b21t-approver-${randomUUID()}`, passwordHash: "scrypt$v1$b21t-not-a-real-hash", role: "admin", status: "active" } });
    // manual novel: manual snapshot with a tag the text would never produce
    await owner.novelTagState.create({ data: { novelId: manualNovel!.id, mode: "manual", revision: 3n } });
    await owner.novelCanonicalTag.create({ data: { novelId: manualNovel!.id, canonicalTagId: tagIds.soldier, source: "manual", evidence: {}, evidenceSchemaVersion: 1, decidedBy: approver.id } });
    // mapped (upstream label) tag on the boilerplate novel and the plain novel
    for (const novelId of [boilerplateNovel!.id, plainNovel!.id]) {
      const sourceItem = await owner.novelSourceItem.findFirstOrThrow({ where: { novelId } });
      const label = await owner.sourceLabel.create({ data: { channelAppId: sourceItem.channelAppId, labelKind: "series_type", externalLabelValue: `b21t-label-${novelId}` } });
      await owner.novelSourceItemLabel.create({ data: { novelSourceItemId: sourceItem.id, sourceLabelId: label.id, active: true } });
      await owner.sourceLabelMapping.create({ data: {
        channelAppId: sourceItem.channelAppId, rawLanguageScope: sourceItem.rawLanguageScope!, rawToken: `b21t-label-${novelId}`,
        canonicalTagId: tagIds.mapped, mappingVersion: "b21t", approvedBy: approver.id,
      } });
    }

    const novelIds = [boilerplateNovel!.id, manualNovel!.id, plainNovel!.id];
    const dependencies = { artifact, enforceCanonicalV1: false };
    const handlersFor = (config?: typeof LEGACY_TAG_CLASSIFIER_CONFIG_V2) => createTaggingWorkerHandlers(worker, { ...dependencies, ...(config ? { config } : {}), env });
    const drain = async (taskId: string, handlers: ReturnType<typeof handlersFor>) => {
      for (let cycle = 0; cycle < 30; cycle += 1) {
        const pending = await owner.genericTaskItem.count({ where: { taskId, status: { in: ["pending", "processing"] } } });
        if (pending === 0) return;
        await processOneWorkerCycle({
          prisma: worker, workerId: "b21t-worker", handlers,
          allowlist: buildWorkerAllowlist(TAGGING_AUTO_CLASSIFY_TASK_TYPE, handlers), signal: new AbortController().signal,
        });
      }
      throw new Error(`task ${taskId} did not drain`);
    };
    const cancelForeignPending = () => owner.$executeRawUnsafe(
      `UPDATE generic_task SET status = 'cancelled' WHERE task_type = '${TAGGING_AUTO_CLASSIFY_TASK_TYPE}' AND status IN ('pending') AND request_token NOT LIKE 'tagging:auto_classify:b21t-%'`,
    );

    // 1. what v0.5.6 did: classify with the previous config -> the description's words became auto tags
    await cancelForeignPending();
    const first = await createTaggingAutoClassifyTask({
      db: web, env, lifecycle: "initialize_missing", mode: "apply", scope: { kind: "novels", novelIds },
      requestId: `${REQUEST_PREFIX}sem-old-${randomUUID()}`, dependencies: { ...dependencies, config: LEGACY_TAG_CLASSIFIER_CONFIG_V2 },
    });
    expect(first).toMatchObject({ status: "enqueued", eligibleCount: 2 }); // the manual novel never qualifies
    if (first.status !== "enqueued") throw new Error("unreachable");
    await drain(first.taskId, handlersFor(LEGACY_TAG_CLASSIFIER_CONFIG_V2));
    const autoTags = async (novelId: string) => (await owner.novelCanonicalTag.findMany({ where: { novelId, source: "auto" }, orderBy: { canonicalTagId: "asc" } })).map((row) => row.canonicalTagId).sort();
    expect(await autoTags(boilerplateNovel!.id)).toEqual([tagIds.royal, tagIds.soldier].sort());
    expect(await autoTags(plainNovel!.id)).toEqual([tagIds.royal, tagIds.soldier].sort());
    const oldRunId = (await owner.novelTagState.findUniqueOrThrow({ where: { novelId: boilerplateNovel!.id } })).currentAutoRunId;
    expect(oldRunId).not.toBeNull();
    const before = {
      mappedBoilerplate: (await resolveEffectiveTags({ db: web, novelId: boilerplateNovel!.id, locale: "en", env })).mapped.map((tag) => tag.stableId),
      mappedPlain: (await resolveEffectiveTags({ db: web, novelId: plainNovel!.id, locale: "en", env })).mapped.map((tag) => tag.stableId),
    };
    expect(before).toEqual({ mappedBoilerplate: ["ct-v1-b21t-mapped"], mappedPlain: ["ct-v1-b21t-mapped"] });

    // 2. the B-23 reclassification (production config)
    await cancelForeignPending();
    const second = await createTaggingAutoClassifyTask({
      db: web, env, lifecycle: "reclassify_existing", mode: "apply", scope: { kind: "novels", novelIds },
      requestId: `${REQUEST_PREFIX}sem-new-${randomUUID()}`, dependencies,
    });
    expect(second).toMatchObject({ status: "enqueued", eligibleCount: 2 });
    if (second.status !== "enqueued") throw new Error("unreachable");
    await drain(second.taskId, handlersFor());
    const items = await owner.genericTaskItem.findMany({ where: { taskId: second.taskId } });
    expect(items.map((item) => item.status)).toEqual(["success", "success"]);

    // (1) the auto tags that only the description produced are gone -- all of them, nothing capped the removal
    expect(await autoTags(boilerplateNovel!.id)).toEqual([]);
    const afterState = await owner.novelTagState.findUniqueOrThrow({ where: { novelId: boilerplateNovel!.id } });
    expect(afterState.currentAutoRunId).not.toBe(oldRunId);
    const newRun = await owner.tagClassificationRun.findUniqueOrThrow({ where: { id: afterState.currentAutoRunId! } });
    expect(newRun).toMatchObject({
      classifierConfigVersion: PRODUCTION_TAG_CLASSIFIER_CONFIG.version,
      classifierConfigFingerprint: PRODUCTION_TAG_CLASSIFIER_CONFIG.fingerprint,
    });
    expect(await owner.tagClassificationRun.count({ where: { novelId: boilerplateNovel!.id } })).toBe(2); // the old run is kept as history
    // an ordinary description is unaffected: same tags (a new run row is still written)
    expect(await autoTags(plainNovel!.id)).toEqual([tagIds.royal, tagIds.soldier].sort());
    expect(await owner.tagClassificationRun.count({ where: { novelId: plainNovel!.id } })).toBe(2);

    // (2) upstream-mapped tags are read live from the label mapping and are untouched; manual tags and manual mode too
    const after = {
      mappedBoilerplate: (await resolveEffectiveTags({ db: web, novelId: boilerplateNovel!.id, locale: "en", env })).effective.map((tag) => tag.stableId),
      mappedPlain: (await resolveEffectiveTags({ db: web, novelId: plainNovel!.id, locale: "en", env })).mapped.map((tag) => tag.stableId),
    };
    expect(after.mappedBoilerplate).toEqual(["ct-v1-b21t-mapped"]); // effective = mapped only, the auto tags are gone
    expect(after.mappedPlain).toEqual(before.mappedPlain);
    expect(await owner.novelCanonicalTag.count({ where: { novelId: manualNovel!.id, source: "manual" } })).toBe(1);
    expect(await owner.novelCanonicalTag.count({ where: { novelId: manualNovel!.id, source: "auto" } })).toBe(0);
    expect(await owner.tagClassificationRun.count({ where: { novelId: manualNovel!.id } })).toBe(0);
    expect(await owner.novelTagState.findUniqueOrThrow({ where: { novelId: manualNovel!.id } })).toMatchObject({ mode: "manual", revision: 3n, currentAutoRunId: null });
    expect(await owner.sourceLabelMapping.count({ where: { rawToken: { startsWith: "b21t-label-" } } })).toBe(2);
  }, 120_000);

  it("the measurement script runs for both implementations and reports a peak RSS", async () => {
    const root = path.resolve(__dirname, "../../..");
    for (const impl of ["current", "legacy"] as const) {
      await removeMyRows();
      const run = spawnSync("npx", [
        "tsx", "scripts/measure-tagging-task-creation-memory.ts", "measure", "--impl", impl,
        "--locale", LOCALE_B, "--lifecycle", "reclassify_existing", "--request-id", `${REQUEST_PREFIX}measure-${impl}-${randomUUID()}`,
      ], { cwd: root, encoding: "utf8", env: { ...process.env, DATABASE_URL: url("P2_06_5_WEB_DATABASE_URL") }, timeout: 90_000 });
      expect(run.status, run.stderr).toBe(0);
      const line = run.stdout.trim().split("\n").filter((row) => row.startsWith("{")).at(-1)!;
      const report = JSON.parse(line) as { impl: string; result: { status: string; eligibleCount: number }; peakRssMiB: number; startRssMiB: number; elapsedMs: number };
      expect(report).toMatchObject({ impl, result: { status: "enqueued", eligibleCount: 40 } });
      expect(report.peakRssMiB).toBeGreaterThan(0);
      expect(report.peakRssMiB).toBeGreaterThanOrEqual(report.startRssMiB);
      expect(Number.isFinite(report.elapsedMs)).toBe(true);
    }
  }, 180_000);
});
