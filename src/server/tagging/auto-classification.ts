import { Prisma, type PrismaClient } from "@prisma/client";

import { classifyNovelText, type TagClassifierResult } from "@/lib/tagging/classifier";
import {
  loadTagClassifierConfig,
  type FrozenTagClassifierConfig,
  type TagClassifierConfig,
} from "@/lib/tagging/classifier-config";
import { TaggingError, type TagClassificationRunMetadata } from "@/lib/tagging/contracts";
import {
  CANONICAL_TAG_V1_COUNT,
  CANONICAL_TAG_V1_SHA256,
  validateKeywordRuleArtifact,
  type KeywordRuleArtifact,
  type KeywordRuleArtifactInput,
  type TagKeywordMatchMode,
  type TagKeywordScriptBucket,
} from "@/lib/tagging/keyword-artifact";
import {
  applyKeywordEligibilityAuthority,
  loadKeywordEligibilityAuthority,
} from "@/lib/tagging/keyword-eligibility";
import { fingerprint, sha256 } from "@/lib/tagging/stable-json";

import { normalizeTaggingNovelIds, TAGGING_NOVEL_IDS_MAX } from "@/lib/tagging/novel-id-scope";

type Db = PrismaClient | Prisma.TransactionClient;

interface SourceIdentityRow {
  id: string;
  channelAppId: string;
  externalBookId: string;
  sourceLocale: string | null;
  rawLanguageScope: string | null;
  channelApp: { status: string };
}

interface NovelInputRow {
  id: string;
  title: string;
  description: string;
  locale: string;
  tagState: { mode: string; currentAutoRunId: string | null } | null;
  sourceItems: SourceIdentityRow[];
}

export interface NovelClassificationSnapshot {
  novelId: string;
  title: string;
  description: string;
  locale: string;
  mode: "automatic" | "manual";
  currentAutoRunId: string | null;
  contentSha256: string;
  entityFingerprint: string;
}

export interface NovelAutoClassification {
  snapshot: NovelClassificationSnapshot;
  config: FrozenTagClassifierConfig;
  artifact: KeywordRuleArtifact;
  result: TagClassifierResult;
  runMetadata: TagClassificationRunMetadata;
}

export interface AutoClassificationDependencies {
  config?: TagClassifierConfig;
  artifact?: KeywordRuleArtifactInput;
  enforceCanonicalV1?: boolean;
}

function stringArray(value: Prisma.JsonValue, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new TaggingError("DATA_INVARIANT_VIOLATION", `${field} must be a string array`);
  }
  return value as string[];
}

export async function loadKeywordRuleArtifactFromDb(
  db: Db,
  options: { enforceCanonicalV1?: boolean } = {},
): Promise<KeywordRuleArtifact> {
  const rows = await db.canonicalTag.findMany({
    where: { status: "active" },
    orderBy: { stableId: "asc" },
    select: {
      id: true,
      stableId: true,
      taxonomyVersion: true,
      keywords: {
        where: { active: true },
        orderBy: { keywordId: "asc" },
        select: {
          keywordId: true,
          value: true,
          scriptBuckets: true,
          matchMode: true,
          riskFlags: true,
          lexiconVersion: true,
        },
      },
    },
  });
  if (options.enforceCanonicalV1 !== false && rows.length !== CANONICAL_TAG_V1_COUNT) {
    throw new TaggingError("DATA_INVARIANT_VIOLATION", `CanonicalTag v1 requires ${CANONICAL_TAG_V1_COUNT} active Tags`);
  }
  if (rows.length === 0) throw new TaggingError("DATA_INVARIANT_VIOLATION", "CanonicalTag authority is empty");
  const taxonomyVersions = new Set(rows.map((row) => row.taxonomyVersion));
  const lexiconVersions = new Set(rows.flatMap((row) => row.keywords.map((keyword) => keyword.lexiconVersion)));
  if (taxonomyVersions.size !== 1 || lexiconVersions.size !== 1) {
    throw new TaggingError("DATA_INVARIANT_VIOLATION", "Active taxonomy and keyword lexicon must each have exactly one version");
  }
  const eligibility = loadKeywordEligibilityAuthority();
  const tags = applyKeywordEligibilityAuthority(rows.map((row) => ({
    canonicalTagId: row.id,
    stableId: row.stableId,
    // Owner-final C1 freezes ALL_PRIORITY_0_THEN_STABLE_ID. Display
    // sortOrder is deliberately not reused as classifier priority.
    textSelectionPriority: 0,
    keywords: row.keywords.map((keyword) => ({
      keywordId: keyword.keywordId,
      value: keyword.value,
      scriptBuckets: stringArray(keyword.scriptBuckets, "scriptBuckets") as TagKeywordScriptBucket[],
      matchMode: keyword.matchMode as TagKeywordMatchMode,
      riskFlags: stringArray(keyword.riskFlags, "riskFlags"),
    })),
  })), eligibility, { requireEnabledRuleCoverage: options.enforceCanonicalV1 !== false });
  return validateKeywordRuleArtifact({
    schemaVersion: 1,
    taxonomyVersion: [...taxonomyVersions][0],
    taxonomySha256: CANONICAL_TAG_V1_SHA256,
    keywordLexiconVersion: [...lexiconVersions][0],
    keywordEligibilityVersion: eligibility.version,
    keywordEligibilitySha256: eligibility.sha256,
    tags,
  });
}

