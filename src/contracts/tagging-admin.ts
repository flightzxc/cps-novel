import type {
  AdminCanonicalTagDetail,
  AdminCanonicalTagItem,
  AdminCanonicalTagKeyword,
  AdminCanonicalTagList,
  AdminNovelTagMutationResult,
  AdminNovelTags,
  AdminResolvedTag,
  AdminSourceLabelMappingItem,
  AdminSourceLabelMappingList,
  AdminTagAuditEntry,
  AdminTagAuditMutationResult,
  AdminTagAuthority,
} from "@/domain/tagging-admin";

export type AdminTagAuditEntryView = Readonly<{
  action: string;
  actorId: string | null;
  requestId: string | null;
  reason: string | null;
  before: Readonly<Record<string, unknown>> | null;
  after: Readonly<Record<string, unknown>> | null;
  createdAt: string;
}>;

export type AdminTagAuthorityView = AdminTagAuthority;

export type AdminCanonicalTagKeywordView = Readonly<{
  keywordId: string;
  value: string;
  scriptBuckets: readonly string[];
  matchMode: string;
  riskFlags: readonly string[];
  active: boolean;
  lexiconVersion: string;
}>;

export type AdminCanonicalTagView = Readonly<{
  id: string;
  stableId: string;
  slug: string;
  active: boolean;
  canonicalDefinition: string;
  facet: string | null;
  sortOrder: number;
  taxonomyVersion: string;
  translations: readonly Readonly<{ locale: string; displayName: string }>[];
  aliases: readonly string[];
  keywordSummary: Readonly<{
    total: number;
    active: number;
    lexiconVersions: readonly string[];
  }>;
  keywords?: readonly AdminCanonicalTagKeywordView[];
  createdAt: string;
  updatedAt: string;
  lastMutation: AdminTagAuditEntryView | null;
  audit?: readonly AdminTagAuditEntryView[];
}>;

