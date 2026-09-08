import type { PrismaClient } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { hashAdminSessionToken } from "@/lib/auth/session";
import type { AdminIdentity, AdminSessionRecord } from "@/lib/auth/types";
import { requireAdminActionAccess } from "@/server/auth/guards";
import { P2_04_ADMIN_REGISTRY } from "@/app/api/admin/_lib/registry";
import { AdminContentQueryError } from "@/server/admin-content";
import {
  ARTICLE_LIST_MAX_PAGE_SIZE,
  ARTICLE_REGENERATE_BATCH_MAX,
  ARTICLE_REGENERATE_BUDGET_MS,
  ArticleConflictError,
  listArticles,
  listDistinctArticleLocales,
  regenerateArticle,
  regenerateArticlesBatch,
  updateArticleContent,
} from "@/server/articles";

import { TestOnlyInMemoryAuthStores } from "../auth/test-only-in-memory-stores";

/**
 * M7 bite tests (交接提示词 B-2 / 施工规格 ACCEPTANCE_MATRIX row "M7 Article")
 * plus N-7 (optimistic lock) and N-8 (body sanitization on the admin edit
 * path — see `sanitize-body.test.ts` for the sanitizer's own unit coverage;
 * this file only asserts `updateArticleContent` actually calls it).
 *
 * Mutation targets reproduced from the CHANGES_REQUIRED report / matrix:
 *   - "再生成改 slug → 红": "regenerateArticle 保留 slug/publicPageShortId"
 *     below asserts the row's slug/shortId are byte-identical before/after a
 *     successful regenerate.
 *   - N-7: "expectedUpdatedAt 不匹配时 update/regenerate 都返回冲突" below.
 */

const NOW = new Date("2026-09-05T03:00:00.000Z");
const TOKEN = "articles-service-session";
const ORIGIN = "https://admin.example.com";

