import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { SITE_LOCALES } from "@/lib/locale/locale-canonical";
import { CANONICAL_TAG_V1_COUNT, CANONICAL_TAG_V1_SHA256 } from "@/lib/tagging/keyword-artifact";
import {
  TRANSLATION_OVERLAY_AUDIT_ACTION,
  TRANSLATION_OVERLAY_EXPECTED_COUNT,
  TRANSLATION_OVERLAY_RELATIVE_PATH,
  TRANSLATION_OVERLAY_SHA256,
  TranslationOverlayError,
  loadTranslationOverlayArtifact,
  parseTranslationOverlayArtifact,
  describeOverlayDatabaseTarget,
  parseTranslationOverlayCliOptions,
  runTranslationOverlayCli,
  type TranslationOverlayArtifact,
  type TranslationOverlayCliOptions,
} from "../../../scripts/p2-06-5-production/canonical-tag-translation-overlay";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const V1_PATH = "docs/p2/p2-06-5-lane-a/canonical-tag-v1-final/2026-08-16/canonical-tag-v1.0.0-final.json";
const APPROVER_ID = "22222222-2222-4222-8222-222222222222";
const TAG_ID = "11111111-1111-4111-8111-111111111111";

function baseOptions(overrides: Partial<TranslationOverlayCliOptions> = {}): TranslationOverlayCliOptions {
  return Object.freeze({
    requestId: "req-overlay-1",
    reason: "unit test overlay",
    approver: APPROVER_ID,
    apply: false,
    overwriteZh: false,
    ...overrides,
  });
}

function miniArtifact(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: 1,
    artifact_status: "REVIEWED",
    taxonomy_version: "canonical-tag-v1",
    canonical_v1_sha256: CANONICAL_TAG_V1_SHA256,
    canonical_v1_count: CANONICAL_TAG_V1_COUNT,
    public_locales: [...SITE_LOCALES],
    translation_count: TRANSLATION_OVERLAY_EXPECTED_COUNT,
    overwrite_zh: false,
    cache_note: "Public taxonomy queries are force-dynamic with request-scoped React.cache().",
    translations: Array.from({ length: TRANSLATION_OVERLAY_EXPECTED_COUNT }, (_, index) => ({
      stableId: `ct-v1-${Math.floor(index / SITE_LOCALES.length)}`,
      slug: `slug-${Math.floor(index / SITE_LOCALES.length)}`,
      locale: SITE_LOCALES[index % SITE_LOCALES.length],
      displayName: `Label ${index}`,
      source: "new",
      sourceLocale: SITE_LOCALES[index % SITE_LOCALES.length],
      reviewStatus: "new",
    })),
    ...overrides,
  };
}

type Row = Record<string, unknown>;

class FakeOverlayDb {
  readonly tags = new Map<string, Row>();
  readonly translations = new Map<string, Row>();
  readonly identities: Row[] = [{ id: APPROVER_ID, username: "owner", status: "active" }];
  readonly audits: Row[] = [];

  seedTag(stableId: string, slug: string, id = TAG_ID) {
    this.tags.set(stableId, { id, stableId, slug });
  }

