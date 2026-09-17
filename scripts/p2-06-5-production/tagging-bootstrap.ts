/**
 * P2-06.5 CanonicalTag v1 bootstrap — the "explicit bootstrap CLI" half of
 * ADR-P2-06-5-TAGGING-V3 §12 ("schema migration + explicit bootstrap CLI").
 *
 * The migration that shipped `canonical_tag` and friends is additive-only and
 * carries no seed data (§12.1). Before this script, nothing in the repository
 * could put the 123 CanonicalTag v1 rows, their zh translations, their
 * deterministic keyword lexicon, or the 196 approved Changdu source-label
 * mapping edges into a real database — `mutateAdminCanonicalTag` only ever
 * updates an existing row (`src/server/tagging/admin-service.ts`), and the
 * only `canonicalTag.create` call in the repository lived in a Postgres
 * integration test fixture. That left the public `/category/[slug]` chain
 * unexercisable in UAT: PR #6 review finding B-3.
 *
 * This CLI is deliberately outside the `mutateAdmin*` semantic layer — the
 * ADR calls bootstrap an "authority plane" operation, not an admin HTTP
 * mutation, so it never touches `requireFreshAdminServiceMutation`, never
 * fabricates an admin session/2FA context, and writes its own
 * `OperationAudit` row directly (mirroring `scripts/bootstrap-admin-identity.ts`).
 *
 * Two authoritative, hash-pinned source files drive every write:
 *  - CanonicalTag v1 Final (123 tags, translations, aliases, keyword seeds):
 *    `docs/p2/p2-06-5-lane-a/canonical-tag-v1-final/2026-08-16/canonical-tag-v1.0.0-final.json`
 *    SHA-256 `8bc8cdae8be2176bde170173e98bad2b9fa0e1770818174a57320816eefdccad`
 *    (same constant the runtime classifier already pins as
 *    `CANONICAL_TAG_V1_SHA256` in `src/lib/tagging/keyword-artifact.ts`).
 *  - B2 Owner Final mapping candidates (285 keys total; 194 approved groups /
 *    196 approved executable edges after filtering to
 *    `record_type=MAPPING_EDGE` + `final_disposition=APPROVED_MAP_CANDIDATE`):
 *    `docs/p2/p2-06-5-lane-b/b2-owner-final/2026-08-16/mapping-candidates-final.csv`
 *    SHA-256 `140057fea8e09980ab465c4eb780e228d07d69dab37d54bbab312da9cab82c38`
 *    (declared by `B2_FINAL_MANIFEST.json`).
 *
 * The keyword lexicon written to `canonical_tag_keyword` is derived from each
 * tag's `keyword_seeds`, applying the exact same three filters the Lane C
 * calibration pipeline (`scripts/p2-06-5-lane-c/owner-final-c1.mjs`
 * `buildLexicon`) and the runtime reader (`loadKeywordRuleArtifactFromDb` in
 * `src/server/tagging/auto-classification.ts`) already agree on:
 *   1. a seed whose normalized form is used by more than one CanonicalTag is
 *      dropped everywhere (`CROSS_TAG_SEED_COLLISION`);
 *   2. a seed whose script is neither purely Latin nor purely CJK is dropped
 *      (`KEYWORD_COVERAGE_INSUFFICIENT_OTHER_SCRIPT`);
 *   3. a seed the frozen `keyword-eligibility-v2` overlay disables
 *      (`enabled: false`) is never written — the runtime applies that same
 *      overlay by seed value at *read* time
 *      (`applyKeywordEligibilityAuthority`), so a disabled seed sitting in
 *      the database would be filtered right back out; omitting it up front
 *      keeps the stored "active keyword" count meaningful. Restricted
 *      (`allowedFields`) overlay entries are *not* baked in here — the
 *      schema has no column for that, and the runtime re-applies the overlay
 *      on every read, so the database only ever holds the base seed.
 *
 * Idempotency has two independent layers, matching every other bootstrap CLI
 * in this repository (`bootstrap-admin-identity.ts`,
 * `mutateAdminCanonicalTag`): a literal re-run with the same `--request-id`
 * is a pure replay (finds the committed `OperationAudit` row, writes
 * nothing); a re-run with a *different* request id still upserts by each
 * table's natural unique key (`stableId`, `(canonicalTagId, locale)`,
 * `keywordId`, the mapping edge key), so unchanged source data never
 * duplicates or corrupts a row.
 *
 * Usage:
 *   npx tsx scripts/p2-06-5-production/tagging-bootstrap.ts \
 *     --request-id <stable-request-id> \
 *     --reason "<change ticket/reason>" \
 *     --channel-app changdu-app=<ChannelApp UUID>
 *
 *   npx tsx scripts/p2-06-5-production/tagging-bootstrap.ts \
 *     --request-id <same-stable-request-id> \
 *     --reason "<same change ticket/reason>" \
 *     --channel-app changdu-app=<ChannelApp UUID> \
 *     --approver <adminIdentity UUID or username> \
 *     --apply
 *
 * `--channel-app` binds the mapping file's symbolic `changdu-app` identifier
 * to a real `ChannelApp` row. Per ADR §12 step 3 this must be supplied
 * explicitly by the operator — the CLI never guesses a "unique candidate" by
 * name. Both dry-run and apply validate the bound UUID resolves to an
 * active `ChannelApp` row; dry-run performs read-only queries only.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Prisma, PrismaClient, type PrismaClient as PrismaClientType } from "@prisma/client";

import {
  CANONICAL_TAG_V1_COUNT,
  CANONICAL_TAG_V1_SHA256,
  type TagKeywordMatchMode,
  type TagKeywordScriptBucket,
} from "../../src/lib/tagging/keyword-artifact";
import {
  loadKeywordEligibilityAuthority,
  normalizeKeywordEligibilitySeed,
  type KeywordEligibilityAuthority,
} from "../../src/lib/tagging/keyword-eligibility";

// ---------------------------------------------------------------------------
// Pinned authority identity
// ---------------------------------------------------------------------------

export const TAGGING_BOOTSTRAP_AUDIT_ACTION = "canonical_tag.bootstrap";
export const TAGGING_BOOTSTRAP_ADVISORY_LOCK_NAMESPACE = "p2-06-5:canonical-taxonomy-bootstrap";

/** Opaque taxonomy/lexicon version tags stored on every bootstrapped row. */
export const TAGGING_BOOTSTRAP_TAXONOMY_VERSION = "canonical-tag-v1";
export const TAGGING_BOOTSTRAP_KEYWORD_LEXICON_VERSION = "canonical-tag-v1-keyword-seeds-v1";
export const TAGGING_BOOTSTRAP_MAPPING_VERSION = "p2-06-5-b2-owner-final-2026-08-16";

