import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import b23Config from "@/lib/tagging/artifacts/classifier-config-b23-v1.json";
import {
  createFrozenTagClassifierConfig,
  LEGACY_TAG_CLASSIFIER_CONFIG_V2,
  loadTagClassifierConfig,
  PRODUCTION_TAG_CLASSIFIER_CONFIG,
  resolveProductionTagClassifierConfig,
} from "@/lib/tagging/classifier-config";
import { createDescriptionBoilerplateAuthority, loadDescriptionBoilerplateAuthority } from "@/lib/tagging/description-boilerplate";
import boilerplateJson from "@/lib/tagging/artifacts/description-boilerplate-v1.json";
import { CANONICAL_TAG_V1_SHA256, validateKeywordRuleArtifact } from "@/lib/tagging/keyword-artifact";
import { TAGGING_ALL_APPLY_CONFIRMATION } from "@/lib/tagging/task-contract";
import { readNovelClassificationSnapshot } from "@/server/tagging/auto-classification";
import { createTaggingAutoClassifyTask } from "@/server/tagging/tasks";
import { createNovelTagBackfillHandler } from "../../../worker/handlers/novel-tag-backfill";

// B-23: the rule change must be visible in the config version and fingerprint
// that authorise a reclassification, and the previous config stays as history.

// Fingerprint of the config in force through v0.5.6; production reported the same value in the 2026-09-27 evaluation.
const LEGACY_VERSION = "2026-08-17-owner-final-c1-final";
const LEGACY_FINGERPRINT = "2236bd35997c9ea933140a6fb0bac2e76ac75ebf5fcd8bef25ca3fc63d09d2d1";
const NEW_VERSION = "2026-10-01-b23-description-boilerplate-v1";
const NEW_FINGERPRINT = "948b1c083b0f999e619cfb2f808c4ec4e82c390f4daa8676325c610334a571d2";
const LIST_SHA256 = "bd686eabb7fa9345c26a32693665d3ada7e82b9ce52e13870b5fd2bb5a8cbde7";

