import { Prisma, type PrismaClient } from "@prisma/client";

import {
  ADMIN_TAG_AUDIT_LIMIT,
  ADMIN_TAG_DEFAULT_PAGE_SIZE,
  ADMIN_TAG_MAX_PAGE_SIZE,
  ADMIN_TAG_MAX_SEARCH_LENGTH,
  TaggingAdminError,
  type AdminCanonicalTagDetail,
  type AdminCanonicalTagGetInput,
  type AdminCanonicalTagItem,
  type AdminCanonicalTagKeyword,
  type AdminCanonicalTagList,
  type AdminCanonicalTagMutation,
  type AdminMappingChannel,
  type AdminMappingTarget,
  type AdminNovelTagMutation,
  type AdminNovelTagMutationResult,
  type AdminNovelTags,
  type AdminResolvedTag,
  type AdminSourceLabelMappingGetInput,
  type AdminSourceLabelMappingItem,
  type AdminSourceLabelMappingList,
  type AdminSourceLabelMappingMutation,
  type AdminTagActiveFilter,
  type AdminTagAuditEntry,
  type AdminTagAuditMutationResult,
  type AdminTagAuthority,
  type AdminTagPageInput,
} from "@/domain/tagging-admin";
import type { AdminIdentityStore, SessionStore } from "@/lib/auth/ports";
import {
  isTagAdminWriteEnabled,
  isTaggingEnabled,
} from "@/lib/flags/feature-flags";
import { PRODUCTION_TAG_CLASSIFIER_CONFIG } from "@/lib/tagging/classifier-config";
import { TaggingError } from "@/lib/tagging/contracts";
import {
  CANONICAL_TAG_V1_COUNT,
  CANONICAL_TAG_V1_SHA256,
  TAG_KEYWORD_MATCH_MODES,
  TAG_KEYWORD_SCRIPT_BUCKETS,
  validateKeywordRuleArtifact,
  type TagKeywordMatchMode,
  type TagKeywordScriptBucket,
} from "@/lib/tagging/keyword-artifact";
import {
  CURRENT_KEYWORD_ELIGIBILITY_SHA256,
  CURRENT_KEYWORD_ELIGIBILITY_VERSION,
} from "@/lib/tagging/keyword-eligibility";
import { fingerprint } from "@/lib/tagging/stable-json";
import {
  requireFreshAdminServiceMutation,
  type AdminServiceAuthorization,
} from "@/server/auth/guards";

import { loadKeywordRuleArtifactFromDb } from "./auto-classification";
import {
  exitManualTagMode,
  replaceManualTagSnapshot,
  resolveEffectiveTags,
} from "./service";

type QueryDb = PrismaClient | Prisma.TransactionClient;
type MutationDependencies = Readonly<{
  db: PrismaClient;
  identities: AdminIdentityStore;
  sessions: SessionStore;
  env?: NodeJS.ProcessEnv;
  now?: Date;
}>;

type NormalizedPage = Readonly<{
  page: number;
  pageSize: number;
  offset: number;
  search?: string;
  active: AdminTagActiveFilter;
}>;

export type NormalizedCanonicalTagGet =
  | Readonly<{ mode: "detail"; id: string }>
  | Readonly<{ mode: "list" } & NormalizedPage>;

export type NormalizedSourceLabelMappingGet =
  | Readonly<{ mode: "detail"; id: string }>
  | Readonly<{
      mode: "list";
      channelAppId?: string;
      canonicalTagId?: string;
      rawLanguageScope?: string;
      rawToken?: string;
    } & NormalizedPage>;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DECIMAL_REVISION_PATTERN = /^(?:0|[1-9]\d*)$/;
const CANONICAL_ACTIONS = [
  "tag.canonical.status",
  "tag.canonical.translations.replace",
  "tag.canonical.aliases.replace",
  "tag.canonical.keywords.replace",
] as const;
const MAPPING_ACTIONS = ["tag.mapping.approve", "tag.mapping.deactivate"] as const;
const AUDIT_VISIBLE_KEYS = new Set([
  "status", "translations", "aliases", "keywords", "active", "mappingVersion",
  "rawLanguageScope", "rawToken", "canonicalTagId", "mode", "revision",
]);

function invalid(message: string): never {
  throw new TaggingAdminError("invalid_tag_request", 400, message);
}

function requireUuid(value: unknown, field: string): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) invalid(`${field} must be a UUID`);
  return value.toLowerCase();
}

function optionalExact(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0) invalid(`${field} must be a non-empty string`);
  return value;
}

function numberInput(value: unknown, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value === "number") return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  return Number.NaN;
}

function normalizePage(input: AdminTagPageInput): NormalizedPage {
  const page = numberInput(input.page, 1);
  const pageSize = numberInput(input.pageSize, ADMIN_TAG_DEFAULT_PAGE_SIZE);
  if (!Number.isSafeInteger(page) || page < 1) invalid("page must be a positive integer");
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > ADMIN_TAG_MAX_PAGE_SIZE) {
    invalid(`pageSize must be between 1 and ${ADMIN_TAG_MAX_PAGE_SIZE}`);
  }
  if (input.search !== undefined && typeof input.search !== "string") invalid("search must be a string");
  const search = typeof input.search === "string" ? input.search.trim() : "";
  if (search.length > ADMIN_TAG_MAX_SEARCH_LENGTH) invalid("search is too long");
  const active = input.active ?? "all";
  if (active !== "all" && active !== "active" && active !== "inactive") invalid("active filter is invalid");
  return {
    page,
    pageSize,
    offset: (page - 1) * pageSize,
    search: search || undefined,
    active,
  };
}

