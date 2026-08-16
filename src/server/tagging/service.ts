import { createHash } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";

import {
  type AutoTagCandidate,
  type EffectiveTag,
  type EffectiveTagLayers,
  type EffectiveTagProvenance,
  type TagClassificationRunMetadata,
  type TaggingActor,
  TaggingError,
} from "@/lib/tagging/contracts";
import {
  isAutoTaggingEnabled,
  isAutoTagWriteAuthorized,
  isTaggingEnabled,
} from "@/lib/flags/feature-flags";

type Db = PrismaClient;

interface EffectiveTagRow {
  canonical_tag_id: string;
  stable_id: string;
  slug: string;
  display_name: string;
  sort_order: number;
}

interface StateRow {
  mode: "automatic" | "manual";
  revision: bigint;
  current_auto_run_id: string | null;
}

export interface ResolveEffectiveTagsInput {
  db: Db;
  novelId: string;
  locale: string;
  env?: NodeJS.ProcessEnv;
}

export interface ReplaceManualTagSnapshotInput {
  db: Db;
  novelId: string;
  canonicalTagIds: readonly string[];
  expectedRevision: bigint;
  requestId: string;
  actor: TaggingActor;
}

export interface ExitManualTagModeInput {
  db: Db;
  novelId: string;
  expectedRevision: bigint;
  requestId: string;
  actor: TaggingActor;
}

export interface ReplaceAutoTagSnapshotInput {
  db: Db;
  novelId: string;
  tags: readonly AutoTagCandidate[];
  runMetadata: TagClassificationRunMetadata;
  contentSha: string;
  requestId: string;
  env?: NodeJS.ProcessEnv;
}

export type ReplaceAutoTagSnapshotTransactionInput = Omit<ReplaceAutoTagSnapshotInput, "db" | "env">;

export interface TagMutationResult {
  mode: "automatic" | "manual";
  revision: bigint;
  replayed: boolean;
  skipped: boolean;
  currentAutoRunId: string | null;
}

const PROVENANCE_ORDER: EffectiveTagProvenance[] = ["manual", "mapped", "auto"];

function requireTaggingEnabled(env: NodeJS.ProcessEnv): void {
  if (!isTaggingEnabled(env)) throw new TaggingError("TAGGING_DISABLED");
}

function stableUniqueIds(ids: readonly string[]): string[] {
  return [...new Set(ids)].sort();
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const row = value as Record<string, unknown>;
  return `{${Object.keys(row).sort().map((key) => `${JSON.stringify(key)}:${stableJson(row[key])}`).join(",")}}`;
}