export const CANONICAL_ARTIFACT_RELATIVE_PATH =
  "docs/p2/p2-06-5-lane-a/canonical-tag-v1-final/2026-08-16/canonical-tag-v1.0.0-final.json";
/** Reuses the constant the runtime classifier already pins — one source of truth. */
export const CANONICAL_ARTIFACT_SHA256 = CANONICAL_TAG_V1_SHA256;
export const CANONICAL_ARTIFACT_EXPECTED_COUNT = CANONICAL_TAG_V1_COUNT;

export const MAPPING_ARTIFACT_RELATIVE_PATH =
  "docs/p2/p2-06-5-lane-b/b2-owner-final/2026-08-16/mapping-candidates-final.csv";
export const MAPPING_ARTIFACT_SHA256 = "140057fea8e09980ab465c4eb780e228d07d69dab37d54bbab312da9cab82c38";
/** Informational only (DEFER + IGNORE_DROP + GAP are not in this file). Source: B2_FINAL_MANIFEST.json. */
export const MAPPING_ARTIFACT_TOTAL_KEY_COUNT = 285;
export const MAPPING_ARTIFACT_APPROVED_GROUP_COUNT = 194;
export const MAPPING_ARTIFACT_APPROVED_EDGE_COUNT = 196;

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type TaggingBootstrapErrorCode =
  | "argument_missing"
  | "argument_value_missing"
  | "alias_collision"
  | "approver_inactive"
  | "approver_not_found"
  | "artifact_invariant_violation"
  | "channel_app_binding_missing"
  | "channel_app_binding_invalid"
  | "channel_app_not_found"
  | "invalid_channel_app_flag"
  | "invalid_reason"
  | "invalid_request_id"
  | "sha256_mismatch"
  | "request_id_conflict";

export class TaggingBootstrapError extends Error {
  constructor(readonly code: TaggingBootstrapErrorCode, message: string) {
    super(message);
    this.name = "TaggingBootstrapError";
  }
}

function fail(code: TaggingBootstrapErrorCode, message: string): never {
  throw new TaggingBootstrapError(code, message);
}

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

export type TaggingBootstrapCliOptions = Readonly<{
  requestId: string;
  reason: string;
  channelAppBinding: Readonly<Record<string, string>>;
  approver: string | null;
  apply: boolean;
}>;

function argValue(argv: readonly string[], index: number, flag: string): string {
  const next = argv[index + 1];
  if (next === undefined || next.startsWith("--")) {
    throw new TaggingBootstrapError("argument_value_missing", `${flag} requires a value`);
  }
  return next;
}

function boundedText(value: string | undefined, field: string, maxLength: number, code: TaggingBootstrapErrorCode): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized || normalized.length > maxLength) fail(code, `${field} must contain 1-${maxLength} characters`);
  return normalized;
}

