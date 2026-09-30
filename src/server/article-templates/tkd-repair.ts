/**
 * 模板 SEO 字段回写工具（TKD 对齐 CPS，Owner 2026-09-30，施工工单第五块）。
 *
 * 默认模板的 `seoTemplate.metaTitle` 改成自然语言之后（`assets/article-templates/*.json`，原地更新，
 * 不发新版本），新文章自动用新模板；**存量文章**的 `Article.seoMetadata.metaTitle` 还是旧值（书名），
 * 要靠这个工具批量刷新。照 CPS `src/lib/template-tkd-repair.ts` + `scripts/repair-template-tkd.ts`
 * 的形状（`docs/governance/port-registry.md` 登记），简化掉海阅用不到的部分（关键词、"空模板列是否
 * 走兜底渲染"——本仓引擎没有任何兜底，模板没写的槽位就是不写），**安全闸一条不少**：
 *
 *  1. 默认只预演，不写库；`--apply` 才写。
 *  2. 单批 ≤ 200 篇（`--limit`/`--article-ids` 都封顶；`--all-linked` 只能预演，不能与 `--apply` 同用）。
 *  3. 执行前先写备份文件（绝对路径、独占创建、fsync 后才动库）；批内任何一条 CAS 失败整批回滚。
 *  4. 必须传预期篇数（`--expected-count`），与本批预演出的"会变化的篇数"不符就停。
 *  5. 排除清单（`--generate-exclusion-file` 生成 -> 运营把 `auto-generated` 理由改成真实理由 = 签字 ->
 *     `--exclude-article-ids-file` 生效，哈希钉死、逐条校验未过期）与执行清单（`--generate-execution-manifest`
 *     冻结整轮的模板内容哈希/目标篇数/排除集；每批写库前逐项对账，模板中途被改就停）。
 *  6. 每批在同一事务里写一条 `OperationAudit`（`article.template_tkd_repair`），带操作人/理由/备份哈希/
 *     执行清单哈希；`--apply` 必须给 `--operator` 与 `--reason`。
 *  7. 续跑游标（`--cursor-file`）每批落盘：下一批的 `--after-id` 必须等于游标里的上次终点，
 *     不会漏批也不会重批；备份文件独占创建，天然按批隔离。
 *  8. 写库只用能改文章的数据库角色，不用前台应用角色（`web_app`）跑：`--apply`/`--restore-from` 前先查
 *     `current_user` 与 `has_table_privilege`，`web_app` 直接拒绝。推荐 `worker_app`
 *     （`infra/postgres/grants.sql`：`article` INSERT/UPDATE、`operation_audit` INSERT、相关表 SELECT）。
 *  9. `--restore-from` 用备份回滚，且只在文章当前值仍等于回写后的值时才回滚（运营中途改过就拒绝覆盖）。
 *
 * 范围：按模板（每个语种的默认模板）取其关联的全部未删除文章（`Article.templateId = 该模板`），
 * **自动跳过 `contentMode = "manual"`**（后台编辑一保存就标 manual，见 `articles/service.ts` 的
 * `updateArticleContent`）。只写 `Article.seoMetadata` 里的 `metaTitle`/`metaDescription` 两个键，其它键
 * （例如 `coverUrl`、`metaKeywords`）原样保留；不碰 `title`/`body`/`slug`/`contentMode`/`templateId`。
 *
 * 渲染**必须**走文章创建时的同一个函数与同一套取值（`renderNovelArticleDraft`，`generate.ts` 也用它），
 * 不得另写一套兜底——`tests/backend/article-templates/tkd-repair.test.ts` 有静态扫描守着这一条。
 */
import { createHash } from "node:crypto";
import { open, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { Prisma, type PrismaClient } from "@prisma/client";

import { SITE_LOCALES } from "@/lib/locale/locale-canonical";
import { isTemplateRenderError, type ArticleTemplateSource } from "@/lib/seo/template";
import { countPreviewChapters, renderNovelArticleDraft } from "@/server/content-creation/render-novel-article";

import { ArticleTemplateInputError, validateStoredArticleTemplate } from "./service";

export const TEMPLATE_TKD_BACKUP_VERSION = 1 as const;
export const TEMPLATE_TKD_EXCLUSION_FILE_VERSION = 1 as const;
export const TEMPLATE_TKD_EXECUTION_MANIFEST_VERSION = 1 as const;
export const TEMPLATE_TKD_CURSOR_VERSION = 1 as const;
export const TEMPLATE_TKD_MAX_BATCH_LIMIT = 200;
export const TEMPLATE_TKD_APPLY_AUDIT_ACTION = "article.template_tkd_repair";
export const TEMPLATE_TKD_RESTORE_AUDIT_ACTION = "article.template_tkd_restore";
/** 回写只碰这两个键，别的键一律原样保留。 */
export const TEMPLATE_TKD_FIELDS = ["metaTitle", "metaDescription"] as const;
/** 全量扫描（预演）时内部分页大小，避免一次读入整个语种的文章。 */
const SCAN_PAGE_SIZE = 500;
/** 前台应用角色：不得执行回写（施工工单第五块"不要用前台应用角色跑"）。 */
export const TEMPLATE_TKD_FORBIDDEN_ROLE = "web_app";

export type TemplateTkdField = (typeof TEMPLATE_TKD_FIELDS)[number];

/** 文章 `seoMetadata` 里这两个键的当前值；`null` = 键不存在（或不是字符串）。 */
export type TemplateTkdValues = { metaTitle: string | null; metaDescription: string | null };

export type TemplateTkdChange = {
  articleId: string;
  locale: string;
  slug: string;
  status: string;
  before: TemplateTkdValues;
  after: TemplateTkdValues;
  /** 读到这篇文章时的 `updatedAt`（ISO），写库时作为 CAS 条件，防止读-写之间被运营改掉。 */
  readUpdatedAt: string;
  /** 读到时的完整 `seoMetadata`，备份文件里留一份，回滚与事后核对用。 */
  beforeSeoMetadata: Record<string, unknown>;
};

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return isString(value) && UUID_PATTERN.test(value);
}

export function hasTemplateTkdChange(before: TemplateTkdValues, after: TemplateTkdValues): boolean {
  return before.metaTitle !== after.metaTitle || before.metaDescription !== after.metaDescription;
}

export function readTemplateTkdValues(seoMetadata: unknown): TemplateTkdValues {
  const record = isPlainObject(seoMetadata) ? seoMetadata : {};
  return {
    metaTitle: isString(record.metaTitle) ? record.metaTitle : null,
    metaDescription: isString(record.metaDescription) ? record.metaDescription : null,
  };
}

/**
 * 只改 `metaTitle`/`metaDescription` 两个键：`values[field] === null` 表示该键应不存在（回滚到"原本没有"），
 * 其余键（`coverUrl` 等）原样带过。纯函数，不改入参。
 */
export function mergeTemplateTkdIntoSeoMetadata(
  seoMetadata: Record<string, unknown>,
  values: TemplateTkdValues,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...seoMetadata };
  for (const field of TEMPLATE_TKD_FIELDS) {
    const value = values[field];
    if (value === null) delete merged[field];
    else merged[field] = value;
  }
  return merged;
}

// ---------------------------------------------------------------------------
// CLI 参数与闸门（纯函数）
// ---------------------------------------------------------------------------

export type TemplateTkdScopeArgs = {
  allLinked: boolean;
  /** 本次是否 `--apply`。`--all-linked` 只能预演。 */
  apply: boolean;
  afterId?: string;
  limit?: number;
  articleIds?: string[];
};

/**
 * 批范围三选一：`--all-linked`（只能预演）、`--article-ids`（≤200）、`--after-id/--limit`
 * （必须显式 `--limit`，1..200，`--after-id` 是上一批的终点 UUID）。任何一次运行都不可能一次写无限多篇。
 */
export function assertTemplateTkdScopeArgs(input: TemplateTkdScopeArgs): void {
  const hasArticleIds = (input.articleIds?.length ?? 0) > 0;
  const hasBatchArgs = input.afterId !== undefined || input.limit !== undefined;
  const modesSelected = [input.allLinked, hasBatchArgs, hasArticleIds].filter(Boolean).length;

  if (modesSelected === 0) {
    throw new Error("Repair requires exactly one scope: --all-linked, --article-ids=<uuids>, or --after-id/--limit");
  }
  if (modesSelected > 1) {
    throw new Error("--all-linked, --article-ids, and --after-id/--limit are mutually exclusive");
  }
  if (input.allLinked && input.apply) {
    throw new Error(
      "--all-linked cannot be combined with --apply; --all-linked is dry-run/audit only — apply must use --after-id/--limit or --article-ids so a single run never writes an unbounded batch",
    );
  }
  if (hasArticleIds) {
    if (input.articleIds!.length > TEMPLATE_TKD_MAX_BATCH_LIMIT) {
      throw new Error(`--article-ids must not list more than ${TEMPLATE_TKD_MAX_BATCH_LIMIT} ids (found ${input.articleIds!.length})`);
    }
    const bad = input.articleIds!.filter((id) => !isUuid(id));
    if (bad.length > 0) throw new Error(`--article-ids must be UUIDs; invalid: ${bad.slice(0, 3).join(", ")}`);
  }
  if (hasBatchArgs) {
    if (input.limit === undefined) {
      throw new Error(`Batch scope requires --limit=<1..${TEMPLATE_TKD_MAX_BATCH_LIMIT}>`);
    }
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > TEMPLATE_TKD_MAX_BATCH_LIMIT) {
      throw new Error(`--limit must be an integer between 1 and ${TEMPLATE_TKD_MAX_BATCH_LIMIT}`);
    }
    if (input.afterId !== undefined && !isUuid(input.afterId)) {
      throw new Error("--after-id must be an article UUID (the last id printed as nextAfterId by the previous batch)");
    }
  }
}

