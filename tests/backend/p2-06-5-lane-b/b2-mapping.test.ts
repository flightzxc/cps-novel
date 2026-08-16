import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { B2_CSV_HEADERS, REVIEW_STATUS, SCORE_WEIGHTS, buildB2ArtifactBundle, evaluationSampleCount, finalizeMappingCandidates, prepareMappingReview, validateCanonicalTagArtifact } from "../../../scripts/p2-06-5-lane-b/b2-mapping.mjs";

const canonical = { canonical_version: "v1.0.0", tags: [
  { canonical_tag_id: "ct-romance", slug: "romance", display_name: "Romance", locale_scope: "*", definition: "A central romantic relationship.", include: ["central relationship"], exclude: ["incidental romance"], status: "public" },
  { canonical_tag_id: "ct-rebirth", slug: "rebirth", display: "Rebirth", locale_scope: ["zh"], definition: "Life restarts.", include: ["life restarts"], exclude: ["flashback"], status: "draft" },
] };
const bytes = JSON.stringify(canonical); const digest = createHash("sha256").update(bytes).digest("hex");
const fullScores = { literal_meaning: 1, sample_semantic_evidence: 1, cooccurrence_evidence: 1, canonical_definition_fit: 1, filter_semantic_fit: 1 };
function samples(token: string, count = 5) { return Array.from({ length: count }, (_, index) => ({ external_book_id: `${token}-${index}`, title: `Title ${index}`, description: "Actual supporting description" })); }
function group(token: string, proposals: unknown[], frequency = 5, extras: Record<string, unknown> = {}) {
  const carriers = Array.from({ length: frequency }, (_, index) => `${token}-${index}`);
  const reviewedProposals = proposals.map((proposal) => ({
    reason: "Real-book evidence and the CanonicalTag definition support this candidate.",
    risk: "NONE_IDENTIFIED",
    ...(proposal as object),
  }));
  return { channel_app_id: "changdu-app", raw_language_scope: " 2 ", exact_raw_token: token, frequency, occurrence_count: frequency, carrier_book_ids: carriers, samples: samples(token, Math.min(frequency, 5)), proposals: reviewedProposals, ...extras };
}
const rawManifestSha256 = "b".repeat(64);
function input(source_groups: any[], final_sample_book_ids = [...new Set(source_groups.flatMap((item) => item.carrier_book_ids))]) {
  const authoritative_source_groups = source_groups.map((item) => Object.fromEntries(
    Object.entries(item).filter(([key]) => key !== "proposals" && key !== "unmapped_reason"),
  ));
  return { artifact: bytes, expectedSha256: digest, authoritative_source_groups, reviewed_source_groups: source_groups, final_sample_book_ids, raw_manifest_sha256: rawManifestSha256 };
}