  asClient() {
    const client = {
      canonicalTag: {
        findMany: async (args: { where: { stableId: { in: string[] } }; select: unknown }) =>
          args.where.stableId.in.flatMap((stableId) => {
            const row = this.tags.get(stableId);
            return row ? [{ id: row.id, stableId: row.stableId, slug: row.slug }] : [];
          }),
      },
      canonicalTagTranslation: {
        count: async () => this.translations.size,
        findMany: async (args?: { where?: { canonicalTagId?: { in: string[] } } }) => {
          const ids = args?.where?.canonicalTagId?.in;
          return [...this.translations.values()].filter((row) =>
            !ids || ids.includes(String(row.canonicalTagId)),
          );
        },
        upsert: async (args: {
          where: { canonicalTagId_locale: { canonicalTagId: string; locale: string } };
          create: Row;
          update: Row;
        }) => {
          const key = `${args.where.canonicalTagId_locale.canonicalTagId}::${args.where.canonicalTagId_locale.locale}`;
          const existing = this.translations.get(key);
          const next = existing
            ? { ...existing, ...args.update }
            : { id: key, ...args.create };
          this.translations.set(key, next);
          return next;
        },
      },
      adminIdentity: {
        findFirst: async (args: { where: { id?: string; username?: string } }) =>
          this.identities.find((row) => row.id === args.where.id || row.username === args.where.username) ?? null,
      },
      operationAudit: {
        findFirst: async (args: { where: { actorType: string; action: string; requestId: string } }) =>
          this.audits.find((audit) =>
            audit.actorType === args.where.actorType
            && audit.action === args.where.action
            && audit.requestId === args.where.requestId) ?? null,
        create: async (args: { data: Row }) => {
          const row = { id: BigInt(this.audits.length + 1), ...args.data };
          this.audits.push(row);
          return { id: row.id };
        },
      },
      $queryRaw: async () => [{ lock_result: null }],
      $transaction: async <T>(callback: (tx: never) => Promise<T>) => callback(client as never),
    };
    return client as unknown as Parameters<typeof runTranslationOverlayCli>[0];
  }
}

describe("canonical tag translation overlay artifact", () => {
  it("pins the on-disk overlay SHA-256 and covers SITE_LOCALES × 123 without zh", () => {
    const loaded = loadTranslationOverlayArtifact(REPO_ROOT);
    const bytes = readFileSync(join(REPO_ROOT, TRANSLATION_OVERLAY_RELATIVE_PATH));
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(TRANSLATION_OVERLAY_SHA256);
    expect(loaded.sha256).toBe(TRANSLATION_OVERLAY_SHA256);
    expect(loaded.artifact.canonical_v1_sha256).toBe(CANONICAL_TAG_V1_SHA256);
    expect(loaded.artifact.translation_count).toBe(CANONICAL_TAG_V1_COUNT * SITE_LOCALES.length);
    expect(loaded.artifact.public_locales).toEqual([...SITE_LOCALES]);
    expect(loaded.artifact.overwrite_zh).toBe(false);
    expect(loaded.artifact.translations.some((row) => (row.locale as string) === "zh")).toBe(false);
    for (const row of loaded.artifact.translations) {
      expect(SITE_LOCALES).toContain(row.locale);
      expect(row.displayName.trim().length).toBeGreaterThan(0);
      expect(row.sourceLocale.trim().length).toBeGreaterThan(0);
      expect(["reuse_cps_exact_slug", "reuse_cps_semantic_map", "reuse_repair", "new"]).toContain(row.source);
      expect(["reviewed", "adapted", "new", "pending-review"]).toContain(row.reviewStatus);
      expect(row.displayName).not.toBe("Ldentity Swap");
      expect(row.displayName).not.toBe("BE");
    }
    expect(loaded.artifact.translations.some((row) => row.sourceLocale === "pt")).toBe(false);
    expect(loaded.artifact.translations.filter((row) => row.reviewStatus === "pending-review")).toHaveLength(0);
    expect(readFileSync(join(REPO_ROOT, "scripts/p2-06-5-production/build-canonical-tag-translation-overlay.py"), "utf8"))
      .not.toMatch(/data\/moboreels\/_tags-minimax-filled/);
    expect(loaded.artifact.cache_note).toMatch(/force-dynamic/);
  });

  it("does not rewrite the frozen CanonicalTag v1 JSON", () => {
    const v1 = readFileSync(join(REPO_ROOT, V1_PATH));
    expect(createHash("sha256").update(v1).digest("hex")).toBe(CANONICAL_TAG_V1_SHA256);
    const parsed = JSON.parse(v1.toString("utf8")) as { tags: { translations: { locale: string }[] }[] };
    for (const tag of parsed.tags) {
      expect(tag.translations.map((row) => row.locale)).toEqual(["zh"]);
    }
  });

  it("rejects an overlay that changes the pinned v1 SHA", () => {
    expect(() => parseTranslationOverlayArtifact(miniArtifact({ canonical_v1_sha256: "0".repeat(64) }))).toThrow(
      TranslationOverlayError,
    );
  });
});