/**
 * `--apply` 的前置闸门：单一语种、预期篇数、实际篇数相符、不超单批上限、备份路径是绝对路径、
 * 有操作人与理由。任何一条不满足就停，不写库、不写备份。
 */
export function assertTemplateTkdApplyGuard(input: {
  apply: boolean;
  locale?: string;
  expectedCount?: number;
  actualCount: number;
  backupPath?: string;
  operator?: string;
  reason?: string;
}): void {
  if (!input.apply) return;
  if (!input.locale) throw new Error("--apply requires exactly one --locale");
  if (!Number.isInteger(input.expectedCount) || input.expectedCount! < 0) {
    throw new Error("--apply requires --expected-count=<dry-run changed count>");
  }
  if (input.expectedCount !== input.actualCount) {
    throw new Error(`Expected ${input.expectedCount} changed articles, but current dry-run found ${input.actualCount}`);
  }
  if (input.actualCount > TEMPLATE_TKD_MAX_BATCH_LIMIT) {
    throw new Error(
      `--apply cannot write more than ${TEMPLATE_TKD_MAX_BATCH_LIMIT} articles in a single transaction (found ${input.actualCount}); use --after-id/--limit or --article-ids to batch it`,
    );
  }
  if (!input.backupPath || !path.isAbsolute(input.backupPath)) {
    throw new Error("--apply requires --backup=<absolute JSON path>");
  }
  if (!input.operator?.trim()) throw new Error("--apply requires --operator=<who is running this>");
  if (!input.reason?.trim()) throw new Error("--apply requires --reason=<approval reference / why>");
}

/** 写库/回滚用的角色闸门：拒绝前台应用角色，且必须真有 `article` UPDATE 与 `operation_audit` INSERT 权限。 */
export function assertTemplateTkdDbRole(role: { currentUser: string; canUpdateArticle: boolean; canInsertAudit: boolean }): void {
  if (role.currentUser === TEMPLATE_TKD_FORBIDDEN_ROLE) {
    throw new Error(
      `Refusing to write as the front-end application role "${TEMPLATE_TKD_FORBIDDEN_ROLE}"; run the repair with the worker role (worker_app) instead`,
    );
  }
  if (!role.canUpdateArticle) {
    throw new Error(`Database role "${role.currentUser}" has no UPDATE privilege on article; cannot apply the repair`);
  }
  if (!role.canInsertAudit) {
    throw new Error(`Database role "${role.currentUser}" has no INSERT privilege on operation_audit; refusing to write without an audit trail`);
  }
}

export async function loadTemplateTkdDbRole(db: Pick<PrismaClient, "$queryRaw">) {
  const rows = await db.$queryRaw<Array<{ current_user: string; can_update_article: boolean; can_insert_audit: boolean }>>`
    SELECT current_user,
           has_table_privilege(current_user, 'public.article', 'UPDATE') AS can_update_article,
           has_table_privilege(current_user, 'public.operation_audit', 'INSERT') AS can_insert_audit
  `;
  const row = rows[0];
  if (!row) throw new Error("could not read current_user / table privileges");
  return { currentUser: row.current_user, canUpdateArticle: row.can_update_article, canInsertAudit: row.can_insert_audit };
}

// ---------------------------------------------------------------------------
// 模板内容哈希（执行清单的漂移守卫）
// ---------------------------------------------------------------------------

export type TemplateContentHashes = {
  titleTemplate: string;
  bodyTemplate: string;
  slugTemplate: string;
  metaTitleTemplate: string;
  metaDescTemplate: string;
  metaKeywordsTemplate: string;
};

const TEMPLATE_CONTENT_HASH_FIELDS = [
  "titleTemplate",
  "bodyTemplate",
  "slugTemplate",
  "metaTitleTemplate",
  "metaDescTemplate",
  "metaKeywordsTemplate",
] as const satisfies readonly (keyof TemplateContentHashes)[];

export function computeTemplateContentHashes(template: {
  bodyTemplate: string;
  seoTemplate: unknown;
  slugTemplate: string;
  metaKeywordsTemplate: string;
}): TemplateContentHashes {
  const seo = isPlainObject(template.seoTemplate) ? template.seoTemplate : {};
  const text = (value: unknown) => (isString(value) ? value : "");
  return {
    titleTemplate: sha256Hex(text(seo.title)),
    bodyTemplate: sha256Hex(template.bodyTemplate),
    slugTemplate: sha256Hex(template.slugTemplate),
    metaTitleTemplate: sha256Hex(text(seo.metaTitle)),
    metaDescTemplate: sha256Hex(text(seo.metaDescription)),
    metaKeywordsTemplate: sha256Hex(template.metaKeywordsTemplate),
  };
}

// ---------------------------------------------------------------------------
// 排除清单：工具生成 -> 运营签字（把 auto-generated 理由改成真实理由）-> 生效
// ---------------------------------------------------------------------------

/** `manual` = 运营手改过的文章（工具本来就自动跳过，列出来是为了让运营签字确认）；`locale_mismatch` = 文章语种与模板语种不符。 */
export type ExcludedArticleKind = "manual" | "locale_mismatch";

export type ExcludedArticleEntry = {
  articleId: string;
  kind: ExcludedArticleKind;
  locale: string;
  reason: string;
};

export type TemplateTkdExclusionFile = {
  version: typeof TEMPLATE_TKD_EXCLUSION_FILE_VERSION;
  generatedAt: string;
  templateKey: string;
  templateVersion: number;
  sha256: string;
  entries: ExcludedArticleEntry[];
};

/**
 * `--generate-exclusion-file` 给每条都盖这个标记，签字前必须改成真实理由：否则"生成后直接拿去用"
 * 会悄悄排除没人看过的文章。任何条目的 `reason` 里仍含它就拒绝使用。
 */
export const TEMPLATE_TKD_AUTO_EXCLUSION_REASON_MARKER = "auto-generated";

export function hashExcludedEntries(entries: ExcludedArticleEntry[]): string {
  const sorted = [...entries].sort((a, b) => (a.articleId < b.articleId ? -1 : a.articleId > b.articleId ? 1 : 0));
  return sha256Hex(sorted.map((entry) => `${entry.articleId}|${entry.kind}|${entry.locale}|${entry.reason}`).join("\n"));
}

export function hashArticleIdList(ids: string[]): string {
  return sha256Hex([...new Set(ids)].sort().join(","));
}

export function buildTemplateTkdExclusionFile(input: {
  templateKey: string;
  templateVersion: number;
  entries: ExcludedArticleEntry[];
  generatedAt?: string;
}): TemplateTkdExclusionFile {
  return {
    version: TEMPLATE_TKD_EXCLUSION_FILE_VERSION,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    templateKey: input.templateKey,
    templateVersion: input.templateVersion,
    sha256: hashExcludedEntries(input.entries),
    entries: input.entries,
  };
}

function parseExcludedEntries(raw: unknown[], where: string): ExcludedArticleEntry[] {
  const entries = raw.map((value, index) => {
    if (!isPlainObject(value)) throw new Error(`Invalid ${where} entry at index ${index}`);
    if (!isUuid(value.articleId) || (value.kind !== "manual" && value.kind !== "locale_mismatch") || !isString(value.locale) || !isString(value.reason)) {
      throw new Error(`Invalid ${where} entry at index ${index}`);
    }
    return { articleId: value.articleId.toLowerCase(), kind: value.kind, locale: value.locale, reason: value.reason } satisfies ExcludedArticleEntry;
  });
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.articleId)) throw new Error(`Invalid ${where}: duplicate article ${entry.articleId}`);
    seen.add(entry.articleId);
  }
  return entries;
}

export function parseTemplateTkdExclusionFile(value: unknown): TemplateTkdExclusionFile {
  if (!isPlainObject(value)) throw new Error("Invalid exclusion file: expected an object");
  if (
    value.version !== TEMPLATE_TKD_EXCLUSION_FILE_VERSION ||
    !isString(value.generatedAt) ||
    !isString(value.templateKey) ||
    !Number.isInteger(value.templateVersion) ||
    !isString(value.sha256) ||
    !Array.isArray(value.entries)
  ) {
    throw new Error("Invalid exclusion file header");
  }
  return {
    version: TEMPLATE_TKD_EXCLUSION_FILE_VERSION,
    generatedAt: value.generatedAt,
    templateKey: value.templateKey,
    templateVersion: value.templateVersion as number,
    sha256: value.sha256,
    entries: parseExcludedEntries(value.entries, "exclusion file"),
  };
}

/** 重算哈希：文件被手改却没重算哈希、或损坏，都会被发现。 */
export function validateTemplateTkdExclusionFileHash(file: TemplateTkdExclusionFile): string[] {
  return hashExcludedEntries(file.entries) === file.sha256
    ? []
    : ["exclusion file hash mismatch: recorded sha256 does not match its entries (file may be corrupted or hand-edited without recomputing the hash)"];
}