export function normalizeCanonicalTagGet(input: AdminCanonicalTagGetInput): NormalizedCanonicalTagGet {
  if (input.id !== undefined) {
    if ([input.page, input.pageSize, input.search, input.active].some((value) => value !== undefined)) {
      invalid("detail id is mutually exclusive with list filters");
    }
    return { mode: "detail", id: requireUuid(input.id, "id") };
  }
  return { mode: "list", ...normalizePage(input) };
}

export function normalizeSourceLabelMappingGet(
  input: AdminSourceLabelMappingGetInput,
): NormalizedSourceLabelMappingGet {
  if (input.id !== undefined) {
    if ([
      input.page, input.pageSize, input.search, input.active, input.channelAppId,
      input.canonicalTagId, input.rawLanguageScope, input.rawToken,
    ].some((value) => value !== undefined)) {
      invalid("detail id is mutually exclusive with list filters");
    }
    return { mode: "detail", id: requireUuid(input.id, "id") };
  }
  return {
    mode: "list",
    ...normalizePage(input),
    channelAppId: input.channelAppId === undefined ? undefined : requireUuid(input.channelAppId, "channelAppId"),
    canonicalTagId: input.canonicalTagId === undefined ? undefined : requireUuid(input.canonicalTagId, "canonicalTagId"),
    rawLanguageScope: optionalExact(input.rawLanguageScope, "rawLanguageScope"),
    rawToken: optionalExact(input.rawToken, "rawToken"),
  };
}

function requireTaggingRead(env: NodeJS.ProcessEnv): void {
  if (!isTaggingEnabled(env)) throw new TaggingAdminError("tagging_disabled", 403);
}

function requireTaggingMutation(env: NodeJS.ProcessEnv): void {
  requireTaggingRead(env);
  if (!isTagAdminWriteEnabled(env)) throw new TaggingAdminError("tag_write_not_authorized", 403);
}

function stringArray(value: Prisma.JsonValue, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new TaggingAdminError("data_invariant_violation", 409, `${field} is not a string array`);
  }
  return [...value] as string[];
}

function sanitizeJson(value: Prisma.JsonValue | null | undefined, depth = 0): unknown {
  if (value === undefined) return null;
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (depth > 4) return null;
  if (Array.isArray(value)) return value.slice(0, 200).map((item) => sanitizeJson(item, depth + 1));
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) result[key] = sanitizeJson(item, depth + 1);
  return result;
}

function visibleSnapshot(value: Prisma.JsonValue | null): Readonly<Record<string, unknown>> | null {
  if (!value || Array.isArray(value) || typeof value !== "object") return null;
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (AUDIT_VISIBLE_KEYS.has(key)) result[key] = sanitizeJson(item);
  }
  return Object.keys(result).length > 0 ? Object.freeze(result) : null;
}

function projectAudit(row: {
  action: string;
  actorId: string | null;
  requestId: string | null;
  reason: string | null;
  beforeSnapshot: Prisma.JsonValue | null;
  afterSnapshot: Prisma.JsonValue | null;
  createdAt: Date;
}): AdminTagAuditEntry {
  return {
    action: row.action,
    actorId: row.actorId,
    requestId: row.requestId,
    reason: row.reason,
    before: visibleSnapshot(row.beforeSnapshot),
    after: visibleSnapshot(row.afterSnapshot),
    createdAt: row.createdAt.toISOString(),
  };
}