function sourceIdentity(sourceItems: readonly SourceIdentityRow[], locale: string) {
  if (sourceItems.length > 1) {
    throw new TaggingError("DATA_INVARIANT_VIOLATION", "Novel has multiple live source entities");
  }
  const source = sourceItems[0];
  if (!source) return null;
  if (source.channelApp.status !== "active" || source.rawLanguageScope === null || source.sourceLocale !== locale) {
    throw new TaggingError("DATA_INVARIANT_VIOLATION", "Novel source identity or scope is incomplete");
  }
  return {
    sourceItemId: source.id,
    channelAppId: source.channelAppId,
    externalBookId: source.externalBookId,
    rawLanguageScope: source.rawLanguageScope,
    sourceLocale: source.sourceLocale,
  };
}

export function classificationSnapshotFromRow(row: NovelInputRow): NovelClassificationSnapshot {
  const source = sourceIdentity(row.sourceItems, row.locale);
  return {
    novelId: row.id,
    title: row.title,
    description: row.description ?? "",
    locale: row.locale,
    mode: row.tagState?.mode === "manual" ? "manual" : "automatic",
    currentAutoRunId: row.tagState?.currentAutoRunId ?? null,
    contentSha256: fingerprint({ schemaVersion: 1, title: row.title, description: row.description ?? "" }),
    entityFingerprint: fingerprint({ schemaVersion: 1, novelId: row.id, locale: row.locale, source }),
  };
}

const NOVEL_CLASSIFICATION_SELECT = {
  id: true,
  title: true,
  description: true,
  locale: true,
  tagState: { select: { mode: true, currentAutoRunId: true } },
  sourceItems: {
    where: { status: "linked", deletedAt: null },
    orderBy: { id: "asc" },
    select: {
      id: true,
      channelAppId: true,
      externalBookId: true,
      sourceLocale: true,
      rawLanguageScope: true,
      channelApp: { select: { status: true } },
    },
  },
} satisfies Prisma.NovelSelect;

export async function readNovelClassificationSnapshot(db: Db, novelId: string): Promise<NovelClassificationSnapshot> {
  const novel = await db.novel.findFirst({
    where: { id: novelId, deletedAt: null },
    select: NOVEL_CLASSIFICATION_SELECT,
  });
  if (!novel) throw new TaggingError("NOVEL_NOT_FOUND");
  return classificationSnapshotFromRow(novel as NovelInputRow);
}

export type NovelClassificationScope = { novelId?: string; novelIds?: readonly string[]; locale?: string; all?: true };

/**
 * Pages through the Novels selected by `scope`, yielding one bounded page of
 * snapshots at a time in ascending-id order, so a caller can keep only the few
 * fields it needs instead of holding every title/description at once (B-21).
 *
 * `pageSize` only applies to the locale / all scopes; an explicit
 * novelId / novelIds selection is already capped at TAGGING_NOVEL_IDS_MAX and
 * is always one page. Concatenating the yielded pages is exactly what
 * readNovelClassificationSnapshots returns.
 */