describe("B-23 classifier config version and fingerprint", () => {
  it("keeps the previous config as history, byte-identical to what v0.5.6 ran", () => {
    expect(LEGACY_TAG_CLASSIFIER_CONFIG_V2).toMatchObject({
      status: "FROZEN", version: LEGACY_VERSION, fingerprint: LEGACY_FINGERPRINT,
      titleWeight: 30, descriptionWeight: 30, threshold: 30, maxTextTags: 3,
    });
    expect("descriptionBoilerplate" in LEGACY_TAG_CLASSIFIER_CONFIG_V2).toBe(false);
    expect(loadTagClassifierConfig(LEGACY_TAG_CLASSIFIER_CONFIG_V2)).toEqual(LEGACY_TAG_CLASSIFIER_CONFIG_V2);
  });

  it("production is a new version with a new fingerprint and the same weights", () => {
    expect(PRODUCTION_TAG_CLASSIFIER_CONFIG).toMatchObject({
      status: "FROZEN", version: NEW_VERSION, fingerprint: NEW_FINGERPRINT,
      titleWeight: 30, descriptionWeight: 30, threshold: 30, maxTextTags: 3,
    });
    expect(PRODUCTION_TAG_CLASSIFIER_CONFIG.fingerprint).not.toBe(LEGACY_FINGERPRINT);
    expect(PRODUCTION_TAG_CLASSIFIER_CONFIG.version).not.toBe(LEGACY_VERSION);
    expect(PRODUCTION_TAG_CLASSIFIER_CONFIG.descriptionBoilerplate).toMatchObject({ version: "description-boilerplate-v1", sha256: LIST_SHA256 });
    expect(b23Config.version).toBe(NEW_VERSION);
    expect(loadTagClassifierConfig()).toEqual(PRODUCTION_TAG_CLASSIFIER_CONFIG);
  });

  it("the fingerprint follows the list: a different list makes a different config fingerprint", () => {
    const patterns = boilerplateJson.patterns.map((pattern, index) => (
      index === 0 ? { ...pattern, phrase: `${pattern.phrase} indeed` } : pattern
    ));
    const changed = createDescriptionBoilerplateAuthority({ ...boilerplateJson, patterns });
    expect(changed.sha256).not.toBe(LIST_SHA256);
    const config = createFrozenTagClassifierConfig({
      version: NEW_VERSION, titleWeight: 30, descriptionWeight: 30, threshold: 30, maxTextTags: 3, descriptionBoilerplate: changed,
    });
    expect(config.fingerprint).not.toBe(NEW_FINGERPRINT);
    expect(loadTagClassifierConfig(config)).toEqual(config);
    // dropping the list altogether returns to the previous fingerprint for the same version label
    const without = createFrozenTagClassifierConfig({ version: LEGACY_VERSION, titleWeight: 30, descriptionWeight: 30, threshold: 30, maxTextTags: 3 });
    expect(without.fingerprint).toBe(LEGACY_FINGERPRINT);
  });

  it("refuses a config whose list or fingerprint was altered after freezing", () => {
    const authority = PRODUCTION_TAG_CLASSIFIER_CONFIG.descriptionBoilerplate!;
    const tampered = { ...authority, patterns: authority.patterns.slice(1) };
    expect(() => loadTagClassifierConfig({ ...PRODUCTION_TAG_CLASSIFIER_CONFIG, descriptionBoilerplate: tampered })).toThrow(/Description boilerplate fingerprint mismatch/);
    expect(() => loadTagClassifierConfig({ ...PRODUCTION_TAG_CLASSIFIER_CONFIG, fingerprint: LEGACY_FINGERPRINT })).toThrow(/fingerprint mismatch/);
    // the previous fingerprint cannot be paired with the boilerplate rule being on
    expect(() => loadTagClassifierConfig({
      ...LEGACY_TAG_CLASSIFIER_CONFIG_V2, version: LEGACY_VERSION, fingerprint: NEW_FINGERPRINT,
    })).toThrow(/fingerprint mismatch/);
  });

  it("fails closed when the B-23 artifact disagrees with the frozen base or its pinned list", () => {
    const resolve = (patch: Record<string, unknown>) => resolveProductionTagClassifierConfig({ ...b23Config, ...patch } as typeof b23Config);
    expect(resolve({})).toEqual(PRODUCTION_TAG_CLASSIFIER_CONFIG);
    expect(() => resolve({ status: "OWNER_REVIEW_PENDING" })).toThrow(/inconsistent/);
    expect(() => resolve({ extends: { ...b23Config.extends, fingerprint: "0".repeat(64) } })).toThrow(/inconsistent/);
    expect(() => resolve({ extends: { ...b23Config.extends, version: "other" } })).toThrow(/inconsistent/);
    expect(() => resolve({ auto_write_authorized: "YES" })).toThrow(/inconsistent/);
    expect(() => resolve({ version: LEGACY_VERSION })).toThrow(/inconsistent/);
    expect(() => resolve({ description_boilerplate: { ...b23Config.description_boilerplate, sha256: "0".repeat(64) } })).toThrow(/pinned fingerprint/);
    expect(() => resolve({ description_boilerplate: { ...b23Config.description_boilerplate, version: "description-boilerplate-v9" } })).toThrow(/Unknown description boilerplate/);
  });

  it("the pinned list fingerprint in the config artifact is the list's real fingerprint", () => {
    expect(loadDescriptionBoilerplateAuthority(b23Config.description_boilerplate.version).sha256).toBe(b23Config.description_boilerplate.sha256);
  });
});

