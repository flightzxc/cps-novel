import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import type { KeywordEligibilityAuthority } from "../../../src/lib/tagging/keyword-eligibility";
import {
  CANONICAL_ARTIFACT_RELATIVE_PATH,
  MAPPING_ARTIFACT_RELATIVE_PATH,
  TAGGING_BOOTSTRAP_AUDIT_ACTION,
  TaggingBootstrapError,
  buildCanonicalPlan,
  buildMappingPlan,
  loadTaggingBootstrapArtifacts,
  parseCsv,
  parseTaggingBootstrapCliOptions,
  runTaggingBootstrapCli,
  type TaggingBootstrapArtifacts,
  type TaggingBootstrapCliOptions,
} from "../../../scripts/p2-06-5-production/tagging-bootstrap";

// ---------------------------------------------------------------------------
// Fixtures — deliberately small (2 tags, 1 mapping edge). `buildCanonicalPlan`
// and `runTaggingBootstrapCli` never re-check the real 123/196 counts (only
// `parseCanonicalArtifact`, reached solely through `loadTaggingBootstrapArtifacts`
// against the real on-disk files, does that) so a fixture-sized artifact is a
// valid input for every function under test here.
// ---------------------------------------------------------------------------

function fixtureCanonical() {
  return {
    schema_version: 2,
    artifact_status: "FINAL",
    count: 2,
    tags: [
      {
        stable_id: "ct-fixture-alpha",
        slug: "fixture-alpha",
        canonical_definition: "Fixture alpha definition",
        translations: [{ locale: "zh", display_name: "甲" }],
        aliases: ["Alpha", "alpha-alias"],
        keyword_seeds: ["Alpha", "alpha", "Common"],
        facet: "topic",
        status: "public",
      },
      {
        stable_id: "ct-fixture-beta",
        slug: "fixture-beta",
        canonical_definition: "Fixture beta definition",
        translations: [{ locale: "zh", display_name: "乙" }, { locale: "en", display_name: "Beta" }],
        aliases: ["Beta"],
        keyword_seeds: ["Beta", "甲乙丙", "Common"],
        facet: "setting",
        status: "public",
      },
    ],
    qa: { stable_id_unique: true, slug_unique: true, alias_collision_count: 0, alias_collisions: [] },
  };
}

