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
    keywordEligibilityVersion: string;
    keywordEligibilitySha256: string;
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

/**
 * v0.5.15 首页题材导航勾选。全站一份名单（15 个语种共用），一次保存整份：
 * `visibleCanonicalTagIds` 是保存后要在首页显示的分类（只能是启用中的分类），
 * `expectedVisibleCanonicalTagIds` 是页面加载时看到的名单（保存前的现值），库里现值与它不一致就拒绝（409）。
 */
export const ADMIN_HOMEPAGE_NAV_MAX_IDS = 1000;

export type AdminHomepageNavMutation = Readonly<{
  requestId: string;
  visibleCanonicalTagIds: readonly string[];
  expectedVisibleCanonicalTagIds: readonly string[];
}>;

export type AdminHomepageNavMutationResult = Readonly<{
  /** 保存后首页导航勾选的分类数（只算启用中的分类）。 */
  visibleCount: number;
  /** 这次真正改了几个分类的值（没变的不算）。 */
  changedCount: number;
  replayed: boolean;
}>;

/** 面板里的一行：一个启用中的分类，连同帮运营挑选的"书数"信息。 */
export type AdminHomepageNavCandidate = Readonly<{
  id: string;
  slug: string;
  facet: string | null;
  sortOrder: number;
  /** 中文名；没有 zh 译名时为 null（面板再回落 en 名、再回落 slug）。 */
  zhName: string | null;
  enName: string | null;
  isHomepageVisible: boolean;
  /** 英语里列表可见的书数（取自每语种每分类本数矩阵，最多晚 60 秒）。 */
  enBookCount: number;
  /** 有书的语种数（同一份矩阵）。 */
  localeCount: number;
}>;

export type AdminHomepageNavCandidates = Readonly<{
  items: readonly AdminHomepageNavCandidate[];
  visibleCount: number;
  /** 最近几次"首页导航"保存记录（新的在前），面板折叠区展示。 */
  audit: readonly AdminTagAuditEntry[];
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
  // v0.5.15 首页题材导航勾选：名单已被别人改过（409）/ 名单里有不存在或已停用的分类（400）。
  "homepage_nav_conflict",
  "invalid_homepage_nav",
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