export function parseTaggingBootstrapCliOptions(argv: readonly string[]): TaggingBootstrapCliOptions {
  let requestId: string | undefined;
  let reason: string | undefined;
  let approver: string | undefined;
  let apply = false;
  const channelAppBinding: Record<string, string> = {};

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--request-id") { requestId = argValue(argv, index, flag); index += 1; }
    else if (flag === "--reason") { reason = argValue(argv, index, flag); index += 1; }
    else if (flag === "--approver") { approver = argValue(argv, index, flag); index += 1; }
    else if (flag === "--apply") apply = true;
    else if (flag === "--channel-app") {
      const raw = argValue(argv, index, flag);
      index += 1;
      const separator = raw.indexOf("=");
      if (separator <= 0 || separator === raw.length - 1) {
        fail("invalid_channel_app_flag", "--channel-app must be <symbol>=<ChannelApp UUID>");
      }
      const symbol = raw.slice(0, separator).trim();
      const uuid = raw.slice(separator + 1).trim();
      if (!symbol || !UUID_PATTERN.test(uuid)) {
        fail("invalid_channel_app_flag", "--channel-app must be <symbol>=<ChannelApp UUID>");
      }
      channelAppBinding[symbol] = uuid.toLowerCase();
    } else {
      throw new TaggingBootstrapError("argument_missing", `Unknown argument: ${flag}`);
    }
  }

  if (requestId === undefined) fail("argument_missing", "--request-id is required");
  if (reason === undefined) fail("argument_missing", "--reason is required");
  if (apply && (approver === undefined || approver.trim().length === 0)) {
    fail("argument_missing", "--approver is required for --apply");
  }

  return Object.freeze({
    requestId: boundedText(requestId, "requestId", 160, "invalid_request_id"),
    reason: boundedText(reason, "reason", 2_000, "invalid_reason"),
    channelAppBinding: Object.freeze({ ...channelAppBinding }),
    approver: approver === undefined ? null : boundedText(approver, "approver", 160, "argument_missing"),
    apply,
  });
}

// ---------------------------------------------------------------------------
// Canonical artifact parsing (pure — no disk I/O)
// ---------------------------------------------------------------------------

interface RawCanonicalTranslation { locale: unknown; display_name: unknown }
interface RawCanonicalTag {
  stable_id: unknown;
  slug: unknown;
  canonical_definition: unknown;
  translations: unknown;
  aliases: unknown;
  keyword_seeds: unknown;
  facet: unknown;
  status: unknown;
}
interface RawCanonicalArtifact {
  schema_version: unknown;
  artifact_status: unknown;
  count: unknown;
  tags: unknown;
  qa: unknown;
}

export interface PlannedTranslation { locale: string; displayName: string }
export interface PlannedKeyword {
  keywordId: string;
  value: string;
  scriptBuckets: [TagKeywordScriptBucket];
  matchMode: TagKeywordMatchMode;
}
export interface PlannedCanonicalTag {
  stableId: string;
  slug: string;
  canonicalDefinition: string;
  aliases: string[];
  facet: string | null;
  sortOrder: number;
  translations: PlannedTranslation[];
  keywords: PlannedKeyword[];
}

export interface CanonicalPlan {
  tags: PlannedCanonicalTag[];
  canonicalCount: number;
  translationCount: number;
  aliasCount: number;
  keywordCount: number;
  skipped: { collision: number; otherScript: number; overlayDisabled: number };
}

const KNOWN_FACETS = new Set(["topic", "maturity", "setting", "audience", "ending"]);
const CJK_SCRIPT = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const LATIN_SCRIPT = /\p{Script=Latin}/u;
const ANY_LETTER = /\p{L}/u;

function seedScript(value: string): TagKeywordScriptBucket | "other" {
  let hasCjk = false; let hasLatin = false; let hasOther = false;
  for (const character of value.normalize("NFC")) {
    if (CJK_SCRIPT.test(character)) hasCjk = true;
    else if (LATIN_SCRIPT.test(character)) hasLatin = true;
    else if (ANY_LETTER.test(character)) hasOther = true;
  }
  if (hasCjk && !hasLatin && !hasOther) return "cjk";
  if (hasLatin && !hasCjk && !hasOther) return "latin";
  return "other";
}

function deterministicKeywordId(stableId: string, normalizedSeed: string): string {
  const digest = createHash("sha256").update(JSON.stringify([stableId, normalizedSeed])).digest("hex");
  return `kw-${digest.slice(0, 24)}`;
}

function stringArrayField(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.length === 0)) {
    fail("artifact_invariant_violation", `${field} must be a non-empty string array`);
  }
  return value as string[];
}

/** Parses and validates the CanonicalTag v1 Final JSON text. Pure — no disk I/O. */
export function parseCanonicalArtifact(raw: string): RawCanonicalArtifact {
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object") fail("artifact_invariant_violation", "canonical artifact must be a JSON object");
  const artifact = parsed as RawCanonicalArtifact;
  if (artifact.schema_version !== 2 || artifact.artifact_status !== "FINAL") {
    fail("artifact_invariant_violation", "canonical artifact must be schema_version 2, status FINAL");
  }
  if (artifact.count !== CANONICAL_ARTIFACT_EXPECTED_COUNT || !Array.isArray(artifact.tags) || artifact.tags.length !== CANONICAL_ARTIFACT_EXPECTED_COUNT) {
    fail("artifact_invariant_violation", `canonical artifact must contain exactly ${CANONICAL_ARTIFACT_EXPECTED_COUNT} tags`);
  }
  return artifact;
}