export type AdminCanonicalTagListView = Readonly<{
  items: readonly AdminCanonicalTagView[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  authority: AdminTagAuthorityView;
}>;

export type AdminCanonicalTagDetailView = Readonly<{
  tag: AdminCanonicalTagView;
  authority: AdminTagAuthorityView;
}>;

export type AdminTagMutationResultView = Readonly<{
  id: string;
  updatedAt: string;
  replayed: boolean;
}>;

export type AdminSourceLabelMappingView = Readonly<{
  id: string;
  channel: Readonly<{
    channelAppId: string;
    channelCode: string;
    sourceAppCode: string;
    externalAppId: string;
    active: boolean;
  }>;
  rawLanguageScope: string;
  rawToken: string;
  target: Readonly<{
    id: string;
    stableId: string;
    slug: string;
    active: boolean;
  }>;
  mappingVersion: string;
  active: boolean;
  approvedBy: Readonly<{ id: string; username: string }>;
  approvedAt: string;
  createdAt: string;
  updatedAt: string;
  lastMutation: AdminTagAuditEntryView | null;
  audit?: readonly AdminTagAuditEntryView[];
}>;

export type AdminSourceLabelMappingListView = Readonly<{
  items: readonly AdminSourceLabelMappingView[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}>;

export type AdminResolvedTagView = Readonly<{
  canonicalTagId: string;
  stableId: string;
  slug: string;
  displayName: string;
  provenance: readonly ("manual" | "mapped" | "auto")[];
}>;

export type AdminNovelTagsView = Readonly<{
  mode: "automatic" | "manual";
  revision: string;
  effective: readonly AdminResolvedTagView[];
  manual: readonly AdminResolvedTagView[];
  mapped: readonly AdminResolvedTagView[];
  auto: readonly AdminResolvedTagView[];
  lastManualMutation: AdminTagAuditEntryView | null;
}>;

export type AdminNovelTagMutationResultView = Readonly<{
  mode: "automatic" | "manual";
  revision: string;
  replayed: boolean;
}>;

const AUDIT_KEYS = [
  "status",
  "translations",
  "aliases",
  "keywords",
  "active",
  "mappingVersion",
  "rawLanguageScope",
  "rawToken",
  "canonicalTagId",
  "mode",
  "revision",
] as const;

function copyJson(value: unknown, depth = 0): unknown {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (depth >= 4) return null;
  if (Array.isArray(value)) return Object.freeze(value.slice(0, 200).map((item) => copyJson(item, depth + 1)));
  if (!value || typeof value !== "object") return null;
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) result[key] = copyJson(item, depth + 1);
  return Object.freeze(result);
}

function projectAuditSnapshot(
  input: Readonly<Record<string, unknown>> | null,
): Readonly<Record<string, unknown>> | null {
  if (!input) return null;
  const result: Record<string, unknown> = {};
  for (const key of AUDIT_KEYS) {
    if (Object.prototype.hasOwnProperty.call(input, key)) result[key] = copyJson(input[key]);
  }
  return Object.keys(result).length > 0 ? Object.freeze(result) : null;
}

export function projectAdminTagAuditEntry(input: AdminTagAuditEntry): AdminTagAuditEntryView {
  return Object.freeze({
    action: input.action,
    actorId: input.actorId,
    requestId: input.requestId,
    reason: input.reason,
    before: projectAuditSnapshot(input.before),
    after: projectAuditSnapshot(input.after),
    createdAt: input.createdAt,
  });
}

function projectAuthority(input: AdminTagAuthority): AdminTagAuthorityView {
  return Object.freeze({
    taxonomy: Object.freeze({
      status: input.taxonomy.status,
      canonicalV1Count: input.taxonomy.canonicalV1Count,
      canonicalV1Sha256: input.taxonomy.canonicalV1Sha256,
      databaseActiveCount: input.taxonomy.databaseActiveCount,
      versions: Object.freeze([...input.taxonomy.versions]),
    }),
    keywords: Object.freeze({
      status: input.keywords.status,
      activeKeywordCount: input.keywords.activeKeywordCount,
      versions: Object.freeze([...input.keywords.versions]),
      fingerprint: input.keywords.fingerprint,
      keywordEligibilityVersion: input.keywords.keywordEligibilityVersion,
      keywordEligibilitySha256: input.keywords.keywordEligibilitySha256,
    }),
    classifier: Object.freeze({
      status: input.classifier.status,
      version: input.classifier.version,
      titleWeight: input.classifier.titleWeight,
      descriptionWeight: input.classifier.descriptionWeight,
      threshold: input.classifier.threshold,
      maxTextTags: input.classifier.maxTextTags,
      fingerprint: input.classifier.fingerprint,
    }),
  });
}

function projectKeyword(input: AdminCanonicalTagKeyword): AdminCanonicalTagKeywordView {
  return Object.freeze({
    keywordId: input.keywordId,
    value: input.value,
    scriptBuckets: Object.freeze([...input.scriptBuckets]),
    matchMode: input.matchMode,
    riskFlags: Object.freeze([...input.riskFlags]),
    active: input.active,
    lexiconVersion: input.lexiconVersion,
  });
}

export function projectAdminCanonicalTag(input: AdminCanonicalTagItem): AdminCanonicalTagView {
  const result: {
    id: string;
    stableId: string;
    slug: string;
    active: boolean;
    canonicalDefinition: string;
    facet: string | null;
    sortOrder: number;
    taxonomyVersion: string;
    translations: readonly Readonly<{ locale: string; displayName: string }>[];
    aliases: readonly string[];
    keywordSummary: AdminCanonicalTagView["keywordSummary"];
    keywords?: readonly AdminCanonicalTagKeywordView[];
    createdAt: string;
    updatedAt: string;
    lastMutation: AdminTagAuditEntryView | null;
    audit?: readonly AdminTagAuditEntryView[];
  } = {
    id: input.id,
    stableId: input.stableId,
    slug: input.slug,
    active: input.active,
    canonicalDefinition: input.canonicalDefinition,
    facet: input.facet,
    sortOrder: input.sortOrder,
    taxonomyVersion: input.taxonomyVersion,
    translations: Object.freeze(input.translations.map((item) => Object.freeze({
      locale: item.locale,
      displayName: item.displayName,
    }))),
    aliases: Object.freeze([...input.aliases]),
    keywordSummary: Object.freeze({
      total: input.keywordSummary.total,
      active: input.keywordSummary.active,
      lexiconVersions: Object.freeze([...input.keywordSummary.lexiconVersions]),
    }),
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
    lastMutation: input.lastMutation ? projectAdminTagAuditEntry(input.lastMutation) : null,
  };
  if (input.keywords) result.keywords = Object.freeze(input.keywords.map(projectKeyword));
  if (input.audit) result.audit = Object.freeze(input.audit.map(projectAdminTagAuditEntry));
  return Object.freeze(result);
}

export function projectAdminCanonicalTagList(input: AdminCanonicalTagList): AdminCanonicalTagListView {
  return Object.freeze({
    items: Object.freeze(input.items.map(projectAdminCanonicalTag)),
    page: input.page,
    pageSize: input.pageSize,
    total: input.total,
    totalPages: input.totalPages,
    authority: projectAuthority(input.authority),
  });
}

export function projectAdminCanonicalTagDetail(input: AdminCanonicalTagDetail): AdminCanonicalTagDetailView {
  return Object.freeze({
    tag: projectAdminCanonicalTag(input.tag),
    authority: projectAuthority(input.authority),
  });
}

export function projectAdminTagMutationResult(input: AdminTagAuditMutationResult): AdminTagMutationResultView {
  return Object.freeze({ id: input.id, updatedAt: input.updatedAt, replayed: input.replayed });
}

export function projectAdminSourceLabelMapping(
  input: AdminSourceLabelMappingItem,
): AdminSourceLabelMappingView {
  const result: {
    id: string;
    channel: AdminSourceLabelMappingView["channel"];
    rawLanguageScope: string;
    rawToken: string;
    target: AdminSourceLabelMappingView["target"];
    mappingVersion: string;
    active: boolean;
    approvedBy: AdminSourceLabelMappingView["approvedBy"];
    approvedAt: string;
    createdAt: string;
    updatedAt: string;
    lastMutation: AdminTagAuditEntryView | null;
    audit?: readonly AdminTagAuditEntryView[];
  } = {
    id: input.id,
    channel: Object.freeze({
      channelAppId: input.channel.channelAppId,
      channelCode: input.channel.channelCode,
      sourceAppCode: input.channel.sourceAppCode,
      externalAppId: input.channel.externalAppId,
      active: input.channel.active,
    }),
    rawLanguageScope: input.rawLanguageScope,
    rawToken: input.rawToken,
    target: Object.freeze({
      id: input.target.id,
      stableId: input.target.stableId,
      slug: input.target.slug,
      active: input.target.active,
    }),
    mappingVersion: input.mappingVersion,
    active: input.active,
    approvedBy: Object.freeze({ id: input.approvedBy.id, username: input.approvedBy.username }),
    approvedAt: input.approvedAt,
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
    lastMutation: input.lastMutation ? projectAdminTagAuditEntry(input.lastMutation) : null,
  };
  if (input.audit) result.audit = Object.freeze(input.audit.map(projectAdminTagAuditEntry));
  return Object.freeze(result);
}

export function projectAdminSourceLabelMappingList(
  input: AdminSourceLabelMappingList,
): AdminSourceLabelMappingListView {
  return Object.freeze({
    items: Object.freeze(input.items.map(projectAdminSourceLabelMapping)),
    page: input.page,
    pageSize: input.pageSize,
    total: input.total,
    totalPages: input.totalPages,
  });
}

function projectResolvedTag(input: AdminResolvedTag): AdminResolvedTagView {
  return Object.freeze({
    canonicalTagId: input.canonicalTagId,
    stableId: input.stableId,
    slug: input.slug,
    displayName: input.displayName,
    provenance: Object.freeze([...input.provenance]),
  });
}

export function projectAdminNovelTags(input: AdminNovelTags): AdminNovelTagsView {
  return Object.freeze({
    mode: input.mode,
    revision: input.revision,
    effective: Object.freeze(input.effective.map(projectResolvedTag)),
    manual: Object.freeze(input.manual.map(projectResolvedTag)),
    mapped: Object.freeze(input.mapped.map(projectResolvedTag)),
    auto: Object.freeze(input.auto.map(projectResolvedTag)),
    lastManualMutation: input.lastManualMutation
      ? projectAdminTagAuditEntry(input.lastManualMutation)
      : null,
  });
}

export function projectAdminNovelTagMutationResult(
  input: AdminNovelTagMutationResult,
): AdminNovelTagMutationResultView {
  return Object.freeze({ mode: input.mode, revision: input.revision, replayed: input.replayed });
}