/** 还带着 auto-generated 占位理由的条目 = 没有人签字，拒绝使用。 */
export function validateTemplateTkdExclusionEntriesReviewed(entries: ExcludedArticleEntry[]): string[] {
  const unreviewed = entries.filter((entry) => entry.reason.includes(TEMPLATE_TKD_AUTO_EXCLUSION_REASON_MARKER));
  if (unreviewed.length === 0) return [];
  return [
    `exclusion list not reviewed: ${unreviewed.length} ${unreviewed.length === 1 ? "entry" : "entries"} for article id(s) ${unreviewed
      .slice(0, 5)
      .map((entry) => entry.articleId)
      .join(", ")}${unreviewed.length > 5 ? ", ..." : ""} still carry the "${TEMPLATE_TKD_AUTO_EXCLUSION_REASON_MARKER}" placeholder reason — edit "reason" to a real justification (that is the sign-off) before using --exclude-article-ids-file`,
  ];
}

// ---------------------------------------------------------------------------
// 执行清单：冻结整轮的模板内容 + 目标篇数 + 排除集，每批写库前逐项对账
// ---------------------------------------------------------------------------

export type TemplateTkdExecutionManifest = {
  version: typeof TEMPLATE_TKD_EXECUTION_MANIFEST_VERSION;
  generatedAt: string;
  template: {
    id: string;
    templateKey: string;
    version: number;
    locale: string;
    updatedAt: string;
    contentHashes: TemplateContentHashes;
  };
  /** 冻结时哪些键会被写（模板定义了哪些槽位）；整轮必须一致。 */
  activeFields: TemplateTkdField[];
  /** 冻结时刻；此后新建的文章不在本轮范围（它们本来就是按新模板创建的）。 */
  createdAtCutoff: string;
  targetArticleIds: { count: number; sha256: string; ids: string[] };
  excludedArticleIds: { count: number; sha256: string; entries: ExcludedArticleEntry[] };
};

export function buildTemplateTkdExecutionManifest(input: {
  template: {
    id: string;
    templateKey: string;
    version: number;
    locale: string;
    updatedAt: Date | string;
    bodyTemplate: string;
    seoTemplate: unknown;
    slugTemplate: string;
    metaKeywordsTemplate: string;
  };
  activeFields: TemplateTkdField[];
  createdAtCutoff: Date | string;
  targetArticleIds: string[];
  excludedEntries: ExcludedArticleEntry[];
  generatedAt?: string;
}): TemplateTkdExecutionManifest {
  const iso = (value: Date | string) => (value instanceof Date ? value.toISOString() : value);
  const sortedTargetIds = [...new Set(input.targetArticleIds)].sort();
  return {
    version: TEMPLATE_TKD_EXECUTION_MANIFEST_VERSION,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    template: {
      id: input.template.id,
      templateKey: input.template.templateKey,
      version: input.template.version,
      locale: input.template.locale,
      updatedAt: iso(input.template.updatedAt),
      contentHashes: computeTemplateContentHashes(input.template),
    },
    activeFields: [...input.activeFields],
    createdAtCutoff: iso(input.createdAtCutoff),
    targetArticleIds: { count: sortedTargetIds.length, sha256: hashArticleIdList(sortedTargetIds), ids: sortedTargetIds },
    excludedArticleIds: {
      count: input.excludedEntries.length,
      sha256: hashExcludedEntries(input.excludedEntries),
      entries: input.excludedEntries,
    },
  };
}

export function parseTemplateTkdExecutionManifest(value: unknown): TemplateTkdExecutionManifest {
  if (!isPlainObject(value)) throw new Error("Invalid execution manifest: expected an object");
  const template = isPlainObject(value.template) ? value.template : null;
  const hashes = template && isPlainObject(template.contentHashes) ? template.contentHashes : null;
  const targets = isPlainObject(value.targetArticleIds) ? value.targetArticleIds : null;
  const excluded = isPlainObject(value.excludedArticleIds) ? value.excludedArticleIds : null;
  if (
    value.version !== TEMPLATE_TKD_EXECUTION_MANIFEST_VERSION ||
    !isString(value.generatedAt) ||
    !Array.isArray(value.activeFields) ||
    !value.activeFields.every((field) => (TEMPLATE_TKD_FIELDS as readonly string[]).includes(field as string)) ||
    !isString(value.createdAtCutoff) ||
    !template ||
    !isString(template.id) ||
    !isString(template.templateKey) ||
    !Number.isInteger(template.version) ||
    !isString(template.locale) ||
    !isString(template.updatedAt) ||
    !hashes ||
    !TEMPLATE_CONTENT_HASH_FIELDS.every((field) => isString(hashes[field])) ||
    !targets ||
    !Number.isInteger(targets.count) ||
    !isString(targets.sha256) ||
    !Array.isArray(targets.ids) ||
    !targets.ids.every(isUuid) ||
    !excluded ||
    !Number.isInteger(excluded.count) ||
    !isString(excluded.sha256) ||
    !Array.isArray(excluded.entries)
  ) {
    throw new Error("Invalid execution manifest header");
  }
  return {
    version: TEMPLATE_TKD_EXECUTION_MANIFEST_VERSION,
    generatedAt: value.generatedAt,
    template: {
      id: template.id as string,
      templateKey: template.templateKey as string,
      version: template.version as number,
      locale: template.locale as string,
      updatedAt: template.updatedAt as string,
      contentHashes: Object.fromEntries(TEMPLATE_CONTENT_HASH_FIELDS.map((field) => [field, hashes[field] as string])) as TemplateContentHashes,
    },
    activeFields: value.activeFields as TemplateTkdField[],
    createdAtCutoff: value.createdAtCutoff,
    targetArticleIds: { count: targets.count as number, sha256: targets.sha256 as string, ids: targets.ids as string[] },
    excludedArticleIds: {
      count: excluded.count as number,
      sha256: excluded.sha256 as string,
      entries: parseExcludedEntries(excluded.entries, "execution manifest"),
    },
  };
}

/** 防篡改：清单里记录的 id 列表/排除集的哈希，必须与它自己的内容重算一致。 */
export function validateTemplateTkdExecutionManifestIntegrity(manifest: TemplateTkdExecutionManifest): string[] {
  const reasons: string[] = [];
  if (manifest.targetArticleIds.count !== manifest.targetArticleIds.ids.length) {
    reasons.push("execution manifest corrupted: targetArticleIds.count does not match the number of recorded ids");
  }
  if (hashArticleIdList(manifest.targetArticleIds.ids) !== manifest.targetArticleIds.sha256) {
    reasons.push("execution manifest corrupted: targetArticleIds hash does not match its recorded ids");
  }
  if (hashExcludedEntries(manifest.excludedArticleIds.entries) !== manifest.excludedArticleIds.sha256) {
    reasons.push("execution manifest corrupted: excludedArticleIds hash does not match its recorded entries");
  }
  return reasons;
}

/** 每批的漂移守卫：模板必须仍是清单冻结时那一份，且这批文章都在冻结的目标集里。 */
export function validateExecutionManifestAgainstPlan(
  manifest: TemplateTkdExecutionManifest,
  plan: Pick<TemplateTkdRepairPlan, "template" | "activeFields" | "fetchedArticleIds">,
): string[] {
  const reasons: string[] = [];
  if (manifest.template.id !== plan.template.id || manifest.template.templateKey !== plan.template.templateKey || manifest.template.version !== plan.template.version) {
    return [
      `execution manifest identity mismatch: manifest is for template ${manifest.template.templateKey} v${manifest.template.version} (${manifest.template.id}), live template is ${plan.template.templateKey} v${plan.template.version} (${plan.template.id})`,
    ];
  }
  if (manifest.template.updatedAt !== plan.template.updatedAt) {
    reasons.push(`execution manifest stale: template.updatedAt changed (manifest=${manifest.template.updatedAt}, live=${plan.template.updatedAt})`);
  }
  for (const field of TEMPLATE_CONTENT_HASH_FIELDS) {
    if (plan.template.contentHashes[field] !== manifest.template.contentHashes[field]) {
      reasons.push(`execution manifest stale: template.${field} content changed since the manifest was generated`);
    }
  }
  if (JSON.stringify([...manifest.activeFields].sort()) !== JSON.stringify([...plan.activeFields].sort())) {
    reasons.push(`execution manifest drift: template SEO slots now write [${plan.activeFields.join(",")}] but the manifest froze [${manifest.activeFields.join(",")}]`);
  }
  const targetSet = new Set(manifest.targetArticleIds.ids);
  const outOfScope = plan.fetchedArticleIds.filter((id) => !targetSet.has(id));
  if (outOfScope.length > 0) {
    reasons.push(`execution manifest drift: article id(s) not in the recorded target set (linked to the template after the manifest was generated?): ${outOfScope.slice(0, 5).join(", ")}${outOfScope.length > 5 ? ", ..." : ""}`);
  }
  return reasons;
}

/** 独立传入的排除清单必须与清单里冻结的那份逐字一致。 */
export function validateExecutionManifestExclusionScope(
  manifest: TemplateTkdExecutionManifest,
  exclusionFile: TemplateTkdExclusionFile | undefined,
): string[] {
  if (!exclusionFile) return [];
  return exclusionFile.sha256 === manifest.excludedArticleIds.sha256
    ? []
    : ["exclusion file drift: --exclude-article-ids-file content no longer matches the execution manifest's recorded exclusion set"];
}

// ---------------------------------------------------------------------------
// 续跑游标
// ---------------------------------------------------------------------------