/**
 * Builds the full write plan (tags + translations + keywords) from an
 * already-parsed, already hash-verified canonical artifact. Pure — every
 * input is a plain value, so this is directly unit-testable with small
 * fixtures instead of the real 123-tag file.
 */
export function buildCanonicalPlan(
  artifact: RawCanonicalArtifact,
  eligibility: KeywordEligibilityAuthority = loadKeywordEligibilityAuthority(),
): CanonicalPlan {
  const rawTags = artifact.tags as RawCanonicalTag[];

  // Pass 1: cross-tag seed collisions (global, before per-tag filtering).
  const occurrences = new Map<string, Set<string>>();
  for (const rawTag of rawTags) {
    const stableId = String(rawTag.stable_id);
    const seeds = stringArrayField(rawTag.keyword_seeds, `${stableId}.keyword_seeds`);
    for (const seed of seeds) {
      const key = normalizeKeywordEligibilitySeed(seed);
      const owners = occurrences.get(key) ?? new Set<string>();
      owners.add(stableId);
      occurrences.set(key, owners);
    }
  }
  const collisions = new Set([...occurrences].filter(([, owners]) => owners.size > 1).map(([key]) => key));

  const overlayByKey = new Map(eligibility.rules.map((rule) => [`${rule.canonicalTagId}\n${rule.normalizedSeed}`, rule]));
  const skipped = { collision: 0, otherScript: 0, overlayDisabled: 0 };
  const seenStableIds = new Set<string>();
  const seenSlugs = new Set<string>();
  let translationCount = 0;
  let aliasCount = 0;
  let keywordCount = 0;

  // Cross-tag alias/stableId/slug collisions only — a tag's own alias
  // repeating its own slug or stableId (e.g. slug "adventure" also listed as
  // an alias, for keyword-seed convenience) is normal and not a collision;
  // `mutateAdminCanonicalTag`'s `replace_aliases` checks the same way (an
  // alias against every *other* tag's identity set, never its own).
  const identityOwners = new Map<string, Set<string>>();
  for (const rawTag of rawTags) {
    const tagStableId = String(rawTag.stable_id);
    const tagAliases = stringArrayField(rawTag.aliases, `${tagStableId}.aliases`);
    for (const identity of [tagStableId, String(rawTag.slug), ...tagAliases]) {
      const owners = identityOwners.get(identity) ?? new Set<string>();
      owners.add(tagStableId);
      identityOwners.set(identity, owners);
    }
  }
  for (const [identity, owners] of identityOwners) {
    if (owners.size > 1) fail("alias_collision", `alias/stableId/slug collision across tags: ${identity}`);
  }

  const tags: PlannedCanonicalTag[] = rawTags.map((rawTag, index) => {
    const stableId = String(rawTag.stable_id);
    const slug = String(rawTag.slug);
    if (!stableId || !slug) fail("artifact_invariant_violation", "stable_id and slug must be non-empty");
    if (seenStableIds.has(stableId) || seenSlugs.has(slug)) {
      fail("artifact_invariant_violation", `duplicate stable_id/slug: ${stableId}`);
    }
    seenStableIds.add(stableId);
    seenSlugs.add(slug);

    const aliases = stringArrayField(rawTag.aliases, `${stableId}.aliases`);
    aliasCount += aliases.length;

    if (rawTag.status !== "public") {
      fail("artifact_invariant_violation", `${stableId} has unsupported status ${String(rawTag.status)}; only "public" is mapped to active`);
    }
    const facet = rawTag.facet === null || rawTag.facet === undefined ? null : String(rawTag.facet);
    if (facet !== null && !KNOWN_FACETS.has(facet)) {
      fail("artifact_invariant_violation", `${stableId} has unknown facet ${facet}`);
    }

    const rawTranslations = rawTag.translations as RawCanonicalTranslation[];
    if (!Array.isArray(rawTranslations) || rawTranslations.length === 0) {
      fail("artifact_invariant_violation", `${stableId} has no translations`);
    }
    const translations: PlannedTranslation[] = rawTranslations.map((translation) => {
      if (typeof translation.locale !== "string" || typeof translation.display_name !== "string" || !translation.display_name) {
        fail("artifact_invariant_violation", `${stableId} has an invalid translation entry`);
      }
      return { locale: translation.locale, displayName: translation.display_name };
    });
    translationCount += translations.length;

    const seeds = stringArrayField(rawTag.keyword_seeds, `${stableId}.keyword_seeds`);
    const seenNormalizedInTag = new Set<string>();
    const keywords: PlannedKeyword[] = [];
    for (const seed of seeds) {
      const normalized = normalizeKeywordEligibilitySeed(seed);
      if (seenNormalizedInTag.has(normalized)) continue;
      seenNormalizedInTag.add(normalized);
      if (collisions.has(normalized)) { skipped.collision += 1; continue; }
      const script = seedScript(seed);
      if (script === "other") { skipped.otherScript += 1; continue; }
      const rule = overlayByKey.get(`${stableId}\n${normalized}`);
      if (rule && !rule.enabled) { skipped.overlayDisabled += 1; continue; }
      keywords.push({
        keywordId: deterministicKeywordId(stableId, normalized),
        value: seed,
        scriptBuckets: [script],
        matchMode: script === "latin" ? "unicode_word" : "cjk_contiguous",
      });
    }
    keywordCount += keywords.length;

    return {
      stableId,
      slug,
      canonicalDefinition: String(rawTag.canonical_definition),
      aliases,
      facet,
      sortOrder: index * 10,
      translations,
      keywords,
    };
  });

  return {
    tags,
    canonicalCount: tags.length,
    translationCount,
    aliasCount,
    keywordCount,
    skipped,
  };
}