const MAPPING_HEADER = "record_type,canonical_stable_id,channel_app_id,raw_language_scope,exact_raw_token,final_disposition";
function fixtureMappingCsv(): string {
  const scope = JSON.stringify(["RAW_LANGUAGE_SCOPE_V1", ["number", "10"], ["string", "英语"]]);
  const escapedScope = scope.replace(/"/g, '""');
  const rows = [
    // Two independent groups (different raw tokens) — the common case.
    `MAPPING_EDGE,ct-fixture-alpha,fixture-app,"${escapedScope}",Fantasy,APPROVED_MAP_CANDIDATE`,
    `MAPPING_EDGE,ct-fixture-beta,fixture-app,"${escapedScope}",Romance,APPROVED_MAP_CANDIDATE`,
    // A row the loader must ignore: not a MAPPING_EDGE.
    `COMPOUND_GROUP_SUMMARY,,fixture-app,"${escapedScope}",Fantasy,APPROVED_MAP_CANDIDATE`,
  ];
  return [MAPPING_HEADER, ...rows].join("\n");
}

/** Same group (token), two canonical tags — the B2 1:N fanout shape. */
function fixtureFanoutMappingCsv(): string {
  const scope = JSON.stringify(["RAW_LANGUAGE_SCOPE_V1", ["number", "10"], ["string", "英语"]]);
  const escapedScope = scope.replace(/"/g, '""');
  const rows = [
    `MAPPING_EDGE,ct-fixture-alpha,fixture-app,"${escapedScope}",Fantasy,APPROVED_MAP_CANDIDATE`,
    `MAPPING_EDGE,ct-fixture-beta,fixture-app,"${escapedScope}",Fantasy,APPROVED_MAP_CANDIDATE`,
  ];
  return [MAPPING_HEADER, ...rows].join("\n");
}

function fixtureArtifacts(): TaggingBootstrapArtifacts {
  return {
    canonical: fixtureCanonical() as unknown as TaggingBootstrapArtifacts["canonical"],
    canonicalSha256: "fixture-canonical-sha",
    mappingRows: parseCsv(fixtureMappingCsv()),
    mappingSha256: "fixture-mapping-sha",
  };
}

const CHANNEL_APP_UUID = "11111111-1111-4111-8111-111111111111";
const APPROVER_ID = "22222222-2222-4222-8222-222222222222";

function baseOptions(overrides: Partial<TaggingBootstrapCliOptions> = {}): TaggingBootstrapCliOptions {
  return Object.freeze({
    requestId: "req-fixture-1",
    reason: "unit test bootstrap",
    channelAppBinding: Object.freeze({ "fixture-app": CHANNEL_APP_UUID }),
    approver: APPROVER_ID,
    apply: false,
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Fake Prisma-shaped DB (mirrors tests/backend/auth/bootstrap-admin-identity.test.ts)
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

class FakeTaggingBootstrapDb {
  readonly canonicalTagRows = new Map<string, Row>(); // key: stableId
  readonly translationRows = new Map<string, Row>(); // key: canonicalTagId\nlocale
  readonly keywordRows = new Map<string, Row>(); // key: keywordId
  readonly mappingRows = new Map<string, Row>(); // key: channelAppId\nscope\ntoken\ncanonicalTagId
  readonly channelApps = new Map<string, { id: string; status: string }>();
  readonly adminIdentities = new Map<string, { id: string; username: string; status: string }>();
  readonly audits: Row[] = [];
  readonly calls: string[] = [];
  /** Throws if anything ever touches novel_canonical_tag — bootstrap must never write it. */
  readonly novelCanonicalTagGuardTripped = { value: false };

  constructor() {
    this.channelApps.set(CHANNEL_APP_UUID, { id: CHANNEL_APP_UUID, status: "active" });
    this.adminIdentities.set(APPROVER_ID, { id: APPROVER_ID, username: "fixture-approver", status: "active" });
  }

  private client() {
    const record = (name: string) => this.calls.push(name);
    return {
      canonicalTag: {
        count: async () => { record("canonicalTag.count"); return this.canonicalTagRows.size; },
        upsert: async (args: { where: { stableId: string }; create: Row; update: Row }) => {
          record("canonicalTag.upsert");
          const existing = this.canonicalTagRows.get(args.where.stableId);
          const row = existing ? { ...existing, ...args.update } : { id: randomUUID(), stableId: args.where.stableId, ...args.create };
          this.canonicalTagRows.set(args.where.stableId, row);
          return { id: row.id as string };
        },
      },
      canonicalTagTranslation: {
        count: async () => { record("canonicalTagTranslation.count"); return this.translationRows.size; },
        upsert: async (args: { where: { canonicalTagId_locale: { canonicalTagId: string; locale: string } }; create: Row; update: Row }) => {
          record("canonicalTagTranslation.upsert");
          const key = `${args.where.canonicalTagId_locale.canonicalTagId}\n${args.where.canonicalTagId_locale.locale}`;
          const existing = this.translationRows.get(key);
          this.translationRows.set(key, existing ? { ...existing, ...args.update } : { ...args.create });
        },
      },
      canonicalTagKeyword: {
        count: async () => { record("canonicalTagKeyword.count"); return this.keywordRows.size; },
        upsert: async (args: { where: { keywordId: string }; create: Row; update: Row }) => {
          record("canonicalTagKeyword.upsert");
          const existing = this.keywordRows.get(args.where.keywordId);
          this.keywordRows.set(args.where.keywordId, existing ? { ...existing, ...args.update } : { ...args.create });
        },
      },
      sourceLabelMapping: {
        count: async () => { record("sourceLabelMapping.count"); return this.mappingRows.size; },
        upsert: async (args: {
          where: { channelAppId_rawLanguageScope_rawToken_canonicalTagId: { channelAppId: string; rawLanguageScope: string; rawToken: string; canonicalTagId: string } };
          create: Row;
          update: Row;
        }) => {
          record("sourceLabelMapping.upsert");
          const k = args.where.channelAppId_rawLanguageScope_rawToken_canonicalTagId;
          const key = `${k.channelAppId}\n${k.rawLanguageScope}\n${k.rawToken}\n${k.canonicalTagId}`;
          const existing = this.mappingRows.get(key);
          this.mappingRows.set(key, existing ? { ...existing, ...args.update } : { ...args.create });
        },
      },
      channelApp: {
        findMany: async (args: { where: { id: { in: string[] } } }) => {
          record("channelApp.findMany");
          return args.where.id.in
            .map((id) => this.channelApps.get(id))
            .filter((row): row is { id: string; status: string } => row !== undefined);
        },
      },
      adminIdentity: {
        findFirst: async (args: { where: { id?: string; username?: string } }) => {
          record("adminIdentity.findFirst");
          for (const identity of this.adminIdentities.values()) {
            if (args.where.id !== undefined && identity.id === args.where.id) return identity;
            if (args.where.username !== undefined && identity.username === args.where.username) return identity;
          }
          return null;
        },
      },
      operationAudit: {
        findFirst: async (args: { where: { actorType: string; action: string; requestId: string } }) => {
          record("operationAudit.findFirst");
          return this.audits.find((audit) =>
            audit.actorType === args.where.actorType && audit.action === args.where.action && audit.requestId === args.where.requestId) ?? null;
        },
        create: async (args: { data: Row }) => {
          record("operationAudit.create");
          const row = { id: BigInt(this.audits.length + 1), ...args.data };
          this.audits.push(row);
          return { id: row.id };
        },
      },
      novelCanonicalTag: new Proxy({}, {
        get: () => { this.novelCanonicalTagGuardTripped.value = true; throw new Error("bootstrap must never touch novel_canonical_tag"); },
      }),
      $queryRaw: async () => { record("pg_advisory_xact_lock"); return [{ lock_result: null }]; },
    };
  }

  asClient(): Parameters<typeof runTaggingBootstrapCli>[0] {
    const root = this.client();
    return {
      ...root,
      $transaction: async <T>(callback: (tx: ReturnType<FakeTaggingBootstrapDb["client"]>) => Promise<T>) => {
        this.calls.push("$transaction");
        const before = {
          canonicalTagRows: new Map(this.canonicalTagRows),
          translationRows: new Map(this.translationRows),
          keywordRows: new Map(this.keywordRows),
          mappingRows: new Map(this.mappingRows),
          audits: [...this.audits],
        };
        try {
          return await callback(this.client());
        } catch (error) {
          this.canonicalTagRows.clear(); for (const [k, v] of before.canonicalTagRows) this.canonicalTagRows.set(k, v);
          this.translationRows.clear(); for (const [k, v] of before.translationRows) this.translationRows.set(k, v);
          this.keywordRows.clear(); for (const [k, v] of before.keywordRows) this.keywordRows.set(k, v);
          this.mappingRows.clear(); for (const [k, v] of before.mappingRows) this.mappingRows.set(k, v);
          this.audits.splice(0, this.audits.length, ...before.audits);
          throw error;
        }
      },
    } as unknown as Parameters<typeof runTaggingBootstrapCli>[0];
  }
}

// ---------------------------------------------------------------------------
// parseCsv
// ---------------------------------------------------------------------------

describe("tagging bootstrap parseCsv", () => {
  it("handles quoted fields with embedded commas and doubled quotes", () => {
    const csv = 'a,b\n"1,2","say ""hi"""\nplain,value\n';
    expect(parseCsv(csv)).toEqual([
      { a: "1,2", b: 'say "hi"' },
      { a: "plain", b: "value" },
    ]);
  });

  it("drops blank trailing rows and strips a leading BOM", () => {
    const csv = "﻿a,b\nx,y\n\n";
    expect(parseCsv(csv)).toEqual([{ a: "x", b: "y" }]);
  });
});

// ---------------------------------------------------------------------------
// loadTaggingBootstrapArtifacts — pinned SHA-256 gate
// ---------------------------------------------------------------------------

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");

describe("tagging bootstrap artifact loading", () => {
  function writeFixtureRepo(canonicalText: string, mappingText: string): string {
    const root = mkdtempSync(join(tmpdir(), "tagging-bootstrap-fixture-"));
    const canonicalPath = join(root, CANONICAL_ARTIFACT_RELATIVE_PATH);
    const mappingPath = join(root, MAPPING_ARTIFACT_RELATIVE_PATH);
    mkdirSync(dirname(canonicalPath), { recursive: true });
    mkdirSync(dirname(mappingPath), { recursive: true });
    writeFileSync(canonicalPath, canonicalText);
    writeFileSync(mappingPath, mappingText);
    return root;
  }

  it("rejects a canonical artifact whose bytes do not match the pinned SHA-256", () => {
    const root = writeFixtureRepo("not the real canonical artifact", `${MAPPING_HEADER}\n`);
    try {
      loadTaggingBootstrapArtifacts(root);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(TaggingBootstrapError);
      expect(error).toMatchObject({ code: "sha256_mismatch" });
      expect(String(error)).toMatch(/CanonicalTag v1 Final artifact/);
    }
  });

  it("rejects a mapping artifact whose bytes do not match the pinned SHA-256, even when the canonical artifact hash is fine", () => {
    // Use the real canonical bytes so the first (canonical) gate passes,
    // isolating the mapping file's own independent SHA-256 check.
    const realCanonicalText = readFileSync(join(REPO_ROOT, CANONICAL_ARTIFACT_RELATIVE_PATH), "utf8");
    const root = writeFixtureRepo(realCanonicalText, "also not the real mapping csv");
    try {
      loadTaggingBootstrapArtifacts(root);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(TaggingBootstrapError);
      expect(error).toMatchObject({ code: "sha256_mismatch" });
      expect(String(error)).toMatch(/B2 mapping candidates artifact/);
    }
  });
});

// ---------------------------------------------------------------------------
// buildMappingPlan
// ---------------------------------------------------------------------------

describe("tagging bootstrap buildMappingPlan", () => {
  it("filters to approved MAPPING_EDGE rows and counts groups vs. edges", () => {
    const plan = buildMappingPlan(parseCsv(fixtureMappingCsv()));
    expect(plan.edgeCount).toBe(2);
    expect(plan.groupCount).toBe(2);
    expect(plan.channelAppSymbols).toEqual(["fixture-app"]);
  });

  it("rejects a malformed raw_language_scope", () => {
    const csv = [MAPPING_HEADER, "MAPPING_EDGE,ct-x,app,not-json,Token,APPROVED_MAP_CANDIDATE"].join("\n");
    expect(() => buildMappingPlan(parseCsv(csv))).toThrow(TaggingBootstrapError);
  });

  it("counts a 1:N fanout (same token, two canonical tags) as one group / two edges", () => {
    const plan = buildMappingPlan(parseCsv(fixtureFanoutMappingCsv()));
    expect(plan.edgeCount).toBe(2);
    expect(plan.groupCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// buildCanonicalPlan
// ---------------------------------------------------------------------------

const NO_OP_ELIGIBILITY: KeywordEligibilityAuthority = Object.freeze({
  version: "keyword-eligibility-v2",
  sha256: "fixture",
  rules: [],
});

describe("tagging bootstrap buildCanonicalPlan", () => {
  it("dedupes intra-tag seeds, drops cross-tag collisions, and counts everything", () => {
    const plan = buildCanonicalPlan(fixtureCanonical() as never, NO_OP_ELIGIBILITY);
    expect(plan.canonicalCount).toBe(2);
    expect(plan.translationCount).toBe(3); // 1 (alpha) + 2 (beta)
    expect(plan.aliasCount).toBe(3); // 2 + 1
    // "Alpha"/"alpha" collapse to one keyword for alpha; "Common" is used by
    // both tags so it is dropped from both as a cross-tag collision.
    const alpha = plan.tags.find((tag) => tag.stableId === "ct-fixture-alpha")!;
    const beta = plan.tags.find((tag) => tag.stableId === "ct-fixture-beta")!;
    expect(alpha.keywords.map((k) => k.value)).toEqual(["Alpha"]);
    expect(beta.keywords.map((k) => k.value)).toEqual(["Beta", "甲乙丙"]);
    expect(plan.skipped.collision).toBe(2); // "Common" skipped once per tag
    expect(plan.keywordCount).toBe(3);
  });

  it("drops a seed the eligibility overlay disables", () => {
    const eligibility: KeywordEligibilityAuthority = Object.freeze({
      version: "keyword-eligibility-v2",
      sha256: "fixture",
      rules: [Object.freeze({
        canonicalTagId: "ct-fixture-alpha",
        normalizedSeed: "alpha",
        enabled: false,
        allowedFields: null,
        blockedDescriptionNamedScopes: [],
        reason: "TEST_DISABLE",
      })],
    });
    const plan = buildCanonicalPlan(fixtureCanonical() as never, eligibility);
    const alpha = plan.tags.find((tag) => tag.stableId === "ct-fixture-alpha")!;
    expect(alpha.keywords.map((k) => k.value)).toEqual([]);
    expect(plan.skipped.overlayDisabled).toBe(1);
  });

  it("rejects an alias that collides with another tag's stableId/slug/alias", () => {
    const artifact = fixtureCanonical();
    artifact.tags[1].aliases = ["ct-fixture-alpha"]; // collides with tag 0's stable_id
    expect(() => buildCanonicalPlan(artifact as never, NO_OP_ELIGIBILITY)).toThrow(TaggingBootstrapError);
  });

  it("does not flag a tag's own alias repeating its own slug as a collision", () => {
    // Regression: the real 123-tag CanonicalTag v1 Final artifact has, e.g.,
    // ct-v1-adventure with slug "adventure" AND alias "adventure" (the slug
    // deliberately reused as a keyword-matching seed). `mutateAdminCanonicalTag`'s
    // `replace_aliases` only checks an alias against *other* tags' identity
    // set, never its own — this must match.
    const artifact = fixtureCanonical();
    artifact.tags[0].aliases = [artifact.tags[0].slug, "Alpha"]; // "fixture-alpha" repeats its own slug
    const plan = buildCanonicalPlan(artifact as never, NO_OP_ELIGIBILITY);
    expect(plan.canonicalCount).toBe(2);
    expect(plan.tags[0].aliases).toEqual(["fixture-alpha", "Alpha"]);
  });
});

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

describe("tagging bootstrap CLI parsing", () => {
  it("is dry-run by default and requires --request-id/--reason", () => {
    const parsed = parseTaggingBootstrapCliOptions(["--request-id", "r1", "--reason", "why"]);
    expect(parsed).toEqual({ requestId: "r1", reason: "why", channelAppBinding: {}, approver: null, apply: false });
    expect(() => parseTaggingBootstrapCliOptions(["--reason", "why"])).toThrow(/--request-id/);
    expect(() => parseTaggingBootstrapCliOptions(["--request-id", "r1"])).toThrow(/--reason/);
  });

  it("requires --approver for --apply", () => {
    expect(() => parseTaggingBootstrapCliOptions(["--request-id", "r1", "--reason", "why", "--apply"])).toThrow(/--approver/);
    expect(parseTaggingBootstrapCliOptions([
      "--request-id", "r1", "--reason", "why", "--approver", "admin", "--apply",
    ])).toMatchObject({ apply: true, approver: "admin" });
  });

  it("parses one or more --channel-app symbol=uuid bindings", () => {
    const parsed = parseTaggingBootstrapCliOptions([
      "--request-id", "r1", "--reason", "why", "--channel-app", `changdu-app=${CHANNEL_APP_UUID}`,
    ]);
    expect(parsed.channelAppBinding).toEqual({ "changdu-app": CHANNEL_APP_UUID });
    expect(() => parseTaggingBootstrapCliOptions([
      "--request-id", "r1", "--reason", "why", "--channel-app", "changdu-app=not-a-uuid",
    ])).toThrow(/--channel-app/);
    expect(() => parseTaggingBootstrapCliOptions([
      "--request-id", "r1", "--reason", "why", "--channel-app", "no-equals-sign",
    ])).toThrow(/--channel-app/);
  });
});

// ---------------------------------------------------------------------------
// runTaggingBootstrapCli — dry-run
// ---------------------------------------------------------------------------

describe("tagging bootstrap dry-run", () => {
  it("reports planned counts and writes nothing", async () => {
    const db = new FakeTaggingBootstrapDb();
    const report = await runTaggingBootstrapCli(db.asClient(), baseOptions(), fixtureArtifacts());

    expect(report).toMatchObject({
      mode: "dry-run",
      outcome: "eligible",
      wrote: false,
      auditId: null,
      planned: { canonicalTag: 2, canonicalTagTranslation: 3, alias: 3, canonicalTagKeyword: 3, sourceLabelMappingGroup: 2, sourceLabelMappingEdge: 2 },
      databaseBefore: { canonicalTag: 0, canonicalTagTranslation: 0, canonicalTagKeyword: 0, sourceLabelMapping: 0 },
      databaseAfter: null,
    });
    expect(db.calls).not.toContain("$transaction");
    expect(db.calls).not.toContain("canonicalTag.upsert");
    expect(db.calls).not.toContain("operationAudit.create");
    expect(db.canonicalTagRows.size).toBe(0);
    expect(db.mappingRows.size).toBe(0);
    expect(db.novelCanonicalTagGuardTripped.value).toBe(false);
  });

  it("still validates the channel-app binding against the database (read-only)", async () => {
    const db = new FakeTaggingBootstrapDb();
    await expect(runTaggingBootstrapCli(db.asClient(), baseOptions({ channelAppBinding: {} }), fixtureArtifacts()))
      .rejects.toMatchObject({ code: "channel_app_binding_missing" });

    const unknownUuid = "99999999-9999-4999-8999-999999999999";
    await expect(runTaggingBootstrapCli(
      db.asClient(),
      baseOptions({ channelAppBinding: { "fixture-app": unknownUuid } }),
      fixtureArtifacts(),
    )).rejects.toMatchObject({ code: "channel_app_not_found" });
    expect(db.calls).not.toContain("$transaction");
  });
});

// ---------------------------------------------------------------------------
// runTaggingBootstrapCli — apply
// ---------------------------------------------------------------------------

describe("tagging bootstrap apply", () => {
  it("rejects an approver that does not exist", async () => {
    const db = new FakeTaggingBootstrapDb();
    const unknown = "33333333-3333-4333-8333-333333333333";
    await expect(runTaggingBootstrapCli(db.asClient(), baseOptions({ apply: true, approver: unknown }), fixtureArtifacts()))
      .rejects.toMatchObject({ code: "approver_not_found" });
    expect(db.canonicalTagRows.size).toBe(0);
  });

  it("rejects an approver that exists but is not active", async () => {
    const db = new FakeTaggingBootstrapDb();
    const inactiveId = "44444444-4444-4444-8444-444444444444";
    db.adminIdentities.set(inactiveId, { id: inactiveId, username: "inactive-admin", status: "disabled" });
    await expect(runTaggingBootstrapCli(db.asClient(), baseOptions({ apply: true, approver: inactiveId }), fixtureArtifacts()))
      .rejects.toMatchObject({ code: "approver_inactive" });
    expect(db.canonicalTagRows.size).toBe(0);
  });

  it("resolves an approver by username as well as by UUID", async () => {
    const db = new FakeTaggingBootstrapDb();
    const report = await runTaggingBootstrapCli(db.asClient(), baseOptions({ apply: true, approver: "fixture-approver" }), fixtureArtifacts());
    expect(report).toMatchObject({ mode: "apply", outcome: "applied", wrote: true });
  });

  it("upserts tags/translations/keywords/mapping edges, writes one audit row, and never touches novel_canonical_tag", async () => {
    const db = new FakeTaggingBootstrapDb();
    const report = await runTaggingBootstrapCli(db.asClient(), baseOptions({ apply: true }), fixtureArtifacts());

    expect(report).toMatchObject({
      mode: "apply",
      outcome: "applied",
      wrote: true,
      databaseAfter: { canonicalTag: 2, canonicalTagTranslation: 3, canonicalTagKeyword: 3, sourceLabelMapping: 2 },
    });
    expect(db.canonicalTagRows.size).toBe(2);
    expect(db.translationRows.size).toBe(3);
    expect(db.keywordRows.size).toBe(3);
    expect(db.mappingRows.size).toBe(2);
    expect(db.audits).toHaveLength(1);
    expect(db.audits[0]).toMatchObject({
      actorType: "system",
      actorId: APPROVER_ID,
      action: TAGGING_BOOTSTRAP_AUDIT_ACTION,
      entityType: "CanonicalTag",
      requestId: baseOptions().requestId,
      reason: baseOptions().reason,
    });
    const afterSnapshot = db.audits[0].afterSnapshot as Record<string, unknown>;
    expect(afterSnapshot).toMatchObject({
      canonicalV1Sha256: "fixture-canonical-sha",
      mappingArtifactSha256: "fixture-mapping-sha",
      taxonomyVersion: "canonical-tag-v1",
      canonicalTag: 2,
    });
    expect(db.novelCanonicalTagGuardTripped.value).toBe(false);

    const mapping = [...db.mappingRows.values()][0];
    expect(mapping.approvedBy).toBe(APPROVER_ID);
  });

  it("is idempotent: a second apply with the same request id replays and writes nothing new", async () => {
    const db = new FakeTaggingBootstrapDb();
    const options = baseOptions({ apply: true });
    const first = await runTaggingBootstrapCli(db.asClient(), options, fixtureArtifacts());
    const callsAfterFirst = db.calls.length;

    const second = await runTaggingBootstrapCli(db.asClient(), options, fixtureArtifacts());

    expect(first).toMatchObject({ outcome: "applied", wrote: true });
    expect(second).toMatchObject({ outcome: "replayed", wrote: false, auditId: first.auditId });
    expect(db.audits).toHaveLength(1);
    expect(db.canonicalTagRows.size).toBe(2);
    expect(db.translationRows.size).toBe(3);
    expect(db.keywordRows.size).toBe(3);
    expect(db.mappingRows.size).toBe(2);
    expect(db.calls.filter((call) => call === "canonicalTag.upsert")).toHaveLength(2); // only from the first apply
    expect(db.calls.length).toBeGreaterThan(callsAfterFirst); // the replay still made read calls…
    expect(db.calls.slice(callsAfterFirst)).not.toContain("canonicalTag.upsert"); // …but no new writes
    expect(db.calls.slice(callsAfterFirst)).not.toContain("sourceLabelMapping.upsert");
    expect(db.calls.slice(callsAfterFirst)).not.toContain("operationAudit.create");
  });

  it("rejects a replayed request id whose binding no longer matches (different reason)", async () => {
    const db = new FakeTaggingBootstrapDb();
    const options = baseOptions({ apply: true });
    await runTaggingBootstrapCli(db.asClient(), options, fixtureArtifacts());

    await expect(runTaggingBootstrapCli(db.asClient(), { ...options, reason: "a different reason" }, fixtureArtifacts()))
      .rejects.toMatchObject({ code: "request_id_conflict" });
  });
});
