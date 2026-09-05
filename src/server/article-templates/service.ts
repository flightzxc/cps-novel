/**
 * CPS v8.3.6 parity: `template-actions.ts` owns CRUD/soft-delete/active
 * selection and `article-generation.ts` prefers TPL001 before the first
 * active template. Novel maps that preference to `system-default-v1` and
 * delegates every validation decision to the existing fail-closed engine.
 */
import { Prisma, type PrismaClient } from "@prisma/client";

import {
  buildNovelTemplateValues,
  narrowArticleTemplateSource,
  renderArticleDraft,
  TEMPLATE_SEO_SCHEMA_VERSION,
  type ArticleTemplateSource,
} from "@/lib/seo/template";
import {
  requireFreshAdminServiceMutation,
  type AdminServiceAuthorization,
} from "@/server/auth/guards";
import type { AdminIdentityStore, SessionStore } from "@/lib/auth/ports";
import {
  DEFAULT_ARTICLE_TEMPLATE,
  DEFAULT_ARTICLE_TEMPLATE_KEY,
} from "@/server/content-creation/default-article-template";
import { SITE_LOCALES } from "@/lib/locale/locale-canonical";
import { APPLICABLE_ARTICLE_TYPES, type ApplicableArticleType } from "@/lib/article-templates/applicable-article-type";
import type { ArticleTemplateStatus, ArticleTemplateWrite } from "@/lib/article-templates/contract";
import {
  compileContentBlocks,
  isArticleContentBlockList,
  type ArticleContentBlock,
} from "./compile-blocks";

/**
 * 适用文章类型枚举、状态类型与写入契约的实际定义都搬到了 `src/lib/article-templates/`
 * 下（后台模板表单需要在浏览器端 import 它们渲染表单，留在本文件会被
 * `tests/ui/admin-secret-boundary.test.tsx` 的 client/server 边界扫描判违规——
 * 该扫描是纯文本正则，连 `import type` 也不放过，见目标文件顶部注释）。这里原样
 * re-export，对现有调用方（`import { APPLICABLE_ARTICLE_TYPES } from
 * "@/server/article-templates"` 等）完全透明。
 */
export type { ArticleTemplateStatus, ArticleTemplateWrite };
export { APPLICABLE_ARTICLE_TYPES, type ApplicableArticleType };

const APPLICABLE_ARTICLE_TYPE_SET: ReadonlySet<string> = new Set(APPLICABLE_ARTICLE_TYPES);

export type ArticleTemplateServiceDependencies = {
  readonly db: PrismaClient;
  readonly identities: AdminIdentityStore;
  readonly sessions: SessionStore;
  readonly env?: NodeJS.ProcessEnv;
  readonly now?: Date;
};

export class ArticleTemplateInputError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.name = "ArticleTemplateInputError";
    this.code = code;
  }
}

function required(value: string, code: string, max: number): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > max) throw new ArticleTemplateInputError(code);
  return normalized;
}

/**
 * `locale` 白名单校验。必须是 `SITE_LOCALES` 的成员，或 `null`/空白（表示"全部语种"）。
 *
 * 🔴 修复真实缺陷：旧实现只做 `input.locale?.trim() || null`，任何拼错的字符串
 * （`"eng"`、`"En"`、多打一个空格之外的形态错误……）都会原样落库，产出一个
 * `selectActiveArticleTemplate` 的 `OR: [{locale: X}, {locale: null}]` 永远匹配不到的
 * 孤儿模板——保存时不报错，用到时才发现模板"不见了"。
 */
function requireLocale(locale: string | null | undefined): string | null {
  const trimmed = typeof locale === "string" ? locale.trim() : "";
  if (trimmed === "") return null;
  // 直接查 SITE_LOCALES 数组，不额外派生一份 Set/Map——`tests/ui/locale-canonical.test.ts`
  // 的"没有第二张语种映射表"扫描按名字（含 LOCALE/LANGUAGE）+ 字面量集合声明识别，
  // 就算这份集合是从唯一真源派生的也会被判成第二张表，索性不建。15 项数组 `.includes`
  // 的开销可以忽略。
  if (!(SITE_LOCALES as readonly string[]).includes(trimmed)) {
    throw new ArticleTemplateInputError("template_locale_invalid");
  }
  return trimmed;
}