describe("P2-06.5 Lane B B2 offline mapping", () => {
  it("checks actual CanonicalTag artifact bytes, supports display_name/display, and exports fixed weights", () => {
    expect(() => validateCanonicalTagArtifact({ artifact: bytes, expectedSha256: "a".repeat(64) })).toThrow(/actual artifact bytes/);
    expect(validateCanonicalTagArtifact({ artifact: bytes, expectedSha256: digest, actualSha256: digest }).tags[1].display_name).toBe("Rebirth");
    expect(SCORE_WEIGHTS).toEqual({ literal_meaning: .15, sample_semantic_evidence: .30, cooccurrence_evidence: .10, canonical_definition_fit: .30, filter_semantic_fit: .15 });
    expect(() => prepareMappingReview(input([group("bad-score", [{ canonical_tag_id: "ct-romance", target_locale: "en", scores: { ...fullScores, literal_meaning: 0.8 }, evidence: {} }])]))).toThrow(/0, 0\.25, 0\.5, 0\.75, 1/u);
  });

  it("requires a non-blank reason and risk for every proposal and accepts the explicit no-risk sentinel", () => {
    const proposal = { canonical_tag_id: "ct-romance", target_locale: "en", scores: fullScores, evidence: {} };
    expect(() => prepareMappingReview(input([group("empty-reason", [{ ...proposal, reason: "" }])]))).toThrow(/proposals\[0\]\.reason.*non-empty/u);
    expect(() => prepareMappingReview(input([group("blank-risk", [{ ...proposal, risk: "  \t" }])]))).toThrow(/proposals\[0\]\.risk.*non-blank/u);
    expect(() => prepareMappingReview(input([group("insufficient-but-invalid", [{ ...proposal, risk: "" }], 1)]))).toThrow(/proposals\[0\]\.risk.*non-empty/u);
    const result = prepareMappingReview(input([group("explicit-no-risk", [{ ...proposal, reason: "Evidence checked.", risk: "NONE_IDENTIFIED" }])]));
    expect(result.mapping_candidates[0]).toMatchObject({ reason: "Evidence checked.", risk: "NONE_IDENTIFIED" });
  });

  it("caps translation-only or conflicting-sample evidence and rejects unknown or non-boolean evidence flags", () => {
    for (const flag of ["only_translation", "sample_conflict"]) {
      const result = prepareMappingReview(input([group(flag, [{
        canonical_tag_id: "ct-romance",
        target_locale: "en",
        scores: fullScores,
        evidence: { [flag]: true },
      }])]));
      expect(result.mapping_candidates[0]).toMatchObject({
        confidence: 0.79,
        review_status: REVIEW_STATUS.HUMAN,
        evidence_flags: { [flag]: true },
      });
    }
    expect(() => prepareMappingReview(input([group("unknown-flag", [{
      canonical_tag_id: "ct-romance", target_locale: "en", scores: fullScores,
      evidence: { translation_only_typo: true },
    }])]))).toThrow(/evidence\.translation_only_typo is an unknown field/u);
    expect(() => prepareMappingReview(input([group("non-boolean-flag", [{
      canonical_tag_id: "ct-romance", target_locale: "en", scores: fullScores,
      evidence: { sample_conflict: "yes" },
    }])]))).toThrow(/evidence\.sample_conflict must be boolean/u);
  });

  it("keeps exact group identity, target canonical locale, and requires every no-proposal reason explicitly", () => {
    expect(() => prepareMappingReview(input([group("unknown", [])]))).toThrow(/explicit unmapped_reason/);
    const result = prepareMappingReview(input([group("爱情", [{ canonical_tag_id: "ct-romance", target_locale: "zh", scores: fullScores, evidence: {} }]), group("unknown", [], 5, { unmapped_reason: "SEMANTIC_UNCERTAIN" })]));
    expect(result.mapping_candidates[0]).toMatchObject({ raw_language_scope: " 2 ", exact_raw_token: "爱情", locale: "zh", review_status: REVIEW_STATUS.HIGH });
    expect(result.unmapped[0]).toMatchObject({ unmapped_reason: "SEMANTIC_UNCERTAIN", review_status: REVIEW_STATUS.HUMAN });
  });

  it("uses collision-safe identities when exact language scopes and tokens contain newlines", () => {
    const result = prepareMappingReview(input([
      group("x", [{ canonical_tag_id: "ct-romance", target_locale: "en", scores: fullScores, evidence: {} }], 5, { raw_language_scope: "lang\ntok" }),
      group("tok\nx", [{ canonical_tag_id: "ct-romance", target_locale: "en", scores: fullScores, evidence: {} }], 5, { raw_language_scope: "lang" }),
    ]));
    expect(result.groups.map((item: any) => item.group_identity)).toHaveLength(2);
    expect(new Set(result.groups.map((item: any) => item.group_identity)).size).toBe(2);
    expect(result.groups.every((item: any) => /^[a-f0-9]{64}$/u.test(item.group_identity))).toBe(true);
  });

  it("enforces evaluation samples and whole-group insufficient-sample unmapped behavior", () => {
    expect(evaluationSampleCount(3)).toBe(3); expect(evaluationSampleCount(5)).toBe(5); expect(evaluationSampleCount(100)).toBe(10);
    const tooSmall = group("small", [{ canonical_tag_id: "ct-romance", target_locale: "en", scores: fullScores, evidence: {} }], 2);
    const missingEvidence = { ...group("missing", [{ canonical_tag_id: "ct-romance", target_locale: "en", scores: fullScores, evidence: {} }], 10), samples: samples("missing", 4) };
    const result = prepareMappingReview(input([tooSmall, missingEvidence]));
    expect(result.mapping_candidates).toHaveLength(0);
    expect(result.unmapped.every((item: { unmapped_reason: string }) => item.unmapped_reason === "INSUFFICIENT_SAMPLE")).toBe(true);
    expect(() => prepareMappingReview(input([{ ...group("bad-carrier", [], 5, { unmapped_reason: "CANONICAL_GAP" }), carrier_book_ids: ["one"] }]))).toThrow(/frequency must equal/);
    const duplicateEvidence = group("duplicate-evidence", [{ canonical_tag_id: "ct-romance", target_locale: "en", scores: fullScores, evidence: {} }], 5);
    duplicateEvidence.samples = Array.from({ length: 5 }, () => duplicateEvidence.samples[0]);
    expect(() => prepareMappingReview(input([duplicateEvidence]))).toThrow(/distinct carrier book identities/u);
  });

  it("caps frequency 3-4 below high confidence, scores 1:N edges separately, and gates fanout above three", () => {
    const three = { ...group("three", [{ canonical_tag_id: "ct-romance", target_locale: "en", scores: fullScores, evidence: {} }], 3), samples: samples("three", 3) };
    const result = prepareMappingReview(input([three]));
    expect(result.mapping_candidates[0]).toMatchObject({ confidence: .949, review_status: REVIEW_STATUS.RECOMMENDED });
    const expanded: any = { ...canonical, tags: [...canonical.tags, ...["a", "b", "c"].map((id) => ({ canonical_tag_id: `ct-${id}`, slug: id, display_name: id, locale_scope: "*", definition: id, include: [id], exclude: [`not ${id}`], status: "draft" }))] };
    const expandedBytes = JSON.stringify(expanded); const expandedDigest = createHash("sha256").update(expandedBytes).digest("hex");
    // The 1:N fixture must respect every target CanonicalTag's declared scope:
    // ct-rebirth is zh-only, while the remaining fixture tags are global.
    const proposals = expanded.tags.map((tag: any) => ({ canonical_tag_id: tag.canonical_tag_id, target_locale: tag.locale_scope === "*" ? "en" : tag.locale_scope[0], scores: tag.canonical_tag_id === "ct-romance" ? fullScores : { ...fullScores, filter_semantic_fit: 0.75 }, evidence: {} }));
    const wideInput = input([group("compound", proposals, 5)]);
    const wide = prepareMappingReview({ ...wideInput, artifact: expandedBytes, expectedSha256: expandedDigest });
    expect(wide.mapping_candidates).toHaveLength(5);
    expect(wide.groups[0]).toMatchObject({ fanout: 5, group_status: REVIEW_STATUS.HUMAN, group_min_confidence: .9625 });
    expect(wide.fanout[0]).toMatchObject({ source_scope: "changdu-app", raw_language_scope: " 2 ", exact_raw_token: "compound", frequency: 5, group_status: REVIEW_STATUS.HUMAN });
  });

  it("summarizes statuses by group and makes the human package group-complete, then lets second blind review close or escalate only recommended groups", () => {
    const result = prepareMappingReview(input([
      group("high", [{ canonical_tag_id: "ct-romance", target_locale: "en", scores: fullScores, evidence: {} }]),
      { ...group("recommended", [{ canonical_tag_id: "ct-romance", target_locale: "en", scores: fullScores, evidence: {} }], 3), samples: samples("recommended", 3) },
      group("gap", [], 5, { unmapped_reason: "CANONICAL_GAP" }),
    ]));
    expect(result.summary).toMatchObject({ TOTAL_SOURCE_TOKENS: 3, HIGH_CONFIDENCE_MAPPING: 1, REVIEW_RECOMMENDED: 1, CANONICAL_GAP: 1 });
    expect(result.summary).toMatchObject({ MAPPING_COVERAGE_BY_BOOK: .6154, BOOK_COVERAGE_ALL_TOKENS_STRICT: .6154, BOOK_COVERAGE_AT_LEAST_ONE_TOKEN: .6154, MAPPING_COVERAGE_BY_OCCURRENCE: .6154, LANE_B_MAPPING_STATUS: "PARTIAL_REVIEW_PENDING", OWNER_REVIEW_ITEMS: 3 });
    expect(result.human_review_package).toHaveLength(3);
    expect(result.review_template).toHaveLength(1);
    expect(result.review_template[0]).toMatchObject({ group_identity: result.groups[1].group_identity, current_group_status: REVIEW_STATUS.RECOMMENDED });
    const record: any = { ...result.review_template[0], decision: "CLOSE_RECOMMENDED", reviewer: "owner", rationale: "blind samples checked", blind_evidence_reference: "packet-7" };
    const final = finalizeMappingCandidates({ prepared: result, blind_review_records: [record] } as any);
    expect(final.groups.find((item: any) => item.exact_raw_token === "recommended")).toMatchObject({ group_status: REVIEW_STATUS.RECOMMENDED, review_closed: true });
    expect(final.human_review_package.map((item: any) => item.exact_raw_token).filter(Boolean)).toEqual(["gap"]);
    expect(final.review_template).toEqual([]);
    expect(final.summary).toMatchObject({ REVIEW_RECOMMENDED: 1, REVIEW_CLOSED_OFFLINE: 1 });
    expect(() => finalizeMappingCandidates({ prepared: result, blind_review_records: [{ ...record, group_identity: result.groups[0].group_identity }] } as any)).toThrow(/only resolve.*REVIEW_RECOMMENDED/);
  });

  it("closes an automatic shared-CanonicalTag cluster when every non-high member review closes", () => {
    const prepared = prepareMappingReview(input([
      group("high-shared", [{ canonical_tag_id: "ct-romance", target_locale: "en", scores: fullScores, evidence: {} }]),
      group("recommended-shared", [{ canonical_tag_id: "ct-romance", target_locale: "en", scores: { ...fullScores, literal_meaning: 0 }, evidence: {} }]),
    ]));
    expect(prepared.summary).toMatchObject({ LANE_B_MAPPING_STATUS: "PARTIAL_REVIEW_PENDING", OWNER_REVIEW_ITEMS: 2 });
    const record: any = {
      ...prepared.review_template[0],
      decision: "CLOSE_RECOMMENDED",
      reviewer: "owner",
      rationale: "Independent evidence review is consistent.",
      blind_evidence_reference: "packet-shared-1",
    };
    const final = finalizeMappingCandidates({ prepared, blind_review_records: [record] } as any);
    expect(final.semantic_clusters[0]).toMatchObject({
      cluster_origin: "SHARED_CANONICAL_MAPPING",
      review_status: REVIEW_STATUS.RECOMMENDED,
      review_closed: true,
      needs_human_review: false,
    });
    expect(final.human_review_package).toEqual([]);
    expect(final.summary).toMatchObject({
      LANE_B_MAPPING_STATUS: "COMPLETE_CANDIDATES_GENERATED",
      OWNER_REVIEW_ITEMS: 0,
    });
  });

  it("puts only open REVIEW_RECOMMENDED groups in the blind-review template", () => {
    const result = prepareMappingReview(input([
      group("recommended-only", [{ canonical_tag_id: "ct-romance", target_locale: "en", scores: { ...fullScores, literal_meaning: 0 }, evidence: {} }]),
      group("human-only", [{ canonical_tag_id: "ct-romance", target_locale: "en", scores: fullScores, evidence: { only_lexical: true } }]),
      group("gap-only", [], 5, { unmapped_reason: "CANONICAL_GAP" }),
    ]));
    const recommended = result.groups.find((item: any) => item.exact_raw_token === "recommended-only");
    expect(result.review_template.map((item: any) => item.group_identity)).toEqual([recommended.group_identity]);
    expect(result.review_template.every((item: any) => item.current_group_status === REVIEW_STATUS.RECOMMENDED)).toBe(true);
  });

  it("keeps the human package to its explicit gate, counts unique groups, and retains exact-token evidence and book-union coverage", () => {
    const result = prepareMappingReview(input([
      group("high", [{ canonical_tag_id: "ct-romance", target_locale: "en", scores: fullScores, evidence: {} }]),
      group("semantic", [], 5, { unmapped_reason: "SEMANTIC_UNCERTAIN" }),
      group("gap", [], 5, { unmapped_reason: "CANONICAL_GAP" }),
      group("low", [], 5, { unmapped_reason: "LOW_VALUE_SOURCE_TAG" }),
      group("insufficient", [{ canonical_tag_id: "ct-romance", target_locale: "en", scores: fullScores, evidence: {} }], 2),
    ]));
    expect(result.human_review_package.map((item: any) => item.exact_raw_token)).toEqual(["semantic", "gap"]);
    expect(result.unmapped.find((item: any) => item.exact_raw_token === "low")).toMatchObject({
      unmapped_reason: "LOW_VALUE_SOURCE_TAG",
      review_status: "LOW_VALUE_SOURCE_TAG",
    });
    expect(result.unmapped.find((item: any) => item.exact_raw_token === "insufficient")).toMatchObject({
      unmapped_reason: "INSUFFICIENT_SAMPLE",
      review_status: "INSUFFICIENT_SAMPLE",
    });
    expect(result.summary).toMatchObject({ OWNER_REVIEW_ITEMS: 2, LANE_B_MAPPING_STATUS: "PARTIAL_REVIEW_PENDING", BOOK_COVERAGE_ALL_TOKENS_STRICT: .2273, BOOK_COVERAGE_AT_LEAST_ONE_TOKEN: .2273 });
    const semantic = result.human_review_package[0];
    expect(Buffer.from(semantic.exact_raw_token_utf8_base64, "base64").toString("utf8")).toBe("semantic");
    expect(createHash("sha256").update("semantic", "utf8").digest("hex")).toBe(semantic.exact_raw_token_sha256);
  });

  it("binds immutable evidence and counts zero-token final books in both book coverage denominators", () => {
    const reviewed = group("high", [{ canonical_tag_id: "ct-romance", target_locale: "en", scores: fullScores, evidence: {} }]);
    const result = prepareMappingReview(input([reviewed], [...reviewed.carrier_book_ids, "zero-token-book"]));
    expect(result.summary).toMatchObject({ MAPPING_COVERAGE_BY_BOOK: .8333, BOOK_COVERAGE_ALL_TOKENS_STRICT: .8333, BOOK_COVERAGE_AT_LEAST_ONE_TOKEN: .8333 });
    expect(result).toMatchObject({ raw_manifest_sha256: rawManifestSha256, source_evidence_sha256: expect.stringMatching(/^[a-f0-9]{64}$/) });

    const tampered = { ...reviewed, frequency: 4 };
    expect(() => prepareMappingReview({ ...input([reviewed]), reviewed_source_groups: [tampered] })).toThrow(/does not exactly match|differs from authoritative/u);
    expect(() => prepareMappingReview(input([reviewed], ["some-other-book"]))).toThrow(/outside final_sample_book_ids/u);
  });

  it("builds required exact B2 deliverables with per-token UTF-8 base64 and SHA-256", () => {
    const result = prepareMappingReview(input([group("爱情", [{ canonical_tag_id: "ct-romance", target_locale: "en", scores: fullScores, evidence: {} }])]));
    const bundle = buildB2ArtifactBundle(result);
    const mappingCsv = bundle.files.find((item: any) => item.name === "mapping-candidates.csv");
    expect(mappingCsv?.content).toContain("exact_raw_token");
    expect(mappingCsv?.content).toContain("exact_raw_token_utf8_base64");
    expect(createHash("sha256").update(Buffer.from(mappingCsv!.bytes_base64, "base64")).digest("hex")).toBe(mappingCsv?.sha256);
    expect(bundle.manifest.files.map((item: any) => item.name)).toEqual([
      "mapping-candidates.csv", "unmapped-source-tokens.csv", "source-token-semantic-clusters.csv", "source-token-semantic-cluster-pairs.csv", "source-token-fanout-risk.csv", "human-review-package.jsonl", "lane-b-summary.json", "review-template.jsonl", "authoritative-mapping-candidates.jsonl",
    ]);
  });

  it("emits all five CSV schemas even when every table is empty", () => {
    const result = prepareMappingReview(input([], []));
    const bundle = buildB2ArtifactBundle(result);
    for (const [name, headers] of Object.entries(B2_CSV_HEADERS)) {
      expect(bundle.files.find((item: any) => item.name === name)?.content).toBe(`${headers.join(",")}\n`);
    }
  });

  it("keeps semantic pair evidence scoped by exact source plus raw language identity", () => {
    const sameBooks = ["book-1", "book-2", "book-3", "book-4", "book-5"];
    const sameScopeLeft = group("恋爱", [{ canonical_tag_id: "ct-romance", target_locale: "zh", scores: fullScores, evidence: {} }]);
    sameScopeLeft.carrier_book_ids = sameBooks;
    sameScopeLeft.samples = sameBooks.map((external_book_id) => ({ external_book_id, title: "title", description: "description" }));
    const sameScopeRight = group("爱情", [{ canonical_tag_id: "ct-romance", target_locale: "zh", scores: fullScores, evidence: {} }]);
    sameScopeRight.carrier_book_ids = sameBooks;
    sameScopeRight.samples = sameBooks.map((external_book_id) => ({ external_book_id, title: "title", description: "description" }));
    const crossLanguage = group("romance", [{ canonical_tag_id: "ct-romance", target_locale: "en", scores: fullScores, evidence: {} }], 5, { raw_language_scope: "english-scope" });
    const result = prepareMappingReview(input([sameScopeLeft, sameScopeRight, crossLanguage]));
    const samePair = result.semantic_pairs.find((pair: any) => pair.left_raw_language_scope === pair.right_raw_language_scope);
    const crossPair = result.semantic_pairs.find((pair: any) => pair.left_raw_language_scope !== pair.right_raw_language_scope);
    expect(samePair).toMatchObject({ evidence_scope_status: "SAME_SOURCE_LANGUAGE_SCOPE", shared_sample_books: 5, sample_jaccard: 1 });
    expect(crossPair).toMatchObject({
      evidence_scope_status: "NOT_APPLICABLE_CROSS_LANGUAGE_SCOPE",
      shared_sample_books: null,
      sample_jaccard: null,
      left_to_right_cooccurrence_rate: null,
      right_to_left_cooccurrence_rate: null,
    });
  });

  it("accepts explicit offline semantic clusters containing mapped and unmapped source-group FKs", () => {
    const mapped = group("霸总", [{ canonical_tag_id: "ct-romance", target_locale: "zh", scores: fullScores, evidence: {} }]);
    const unmapped = group("强势老板", [], 5, { unmapped_reason: "SEMANTIC_UNCERTAIN" });
    const base = input([mapped, unmapped]);
    const initial = prepareMappingReview(base);
    const semantic_cluster_candidates = [{
      cluster_id: "offline-霸总",
      canonical_tag_id: null,
      recommendation: "UNDECIDED",
      confidence: 0.75,
      review_status: "HUMAN_REVIEW_REQUIRED",
      reason: "Lexically related, but real-book evidence is not yet conclusive.",
      risk: "Could conflate an archetype with an occupation.",
      members: initial.groups.map(({ group_identity }: any) => ({ group_identity })),
    }];
    const result = prepareMappingReview({ ...base, semantic_cluster_candidates });
    expect(result.semantic_clusters).toEqual(expect.arrayContaining([
      expect.objectContaining({ cluster_id: "offline-霸总", cluster_origin: "OFFLINE_SEMANTIC_CANDIDATE", recommendation: "UNDECIDED" }),
    ]));
    const cluster = result.semantic_clusters.find((item: any) => item.cluster_id === "offline-霸总");
    expect(cluster.members).toEqual(expect.arrayContaining([
      expect.objectContaining({ exact_raw_token: "霸总", mapped: true }),
      expect.objectContaining({ exact_raw_token: "强势老板", mapped: false, unmapped_reason: "SEMANTIC_UNCERTAIN" }),
    ]));
    expect(result).toMatchObject({ semantic_cluster_candidates_sha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(result.human_review_package).toEqual(expect.arrayContaining([
      expect.objectContaining({ review_item_type: "SEMANTIC_CLUSTER", review_item_id: "offline-霸总" }),
    ]));
    expect(result.summary.OWNER_REVIEW_ITEMS).toBe(2);
    expect(buildB2ArtifactBundle(result).manifest.semantic_cluster_candidates_sha256).toBe(result.semantic_cluster_candidates_sha256);
    expect(() => prepareMappingReview({
      ...base,
      semantic_cluster_candidates: [{ ...semantic_cluster_candidates[0], members: [{ group_identity: "0".repeat(64) }, semantic_cluster_candidates[0].members[1]] }],
    })).toThrow(/source-group FK/u);
    expect(() => prepareMappingReview({
      ...base,
      semantic_cluster_candidates: [{ ...semantic_cluster_candidates[0], canonical_tag_id: "missing-tag" }],
    })).toThrow(/non-deprecated CanonicalTag/u);
    expect(() => prepareMappingReview({
      ...base,
      semantic_cluster_candidates: [{ ...semantic_cluster_candidates[0], confidence: 0.5, review_status: "HIGH_CONFIDENCE_MAPPING" }],
    })).toThrow(/must match confidence threshold/u);
    expect(() => prepareMappingReview({
      ...base,
      semantic_cluster_candidates: [{ ...semantic_cluster_candidates[0], risk: " \t " }],
    })).toThrow(/risk.*non-blank/u);
    expect(() => prepareMappingReview({
      ...base,
      semantic_cluster_candidates: [{ ...semantic_cluster_candidates[0], unexpected_decision: true }],
    })).toThrow(/unexpected_decision is an unknown field/u);
    expect(() => prepareMappingReview({
      ...base,
      semantic_cluster_candidates: [{
        ...semantic_cluster_candidates[0],
        members: [{ ...semantic_cluster_candidates[0].members[0], extra: true }, semantic_cluster_candidates[0].members[1]],
      }],
    })).toThrow(/members\[0\]\.extra is an unknown field/u);
  });

  it("uses the least-safe mapped-group status for shared CanonicalTag clusters", () => {
    const result = prepareMappingReview(input([
      group("high", [{ canonical_tag_id: "ct-romance", target_locale: "en", scores: fullScores, evidence: {} }]),
      group("recommended", [{ canonical_tag_id: "ct-romance", target_locale: "en", scores: { ...fullScores, literal_meaning: 0 }, evidence: {} }]),
    ]));
    expect(result.semantic_clusters[0]).toMatchObject({
      cluster_origin: "SHARED_CANONICAL_MAPPING",
      review_status: "REVIEW_RECOMMENDED",
      needs_human_review: true,
    });
  });
});