// ---------------------------------------------------------------------------
// B2 mapping artifact parsing (pure — no disk I/O)
// ---------------------------------------------------------------------------

export interface PlannedMappingEdge {
  channelAppSymbol: string;
  rawLanguageScope: string;
  rawToken: string;
  canonicalStableId: string;
}

export interface MappingPlan {
  edges: PlannedMappingEdge[];
  groupCount: number;
  edgeCount: number;
  channelAppSymbols: string[];
}

/** Minimal RFC4180 CSV parser (quoted fields, doubled-quote escaping, CRLF). */
export function parseCsv(text: string): Record<string, string>[] {
  const source = text.replace(/^\uFEFF/u, "");
  const matrix: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quoted) {
      if (character === '"' && source[index + 1] === '"') { field += '"'; index += 1; }
      else if (character === '"') quoted = false;
      else field += character;
    } else if (character === '"') quoted = true;
    else if (character === ",") { row.push(field); field = ""; }
    else if (character === "\n") { row.push(field.replace(/\r$/u, "")); matrix.push(row); row = []; field = ""; }
    else field += character;
  }
  if (quoted) fail("artifact_invariant_violation", "unterminated CSV quote in mapping artifact");
  if (field.length > 0 || row.length > 0) { row.push(field); matrix.push(row); }
  const header = matrix.shift();
  if (!header?.length) fail("artifact_invariant_violation", "mapping artifact CSV is empty");
  return matrix
    .filter((cells) => cells.some((cell) => cell.length > 0))
    .map((cells) => Object.fromEntries(header.map((name, index) => [name, cells[index] ?? ""])));
}

/**
 * Filters the B2 mapping candidates CSV down to the approved, executable
 * edges and builds the write plan. Pure — takes already-parsed CSV rows.
 */
export function buildMappingPlan(rows: readonly Record<string, string>[]): MappingPlan {
  const edgeRows = rows.filter((row) => row.record_type === "MAPPING_EDGE" && row.final_disposition === "APPROVED_MAP_CANDIDATE");
  const seenEdgeKeys = new Set<string>();
  const groupKeys = new Set<string>();
  const channelAppSymbols = new Set<string>();
  const edges: PlannedMappingEdge[] = edgeRows.map((row) => {
    const channelAppSymbol = row.channel_app_id;
    const rawLanguageScope = row.raw_language_scope;
    const rawToken = row.exact_raw_token;
    const canonicalStableId = row.canonical_stable_id;
    if (!channelAppSymbol || !rawLanguageScope || !rawToken || !canonicalStableId) {
      fail("artifact_invariant_violation", "mapping edge row is missing a required column");
    }
    let parsedScope: unknown;
    try { parsedScope = JSON.parse(rawLanguageScope); } catch { parsedScope = null; }
    if (!Array.isArray(parsedScope) || parsedScope[0] !== "RAW_LANGUAGE_SCOPE_V1") {
      fail("artifact_invariant_violation", `mapping edge has a malformed raw_language_scope: ${rawLanguageScope}`);
    }
    const edgeKey = `${channelAppSymbol}\n${rawLanguageScope}\n${rawToken}\n${canonicalStableId}`;
    if (seenEdgeKeys.has(edgeKey)) fail("artifact_invariant_violation", `duplicate mapping edge: ${edgeKey}`);
    seenEdgeKeys.add(edgeKey);
    groupKeys.add(`${channelAppSymbol}\n${rawLanguageScope}\n${rawToken}`);
    channelAppSymbols.add(channelAppSymbol);
    return { channelAppSymbol, rawLanguageScope, rawToken, canonicalStableId };
  });
  return {
    edges,
    groupCount: groupKeys.size,
    edgeCount: edges.length,
    channelAppSymbols: [...channelAppSymbols].sort(),
  };
}

// ---------------------------------------------------------------------------
// Artifact loading (impure — disk I/O + pinned hash verification)
// ---------------------------------------------------------------------------

export interface TaggingBootstrapArtifacts {
  canonical: RawCanonicalArtifact;
  canonicalSha256: string;
  mappingRows: Record<string, string>[];
  mappingSha256: string;
}

function verifySha256(buffer: Buffer, expected: string, label: string): string {
  const actual = createHash("sha256").update(buffer).digest("hex");
  if (actual !== expected) {
    fail("sha256_mismatch", `${label} SHA-256 mismatch: expected ${expected}, got ${actual}`);
  }
  return actual;
}