export type TemplateTkdCursor = {
  version: typeof TEMPLATE_TKD_CURSOR_VERSION;
  templateKey: string;
  templateVersion: number;
  executionManifestSha256: string;
  lastAfterId: string | null;
  appliedTotal: number;
  batchesApplied: number;
  updatedAt: string;
};

export function parseTemplateTkdCursor(value: unknown): TemplateTkdCursor {
  if (
    !isPlainObject(value) ||
    value.version !== TEMPLATE_TKD_CURSOR_VERSION ||
    !isString(value.templateKey) ||
    !Number.isInteger(value.templateVersion) ||
    !isString(value.executionManifestSha256) ||
    !(value.lastAfterId === null || isUuid(value.lastAfterId)) ||
    !Number.isInteger(value.appliedTotal) ||
    !Number.isInteger(value.batchesApplied) ||
    !isString(value.updatedAt)
  ) {
    throw new Error("Invalid cursor file");
  }
  return value as unknown as TemplateTkdCursor;
}

/**
 * 续跑对账：这一批的 `--after-id` 必须恰好是游标记录的上次终点（首批没有游标文件时不能带 `--after-id`），
 * 且游标属于同一份执行清单——不会漏批，也不会重批，更不会把上一轮的游标带进这一轮。
 */
export function validateTemplateTkdCursor(input: {
  cursor: TemplateTkdCursor | null;
  afterId?: string;
  templateKey: string;
  templateVersion: number;
  executionManifestSha256: string;
}): string[] {
  const { cursor } = input;
  if (cursor === null) {
    return input.afterId === undefined ? [] : [`cursor file does not exist yet, so the first batch must not pass --after-id (got ${input.afterId})`];
  }
  const reasons: string[] = [];
  if (cursor.templateKey !== input.templateKey || cursor.templateVersion !== input.templateVersion) {
    reasons.push(`cursor file belongs to template ${cursor.templateKey} v${cursor.templateVersion}, not ${input.templateKey} v${input.templateVersion}`);
  }
  if (cursor.executionManifestSha256 !== input.executionManifestSha256) {
    reasons.push("cursor file belongs to a different execution manifest (a different round); use a fresh --cursor-file per round");
  }
  if ((cursor.lastAfterId ?? undefined) !== input.afterId) {
    reasons.push(`--after-id (${input.afterId ?? "none"}) does not match the cursor's last batch end (${cursor.lastAfterId ?? "none"}); refusing to skip or repeat a batch`);
  }
  return reasons;
}

// ---------------------------------------------------------------------------
// 备份
// ---------------------------------------------------------------------------

export type TemplateTkdBackup = {
  version: typeof TEMPLATE_TKD_BACKUP_VERSION;
  generatedAt: string;
  template: { id: string; templateKey: string; version: number; locale: string };
  changes: TemplateTkdChange[];
};

function isTkdValues(value: unknown): value is TemplateTkdValues {
  return isPlainObject(value) && (value.metaTitle === null || isString(value.metaTitle)) && (value.metaDescription === null || isString(value.metaDescription));
}

export function parseTemplateTkdBackup(value: unknown): TemplateTkdBackup {
  if (!isPlainObject(value)) throw new Error("Invalid TKD backup: expected an object");
  const template = isPlainObject(value.template) ? value.template : null;
  if (
    value.version !== TEMPLATE_TKD_BACKUP_VERSION ||
    !isString(value.generatedAt) ||
    !template ||
    !isString(template.id) ||
    !isString(template.templateKey) ||
    !Number.isInteger(template.version) ||
    !isString(template.locale) ||
    !Array.isArray(value.changes)
  ) {
    throw new Error("Invalid TKD backup header");
  }
  const changes = value.changes.map((raw, index) => {
    if (
      !isPlainObject(raw) ||
      !isUuid(raw.articleId) ||
      !isString(raw.locale) ||
      !isString(raw.slug) ||
      !isString(raw.status) ||
      !isTkdValues(raw.before) ||
      !isTkdValues(raw.after) ||
      !isString(raw.readUpdatedAt) ||
      !isPlainObject(raw.beforeSeoMetadata)
    ) {
      throw new Error(`Invalid TKD backup change at index ${index}`);
    }
    return raw as unknown as TemplateTkdChange;
  });
  const seen = new Set<string>();
  for (const change of changes) {
    if (seen.has(change.articleId)) throw new Error(`Invalid TKD backup: duplicate article ${change.articleId}`);
    if (change.locale !== template.locale) throw new Error(`Invalid TKD backup: article ${change.articleId} locale does not match template`);
    seen.add(change.articleId);
  }
  return {
    version: TEMPLATE_TKD_BACKUP_VERSION,
    generatedAt: value.generatedAt,
    template: { id: template.id as string, templateKey: template.templateKey as string, version: template.version as number, locale: template.locale as string },
    changes,
  };
}

