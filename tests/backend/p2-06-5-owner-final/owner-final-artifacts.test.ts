import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { parseCsv } from "../../../scripts/p2-06-5-lane-a/owner-final.mjs";
import { verifyB2FinalBundle } from "../../../scripts/p2-06-5-lane-b/b2-final.mjs";
import { verifyOwnerFinalC1 } from "../../../scripts/p2-06-5-lane-c/owner-final-c1.mjs";

const root = resolve(import.meta.dirname, "../../..");
const canonicalDir = resolve(root, "docs/p2/p2-06-5-lane-a/canonical-tag-v1-final/2026-08-16");
const b2Dir = resolve(root, "docs/p2/p2-06-5-lane-b/b2-owner-final/2026-08-16");
const c1Dir = resolve(root, "docs/p2/p2-06-5-lane-c/runs/2026-08-16-owner-final-c1-v2");
const c1AuthoritativeDir = resolve(root, "artifacts/p2-06-5-lane-c/2026-08-16-owner-final-c1-v2");
const ownerEvidenceDir = resolve(root, "docs/p2/p2-06-5-owner-final/2026-08-16/evidence");
const ownerFinalDir = resolve(root, "docs/p2/p2-06-5-owner-final/2026-08-16");

function sha256(value: Buffer | string) { return createHash("sha256").update(value).digest("hex"); }

