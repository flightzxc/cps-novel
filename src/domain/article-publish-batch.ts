/**
 * 文章「全选 → 后台批量发布」任务的零依赖领域模块（可以被 Client Component 引用，
 * 因此不得 import Prisma / Node 内置模块；与 `./article-generation.ts` 同一纪律）。
 *
 * 任务结构照搬 `article.generate.batch.v2`：父任务按筛选快照枚举草稿，每
 * {@link ARTICLE_PUBLISH_LEAF_MAX} 篇拆成一个子任务，子任务每个条目一篇文章。
 * 设计决定见 `docs/adr/ADR-ARTICLE-PUBLISH-BATCH-TASK.md`。
 */
import { ADMIN_CONTENT_MAX_SEARCH_LENGTH } from "./admin-content";

/** 父任务：按筛选快照枚举草稿并拆分子任务。登记进 `PARENT_BATCH_TASK_TYPES`。 */
export const ARTICLE_PUBLISH_BATCH_TASK_TYPE = "article.publish.batch.v1";
/** 子任务：每个条目一篇文章，调用与「发布」按钮同一个发布核心。 */
export const ARTICLE_PUBLISH_TASK_TYPE = "article.publish.v1";
export const ARTICLE_PUBLISH_BATCH_TARGET_TYPE = "article_publish_filter";
export const ARTICLE_PUBLISH_TARGET_TYPE = "article";

/** 每个子任务的条目数；与同步批量发布的 `MAX_BATCH_SIZE`（200）、建稿子任务的 `ARTICLE_GENERATE_LEAF_MAX` 同口径。 */
export const ARTICLE_PUBLISH_LEAF_MAX = 200;
/** 一次「全选」允许提交的草稿篇数上限，超过就拒绝。 */
export const ARTICLE_PUBLISH_BATCH_MAX = 50_000;
/** 父任务从提交到被 worker 领取并完成枚举的有效期，与建稿批次同为 6 小时。 */
export const ARTICLE_PUBLISH_TTL_MS = 6 * 60 * 60 * 1_000;

export function isArticlePublishBatchTaskType(taskType: string | null | undefined): boolean {
  return taskType === ARTICLE_PUBLISH_BATCH_TASK_TYPE;
}

export function isArticlePublishTaskType(taskType: string | null | undefined): boolean {
  return taskType === ARTICLE_PUBLISH_TASK_TYPE;
}

/**
 * 批量发布的筛选快照：恰好是文章列表页上的筛选轴，去掉 `status`——后台任务
 * 只发布草稿，状态条件由枚举处固定为 `draft`，不进快照。
 */
export type ArticlePublishFilter = Readonly<{
  locale?: string;
  novelId?: string;
  templateId?: string;
  search?: string;
  canonicalTagId?: string;
  seoVisibility?: string;
  articleType?: string;
  contentMode?: string;
}>;

export class ArticlePublishInputError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "ArticlePublishInputError";
  }
}

/**
 * 快照键的固定顺序：`JSON.stringify` 之后要进指纹与 scope hash，键序必须稳定。
 * 与 `src/server/articles/service.ts` 的 `ArticleListInput` 一致；未列出的键一律
 * 拒绝（宁可报错，也不能因为拼错键名而静默放宽筛选范围）。
 */
const FILTER_KEYS = [
  "locale", "novelId", "templateId", "search", "canonicalTagId",
  "seoVisibility", "articleType", "contentMode",
] as const;
const FILTER_KEYS_WITH_STATUS: ReadonlySet<string> = new Set([...FILTER_KEYS, "status"]);
/** 列表页的下拉用 `""` 或 `all` 表示"不筛"；与 `normalizeArticleListInput` 对这三个轴的归一一致。 */
const ALL_MEANS_UNFILTERED: ReadonlySet<string> = new Set(["seoVisibility", "articleType", "contentMode"]);
const FILTER_VALUE_MAX_LENGTH = 64;

export function normalizeArticlePublishFilter(raw: unknown): ArticlePublishFilter {
  if (raw === undefined || raw === null) return Object.freeze({});
  if (typeof raw !== "object" || Array.isArray(raw)) throw new ArticlePublishInputError("filter_invalid");
  const input = raw as Record<string, unknown>;
  for (const key of Object.keys(input)) {
    if (!FILTER_KEYS_WITH_STATUS.has(key)) throw new ArticlePublishInputError("filter_key_unknown");
  }
  const status = input.status;
  if (status !== undefined && status !== null && status !== "" && status !== "draft") {
    // 筛选条件里明确选了"已发布/已下线"等非草稿状态：后台任务只发草稿，交集恒为空。
    throw new ArticlePublishInputError("filter_status_not_draft");
  }
  const out: Record<string, string> = {};
  for (const key of FILTER_KEYS) {
    const value = input[key];
    if (value === undefined || value === null) continue;
    if (typeof value !== "string") throw new ArticlePublishInputError("filter_value_invalid");
    const trimmed = value.trim();
    if (trimmed === "") continue;
    if (ALL_MEANS_UNFILTERED.has(key) && trimmed === "all") continue;
    const max = key === "search" ? ADMIN_CONTENT_MAX_SEARCH_LENGTH : FILTER_VALUE_MAX_LENGTH;
    if (trimmed.length > max) throw new ArticlePublishInputError("filter_value_too_long");
    out[key] = trimmed;
  }
  return Object.freeze(out) as ArticlePublishFilter;
}

/**
 * 父任务 `result` 里的站点地图触发记录（见 `docs/governance/database-governance.md`
 * §3.4 本任务小节）。`coveredPublishedCount` 是"上一次触发时已经覆盖的已发布篇数"，
 * 用作水位线：只有当前已发布总数超过它才会再触发，所以暂停/恢复、重试失败项
 * 之后新增的发布也会补一次，而一次完整跑完只触发一次。
 */
export type ArticlePublishSitemapRefreshRecord = Readonly<{
  status: "queued" | "coalesced" | "disabled" | "failed";
  triggerCount: number;
  coveredPublishedCount: number;
  triggeredAt: string;
}>;