/** 独占创建（`wx`：文件已存在就报错，绝不覆盖上一批的备份）+ fsync，之后才允许动库。返回内容哈希。 */
export async function writeExclusiveJsonFile(filePath: string, contents: unknown): Promise<string> {
  if (!path.isAbsolute(filePath)) throw new Error(`${filePath} must be an absolute path`);
  const text = `${JSON.stringify(contents, null, 2)}\n`;
  const handle = await open(filePath, "wx");
  try {
    await handle.writeFile(text, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  return sha256Hex(text);
}

// ---------------------------------------------------------------------------
// 计划：取一批 -> 渲染 -> 校验
// ---------------------------------------------------------------------------

export type TemplateTkdDb = Pick<PrismaClient, "articleTemplate" | "article" | "novelChapter" | "operationAudit" | "$transaction" | "$queryRaw">;

const templateSelect = {
  id: true,
  templateKey: true,
  templateName: true,
  locale: true,
  version: true,
  schemaVersion: true,
  status: true,
  applicableArticleType: true,
  bodyTemplate: true,
  seoTemplate: true,
  slugTemplate: true,
  metaKeywordsTemplate: true,
  updatedAt: true,
  deletedAt: true,
} as const;

export type TemplateTkdTemplateRow = Prisma.ArticleTemplateGetPayload<{ select: typeof templateSelect }>;

export async function loadTemplateForTkdRepair(
  db: Pick<PrismaClient, "articleTemplate">,
  input: { templateKey: string; templateVersion: number },
): Promise<TemplateTkdTemplateRow> {
  const template = await db.articleTemplate.findUnique({
    where: { templateKey_version: { templateKey: input.templateKey, version: input.templateVersion } },
    select: templateSelect,
  });
  if (!template || template.deletedAt !== null) {
    throw new Error(`Template not found or deleted: ${input.templateKey} v${input.templateVersion}`);
  }
  if (template.applicableArticleType !== "novel_article" && template.applicableArticleType !== "any") {
    throw new Error(`Template ${template.templateKey} is ${template.applicableArticleType}, expected novel_article`);
  }
  if (!(SITE_LOCALES as readonly string[]).includes(template.locale)) {
    throw new Error(`Template ${template.templateKey} locale "${template.locale}" is not a registered SITE_LOCALE`);
  }
  return template;
}

const articleRepairSelect = {
  id: true,
  locale: true,
  slug: true,
  status: true,
  articleType: true,
  contentMode: true,
  seoMetadata: true,
  updatedAt: true,
  novel: { select: { id: true, title: true, description: true, coverUrl: true, totalChapterCount: true } },
  promoLink: { select: { publicRedirectCode: true } },
} as const;

type ArticleRepairRow = Prisma.ArticleGetPayload<{ select: typeof articleRepairSelect }>;

export type TemplateTkdRepairScope = {
  /** 上一批的终点 UUID（不含）。 */
  afterId?: string;
  limit?: number;
  articleIds?: string[];
  /** 只看这个时刻及之前创建的文章（执行清单冻结的 cutoff）。 */
  createdAtCutoff?: Date;
  /** `--all-linked`：内部分页读完整个模板的关联文章（只用于预演）。 */
  allLinked?: boolean;
};

export type TemplateTkdSkippedArticle = { articleId: string; locale: string; slug: string; status: string };

export type TemplateTkdRepairPlan = {
  template: {
    id: string;
    templateKey: string;
    version: number;
    templateName: string;
    locale: string;
    status: string;
    updatedAt: string;
    contentHashes: TemplateContentHashes;
  };
  /** 模板定义了哪些 SEO 槽位 = 这次会写哪些键。 */
  activeFields: TemplateTkdField[];
  fetchedArticleIds: string[];
  targetCount: number;
  blockers: string[];
  warnings: string[];
  changes: TemplateTkdChange[];
  statusCounts: Record<string, number>;
  /** 因 `contentMode = manual` 自动跳过的文章。 */
  manualSkipped: TemplateTkdSkippedArticle[];
  localeMismatchCount: number;
  excludedCount: number;
  excludedArticleIds: string[];
  unchangedCount: number;
  changedByField: Record<TemplateTkdField, number>;
};

/** 模板定义了哪些 SEO 槽位——没写的槽位不渲染、不写、不校验（本仓引擎没有任何兜底）。 */
export function activeTemplateTkdFields(source: ArticleTemplateSource): TemplateTkdField[] {
  const fields: TemplateTkdField[] = [];
  if (source.metaTitle !== undefined) fields.push("metaTitle");
  if (source.metaDescription !== undefined) fields.push("metaDescription");
  return fields;
}

/**
 * 校验排除清单没有过期（每条都必须仍是"该模板下未删除、且仍符合当初排除理由"的文章）。
 * 返回 blocker 文案；空数组 = 有效。
 */
async function validateExclusionEntriesAgainstDb(
  db: Pick<PrismaClient, "article">,
  template: TemplateTkdTemplateRow,
  entries: ExcludedArticleEntry[],
): Promise<string[]> {
  const blockers: string[] = [...validateTemplateTkdExclusionEntriesReviewed(entries)];
  if (entries.length === 0) return blockers;
  const rows = await db.article.findMany({
    where: { id: { in: entries.map((entry) => entry.articleId) } },
    select: { id: true, locale: true, templateId: true, deletedAt: true, contentMode: true },
  });
  const byId = new Map(rows.map((row) => [row.id, row]));
  for (const entry of entries) {
    const row = byId.get(entry.articleId);
    if (!row || row.deletedAt !== null || row.templateId !== template.id) {
      blockers.push(`exclusion list stale: article ${entry.articleId} is no longer an active article linked to template ${template.templateKey}`);
      continue;
    }
    if (entry.kind === "manual") {
      if (row.contentMode !== "manual") {
        blockers.push(`exclusion list stale: article ${entry.articleId} is no longer manual-mode (contentMode=${row.contentMode}); regenerate the exclusion list`);
      }
      continue;
    }
    if (row.locale === template.locale) {
      blockers.push(`exclusion list stale: article ${entry.articleId} locale now matches the template locale (${row.locale}); exclusion is no longer applicable`);
    } else if (row.locale !== entry.locale) {
      blockers.push(`exclusion list stale: article ${entry.articleId} locale changed from recorded "${entry.locale}" to live "${row.locale}"`);
    }
  }
  return blockers;
}

function articleWhere(template: TemplateTkdTemplateRow, scope: TemplateTkdRepairScope, afterId: string | undefined): Prisma.ArticleWhereInput {
  const where: Prisma.ArticleWhereInput = { templateId: template.id, deletedAt: null };
  if (scope.articleIds && scope.articleIds.length > 0) where.id = { in: [...new Set(scope.articleIds)] };
  else if (afterId !== undefined) where.id = { gt: afterId };
  if (scope.createdAtCutoff) where.createdAt = { lte: scope.createdAtCutoff };
  return where;
}

/**
 * 取一批模板关联文章，逐篇渲染并校验，产出计划。不写库、不写文件。
 *
 * 渲染只走 `renderNovelArticleDraft`（`generate.ts` 创建文章时用的同一个函数、同一套取值）；渲染失败、
 * 语种/类型不符、没有关联小说等一律是 blocker（有 blocker 就不允许 apply），语种不符只有出现在
 * 已签字且未过期的排除清单里才被跳过；`contentMode = manual` 自动跳过（不是 blocker）。
 */
export async function buildTemplateTkdRepairPlan(
  db: TemplateTkdDb,
  template: TemplateTkdTemplateRow,
  scope: TemplateTkdRepairScope,
  exclusion?: { entries: ExcludedArticleEntry[] },
): Promise<TemplateTkdRepairPlan> {
  const blockers: string[] = [];
  const warnings: string[] = [];

  let source: ArticleTemplateSource;
  try {
    source = validateStoredArticleTemplate(template);
  } catch (error) {
    if (error instanceof ArticleTemplateInputError || isTemplateRenderError(error)) {
      throw new Error(`Template ${template.templateKey} v${template.version} is not a valid renderable template: ${error.message}`);
    }
    throw error;
  }
  const activeFields = activeTemplateTkdFields(source);
  if (activeFields.length === 0) {
    throw new Error(`Template ${template.templateKey} v${template.version} defines neither metaTitle nor metaDescription; nothing to repair`);
  }

  const exclusionEntries = exclusion?.entries ?? [];
  let exclusionValid = true;
  if (exclusionEntries.length > 0) {
    const exclusionBlockers = await validateExclusionEntriesAgainstDb(db, template, exclusionEntries);
    if (exclusionBlockers.length > 0) {
      blockers.push(...exclusionBlockers);
      exclusionValid = false;
    }
  }
  const exclusionById = new Map(exclusionEntries.map((entry) => [entry.articleId, entry]));

  const articles: ArticleRepairRow[] = [];
  if (scope.allLinked) {
    let cursor: string | undefined;
    for (;;) {
      const page = await db.article.findMany({
        where: articleWhere(template, scope, cursor),
        orderBy: { id: "asc" },
        select: articleRepairSelect,
        take: SCAN_PAGE_SIZE,
      });
      articles.push(...page);
      if (page.length < SCAN_PAGE_SIZE) break;
      cursor = page[page.length - 1]!.id;
    }
  } else {
    articles.push(
      ...(await db.article.findMany({
        where: articleWhere(template, scope, scope.afterId),
        orderBy: { id: "asc" },
        select: articleRepairSelect,
        ...(scope.limit !== undefined ? { take: scope.limit } : {}),
      })),
    );
  }

  if (scope.articleIds && scope.articleIds.length > 0) {
    const resolved = new Set(articles.map((article) => article.id));
    for (const id of scope.articleIds) {
      if (!resolved.has(id)) blockers.push(`requested article ${id} not found in scope (deleted, wrong template, or created after the execution manifest cutoff)`);
    }
  }

  const changes: TemplateTkdChange[] = [];
  const statusCounts: Record<string, number> = {};
  const manualSkipped: TemplateTkdSkippedArticle[] = [];
  const excludedArticleIds: string[] = [];
  let localeMismatchCount = 0;
  let unchangedCount = 0;
  const changedByField: Record<TemplateTkdField, number> = { metaTitle: 0, metaDescription: 0 };

  for (const article of articles) {
    statusCounts[article.status] = (statusCounts[article.status] ?? 0) + 1;

    // 运营手改过的文章：自动跳过（后台编辑一保存就标 manual，SEO 标题很可能是手写的），不是 blocker。
    if (article.contentMode === "manual") {
      manualSkipped.push({ articleId: article.id, locale: article.locale, slug: article.slug, status: article.status });
      continue;
    }
    if (article.locale !== template.locale) {
      localeMismatchCount += 1;
      if (exclusionValid && exclusionById.get(article.id)?.kind === "locale_mismatch") {
        excludedArticleIds.push(article.id);
        continue;
      }
      blockers.push(`article ${article.id} locale=${article.locale} does not match template locale=${template.locale}`);
      continue;
    }
    if (article.articleType !== "novel_article" || article.novel === null) {
      blockers.push(`article ${article.id} type=${article.articleType} has no linked novel; not a novel_article`);
      continue;
    }
    if (!isPlainObject(article.seoMetadata)) {
      blockers.push(`article ${article.id} seoMetadata is not a JSON object; refusing to touch it`);
      continue;
    }

    let rendered;
    try {
      const previewChapterCount = await countPreviewChapters(db as never, article.novel.id);
      rendered = renderNovelArticleDraft({
        source,
        templateKey: template.templateKey,
        novel: article.novel,
        previewChapterCount,
        promoPublicRedirectCode: article.promoLink?.publicRedirectCode ?? null,
      });
    } catch (error) {
      if (isTemplateRenderError(error)) {
        blockers.push(`article ${article.id} template render failed: ${error.code}${error.slot ? ` (slot ${error.slot})` : ""}`);
        continue;
      }
      throw error;
    }

    const before = readTemplateTkdValues(article.seoMetadata);
    const after: TemplateTkdValues = {
      metaTitle: activeFields.includes("metaTitle") ? (rendered.seoMetadata.metaTitle ?? null) : before.metaTitle,
      metaDescription: activeFields.includes("metaDescription") ? (rendered.seoMetadata.metaDescription ?? null) : before.metaDescription,
    };
    // 引擎保证被渲染的槽位非空；这里再兜一道，绝不把空值写进 SEO 字段。
    for (const field of activeFields) {
      if (after[field] === null || after[field]!.trim() === "") {
        blockers.push(`article ${article.id} ${field} is empty after render`);
      }
    }
    if (hasTemplateTkdChange(before, after)) {
      changes.push({
        articleId: article.id,
        locale: article.locale,
        slug: article.slug,
        status: article.status,
        before,
        after,
        readUpdatedAt: article.updatedAt.toISOString(),
        beforeSeoMetadata: article.seoMetadata,
      });
      for (const field of TEMPLATE_TKD_FIELDS) if (before[field] !== after[field]) changedByField[field] += 1;
    } else {
      unchangedCount += 1;
    }
  }

  if (exclusionEntries.length > 0) {
    const listedManual = new Set(exclusionEntries.filter((entry) => entry.kind === "manual").map((entry) => entry.articleId));
    const unsigned = manualSkipped.filter((article) => !listedManual.has(article.articleId));
    if (unsigned.length > 0) {
      warnings.push(`${unsigned.length} manual-mode article(s) in this batch are not on the signed exclusion list (skipped anyway): ${unsigned.slice(0, 5).map((a) => a.articleId).join(", ")}${unsigned.length > 5 ? ", ..." : ""}`);
    }
  }

  return {
    template: {
      id: template.id,
      templateKey: template.templateKey,
      version: template.version,
      templateName: template.templateName,
      locale: template.locale,
      status: template.status,
      updatedAt: template.updatedAt.toISOString(),
      contentHashes: computeTemplateContentHashes(template),
    },
    activeFields,
    fetchedArticleIds: articles.map((article) => article.id),
    targetCount: articles.length,
    blockers,
    warnings,
    changes,
    statusCounts,
    manualSkipped,
    localeMismatchCount,
    excludedCount: excludedArticleIds.length,
    excludedArticleIds,
    unchangedCount,
    changedByField,
  };
}

/** `--generate-exclusion-file`：把该模板下所有会被跳过/需要排除的文章列出来，等运营签字。 */
export async function collectTemplateTkdExclusionCandidates(
  db: Pick<PrismaClient, "article">,
  template: Pick<TemplateTkdTemplateRow, "id" | "locale">,
): Promise<ExcludedArticleEntry[]> {
  const rows = await db.article.findMany({
    where: {
      templateId: template.id,
      deletedAt: null,
      OR: [{ contentMode: "manual" }, { locale: { not: template.locale } }],
    },
    select: { id: true, locale: true, contentMode: true },
    orderBy: { id: "asc" },
  });
  return rows.map((row) => {
    const kind: ExcludedArticleKind = row.contentMode === "manual" ? "manual" : "locale_mismatch";
    return {
      articleId: row.id,
      kind,
      locale: row.locale,
      reason: `${kind}: ${TEMPLATE_TKD_AUTO_EXCLUSION_REASON_MARKER}, review and replace this reason with a real justification before use`,
    };
  });
}

// ---------------------------------------------------------------------------
// 写库：备份 -> 事务内 CAS 更新 + 审计 -> 事后核对
// ---------------------------------------------------------------------------

export type ApplyTemplateTkdBatchInput = {
  plan: TemplateTkdRepairPlan;
  operator: string;
  reason: string;
  requestId: string;
  backupPath: string;
  executionManifestSha256: string | null;
  scope: { afterId?: string; limit?: number; articleIds?: string[] };
};

export type ApplyTemplateTkdBatchResult = {
  appliedCount: number;
  backupPath: string;
  backupSha256: string;
  auditId: string;
};

/**
 * 写库的 CAS 条件：只在文章仍是"读到它时的样子"才写——未删除、仍关联同一模板、`updatedAt` 没变
 * （运营在读-写之间改过 = `updatedAt` 变了 = 0 行 = 整批回滚）。
 * `timestamptz(6)` 可能带亚毫秒精度，JS `Date` 往返还原不出来，所以是 `[t, t+1ms)` 窗口，与
 * `updateArticleContent` 的 CAS 同一手法。
 *
 * 写库时额外要求 `contentMode` 仍是 template：这只是**读**条件，本工具从不写 `contentMode`。
 * 特意放在这个函数里、不直接写进文章 `updateMany` 的调用参数里——C-26 的静态扫描
 * （`tests/backend/articles/content-mode-sole-write-paths.test.ts`）按"文章写入调用的参数里出现
 * contentMode 键"识别写入点，这里不是写入点，不该让"只有两处写 contentMode"的断言失去含义。
 */
function casWhere(input: { articleId: string; templateId: string; readUpdatedAt: Date; requireTemplateMode: boolean }): Prisma.ArticleWhereInput {
  const where: Prisma.ArticleWhereInput = {
    id: input.articleId,
    deletedAt: null,
    templateId: input.templateId,
    updatedAt: { gte: input.readUpdatedAt, lt: new Date(input.readUpdatedAt.getTime() + 1) },
  };
  if (input.requireTemplateMode) where.contentMode = "template";
  return where;
}

async function assertStoredTkdMatches(
  db: Pick<PrismaClient, "article">,
  changes: TemplateTkdChange[],
  side: "before" | "after",
): Promise<void> {
  const rows = await db.article.findMany({
    where: { id: { in: changes.map((change) => change.articleId) } },
    select: { id: true, seoMetadata: true },
  });
  const byId = new Map(rows.map((row) => [row.id, row]));
  const mismatches = changes.filter((change) => {
    const row = byId.get(change.articleId);
    if (!row || !isPlainObject(row.seoMetadata)) return true;
    if (hasTemplateTkdChange(readTemplateTkdValues(row.seoMetadata), change[side])) return true;
    // 其它键必须原样保留：把当前 seoMetadata 去掉这两个键，与读到时（去掉这两个键）逐键比较。
    const strip = (record: Record<string, unknown>) => {
      const copy = { ...record };
      for (const field of TEMPLATE_TKD_FIELDS) delete copy[field];
      return JSON.stringify(Object.fromEntries(Object.entries(copy).sort(([a], [b]) => (a < b ? -1 : 1))));
    };
    return strip(row.seoMetadata) !== strip(change.beforeSeoMetadata);
  });
  if (mismatches.length > 0) {
    throw new Error(`Post-write verification failed for article IDs: ${mismatches.map((change) => change.articleId).join(", ")}`);
  }
}

/**
 * 写一批。调用前调用方必须已经过 `assertTemplateTkdApplyGuard`（篇数/备份路径/操作人）、
 * 计划无 blocker、角色闸门通过。本函数自己再做三件事：先独占写备份并 fsync；事务里对每篇做
 * `updatedAt` CAS（读到之后被运营改过 = 0 行 = 整批回滚）+ 同事务写 `OperationAudit`；提交后回读核对。
 */
export async function applyTemplateTkdBatch(db: TemplateTkdDb, input: ApplyTemplateTkdBatchInput): Promise<ApplyTemplateTkdBatchResult> {
  const { plan } = input;
  if (plan.blockers.length > 0) throw new Error(`Refusing to apply: ${plan.blockers.length} blocker(s)`);
  if (plan.changes.length === 0) throw new Error("Nothing to apply");
  if (plan.changes.length > TEMPLATE_TKD_MAX_BATCH_LIMIT) {
    throw new Error(`--apply cannot write more than ${TEMPLATE_TKD_MAX_BATCH_LIMIT} articles in a single transaction (found ${plan.changes.length})`);
  }

  const backup: TemplateTkdBackup = {
    version: TEMPLATE_TKD_BACKUP_VERSION,
    generatedAt: new Date().toISOString(),
    template: { id: plan.template.id, templateKey: plan.template.templateKey, version: plan.template.version, locale: plan.template.locale },
    changes: plan.changes,
  };
  // 先备份（独占创建 + fsync），备份没落盘就不动库。
  const backupSha256 = await writeExclusiveJsonFile(input.backupPath, backup);

  const audit = await db.$transaction(async (tx) => {
    for (const change of plan.changes) {
      const write = await tx.article.updateMany({
        where: casWhere({ articleId: change.articleId, templateId: plan.template.id, readUpdatedAt: new Date(change.readUpdatedAt), requireTemplateMode: true }),
        data: { seoMetadata: mergeTemplateTkdIntoSeoMetadata(change.beforeSeoMetadata, change.after) as Prisma.InputJsonValue },
      });
      if (write.count !== 1) {
        throw new Error(`article ${change.articleId} changed since it was read (edited, deleted, re-linked or switched to manual); aborting the whole batch`);
      }
    }
    return tx.operationAudit.create({
      data: {
        actorType: "system",
        actorId: input.operator.slice(0, 128),
        action: TEMPLATE_TKD_APPLY_AUDIT_ACTION,
        entityType: "ArticleTemplate",
        entityId: plan.template.id,
        requestId: input.requestId,
        reason: input.reason,
        beforeSnapshot: {
          templateKey: plan.template.templateKey,
          templateVersion: plan.template.version,
          locale: plan.template.locale,
          scope: input.scope,
        } as Prisma.InputJsonValue,
        afterSnapshot: {
          mode: "APPLY",
          activeFields: plan.activeFields,
          changedCount: plan.changes.length,
          changedByField: plan.changedByField,
          articleIds: plan.changes.map((change) => change.articleId),
          manualSkippedCount: plan.manualSkipped.length,
          backupPath: input.backupPath,
          backupSha256,
          executionManifestSha256: input.executionManifestSha256,
          templateContentHashes: plan.template.contentHashes,
          operator: input.operator,
        } as Prisma.InputJsonValue,
      },
      select: { id: true },
    });
  });

  await assertStoredTkdMatches(db, plan.changes, "after");
  return { appliedCount: plan.changes.length, backupPath: input.backupPath, backupSha256, auditId: audit.id.toString() };
}

export type RestoreTemplateTkdResult = { restoredCount: number; auditId: string };

/**
 * 用备份回滚一批：只在文章当前的 metaTitle/metaDescription 仍等于回写后的值时才回滚（运营中途改过就拒绝
 * 覆盖），仍带着模板关联、未删除、语种与 slug 没变。同事务写审计，回读核对。
 */
export async function restoreTemplateTkdBackup(
  db: TemplateTkdDb,
  input: { backup: TemplateTkdBackup; operator: string; reason: string; requestId: string; backupPath: string },
): Promise<RestoreTemplateTkdResult> {
  const { backup } = input;
  const current = await db.article.findMany({
    where: { id: { in: backup.changes.map((change) => change.articleId) } },
    select: { id: true, locale: true, slug: true, templateId: true, deletedAt: true, seoMetadata: true, updatedAt: true },
  });
  const byId = new Map(current.map((row) => [row.id, row]));
  const blockers: string[] = [];
  for (const change of backup.changes) {
    const row = byId.get(change.articleId);
    if (!row) {
      blockers.push(`article ${change.articleId} no longer exists`);
    } else if (row.deletedAt !== null || row.templateId !== backup.template.id) {
      blockers.push(`article ${change.articleId} deletion/template state changed after backup`);
    } else if (row.locale !== change.locale || row.slug !== change.slug) {
      blockers.push(`article ${change.articleId} locale/slug changed after backup`);
    } else if (!isPlainObject(row.seoMetadata) || hasTemplateTkdChange(readTemplateTkdValues(row.seoMetadata), change.after)) {
      blockers.push(`article ${change.articleId} TKD changed after repair; refusing to overwrite`);
    }
  }
  if (blockers.length > 0) throw new Error(`Restore blocked:\n${blockers.join("\n")}`);

  const audit = await db.$transaction(async (tx) => {
    for (const change of backup.changes) {
      const row = byId.get(change.articleId)!;
      const seoMetadata = row.seoMetadata as Record<string, unknown>;
      const write = await tx.article.updateMany({
        where: casWhere({ articleId: change.articleId, templateId: backup.template.id, readUpdatedAt: row.updatedAt, requireTemplateMode: false }),
        data: { seoMetadata: mergeTemplateTkdIntoSeoMetadata(seoMetadata, change.before) as Prisma.InputJsonValue },
      });
      if (write.count !== 1) throw new Error(`article ${change.articleId} changed while restoring; aborting the whole restore`);
    }
    return tx.operationAudit.create({
      data: {
        actorType: "system",
        actorId: input.operator.slice(0, 128),
        action: TEMPLATE_TKD_RESTORE_AUDIT_ACTION,
        entityType: "ArticleTemplate",
        entityId: backup.template.id,
        requestId: input.requestId,
        reason: input.reason,
        afterSnapshot: {
          mode: "RESTORE",
          restoredCount: backup.changes.length,
          articleIds: backup.changes.map((change) => change.articleId),
          restoredFrom: input.backupPath,
          templateKey: backup.template.templateKey,
          operator: input.operator,
        } as Prisma.InputJsonValue,
      },
      select: { id: true },
    });
  });

  // 回读：TKD 回到备份里的 before；其它键不动。
  const after = await db.article.findMany({
    where: { id: { in: backup.changes.map((change) => change.articleId) } },
    select: { id: true, seoMetadata: true },
  });
  const afterById = new Map(after.map((row) => [row.id, row]));
  const bad = backup.changes.filter((change) => {
    const row = afterById.get(change.articleId);
    return !row || !isPlainObject(row.seoMetadata) || hasTemplateTkdChange(readTemplateTkdValues(row.seoMetadata), change.before);
  });
  if (bad.length > 0) throw new Error(`Post-restore verification failed for article IDs: ${bad.map((change) => change.articleId).join(", ")}`);
  return { restoredCount: backup.changes.length, auditId: audit.id.toString() };
}

// ---------------------------------------------------------------------------
// 顶层编排：CLI 与真实库测试共用（默认预演）
// ---------------------------------------------------------------------------

export type TemplateTkdRepairOptions = {
  templateKey: string;
  templateVersion: number;
  scope: { allLinked: boolean; afterId?: string; limit?: number; articleIds?: string[] };
  apply: boolean;
  locale?: string;
  expectedCount?: number;
  backupPath?: string;
  manifestPath?: string;
  operator?: string;
  reason?: string;
  requestId?: string;
  excludeFilePath?: string;
  executionManifestPath?: string;
  cursorFilePath?: string;
};

export type TemplateTkdRepairSummary = {
  mode: "DRY_RUN" | "APPLIED";
  template: { id: string; templateKey: string; version: number; templateName: string; locale: string; status: string };
  scope: { allLinked: boolean; afterId: string | null; limit: number | null; articleIds: string[] | null; createdAtCutoff: string | null };
  activeFields: TemplateTkdField[];
  targetCount: number;
  changedCount: number;
  changedByField: Record<TemplateTkdField, number>;
  unchangedCount: number;
  manualSkippedCount: number;
  manualSkippedArticleIds: string[];
  localeMismatchCount: number;
  excludedCount: number;
  excludedArticleIds: string[];
  statusCounts: Record<string, number>;
  blockers: string[];
  warnings: string[];
  sampleChanges: Array<Pick<TemplateTkdChange, "articleId" | "locale" | "slug" | "status" | "before" | "after">>;
  nextAfterId: string | null;
  applied: null | { appliedCount: number; backupPath: string; backupSha256: string; auditId: string; cursorFilePath: string | null };
};

async function readJsonFile(filePath: string, flag: string): Promise<unknown> {
  if (!path.isAbsolute(filePath)) throw new Error(`${flag} must be an absolute path`);
  return JSON.parse(await readFile(filePath, "utf8")) as unknown;
}

async function readCursorIfPresent(filePath: string): Promise<TemplateTkdCursor | null> {
  if (!path.isAbsolute(filePath)) throw new Error("--cursor-file must be an absolute path");
  let text: string;
  try {
    text = await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  return parseTemplateTkdCursor(JSON.parse(text));
}

/**
 * 预演一批；`options.apply` 时在全部闸门通过后写库。任何闸门不过都抛错（CLI 会打印摘要再以非零退出）。
 * 顺序：参数闸门 -> 取模板 -> 读排除清单/执行清单并校验 -> 建计划 -> 与清单对账 -> blocker -> 篇数/备份/操作人闸门
 * -> 角色闸门 -> 游标对账 -> 写库 -> 游标落盘。
 */
export async function runTemplateTkdRepair(
  db: TemplateTkdDb,
  options: TemplateTkdRepairOptions,
  onSummary?: (summary: TemplateTkdRepairSummary) => void,
): Promise<TemplateTkdRepairSummary> {
  assertTemplateTkdScopeArgs({
    allLinked: options.scope.allLinked,
    apply: options.apply,
    afterId: options.scope.afterId,
    limit: options.scope.limit,
    articleIds: options.scope.articleIds,
  });
  const template = await loadTemplateForTkdRepair(db, { templateKey: options.templateKey, templateVersion: options.templateVersion });
  if (options.locale && options.locale !== template.locale) {
    throw new Error(`--locale=${options.locale} does not match template locale=${template.locale}`);
  }

  const preflight: string[] = [];
  let exclusionFile: TemplateTkdExclusionFile | undefined;
  if (options.excludeFilePath) {
    exclusionFile = parseTemplateTkdExclusionFile(await readJsonFile(options.excludeFilePath, "--exclude-article-ids-file"));
    if (exclusionFile.templateKey !== template.templateKey || exclusionFile.templateVersion !== template.version) {
      preflight.push(`--exclude-article-ids-file is for template ${exclusionFile.templateKey} v${exclusionFile.templateVersion}, not ${template.templateKey} v${template.version}`);
    }
    preflight.push(...validateTemplateTkdExclusionFileHash(exclusionFile));
  }
  let executionManifest: TemplateTkdExecutionManifest | undefined;
  let executionManifestSha256: string | null = null;
  if (options.executionManifestPath) {
    const text = await readFile(options.executionManifestPath, "utf8");
    executionManifestSha256 = sha256Hex(text);
    executionManifest = parseTemplateTkdExecutionManifest(JSON.parse(text));
    if (executionManifest.template.templateKey !== template.templateKey || executionManifest.template.version !== template.version) {
      preflight.push(`--execution-manifest is for template ${executionManifest.template.templateKey} v${executionManifest.template.version}, not ${template.templateKey} v${template.version}`);
    }
    preflight.push(...validateTemplateTkdExecutionManifestIntegrity(executionManifest));
    preflight.push(...validateExecutionManifestExclusionScope(executionManifest, exclusionFile));
  }
  // 签字后的排除清单优先；没有就用执行清单里冻结（且已校验过哈希）的那份。
  const effectiveExclusionEntries = exclusionFile?.entries ?? executionManifest?.excludedArticleIds.entries ?? [];

  const plan = await buildTemplateTkdRepairPlan(
    db,
    template,
    {
      afterId: options.scope.afterId,
      limit: options.scope.limit,
      articleIds: options.scope.articleIds,
      allLinked: options.scope.allLinked,
      createdAtCutoff: executionManifest ? new Date(executionManifest.createdAtCutoff) : undefined,
    },
    effectiveExclusionEntries.length > 0 ? { entries: effectiveExclusionEntries } : undefined,
  );
  const manifestBlockers = executionManifest ? validateExecutionManifestAgainstPlan(executionManifest, plan) : [];
  const blockers = [...preflight, ...plan.blockers, ...manifestBlockers];

  if (options.apply && !executionManifest) {
    blockers.push("--apply requires --execution-manifest (freeze scope + template content + signed exclusions first with --generate-execution-manifest)");
  }
  if (options.apply && !options.scope.articleIds && !options.cursorFilePath) {
    blockers.push("--apply with --after-id/--limit requires --cursor-file=<absolute path> (the per-round resume cursor, written after every batch)");
  }

  let cursor: TemplateTkdCursor | null = null;
  if (options.apply && options.cursorFilePath && executionManifestSha256) {
    cursor = await readCursorIfPresent(options.cursorFilePath);
    if (!options.scope.articleIds) {
      blockers.push(
        ...validateTemplateTkdCursor({
          cursor,
          afterId: options.scope.afterId,
          templateKey: template.templateKey,
          templateVersion: template.version,
          executionManifestSha256,
        }),
      );
    }
  }

  const nextAfterId = plan.fetchedArticleIds.length > 0 ? plan.fetchedArticleIds[plan.fetchedArticleIds.length - 1]! : (options.scope.afterId ?? null);
  const summary: TemplateTkdRepairSummary = {
    mode: "DRY_RUN",
    template: {
      id: plan.template.id,
      templateKey: plan.template.templateKey,
      version: plan.template.version,
      templateName: plan.template.templateName,
      locale: plan.template.locale,
      status: plan.template.status,
    },
    scope: {
      allLinked: options.scope.allLinked,
      afterId: options.scope.afterId ?? null,
      limit: options.scope.limit ?? null,
      articleIds: options.scope.articleIds ?? null,
      createdAtCutoff: executionManifest?.createdAtCutoff ?? null,
    },
    activeFields: plan.activeFields,
    targetCount: plan.targetCount,
    changedCount: plan.changes.length,
    changedByField: plan.changedByField,
    unchangedCount: plan.unchangedCount,
    manualSkippedCount: plan.manualSkipped.length,
    manualSkippedArticleIds: plan.manualSkipped.map((article) => article.articleId),
    localeMismatchCount: plan.localeMismatchCount,
    excludedCount: plan.excludedCount,
    excludedArticleIds: plan.excludedArticleIds,
    statusCounts: plan.statusCounts,
    blockers,
    warnings: plan.warnings,
    sampleChanges: plan.changes.slice(0, 20).map(({ articleId, locale, slug, status, before, after }) => ({ articleId, locale, slug, status, before, after })),
    nextAfterId,
    applied: null,
  };
  onSummary?.(summary);

  if (options.manifestPath) {
    await writeExclusiveJsonFile(options.manifestPath, {
      version: TEMPLATE_TKD_BACKUP_VERSION,
      generatedAt: new Date().toISOString(),
      mode: summary.mode,
      template: summary.template,
      changedCount: plan.changes.length,
      changes: plan.changes.map(({ articleId, locale, slug, status, before, after }) => ({ articleId, locale, slug, status, before, after })),
    });
  }

  if (blockers.length > 0) {
    throw new Error(`Repair blocked: ${blockers.length} blocker(s) found (see blockers[] in the summary above)`);
  }
  assertTemplateTkdApplyGuard({
    apply: options.apply,
    locale: options.locale,
    expectedCount: options.expectedCount,
    actualCount: plan.changes.length,
    backupPath: options.backupPath,
    operator: options.operator,
    reason: options.reason,
  });
  if (!options.apply) return summary;

  const cursorMode = Boolean(options.cursorFilePath && executionManifestSha256 && !options.scope.articleIds);
  const writeCursor = async (appliedInBatch: number, batchApplied: boolean): Promise<string | null> => {
    if (!cursorMode) return null;
    const next: TemplateTkdCursor = {
      version: TEMPLATE_TKD_CURSOR_VERSION,
      templateKey: template.templateKey,
      templateVersion: template.version,
      executionManifestSha256: executionManifestSha256!,
      lastAfterId: nextAfterId,
      appliedTotal: (cursor?.appliedTotal ?? 0) + appliedInBatch,
      batchesApplied: (cursor?.batchesApplied ?? 0) + (batchApplied ? 1 : 0),
      updatedAt: new Date().toISOString(),
    };
    // 先写临时文件再改名：游标文件任何时刻都是完整的一份，进程中途死掉不会留下半截 JSON。
    const tmpPath = `${options.cursorFilePath!}.tmp`;
    await writeFile(tmpPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    await rename(tmpPath, options.cursorFilePath!);
    return options.cursorFilePath!;
  };

  if (plan.changes.length === 0) {
    // 这一批没有需要写的文章（已是新值 / 被跳过 / 范围走到头）：不写备份、不写审计、不动库，
    // 但游标照样推进到本批终点，下一批的 --after-id 才对得上。
    await writeCursor(0, false);
    return summary;
  }

  assertTemplateTkdDbRole(await loadTemplateTkdDbRole(db));
  const result = await applyTemplateTkdBatch(db, {
    plan,
    operator: options.operator!,
    reason: options.reason!,
    requestId: options.requestId?.trim() || `tkd-repair-${template.templateKey}-v${template.version}-${Date.now()}`,
    backupPath: options.backupPath!,
    executionManifestSha256,
    scope: { afterId: options.scope.afterId, limit: options.scope.limit, articleIds: options.scope.articleIds },
  });

  const cursorFilePath = await writeCursor(result.appliedCount, true);
  return { ...summary, mode: "APPLIED", applied: { ...result, cursorFilePath } };
}

/**
 * `--generate-execution-manifest`：冻结整轮的模板内容哈希、目标篇数（创建时间 ≤ 冻结时刻的全部关联文章）与排除集。
 * 排除集来自签字后的排除清单；模板下若仍有"手改/语种不符"的文章没有出现在清单里，就拒绝生成——
 * 这是让"运营签字"真正有牙的那道闸。
 */
export async function generateTemplateTkdExecutionManifest(
  db: TemplateTkdDb,
  input: { templateKey: string; templateVersion: number; excludeFilePath?: string; outPath: string },
): Promise<{ manifest: TemplateTkdExecutionManifest; sha256: string }> {
  if (!path.isAbsolute(input.outPath)) throw new Error("--execution-manifest must be an absolute path");
  const template = await loadTemplateForTkdRepair(db, { templateKey: input.templateKey, templateVersion: input.templateVersion });
  const source = validateStoredArticleTemplate(template);
  const activeFields = activeTemplateTkdFields(source);
  if (activeFields.length === 0) throw new Error(`Template ${template.templateKey} defines neither metaTitle nor metaDescription; nothing to freeze`);

  let entries: ExcludedArticleEntry[] = [];
  if (input.excludeFilePath) {
    const file = parseTemplateTkdExclusionFile(await readJsonFile(input.excludeFilePath, "--exclude-article-ids-file"));
    const hashIssues = validateTemplateTkdExclusionFileHash(file);
    if (hashIssues.length > 0) throw new Error(hashIssues.join("; "));
    if (file.templateKey !== template.templateKey || file.templateVersion !== template.version) {
      throw new Error(`--exclude-article-ids-file is for template ${file.templateKey} v${file.templateVersion}, not ${template.templateKey} v${template.version}`);
    }
    const stale = await validateExclusionEntriesAgainstDb(db, template, file.entries);
    if (stale.length > 0) throw new Error(stale.join("; "));
    entries = file.entries;
  }
  const candidates = await collectTemplateTkdExclusionCandidates(db, template);
  const signed = new Set(entries.map((entry) => entry.articleId));
  const unsigned = candidates.filter((candidate) => !signed.has(candidate.articleId));
  if (unsigned.length > 0) {
    throw new Error(
      `exclusion list incomplete: ${unsigned.length} manual-mode/locale-mismatched article(s) are not on the signed exclusion list (e.g. ${unsigned
        .slice(0, 5)
        .map((entry) => entry.articleId)
        .join(", ")}); generate it with --generate-exclusion-file, have operations sign it, and pass --exclude-article-ids-file`,
    );
  }

  const cutoff = new Date();
  const targets = await db.article.findMany({
    where: { templateId: template.id, deletedAt: null, createdAt: { lte: cutoff } },
    select: { id: true },
    orderBy: { id: "asc" },
  });
  const manifest = buildTemplateTkdExecutionManifest({
    template,
    activeFields,
    createdAtCutoff: cutoff,
    targetArticleIds: targets.map((row) => row.id),
    excludedEntries: entries,
  });
  const sha256 = await writeExclusiveJsonFile(input.outPath, manifest);
  return { manifest, sha256 };
}

export async function generateTemplateTkdExclusionFile(
  db: Pick<PrismaClient, "articleTemplate" | "article">,
  input: { templateKey: string; templateVersion: number; outPath: string },
): Promise<{ file: TemplateTkdExclusionFile; count: number }> {
  if (!path.isAbsolute(input.outPath)) throw new Error("--generate-exclusion-file must be an absolute path");
  const template = await loadTemplateForTkdRepair(db, { templateKey: input.templateKey, templateVersion: input.templateVersion });
  const entries = await collectTemplateTkdExclusionCandidates(db, template);
  const file = buildTemplateTkdExclusionFile({ templateKey: template.templateKey, templateVersion: template.version, entries });
  await writeExclusiveJsonFile(input.outPath, file);
  return { file, count: entries.length };
}

/** `--restore-from`：读备份、校验、（`--apply` 时）回滚。 */
export async function runTemplateTkdRestore(
  db: TemplateTkdDb,
  options: { backupPath: string; expectedCount?: number; apply: boolean; operator?: string; reason?: string; requestId?: string },
): Promise<{ mode: "RESTORE_DRY_RUN" | "RESTORED"; restoreCount: number; auditId: string | null }> {
  const backup = parseTemplateTkdBackup(await readJsonFile(options.backupPath, "--restore-from"));
  if (!options.apply) return { mode: "RESTORE_DRY_RUN", restoreCount: backup.changes.length, auditId: null };
  if (options.expectedCount !== backup.changes.length) {
    throw new Error(`Restore expected-count ${options.expectedCount ?? "missing"} does not match backup count ${backup.changes.length}`);
  }
  if (!options.operator?.trim() || !options.reason?.trim()) throw new Error("--restore-from --apply requires --operator and --reason");
  assertTemplateTkdDbRole(await loadTemplateTkdDbRole(db));
  const result = await restoreTemplateTkdBackup(db, {
    backup,
    operator: options.operator,
    reason: options.reason,
    requestId: options.requestId?.trim() || `tkd-restore-${backup.template.templateKey}-${Date.now()}`,
    backupPath: options.backupPath,
  });
  return { mode: "RESTORED", restoreCount: result.restoredCount, auditId: result.auditId };
}
