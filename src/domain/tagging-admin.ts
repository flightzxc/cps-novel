import type { CanonicalTagStatus } from "./database-statuses";

export const ADMIN_TAG_DEFAULT_PAGE_SIZE = 20;
export const ADMIN_TAG_MAX_PAGE_SIZE = 100;
export const ADMIN_TAG_MAX_SEARCH_LENGTH = 160;
export const ADMIN_TAG_AUDIT_LIMIT = 20;

export type AdminTagAuthorityStatus = "READY" | "INCOMPLETE";
export type AdminTagActiveFilter = "all" | "active" | "inactive";

export type AdminTagAuditEntry = Readonly<{
  action: string;
  actorId: string | null;
  requestId: string | null;
  reason: string | null;
  before: Readonly<Record<string, unknown>> | null;
  after: Readonly<Record<string, unknown>> | null;
  createdAt: string;
}>;

export type AdminTagAuthority = Readonly<{
  taxonomy: Readonly<{
    status: AdminTagAuthorityStatus;
    canonicalV1Count: number;
    canonicalV1Sha256: string;
    databaseActiveCount: number;
    versions: readonly string[];
  }>;
  keywords: Readonly<{
    status: AdminTagAuthorityStatus;
    activeKeywordCount: number;
    versions: readonly string[];
    fingerprint: string | null;
  }>;
  classifier: Readonly<{
    status: "OWNER_REVIEW_PENDING" | "FROZEN";
    version: string;
    titleWeight: number | null;
    descriptionWeight: number | null;
    threshold: number | null;
    maxTextTags: number | null;
    fingerprint: string | null;
  }>;
}>;

export type AdminCanonicalTagTranslation = Readonly<{
  locale: string;
  displayName: string;
}>;

export type AdminCanonicalTagKeyword = Readonly<{
  keywordId: string;
  value: string;
  scriptBuckets: readonly string[];
  matchMode: string;
  riskFlags: readonly string[];
  active: boolean;
  lexiconVersion: string;
}>;

export type AdminCanonicalTagKeywordSummary = Readonly<{
  total: number;
  active: number;
  lexiconVersions: readonly string[];
}>;

export type AdminCanonicalTagItem = Readonly<{
  id: string;
  stableId: string;
  slug: string;
  active: boolean;
  canonicalDefinition: string;
  facet: string | null;
  sortOrder: number;
  taxonomyVersion: string;
  translations: readonly AdminCanonicalTagTranslation[];
  aliases: readonly string[];
  keywordSummary: AdminCanonicalTagKeywordSummary;
  keywords?: readonly AdminCanonicalTagKeyword[];
  createdAt: string;
  updatedAt: string;
  lastMutation: AdminTagAuditEntry | null;
  audit?: readonly AdminTagAuditEntry[];
}>;