export async function* iterateNovelClassificationSnapshotPages(
  db: Db,
  scope: NovelClassificationScope,
  options: { pageSize?: number } = {},
): AsyncGenerator<NovelClassificationSnapshot[], void, undefined> {
  const pageSize = options.pageSize ?? TAGGING_NOVEL_IDS_MAX;
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > TAGGING_NOVEL_IDS_MAX) {
    throw new TaggingError("DATA_INVARIANT_VIOLATION", `pageSize must be between 1 and ${TAGGING_NOVEL_IDS_MAX}`);
  }
  // Explicit empty selection is never an unbounded query. The total cap also
  // bounds each read to C-15's <=5,000 IDs; callers segment before this API.
  const ids = scope.novelIds === undefined ? undefined : normalizeTaggingNovelIds(scope.novelIds);
  if (ids?.length === 0) return;

  // A bound novelId/novelIds selection can never exceed TAGGING_NOVEL_IDS_MAX
  // (a single id, or a list normalizeTaggingNovelIds already capped at 5,000),
  // so it stays a single query.
  if (ids || scope.novelId) {
    const novels = await db.novel.findMany({
      where: {
        deletedAt: null,
        ...(ids ? { id: { in: ids } } : {}),
        ...(scope.novelId ? { id: scope.novelId } : {}),
      },
      orderBy: { id: "asc" },
      select: NOVEL_CLASSIFICATION_SELECT,
    });
    if (scope.novelId && novels.length === 0) throw new TaggingError("NOVEL_NOT_FOUND");
    yield novels.map((novel) => classificationSnapshotFromRow(novel as NovelInputRow));
    return;
  }

  // locale / all scopes have no upper bound on how many Novels can match --
  // unlike novelId/novelIds above, nothing caps them at TAGGING_NOVEL_IDS_MAX
  // before this query runs. This select's relation preload (sourceItems,
  // tagState) folds every matched id into the *same* prepared statement as
  // bind variables, and Postgres' prepared-statement bind-variable ceiling is
  // 32,767. Measured against production data: a `locale: "en"` scope with
  // 43,431 novels always fails with
  // `P2035 too many bind variables in prepared statement, expected maximum
  // of 32767, received 32768`, while a 7,918-novel locale succeeds in ~0.7s.
  // So we page this read by id (keyset pagination: `id > <last page's last
  // id>`), capping every page at `pageSize` (<= the same 5,000 the
  // explicit-selection path is already bound to) and yielding pages in
  // ascending-id order -- the exact order and where-clause the single query
  // above used to produce, which callers rely on (payloadFingerprint hashes
  // novelIds in this order for request-id idempotency).
  const where: Prisma.NovelWhereInput = {
    deletedAt: null,
    ...(scope.locale ? { locale: scope.locale } : {}),
  };
  let cursorId: string | undefined;
  for (;;) {
    const page = await db.novel.findMany({
      where: cursorId ? { ...where, id: { gt: cursorId } } : where,
      orderBy: { id: "asc" },
      take: pageSize,
      select: NOVEL_CLASSIFICATION_SELECT,
    });
    if (page.length === 0) return;
    yield page.map((novel) => classificationSnapshotFromRow(novel as NovelInputRow));
    cursorId = page[page.length - 1]!.id;
    if (page.length < pageSize) return;
  }
}

export async function readNovelClassificationSnapshots(
  db: Db,
  scope: NovelClassificationScope,
): Promise<NovelClassificationSnapshot[]> {
  const snapshots: NovelClassificationSnapshot[] = [];
  for await (const page of iterateNovelClassificationSnapshotPages(db, scope)) snapshots.push(...page);
  return snapshots;
}

export async function resolveAutoClassificationAuthorities(
  db: Db,
  dependencies: AutoClassificationDependencies = {},
): Promise<{ config: FrozenTagClassifierConfig; artifact: KeywordRuleArtifact }> {
  const config = loadTagClassifierConfig(dependencies.config);
  const artifact = dependencies.artifact
    ? validateKeywordRuleArtifact(dependencies.artifact)
    : await loadKeywordRuleArtifactFromDb(db, { enforceCanonicalV1: dependencies.enforceCanonicalV1 });
  return { config, artifact };
}

export async function classifyNovelForAuto(
  db: Db,
  novelId: string,
  dependencies: AutoClassificationDependencies = {},
): Promise<NovelAutoClassification> {
  const [snapshot, authorities] = await Promise.all([
    readNovelClassificationSnapshot(db, novelId),
    resolveAutoClassificationAuthorities(db, dependencies),
  ]);
  const result = classifyNovelText(snapshot, authorities.artifact, authorities.config);
  return {
    snapshot,
    ...authorities,
    result,
    runMetadata: {
      method: "deterministic_text",
      taxonomyVersion: authorities.artifact.taxonomyVersion,
      taxonomySha256: authorities.artifact.taxonomySha256,
      keywordLexiconVersion: authorities.artifact.keywordLexiconVersion,
      keywordFingerprint: authorities.artifact.keywordFingerprint,
      classifierConfigVersion: authorities.config.version,
      classifierConfigFingerprint: authorities.config.fingerprint,
      resultSummary: {
        schemaVersion: 1,
        rawEligibleCount: result.rawEligibleCount,
        selectedCount: result.selectedCount,
        truncatedCount: result.truncatedCount,
        inputContractSha256: sha256("title+description:v1"),
        keywordEligibilityVersion: authorities.artifact.keywordEligibilityVersion,
        keywordEligibilitySha256: authorities.artifact.keywordEligibilitySha256,
      },
    },
  };
}