type ArticleRow = {
  id: string;
  novelId: string;
  templateId: string | null;
  promoLinkId: string | null;
  locale: string;
  slug: string;
  publicPageShortId: string;
  title: string;
  summary: string | null;
  body: string;
  seoMetadata: unknown;
  seoSchemaVersion: number;
  status: string;
  /** C-25: `Article.seoVisibility` (C-24 axes foundation). */
  seoVisibility: string;
  /** C-26: `Article.articleType`/`Article.contentMode` (C-24 axes foundation, maintained by C-26). */
  articleType: string;
  contentMode: string;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

type NovelRow = { id: string; title: string; description: string; coverUrl: string | null; totalChapterCount: number };
type PromoLinkRow = { id: string; publicRedirectCode: string };
type TemplateRow = {
  id: string;
  templateKey: string;
  templateName: string;
  locale: string | null;
  version: number;
  schemaVersion: number;
  status: string;
  bodyTemplate: string;
  seoTemplate: unknown;
  deletedAt: Date | null;
};
/** C-20: `CanonicalTag` catalog entry — only what `listRow`'s 分类 projection needs. */
type CanonicalTagRow = { stableId: string; zhDisplayName: string | null };

let nextUpdatedAt = NOW.getTime();
function bumpedNow(): Date {
  nextUpdatedAt += 1;
  return new Date(nextUpdatedAt);
}

/** Only-what's-used-here in-memory `article`/`articleTemplate`/`novelChapter`/`operationAudit` double. */
class FakeArticlesDb {
  readonly articles: ArticleRow[] = [];
  readonly novels = new Map<string, NovelRow>();
  readonly promoLinks = new Map<string, PromoLinkRow>();
  readonly templates: TemplateRow[] = [];
  readonly audits: Array<Record<string, unknown>> = [];
  /** C-19: `NovelCanonicalTag` links — only what `canonicalTagId`'s EXISTS filter needs. */
  readonly novelCanonicalTags: Array<{ novelId: string; canonicalTagId: string }> = [];
  /** C-20: `CanonicalTag` catalog, keyed by id — resolves `novelCanonicalTags`' ids to display names in `listRow`. */
  readonly canonicalTagCatalog = new Map<string, CanonicalTagRow>();

  private fullRow(row: ArticleRow) {
    const novel = this.novels.get(row.novelId)!;
    const promoLink = row.promoLinkId ? this.promoLinks.get(row.promoLinkId) ?? null : null;
    return {
      ...structuredClone(row),
      novel: structuredClone(novel),
      promoLink: promoLink ? structuredClone(promoLink) : null,
    };
  }

  private client() {
    return {
      article: {
        findFirst: async (args: { where: Record<string, unknown> }) => {
          const row = this.articles.find((candidate) => this.matches(candidate, args.where));
          return row ? this.fullRow(row) : null;
        },
        findFirstOrThrow: async (args: { where: Record<string, unknown> }) => {
          const row = this.articles.find((candidate) => this.matches(candidate, args.where));
          if (!row) throw new Error("article_not_found");
          return this.fullRow(row);
        },
        update: async (args: { where: { id: string }; data: Record<string, unknown> }) => {
          const row = this.articles.find((candidate) => candidate.id === args.where.id);
          if (!row) throw new Error("article_not_found");
          Object.assign(row, args.data, { updatedAt: (args.data.updatedAt as Date | undefined) ?? bumpedNow() });
          return this.fullRow(row);
        },
        updateMany: async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
          const row = this.articles.find((candidate) => this.matches(candidate, args.where));
          if (!row) return { count: 0 };
          Object.assign(row, args.data, { updatedAt: (args.data.updatedAt as Date | undefined) ?? bumpedNow() });
          return { count: 1 };
        },
        // M7 `listArticles` support. `orderBy`/`skip`/`take` mirror the real
        // Prisma call shape closely enough for the list tests below; `select`
        // is ignored — this fake always returns the same list-row shape
        // `listArticles` actually selects (id/title/locale/slug/
        // publicPageShortId/status/summary/updatedAt/template.templateKey).
        // C-19: `distinct`/`orderBy.locale` added for `listDistinctArticleLocales`.
        findMany: async (args: {
          where: Record<string, unknown>;
          orderBy?: { updatedAt?: "asc" | "desc"; locale?: "asc" | "desc" };
          skip?: number;
          take?: number;
          distinct?: readonly string[];
        }) => {
          let rows = this.articles.filter((candidate) => this.matches(candidate, args.where));
          if (args.distinct?.includes("locale")) {
            const seen = new Set<string>();
            rows = rows.filter((row) => (seen.has(row.locale) ? false : (seen.add(row.locale), true)));
          }
          if (args.orderBy?.locale) {
            const direction = args.orderBy.locale;
            rows = [...rows].sort((a, b) =>
              direction === "asc" ? a.locale.localeCompare(b.locale) : b.locale.localeCompare(a.locale),
            );
          } else if (args.orderBy?.updatedAt === "asc") {
            rows = [...rows].sort((a, b) => a.updatedAt.getTime() - b.updatedAt.getTime());
          } else {
            rows = [...rows].sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
          }
          const skip = args.skip ?? 0;
          const take = args.take ?? rows.length;
          return rows.slice(skip, skip + take).map((row) => this.listRow(row));
        },
        count: async (args: { where: Record<string, unknown> }) => {
          return this.articles.filter((candidate) => this.matches(candidate, args.where)).length;
        },
      },
      articleTemplate: {
        findFirst: async (args: { where: Record<string, unknown> }) => {
          const matched = this.templates.filter((row) => this.matchesTemplate(row, args.where));
          return matched[0] ? structuredClone(matched[0]) : null;
        },
      },
      novelChapter: {
        count: async () => 0,
      },
      operationAudit: {
        create: async (args: { data: Record<string, unknown> }) => {
          this.audits.push(structuredClone(args.data));
          return { id: BigInt(this.audits.length) };
        },
      },
      $transaction: async <T>(run: (tx: unknown) => Promise<T>): Promise<T> => run(this.client()),
    };
  }

  private matches(row: ArticleRow, where: Record<string, unknown>): boolean {
    if (where.id !== undefined && row.id !== where.id) return false;
    if ("deletedAt" in where && where.deletedAt === null && row.deletedAt !== null) return false;
    const updatedAt = where.updatedAt as { gte?: Date; lt?: Date } | undefined;
    if (updatedAt) {
      if (updatedAt.gte && row.updatedAt.getTime() < updatedAt.gte.getTime()) return false;
      if (updatedAt.lt && row.updatedAt.getTime() >= updatedAt.lt.getTime()) return false;
    }
    // M7 `listArticles` filters — plain equality, same as Prisma's `where: { locale }` etc.
    // C-25 added `seoVisibility`; C-26 added `articleType`/`contentMode` to this same equality family.
    for (const key of ["locale", "status", "novelId", "templateId", "seoVisibility", "articleType", "contentMode"] as const) {
      if (where[key] !== undefined && row[key] !== where[key]) return false;
    }
    // C-19 `search`: each of `buildArticleSearchOr`'s OR branches is either a
    // plain-string exact match (the shortId branch) or a `{contains, mode}`
    // clause (title/slug/publicPageShortId) — mirrors Prisma's own `StringFilter`.
    for (const key of ["title", "slug", "publicPageShortId"] as const) {
      const clause = where[key] as { contains?: string; mode?: string } | string | undefined;
      if (clause === undefined) continue;
      if (typeof clause === "string") {
        if (row[key] !== clause) return false;
      } else if (clause.contains !== undefined) {
        const insensitive = clause.mode === "insensitive";
        const haystack = insensitive ? row[key].toLowerCase() : row[key];
        const needle = insensitive ? clause.contains.toLowerCase() : clause.contains;
        if (!haystack.includes(needle)) return false;
      }
    }
    // `OR` — recurses into `matches` itself so any of the clause shapes above
    // (or a further nested `OR`) evaluate correctly inside each branch.
    if (where.OR) {
      const options = where.OR as ReadonlyArray<Record<string, unknown>>;
      if (!options.some((option) => this.matches(row, option))) return false;
    }
    // C-19 `canonicalTagId`: `novel: { canonicalTags: { some: { canonicalTagId } } }`,
    // Prisma's EXISTS-style relation filter — evaluated against `novelCanonicalTags`.
    if (where.novel) {
      const novelWhere = where.novel as { canonicalTags?: { some?: { canonicalTagId?: string } } };
      const wantedTagId = novelWhere.canonicalTags?.some?.canonicalTagId;
      if (wantedTagId !== undefined) {
        const hasTag = this.novelCanonicalTags.some(
          (link) => link.novelId === row.novelId && link.canonicalTagId === wantedTagId,
        );
        if (!hasTag) return false;
      }
    }
    return true;
  }

  /**
   * `listArticles`'s row shape post-C-20: id/title/locale/slug/
   * publicPageShortId/status/summary/updatedAt/createdAt +
   * template.{templateKey,templateName} + novel.{id,title,canonicalTags}.
   * `novel.canonicalTags` mirrors the real nested Prisma select exactly
   * (`canonicalTagId` + `canonicalTag.{stableId,translations}`) so
   * `listArticles`'s own `articleCanonicalTagNames` row-mapping code runs
   * unmodified against this fake, the same way it runs against Prisma.
   */
  private listRow(row: ArticleRow) {
    const template = row.templateId ? this.templates.find((candidate) => candidate.id === row.templateId) ?? null : null;
    const novel = this.novels.get(row.novelId)!;
    const novelCanonicalTags = this.novelCanonicalTags
      .filter((link) => link.novelId === row.novelId)
      .map((link) => {
        const tag = this.canonicalTagCatalog.get(link.canonicalTagId);
        return {
          canonicalTagId: link.canonicalTagId,
          canonicalTag: {
            stableId: tag?.stableId ?? link.canonicalTagId,
            translations: tag?.zhDisplayName ? [{ displayName: tag.zhDisplayName }] : [],
          },
        };
      });
    return {
      id: row.id,
      title: row.title,
      locale: row.locale,
      slug: row.slug,
      publicPageShortId: row.publicPageShortId,
      status: row.status,
      seoVisibility: row.seoVisibility,
      articleType: row.articleType,
      contentMode: row.contentMode,
      summary: row.summary,
      updatedAt: row.updatedAt,
      createdAt: row.createdAt,
      template: template ? { templateKey: template.templateKey, templateName: template.templateName } : null,
      novel: { id: row.novelId, title: novel.title, canonicalTags: novelCanonicalTags },
    };
  }

  /**
   * Recursive so it can evaluate the `AND: [{OR:[...]}, {OR:[...]}]` shape
   * `selectActiveArticleTemplate` builds (P2-02B: it combines the locale clause and the
   * optional applicableArticleType clause under `AND` because two top-level `OR` keys
   * can't be merged by object spread — the second would silently clobber the first).
   * Without `AND` handling here, an unrecognized `AND` key was previously ignored
   * entirely, which made every template match regardless of locale.
   */
  private matchesTemplate(row: TemplateRow, where: Record<string, unknown>): boolean {
    if (where.id !== undefined && row.id !== where.id) return false;
    if (where.templateKey !== undefined && row.templateKey !== where.templateKey) return false;
    if (where.status !== undefined && row.status !== where.status) return false;
    if (where.locale !== undefined && row.locale !== where.locale) return false;
    if ("deletedAt" in where && where.deletedAt === null && row.deletedAt !== null) return false;
    if (where.OR) {
      const options = where.OR as ReadonlyArray<Record<string, unknown>>;
      if (!options.some((option) => this.matchesTemplate(row, option))) return false;
    }
    if (where.AND) {
      const clauses = where.AND as ReadonlyArray<Record<string, unknown>>;
      if (!clauses.every((clause) => this.matchesTemplate(row, clause))) return false;
    }
    return true;
  }

  asPrismaClient(): PrismaClient {
    return this.client() as unknown as PrismaClient;
  }
}

function seedArticle(db: FakeArticlesDb, overrides: Partial<ArticleRow> & { id: string; novelId: string }): ArticleRow {
  const row: ArticleRow = {
    templateId: null,
    promoLinkId: null,
    locale: "en",
    slug: "some-novel",
    publicPageShortId: "AbCdEf12",
    title: "Some Novel",
    summary: "A summary",
    body: "<p>Original body</p>",
    seoMetadata: {},
    seoSchemaVersion: 1,
    status: "draft",
    seoVisibility: "public",
    articleType: "novel_article",
    contentMode: "template",
    deletedAt: null,
    createdAt: new Date(NOW),
    updatedAt: new Date(NOW),
    ...overrides,
  };
  db.articles.push(row);
  return row;
}

function seedNovel(db: FakeArticlesDb, id: string, overrides: Partial<NovelRow> = {}): NovelRow {
  const novel: NovelRow = { id, title: "Some Novel", description: "A description", coverUrl: null, totalChapterCount: 10, ...overrides };
  db.novels.set(id, novel);
  return novel;
}

