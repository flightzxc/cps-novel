import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { rawLanguageScopeFromPayload } from "@/lib/tagging/raw-language-scope";
import { createFrozenTagClassifierConfig } from "@/lib/tagging/classifier-config";
import { CANONICAL_TAG_V1_SHA256, validateKeywordRuleArtifact } from "@/lib/tagging/keyword-artifact";
import { TAGGING_AUTO_CLASSIFY_TASK_TYPE } from "@/lib/tagging/task-contract";
import { buildWorkerAllowlist, claimPendingItem, finalizeTaskItem } from "@/lib/tasks";
import {
  createTaggingAutoClassifyTask,
  exitManualTagMode,
  replaceAutoTagSnapshot,
  replaceManualTagSnapshot,
  resolveEffectiveTags,
} from "@/server/tagging";
import { createTaggingWorkerHandlers } from "../../../worker/handlers/novel-tag-backfill";
import { processOneWorkerCycle } from "../../../worker/runtime";

const enabled = process.env.P2_06_5_DATABASE_TEST === "1";
const url = (name: string) => {
  const value = process.env[name];
  if (enabled && !value) throw new Error(`${name} is required`);
  return value ?? process.env.DATABASE_URL;
};
const owner = new PrismaClient({ datasourceUrl: url("P2_06_5_OWNER_DATABASE_URL") });
const web = new PrismaClient({ datasourceUrl: url("P2_06_5_WEB_DATABASE_URL") });
const worker = new PrismaClient({ datasourceUrl: url("P2_06_5_WORKER_DATABASE_URL") });
const scheduler = new PrismaClient({ datasourceUrl: url("P2_06_5_SCHEDULER_DATABASE_URL") });

const env: NodeJS.ProcessEnv = { ...process.env, FEATURE_P2_06_5_TAGGING: "true", FEATURE_NOVEL_TAG_AUTO: "true", AUTO_WRITE_AUTHORIZED: "YES" };
const ids = {
  channel: randomUUID(), sourceApp: randomUUID(), channelApp: randomUUID(), admin: randomUUID(),
  novel: randomUUID(), sourceItem: randomUUID(), tagA: randomUUID(), tagB: randomUUID(), tagC: randomUUID(),
  labelExact: randomUUID(), labelCase: randomUUID(), mappingExact: randomUUID(), mappingSecond: randomUUID(),
};
const rawPayload = { language: 2, languageName: " English ", seriesName: "Tagged Novel" };
const rawScope = rawLanguageScopeFromPayload(rawPayload)!;
const hash = "a".repeat(64);
const classifierConfig = createFrozenTagClassifierConfig({
  version: "fixture-v1", titleWeight: 30, descriptionWeight: 20, threshold: 20, maxTextTags: 3,
});

function keywordArtifact(canonicalTagId = ids.tagA) {
  return validateKeywordRuleArtifact({
    schemaVersion: 1,
    taxonomyVersion: "v1",
    taxonomySha256: CANONICAL_TAG_V1_SHA256,
    keywordLexiconVersion: "fixture-lexicon-v1",
    tags: [{
      canonicalTagId,
      stableId: "ct-v1-alpha",
      textSelectionPriority: 0,
      keywords: [{ keywordId: "kw-alpha", value: "Tagged", scriptBuckets: ["latin"], matchMode: "unicode_word", riskFlags: [] }],
    }],
  });
}

function autoMetadata() {
  return {
    method: "deterministic_text" as const,
    taxonomyVersion: "canonical-tag-v1",
    taxonomySha256: hash,
    keywordLexiconVersion: "fixture-v1",
    keywordFingerprint: hash,
    classifierConfigVersion: "fixture-v1",
    classifierConfigFingerprint: hash,
    resultSummary: { selected: 1 },
  };
}