describe("P2-06.5 Owner Final versioned artifacts", () => {
  it("materializes the selected 119 baseline as collision-free Final 123", async () => {
    const bytes = await readFile(resolve(canonicalDir, "canonical-tag-v1.0.0-final.json"));
    const artifact = JSON.parse(bytes.toString("utf8"));
    const expectedSha = (await readFile(resolve(canonicalDir, "canonical-tag-v1.0.0-final.json.sha256"), "utf8")).trim().split(/\s/u)[0];
    expect(sha256(bytes)).toBe(expectedSha);
    expect(artifact).toMatchObject({ artifact_status: "FINAL", count: 123 });
    const ids = artifact.tags.map(({ stable_id: id }: { stable_id: string }) => id);
    const slugs = artifact.tags.map(({ slug }: { slug: string }) => slug);
    expect(new Set(ids).size).toBe(123);
    expect(new Set(slugs).size).toBe(123);
    expect(ids).not.toEqual(expect.arrayContaining(["ct-v1-split:time-travel+rebirth", "ct-v1-power-dynamics-review", "ct-v1-mutual-first-experience-review"]));
    expect(slugs).toEqual(expect.arrayContaining(["male-audience", "lgbtq-romance", "supernatural", "horror", "historical-fiction", "gaming-esports", "xianxia"]));
    expect(slugs).not.toContain("fanfiction");
    expect(slugs).toContain("eastern-fantasy");
    expect(artifact.qa).toMatchObject({ stable_id_unique: true, slug_unique: true, alias_collision_count: 0, alias_collisions: [] });
    for (const tag of artifact.tags) {
      expect(tag).toMatchObject({
        stable_id: expect.stringMatching(/^ct-v1-/u),
        slug: expect.stringMatching(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u),
        display_name_zh: expect.any(String),
        canonical_definition: expect.any(String),
        translations: expect.any(Array),
        aliases: expect.any(Array),
        keyword_seeds: expect.any(Array),
        include_examples: expect.any(Array),
        exclude_examples: expect.any(Array),
        status: expect.any(String),
      });
      expect(tag.display_name_zh.length).toBeGreaterThan(0);
      expect(tag.canonical_definition.length).toBeGreaterThan(0);
      expect(tag.keyword_seeds.length).toBeGreaterThan(0);
      expect(tag.include_examples.length).toBeGreaterThan(0);
      expect(tag.exclude_examples.length).toBeGreaterThan(0);
    }
    const normalizedAliases = new Map<string, string>();
    for (const tag of artifact.tags) {
      for (const alias of [tag.slug, tag.display_name_zh, ...tag.aliases]) {
        const normalized = alias.normalize("NFKC").trim().toLocaleLowerCase("und");
        expect(normalizedAliases.get(normalized) ?? tag.stable_id).toBe(tag.stable_id);
        normalizedAliases.set(normalized, tag.stable_id);
      }
    }
    const manifest = JSON.parse(await readFile(resolve(canonicalDir, "CANONICAL_TAG_V1_MANIFEST.json"), "utf8"));
    expect(manifest).toMatchObject({ canonical_status: "FINAL", row_count: 123, stable_id_unique: true, slug_unique: true });
    for (const source of Object.values(manifest.source_evidence_versions) as Array<{ filename: string; sha256: string }>) {
      expect(sha256(await readFile(resolve(ownerEvidenceDir, source.filename)))).toBe(source.sha256);
    }
  });

  it("closes all 285 B2 logical keys with exact FK edges and no Owner queue", async () => {
    expect(await verifyB2FinalBundle(b2Dir)).toMatchObject({ ok: true, failures: [] });
    const summary = JSON.parse(await readFile(resolve(b2Dir, "b2-final-summary.json"), "utf8"));
    expect(summary).toMatchObject({ B2_MAPPING_KEY_TOTAL: 285, B2_ACCEPT_MAP: 194, B2_DEFER: 52, B2_IGNORE_DROP: 37, B2_CANONICAL_GAP: 2, B2_OWNER_REVIEW_REMAINING: 0, B2_MAPPING_CANDIDATE_ROW_COUNT: 198, B2_EXECUTABLE_MAPPING_EDGE_COUNT: 196 });
    const canonical = JSON.parse(await readFile(resolve(canonicalDir, "canonical-tag-v1.0.0-final.json"), "utf8"));
    const ids = new Set(canonical.tags.map(({ stable_id: id }: { stable_id: string }) => id));
    const mapping = parseCsv(await readFile(resolve(b2Dir, "mapping-candidates-final.csv"), "utf8"));
    expect(mapping).toHaveLength(198);
    const edges = mapping.filter(({ record_type: type }) => type === "MAPPING_EDGE");
    expect(edges).toHaveLength(196);
    expect(edges.every(({ canonical_stable_id: id }) => ids.has(id))).toBe(true);
    const summaries = mapping.filter(({ record_type: type }) => type === "COMPOUND_GROUP_SUMMARY");
    expect(summaries).toHaveLength(2);
    expect(summaries.every(({ canonical_stable_id: id }) => id === "")).toBe(true);
    expect(mapping.filter(({ exact_raw_token: token }) => token === "穿越重生")).toHaveLength(0);
    expect(edges.filter(({ exact_raw_token: token }) => token === "仙侠情缘" || token === "仙侠武侠" || token === "武侠仙侠" || token === "仙俠情緣" || token === "仙俠武俠").every(({ canonical_slug: slug }) => slug === "xianxia")).toBe(true);
    const deferred = parseCsv(await readFile(resolve(b2Dir, "deferred-source-dirty.csv"), "utf8"));
    const ignored = parseCsv(await readFile(resolve(b2Dir, "ignored-source-tokens.csv"), "utf8"));
    const gaps = parseCsv(await readFile(resolve(b2Dir, "canonical-gaps.csv"), "utf8"));
    expect(summary.B2_ACCEPT_MAP + summary.B2_DEFER + summary.B2_IGNORE_DROP + summary.B2_CANONICAL_GAP).toBe(285);
    expect(ignored.filter(({ exact_raw_token: token }) => token === "Adventure")).toHaveLength(2);
    expect(deferred.filter(({ exact_raw_token: token }) => token === "Xuanhuan")).toHaveLength(7);
    expect(deferred).toEqual(expect.arrayContaining([
      expect.objectContaining({ scope_label_non_authoritative: "EN", exact_raw_token: "History" }),
      expect.objectContaining({ scope_label_non_authoritative: "ES", exact_raw_token: "Historia" }),
      expect.objectContaining({ scope_label_non_authoritative: "FR", exact_raw_token: "Histoire" }),
      expect.objectContaining({ scope_label_non_authoritative: "EN", exact_raw_token: "Horror" }),
      expect.objectContaining({ scope_label_non_authoritative: "ES", exact_raw_token: "Adulto Joven" }),
      expect.objectContaining({ scope_label_non_authoritative: "PT", exact_raw_token: "Jovem Adulto" }),
    ]));
    expect(deferred.filter(({ exact_raw_token: token }) => token === "穿越重生")).toHaveLength(2);
    expect(edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ scope_label_non_authoritative: "EN", exact_raw_token: "Young Adult", canonical_slug: "young-adult", risk: "NOT_CONTENT_SAFETY_EVIDENCE" }),
      expect.objectContaining({ scope_label_non_authoritative: "RU", exact_raw_token: "Для взрослых", canonical_slug: "mature-content" }),
    ]));
    expect(gaps).toHaveLength(2);
    expect(gaps.every(({ exact_raw_token: token }) => token === "动漫同人" || token === "動漫世界")).toBe(true);
  });

  it("publishes a hash-verified 10k C1 aggregate with nine review-pending configurations", async () => {
    expect(await verifyOwnerFinalC1(c1Dir)).toMatchObject({ ok: true, failures: [] });
    const summary = JSON.parse(await readFile(resolve(c1Dir, "calibration-summary.json"), "utf8"));
    expect(summary.status).toMatchObject({ LANE_C_C1_STATUS: "CALIBRATION_REVIEW_PENDING", C1_SAMPLE_COUNT: 10000, TEXT_PARAMETER_STATUS: "CALIBRATION_RECOMMENDATION_ONLY", CHAPTER_EVIDENCE_STATUS: "DEFER", AUTO_WRITE_AUTHORIZED: "NO" });
    expect(summary.status).toMatchObject({
      C1_RECOMMENDED_SCHEME: "OWNER_REVIEW_REQUIRED",
      C1_RECOMMENDED_MAX_TEXT_TAGS: "OWNER_REVIEW_REQUIRED",
      C1_RECOMMENDED_THRESHOLD: "OWNER_REVIEW_REQUIRED",
      C2_SAMPLE_REQUEST: "NONE_PENDING_C1_ADJUDICATION",
      OWNER_NEXT_DECISIONS: "C1_INDEPENDENT_ADJUDICATION;TEXT_PARAMETER_FREEZE;C2_NEED_DECISION_AFTER_RECALL_REVIEW",
    });
    expect(summary.input_qa).toMatchObject({ unique_novels: 10000, unique_sample_rows: 10000, title_missing_or_empty: 0, description_missing_or_empty: 1, no_series_type: 1, novels_with_mapped_source_tags: 9932, manual_full_snapshot_count: 0 });
    expect(summary).toMatchObject({
      false_positive_audit_status: "UNASSESSED_PENDING_INDEPENDENT_REVIEW",
      high_false_positive_keyword_status: "UNASSESSED_PENDING_INDEPENDENT_REVIEW",
      c1_input_sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      scorer_sample_sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    expect(summary.configurations).toHaveLength(9);
    expect(new Set(summary.configurations.map(({ config_id: id, max_text_tags: cap }: { config_id: string; max_text_tags: number }) => `${id}/${cap}`)).size).toBe(9);
    for (const row of summary.configurations) {
      expect(row).toMatchObject({
        title_only_rate: expect.any(Number), description_only_rate: expect.any(Number), title_description_both_rate: expect.any(Number),
        selected_text_tag_count: { p50: expect.any(Number), p90: expect.any(Number), p99: expect.any(Number) },
        mapped_count: 9932, text_supplement_count: expect.any(Number), union_count: expect.any(Number),
      });
      expect(Object.values(row.source_text_relations).reduce((sum: number, value) => sum + Number(value), 0)).toBe(10000);
    }
    expect(summary.source_blind_simulation).toHaveLength(9);
    expect(summary.raw_scope_statistics.flatMap(({ rows }: { rows: Array<{ rawLanguageScope: string; localeStatisticsStatus: string }> }) => rows).filter(({ localeStatisticsStatus }: { localeStatisticsStatus: string }) => localeStatisticsStatus === "BLOCKED_RAW_SCOPE_ONLY").length).toBeGreaterThan(0);

    const inputBytes = await readFile(resolve(c1AuthoritativeDir, "c1-input.jsonl"));
    expect(sha256(inputBytes)).toBe(summary.c1_input_sha256);
    const inputRows = inputBytes.toString("utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(inputRows).toHaveLength(10000);
    expect(new Set(inputRows.map(({ novel_identity: id }) => id)).size).toBe(10000);
    expect(inputRows[0]).toMatchObject({
      novel_identity: expect.any(String), channel_app_id: "changdu-app", raw_language_scope: expect.any(String),
      title: expect.any(String), description: expect.any(String), raw_series_types: expect.any(Array), mapped_source_tags: expect.any(Array),
    });
    expect(inputRows.filter(({ raw_language_scope: scope }) => scope.includes('"19"') || scope.includes('"20"')).every(({ resolved_locale: locale }) => locale === null)).toBe(true);
    const b2Edges = parseCsv(await readFile(resolve(b2Dir, "mapping-candidates-final.csv"), "utf8")).filter(({ record_type: type }) => type === "MAPPING_EDGE");
    const edgeSet = new Set(b2Edges.map((row) => JSON.stringify([row.channel_app_id, row.raw_language_scope, row.exact_raw_token, row.canonical_stable_id, row.mapping_key])));
    expect(inputRows.every((row) => row.mapped_source_tags.every((tag: { exact_raw_token: string; canonical_stable_id: string; mapping_key: string }) => edgeSet.has(JSON.stringify([row.channel_app_id, row.raw_language_scope, tag.exact_raw_token, tag.canonical_stable_id, tag.mapping_key]))))).toBe(true);

    const shortfalls = JSON.parse(await readFile(resolve(c1AuthoritativeDir, "scored/audit-queue-shortfalls.json"), "utf8"));
    expect(shortfalls.shortfalls).toEqual(expect.arrayContaining([
      expect.objectContaining({ stratum: "HIGH_TAG_COUNT" }),
      expect.objectContaining({ stratum: "SOURCE_TEXT_CONFLICT_REVIEW", available: 0 }),
    ]));
  });

  it("binds the authoritative v2 closeout and browser-verified portable report by byte hash", async () => {
    const manifest = JSON.parse(await readFile(resolve(ownerFinalDir, "OWNER_FINAL_V2_MANIFEST.json"), "utf8"));
    expect(manifest).toMatchObject({
      closeout_status: "OWNER_PARAMETER_FREEZE_EVIDENCE_READY_PENDING_INDEPENDENT_C1_ADJUDICATION",
      authoritative_c1_run: "2026-08-16-owner-final-c1-v2",
      superseded_c1_run: "2026-08-16-owner-final-c1",
      fixed: { canonical_count: 123, b2_key_total: 285, c1_sample_count: 10000, auto_write_authorized: false },
    });
    for (const file of manifest.files as Array<{ path: string; bytes: number; sha256: string }>) {
      const bytes = await readFile(resolve(root, file.path));
      expect(bytes.length).toBe(file.bytes);
      expect(sha256(bytes)).toBe(file.sha256);
    }

    const reportDir = resolve(ownerFinalDir, "report");
    const artifact = JSON.parse(await readFile(resolve(reportDir, "artifact-v2.json"), "utf8"));
    const receipt = JSON.parse(await readFile(resolve(reportDir, "REPORT_DELIVERY_RECEIPT_V2.json"), "utf8"));
    const summary = JSON.parse(await readFile(resolve(c1Dir, "calibration-summary.json"), "utf8"));
    const html = await readFile(resolve(reportDir, "P2-06.5_OWNER_FINAL_REPORT_V2.html"), "utf8");
    expect(artifact).toMatchObject({
      status: "CALIBRATION_REVIEW_PENDING",
      headline: { canonical_tag_count: 123, b2_mapping_key_total: 285, c1_sample_count: 10000, c1_input_sha256: summary.c1_input_sha256 },
      c1: { status: summary.status, configurations: expect.any(Array) },
      auto_write_authorized: false,
    });
    expect(artifact.c1.configurations).toEqual(summary.configurations.map((row: { config_id: string; max_text_tags: number }) => ({
      configuration: `${row.config_id}/${row.max_text_tags}`,
      ...row,
    })));
    expect(receipt).toMatchObject({
      status: "READY_WITH_OWNER_REVIEW_REQUIRED",
      c1_run: "2026-08-16-owner-final-c1-v2",
      browser_qa: { status: "PASS", console_errors: 0, responsive_overflow: "PASS", viewports: ["1440x1000", "390x844"] },
    });
    for (const file of receipt.files as Array<{ path: string; bytes: number; sha256: string }>) {
      const bytes = await readFile(resolve(root, file.path));
      expect(bytes.length).toBe(file.bytes);
      expect(sha256(bytes)).toBe(file.sha256);
    }
    expect((html.match(/<tr>/gu) ?? [])).toHaveLength(10);
    expect(html).toContain("NONE_PENDING_C1_ADJUDICATION");
    expect(html).toContain("UNASSESSED_PENDING_INDEPENDENT_REVIEW");

    for (const path of [
      "scripts/p2-06-5-text-calibration.mjs",
      "scripts/p2-06-5-lane-c/owner-final-c1.mjs",
      "scripts/p2-06-5-owner-final-report.mjs",
    ]) {
      const source = await readFile(resolve(root, path), "utf8");
      expect(source).not.toMatch(/\bfetch\s*\(/u);
      expect(source).not.toMatch(/from\s+["'][^"']*(?:prisma|database|worker|scheduler|adapter)[^"']*["']/iu);
    }
  });
});