/** C-19: links a novel to a Canonical Tag id, for `canonicalTagId`'s EXISTS filter. */
function linkNovelCanonicalTag(db: FakeArticlesDb, novelId: string, canonicalTagId: string): void {
  db.novelCanonicalTags.push({ novelId, canonicalTagId });
}

/** C-20: registers a Canonical Tag's display info, resolved by `listRow` for the 分类 column. */
function seedCanonicalTag(db: FakeArticlesDb, id: string, overrides: Partial<CanonicalTagRow> & { stableId: string }): void {
  db.canonicalTagCatalog.set(id, { zhDisplayName: null, ...overrides });
}

function seedTemplate(db: FakeArticlesDb, overrides: Partial<TemplateRow> & { id: string; templateKey: string }): TemplateRow {
  const row: TemplateRow = {
    templateName: overrides.templateKey,
    locale: "en",
    version: 1,
    schemaVersion: 1,
    status: "active",
    bodyTemplate: "<article><h1>{novel_title}</h1><p>{novel_description}</p></article>",
    seoTemplate: { title: "{novel_title}", metaTitle: "{novel_title}", metaDescription: "{novel_description}" },
    deletedAt: null,
    ...overrides,
  };
  db.templates.push(row);
  return row;
}

function authFixture() {
  const stores = new TestOnlyInMemoryAuthStores();
  const identity: AdminIdentity = {
    id: "admin-1",
    username: "admin",
    role: "super_admin",
    status: "active",
    sessionVersion: 1,
    twoFactorEnabled: true,
  };
  const session: AdminSessionRecord = {
    id: "session-1",
    tokenHash: hashAdminSessionToken(TOKEN),
    identityId: identity.id,
    sessionVersion: 1,
    issuedAt: new Date(NOW.getTime() - 60 * 60 * 1000),
    lastSeenAt: new Date(NOW.getTime() - 60_000),
    absoluteExpiresAt: new Date(NOW.getTime() + 23 * 60 * 60 * 1000),
    twoFactorCompletedAt: new Date(NOW.getTime() - 30_000),
    revokedAt: null,
  };
  stores.identities.set(identity.id, identity);
  stores.sessions.set(session.id, session);
  return stores;
}

async function authorization(stores: TestOnlyInMemoryAuthStores, actionId: string, requestId = "550e8400-e29b-41d4-a716-446655440000") {
  const guarded = await requireAdminActionAccess(
    { actionId, sessionToken: TOKEN, origin: ORIGIN, canonicalOrigin: ORIGIN, requestId },
    { identities: stores, sessions: stores, registry: P2_04_ADMIN_REGISTRY, now: NOW, env: {} as NodeJS.ProcessEnv },
  );
  return { authorization: guarded.serviceAuthorization!, requestId };
}

function deps(db: FakeArticlesDb, stores: TestOnlyInMemoryAuthStores) {
  return { db: db.asPrismaClient(), identities: stores, sessions: stores, now: NOW };
}