function storage(input: ArticleTemplateWrite) {
  const templateKey = required(input.templateKey, "template_key_invalid", 96);
  const templateName = required(input.templateName, "template_name_invalid", 191);

  if (!(["draft", "active", "inactive"] as const).includes(input.status)) {
    throw new ArticleTemplateInputError("template_status_invalid");
  }

  const locale = requireLocale(input.locale);

  const applicableArticleType = input.applicableArticleType ?? "novel_article";
  if (!APPLICABLE_ARTICLE_TYPE_SET.has(applicableArticleType)) {
    throw new ArticleTemplateInputError("template_article_type_invalid");
  }

  if (!isArticleContentBlockList(input.contentTemplate)) {
    throw new ArticleTemplateInputError("template_content_invalid");
  }
  const contentTemplate: readonly ArticleContentBlock[] = input.contentTemplate;
  const bodyTemplate = required(compileContentBlocks(contentTemplate), "template_body_invalid", 500_000);

  const schemaVersion = input.schemaVersion ?? TEMPLATE_SEO_SCHEMA_VERSION;
  const seoTemplate = {
    title: required(input.titleTemplate, "template_title_invalid", 20_000),
    ...(input.metaTitleTemplate === undefined ? {} : { metaTitle: input.metaTitleTemplate }),
    ...(input.metaDescriptionTemplate === undefined ? {} : { metaDescription: input.metaDescriptionTemplate }),
  };
  const stored = {
    templateKey,
    templateName,
    locale,
    schemaVersion,
    status: input.status,
    applicableArticleType,
    bodyTemplate,
    contentTemplate,
    seoTemplate,
    slugTemplate: input.slugTemplate ?? "",
    metaKeywordsTemplate: input.metaKeywordsTemplate ?? "",
  };
  validateStoredArticleTemplate(stored);
  return stored;
}

export function validateStoredArticleTemplate(input: {
  readonly templateKey: string;
  readonly schemaVersion: number;
  readonly bodyTemplate: string;
  readonly seoTemplate: unknown;
  readonly slugTemplate?: string;
  readonly metaKeywordsTemplate?: string;
}): ArticleTemplateSource {
  const narrowed = narrowArticleTemplateSource(input);
  if (!narrowed) throw new ArticleTemplateInputError("template_schema_invalid");
  // Deliberately representative non-empty values: syntax, registered fields,
  // HTML contexts, output constraints and empty-required-variable behavior all
  // remain owned by renderArticleDraft.
  renderArticleDraft(
    narrowed,
    buildNovelTemplateValues({
      title: "Sample Novel",
      description: "Sample description",
      coverUrl: "https://example.test/cover.jpg",
      totalChapterCount: 12,
      previewChapterCount: 3,
      promoRedirectUrl: "/go/sample",
    }),
    { templateKey: input.templateKey },
  );
  return narrowed;
}

/**
 * 引导默认模板用的内容区块。**刻意不用来派生 `bodyTemplate`**——`bodyTemplate` 仍是
 * `DEFAULT_ARTICLE_TEMPLATE.body`（`default-article-template.test.ts` 已按字节精确
 * pin 住它的渲染产物），这里只是给这条种子行一个结构上合法、语义等价的
 * `contentTemplate`，供后续阶段的编辑器/列表展示。
 *
 * 这份区块编译出来的 HTML 是**安全的**（`image` 区块带 `{if cover_url}` 包裹，
 * 整块条件会被外提到标签外，见 `compile-blocks.ts`），无封面/无章节计数的小说都能
 * 正常渲染。但它与 `DEFAULT_ARTICLE_TEMPLATE.body` **不是逐字节相同**：后者多一层
 * `<article>` 外壳、用 `<h1>` 而非 `<h2>`、`<img>` 带 `alt="Cover"`、CTA 外面还有一层
 * `<p>`。区块词汇表表达不了这些差异。
 *
 * 🔴 **后续阶段（后台表单）必须注意**：运营在编辑器里打开这条种子模板再保存，正文会
 * 从 `<article>` 版静默变成区块编译版。UI 不应该让"只是打开看看"产生这种改写——
 * 要么保存时提示正文将被重写，要么对这条种子行做特殊处理。
 */
const SYSTEM_DEFAULT_CONTENT_BLOCKS: readonly ArticleContentBlock[] = [
  { type: "heading", content: "{novel_title}" },
  { type: "image", content: "" },
  { type: "paragraph", content: "{novel_description}" },
  { type: "paragraph", content: "{if total_chapter_count}Total chapters: {total_chapter_count}{endif}" },
  {
    type: "paragraph",
    content: "{if preview_chapter_count}Free preview chapters available: {preview_chapter_count}{endif}",
  },
  { type: "cta", content: "Start Reading" },
];