export type AdminCanonicalTagList = Readonly<{
  items: readonly AdminCanonicalTagItem[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  authority: AdminTagAuthority;
}>;

export type AdminCanonicalTagDetail = Readonly<{
  tag: AdminCanonicalTagItem;
  authority: AdminTagAuthority;
}>;

export type AdminTagPageInput = Readonly<{
  page?: unknown;
  pageSize?: unknown;
  search?: unknown;
  active?: unknown;
}>;

export type AdminCanonicalTagGetInput = AdminTagPageInput & Readonly<{ id?: unknown }>;

export type AdminTagAuditMutationResult = Readonly<{
  id: string;
  updatedAt: string;
  replayed: boolean;
}>;

export type AdminCanonicalTagMutation =
  | Readonly<{
      action: "set_status";
      requestId: string;
      canonicalTagId: string;
      expectedUpdatedAt: string;
      status: CanonicalTagStatus;
    }>
  | Readonly<{
      action: "replace_translations";
      requestId: string;
      canonicalTagId: string;
      expectedUpdatedAt: string;
      translations: readonly AdminCanonicalTagTranslation[];
    }>
  | Readonly<{
      action: "replace_aliases";
      requestId: string;
      canonicalTagId: string;
      expectedUpdatedAt: string;
      aliases: readonly string[];
    }>
  | Readonly<{
      action: "replace_keywords";
      requestId: string;
      canonicalTagId: string;
      expectedUpdatedAt: string;
      keywords: readonly AdminCanonicalTagKeyword[];
    }>;

export type AdminMappingTarget = Readonly<{
  id: string;
  stableId: string;
  slug: string;
  active: boolean;
}>;

export type AdminMappingChannel = Readonly<{
  channelAppId: string;
  channelCode: string;
  sourceAppCode: string;
  externalAppId: string;
  active: boolean;
}>;

export type AdminSourceLabelMappingItem = Readonly<{
  id: string;
  channel: AdminMappingChannel;
  rawLanguageScope: string;
  rawToken: string;
  target: AdminMappingTarget;
  mappingVersion: string;
  active: boolean;
  approvedBy: Readonly<{ id: string; username: string }>;
  approvedAt: string;
  createdAt: string;
  updatedAt: string;
  lastMutation: AdminTagAuditEntry | null;
  audit?: readonly AdminTagAuditEntry[];
}>;

export type AdminSourceLabelMappingList = Readonly<{
  items: readonly AdminSourceLabelMappingItem[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}>;

export type AdminSourceLabelMappingGetInput = AdminTagPageInput & Readonly<{
  id?: unknown;
  channelAppId?: unknown;
  canonicalTagId?: unknown;
  rawLanguageScope?: unknown;
  rawToken?: unknown;
}>;

export type AdminSourceLabelMappingMutation =
  | Readonly<{
      action: "approve_edge";
      requestId: string;
      channelAppId: string;
      rawLanguageScope: string;
      rawToken: string;
      canonicalTagId: string;
      mappingVersion: string;
      expectedUpdatedAt: string | null;
    }>
  | Readonly<{
      action: "deactivate_edge";
      requestId: string;
      mappingId: string;
      expectedUpdatedAt: string;
    }>;

export type AdminResolvedTag = Readonly<{
  canonicalTagId: string;
  stableId: string;
  slug: string;
  displayName: string;
  provenance: readonly ("manual" | "mapped" | "auto")[];
}>;

export type AdminNovelTags = Readonly<{
  mode: "automatic" | "manual";
  revision: string;
  effective: readonly AdminResolvedTag[];
  manual: readonly AdminResolvedTag[];
  mapped: readonly AdminResolvedTag[];
  auto: readonly AdminResolvedTag[];
  lastManualMutation: AdminTagAuditEntry | null;
}>;

export type AdminNovelTagMutation =
  | Readonly<{
      action: "replace_manual";
      requestId: string;
      novelId: string;
      expectedRevision: string;
      canonicalTagIds: readonly string[];
    }>
  | Readonly<{
      action: "exit_manual";
      requestId: string;
      novelId: string;
      expectedRevision: string;
    }>;

export type AdminNovelTagMutationResult = Readonly<{
  mode: "automatic" | "manual";
  revision: string;
  replayed: boolean;
}>;

export const TAGGING_ADMIN_ERROR_CODES = [
  "invalid_tag_request",
  "invalid_canonical_tag",
  "tagging_disabled",
  "tag_write_not_authorized",
  "canonical_tag_not_found",
  "mapping_not_found",
  "novel_not_found",
  "inactive_canonical_tag",
  "alias_collision",
  "keyword_collision",
  "mapping_identity_conflict",
  "revision_conflict",
  "idempotency_conflict",
  "data_invariant_violation",
  "manual_mode_conflict",
] as const;

export type TaggingAdminErrorCode = (typeof TAGGING_ADMIN_ERROR_CODES)[number];
export type TaggingAdminErrorStatus = 400 | 403 | 404 | 409;

export class TaggingAdminError extends Error {
  constructor(
    readonly code: TaggingAdminErrorCode,
    readonly status: TaggingAdminErrorStatus,
    message: string = code,
  ) {
    super(message);
    this.name = "TaggingAdminError";
  }
}