beforeEach(() => {
  nextUpdatedAt = NOW.getTime();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("updateArticleContent", () => {
  it("写 body（经 N-8 白名单清洗）与 seoMetadata，并落审计", async () => {
    const db = new FakeArticlesDb();
    seedNovel(db, "novel-1");
    const row = seedArticle(db, { id: "article-1", novelId: "novel-1" });
    const stores = authFixture();
    const guarded = await authorization(stores, "admin.article.update");

    const updated = await updateArticleContent(
      {
        ...guarded,
        articleId: row.id,
        expectedUpdatedAt: row.updatedAt.toISOString(),
        patch: {
          title: "New Title",
          summary: "New summary",
          body: '<p>hi</p><script>alert(1)</script>',
          metaTitle: "New meta title",
          metaDescription: "New meta description",
        },
      },
      deps(db, stores),
    );

    expect(updated.title).toBe("New Title");
    expect(updated.body).toBe("<p>hi</p>");
    expect(updated.body).not.toContain("script");
    expect(updated.seoMetadata).toMatchObject({ metaTitle: "New meta title", metaDescription: "New meta description" });
    expect(db.audits).toHaveLength(1);
    expect(db.audits[0]).toMatchObject({ action: "article.update", entityType: "Article", entityId: row.id });
  });

  it("N-7：expectedUpdatedAt 与当前行不一致时抛 ArticleConflictError，不写入", async () => {
    const db = new FakeArticlesDb();
    seedNovel(db, "novel-1");
    const row = seedArticle(db, { id: "article-1", novelId: "novel-1" });
    const stores = authFixture();
    const guarded = await authorization(stores, "admin.article.update");

    await expect(
      updateArticleContent(
        {
          ...guarded,
          articleId: row.id,
          expectedUpdatedAt: new Date(row.updatedAt.getTime() - 5_000).toISOString(),
          patch: { title: "Should not land", summary: "", body: "<p>x</p>", metaTitle: "", metaDescription: "" },
        },
        deps(db, stores),
      ),
    ).rejects.toBeInstanceOf(ArticleConflictError);

    expect(db.articles.find((candidate) => candidate.id === row.id)!.title).toBe(row.title);
    expect(db.audits).toHaveLength(0);
  });

  /**
   * C-25 (`规划_文章管理能力补齐_博客类型可见性换小说_2026-09-08.md` §三/C-25):
   * "文章编辑写入服务在补丁里接受可选的 seoVisibility，落库前按取值域校验，写入
   * 进既有的乐观锁事务，审计前后快照里带上该字段" — this test pins all four
   * clauses at once.
   */
  it("接受可选的 seoVisibility，写入并在审计前后快照中都带上它", async () => {
    const db = new FakeArticlesDb();
    seedNovel(db, "novel-1");
    const row = seedArticle(db, { id: "article-1", novelId: "novel-1", seoVisibility: "public" });
    const stores = authFixture();
    const guarded = await authorization(stores, "admin.article.update");

    const updated = await updateArticleContent(
      {
        ...guarded,
        articleId: row.id,
        expectedUpdatedAt: row.updatedAt.toISOString(),
        patch: {
          title: row.title,
          summary: row.summary ?? "",
          body: row.body,
          metaTitle: "",
          metaDescription: "",
          seoVisibility: "hidden",
        },
      },
      deps(db, stores),
    );

    expect(updated.seoVisibility).toBe("hidden");
    expect(db.audits).toHaveLength(1);
    expect(db.audits[0]).toMatchObject({
      beforeSnapshot: expect.objectContaining({ seoVisibility: "public" }),
      afterSnapshot: expect.objectContaining({ seoVisibility: "hidden" }),
    });
  });

  it("省略 seoVisibility 时保持原值不变（补丁字段缺省 = 不动该列）", async () => {
    const db = new FakeArticlesDb();
    seedNovel(db, "novel-1");
    const row = seedArticle(db, { id: "article-1", novelId: "novel-1", seoVisibility: "seo_only" });
    const stores = authFixture();
    const guarded = await authorization(stores, "admin.article.update");

    const updated = await updateArticleContent(
      {
        ...guarded,
        articleId: row.id,
        expectedUpdatedAt: row.updatedAt.toISOString(),
        patch: { title: "New Title", summary: "", body: "<p>x</p>", metaTitle: "", metaDescription: "" },
      },
      deps(db, stores),
    );

    expect(updated.seoVisibility).toBe("seo_only");
  });

  it("非法 seoVisibility 被拒绝，不写入、不落审计", async () => {
    const db = new FakeArticlesDb();
    seedNovel(db, "novel-1");
    const row = seedArticle(db, { id: "article-1", novelId: "novel-1", seoVisibility: "public" });
    const stores = authFixture();
    const guarded = await authorization(stores, "admin.article.update");

    await expect(
      updateArticleContent(
        {
          ...guarded,
          articleId: row.id,
          expectedUpdatedAt: row.updatedAt.toISOString(),
          patch: {
            title: row.title,
            summary: row.summary ?? "",
            body: row.body,
            metaTitle: "",
            metaDescription: "",
            seoVisibility: "bogus",
          },
        },
        deps(db, stores),
      ),
    ).rejects.toThrow("article_seo_visibility_invalid");

    expect(db.articles.find((candidate) => candidate.id === row.id)!.seoVisibility).toBe("public");
    expect(db.audits).toHaveLength(0);
  });

  /**
   * C-26 (`规划_文章管理能力补齐_博客类型可见性换小说_2026-09-08.md` §三/C-26):
   * "运营手改正文的写入服务：把 contentMode 写成 manual（与正文、摘要、SEO
   * 元数据同一个乐观锁事务，审计前后快照带上）" — unconditional (unlike
   * `seoVisibility`, there is no patch flag gating this): every call to this
   * function is, by definition, a human hand-edit, so `contentMode` always
   * flips to `"manual"`, even starting from `"template"`.
   */
  it("把 contentMode 写成 manual（无条件，与正文同一事务，审计前后快照带上）", async () => {
    const db = new FakeArticlesDb();
    seedNovel(db, "novel-1");
    const row = seedArticle(db, { id: "article-1", novelId: "novel-1", contentMode: "template" });
    const stores = authFixture();
    const guarded = await authorization(stores, "admin.article.update");

    const updated = await updateArticleContent(
      {
        ...guarded,
        articleId: row.id,
        expectedUpdatedAt: row.updatedAt.toISOString(),
        patch: { title: "New Title", summary: "New summary", body: "<p>hand-edited</p>", metaTitle: "", metaDescription: "" },
      },
      deps(db, stores),
    );

    expect(updated.contentMode).toBe("manual");
    expect(db.audits).toHaveLength(1);
    expect(db.audits[0]).toMatchObject({
      beforeSnapshot: expect.objectContaining({ contentMode: "template" }),
      afterSnapshot: expect.objectContaining({ contentMode: "manual" }),
    });
  });

  it("即使文章已经是 manual，再次手改仍保持 manual（幂等）", async () => {
    const db = new FakeArticlesDb();
    seedNovel(db, "novel-1");
    const row = seedArticle(db, { id: "article-1", novelId: "novel-1", contentMode: "manual" });
    const stores = authFixture();
    const guarded = await authorization(stores, "admin.article.update");

    const updated = await updateArticleContent(
      {
        ...guarded,
        articleId: row.id,
        expectedUpdatedAt: row.updatedAt.toISOString(),
        patch: { title: "Another edit", summary: "", body: "<p>x</p>", metaTitle: "", metaDescription: "" },
      },
      deps(db, stores),
    );

    expect(updated.contentMode).toBe("manual");
  });
});

describe("regenerateArticle", () => {
  it("再生成保留 slug/publicPageShortId 不变（mutation target: 再生成改 slug → 红）", async () => {
    const db = new FakeArticlesDb();
    seedNovel(db, "novel-1", { title: "Regenerated Title", description: "Regenerated description" });
    seedTemplate(db, { id: "template-1", templateKey: "tpl-1" });
    const row = seedArticle(db, {
      id: "article-1",
      novelId: "novel-1",
      templateId: "template-1",
      slug: "original-slug-must-survive",
      publicPageShortId: "OriginalShortId1",
    });
    const stores = authFixture();
    const guarded = await authorization(stores, "admin.article.regenerate");

    const result = await regenerateArticle(
      { ...guarded, articleId: row.id, expectedUpdatedAt: row.updatedAt.toISOString() },
      deps(db, stores),
    );

    expect(result.outcome).toBe("regenerated");
    const after = db.articles.find((candidate) => candidate.id === row.id)!;
    expect(after.slug).toBe("original-slug-must-survive");
    expect(after.publicPageShortId).toBe("OriginalShortId1");
    expect(after.title).toBe("Regenerated Title");
  });

  it("N-7：expectedUpdatedAt 不匹配时返回 conflict outcome，不落库", async () => {
    const db = new FakeArticlesDb();
    seedNovel(db, "novel-1");
    seedTemplate(db, { id: "template-1", templateKey: "tpl-1" });
    const row = seedArticle(db, { id: "article-1", novelId: "novel-1", templateId: "template-1", title: "Stale-check title" });
    const stores = authFixture();
    const guarded = await authorization(stores, "admin.article.regenerate");

    const result = await regenerateArticle(
      { ...guarded, articleId: row.id, expectedUpdatedAt: new Date(row.updatedAt.getTime() - 1_000).toISOString() },
      deps(db, stores),
    );

    expect(result.outcome).toBe("conflict");
    expect(db.articles.find((candidate) => candidate.id === row.id)!.title).toBe("Stale-check title");
  });

  it("文章不存在时返回 article_not_found", async () => {
    const db = new FakeArticlesDb();
    const stores = authFixture();
    const guarded = await authorization(stores, "admin.article.regenerate");
    const result = await regenerateArticle(
      { ...guarded, articleId: "missing", expectedUpdatedAt: NOW.toISOString() },
      deps(db, stores),
    );
    expect(result.outcome).toBe("article_not_found");
  });

  /**
   * C-26: "模板渲染路径（创建服务里的文章插入、再生成服务的正文覆盖）：写成
   * template" — the N-7 CAS branch (`expectedUpdatedAt` supplied, this
   * function's own always-on contract). Pins that a re-render always
   * reasserts `"template"` even over an article a human had previously
   * hand-edited to `"manual"` — re-rendering from the template means the
   * body is no longer "last written by an operator".
   */
  it("再生成把 contentMode 写回 template，即使原先是 manual（CAS 分支）", async () => {
    const db = new FakeArticlesDb();
    seedNovel(db, "novel-1");
    seedTemplate(db, { id: "template-1", templateKey: "tpl-1" });
    const row = seedArticle(db, { id: "article-1", novelId: "novel-1", templateId: "template-1", contentMode: "manual" });
    const stores = authFixture();
    const guarded = await authorization(stores, "admin.article.regenerate");

    const result = await regenerateArticle(
      { ...guarded, articleId: row.id, expectedUpdatedAt: row.updatedAt.toISOString() },
      deps(db, stores),
    );

    expect(result.outcome).toBe("regenerated");
    expect(db.articles.find((candidate) => candidate.id === row.id)!.contentMode).toBe("template");
  });
});

describe("regenerateArticlesBatch", () => {
  it("超过 50 个选择直接拒绝", async () => {
    const db = new FakeArticlesDb();
    const stores = authFixture();
    const guarded = await authorization(stores, "admin.article.regenerate_batch");
    const tooMany = Array.from({ length: ARTICLE_REGENERATE_BATCH_MAX + 1 }, (_, index) => `id-${index}`);
    await expect(regenerateArticlesBatch({ ...guarded, articleIds: tooMany }, deps(db, stores))).rejects.toThrow(
      "article_batch_selection_invalid",
    );
  });

  it("四态：regenerated / skipped(不存在) / failed(无可用模板) / not_processed(超预算)", async () => {
    const db = new FakeArticlesDb();
    seedNovel(db, "novel-ok");
    seedTemplate(db, { id: "template-1", templateKey: "tpl-1", locale: "en" });
    seedArticle(db, { id: "ok", novelId: "novel-ok", templateId: "template-1", locale: "en" });
    // No active template exists for "fr" — `selectActiveArticleTemplate` returns null.
    seedNovel(db, "novel-no-template");
    seedArticle(db, { id: "no-template", novelId: "novel-no-template", templateId: null, locale: "fr" });

    const stores = authFixture();
    const guarded = await authorization(stores, "admin.article.regenerate_batch");

    // `Date.now()` is called once for `startedAt`, then once per loop
    // iteration's budget check (before that item is processed). Exceeding
    // the budget on the 4th check (index 3, the last id) forces that one
    // id — and only that one — into `not_processed`.
    const dateNowSpy = vi.spyOn(Date, "now");
    dateNowSpy
      .mockReturnValueOnce(0) // startedAt
      .mockReturnValueOnce(0) // idx0 check: "ok"
      .mockReturnValueOnce(0) // idx1 check: "no-template"
      .mockReturnValueOnce(0) // idx2 check: "missing"
      .mockReturnValue(ARTICLE_REGENERATE_BUDGET_MS); // idx3 check: "budget-exceeded" -> break

    const result = await regenerateArticlesBatch(
      { ...guarded, articleIds: ["ok", "no-template", "missing", "budget-exceeded"] },
      deps(db, stores),
    );

    expect(result.items).toEqual([
      { articleId: "ok", status: "regenerated", result: expect.objectContaining({ outcome: "regenerated" }) },
      { articleId: "no-template", status: "failed", result: expect.objectContaining({ outcome: "template_not_available" }) },
      { articleId: "missing", status: "skipped", result: expect.objectContaining({ outcome: "article_not_found" }) },
      { articleId: "budget-exceeded", status: "not_processed" },
    ]);
    expect(result.counts).toEqual({ regenerated: 1, skipped: 1, failed: 1, not_processed: 1 });
  });

  /**
   * C-26: same claim as `regenerateArticle`'s own contentMode test above, but
   * exercised through the *other* branch of `regenerateCore` — the batch
   * path never supplies `expectedUpdatedAt` (see that function's own doc
   * comment on why), so this is the one test in this file that actually
   * reaches the plain `tx.article.update(...)` write rather than the N-7
   * `updateMany` CAS write. Both branches are authorized `contentMode:`
   * write sites (see `content-mode-sole-write-paths.test.ts`), and both must
   * actually write it.
   */
  it("批量再生成（非 CAS 分支）也把 contentMode 写回 template", async () => {
    const db = new FakeArticlesDb();
    seedNovel(db, "novel-manual");
    seedTemplate(db, { id: "template-1", templateKey: "tpl-1", locale: "en" });
    const row = seedArticle(db, {
      id: "manual-article",
      novelId: "novel-manual",
      templateId: "template-1",
      locale: "en",
      contentMode: "manual",
    });
    const stores = authFixture();
    const guarded = await authorization(stores, "admin.article.regenerate_batch");

    const result = await regenerateArticlesBatch({ ...guarded, articleIds: [row.id] }, deps(db, stores));

    expect(result.items).toEqual([
      { articleId: row.id, status: "regenerated", result: expect.objectContaining({ outcome: "regenerated" }) },
    ]);
    expect(db.articles.find((candidate) => candidate.id === row.id)!.contentMode).toBe("template");
  });
});

describe("listArticles (M7 ①)", () => {
  /**
   * Mutation target: "列表筛选去掉 status 条件 → 红" — remove the `status`
   * branch from `service.ts`'s `where` object and this test (plus "组合筛选"
   * below, which also asserts on `status`) turns red, because `takedown-1`
   * (a `takedown` row that must not appear in a `status: "draft"` filter)
   * would leak into the result.
   */
  it("按 status 筛选：只返回该状态的行", async () => {
    const db = new FakeArticlesDb();
    seedNovel(db, "novel-1");
    seedArticle(db, { id: "draft-1", novelId: "novel-1", status: "draft" });
    seedArticle(db, { id: "published-1", novelId: "novel-1", status: "published", slug: "published-1" });
    seedArticle(db, { id: "takedown-1", novelId: "novel-1", status: "takedown", slug: "takedown-1" });

    const page = await listArticles(db.asPrismaClient(), { status: "draft" });

    expect(page.items.map((item) => item.id)).toEqual(["draft-1"]);
    expect(page.total).toBe(1);
  });

  it("按 locale 筛选：只返回该语种的行", async () => {
    const db = new FakeArticlesDb();
    seedNovel(db, "novel-en");
    seedNovel(db, "novel-fr");
    seedArticle(db, { id: "en-1", novelId: "novel-en", locale: "en" });
    seedArticle(db, { id: "fr-1", novelId: "novel-fr", locale: "fr", slug: "fr-1" });

    const page = await listArticles(db.asPrismaClient(), { locale: "en" });

    expect(page.items.map((item) => item.id)).toEqual(["en-1"]);
  });

  // `novelId`/`templateId` go through `requireArticleUuid` (M7 — see the
  // "非法 …（不是 UUID）" tests below), so these two seed real UUID-shaped
  // ids for the filter value even though every other test in this file uses
  // plain readable ids for `Article.id` (which is never UUID-validated).
  const NOVEL_A = "11111111-1111-4111-8111-111111111111";
  const NOVEL_B = "22222222-2222-4222-8222-222222222222";
  const TEMPLATE_A = "33333333-3333-4333-8333-333333333333";
  const TEMPLATE_B = "44444444-4444-4444-8444-444444444444";

  it("按 novelId 筛选：只返回该书目的行", async () => {
    const db = new FakeArticlesDb();
    seedNovel(db, NOVEL_A);
    seedNovel(db, NOVEL_B);
    seedArticle(db, { id: "a-1", novelId: NOVEL_A });
    seedArticle(db, { id: "b-1", novelId: NOVEL_B, slug: "b-1" });

    const page = await listArticles(db.asPrismaClient(), { novelId: NOVEL_A });

    expect(page.items.map((item) => item.id)).toEqual(["a-1"]);
  });

  it("按 templateId 筛选：只返回绑定该模板的行", async () => {
    const db = new FakeArticlesDb();
    seedNovel(db, "novel-1");
    seedTemplate(db, { id: TEMPLATE_A, templateKey: "tpl-a" });
    seedTemplate(db, { id: TEMPLATE_B, templateKey: "tpl-b" });
    seedArticle(db, { id: "tpl-a-article", novelId: "novel-1", templateId: TEMPLATE_A });
    seedArticle(db, { id: "tpl-b-article", novelId: "novel-1", templateId: TEMPLATE_B, slug: "tpl-b-article" });

    const page = await listArticles(db.asPrismaClient(), { templateId: TEMPLATE_A });

    expect(page.items.map((item) => item.id)).toEqual(["tpl-a-article"]);
    expect(page.items[0]!.templateKey).toBe("tpl-a");
  });

  /**
   * C-25 (`规划_文章管理能力补齐_博客类型可见性换小说_2026-09-08.md` §三/C-25):
   * "文章列表入参新增可选的 seoVisibility" — exact-match filter, same shape as
   * every other filter in this describe block.
   */
  it("按 seoVisibility 筛选：只返回该可见性的行", async () => {
    const db = new FakeArticlesDb();
    seedNovel(db, "novel-1");
    seedArticle(db, { id: "pub-1", novelId: "novel-1", seoVisibility: "public" });
    seedArticle(db, { id: "seo-only-1", novelId: "novel-1", seoVisibility: "seo_only", slug: "seo-only-1" });
    seedArticle(db, { id: "hidden-1", novelId: "novel-1", seoVisibility: "hidden", slug: "hidden-1" });

    const page = await listArticles(db.asPrismaClient(), { seoVisibility: "seo_only" });

    expect(page.items.map((item) => item.id)).toEqual(["seo-only-1"]);
    expect(page.total).toBe(1);
  });

  it("非法 seoVisibility 被 invalid_status 拒绝（复用同族错误码，本工单唯一允许的错误码复用）", async () => {
    const db = new FakeArticlesDb();
    await expect(listArticles(db.asPrismaClient(), { seoVisibility: "bogus" })).rejects.toMatchObject(
      { code: "invalid_status" },
    );
    await expect(listArticles(db.asPrismaClient(), { seoVisibility: "bogus" })).rejects.toBeInstanceOf(
      AdminContentQueryError,
    );
  });

  /**
   * C-26 (`规划_文章管理能力补齐_博客类型可见性换小说_2026-09-08.md` §三/C-26):
   * "文章列表入参新增可选的 articleType 与 contentMode；规范化按取值域校验；
   * where 各加一条相等条件" — same exact-match shape as `seoVisibility` above.
   */
  it("按 articleType 筛选：只返回该类型的行", async () => {
    const db = new FakeArticlesDb();
    seedNovel(db, "novel-1");
    seedArticle(db, { id: "novel-article-1", novelId: "novel-1", articleType: "novel_article" });
    seedArticle(db, { id: "blog-article-1", novelId: "novel-1", articleType: "blog_article", slug: "blog-article-1" });

    const page = await listArticles(db.asPrismaClient(), { articleType: "blog_article" });

    expect(page.items.map((item) => item.id)).toEqual(["blog-article-1"]);
    expect(page.total).toBe(1);
  });

  it("按 contentMode 筛选：只返回该内容模式的行", async () => {
    const db = new FakeArticlesDb();
    seedNovel(db, "novel-1");
    seedArticle(db, { id: "template-1", novelId: "novel-1", contentMode: "template" });
    seedArticle(db, { id: "manual-1", novelId: "novel-1", contentMode: "manual", slug: "manual-1" });

    const page = await listArticles(db.asPrismaClient(), { contentMode: "manual" });

    expect(page.items.map((item) => item.id)).toEqual(["manual-1"]);
    expect(page.total).toBe(1);
  });

  /**
   * C-26: "取值为空串或 all 时不筛...海阅统一对所有筛选做归一" — pins that
   * both spellings ("" and "all") normalize to "no filter" for these two
   * axes, matching the filter bar's own empty-option value (`""`) and the
   * literal CPS's service layer accepts for these newer axes ("all").
   */
  it("articleType/contentMode 传空串或 'all' 时视为不筛，不报错", async () => {
    const db = new FakeArticlesDb();
    seedNovel(db, "novel-1");
    seedArticle(db, { id: "a-1", novelId: "novel-1", articleType: "novel_article", contentMode: "template" });
    seedArticle(db, { id: "a-2", novelId: "novel-1", articleType: "blog_article", contentMode: "manual", slug: "a-2" });

    const empty = await listArticles(db.asPrismaClient(), { articleType: "", contentMode: "" });
    expect(empty.items.map((item) => item.id).sort()).toEqual(["a-1", "a-2"]);

    const all = await listArticles(db.asPrismaClient(), { articleType: "all", contentMode: "all" });
    expect(all.items.map((item) => item.id).sort()).toEqual(["a-1", "a-2"]);
  });

  it("非法 articleType 被 invalid_status 拒绝（复用同族错误码）", async () => {
    const db = new FakeArticlesDb();
    await expect(listArticles(db.asPrismaClient(), { articleType: "bogus" })).rejects.toMatchObject({
      code: "invalid_status",
    });
    await expect(listArticles(db.asPrismaClient(), { articleType: "bogus" })).rejects.toBeInstanceOf(
      AdminContentQueryError,
    );
  });

  it("非法 contentMode 被 invalid_status 拒绝（复用同族错误码）", async () => {
    const db = new FakeArticlesDb();
    await expect(listArticles(db.asPrismaClient(), { contentMode: "bogus" })).rejects.toMatchObject({
      code: "invalid_status",
    });
    await expect(listArticles(db.asPrismaClient(), { contentMode: "bogus" })).rejects.toBeInstanceOf(
      AdminContentQueryError,
    );
  });

  it("组合筛选（locale + status）：两个条件都要满足", async () => {
    const db = new FakeArticlesDb();
    seedNovel(db, "novel-1");
    seedArticle(db, { id: "en-draft", novelId: "novel-1", locale: "en", status: "draft" });
    seedArticle(db, { id: "en-published", novelId: "novel-1", locale: "en", status: "published", slug: "en-published" });
    seedArticle(db, { id: "fr-draft", novelId: "novel-1", locale: "fr", status: "draft", slug: "fr-draft" });

    const page = await listArticles(db.asPrismaClient(), { locale: "en", status: "draft" });

    expect(page.items.map((item) => item.id)).toEqual(["en-draft"]);
  });

  it("软删除的行永不出现，即使筛选条件全部匹配", async () => {
    const db = new FakeArticlesDb();
    seedNovel(db, "novel-1");
    seedArticle(db, { id: "deleted-1", novelId: "novel-1", status: "draft", deletedAt: new Date(NOW) });

    const page = await listArticles(db.asPrismaClient(), { status: "draft" });

    expect(page.items).toEqual([]);
    expect(page.total).toBe(0);
  });

  it("未登记的查询参数被忽略，不抛错", async () => {
    const db = new FakeArticlesDb();
    seedNovel(db, "novel-1");
    seedArticle(db, { id: "article-1", novelId: "novel-1" });

    const page = await listArticles(db.asPrismaClient(), {
      // @ts-expect-error — deliberately passing an unregistered key to prove it is ignored, not rejected.
      // C-19: `search` itself is now a registered filter (see the `listArticles · search / canonicalTagId (C-19)`
      // block below), so this test switched to a key that stays unregistered.
      unregisteredFilterKey: "should be ignored",
    });

    expect(page.items.map((item) => item.id)).toEqual(["article-1"]);
  });

  it("非法 status 被 invalid_status 拒绝（复用 @/server/admin-content 的错误码）", async () => {
    const db = new FakeArticlesDb();
    await expect(listArticles(db.asPrismaClient(), { status: "bogus" })).rejects.toMatchObject(
      { code: "invalid_status" },
    );
    await expect(listArticles(db.asPrismaClient(), { status: "bogus" })).rejects.toBeInstanceOf(
      AdminContentQueryError,
    );
  });

  it("非法 locale 被 invalid_locale 拒绝", async () => {
    const db = new FakeArticlesDb();
    await expect(listArticles(db.asPrismaClient(), { locale: "not-a-locale" })).rejects.toMatchObject(
      { code: "invalid_locale" },
    );
  });

  it("非法 novelId（不是 UUID）被 invalid_identifier 拒绝", async () => {
    const db = new FakeArticlesDb();
    await expect(listArticles(db.asPrismaClient(), { novelId: "not-a-uuid" })).rejects.toMatchObject(
      { code: "invalid_identifier" },
    );
  });

  it("非法 templateId（不是 UUID）被 invalid_identifier 拒绝", async () => {
    const db = new FakeArticlesDb();
    await expect(listArticles(db.asPrismaClient(), { templateId: "not-a-uuid" })).rejects.toMatchObject(
      { code: "invalid_identifier" },
    );
  });

  it("分页：page/pageSize 生效，total/totalPages 来自真实计数（不是伪造翻页）", async () => {
    const db = new FakeArticlesDb();
    seedNovel(db, "novel-1");
    for (let index = 0; index < 5; index += 1) {
      seedArticle(db, {
        id: `article-${index}`,
        novelId: "novel-1",
        slug: `article-${index}`,
        updatedAt: new Date(NOW.getTime() + index * 1000),
      });
    }

    const firstPage = await listArticles(db.asPrismaClient(), { page: 1, pageSize: 2 });
    expect(firstPage.items).toHaveLength(2);
    expect(firstPage.total).toBe(5);
    expect(firstPage.totalPages).toBe(3);
    // Newest-updated first, same ordering as the pre-M7 list.
    expect(firstPage.items.map((item) => item.id)).toEqual(["article-4", "article-3"]);

    const secondPage = await listArticles(db.asPrismaClient(), { page: 2, pageSize: 2 });
    expect(secondPage.items.map((item) => item.id)).toEqual(["article-2", "article-1"]);

    const thirdPage = await listArticles(db.asPrismaClient(), { page: 3, pageSize: 2 });
    expect(thirdPage.items.map((item) => item.id)).toEqual(["article-0"]);
  });

  it("page < 1 被 invalid_page 拒绝", async () => {
    const db = new FakeArticlesDb();
    await expect(listArticles(db.asPrismaClient(), { page: 0 })).rejects.toMatchObject({ code: "invalid_page" });
  });

  it(`pageSize 超过上限 ${ARTICLE_LIST_MAX_PAGE_SIZE} 被 invalid_page_size 拒绝（同一处 ≤100 明示分页约定）`, async () => {
    const db = new FakeArticlesDb();
    await expect(
      listArticles(db.asPrismaClient(), { pageSize: ARTICLE_LIST_MAX_PAGE_SIZE + 1 }),
    ).rejects.toMatchObject({ code: "invalid_page_size" });
  });
});

/**
 * C-19 (`分析_文章管理Parity缺口_2026-09-08.md` §六 "C-19"): `search` and
 * `canonicalTagId`, the two new `ArticleListInput` fields that replace the
 * filter bar's raw-UUID `novelId`/`templateId` text inputs with CPS-parity
 * alternatives (see `../../../src/app/(admin)/articles/_components/article-filters.tsx`'s
 * own header for the UI side).
 */
describe("listArticles · search / canonicalTagId (C-19)", () => {
  const TAG_ROMANCE = "55555555-5555-4555-8555-555555555555";
  const TAG_UNUSED = "66666666-6666-4666-8666-666666666666";

  it("search 命中标题 / slug / 短码三者之一（contains，大小写不敏感）", async () => {
    const db = new FakeArticlesDb();
    seedNovel(db, "novel-1");
    seedArticle(db, { id: "by-title", novelId: "novel-1", title: "Moonlight Romance", slug: "moonlight-romance", publicPageShortId: "shortid01" });
    seedArticle(db, { id: "by-slug", novelId: "novel-1", title: "Second Article", slug: "unique-slug-token", publicPageShortId: "shortid02" });
    seedArticle(db, { id: "by-shortid", novelId: "novel-1", title: "Third Article", slug: "third-article", publicPageShortId: "findablecode99" });
    seedArticle(db, { id: "no-match", novelId: "novel-1", title: "Unrelated", slug: "unrelated", publicPageShortId: "zzz00000" });

    const byTitle = await listArticles(db.asPrismaClient(), { search: "moonlight" });
    expect(byTitle.items.map((item) => item.id)).toEqual(["by-title"]);

    // 大小写不敏感：同一个查询词全大写也命中。
    const byTitleUpper = await listArticles(db.asPrismaClient(), { search: "MOONLIGHT" });
    expect(byTitleUpper.items.map((item) => item.id)).toEqual(["by-title"]);

    const bySlug = await listArticles(db.asPrismaClient(), { search: "unique-slug-token" });
    expect(bySlug.items.map((item) => item.id)).toEqual(["by-slug"]);

    const byShortId = await listArticles(db.asPrismaClient(), { search: "findablecode99" });
    expect(byShortId.items.map((item) => item.id)).toEqual(["by-shortid"]);
  });

  it("粘贴完整前台 URL 时，按解析出的短码精确命中（不靠 contains 命中整段 URL）", async () => {
    const db = new FakeArticlesDb();
    seedNovel(db, "novel-1");
    seedArticle(db, { id: "url-hit", novelId: "novel-1", slug: "my-story", publicPageShortId: "abc123xy" });
    seedArticle(db, { id: "other", novelId: "novel-1", slug: "other-story", publicPageShortId: "zzz99999" });

    const page = await listArticles(db.asPrismaClient(), {
      search: "https://novel.test/novel/my-story-pabc123xy",
    });

    expect(page.items.map((item) => item.id)).toEqual(["url-hit"]);
  });

  it("粘贴裸路径（无协议/域名）也能按短码命中", async () => {
    const db = new FakeArticlesDb();
    seedNovel(db, "novel-1");
    seedArticle(db, { id: "path-hit", novelId: "novel-1", slug: "another-story", publicPageShortId: "def456uv" });

    const page = await listArticles(db.asPrismaClient(), { search: "/fr/novel/another-story-pdef456uv" });

    expect(page.items.map((item) => item.id)).toEqual(["path-hit"]);
  });

  it("超长 search 被 invalid_search 拒绝（复用既有长度上限与错误码）", async () => {
    const db = new FakeArticlesDb();
    await expect(listArticles(db.asPrismaClient(), { search: "x".repeat(161) })).rejects.toMatchObject({
      code: "invalid_search",
    });
  });

  it("按 canonicalTagId 筛选：命中该书目挂了这个标签的文章（EXISTS 语义）", async () => {
    const db = new FakeArticlesDb();
    seedNovel(db, "novel-tagged");
    seedNovel(db, "novel-untagged");
    linkNovelCanonicalTag(db, "novel-tagged", TAG_ROMANCE);
    seedArticle(db, { id: "tagged-article", novelId: "novel-tagged" });
    seedArticle(db, { id: "untagged-article", novelId: "novel-untagged", slug: "untagged-article" });

    const page = await listArticles(db.asPrismaClient(), { canonicalTagId: TAG_ROMANCE });

    expect(page.items.map((item) => item.id)).toEqual(["tagged-article"]);
  });

  it("按 canonicalTagId 筛选：该标签没有任何书目挂载时返回空", async () => {
    const db = new FakeArticlesDb();
    seedNovel(db, "novel-tagged");
    linkNovelCanonicalTag(db, "novel-tagged", TAG_ROMANCE);
    seedArticle(db, { id: "tagged-article", novelId: "novel-tagged" });

    const page = await listArticles(db.asPrismaClient(), { canonicalTagId: TAG_UNUSED });

    expect(page.items).toEqual([]);
  });

  it("非法 canonicalTagId（不是 UUID）被 invalid_identifier 拒绝", async () => {
    const db = new FakeArticlesDb();
    await expect(listArticles(db.asPrismaClient(), { canonicalTagId: "not-a-uuid" })).rejects.toMatchObject({
      code: "invalid_identifier",
    });
  });
});

describe("listDistinctArticleLocales (C-19)", () => {
  it("只返回库里真实出现过的语种，去重且按字母排序", async () => {
    const db = new FakeArticlesDb();
    seedNovel(db, "novel-en");
    seedNovel(db, "novel-fr");
    seedArticle(db, { id: "en-1", novelId: "novel-en", locale: "en" });
    seedArticle(db, { id: "en-2", novelId: "novel-en", locale: "en", slug: "en-2" });
    seedArticle(db, { id: "fr-1", novelId: "novel-fr", locale: "fr", slug: "fr-1" });

    const locales = await listDistinctArticleLocales(db.asPrismaClient());

    expect(locales).toEqual(["en", "fr"]);
  });

  it("软删除的文章不贡献语种", async () => {
    const db = new FakeArticlesDb();
    seedNovel(db, "novel-1");
    seedArticle(db, { id: "deleted-ru", novelId: "novel-1", locale: "ru", deletedAt: new Date(NOW) });

    const locales = await listDistinctArticleLocales(db.asPrismaClient());

    expect(locales).toEqual([]);
  });
});

/**
 * C-20 (`分析_文章管理Parity缺口_2026-09-08.md` §六 "C-20"): the list
 * projection additions — 创建时间/书目/模板名/分类 — plus their fallback
 * values when the underlying relation is absent (`templateName`) or empty
 * (`canonicalTags`).
 */
describe("listArticles · 投影新增字段 (C-20)", () => {
  const TAG_ROMANCE = "77777777-7777-4777-8777-777777777777";
  const TAG_REBIRTH = "88888888-8888-4888-8888-888888888888";
  const TAG_NO_ZH = "99999999-9999-4999-8999-999999999999";
  const TAG_EXTRA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

  it("投影包含 createdAt / 书目 id+title / 模板名", async () => {
    const db = new FakeArticlesDb();
    seedNovel(db, "novel-1", { title: "重生之名" });
    seedTemplate(db, { id: "template-1", templateKey: "tpl-1", templateName: "标准模板" });
    const row = seedArticle(db, {
      id: "article-1",
      novelId: "novel-1",
      templateId: "template-1",
      createdAt: new Date("2026-08-20T00:00:00.000Z"),
    });

    const page = await listArticles(db.asPrismaClient());

    expect(page.items).toHaveLength(1);
    const item = page.items[0]!;
    expect(item.createdAt).toBe(row.createdAt.toISOString());
    expect(item.novel).toEqual({ id: "novel-1", title: "重生之名" });
    expect(item.templateName).toBe("标准模板");
    expect(item.templateKey).toBe("tpl-1");
  });

  /**
   * C-25: "列表投影新增 seoVisibility；列表项类型新增可选字段" — pins that the
   * new column reaches `ArticleListItem` (this is `article-list.tsx`'s "SEO
   * 可见性" badge column's only data source).
   */
  it("投影包含 seoVisibility", async () => {
    const db = new FakeArticlesDb();
    seedNovel(db, "novel-1");
    seedArticle(db, { id: "article-1", novelId: "novel-1", seoVisibility: "seo_only" });

    const page = await listArticles(db.asPrismaClient());

    expect(page.items[0]!.seoVisibility).toBe("seo_only");
  });

  /**
   * C-26: "列表投影新增两列，列表项类型新增两个可选字段" — same shape as the
   * `seoVisibility` projection test immediately above.
   */
  it("投影包含 articleType / contentMode", async () => {
    const db = new FakeArticlesDb();
    seedNovel(db, "novel-1");
    seedArticle(db, { id: "article-1", novelId: "novel-1", articleType: "blog_article", contentMode: "manual" });

    const page = await listArticles(db.asPrismaClient());

    expect(page.items[0]!.articleType).toBe("blog_article");
    expect(page.items[0]!.contentMode).toBe("manual");
  });

  it("无关联模板时 templateName 与 templateKey 都回退为 null", async () => {
    const db = new FakeArticlesDb();
    seedNovel(db, "novel-1");
    seedArticle(db, { id: "article-1", novelId: "novel-1", templateId: null });

    const page = await listArticles(db.asPrismaClient());

    expect(page.items[0]!.templateName).toBeNull();
    expect(page.items[0]!.templateKey).toBeNull();
  });

  it("书目没有任何 Canonical Tag 时 canonicalTags 为空数组，不是 undefined", async () => {
    const db = new FakeArticlesDb();
    seedNovel(db, "novel-untagged");
    seedArticle(db, { id: "article-1", novelId: "novel-untagged" });

    const page = await listArticles(db.asPrismaClient());

    expect(page.items[0]!.canonicalTags).toEqual([]);
  });

  it("分类显示 zh 译名，没有译名时回退 stableId；同一标签的重复关联去重", async () => {
    const db = new FakeArticlesDb();
    seedNovel(db, "novel-1");
    seedCanonicalTag(db, TAG_ROMANCE, { stableId: "romance", zhDisplayName: "言情" });
    seedCanonicalTag(db, TAG_NO_ZH, { stableId: "no-zh-stable-id", zhDisplayName: null });
    linkNovelCanonicalTag(db, "novel-1", TAG_ROMANCE);
    // 同一 canonicalTagId 出现两次（例如一次 auto、一次 manual）——去重后只应出现一次。
    linkNovelCanonicalTag(db, "novel-1", TAG_ROMANCE);
    linkNovelCanonicalTag(db, "novel-1", TAG_NO_ZH);
    seedArticle(db, { id: "article-1", novelId: "novel-1" });

    const page = await listArticles(db.asPrismaClient());

    expect(page.items[0]!.canonicalTags).toEqual(["言情", "no-zh-stable-id"]);
  });

  it("分类超过展示上限时按插入顺序截断", async () => {
    const db = new FakeArticlesDb();
    seedNovel(db, "novel-1");
    seedCanonicalTag(db, TAG_ROMANCE, { stableId: "romance", zhDisplayName: "言情" });
    seedCanonicalTag(db, TAG_REBIRTH, { stableId: "rebirth", zhDisplayName: "重生" });
    seedCanonicalTag(db, TAG_NO_ZH, { stableId: "sweet", zhDisplayName: "甜宠" });
    seedCanonicalTag(db, TAG_EXTRA, { stableId: "extra", zhDisplayName: "第四个应被截断" });
    linkNovelCanonicalTag(db, "novel-1", TAG_ROMANCE);
    linkNovelCanonicalTag(db, "novel-1", TAG_REBIRTH);
    linkNovelCanonicalTag(db, "novel-1", TAG_NO_ZH);
    linkNovelCanonicalTag(db, "novel-1", TAG_EXTRA);
    seedArticle(db, { id: "article-1", novelId: "novel-1" });

    const page = await listArticles(db.asPrismaClient());

    expect(page.items[0]!.canonicalTags).toEqual(["言情", "重生", "甜宠"]);
  });
});