export async function ensureDefaultArticleTemplate(
  tx: Pick<Prisma.TransactionClient, "articleTemplate">,
) {
  const count = await tx.articleTemplate.count({ where: { deletedAt: null } });
  if (count > 0) return null;
  return tx.articleTemplate.create({
    data: {
      templateKey: DEFAULT_ARTICLE_TEMPLATE_KEY,
      templateName: "系统默认模板",
      locale: "en",
      version: 1,
      schemaVersion: 1,
      status: "active",
      applicableArticleType: "novel_article",
      bodyTemplate: DEFAULT_ARTICLE_TEMPLATE.body,
      contentTemplate: SYSTEM_DEFAULT_CONTENT_BLOCKS as unknown as Prisma.InputJsonValue,
      seoTemplate: {
        title: DEFAULT_ARTICLE_TEMPLATE.title,
        metaTitle: DEFAULT_ARTICLE_TEMPLATE.metaTitle ?? DEFAULT_ARTICLE_TEMPLATE.title,
        metaDescription: DEFAULT_ARTICLE_TEMPLATE.metaDescription ?? "{novel_description}",
      },
      slugTemplate: "",
      metaKeywordsTemplate: "",
    },
  });
}

const TEMPLATE_SELECT = {
  id: true,
  templateKey: true,
  templateName: true,
  locale: true,
  version: true,
  schemaVersion: true,
  status: true,
  applicableArticleType: true,
  bodyTemplate: true,
  contentTemplate: true,
  seoTemplate: true,
  slugTemplate: true,
  metaKeywordsTemplate: true,
  deletedAt: true,
  createdAt: true,
  updatedAt: true,
} as const;

export async function selectActiveArticleTemplate(
  db: Pick<PrismaClient, "articleTemplate">,
  input: { readonly locale: string; readonly templateKey?: string; readonly applicableArticleType?: string },
) {
  // 🔴 locale 与 applicableArticleType 各自是一条 OR 子句；不能用两次对象展开
  // `{...localeWhere, ...typeWhere}` 合并——两者的 key 都叫 `OR`，后一次展开会
  // 静默吃掉前一次，等价于 locale 过滤完全失效。改用 `AND` 数组显式并列两个独立的 OR。
  const conditions: Prisma.ArticleTemplateWhereInput[] = [{ OR: [{ locale: input.locale }, { locale: null }] }];
  if (input.applicableArticleType) {
    conditions.push({ OR: [{ applicableArticleType: input.applicableArticleType }, { applicableArticleType: "any" }] });
  }
  if (input.templateKey) {
    return db.articleTemplate.findFirst({
      where: { templateKey: input.templateKey, status: "active", deletedAt: null, AND: conditions },
      select: TEMPLATE_SELECT,
      orderBy: { version: "desc" },
    });
  }
  const preferred = await db.articleTemplate.findFirst({
    where: { templateKey: DEFAULT_ARTICLE_TEMPLATE_KEY, status: "active", deletedAt: null, AND: conditions },
    select: TEMPLATE_SELECT,
    orderBy: { version: "desc" },
  });
  return preferred ?? db.articleTemplate.findFirst({
    where: { status: "active", deletedAt: null, AND: conditions },
    select: TEMPLATE_SELECT,
    orderBy: [{ createdAt: "asc" }, { version: "desc" }],
  });
}

export async function listArticleTemplates(db: PrismaClient, input: { search?: string; status?: string } = {}) {
  return db.articleTemplate.findMany({
    where: {
      deletedAt: null,
      ...(input.status ? { status: input.status } : {}),
      ...(input.search ? { templateKey: { contains: input.search, mode: "insensitive" as const } } : {}),
    },
    select: { ...TEMPLATE_SELECT, _count: { select: { articles: true } } },
    orderBy: [{ createdAt: "desc" }, { version: "desc" }],
  });
}

export async function getArticleTemplate(db: PrismaClient, id: string) {
  return db.articleTemplate.findFirst({ where: { id, deletedAt: null }, select: TEMPLATE_SELECT });
}

export async function listActiveArticleTemplateOptions(
  db: PrismaClient,
  locale: string,
  applicableArticleType?: string,
) {
  const conditions: Prisma.ArticleTemplateWhereInput[] = [{ OR: [{ locale }, { locale: null }] }];
  if (applicableArticleType) {
    conditions.push({ OR: [{ applicableArticleType }, { applicableArticleType: "any" }] });
  }
  return db.articleTemplate.findMany({
    where: { status: "active", deletedAt: null, AND: conditions },
    select: { id: true, templateKey: true, locale: true, version: true },
    orderBy: [{ templateKey: "asc" }, { version: "desc" }],
    distinct: ["templateKey"],
  });
}

async function authorize(
  authorization: AdminServiceAuthorization,
  entryId: string,
  requestId: string,
  deps: ArticleTemplateServiceDependencies,
) {
  return requireFreshAdminServiceMutation(authorization, "content:publish", {
    identities: deps.identities,
    sessions: deps.sessions,
    env: deps.env,
    now: deps.now,
    entryId,
    requestId,
  });
}

