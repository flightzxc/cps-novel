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

export type ArticleTemplateStatus = "draft" | "active" | "inactive";

export type ArticleTemplateWrite = {
  readonly templateKey: string;
  readonly locale?: string | null;
  readonly version: number;
  readonly schemaVersion?: number;
  readonly status: ArticleTemplateStatus;
  readonly titleTemplate: string;
  readonly bodyTemplate: string;
  readonly metaTitleTemplate?: string;
  readonly metaDescriptionTemplate?: string;
};

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

function storage(input: ArticleTemplateWrite) {
  const templateKey = required(input.templateKey, "template_key_invalid", 96);
  if (!Number.isSafeInteger(input.version) || input.version < 1) {
    throw new ArticleTemplateInputError("template_version_invalid");
  }
  if (!(["draft", "active", "inactive"] as const).includes(input.status)) {
    throw new ArticleTemplateInputError("template_status_invalid");
  }
  const schemaVersion = input.schemaVersion ?? 1;
  const seoTemplate = {
    title: required(input.titleTemplate, "template_title_invalid", 20_000),
    ...(input.metaTitleTemplate === undefined ? {} : { metaTitle: input.metaTitleTemplate }),
    ...(input.metaDescriptionTemplate === undefined ? {} : { metaDescription: input.metaDescriptionTemplate }),
  };
  const stored = {
    templateKey,
    locale: input.locale?.trim() || null,
    version: input.version,
    schemaVersion,
    status: input.status,
    bodyTemplate: required(input.bodyTemplate, "template_body_invalid", 500_000),
    seoTemplate,
  };
  validateStoredArticleTemplate(stored);
  return stored;
}

export function validateStoredArticleTemplate(input: {
  readonly templateKey: string;
  readonly schemaVersion: number;
  readonly bodyTemplate: string;
  readonly seoTemplate: unknown;
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

export async function ensureDefaultArticleTemplate(
  tx: Pick<Prisma.TransactionClient, "articleTemplate">,
) {
  const count = await tx.articleTemplate.count({ where: { deletedAt: null } });
  if (count > 0) return null;
  return tx.articleTemplate.create({
    data: {
      templateKey: DEFAULT_ARTICLE_TEMPLATE_KEY,
      locale: "en",
      version: 1,
      schemaVersion: 1,
      status: "active",
      bodyTemplate: DEFAULT_ARTICLE_TEMPLATE.body,
      seoTemplate: {
        title: DEFAULT_ARTICLE_TEMPLATE.title,
        metaTitle: DEFAULT_ARTICLE_TEMPLATE.metaTitle ?? DEFAULT_ARTICLE_TEMPLATE.title,
        metaDescription: DEFAULT_ARTICLE_TEMPLATE.metaDescription ?? "{novel_description}",
      },
    },
  });
}

const TEMPLATE_SELECT = {
  id: true,
  templateKey: true,
  locale: true,
  version: true,
  schemaVersion: true,
  status: true,
  bodyTemplate: true,
  seoTemplate: true,
  deletedAt: true,
  createdAt: true,
  updatedAt: true,
} as const;

export async function selectActiveArticleTemplate(
  db: Pick<PrismaClient, "articleTemplate">,
  input: { readonly locale: string; readonly templateKey?: string },
) {
  const localeWhere = { OR: [{ locale: input.locale }, { locale: null }] };
  if (input.templateKey) {
    return db.articleTemplate.findFirst({
      where: { templateKey: input.templateKey, status: "active", deletedAt: null, ...localeWhere },
      select: TEMPLATE_SELECT,
      orderBy: { version: "desc" },
    });
  }
  const preferred = await db.articleTemplate.findFirst({
    where: { templateKey: DEFAULT_ARTICLE_TEMPLATE_KEY, status: "active", deletedAt: null, ...localeWhere },
    select: TEMPLATE_SELECT,
    orderBy: { version: "desc" },
  });
  return preferred ?? db.articleTemplate.findFirst({
    where: { status: "active", deletedAt: null, ...localeWhere },
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

export async function listActiveArticleTemplateOptions(db: PrismaClient, locale: string) {
  return db.articleTemplate.findMany({
    where: { status: "active", deletedAt: null, OR: [{ locale }, { locale: null }] },
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
    const row = await tx.articleTemplate.create({ data: { ...data, seoTemplate: data.seoTemplate as Prisma.InputJsonValue } });
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
    const row = await tx.articleTemplate.update({ where: { id: input.id }, data: { ...data, seoTemplate: data.seoTemplate as Prisma.InputJsonValue } });
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