describe.skipIf(!enabled).sequential("P2-06.5 isolated PostgreSQL foundation", () => {
  beforeAll(async () => {
    const [{ database_name: databaseName, version }] = await owner.$queryRawUnsafe<Array<{ database_name: string; version: string }>>(
      "SELECT current_database() AS database_name, current_setting('server_version') AS version",
    );
    if (!databaseName.includes("p2_06_5")) throw new Error(`Refusing P2-06.5 tests against ${databaseName}`);
    if (!version.startsWith("16.14")) throw new Error(`PostgreSQL 16.14 required, got ${version}`);
    await owner.$executeRawUnsafe("TRUNCATE channel, source_app, admin_identity, novel, canonical_tag CASCADE");

    await owner.adminIdentity.create({ data: {
      id: ids.admin,
      username: `p2-06-5-${ids.admin}`,
      passwordHash: "scrypt$v1$test-only",
      role: "super_admin",
      status: "active",
    } });
    await owner.channel.create({ data: { id: ids.channel, code: `p2065-${ids.channel}`, name: "P2-06.5" } });
    await owner.sourceApp.create({ data: { id: ids.sourceApp, code: `p2065-${ids.sourceApp}`, name: "MoboReader" } });
    await owner.channelApp.create({ data: {
      id: ids.channelApp, channelId: ids.channel, sourceAppId: ids.sourceApp,
      externalAppId: `p2065-${ids.channelApp}`, projectType: 2, status: "active",
    } });
    await owner.novel.create({ data: {
      id: ids.novel, businessId: `p2065-${ids.novel}`, locale: "zh", title: "Tagged Novel",
      description: "description", slug: `p2065-${ids.novel}`, status: "draft",
    } });
    await owner.canonicalTag.createMany({ data: [
      { id: ids.tagA, stableId: "ct-v1-alpha", slug: "alpha", canonicalDefinition: "Alpha", aliases: [], sortOrder: 20, taxonomyVersion: "v1" },
      { id: ids.tagB, stableId: "ct-v1-beta", slug: "beta", canonicalDefinition: "Beta", aliases: [], sortOrder: 10, taxonomyVersion: "v1" },
      { id: ids.tagC, stableId: "ct-v1-gamma", slug: "gamma", canonicalDefinition: "Gamma", aliases: [], sortOrder: 30, taxonomyVersion: "v1" },
    ] });
    await owner.canonicalTagTranslation.createMany({ data: [
      { canonicalTagId: ids.tagA, locale: "zh", displayName: "甲" },
      { canonicalTagId: ids.tagB, locale: "zh", displayName: "乙" },
    ] });
    await owner.novelSourceItem.create({ data: {
      id: ids.sourceItem, channelAppId: ids.channelApp, novelId: ids.novel,
      externalBookId: `book-${ids.novel}`, sourceLanguageCode: "2", sourceLanguageName: " English ",
      sourceLocale: "zh", rawLanguageScope: rawScope, title: "Tagged Novel", description: "description",
      status: "linked", rawPayload,
    } });
    await owner.sourceLabel.createMany({ data: [
      { id: ids.labelExact, channelAppId: ids.channelApp, labelKind: "series_type", externalLabelValue: " Fantasy " },
      { id: ids.labelCase, channelAppId: ids.channelApp, labelKind: "series_type", externalLabelValue: "fantasy" },
    ] });
    await owner.novelSourceItemLabel.createMany({ data: [
      { novelSourceItemId: ids.sourceItem, sourceLabelId: ids.labelExact, active: true },
      { novelSourceItemId: ids.sourceItem, sourceLabelId: ids.labelCase, active: true },
    ] });
    await owner.sourceLabelMapping.createMany({ data: [
      { id: ids.mappingExact, channelAppId: ids.channelApp, rawLanguageScope: rawScope, rawToken: " Fantasy ", canonicalTagId: ids.tagA, mappingVersion: "b2", approvedBy: ids.admin },
      { id: ids.mappingSecond, channelAppId: ids.channelApp, rawLanguageScope: rawScope, rawToken: " Fantasy ", canonicalTagId: ids.tagB, mappingVersion: "b2", approvedBy: ids.admin },
    ] });
  }, 30_000);

  afterAll(async () => {
    await Promise.all([owner, web, worker, scheduler].map((client) => client.$disconnect()));
  });

  it("enforces C collation exactness and approved 1:N edge identity", async () => {
    const rows = await owner.$queryRawUnsafe<Array<{ collation_name: string }>>(`
      SELECT collation_name FROM information_schema.columns
      WHERE table_schema='public' AND table_name='source_label_mapping' AND column_name IN ('raw_language_scope','raw_token')
      ORDER BY column_name
    `);
    expect(rows).toEqual([{ collation_name: "C" }, { collation_name: "C" }]);
    expect(await owner.sourceLabelMapping.count({ where: { rawToken: " Fantasy " } })).toBe(2);
    await expect(owner.sourceLabelMapping.create({ data: {
      channelAppId: ids.channelApp, rawLanguageScope: rawScope, rawToken: " Fantasy ",
      canonicalTagId: ids.tagA, mappingVersion: "duplicate", approvedBy: ids.admin,
    } })).rejects.toThrow();
    const caseDistinct = await owner.sourceLabelMapping.create({ data: {
      channelAppId: ids.channelApp, rawLanguageScope: rawScope, rawToken: "fantasy",
      canonicalTagId: ids.tagA, mappingVersion: "case-distinct", approvedBy: ids.admin,
    } });
    await owner.sourceLabelMapping.delete({ where: { id: caseDistinct.id } });
  });

  it("resolves mapped+auto union with dedupe, provenance, fallback, and stable order", async () => {
    await replaceAutoTagSnapshot({
      db: worker, novelId: ids.novel, tags: [
        { canonicalTagId: ids.tagA, score: 9, evidence: { field: "title" } },
        { canonicalTagId: ids.tagC, score: 8, evidence: { field: "description" } },
      ],
      runMetadata: autoMetadata(), contentSha: hash, requestId: randomUUID(), env,
    });
    const result = await resolveEffectiveTags({ db: web, novelId: ids.novel, locale: "ja", env });
    expect(result.effective.map((tag) => tag.stableId)).toEqual(["ct-v1-beta", "ct-v1-alpha", "ct-v1-gamma"]);
    expect(result.effective.find((tag) => tag.stableId === "ct-v1-alpha")?.provenance).toEqual(["mapped", "auto"]);
    expect(result.effective.find((tag) => tag.stableId === "ct-v1-alpha")?.displayName).toBe("甲");
    expect(result.effective.find((tag) => tag.stableId === "ct-v1-gamma")?.displayName).toBe("gamma");
    expect(await owner.novelCanonicalTag.count({ where: { novelId: ids.novel, source: "mapped" } })).toBe(0);
    const autoHidden = await resolveEffectiveTags({
      db: web,
      novelId: ids.novel,
      locale: "zh",
      env: { ...env, FEATURE_NOVEL_TAG_AUTO: "false" },
    });
    expect(autoHidden.effective.map((tag) => tag.stableId)).toEqual(["ct-v1-beta", "ct-v1-alpha"]);
  });

  it("supports concurrent idempotent manual empty takeover and exact replay", async () => {
    const requestId = randomUUID();
    const operation = () => replaceManualTagSnapshot({
      db: web, novelId: ids.novel, canonicalTagIds: [], expectedRevision: 0n,
      requestId, actor: { id: ids.admin, type: "admin" },
    });
    const results = await Promise.all([operation(), operation()]);
    expect(results.map((result) => result.replayed).sort()).toEqual([false, true]);
    const resolved = await resolveEffectiveTags({ db: web, novelId: ids.novel, locale: "zh", env });
    expect(resolved.mode).toBe("manual");
    expect(resolved.effective).toEqual([]);
    expect(await owner.novelCanonicalTag.count({ where: { novelId: ids.novel, source: "auto" } })).toBe(2);
    await expect(replaceManualTagSnapshot({
      db: web, novelId: ids.novel, canonicalTagIds: [ids.tagA], expectedRevision: 1n,
      requestId, actor: { id: ids.admin, type: "admin" },
    })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    await expect(exitManualTagMode({
      db: web, novelId: ids.novel, expectedRevision: 1n, requestId,
      actor: { id: ids.admin, type: "admin" },
    })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  });

  it("exits manual without classification and reveals retained mapped/auto", async () => {
    await expect(exitManualTagMode({
      db: web, novelId: ids.novel, expectedRevision: 0n, requestId: randomUUID(),
      actor: { id: ids.admin, type: "admin" },
    })).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
    const result = await exitManualTagMode({
      db: web, novelId: ids.novel, expectedRevision: 1n, requestId: randomUUID(),
      actor: { id: ids.admin, type: "admin" },
    });
    expect(result).toMatchObject({ mode: "automatic", revision: 2n, skipped: false });
    expect((await resolveEffectiveTags({ db: web, novelId: ids.novel, locale: "zh", env })).effective).toHaveLength(3);
  });

  it("records an empty auto snapshot and never overwrites manual mode", async () => {
    const requestId = randomUUID();
    const empty = await replaceAutoTagSnapshot({
      db: worker, novelId: ids.novel, tags: [], runMetadata: autoMetadata(),
      contentSha: "b".repeat(64), requestId, env,
    });
    expect(empty.currentAutoRunId).not.toBeNull();
    expect(await owner.tagClassificationRun.count({ where: { id: empty.currentAutoRunId! } })).toBe(1);
    expect(await owner.novelCanonicalTag.count({ where: { novelId: ids.novel, source: "auto" } })).toBe(0);
    expect(await replaceAutoTagSnapshot({
      db: worker, novelId: ids.novel, tags: [], runMetadata: autoMetadata(),
      contentSha: "b".repeat(64), requestId, env,
    })).toMatchObject({ replayed: true, currentAutoRunId: empty.currentAutoRunId });
    await expect(replaceAutoTagSnapshot({
      db: worker, novelId: ids.novel,
      tags: [{ canonicalTagId: ids.tagC, score: 1, evidence: {} }],
      runMetadata: autoMetadata(), contentSha: "b".repeat(64), requestId, env,
    })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });

    const [, racedAuto] = await Promise.all([replaceManualTagSnapshot({
      db: web, novelId: ids.novel, canonicalTagIds: [ids.tagB], expectedRevision: 2n,
      requestId: randomUUID(), actor: { id: ids.admin, type: "admin" },
    }), replaceAutoTagSnapshot({
      db: worker, novelId: ids.novel, tags: [{ canonicalTagId: ids.tagC, score: 1, evidence: {} }],
      runMetadata: autoMetadata(), contentSha: "c".repeat(64), requestId: randomUUID(), env,
    })]);
    expect(racedAuto.mode === "manual" ? racedAuto.skipped : racedAuto.mode === "automatic").toBe(true);
    expect((await resolveEffectiveTags({ db: web, novelId: ids.novel, locale: "zh", env })).effective.map((tag) => tag.stableId)).toEqual(["ct-v1-beta"]);
  });

  it("fails closed on flags, inactive objects, missing scope, and multiple source entities", async () => {
    await expect(replaceAutoTagSnapshot({
      db: worker, novelId: ids.novel, tags: [], runMetadata: autoMetadata(), contentSha: hash,
      requestId: randomUUID(), env: { ...process.env, FEATURE_P2_06_5_TAGGING: "true", FEATURE_NOVEL_TAG_AUTO: "true", AUTO_WRITE_AUTHORIZED: "NO" },
    })).rejects.toMatchObject({ code: "AUTO_WRITE_NOT_AUTHORIZED" });
    await expect(resolveEffectiveTags({ db: web, novelId: ids.novel, locale: "zh", env: {} as NodeJS.ProcessEnv })).rejects.toMatchObject({ code: "TAGGING_DISABLED" });

    await exitManualTagMode({ db: web, novelId: ids.novel, expectedRevision: 3n, requestId: randomUUID(), actor: { id: ids.admin, type: "admin" } });
    await owner.sourceLabelMapping.update({ where: { id: ids.mappingExact }, data: { active: false } });
    await owner.canonicalTag.update({ where: { id: ids.tagB }, data: { status: "inactive" } });
    expect((await resolveEffectiveTags({ db: web, novelId: ids.novel, locale: "zh", env })).mapped).toEqual([]);

    await owner.novelSourceItem.update({ where: { id: ids.sourceItem }, data: { rawLanguageScope: null } });
    await expect(resolveEffectiveTags({ db: web, novelId: ids.novel, locale: "zh", env })).rejects.toMatchObject({ code: "DATA_INVARIANT_VIOLATION" });
    await owner.novelSourceItem.update({ where: { id: ids.sourceItem }, data: { rawLanguageScope: rawScope } });
    await owner.novelSourceItem.create({ data: {
      channelAppId: ids.channelApp, novelId: ids.novel, externalBookId: `second-${ids.novel}`,
      sourceLanguageCode: "2", sourceLanguageName: " English ", sourceLocale: "zh",
      rawLanguageScope: rawScope, title: "Second", description: "", status: "linked", rawPayload,
    } });
    await expect(resolveEffectiveTags({ db: web, novelId: ids.novel, locale: "zh", env })).rejects.toMatchObject({ code: "DATA_INVARIANT_VIOLATION" });
  });

  it("enforces source-shape checks, rollback, and Scheduler exclusion", async () => {
    await expect(owner.$transaction(async (tx) => {
      await tx.novelCanonicalTag.create({ data: {
        novelId: ids.novel, canonicalTagId: ids.tagA, source: "mapped",
        evidence: {}, evidenceSchemaVersion: 1,
      } });
    })).rejects.toThrow();
    expect(await owner.novelCanonicalTag.count({ where: { source: "mapped" } })).toBe(0);
    await expect(scheduler.$queryRawUnsafe("SELECT id FROM canonical_tag LIMIT 1")).rejects.toThrow();
    expect(await worker.$queryRawUnsafe("SELECT id FROM canonical_tag LIMIT 1")).toHaveLength(1);
  });

  it("runs scoped dry-run/apply tasks idempotently and fails closed on stale/manual/gate states", async () => {
    const novelId = randomUUID();
    await owner.novel.create({ data: {
      id: novelId, businessId: `task-${novelId}`, locale: "zh", title: "Tagged lifecycle",
      description: "description", slug: `task-${novelId}`, status: "draft",
    } });
    const dependencies = { config: classifierConfig, artifact: keywordArtifact(), enforceCanonicalV1: false };
    const dryEnv = { ...process.env, FEATURE_P2_06_5_TAGGING: "true", FEATURE_NOVEL_TAG_AUTO: "false", AUTO_WRITE_AUTHORIZED: "NO" };
    const applyEnv = { ...dryEnv, FEATURE_NOVEL_TAG_AUTO: "true", AUTO_WRITE_AUTHORIZED: "YES" };
    const dry = await createTaggingAutoClassifyTask({
      db: web, lifecycle: "initialize_missing", scope: { kind: "novel", novelId }, requestId: randomUUID(),
      env: dryEnv, dependencies,
    });
    expect(dry.status).toBe("enqueued");
    const dryHandlers = createTaggingWorkerHandlers(worker, { ...dependencies, env: dryEnv });
    expect(await processOneWorkerCycle({
      prisma: worker, workerId: "tag-dry-worker", handlers: dryHandlers,
      allowlist: buildWorkerAllowlist(TAGGING_AUTO_CLASSIFY_TASK_TYPE, dryHandlers),
      signal: new AbortController().signal,
    })).toBe(true);
    expect(await owner.genericTaskItem.findFirstOrThrow({ where: { taskId: "taskId" in dry ? dry.taskId : "" } })).toMatchObject({ status: "success", result: expect.objectContaining({ code: "dry_run" }) });
    expect(await owner.tagClassificationRun.count({ where: { novelId } })).toBe(0);
    expect(await owner.novelTagState.count({ where: { novelId } })).toBe(0);

    const taskCountBeforeRejectedApply = await owner.genericTask.count();
    await expect(createTaggingAutoClassifyTask({
      db: web, lifecycle: "reclassify_existing", mode: "apply", scope: { kind: "novel", novelId },
      requestId: randomUUID(), env: { ...applyEnv, AUTO_WRITE_AUTHORIZED: "NO" }, dependencies,
    })).rejects.toMatchObject({ code: "AUTO_WRITE_NOT_AUTHORIZED" });
    expect(await owner.genericTask.count()).toBe(taskCountBeforeRejectedApply);

    const gateChanged = await createTaggingAutoClassifyTask({
      db: web, lifecycle: "reclassify_existing", mode: "apply", scope: { kind: "novel", novelId },
      requestId: randomUUID(), env: applyEnv, dependencies,
    });
    const deniedHandlers = createTaggingWorkerHandlers(worker, {
      ...dependencies, env: { ...applyEnv, AUTO_WRITE_AUTHORIZED: "NO" },
    });
    await processOneWorkerCycle({
      prisma: worker, workerId: "tag-denied-worker", handlers: deniedHandlers,
      allowlist: buildWorkerAllowlist(TAGGING_AUTO_CLASSIFY_TASK_TYPE, deniedHandlers),
      signal: new AbortController().signal,
    });
    expect(await owner.genericTaskItem.findFirstOrThrow({ where: { taskId: "taskId" in gateChanged ? gateChanged.taskId : "" } })).toMatchObject({
      status: "failed", error: expect.objectContaining({ code: "auto_write_not_authorized" }),
    });
    expect(await owner.tagClassificationRun.count({ where: { novelId } })).toBe(0);

    const applyRequest = randomUUID();
    const appliedTask = await createTaggingAutoClassifyTask({
      db: web, lifecycle: "reclassify_existing", mode: "apply", scope: { kind: "novel", novelId },
      requestId: applyRequest, env: applyEnv, dependencies,
    });
    const applyHandlers = createTaggingWorkerHandlers(worker, { ...dependencies, env: applyEnv });
    await processOneWorkerCycle({
      prisma: worker, workerId: "tag-apply-worker", handlers: applyHandlers,
      allowlist: buildWorkerAllowlist(TAGGING_AUTO_CLASSIFY_TASK_TYPE, applyHandlers),
      signal: new AbortController().signal,
    });
    expect(await owner.tagClassificationRun.count({ where: { novelId } })).toBe(1);
    expect(await owner.novelCanonicalTag.findMany({ where: { novelId, source: "auto" } })).toHaveLength(1);
    const replay = await createTaggingAutoClassifyTask({
      db: web, lifecycle: "reclassify_existing", mode: "apply", scope: { kind: "novel", novelId },
      requestId: applyRequest, env: applyEnv, dependencies,
    });
    expect(replay).toMatchObject({ status: "duplicate", taskId: "taskId" in appliedTask ? appliedTask.taskId : undefined });
    await expect(createTaggingAutoClassifyTask({
      db: web, lifecycle: "initialize_missing", mode: "apply", scope: { kind: "novel", novelId },
      requestId: applyRequest, env: applyEnv, dependencies,
    })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });

    const stale = await createTaggingAutoClassifyTask({
      db: web, lifecycle: "reclassify_existing", mode: "apply", scope: { kind: "novel", novelId },
      requestId: randomUUID(), env: applyEnv, dependencies,
    });
    await owner.novel.update({ where: { id: novelId }, data: { title: "Changed after enqueue" } });
    await processOneWorkerCycle({
      prisma: worker, workerId: "tag-stale-worker", handlers: applyHandlers,
      allowlist: buildWorkerAllowlist(TAGGING_AUTO_CLASSIFY_TASK_TYPE, applyHandlers),
      signal: new AbortController().signal,
    });
    expect(await owner.genericTaskItem.findFirstOrThrow({ where: { taskId: "taskId" in stale ? stale.taskId : "" } })).toMatchObject({ status: "skipped", result: expect.objectContaining({ code: "content_changed" }) });
    expect(await owner.tagClassificationRun.count({ where: { novelId } })).toBe(1);

    await owner.novel.update({ where: { id: novelId }, data: { title: "Tagged lifecycle" } });
    const manualRace = await createTaggingAutoClassifyTask({
      db: web, lifecycle: "reclassify_existing", mode: "apply", scope: { kind: "novel", novelId },
      requestId: randomUUID(), env: applyEnv, dependencies,
    });
    await replaceManualTagSnapshot({
      db: web, novelId, canonicalTagIds: [], expectedRevision: 0n, requestId: randomUUID(),
      actor: { id: ids.admin, type: "admin" },
    });
    await processOneWorkerCycle({
      prisma: worker, workerId: "tag-manual-worker", handlers: applyHandlers,
      allowlist: buildWorkerAllowlist(TAGGING_AUTO_CLASSIFY_TASK_TYPE, applyHandlers),
      signal: new AbortController().signal,
    });
    expect(await owner.genericTaskItem.findFirstOrThrow({ where: { taskId: "taskId" in manualRace ? manualRace.taskId : "" } })).toMatchObject({ status: "skipped", result: expect.objectContaining({ code: "manual_mode" }) });
    expect(await owner.tagClassificationRun.count({ where: { novelId } })).toBe(1);
  });

  it("lets a fenced protected write select the final terminal outcome", async () => {
    const task = await owner.genericTask.create({ data: {
      taskType: TAGGING_AUTO_CLASSIFY_TASK_TYPE,
      operationScopeHash: hash,
      requestToken: randomUUID(),
      totalCount: 1,
      items: { create: [{ targetType: "Novel", targetId: ids.novel, payload: {} }] },
    }, include: { items: true } });
    const lease = await claimPendingItem(worker, {
      family: "generic", taskTypes: [TAGGING_AUTO_CLASSIFY_TASK_TYPE], workerId: "terminal-override", leaseMs: 30_000,
    });
    expect(lease?.itemId).toBe(task.items[0].id);
    await finalizeTaskItem(worker, lease!, {
      status: "success",
      result: { code: "provisional" },
      protectedWrite: async () => ({ status: "skipped", result: { code: "manual_mode" } }),
    });
    expect(await owner.genericTaskItem.findUniqueOrThrow({ where: { id: task.items[0].id } })).toMatchObject({
      status: "skipped", result: { code: "manual_mode" },
    });
  });
});