describe("B-23 `--all --apply` needs the new fingerprint", () => {
  const artifact = validateKeywordRuleArtifact({
    schemaVersion: 1, taxonomyVersion: "v1", taxonomySha256: CANONICAL_TAG_V1_SHA256, keywordLexiconVersion: "fixture-v1",
    tags: [{
      canonicalTagId: "00000000-0000-4000-8000-0000000000aa", stableId: "ct-v1-a", textSelectionPriority: 0,
      keywords: [{ keywordId: "kw", value: "x", scriptBuckets: ["latin"], matchMode: "unicode_word", riskFlags: [] }],
    }],
  });
  const env = { NODE_ENV: "test" as const, FEATURE_P2_06_5_TAGGING: "true", FEATURE_NOVEL_TAG_AUTO: "true", AUTO_WRITE_AUTHORIZED: "YES" };

  function attempt(classifierConfigFingerprint: string) {
    const findMany = vi.fn().mockResolvedValue([]);
    const findUnique = vi.fn().mockResolvedValue(null);
    const db = { novel: { findMany }, genericTask: { findUnique }, $transaction: vi.fn() } as unknown as PrismaClient;
    // No `dependencies.config`: the real production config decides, exactly as the CLI does.
    const result = createTaggingAutoClassifyTask({
      db, env, lifecycle: "reclassify_existing", mode: "apply", scope: { kind: "all" }, requestId: "all-apply",
      dependencies: { artifact, enforceCanonicalV1: false },
      allApplyConfirmation: {
        literal: TAGGING_ALL_APPLY_CONFIRMATION,
        taxonomySha256: artifact.taxonomySha256,
        keywordFingerprint: artifact.keywordFingerprint,
        classifierConfigFingerprint,
      },
    });
    return { result, findMany, findUnique };
  }

  it("rejects the previous config fingerprint before touching the database", async () => {
    const { result, findMany, findUnique } = attempt(LEGACY_FINGERPRINT);
    await expect(result).rejects.toThrow(/All-scope apply authority confirmation mismatch/);
    expect(findUnique).not.toHaveBeenCalled();
    expect(findMany).not.toHaveBeenCalled();
  });

  it("accepts the new fingerprint", async () => {
    const { result, findMany } = attempt(NEW_FINGERPRINT);
    await expect(result).resolves.toEqual({ status: "no_eligible_novels", eligibleCount: 0 });
    expect(findMany).toHaveBeenCalled();
  });

  it("a dry-run of the same scope never needed the confirmation", async () => {
    const db = { novel: { findMany: vi.fn().mockResolvedValue([]) }, genericTask: { findUnique: vi.fn().mockResolvedValue(null) } } as unknown as PrismaClient;
    await expect(createTaggingAutoClassifyTask({
      db, env, lifecycle: "reclassify_existing", mode: "dry_run", scope: { kind: "all" }, requestId: "all-dry",
      dependencies: { artifact, enforceCanonicalV1: false },
    })).resolves.toEqual({ status: "no_eligible_novels", eligibleCount: 0 });
  });

  it("a task enqueued under the previous fingerprint is skipped as authority_changed by a worker running the new config", async () => {
    const novel = {
      id: "00000000-0000-4000-8000-000000000001", title: "Plain", description: "A royal soldier.", locale: "en", tagState: null, sourceItems: [],
    };
    const db = { novel: { findFirst: vi.fn().mockResolvedValue(novel) } } as unknown as PrismaClient;
    const snapshot = await readNovelClassificationSnapshot(db, novel.id);
    const payload = (classifierConfigVersion: string, classifierConfigFingerprint: string) => ({
      schemaVersion: 1, lifecycle: "reclassify_existing", novelId: novel.id,
      expectedContentSha256: snapshot.contentSha256, expectedEntityFingerprint: snapshot.entityFingerprint,
      taxonomyVersion: artifact.taxonomyVersion, taxonomySha256: artifact.taxonomySha256,
      keywordLexiconVersion: artifact.keywordLexiconVersion, keywordFingerprint: artifact.keywordFingerprint,
      classifierConfigVersion, classifierConfigFingerprint, classificationRequestId: "a".repeat(64),
    });
    const handler = createNovelTagBackfillHandler(db, { env, artifact, enforceCanonicalV1: false });
    const run = (value: ReturnType<typeof payload>) => handler({
      lease: { payload: value, taskType: "tagging.auto_classify", taskId: "task" },
      mode: "dry_run",
    } as unknown as Parameters<typeof handler>[0]);
    expect(await run(payload(LEGACY_VERSION, LEGACY_FINGERPRINT))).toEqual({ status: "skipped", result: { code: "authority_changed" } });
    expect(await run(payload(NEW_VERSION, NEW_FINGERPRINT))).toMatchObject({ status: "success", result: { code: "dry_run" } });
  });
});