async function readAudits(
  db: QueryDb,
  entityType: "CanonicalTag" | "SourceLabelMapping" | "NovelTagState",
  entityId: string,
  limit: number,
): Promise<AdminTagAuditEntry[]> {
  const rows = await db.operationAudit.findMany({
    where: { entityType, entityId },
    select: {
      action: true,
      actorId: true,
      requestId: true,
      reason: true,
      beforeSnapshot: true,
      afterSnapshot: true,
      createdAt: true,
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit,
  });
  return rows.map(projectAudit);
}

type CanonicalRow = Prisma.CanonicalTagGetPayload<{
  include: { translations: true; keywords: true };
}>;

async function projectCanonicalTag(
  db: QueryDb,
  row: CanonicalRow,
  detail: boolean,
): Promise<AdminCanonicalTagItem> {
  const aliases = stringArray(row.aliases, "CanonicalTag.aliases");
  const keywords = row.keywords
    .map((keyword): AdminCanonicalTagKeyword => ({
      keywordId: keyword.keywordId,
      value: keyword.value,
      scriptBuckets: stringArray(keyword.scriptBuckets, "CanonicalTagKeyword.scriptBuckets"),
      matchMode: keyword.matchMode,
      riskFlags: stringArray(keyword.riskFlags, "CanonicalTagKeyword.riskFlags"),
      active: keyword.active,
      lexiconVersion: keyword.lexiconVersion,
    }))
    .sort((left, right) => left.keywordId.localeCompare(right.keywordId, "en"));
  const audits = await readAudits(db, "CanonicalTag", row.id, detail ? ADMIN_TAG_AUDIT_LIMIT : 1);
  const item: AdminCanonicalTagItem = {
    id: row.id,
    stableId: row.stableId,
    slug: row.slug,
    active: row.status === "active",
    canonicalDefinition: row.canonicalDefinition,
    facet: row.facet,
    sortOrder: row.sortOrder,
    taxonomyVersion: row.taxonomyVersion,
    translations: row.translations
      .map((translation) => ({ locale: translation.locale, displayName: translation.displayName }))
      .sort((left, right) => left.locale.localeCompare(right.locale, "en")),
    aliases,
    keywordSummary: {
      total: keywords.length,
      active: keywords.filter((keyword) => keyword.active).length,
      lexiconVersions: [...new Set(keywords.map((keyword) => keyword.lexiconVersion))].sort(),
    },
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    lastMutation: audits[0] ?? null,
  };
  return detail ? { ...item, keywords, audit: audits } : item;
}

export async function readAdminTagAuthority(db: PrismaClient): Promise<AdminTagAuthority> {
  const [databaseActiveCount, taxonomyVersionRows, activeKeywordCount, lexiconVersionRows] = await Promise.all([
    db.canonicalTag.count({ where: { status: "active" } }),
    db.canonicalTag.groupBy({ by: ["taxonomyVersion"], where: { status: "active" }, orderBy: { taxonomyVersion: "asc" } }),
    db.canonicalTagKeyword.count({ where: { active: true, canonicalTag: { status: "active" } } }),
    db.canonicalTagKeyword.groupBy({
      by: ["lexiconVersion"],
      where: { active: true, canonicalTag: { status: "active" } },
      orderBy: { lexiconVersion: "asc" },
    }),
  ]);
  const taxonomyVersions = taxonomyVersionRows.map((row) => row.taxonomyVersion);
  const lexiconVersions = lexiconVersionRows.map((row) => row.lexiconVersion);
  let keywordFingerprint: string | null = null;
  try {
    keywordFingerprint = (await loadKeywordRuleArtifactFromDb(db)).keywordFingerprint;
  } catch (error) {
    if (!(error instanceof TaggingError)) throw error;
  }
  return {
    taxonomy: {
      status: databaseActiveCount === CANONICAL_TAG_V1_COUNT && taxonomyVersions.length === 1 ? "READY" : "INCOMPLETE",
      canonicalV1Count: CANONICAL_TAG_V1_COUNT,
      canonicalV1Sha256: CANONICAL_TAG_V1_SHA256,
      databaseActiveCount,
      versions: taxonomyVersions,
    },
    keywords: {
      status: keywordFingerprint === null ? "INCOMPLETE" : "READY",
      activeKeywordCount,
      versions: lexiconVersions,
      fingerprint: keywordFingerprint,
      keywordEligibilityVersion: CURRENT_KEYWORD_ELIGIBILITY_VERSION,
      keywordEligibilitySha256: CURRENT_KEYWORD_ELIGIBILITY_SHA256,
    },
    classifier: { ...PRODUCTION_TAG_CLASSIFIER_CONFIG },
  };
}

export async function listAdminCanonicalTags(
  db: PrismaClient,
  input: AdminCanonicalTagGetInput = {},
  env: NodeJS.ProcessEnv = process.env,
): Promise<AdminCanonicalTagList> {
  requireTaggingRead(env);
  const normalized = normalizeCanonicalTagGet(input);
  if (normalized.mode !== "list") invalid("list input is required");
  const where: Prisma.CanonicalTagWhereInput = {
    ...(normalized.active === "all" ? {} : { status: normalized.active }),
    ...(normalized.search ? {
      OR: [
        { stableId: { contains: normalized.search } },
        { slug: { contains: normalized.search } },
        { canonicalDefinition: { contains: normalized.search } },
        { translations: { some: { displayName: { contains: normalized.search } } } },
      ],
    } : {}),
  };
  const [rows, total, authority] = await Promise.all([
    db.canonicalTag.findMany({
      where,
      include: { translations: true, keywords: true },
      orderBy: [{ sortOrder: "asc" }, { stableId: "asc" }],
      skip: normalized.offset,
      take: normalized.pageSize,
    }),
    db.canonicalTag.count({ where }),
    readAdminTagAuthority(db),
  ]);
  return {
    items: await Promise.all(rows.map((row) => projectCanonicalTag(db, row, false))),
    page: normalized.page,
    pageSize: normalized.pageSize,
    total,
    totalPages: Math.ceil(total / normalized.pageSize),
    authority,
  };
}

export async function getAdminCanonicalTag(
  db: PrismaClient,
  id: unknown,
  env: NodeJS.ProcessEnv = process.env,
): Promise<AdminCanonicalTagDetail> {
  requireTaggingRead(env);
  const canonicalTagId = requireUuid(id, "id");
  const [row, authority] = await Promise.all([
    db.canonicalTag.findUnique({ where: { id: canonicalTagId }, include: { translations: true, keywords: true } }),
    readAdminTagAuthority(db),
  ]);
  if (!row) throw new TaggingAdminError("canonical_tag_not_found", 404);
  return { tag: await projectCanonicalTag(db, row, true), authority };
}

type MappingRow = Prisma.SourceLabelMappingGetPayload<{
  include: {
    channelApp: { include: { channel: true; sourceApp: true } };
    canonicalTag: true;
    approver: true;
  };
}>;

async function projectMapping(db: QueryDb, row: MappingRow, detail: boolean): Promise<AdminSourceLabelMappingItem> {
  const audits = await readAudits(db, "SourceLabelMapping", row.id, detail ? ADMIN_TAG_AUDIT_LIMIT : 1);
  const channel: AdminMappingChannel = {
    channelAppId: row.channelApp.id,
    channelCode: row.channelApp.channel.code,
    sourceAppCode: row.channelApp.sourceApp.code,
    externalAppId: row.channelApp.externalAppId,
    active: row.channelApp.status === "active",
  };
  const target: AdminMappingTarget = {
    id: row.canonicalTag.id,
    stableId: row.canonicalTag.stableId,
    slug: row.canonicalTag.slug,
    active: row.canonicalTag.status === "active",
  };
  const item: AdminSourceLabelMappingItem = {
    id: row.id,
    channel,
    rawLanguageScope: row.rawLanguageScope,
    rawToken: row.rawToken,
    target,
    mappingVersion: row.mappingVersion,
    active: row.active,
    approvedBy: { id: row.approver.id, username: row.approver.username },
    approvedAt: row.approvedAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    lastMutation: audits[0] ?? null,
  };
  return detail ? { ...item, audit: audits } : item;
}

const MAPPING_INCLUDE = {
  channelApp: { include: { channel: true, sourceApp: true } },
  canonicalTag: true,
  approver: true,
} as const;

export async function listAdminSourceLabelMappings(
  db: PrismaClient,
  input: AdminSourceLabelMappingGetInput = {},
  env: NodeJS.ProcessEnv = process.env,
): Promise<AdminSourceLabelMappingList> {
  requireTaggingRead(env);
  const normalized = normalizeSourceLabelMappingGet(input);
  if (normalized.mode !== "list") invalid("list input is required");
  const where: Prisma.SourceLabelMappingWhereInput = {
    ...(normalized.active === "all" ? {} : { active: normalized.active === "active" }),
    ...(normalized.channelAppId ? { channelAppId: normalized.channelAppId } : {}),
    ...(normalized.canonicalTagId ? { canonicalTagId: normalized.canonicalTagId } : {}),
    ...(normalized.rawLanguageScope !== undefined ? { rawLanguageScope: normalized.rawLanguageScope } : {}),
    ...(normalized.rawToken !== undefined ? { rawToken: normalized.rawToken } : {}),
    ...(normalized.search ? {
      OR: [
        { rawToken: { contains: normalized.search } },
        { canonicalTag: { stableId: { contains: normalized.search } } },
        { canonicalTag: { slug: { contains: normalized.search } } },
        { channelApp: { externalAppId: { contains: normalized.search } } },
      ],
    } : {}),
  };
  const [rows, total] = await Promise.all([
    db.sourceLabelMapping.findMany({
      where,
      include: MAPPING_INCLUDE,
      orderBy: [
        { channelAppId: "asc" }, { rawLanguageScope: "asc" }, { rawToken: "asc" }, { canonicalTagId: "asc" },
      ],
      skip: normalized.offset,
      take: normalized.pageSize,
    }),
    db.sourceLabelMapping.count({ where }),
  ]);
  return {
    items: await Promise.all(rows.map((row) => projectMapping(db, row, false))),
    page: normalized.page,
    pageSize: normalized.pageSize,
    total,
    totalPages: Math.ceil(total / normalized.pageSize),
  };
}

export async function getAdminSourceLabelMapping(
  db: PrismaClient,
  id: unknown,
  env: NodeJS.ProcessEnv = process.env,
): Promise<AdminSourceLabelMappingItem> {
  requireTaggingRead(env);
  const mappingId = requireUuid(id, "id");
  const row = await db.sourceLabelMapping.findUnique({ where: { id: mappingId }, include: MAPPING_INCLUDE });
  if (!row) throw new TaggingAdminError("mapping_not_found", 404);
  return projectMapping(db, row, true);
}

function resolvedTag(tag: {
  canonicalTagId: string;
  stableId: string;
  slug: string;
  displayName: string;
  provenance: readonly ("manual" | "mapped" | "auto")[];
}): AdminResolvedTag {
  return {
    canonicalTagId: tag.canonicalTagId,
    stableId: tag.stableId,
    slug: tag.slug,
    displayName: tag.displayName,
    provenance: [...tag.provenance],
  };
}

export async function getAdminNovelTags(
  db: PrismaClient,
  input: { novelId: unknown; locale?: unknown },
  env: NodeJS.ProcessEnv = process.env,
): Promise<AdminNovelTags> {
  requireTaggingRead(env);
  const novelId = requireUuid(input.novelId, "novelId");
  const novel = await db.novel.findFirst({ where: { id: novelId, deletedAt: null }, select: { locale: true } });
  if (!novel) throw new TaggingAdminError("novel_not_found", 404);
  if (input.locale !== undefined && (typeof input.locale !== "string" || input.locale.length === 0 || input.locale.length > 16)) {
    invalid("locale must be a non-empty internal translation key of at most 16 characters");
  }
  const layers = await translateCoreError(() => resolveEffectiveTags({
    db,
    novelId,
    locale: typeof input.locale === "string" ? input.locale : novel.locale,
    env,
  }));
  const latestRow = await db.operationAudit.findFirst({
    where: {
      entityType: "NovelTagState",
      entityId: novelId,
      action: { in: ["tag.manual.replace", "tag.manual.exit"] },
    },
    select: {
      action: true,
      actorId: true,
      requestId: true,
      reason: true,
      beforeSnapshot: true,
      afterSnapshot: true,
      createdAt: true,
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  const latest = latestRow ? projectAudit(latestRow) : null;
  return {
    mode: layers.mode,
    revision: layers.revision.toString(),
    effective: layers.effective.map(resolvedTag),
    manual: layers.manual.map(resolvedTag),
    mapped: layers.mapped.map(resolvedTag),
    auto: layers.auto.map(resolvedTag),
    lastManualMutation: latest,
  };
}

async function authorizeMutation(
  authorization: AdminServiceAuthorization,
  entryId: string,
  requestId: string,
  deps: MutationDependencies,
) {
  const env = deps.env ?? process.env;
  requireTaggingMutation(env);
  return requireFreshAdminServiceMutation(authorization, "tag:manage", {
    identities: deps.identities,
    sessions: deps.sessions,
    now: deps.now,
    env,
    entryId,
    requestId,
  });
}

async function lockRequest(tx: Prisma.TransactionClient, requestId: string): Promise<void> {
  await tx.$queryRaw(Prisma.sql`
    SELECT 1::int AS locked FROM pg_advisory_xact_lock(hashtextextended(${requestId}, 0))
  `);
}

async function lockNamespace(tx: Prisma.TransactionClient, namespace: string): Promise<void> {
  await tx.$queryRaw(Prisma.sql`
    SELECT 1::int AS locked FROM pg_advisory_xact_lock(hashtextextended(${namespace}, 0))
  `);
}

function requireIso(value: string): string {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) invalid("expectedUpdatedAt must be an ISO timestamp");
  const normalized = new Date(value).toISOString();
  if (normalized !== value) invalid("expectedUpdatedAt must use the canonical ISO representation");
  return value;
}

function requireRevision(value: string): bigint {
  if (typeof value !== "string" || !DECIMAL_REVISION_PATTERN.test(value)) invalid("expectedRevision must be a decimal string");
  return BigInt(value);
}

function auditObject(value: Prisma.JsonValue | null): Record<string, unknown> {
  if (!value || Array.isArray(value) || typeof value !== "object") {
    throw new TaggingAdminError("data_invariant_violation", 409, "Admin audit payload is invalid");
  }
  return value as Record<string, unknown>;
}

function replayAudit(
  audit: { afterSnapshot: Prisma.JsonValue | null },
  payloadFingerprint: string,
): AdminTagAuditMutationResult {
  const payload = auditObject(audit.afterSnapshot);
  if (payload.payloadFingerprint !== payloadFingerprint) {
    throw new TaggingAdminError("idempotency_conflict", 409);
  }
  if (typeof payload.resultId !== "string" || typeof payload.resultUpdatedAt !== "string") {
    throw new TaggingAdminError("data_invariant_violation", 409, "Admin audit result binding is invalid");
  }
  return { id: payload.resultId, updatedAt: payload.resultUpdatedAt, replayed: true };
}

function canonicalAuditAction(action: AdminCanonicalTagMutation["action"]): (typeof CANONICAL_ACTIONS)[number] {
  if (action === "set_status") return "tag.canonical.status";
  if (action === "replace_translations") return "tag.canonical.translations.replace";
  if (action === "replace_aliases") return "tag.canonical.aliases.replace";
  return "tag.canonical.keywords.replace";
}

function validateTranslations(value: readonly { locale: string; displayName: string }[]) {
  if (!Array.isArray(value)) invalid("translations must be an array");
  const locales = new Set<string>();
  return value.map((translation) => {
    if (!translation || typeof translation.locale !== "string" || typeof translation.displayName !== "string") {
      invalid("translation entries are invalid");
    }
    if (translation.locale.length === 0 || translation.locale.length > 16 || translation.locale.trim().length === 0) {
      invalid("translation locale is invalid");
    }
    if (translation.displayName.length === 0 || translation.displayName.length > 160 || translation.displayName.trim().length === 0) {
      invalid("translation displayName is invalid");
    }
    if (locales.has(translation.locale)) invalid("translation locales must be unique");
    locales.add(translation.locale);
    return { locale: translation.locale, displayName: translation.displayName };
  }).sort((left, right) => left.locale.localeCompare(right.locale, "en"));
}

function validateAliases(value: readonly string[]) {
  if (!Array.isArray(value) || value.some((alias) => typeof alias !== "string" || alias.length === 0 || alias.trim().length === 0)) {
    invalid("aliases must contain non-empty strings");
  }
  if (new Set(value).size !== value.length) throw new TaggingAdminError("alias_collision", 409);
  return [...value];
}

function validateKeywords(
  value: readonly AdminCanonicalTagKeyword[],
  tag: { id: string; stableId: string; taxonomyVersion: string },
): AdminCanonicalTagKeyword[] {
  if (!Array.isArray(value)) invalid("keywords must be an array");
  const ids = new Set<string>();
  return value.map((keyword) => {
    if (!keyword || typeof keyword.keywordId !== "string" || !keyword.keywordId.trim() || keyword.keywordId.length > 200) {
      invalid("keywordId is invalid");
    }
    if (ids.has(keyword.keywordId)) throw new TaggingAdminError("keyword_collision", 409);
    ids.add(keyword.keywordId);
    if (typeof keyword.value !== "string" || keyword.value.length === 0) invalid("keyword value is invalid");
    if (typeof keyword.lexiconVersion !== "string" || !keyword.lexiconVersion.trim() || keyword.lexiconVersion.length > 64) {
      invalid("keyword lexiconVersion is invalid");
    }
    if (!Array.isArray(keyword.scriptBuckets)
      || keyword.scriptBuckets.some((bucket: unknown) => typeof bucket !== "string" || !TAG_KEYWORD_SCRIPT_BUCKETS.includes(bucket as TagKeywordScriptBucket))) {
      invalid("keyword scriptBuckets are invalid");
    }
    if (!TAG_KEYWORD_MATCH_MODES.includes(keyword.matchMode as TagKeywordMatchMode)) invalid("keyword matchMode is invalid");
    if (!Array.isArray(keyword.riskFlags) || keyword.riskFlags.some((flag: unknown) => typeof flag !== "string")) {
      invalid("keyword riskFlags are invalid");
    }
    if (typeof keyword.active !== "boolean") invalid("keyword active must be boolean");
    try {
      validateKeywordRuleArtifact({
        schemaVersion: 1,
        taxonomyVersion: tag.taxonomyVersion,
        taxonomySha256: CANONICAL_TAG_V1_SHA256,
        keywordLexiconVersion: keyword.lexiconVersion,
        tags: [{
          canonicalTagId: tag.id,
          stableId: tag.stableId,
          textSelectionPriority: 0,
          keywords: [{
            keywordId: keyword.keywordId,
            value: keyword.value,
            scriptBuckets: [...keyword.scriptBuckets] as TagKeywordScriptBucket[],
            matchMode: keyword.matchMode as TagKeywordMatchMode,
            riskFlags: [...keyword.riskFlags],
          }],
        }],
      });
    } catch (error) {
      if (error instanceof TaggingError) throw new TaggingAdminError("invalid_canonical_tag", 400);
      throw error;
    }
    return {
      keywordId: keyword.keywordId,
      value: keyword.value,
      scriptBuckets: [...keyword.scriptBuckets],
      matchMode: keyword.matchMode,
      riskFlags: [...keyword.riskFlags],
      active: keyword.active,
      lexiconVersion: keyword.lexiconVersion,
    };
  }).sort((left, right) => left.keywordId.localeCompare(right.keywordId, "en"));
}

export async function mutateAdminCanonicalTag(
  input: {
    authorization: AdminServiceAuthorization;
    entryId: "admin.api.canonical_tag.write";
    mutation: AdminCanonicalTagMutation;
  },
  deps: MutationDependencies,
): Promise<AdminTagAuditMutationResult> {
  const mutation = input.mutation;
  const actor = await authorizeMutation(input.authorization, input.entryId, mutation.requestId, deps);
  const canonicalTagId = requireUuid(mutation.canonicalTagId, "canonicalTagId");
  const expectedUpdatedAt = requireIso(mutation.expectedUpdatedAt);
  const action = canonicalAuditAction(mutation.action);
  const payloadFingerprint = fingerprint({ ...mutation, canonicalTagId, actorId: actor.identity.id });

  try {
    return await deps.db.$transaction(async (tx) => {
      await lockRequest(tx, mutation.requestId);
      await lockNamespace(tx, "p2-06-5:canonical-taxonomy-admin");
      const prior = await tx.operationAudit.findFirst({
        where: { actorType: "admin", requestId: mutation.requestId, action: { in: [...CANONICAL_ACTIONS] } },
        select: { action: true, afterSnapshot: true },
      });
      if (prior) {
        if (prior.action !== action) throw new TaggingAdminError("idempotency_conflict", 409);
        return replayAudit(prior, payloadFingerprint);
      }
      const [locked] = await tx.$queryRaw<Array<{ id: string; updated_at: Date }>>(Prisma.sql`
        SELECT id, updated_at FROM canonical_tag WHERE id = ${canonicalTagId}::uuid FOR UPDATE
      `);
      if (!locked) throw new TaggingAdminError("canonical_tag_not_found", 404);
      if (locked.updated_at.toISOString() !== expectedUpdatedAt) throw new TaggingAdminError("revision_conflict", 409);
      const tag = await tx.canonicalTag.findUniqueOrThrow({
        where: { id: canonicalTagId },
        include: { translations: true, keywords: true },
      });
      const before: Record<string, Prisma.InputJsonValue> = {};
      const after: Record<string, Prisma.InputJsonValue> = {};

      if (mutation.action === "set_status") {
        if (mutation.status !== "active" && mutation.status !== "inactive") {
          throw new TaggingAdminError("invalid_canonical_tag", 400);
        }
        before.status = tag.status;
        after.status = mutation.status;
        await tx.canonicalTag.update({ where: { id: canonicalTagId }, data: { status: mutation.status } });
      } else if (mutation.action === "replace_translations") {
        const translations = validateTranslations(mutation.translations);
        before.translations = tag.translations.map((item) => ({ locale: item.locale, displayName: item.displayName }));
        after.translations = translations;
        await tx.canonicalTagTranslation.deleteMany({ where: { canonicalTagId } });
        if (translations.length > 0) {
          await tx.canonicalTagTranslation.createMany({ data: translations.map((item) => ({ canonicalTagId, ...item })) });
        }
      } else if (mutation.action === "replace_aliases") {
        const aliases = validateAliases(mutation.aliases);
        const otherTags = await tx.canonicalTag.findMany({
          where: { id: { not: canonicalTagId } },
          select: { stableId: true, slug: true, aliases: true },
        });
        const occupied = new Set(otherTags.flatMap((other) => [
          other.stableId,
          other.slug,
          ...stringArray(other.aliases, "CanonicalTag.aliases"),
        ]));
        if (aliases.some((alias) => occupied.has(alias))) throw new TaggingAdminError("alias_collision", 409);
        before.aliases = stringArray(tag.aliases, "CanonicalTag.aliases");
        after.aliases = aliases;
        await tx.canonicalTag.update({ where: { id: canonicalTagId }, data: { aliases } });
      } else {
        const keywords = validateKeywords(mutation.keywords, tag);
        const collisions = keywords.length === 0 ? [] : await tx.canonicalTagKeyword.findMany({
          where: { keywordId: { in: keywords.map((item) => item.keywordId) }, canonicalTagId: { not: canonicalTagId } },
          select: { keywordId: true },
        });
        if (collisions.length > 0) throw new TaggingAdminError("keyword_collision", 409);
        before.keywords = tag.keywords.map((item) => ({
          keywordId: item.keywordId,
          value: item.value,
          scriptBuckets: item.scriptBuckets,
          matchMode: item.matchMode,
          riskFlags: item.riskFlags,
          active: item.active,
          lexiconVersion: item.lexiconVersion,
        }));
        after.keywords = keywords as unknown as Prisma.InputJsonArray;
        await tx.canonicalTagKeyword.deleteMany({ where: { canonicalTagId } });
        if (keywords.length > 0) {
          await tx.canonicalTagKeyword.createMany({
            data: keywords.map((keyword) => ({
              canonicalTagId,
              keywordId: keyword.keywordId,
              value: keyword.value,
              scriptBuckets: [...keyword.scriptBuckets],
              matchMode: keyword.matchMode,
              riskFlags: [...keyword.riskFlags],
              active: keyword.active,
              lexiconVersion: keyword.lexiconVersion,
            })),
          });
        }
      }

      const updated = await tx.canonicalTag.update({ where: { id: canonicalTagId }, data: { updatedAt: deps.now ?? new Date() } });
      const result = { id: updated.id, updatedAt: updated.updatedAt.toISOString(), replayed: false };
      await tx.operationAudit.create({ data: {
        actorType: "admin",
        actorId: actor.identity.id,
        action,
        entityType: "CanonicalTag",
        entityId: canonicalTagId,
        requestId: mutation.requestId,
        beforeSnapshot: before,
        afterSnapshot: {
          ...after,
          payloadFingerprint,
          resultId: result.id,
          resultUpdatedAt: result.updatedAt,
        },
      } });
      return result;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw new TaggingAdminError(mutation.action === "replace_keywords" ? "keyword_collision" : "alias_collision", 409);
    }
    throw error;
  }
}

function mappingAuditAction(action: AdminSourceLabelMappingMutation["action"]): (typeof MAPPING_ACTIONS)[number] {
  return action === "approve_edge" ? "tag.mapping.approve" : "tag.mapping.deactivate";
}

export async function mutateAdminSourceLabelMapping(
  input: {
    authorization: AdminServiceAuthorization;
    entryId: "admin.api.tag_mapping.write";
    mutation: AdminSourceLabelMappingMutation;
  },
  deps: MutationDependencies,
): Promise<AdminTagAuditMutationResult> {
  const mutation = input.mutation;
  const actor = await authorizeMutation(input.authorization, input.entryId, mutation.requestId, deps);
  const action = mappingAuditAction(mutation.action);
  const normalized = mutation.action === "approve_edge" ? {
    ...mutation,
    channelAppId: requireUuid(mutation.channelAppId, "channelAppId"),
    canonicalTagId: requireUuid(mutation.canonicalTagId, "canonicalTagId"),
  } : {
    ...mutation,
    mappingId: requireUuid(mutation.mappingId, "mappingId"),
  };
  if (mutation.action === "approve_edge") {
    if (typeof mutation.rawLanguageScope !== "string" || typeof mutation.rawToken !== "string"
      || mutation.rawLanguageScope.length === 0 || mutation.rawToken.length === 0) {
      invalid("mapping scope and token must not be empty");
    }
    if (typeof mutation.mappingVersion !== "string" || !mutation.mappingVersion.trim() || mutation.mappingVersion.length > 96) {
      invalid("mappingVersion is invalid");
    }
    if (mutation.expectedUpdatedAt !== null) requireIso(mutation.expectedUpdatedAt);
  } else {
    requireIso(mutation.expectedUpdatedAt);
  }
  const payloadFingerprint = fingerprint({ ...normalized, actorId: actor.identity.id });

  try {
    return await deps.db.$transaction(async (tx) => {
      await lockRequest(tx, mutation.requestId);
      const prior = await tx.operationAudit.findFirst({
        where: { actorType: "admin", requestId: mutation.requestId, action: { in: [...MAPPING_ACTIONS] } },
        select: { action: true, afterSnapshot: true },
      });
      if (prior) {
        if (prior.action !== action) throw new TaggingAdminError("idempotency_conflict", 409);
        return replayAudit(prior, payloadFingerprint);
      }

      let mappingId: string;
      let before: Prisma.InputJsonObject;
      if (mutation.action === "approve_edge") {
        const value = normalized as Extract<typeof normalized, { action: "approve_edge" }>;
        await lockNamespace(tx, `p2-06-5:mapping:${value.channelAppId}:${value.rawLanguageScope}:${value.rawToken}:${value.canonicalTagId}`);
        const [channelApp, tag] = await Promise.all([
          tx.channelApp.findUnique({ where: { id: value.channelAppId }, select: { status: true } }),
          tx.canonicalTag.findUnique({ where: { id: value.canonicalTagId }, select: { status: true } }),
        ]);
        if (!channelApp || channelApp.status !== "active") throw new TaggingAdminError("mapping_identity_conflict", 409);
        if (!tag) throw new TaggingAdminError("canonical_tag_not_found", 404);
        if (tag.status !== "active") throw new TaggingAdminError("inactive_canonical_tag", 409);
        const existing = await tx.sourceLabelMapping.findFirst({ where: {
          channelAppId: value.channelAppId,
          rawLanguageScope: value.rawLanguageScope,
          rawToken: value.rawToken,
          canonicalTagId: value.canonicalTagId,
        } });
        if (existing && value.expectedUpdatedAt === null) throw new TaggingAdminError("mapping_identity_conflict", 409);
        if (!existing && value.expectedUpdatedAt !== null) throw new TaggingAdminError("mapping_identity_conflict", 409);
        if (existing && existing.updatedAt.toISOString() !== value.expectedUpdatedAt) {
          throw new TaggingAdminError("revision_conflict", 409);
        }
        before = existing ? { active: existing.active, mappingVersion: existing.mappingVersion } : {};
        if (existing) {
          const updated = await tx.sourceLabelMapping.update({ where: { id: existing.id }, data: {
            active: true,
            mappingVersion: value.mappingVersion,
            approvedBy: actor.identity.id,
            approvedAt: deps.now ?? new Date(),
            updatedAt: deps.now ?? new Date(),
          } });
          mappingId = updated.id;
        } else {
          const created = await tx.sourceLabelMapping.create({ data: {
            channelAppId: value.channelAppId,
            rawLanguageScope: value.rawLanguageScope,
            rawToken: value.rawToken,
            canonicalTagId: value.canonicalTagId,
            mappingVersion: value.mappingVersion,
            active: true,
            approvedBy: actor.identity.id,
            approvedAt: deps.now ?? new Date(),
          } });
          mappingId = created.id;
        }
      } else {
        const value = normalized as Extract<typeof normalized, { action: "deactivate_edge" }>;
        const [locked] = await tx.$queryRaw<Array<{ id: string; active: boolean; updated_at: Date; mapping_version: string }>>(Prisma.sql`
          SELECT id, active, updated_at, mapping_version
          FROM source_label_mapping WHERE id = ${value.mappingId}::uuid FOR UPDATE
        `);
        if (!locked) throw new TaggingAdminError("mapping_not_found", 404);
        if (locked.updated_at.toISOString() !== value.expectedUpdatedAt) throw new TaggingAdminError("revision_conflict", 409);
        before = { active: locked.active, mappingVersion: locked.mapping_version };
        const updated = await tx.sourceLabelMapping.update({
          where: { id: value.mappingId },
          data: { active: false, updatedAt: deps.now ?? new Date() },
        });
        mappingId = updated.id;
      }

      const mapping = await tx.sourceLabelMapping.findUniqueOrThrow({ where: { id: mappingId } });
      const result = { id: mapping.id, updatedAt: mapping.updatedAt.toISOString(), replayed: false };
      await tx.operationAudit.create({ data: {
        actorType: "admin",
        actorId: actor.identity.id,
        action,
        entityType: "SourceLabelMapping",
        entityId: mapping.id,
        requestId: mutation.requestId,
        beforeSnapshot: before,
        afterSnapshot: {
          active: mapping.active,
          mappingVersion: mapping.mappingVersion,
          rawLanguageScope: mapping.rawLanguageScope,
          rawToken: mapping.rawToken,
          canonicalTagId: mapping.canonicalTagId,
          payloadFingerprint,
          resultId: result.id,
          resultUpdatedAt: result.updatedAt,
        },
      } });
      return result;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw new TaggingAdminError("mapping_identity_conflict", 409);
    }
    throw error;
  }
}

async function translateCoreError<T>(run: () => Promise<T>, manualExit = false): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (!(error instanceof TaggingError)) throw error;
    if (error.code === "TAGGING_DISABLED") throw new TaggingAdminError("tagging_disabled", 403);
    if (error.code === "NOVEL_NOT_FOUND") throw new TaggingAdminError("novel_not_found", 404);
    if (error.code === "REVISION_CONFLICT") throw new TaggingAdminError("revision_conflict", 409);
    if (error.code === "IDEMPOTENCY_CONFLICT") throw new TaggingAdminError("idempotency_conflict", 409);
    if (error.code === "TAG_NOT_ACTIVE") throw new TaggingAdminError("inactive_canonical_tag", 409);
    if (error.code === "DATA_INVARIANT_VIOLATION" && manualExit) {
      throw new TaggingAdminError("manual_mode_conflict", 409);
    }
    throw new TaggingAdminError("data_invariant_violation", 409);
  }
}

export async function mutateAdminNovelTags(
  input: {
    authorization: AdminServiceAuthorization;
    entryId: "admin.api.novel_tag.write";
    mutation: AdminNovelTagMutation;
  },
  deps: MutationDependencies,
): Promise<AdminNovelTagMutationResult> {
  const mutation = input.mutation;
  const actor = await authorizeMutation(input.authorization, input.entryId, mutation.requestId, deps);
  const novelId = requireUuid(mutation.novelId, "novelId");
  const expectedRevision = requireRevision(mutation.expectedRevision);
  if (mutation.action === "replace_manual" && !Array.isArray(mutation.canonicalTagIds)) {
    invalid("canonicalTagIds must be an array");
  }
  const result = mutation.action === "replace_manual"
    ? await translateCoreError(() => replaceManualTagSnapshot({
        db: deps.db,
        novelId,
        canonicalTagIds: mutation.canonicalTagIds.map((id) => requireUuid(id, "canonicalTagIds")),
        expectedRevision,
        requestId: mutation.requestId,
        actor: { id: actor.identity.id, type: "admin" },
      }))
    : await translateCoreError(() => exitManualTagMode({
        db: deps.db,
        novelId,
        expectedRevision,
        requestId: mutation.requestId,
        actor: { id: actor.identity.id, type: "admin" },
      }), true);
  return { mode: result.mode, revision: result.revision.toString(), replayed: result.replayed };
}