export async function createArticleTemplate(input: {
  authorization: AdminServiceAuthorization;
  requestId: string;
  template: ArticleTemplateWrite;
}, deps: ArticleTemplateServiceDependencies) {
  const context = await authorize(input.authorization, "admin.article_template.create", input.requestId, deps);
  const data = storage(input.template);
  return deps.db.$transaction(async (tx) => {
    // 版本自动分配：同一 templateKey 的 max(version) + 1（无记录则 1）。读取与插入
    // 必须在同一事务里（`@@unique([templateKey, version])` 下的竞态），这里满足了
    // 这一条；但 Postgres 默认 READ COMMITTED 下两个并发事务仍可能读到相同的
    // max(version) 并都尝试插入下一个号——这种情况下 UNIQUE 约束会让其中一个写入
    // 以约束冲突失败（可重试），不会产生数据损坏或静默覆盖。没有额外加
    // `pg_advisory_xact_lock` 之类的显式加锁：单管理员驱动的模板 CRUD 里
    // 同一 templateKey 的并发创建概率可以忽略，加锁会为测试 double（Fake DB）额外
    // 增加需要模拟的 Prisma 方法面。
    const latest = await tx.articleTemplate.findFirst({
      where: { templateKey: data.templateKey },
      orderBy: { version: "desc" },
      select: { version: true },
    });
    const version = (latest?.version ?? 0) + 1;
    const row = await tx.articleTemplate.create({
      data: {
        ...data,
        version,
        contentTemplate: data.contentTemplate as unknown as Prisma.InputJsonValue,
        seoTemplate: data.seoTemplate as Prisma.InputJsonValue,
      },
    });
    await tx.operationAudit.create({ data: {
      actorType: "admin", actorId: context.identity.id, action: "article_template.create",
      entityType: "ArticleTemplate", entityId: row.id, requestId: input.requestId,
      afterSnapshot: { templateKey: row.templateKey, version: row.version, status: row.status },
    } });
    return row;
  });
}

export async function updateArticleTemplate(input: {
  authorization: AdminServiceAuthorization;
  requestId: string;
  id: string;
  template: ArticleTemplateWrite;
}, deps: ArticleTemplateServiceDependencies) {
  const context = await authorize(input.authorization, "admin.article_template.update", input.requestId, deps);
  const data = storage(input.template);
  return deps.db.$transaction(async (tx) => {
    const before = await tx.articleTemplate.findFirstOrThrow({ where: { id: input.id, deletedAt: null } });
    const row = await tx.articleTemplate.update({
      where: { id: input.id },
      data: {
        ...data,
        contentTemplate: data.contentTemplate as unknown as Prisma.InputJsonValue,
        seoTemplate: data.seoTemplate as Prisma.InputJsonValue,
      },
    });
    await tx.operationAudit.create({ data: {
      actorType: "admin", actorId: context.identity.id, action: "article_template.update",
      entityType: "ArticleTemplate", entityId: row.id, requestId: input.requestId,
      beforeSnapshot: { templateKey: before.templateKey, version: before.version, status: before.status },
      afterSnapshot: { templateKey: row.templateKey, version: row.version, status: row.status },
    } });
    return row;
  });
}

export async function setArticleTemplateStatus(input: {
  authorization: AdminServiceAuthorization; requestId: string; id: string; status: ArticleTemplateStatus;
}, deps: ArticleTemplateServiceDependencies) {
  const context = await authorize(input.authorization, "admin.article_template.status", input.requestId, deps);
  if (!(["draft", "active", "inactive"] as const).includes(input.status)) throw new ArticleTemplateInputError("template_status_invalid");
  return deps.db.$transaction(async (tx) => {
    const row = await tx.articleTemplate.update({ where: { id: input.id }, data: { status: input.status } });
    await tx.operationAudit.create({ data: {
      actorType: "admin", actorId: context.identity.id, action: "article_template.status",
      entityType: "ArticleTemplate", entityId: row.id, requestId: input.requestId,
      afterSnapshot: { status: row.status },
    } });
    return row;
  });
}

export async function softDeleteArticleTemplate(input: {
  authorization: AdminServiceAuthorization; requestId: string; id: string;
}, deps: ArticleTemplateServiceDependencies) {
  const context = await authorize(input.authorization, "admin.article_template.delete", input.requestId, deps);
  const now = deps.now ?? new Date();
  return deps.db.$transaction(async (tx) => {
    const row = await tx.articleTemplate.update({ where: { id: input.id }, data: { deletedAt: now, status: "inactive" } });
    await tx.operationAudit.create({ data: {
      actorType: "admin", actorId: context.identity.id, action: "article_template.delete",
      entityType: "ArticleTemplate", entityId: row.id, requestId: input.requestId,
      afterSnapshot: { deletedAt: now.toISOString(), status: "inactive" },
    } });
    return row;
  });
}