/**
 * Reads and hash-verifies both authority files from disk. Kept separate
 * from `runTaggingBootstrapCli` so unit tests can exercise the orchestration
 * logic against small in-memory fixtures without touching the repository's
 * real 123-tag / 196-edge files.
 */
export function loadTaggingBootstrapArtifacts(repoRoot: string = REPO_ROOT): TaggingBootstrapArtifacts {
  const canonicalBuffer = readFileSync(path.join(repoRoot, CANONICAL_ARTIFACT_RELATIVE_PATH));
  const canonicalSha256 = verifySha256(canonicalBuffer, CANONICAL_ARTIFACT_SHA256, "CanonicalTag v1 Final artifact");
  const mappingBuffer = readFileSync(path.join(repoRoot, MAPPING_ARTIFACT_RELATIVE_PATH));
  const mappingSha256 = verifySha256(mappingBuffer, MAPPING_ARTIFACT_SHA256, "B2 mapping candidates artifact");
  const mappingRows = parseCsv(mappingBuffer.toString("utf8"));

  // This 194/196 gate belongs here, not in `runTaggingBootstrapCli`: it is a
  // fact about *this specific, hash-pinned production file* (ADR §12 G3 —
  // "285/194/196"), not a generic invariant every caller must satisfy. Unit
  // tests exercise the orchestration logic with small fixtures that this
  // check would otherwise always reject.
  const mappingPlan = buildMappingPlan(mappingRows);
  if (mappingPlan.groupCount !== MAPPING_ARTIFACT_APPROVED_GROUP_COUNT || mappingPlan.edgeCount !== MAPPING_ARTIFACT_APPROVED_EDGE_COUNT) {
    fail(
      "artifact_invariant_violation",
      `B2 mapping artifact must contain ${MAPPING_ARTIFACT_APPROVED_GROUP_COUNT} approved groups / ${MAPPING_ARTIFACT_APPROVED_EDGE_COUNT} approved edges, got ${mappingPlan.groupCount}/${mappingPlan.edgeCount}`,
    );
  }

  return {
    canonical: parseCanonicalArtifact(canonicalBuffer.toString("utf8")),
    canonicalSha256,
    mappingRows,
    mappingSha256,
  };
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

type Db = Pick<PrismaClientType, "canonicalTag" | "canonicalTagTranslation" | "canonicalTagKeyword" | "sourceLabelMapping" | "channelApp" | "adminIdentity" | "operationAudit" | "$transaction">;
type Tx = Omit<Db, "$transaction">;

export interface TaggingBootstrapCounts {
  canonicalTag: number;
  canonicalTagTranslation: number;
  canonicalTagKeyword: number;
  sourceLabelMapping: number;
}

export interface TaggingBootstrapReport {
  mode: "dry-run" | "apply";
  outcome: "eligible" | "applied" | "replayed";
  requestId: string;
  wrote: boolean;
  auditId: string | null;
  canonicalV1Sha256: string;
  mappingArtifactSha256: string;
  taxonomyVersion: string;
  planned: { canonicalTag: number; canonicalTagTranslation: number; alias: number; canonicalTagKeyword: number; sourceLabelMappingGroup: number; sourceLabelMappingEdge: number };
  databaseBefore: TaggingBootstrapCounts;
  databaseAfter: TaggingBootstrapCounts | null;
  skippedKeywordSeeds: { collision: number; otherScript: number; overlayDisabled: number };
}

async function readCounts(db: Pick<Db, "canonicalTag" | "canonicalTagTranslation" | "canonicalTagKeyword" | "sourceLabelMapping">): Promise<TaggingBootstrapCounts> {
  const [canonicalTag, canonicalTagTranslation, canonicalTagKeyword, sourceLabelMapping] = await Promise.all([
    db.canonicalTag.count(),
    db.canonicalTagTranslation.count(),
    db.canonicalTagKeyword.count(),
    db.sourceLabelMapping.count(),
  ]);
  return { canonicalTag, canonicalTagTranslation, canonicalTagKeyword, sourceLabelMapping };
}

async function requireChannelAppBinding(
  db: Pick<Db, "channelApp">,
  mappingPlan: MappingPlan,
  binding: Readonly<Record<string, string>>,
): Promise<void> {
  const missingSymbols = mappingPlan.channelAppSymbols.filter((symbol) => !binding[symbol]);
  if (missingSymbols.length > 0) {
    fail("channel_app_binding_missing", `--channel-app binding is required for: ${missingSymbols.join(", ")}`);
  }
  const boundUuids = [...new Set(Object.values(binding))];
  if (boundUuids.length === 0) return;
  const rows = await db.channelApp.findMany({ where: { id: { in: boundUuids } }, select: { id: true, status: true } });
  const byId = new Map(rows.map((row) => [row.id, row]));
  for (const [symbol, uuid] of Object.entries(binding)) {
    if (!mappingPlan.channelAppSymbols.includes(symbol)) continue;
    const row = byId.get(uuid);
    if (!row) fail("channel_app_not_found", `--channel-app ${symbol}=${uuid} does not resolve to any ChannelApp row`);
    if (row.status !== "active") fail("channel_app_not_found", `--channel-app ${symbol}=${uuid} resolves to a non-active ChannelApp row`);
  }
}

type ApproverRow = { id: string; username: string; status: string };

async function resolveApprover(db: Pick<Db, "adminIdentity">, approver: string): Promise<ApproverRow> {
  const where: Prisma.AdminIdentityWhereInput = UUID_PATTERN.test(approver)
    ? { id: approver.toLowerCase() }
    : { username: approver };
  const identity = await db.adminIdentity.findFirst({ where, select: { id: true, username: true, status: true } });
  if (!identity) fail("approver_not_found", `approver ${approver} does not resolve to any admin_identity row`);
  if (identity.status !== "active") fail("approver_inactive", `approver ${approver} is not active`);
  return identity;
}

function auditSnapshot(counts: TaggingBootstrapCounts | null, extra: Record<string, unknown> = {}): Prisma.InputJsonValue {
  return { ...counts, ...extra } as Prisma.InputJsonValue;
}

async function writeCanonicalPlan(tx: Tx, plan: CanonicalPlan): Promise<Map<string, string>> {
  const idByStableId = new Map<string, string>();
  for (const tag of plan.tags) {
    const row = await tx.canonicalTag.upsert({
      where: { stableId: tag.stableId },
      create: {
        stableId: tag.stableId,
        slug: tag.slug,
        canonicalDefinition: tag.canonicalDefinition,
        aliases: tag.aliases,
        facet: tag.facet,
        status: "active",
        sortOrder: tag.sortOrder,
        taxonomyVersion: TAGGING_BOOTSTRAP_TAXONOMY_VERSION,
      },
      update: {
        slug: tag.slug,
        canonicalDefinition: tag.canonicalDefinition,
        aliases: tag.aliases,
        facet: tag.facet,
        sortOrder: tag.sortOrder,
        taxonomyVersion: TAGGING_BOOTSTRAP_TAXONOMY_VERSION,
      },
      select: { id: true },
    });
    idByStableId.set(tag.stableId, row.id);

    for (const translation of tag.translations) {
      await tx.canonicalTagTranslation.upsert({
        where: { canonicalTagId_locale: { canonicalTagId: row.id, locale: translation.locale } },
        create: { canonicalTagId: row.id, locale: translation.locale, displayName: translation.displayName },
        update: { displayName: translation.displayName },
      });
    }
    for (const keyword of tag.keywords) {
      await tx.canonicalTagKeyword.upsert({
        where: { keywordId: keyword.keywordId },
        create: {
          keywordId: keyword.keywordId,
          canonicalTagId: row.id,
          value: keyword.value,
          scriptBuckets: keyword.scriptBuckets,
          matchMode: keyword.matchMode,
          riskFlags: [],
          active: true,
          lexiconVersion: TAGGING_BOOTSTRAP_KEYWORD_LEXICON_VERSION,
        },
        update: {
          canonicalTagId: row.id,
          value: keyword.value,
          scriptBuckets: keyword.scriptBuckets,
          matchMode: keyword.matchMode,
          active: true,
          lexiconVersion: TAGGING_BOOTSTRAP_KEYWORD_LEXICON_VERSION,
        },
      });
    }
  }
  return idByStableId;
}

async function writeMappingPlan(
  tx: Tx,
  mappingPlan: MappingPlan,
  channelAppBinding: Readonly<Record<string, string>>,
  canonicalIdByStableId: Map<string, string>,
  approverId: string,
): Promise<void> {
  for (const edge of mappingPlan.edges) {
    const channelAppId = channelAppBinding[edge.channelAppSymbol];
    const canonicalTagId = canonicalIdByStableId.get(edge.canonicalStableId);
    if (!channelAppId) fail("channel_app_binding_missing", `no binding for ${edge.channelAppSymbol}`);
    if (!canonicalTagId) fail("artifact_invariant_violation", `mapping edge references unknown CanonicalTag ${edge.canonicalStableId}`);
    await tx.sourceLabelMapping.upsert({
      where: {
        channelAppId_rawLanguageScope_rawToken_canonicalTagId: {
          channelAppId,
          rawLanguageScope: edge.rawLanguageScope,
          rawToken: edge.rawToken,
          canonicalTagId,
        },
      },
      create: {
        channelAppId,
        rawLanguageScope: edge.rawLanguageScope,
        rawToken: edge.rawToken,
        canonicalTagId,
        mappingVersion: TAGGING_BOOTSTRAP_MAPPING_VERSION,
        active: true,
        approvedBy: approverId,
      },
      update: {
        mappingVersion: TAGGING_BOOTSTRAP_MAPPING_VERSION,
        active: true,
        approvedBy: approverId,
      },
    });
  }
}

export async function runTaggingBootstrapCli(
  db: Db,
  options: TaggingBootstrapCliOptions,
  artifacts: TaggingBootstrapArtifacts,
): Promise<TaggingBootstrapReport> {
  const canonicalPlan = buildCanonicalPlan(artifacts.canonical);
  const mappingPlan = buildMappingPlan(artifacts.mappingRows);

  await requireChannelAppBinding(db, mappingPlan, options.channelAppBinding);
  const databaseBefore = await readCounts(db);

  const planned = {
    canonicalTag: canonicalPlan.canonicalCount,
    canonicalTagTranslation: canonicalPlan.translationCount,
    alias: canonicalPlan.aliasCount,
    canonicalTagKeyword: canonicalPlan.keywordCount,
    sourceLabelMappingGroup: mappingPlan.groupCount,
    sourceLabelMappingEdge: mappingPlan.edgeCount,
  };

  if (!options.apply) {
    return Object.freeze({
      mode: "dry-run",
      outcome: "eligible",
      requestId: options.requestId,
      wrote: false,
      auditId: null,
      canonicalV1Sha256: artifacts.canonicalSha256,
      mappingArtifactSha256: artifacts.mappingSha256,
      taxonomyVersion: TAGGING_BOOTSTRAP_TAXONOMY_VERSION,
      planned,
      databaseBefore,
      databaseAfter: null,
      skippedKeywordSeeds: canonicalPlan.skipped,
    });
  }

  const approver = await resolveApprover(db, options.approver!);

  return db.$transaction(async (tx) => {
    await tx.$queryRaw!(Prisma.sql`
      SELECT pg_advisory_xact_lock(hashtextextended(${TAGGING_BOOTSTRAP_ADVISORY_LOCK_NAMESPACE}, 0))::text AS lock_result
    `);

    const committed = await tx.operationAudit.findFirst({
      where: { actorType: "system", action: TAGGING_BOOTSTRAP_AUDIT_ACTION, requestId: options.requestId },
      select: { id: true, actorId: true, reason: true, afterSnapshot: true },
    });
    if (committed) {
      const snapshot = committed.afterSnapshot as Record<string, unknown> | null;
      const bindingMatches = committed.actorId === approver.id
        && committed.reason === options.reason
        && snapshot?.canonicalV1Sha256 === artifacts.canonicalSha256;
      if (!bindingMatches) fail("request_id_conflict", "the request id is already committed for different bootstrap input");
      return Object.freeze({
        mode: "apply",
        outcome: "replayed",
        requestId: options.requestId,
        wrote: false,
        auditId: committed.id.toString(),
        canonicalV1Sha256: artifacts.canonicalSha256,
        mappingArtifactSha256: artifacts.mappingSha256,
        taxonomyVersion: TAGGING_BOOTSTRAP_TAXONOMY_VERSION,
        planned,
        databaseBefore,
        databaseAfter: databaseBefore,
        skippedKeywordSeeds: canonicalPlan.skipped,
      });
    }

    const canonicalIdByStableId = await writeCanonicalPlan(tx, canonicalPlan);
    await writeMappingPlan(tx, mappingPlan, options.channelAppBinding, canonicalIdByStableId, approver.id);
    const databaseAfter = await readCounts(tx);

    const audit = await tx.operationAudit.create({
      data: {
        actorType: "system",
        actorId: approver.id,
        action: TAGGING_BOOTSTRAP_AUDIT_ACTION,
        entityType: "CanonicalTag",
        entityId: TAGGING_BOOTSTRAP_TAXONOMY_VERSION,
        requestId: options.requestId,
        reason: options.reason,
        beforeSnapshot: auditSnapshot(databaseBefore),
        afterSnapshot: auditSnapshot(databaseAfter, {
          canonicalV1Sha256: artifacts.canonicalSha256,
          mappingArtifactSha256: artifacts.mappingSha256,
          taxonomyVersion: TAGGING_BOOTSTRAP_TAXONOMY_VERSION,
          requestId: options.requestId,
          reason: options.reason,
          approverUsername: approver.username,
        }),
      },
      select: { id: true },
    });

    return Object.freeze({
      mode: "apply",
      outcome: "applied",
      requestId: options.requestId,
      wrote: true,
      auditId: audit.id.toString(),
      canonicalV1Sha256: artifacts.canonicalSha256,
      mappingArtifactSha256: artifacts.mappingSha256,
      taxonomyVersion: TAGGING_BOOTSTRAP_TAXONOMY_VERSION,
      planned,
      databaseBefore,
      databaseAfter,
      skippedKeywordSeeds: canonicalPlan.skipped,
    });
  });
}

// ---------------------------------------------------------------------------
// CLI entrypoint
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const options = parseTaggingBootstrapCliOptions(process.argv.slice(2));
  const artifacts = loadTaggingBootstrapArtifacts();
  const prisma = new PrismaClient();
  try {
    const report = await runTaggingBootstrapCli(prisma, options, artifacts);
    if (report.mode === "dry-run") {
      console.log("[DRY RUN — no changes written; pass --apply --approver <adminIdentity> to bootstrap]");
    }
    console.log(JSON.stringify(report, (_key, value) => (typeof value === "bigint" ? value.toString() : value), 2));
  } finally {
    await prisma.$disconnect();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
