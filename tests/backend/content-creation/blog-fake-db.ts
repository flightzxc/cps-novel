/**
 * TEST_ONLY — a minimal hand-rolled double for exactly the three Prisma
 * call shapes `src/server/content-creation/blog.ts`'s `createBlogArticle`
 * issues inside its one `$transaction` (`article.findFirst`/
 * `article.create`/`operationAudit.create`). Same "one method per real call
 * shape, not a general query engine" discipline as this directory's own
 * `fake-db.ts` — deliberately a separate, smaller fake rather than an
 * extension of that one, since `createContentFromSourceItem`'s call shape
 * (Novel/NovelSourceItem/ArticleTemplate joins) is much wider than this
 * function's. Shared between `blog.test.ts` (unit coverage of
 * `createBlogArticle` itself) and `blog-publish-gate-e2e.test.ts` (the
 * plan's end-to-end confirmation that a freshly created blog draft clears
 * the real, unmodified `evaluatePublishGate`).
 */
import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";

export function uniqueViolation(target: string | string[]): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
    code: "P2002",
    clientVersion: "test",
    meta: { target: Array.isArray(target) ? target : [target] },
  });
}

export type FakeArticleRow = {
  id: string;
  novelId: string | null;
  templateId: string | null;
  promoLinkId: string | null;
  articleType: string;
  contentMode: string;
  locale: string;
  slug: string;
  publicPageShortId: string;
  title: string;
  summary: string | null;
  body: string;
  seoMetadata: unknown;
  seoVisibility: string;
  deletedAt: null;
};

/** `forceCreateConflict` simulates the race-window case (pre-check clear, insert itself hits the unique index) without needing real concurrency. */
export class FakeBlogArticleDb {
  readonly articles: FakeArticleRow[] = [];
  readonly audits: Array<Record<string, unknown>> = [];
  readonly createCalls: Array<Record<string, unknown>> = [];
  forceCreateConflict: "locale_slug" | null = null;

  seed(row: Partial<FakeArticleRow> & { locale: string; slug: string }): this {
    this.articles.push({
      id: randomUUID(),
      novelId: null,
      templateId: null,
      promoLinkId: null,
      articleType: "blog_article",
      contentMode: "manual",
      publicPageShortId: randomUUID().slice(0, 8),
      title: "Existing",
      summary: null,
      body: "Existing body",
      seoMetadata: {},
      seoVisibility: "public",
      deletedAt: null,
      ...row,
    });
    return this;
  }

  private article = {
    findFirst: async ({ where }: { where: { locale: string; slug: string; deletedAt: null } }) => {
      return (
        this.articles.find(
          (row) => row.locale === where.locale && row.slug === where.slug && row.deletedAt === where.deletedAt,
        ) ?? null
      );
    },
    create: async ({ data }: { data: Record<string, unknown> }) => {
      this.createCalls.push({ ...data });
      if (this.forceCreateConflict === "locale_slug") {
        throw uniqueViolation("article_locale_slug_active_uidx");
      }
      const row = { ...(data as FakeArticleRow), id: randomUUID(), deletedAt: null };
      this.articles.push(row);
      return row;
    },
  };

  private operationAudit = {
    create: async ({ data }: { data: Record<string, unknown> }) => {
      this.audits.push({ ...data });
      return data;
    },
  };

  private buildClient() {
    return { article: this.article, operationAudit: this.operationAudit };
  }

  $transaction = async <T>(fn: (tx: ReturnType<typeof this.buildClient>) => Promise<T>): Promise<T> =>
    fn(this.buildClient());

  /** Same escape hatch as `./fake-db.ts`'s own `asPrismaClient()` — `createBlogArticle` is typed against the real `PrismaClient`, not a narrower port. */
  asPrismaClient(): PrismaClient {
    return this as unknown as PrismaClient;
  }
}