function sha256(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function rowsToTags(rows: readonly EffectiveTagRow[], provenance: EffectiveTagProvenance): EffectiveTag[] {
  return rows.map((row) => ({
    canonicalTagId: row.canonical_tag_id,
    stableId: row.stable_id,
    slug: row.slug,
    displayName: row.display_name,
    provenance: [provenance],
    sortOrder: row.sort_order,
  }));
}

function unionTags(...layers: readonly EffectiveTag[][]): EffectiveTag[] {
  const tags = new Map<string, EffectiveTag>();
  for (const layer of layers) {
    for (const tag of layer) {
      const existing = tags.get(tag.canonicalTagId);
      if (!existing) {
        tags.set(tag.canonicalTagId, { ...tag, provenance: [...tag.provenance] });
        continue;
      }
      existing.provenance = PROVENANCE_ORDER.filter((item) => (
        existing.provenance.includes(item) || tag.provenance.includes(item)
      ));
    }
  }
  return [...tags.values()].sort((left, right) => (
    left.sortOrder - right.sortOrder || left.stableId.localeCompare(right.stableId, "en")
  ));
}

async function readTagRows(
  db: Db | Prisma.TransactionClient,
  novelId: string,
  locale: string,
  source: "manual" | "auto",
  runId?: string | null,
): Promise<EffectiveTagRow[]> {
  return db.$queryRaw<EffectiveTagRow[]>(Prisma.sql`
    SELECT ct.id AS canonical_tag_id,
           ct.stable_id,
           ct.slug,
           COALESCE(requested.display_name, zh.display_name, ct.slug) AS display_name,
           ct.sort_order
    FROM novel_canonical_tag nct
    JOIN canonical_tag ct ON ct.id = nct.canonical_tag_id AND ct.status = 'active'
    LEFT JOIN canonical_tag_translation requested
      ON requested.canonical_tag_id = ct.id AND requested.locale = ${locale}
    LEFT JOIN canonical_tag_translation zh
      ON zh.canonical_tag_id = ct.id AND zh.locale = 'zh'
    WHERE nct.novel_id = ${novelId}::uuid
      AND nct.source = ${source}
      ${source === "auto" ? Prisma.sql`AND nct.classification_run_id = ${runId}::uuid` : Prisma.empty}
    ORDER BY ct.sort_order, ct.stable_id
  `);
}

async function assertActiveTags(
  tx: Prisma.TransactionClient,
  canonicalTagIds: readonly string[],
): Promise<void> {
  if (canonicalTagIds.length === 0) return;
  const rows = await tx.canonicalTag.findMany({
    where: { id: { in: [...canonicalTagIds] }, status: "active" },
    select: { id: true },
  });
  if (rows.length !== canonicalTagIds.length) throw new TaggingError("TAG_NOT_ACTIVE");
}

async function lockNovelAndState(tx: Prisma.TransactionClient, novelId: string): Promise<StateRow> {
  const novels = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT id FROM novel WHERE id = ${novelId}::uuid AND deleted_at IS NULL FOR UPDATE
  `);
  if (novels.length !== 1) throw new TaggingError("NOVEL_NOT_FOUND");
  await tx.$executeRaw(Prisma.sql`
    INSERT INTO novel_tag_state (novel_id, mode, revision, created_at, updated_at)
    VALUES (${novelId}::uuid, 'automatic', 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT (novel_id) DO NOTHING
  `);
  const [state] = await tx.$queryRaw<StateRow[]>(Prisma.sql`
    SELECT mode, revision, current_auto_run_id
    FROM novel_tag_state WHERE novel_id = ${novelId}::uuid FOR UPDATE
  `);
  return state;
}

async function lockRequest(tx: Prisma.TransactionClient, requestId: string): Promise<void> {
  await tx.$queryRaw(Prisma.sql`
    SELECT 1::int AS locked
    FROM pg_advisory_xact_lock(hashtextextended(${requestId}, 0))
  `);
}

function auditPayload(audit: { afterSnapshot: Prisma.JsonValue | null }): Record<string, unknown> {
  if (audit.afterSnapshot === null || Array.isArray(audit.afterSnapshot) || typeof audit.afterSnapshot !== "object") {
    throw new TaggingError("DATA_INVARIANT_VIOLATION", "Tagging audit payload is invalid");
  }
  return audit.afterSnapshot as Record<string, unknown>;
}

function replayResult(payload: Record<string, unknown>, expectedFingerprint: string): TagMutationResult {
  if (payload.payloadFingerprint !== expectedFingerprint) throw new TaggingError("IDEMPOTENCY_CONFLICT");
  return {
    mode: payload.mode === "manual" ? "manual" : "automatic",
    revision: BigInt(String(payload.revision)),
    replayed: true,
    skipped: Boolean(payload.skipped),
    currentAutoRunId: typeof payload.currentAutoRunId === "string" ? payload.currentAutoRunId : null,
  };
}

export async function resolveEffectiveTags(input: ResolveEffectiveTagsInput): Promise<EffectiveTagLayers> {
  const env = input.env ?? process.env;
  requireTaggingEnabled(env);
  const [novel] = await input.db.$queryRaw<Array<{ locale: string; mode: string | null; revision: bigint | null; current_auto_run_id: string | null }>>(Prisma.sql`
    SELECT n.locale, nts.mode, nts.revision, nts.current_auto_run_id
    FROM novel n LEFT JOIN novel_tag_state nts ON nts.novel_id = n.id
    WHERE n.id = ${input.novelId}::uuid AND n.deleted_at IS NULL
  `);
  if (!novel) throw new TaggingError("NOVEL_NOT_FOUND");
  const mode = novel.mode === "manual" ? "manual" : "automatic";
  const revision = novel.revision ?? 0n;

  if (mode === "manual") {
    const manual = rowsToTags(await readTagRows(input.db, input.novelId, input.locale, "manual"), "manual");
    return { mode, revision, effective: manual, manual, mapped: [], auto: [] };
  }

  const sources = await input.db.$queryRaw<Array<{
    id: string;
    channel_app_id: string;
    raw_language_scope: string | null;
    source_locale: string | null;
  }>>(Prisma.sql`
    SELECT nsi.id, nsi.channel_app_id, nsi.raw_language_scope, nsi.source_locale
    FROM novel_source_item nsi
    JOIN channel_app ca ON ca.id = nsi.channel_app_id AND ca.status = 'active'
    WHERE nsi.novel_id = ${input.novelId}::uuid
      AND nsi.status = 'linked'
      AND nsi.deleted_at IS NULL
  `);
  if (sources.length > 1) throw new TaggingError("DATA_INVARIANT_VIOLATION", "Novel has multiple live source entities");
  const source = sources[0];
  if (source && (
    source.raw_language_scope === null
    || source.source_locale === null
    || source.source_locale !== novel.locale
  )) {
    throw new TaggingError("DATA_INVARIANT_VIOLATION", "Novel source identity or scope is incomplete");
  }

  const mappedRows = source ? await input.db.$queryRaw<EffectiveTagRow[]>(Prisma.sql`
    SELECT DISTINCT ct.id AS canonical_tag_id,
           ct.stable_id,
           ct.slug,
           COALESCE(requested.display_name, zh.display_name, ct.slug) AS display_name,
           ct.sort_order
    FROM novel_source_item_label nsil
    JOIN source_label sl
      ON sl.id = nsil.source_label_id
     AND sl.label_kind = 'series_type'
     AND sl.channel_app_id = ${source.channel_app_id}::uuid
    JOIN source_label_mapping slm
      ON slm.channel_app_id = ${source.channel_app_id}::uuid
     AND slm.raw_language_scope COLLATE "C" = ${source.raw_language_scope} COLLATE "C"
     AND slm.raw_token COLLATE "C" = sl.external_label_value::text COLLATE "C"
     AND slm.active IS TRUE
    JOIN canonical_tag ct ON ct.id = slm.canonical_tag_id AND ct.status = 'active'
    LEFT JOIN canonical_tag_translation requested
      ON requested.canonical_tag_id = ct.id AND requested.locale = ${input.locale}
    LEFT JOIN canonical_tag_translation zh
      ON zh.canonical_tag_id = ct.id AND zh.locale = 'zh'
    WHERE nsil.novel_source_item_id = ${source.id}::uuid AND nsil.active IS TRUE
    ORDER BY ct.sort_order, ct.stable_id
  `) : [];
  const mapped = rowsToTags(mappedRows, "mapped");
  const auto = isAutoTaggingEnabled(env) && novel.current_auto_run_id
    ? rowsToTags(await readTagRows(input.db, input.novelId, input.locale, "auto", novel.current_auto_run_id), "auto")
    : [];
  return { mode, revision, effective: unionTags(mapped, auto), manual: [], mapped, auto };
}

export async function replaceManualTagSnapshot(input: ReplaceManualTagSnapshotInput): Promise<TagMutationResult> {
  const canonicalTagIds = stableUniqueIds(input.canonicalTagIds);
  const payloadFingerprint = sha256({
    novelId: input.novelId,
    canonicalTagIds,
    expectedRevision: input.expectedRevision.toString(),
    actorId: input.actor.id,
  });
  return input.db.$transaction(async (tx) => {
    await lockRequest(tx, input.requestId);
    const prior = await tx.operationAudit.findFirst({
      where: { actorType: "admin", requestId: input.requestId, action: { in: ["tag.manual.replace", "tag.manual.exit"] } },
      select: { action: true, afterSnapshot: true },
    });
    if (prior) {
      if (prior.action !== "tag.manual.replace") throw new TaggingError("IDEMPOTENCY_CONFLICT");
      return replayResult(auditPayload(prior), payloadFingerprint);
    }
    const state = await lockNovelAndState(tx, input.novelId);
    if (state.revision !== input.expectedRevision) throw new TaggingError("REVISION_CONFLICT");
    await assertActiveTags(tx, canonicalTagIds);
    await tx.novelCanonicalTag.deleteMany({ where: { novelId: input.novelId, source: "manual" } });
    if (canonicalTagIds.length > 0) {
      await tx.novelCanonicalTag.createMany({
        data: canonicalTagIds.map((canonicalTagId) => ({
          novelId: input.novelId,
          canonicalTagId,
          source: "manual",
          evidence: {},
          evidenceSchemaVersion: 1,
          decidedBy: input.actor.id,
        })),
      });
    }
    const revision = state.revision + 1n;
    await tx.novelTagState.update({ where: { novelId: input.novelId }, data: { mode: "manual", revision } });
    const afterSnapshot = { payloadFingerprint, mode: "manual", revision: revision.toString(), skipped: false, currentAutoRunId: state.current_auto_run_id };
    await tx.operationAudit.create({ data: {
      actorType: input.actor.type,
      actorId: input.actor.id,
      action: "tag.manual.replace",
      entityType: "NovelTagState",
      entityId: input.novelId,
      requestId: input.requestId,
      beforeSnapshot: { mode: state.mode, revision: state.revision.toString() },
      afterSnapshot,
    } });
    return { mode: "manual", revision, replayed: false, skipped: false, currentAutoRunId: state.current_auto_run_id };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
}

export async function exitManualTagMode(input: ExitManualTagModeInput): Promise<TagMutationResult> {
  const payloadFingerprint = sha256({
    novelId: input.novelId,
    operation: "exit_manual",
    expectedRevision: input.expectedRevision.toString(),
    actorId: input.actor.id,
  });
  return input.db.$transaction(async (tx) => {
    await lockRequest(tx, input.requestId);
    const prior = await tx.operationAudit.findFirst({
      where: { actorType: "admin", requestId: input.requestId, action: { in: ["tag.manual.replace", "tag.manual.exit"] } },
      select: { action: true, afterSnapshot: true },
    });
    if (prior) {
      if (prior.action !== "tag.manual.exit") throw new TaggingError("IDEMPOTENCY_CONFLICT");
      return replayResult(auditPayload(prior), payloadFingerprint);
    }
    const state = await lockNovelAndState(tx, input.novelId);
    if (state.revision !== input.expectedRevision) throw new TaggingError("REVISION_CONFLICT");
    if (state.mode !== "manual") throw new TaggingError("DATA_INVARIANT_VIOLATION", "Novel is not in manual Tag mode");
    await tx.novelCanonicalTag.deleteMany({ where: { novelId: input.novelId, source: "manual" } });
    const revision = state.revision + 1n;
    await tx.novelTagState.update({ where: { novelId: input.novelId }, data: { mode: "automatic", revision } });
    const afterSnapshot = { payloadFingerprint, mode: "automatic", revision: revision.toString(), skipped: false, currentAutoRunId: state.current_auto_run_id };
    await tx.operationAudit.create({ data: {
      actorType: input.actor.type,
      actorId: input.actor.id,
      action: "tag.manual.exit",
      entityType: "NovelTagState",
      entityId: input.novelId,
      requestId: input.requestId,
      beforeSnapshot: { mode: state.mode, revision: state.revision.toString() },
      afterSnapshot,
    } });
    return { mode: "automatic", revision, replayed: false, skipped: false, currentAutoRunId: state.current_auto_run_id };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
}

export async function replaceAutoTagSnapshot(input: ReplaceAutoTagSnapshotInput): Promise<TagMutationResult> {
  const env = input.env ?? process.env;
  requireTaggingEnabled(env);
  if (!isAutoTaggingEnabled(env)) throw new TaggingError("TAGGING_DISABLED");
  if (!isAutoTagWriteAuthorized(env)) throw new TaggingError("AUTO_WRITE_NOT_AUTHORIZED");
  const tags = [...input.tags].sort((left, right) => left.canonicalTagId.localeCompare(right.canonicalTagId));
  if (new Set(tags.map((tag) => tag.canonicalTagId)).size !== tags.length) {
    throw new TaggingError("DATA_INVARIANT_VIOLATION", "Duplicate auto Tag candidate");
  }
  return input.db.$transaction((tx) => replaceAutoTagSnapshotInTransaction(tx, { ...input, tags }), {
    isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
  });
}

export async function replaceAutoTagSnapshotInTransaction(
  tx: Prisma.TransactionClient,
  input: ReplaceAutoTagSnapshotTransactionInput,
): Promise<TagMutationResult> {
  const tags = [...input.tags].sort((left, right) => left.canonicalTagId.localeCompare(right.canonicalTagId));
  if (new Set(tags.map((tag) => tag.canonicalTagId)).size !== tags.length) {
    throw new TaggingError("DATA_INVARIANT_VIOLATION", "Duplicate auto Tag candidate");
  }
  const payloadFingerprint = sha256({ novelId: input.novelId, tags, runMetadata: input.runMetadata, contentSha: input.contentSha });
  await lockRequest(tx, input.requestId);
  const prior = await tx.tagClassificationRun.findUnique({
    where: { novelId_requestId: { novelId: input.novelId, requestId: input.requestId } },
    select: { id: true, resultSummary: true },
  });
  if (prior) {
    const summary = auditPayload({ afterSnapshot: prior.resultSummary });
    if (summary.mutationFingerprint !== payloadFingerprint) throw new TaggingError("IDEMPOTENCY_CONFLICT");
    const state = await tx.novelTagState.findUnique({ where: { novelId: input.novelId } });
    return { mode: state?.mode === "manual" ? "manual" : "automatic", revision: state?.revision ?? 0n, replayed: true, skipped: false, currentAutoRunId: prior.id };
  }
  const state = await lockNovelAndState(tx, input.novelId);
  if (state.mode === "manual") {
    return { mode: "manual", revision: state.revision, replayed: false, skipped: true, currentAutoRunId: state.current_auto_run_id };
  }
  await assertActiveTags(tx, tags.map((tag) => tag.canonicalTagId));
  const run = await tx.tagClassificationRun.create({ data: {
    novelId: input.novelId,
    method: input.runMetadata.method,
    taxonomyVersion: input.runMetadata.taxonomyVersion,
    taxonomySha256: input.runMetadata.taxonomySha256,
    keywordLexiconVersion: input.runMetadata.keywordLexiconVersion,
    keywordFingerprint: input.runMetadata.keywordFingerprint,
    classifierConfigVersion: input.runMetadata.classifierConfigVersion,
    classifierConfigFingerprint: input.runMetadata.classifierConfigFingerprint,
    contentSha256: input.contentSha,
    requestId: input.requestId,
    taskType: input.runMetadata.taskType,
    taskId: input.runMetadata.taskId,
    resultSummary: { schemaVersion: 1, classifier: input.runMetadata.resultSummary, mutationFingerprint: payloadFingerprint, tagCount: tags.length },
    resultSchemaVersion: 1,
  } });
  await tx.novelCanonicalTag.deleteMany({ where: { novelId: input.novelId, source: "auto" } });
  if (tags.length > 0) {
    await tx.novelCanonicalTag.createMany({ data: tags.map((tag) => ({
      novelId: input.novelId,
      canonicalTagId: tag.canonicalTagId,
      source: "auto",
      score: tag.score,
      classificationRunId: run.id,
      evidence: tag.evidence as Prisma.InputJsonObject,
      evidenceSchemaVersion: 1,
    })) });
  }
  await tx.novelTagState.update({ where: { novelId: input.novelId }, data: { currentAutoRunId: run.id } });
  await tx.operationAudit.create({ data: {
    actorType: "worker",
    action: "tag.auto.replace",
    entityType: "NovelTagState",
    entityId: input.novelId,
    requestId: input.requestId,
    taskType: input.runMetadata.taskType,
    taskId: input.runMetadata.taskId,
    beforeSnapshot: { currentAutoRunId: state.current_auto_run_id },
    afterSnapshot: { currentAutoRunId: run.id, tagCount: tags.length, contentSha256: input.contentSha },
  } });
  return { mode: "automatic", revision: state.revision, replayed: false, skipped: false, currentAutoRunId: run.id };
}