describe("canonical tag translation overlay CLI", () => {
  it("is dry-run by default and requires request-id/reason; apply requires approver", () => {
    expect(parseTranslationOverlayCliOptions(["--request-id", "r1", "--reason", "why"])).toEqual({
      requestId: "r1",
      reason: "why",
      approver: null,
      apply: false,
      overwriteZh: false,
    });
    expect(() => parseTranslationOverlayCliOptions(["--reason", "why"])).toThrow(/--request-id/);
    expect(() => parseTranslationOverlayCliOptions(["--request-id", "r1", "--reason", "why", "--apply"])).toThrow(/--approver/);
  });

  it("upserts translations without creating CanonicalTag rows and writes OperationAudit", async () => {
    const db = new FakeOverlayDb();
    db.seedTag("ct-v1-0", "slug-0");
    const translations = SITE_LOCALES.map((locale) => ({
      stableId: "ct-v1-0",
      slug: "slug-0",
      locale,
      displayName: `Name ${locale}`,
      source: "new" as const,
      sourceLocale: locale,
      reviewStatus: "new" as const,
    }));
    const artifact = parseTranslationOverlayArtifact(miniArtifact({
      canonical_v1_count: CANONICAL_TAG_V1_COUNT,
      translations: [
        ...translations,
        ...Array.from({ length: TRANSLATION_OVERLAY_EXPECTED_COUNT - translations.length }, (_, index) => ({
          stableId: `ct-v1-${Math.floor((index + SITE_LOCALES.length) / SITE_LOCALES.length)}`,
          slug: `slug-${Math.floor((index + SITE_LOCALES.length) / SITE_LOCALES.length)}`,
          locale: SITE_LOCALES[index % SITE_LOCALES.length],
          displayName: `Pad ${index}`,
          source: "new",
          sourceLocale: SITE_LOCALES[index % SITE_LOCALES.length],
          reviewStatus: "new",
        })),
      ],
    })) as TranslationOverlayArtifact;

    for (const stableId of new Set(artifact.translations.map((row) => row.stableId))) {
      const slug = artifact.translations.find((row) => row.stableId === stableId)!.slug;
      db.seedTag(stableId, slug, stableId);
    }

    const dry = await runTranslationOverlayCli(db.asClient(), baseOptions(), { artifact, sha256: "fixture-sha" });
    expect(dry.mode).toBe("dry-run");
    expect(dry.wrote).toBe(false);
    expect(dry.insert).toBe(TRANSLATION_OVERLAY_EXPECTED_COUNT);
    expect(dry.update).toBe(0);
    expect(dry.unchanged).toBe(0);
    expect(dry.exception).toBe(0);
    expect(dry.wouldOverwriteExisting).toBe(0);
    expect(db.translations.size).toBe(0);

    const applied = await runTranslationOverlayCli(
      db.asClient(),
      baseOptions({ apply: true }),
      { artifact, sha256: "fixture-sha" },
    );
    expect(applied.outcome).toBe("applied");
    expect(applied.wrote).toBe(true);
    expect(applied.insert).toBe(TRANSLATION_OVERLAY_EXPECTED_COUNT);
    expect(applied.update).toBe(0);
    expect(db.translations.size).toBe(TRANSLATION_OVERLAY_EXPECTED_COUNT);
    expect(db.tags.size).toBe(CANONICAL_TAG_V1_COUNT);
    expect(db.audits[0]?.action).toBe(TRANSLATION_OVERLAY_AUDIT_ACTION);

    const replayed = await runTranslationOverlayCli(
      db.asClient(),
      baseOptions({ apply: true }),
      { artifact, sha256: "fixture-sha" },
    );
    expect(replayed.outcome).toBe("replayed");
    expect(replayed.wrote).toBe(false);
    expect(db.translations.size).toBe(TRANSLATION_OVERLAY_EXPECTED_COUNT);

    const secondRequest = await runTranslationOverlayCli(
      db.asClient(),
      baseOptions({ apply: true, requestId: "req-overlay-2" }),
      { artifact, sha256: "fixture-sha" },
    );
    expect(secondRequest.outcome).toBe("applied");
    expect(secondRequest.wrote).toBe(false);
    expect(secondRequest.insert).toBe(0);
    expect(secondRequest.update).toBe(0);
    expect(secondRequest.unchanged).toBe(TRANSLATION_OVERLAY_EXPECTED_COUNT);
    expect(db.translations.size).toBe(TRANSLATION_OVERLAY_EXPECTED_COUNT);
  });

  it("dry-run reports overwrites of existing display names without writing", async () => {
    const db = new FakeOverlayDb();
    db.seedTag("ct-v1-0", "slug-0");
    db.translations.set(`${TAG_ID}::en`, {
      canonicalTagId: TAG_ID,
      locale: "en",
      displayName: "Human EN label",
    });
    const translations = SITE_LOCALES.map((locale) => ({
      stableId: "ct-v1-0",
      slug: "slug-0",
      locale,
      displayName: `Name ${locale}`,
      source: "new" as const,
      sourceLocale: locale,
      reviewStatus: "new" as const,
    }));
    const artifact = parseTranslationOverlayArtifact(miniArtifact({
      translations: [
        ...translations,
        ...Array.from({ length: TRANSLATION_OVERLAY_EXPECTED_COUNT - translations.length }, (_, index) => ({
          stableId: `ct-v1-${Math.floor((index + SITE_LOCALES.length) / SITE_LOCALES.length)}`,
          slug: `slug-${Math.floor((index + SITE_LOCALES.length) / SITE_LOCALES.length)}`,
          locale: SITE_LOCALES[index % SITE_LOCALES.length],
          displayName: `Pad ${index}`,
          source: "new",
          sourceLocale: SITE_LOCALES[index % SITE_LOCALES.length],
          reviewStatus: "new",
        })),
      ],
    })) as TranslationOverlayArtifact;
    for (const stableId of new Set(artifact.translations.map((row) => row.stableId))) {
      const slug = artifact.translations.find((row) => row.stableId === stableId)!.slug;
      db.seedTag(stableId, slug, stableId === "ct-v1-0" ? TAG_ID : stableId);
    }

    const dry = await runTranslationOverlayCli(db.asClient(), baseOptions(), { artifact, sha256: "fixture-sha" });
    expect(dry.update).toBe(1);
    expect(dry.wouldOverwriteExisting).toBe(1);
    expect(dry.overwriteSamples).toEqual([
      { slug: "slug-0", locale: "en", existingDisplayName: "Human EN label", plannedDisplayName: "Name en" },
    ]);
    expect(dry.insert).toBe(TRANSLATION_OVERLAY_EXPECTED_COUNT - 1);
    expect(db.translations.get(`${TAG_ID}::en`)?.displayName).toBe("Human EN label");
  });

  it("does not update zh when --overwrite-zh is omitted even if a zh row sneaks into the plan", async () => {
    const db = new FakeOverlayDb();
    db.seedTag("ct-v1-werewolf", "werewolf");
    db.translations.set(`${TAG_ID}::zh`, { canonicalTagId: TAG_ID, locale: "zh", displayName: "狼人" });
    expect(parseTranslationOverlayCliOptions(["--request-id", "r", "--reason", "why"]).overwriteZh).toBe(false);
  });

  it("desensitizes DATABASE_URL without echoing the password", () => {
    const target = describeOverlayDatabaseTarget("postgresql://web_app:s3cret@db.internal:5432/cps_novel_qa?schema=public");
    expect(target).toEqual({
      configured: true,
      user: "web_app",
      database: "cps_novel_qa",
      hostFingerprint: expect.any(String),
      port: "5432",
    });
    expect(JSON.stringify(target)).not.toContain("s3cret");
    expect(describeOverlayDatabaseTarget(undefined).configured).toBe(false);
  });
});
