import type { Prisma, PrismaClient } from "@prisma/client";
import { beforeEach, describe, expect, it } from "vitest";

import { hashAdminSessionToken } from "@/lib/auth/session";
import type { AdminIdentity, AdminSessionRecord } from "@/lib/auth/types";
import { requireAdminActionAccess } from "@/server/auth/guards";
import { P2_04_ADMIN_REGISTRY } from "@/app/api/admin/_lib/registry";
import {
  ArticleTemplateInputError,
  createArticleTemplate,
  ensureDefaultArticleTemplate,
  listActiveArticleTemplateOptions,
  selectActiveArticleTemplate,
} from "@/server/article-templates";
import { DEFAULT_ARTICLE_TEMPLATE_KEY } from "@/server/content-creation/default-article-template";
import { isTemplateRenderError } from "@/lib/seo/template";

import { TestOnlyInMemoryAuthStores } from "../auth/test-only-in-memory-stores";

/**
 * M6 bite tests (交接提示词 B-2 / 施工规格 ACCEPTANCE_MATRIX row "M6 Template"),
 * extended in P2-02B (CPS parity: templateName/applicableArticleType/contentTemplate/
 * slugTemplate/metaKeywordsTemplate + locale 白名单 + 自动版本号).
 *
 * Two of Opus's "存活变异" from the CHANGES_REQUIRED report are reproduced
 * verbatim as the mutation targets these tests exist to kill:
 *   - "从 `storage()` 删掉 `validateStoredArticleTemplate(stored)`（允许未登记
 *     变量保存）→ 全绿" — killed by "创建模板拒绝未登记变量" below, which
 *     drives the real `createArticleTemplate` (not a re-implementation of
 *     `storage()`) with a content block referencing a field outside `fields.ts`'s
 *     registered set and asserts the write is rejected.
 *   - the matrix's own "停用模板仍可选→红" — killed by "停用模板不可被选中"
 *     below, which asserts `selectActiveArticleTemplate` excludes a
 *     `status: "inactive"` row even when queried by its exact `templateKey`.
 */

const NOW = new Date("2026-09-05T03:00:00.000Z");
const TOKEN = "article-template-service-session";
const ORIGIN = "https://admin.example.com";

type TemplateRow = {
  id: string;
  templateKey: string;
  templateName: string;
  locale: string | null;
  version: number;
  schemaVersion: number;
  status: string;
  applicableArticleType: string;
  bodyTemplate: string;
  contentTemplate: unknown;
  seoTemplate: unknown;
  slugTemplate: string;
  metaKeywordsTemplate: string;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

let nextId = 0;

/** Minimal in-memory `articleTemplate` + `operationAudit` double — same discipline as `FakeSiteSettingDb` (`tests/backend/site-settings/write-service.test.ts`). */
class FakeArticleTemplateDb {
  readonly rows: TemplateRow[] = [];
  readonly audits: Array<Record<string, unknown>> = [];

  /**
   * Recursive so it can evaluate the `AND: [{OR:[...]}, {OR:[...]}]` shape
   * `selectActiveArticleTemplate`/`listActiveArticleTemplateOptions` build for
   * combining the locale clause and the applicableArticleType clause — two
   * top-level `OR` keys can't be merged by object spread (the second silently
   * clobbers the first), so the real service combines them under `AND` instead.
   */
  private matches(row: TemplateRow, where: Record<string, unknown>): boolean {
    if (where.id !== undefined && row.id !== where.id) return false;
    if (where.templateKey !== undefined && row.templateKey !== where.templateKey) return false;
    if (where.status !== undefined && row.status !== where.status) return false;
    if (where.locale !== undefined && row.locale !== where.locale) return false;
    if (where.applicableArticleType !== undefined && row.applicableArticleType !== where.applicableArticleType) return false;
    if ("deletedAt" in where && where.deletedAt === null && row.deletedAt !== null) return false;
    if (where.OR) {
      const options = where.OR as ReadonlyArray<Record<string, unknown>>;
      if (!options.some((option) => this.matches(row, option))) return false;
    }
    if (where.AND) {
      const clauses = where.AND as ReadonlyArray<Record<string, unknown>>;
      if (!clauses.every((clause) => this.matches(row, clause))) return false;
    }
    return true;
  }

  private sorted(rows: TemplateRow[], orderBy: unknown): TemplateRow[] {
    const clauses = Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : [];
    return [...rows].sort((a, b) => {
      for (const clause of clauses as Array<Record<string, "asc" | "desc">>) {
        const [field, direction] = Object.entries(clause)[0]!;
        const av = (a as unknown as Record<string, unknown>)[field];
        const bv = (b as unknown as Record<string, unknown>)[field];
        const cmp = av! > bv! ? 1 : av! < bv! ? -1 : 0;
        if (cmp !== 0) return direction === "desc" ? -cmp : cmp;
      }
      return 0;
    });
  }

  private client() {
    return {
      articleTemplate: {
        create: async (args: { data: Record<string, unknown> }) => {
          const row: TemplateRow = {
            id: `template-${(nextId += 1)}`,
            templateKey: args.data.templateKey as string,
            templateName: args.data.templateName as string,
            locale: (args.data.locale as string | null) ?? null,
            version: args.data.version as number,
            schemaVersion: args.data.schemaVersion as number,
            status: args.data.status as string,
            applicableArticleType: args.data.applicableArticleType as string,
            bodyTemplate: args.data.bodyTemplate as string,
            contentTemplate: args.data.contentTemplate,
            seoTemplate: args.data.seoTemplate,
            slugTemplate: (args.data.slugTemplate as string) ?? "",
            metaKeywordsTemplate: (args.data.metaKeywordsTemplate as string) ?? "",
            deletedAt: null,
            createdAt: new Date(NOW),
            updatedAt: new Date(NOW),
          };
          this.rows.push(row);
          return structuredClone(row);
        },
        update: async (args: { where: { id: string }; data: Record<string, unknown> }) => {
          const row = this.rows.find((candidate) => candidate.id === args.where.id);
          if (!row) throw new Error("not_found");
          Object.assign(row, args.data, { updatedAt: new Date(NOW) });
          return structuredClone(row);
        },
        findFirst: async (args: { where?: Record<string, unknown>; orderBy?: unknown } = {}) => {
          const matched = this.rows.filter((row) => this.matches(row, args.where ?? {}));
          const sorted = this.sorted(matched, args.orderBy);
          return sorted[0] ? structuredClone(sorted[0]) : null;
        },
        findFirstOrThrow: async (args: { where?: Record<string, unknown> } = {}) => {
          const matched = this.rows.find((row) => this.matches(row, args.where ?? {}));
          if (!matched) throw new Error("article_template_not_found");
          return structuredClone(matched);
        },
        findMany: async (args: { where?: Record<string, unknown> } = {}) =>
          this.rows.filter((row) => this.matches(row, args.where ?? {})).map((row) => structuredClone(row)),
        count: async (args: { where?: Record<string, unknown> } = {}) =>
          this.rows.filter((row) => this.matches(row, args.where ?? {})).length,
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

  asPrismaClient(): PrismaClient {
    return this.client() as unknown as PrismaClient;
  }

  asTransactionClient(): Prisma.TransactionClient {
    return this.client() as unknown as Prisma.TransactionClient;
  }
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

function deps(db: FakeArticleTemplateDb, stores: TestOnlyInMemoryAuthStores) {
  return { db: db.asPrismaClient(), identities: stores, sessions: stores, now: NOW };
}

const VALID_TEMPLATE = {
  templateKey: "tpl-valid",
  templateName: "有效模板",
  locale: "en",
  status: "active" as const,
  titleTemplate: "{novel_title}",
  contentTemplate: [
    { type: "heading", content: "{novel_title}" },
    { type: "paragraph", content: "{novel_description}" },
  ],
  metaTitleTemplate: "{novel_title}",
  metaDescriptionTemplate: "{novel_description}",
};

describe("createArticleTemplate · 未登记变量必须被引擎拒绝", () => {
  it("正常模板（仅引用已登记字段）可以保存", async () => {
    const db = new FakeArticleTemplateDb();
    const stores = authFixture();
    const guarded = await authorization(stores, "admin.article_template.create");
    const row = await createArticleTemplate({ ...guarded, template: VALID_TEMPLATE }, deps(db, stores));
    expect(row.templateKey).toBe("tpl-valid");
    expect(db.rows).toHaveLength(1);
  });

  it("正文引用未登记变量时创建被拒绝，且不落库（mutation target: storage() 里的 validateStoredArticleTemplate 调用）", async () => {
    const db = new FakeArticleTemplateDb();
    const stores = authFixture();
    const guarded = await authorization(stores, "admin.article_template.create");
    await expect(
      createArticleTemplate(
        {
          ...guarded,
          template: {
            ...VALID_TEMPLATE,
            templateKey: "tpl-bad",
            contentTemplate: [{ type: "paragraph", content: "{author}" }],
          },
        },
        deps(db, stores),
      ),
    ).rejects.toSatisfy((error: unknown) => isTemplateRenderError(error) && error.code === "ERR_TEMPLATE_FIELD_NOT_REGISTERED");
    expect(db.rows).toHaveLength(0);
  });

  it("SEO 标题模板引用未登记变量同样被拒绝", async () => {
    const db = new FakeArticleTemplateDb();
    const stores = authFixture();
    const guarded = await authorization(stores, "admin.article_template.create");
    await expect(
      createArticleTemplate(
        { ...guarded, template: { ...VALID_TEMPLATE, templateKey: "tpl-bad-2", titleTemplate: "{views}{novel_title}" } },
        deps(db, stores),
      ),
    ).rejects.toSatisfy((error: unknown) => isTemplateRenderError(error) && error.code === "ERR_TEMPLATE_FIELD_NOT_REGISTERED");
    expect(db.rows).toHaveLength(0);
  });

  it("locale 越界（不在 SITE_LOCALES 白名单）被拒绝，且不落库", async () => {
    const db = new FakeArticleTemplateDb();
    const stores = authFixture();
    const guarded = await authorization(stores, "admin.article_template.create");
    await expect(
      createArticleTemplate(
        { ...guarded, template: { ...VALID_TEMPLATE, templateKey: "tpl-bad-locale", locale: "eng" } },
        deps(db, stores),
      ),
    ).rejects.toSatisfy((error: unknown) => error instanceof ArticleTemplateInputError && error.code === "template_locale_invalid");
    expect(db.rows).toHaveLength(0);
  });

  // L10N P3（矩阵 #5，施工提示词 §1.G）：`requireLocale` 不再接受 null/空白
  // 表示"全部语种"——CPS 没有通用模板这个概念，且 `ArticleTemplate.locale`
  // 已收口为数据库层 `NOT NULL`。`it`/`tr` 是真实的 BCP-47 语种码（resolveSiteLocale
  // 能把上游码解析成它们），但不是这 15 个已登记的 `SITE_LOCALES` 成员——同一条
  // `requireLocale` 白名单校验必须把它们和格式错误的 "eng" 一样拒绝。
  it.each(["it", "tr", "", "   "])("locale=%j（合法 BCP-47 但非 SITE_LOCALES 成员，或空白）被拒绝，且不落库", async (locale) => {
    const db = new FakeArticleTemplateDb();
    const stores = authFixture();
    const guarded = await authorization(stores, "admin.article_template.create");
    await expect(
      createArticleTemplate(
        { ...guarded, template: { ...VALID_TEMPLATE, templateKey: "tpl-bad-locale-2", locale } },
        deps(db, stores),
      ),
    ).rejects.toSatisfy((error: unknown) => error instanceof ArticleTemplateInputError && error.code === "template_locale_invalid");
    expect(db.rows).toHaveLength(0);
  });

  it("locale 为 null/undefined（旧「全部语种」语义）同样被拒绝——不再是合法输入", async () => {
    const db = new FakeArticleTemplateDb();
    const stores = authFixture();
    const guarded = await authorization(stores, "admin.article_template.create");
    for (const locale of [null, undefined] as const) {
      await expect(
        createArticleTemplate(
          { ...guarded, template: { ...VALID_TEMPLATE, templateKey: "tpl-null-locale", locale } },
          deps(db, stores),
        ),
      ).rejects.toSatisfy((error: unknown) => error instanceof ArticleTemplateInputError && error.code === "template_locale_invalid");
    }
    expect(db.rows).toHaveLength(0);
  });

  it("applicableArticleType 越界（不在五值枚举内）被拒绝，且不落库", async () => {
    const db = new FakeArticleTemplateDb();
    const stores = authFixture();
    const guarded = await authorization(stores, "admin.article_template.create");
    await expect(
      createArticleTemplate(
        {
          ...guarded,
          template: { ...VALID_TEMPLATE, templateKey: "tpl-bad-type", applicableArticleType: "drama_article" },
        },
        deps(db, stores),
      ),
    ).rejects.toSatisfy((error: unknown) => error instanceof ArticleTemplateInputError && error.code === "template_article_type_invalid");
    expect(db.rows).toHaveLength(0);
  });

  it("contentTemplate 为空数组时被拒绝（至少一个内容区块）", async () => {
    const db = new FakeArticleTemplateDb();
    const stores = authFixture();
    const guarded = await authorization(stores, "admin.article_template.create");
    await expect(
      createArticleTemplate(
        { ...guarded, template: { ...VALID_TEMPLATE, templateKey: "tpl-empty-content", contentTemplate: [] } },
        deps(db, stores),
      ),
    ).rejects.toSatisfy((error: unknown) => error instanceof ArticleTemplateInputError && error.code === "template_content_invalid");
    expect(db.rows).toHaveLength(0);
  });

  it("同一 templateKey 连续创建两次，version 自动 +1（1 然后 2）", async () => {
    const db = new FakeArticleTemplateDb();
    const stores = authFixture();
    const guarded = await authorization(stores, "admin.article_template.create");
    const first = await createArticleTemplate(
      { ...guarded, template: { ...VALID_TEMPLATE, templateKey: "tpl-versioned" } },
      deps(db, stores),
    );
    const second = await createArticleTemplate(
      { ...guarded, template: { ...VALID_TEMPLATE, templateKey: "tpl-versioned" } },
      deps(db, stores),
    );
    expect(first.version).toBe(1);
    expect(second.version).toBe(2);
    expect(db.rows.filter((row) => row.templateKey === "tpl-versioned")).toHaveLength(2);
  });
});

describe("selectActiveArticleTemplate · 停用模板不可被选中", () => {
  it("按 templateKey 查询时，inactive 状态的行不返回（mutation target: 去掉 status 过滤）", async () => {
    const db = new FakeArticleTemplateDb();
    const stores = authFixture();
    const guarded = await authorization(stores, "admin.article_template.create");
    const created = await createArticleTemplate({ ...guarded, template: VALID_TEMPLATE }, deps(db, stores));
    // Flip the freshly-created row to inactive directly on the fake store —
    // equivalent to an operator having stopped it via `setArticleTemplateStatus`.
    const row = db.rows.find((candidate) => candidate.id === created.id)!;
    row.status = "inactive";

    const selected = await selectActiveArticleTemplate(db.asPrismaClient(), {
      locale: "en",
      templateKey: "tpl-valid",
    });
    expect(selected).toBeNull();
  });

  it("active 状态的行可以被按 templateKey 选中", async () => {
    const db = new FakeArticleTemplateDb();
    const stores = authFixture();
    const guarded = await authorization(stores, "admin.article_template.create");
    await createArticleTemplate({ ...guarded, template: VALID_TEMPLATE }, deps(db, stores));

    const selected = await selectActiveArticleTemplate(db.asPrismaClient(), {
      locale: "en",
      templateKey: "tpl-valid",
    });
    expect(selected?.templateKey).toBe("tpl-valid");
  });

  it("无 templateKey 时优先 system-default-v1，其后按 createdAt 取首个 active", async () => {
    const db = new FakeArticleTemplateDb();
    const stores = authFixture();
    const guarded = await authorization(stores, "admin.article_template.create");
    await createArticleTemplate({ ...guarded, template: { ...VALID_TEMPLATE, templateKey: "tpl-other" } }, deps(db, stores));
    await createArticleTemplate(
      { ...guarded, template: { ...VALID_TEMPLATE, templateKey: DEFAULT_ARTICLE_TEMPLATE_KEY } },
      deps(db, stores),
    );

    const selected = await selectActiveArticleTemplate(db.asPrismaClient(), { locale: "en" });
    expect(selected?.templateKey).toBe(DEFAULT_ARTICLE_TEMPLATE_KEY);
  });

  it("applicableArticleType 参与过滤：不匹配的文章类型选不到，'any' 对全部类型可选中", async () => {
    const db = new FakeArticleTemplateDb();
    const stores = authFixture();
    const guarded = await authorization(stores, "admin.article_template.create");
    await createArticleTemplate(
      { ...guarded, template: { ...VALID_TEMPLATE, templateKey: "tpl-blog", applicableArticleType: "blog_article" } },
      deps(db, stores),
    );
    await createArticleTemplate(
      { ...guarded, template: { ...VALID_TEMPLATE, templateKey: "tpl-any", applicableArticleType: "any" } },
      deps(db, stores),
    );

    // A blog-only template must not be selectable for novel_article.
    const blogAsNovel = await selectActiveArticleTemplate(db.asPrismaClient(), {
      locale: "en",
      templateKey: "tpl-blog",
      applicableArticleType: "novel_article",
    });
    expect(blogAsNovel).toBeNull();

    // The same blog-only template IS selectable for its own declared type.
    const blogAsBlog = await selectActiveArticleTemplate(db.asPrismaClient(), {
      locale: "en",
      templateKey: "tpl-blog",
      applicableArticleType: "blog_article",
    });
    expect(blogAsBlog?.templateKey).toBe("tpl-blog");

    // A template declared "any" is selectable regardless of requested type.
    const anyAsNovel = await selectActiveArticleTemplate(db.asPrismaClient(), {
      locale: "en",
      templateKey: "tpl-any",
      applicableArticleType: "novel_article",
    });
    expect(anyAsNovel?.templateKey).toBe("tpl-any");
  });
});

// L10N P3（矩阵 #5，施工提示词 §1.G）：`selectActiveArticleTemplate`/
// `listActiveArticleTemplateOptions` 不再 OR 一个 `{locale: null}` 通配——
// locale 精确匹配，ru 请求不会命中 en 模板，反之亦然；一份（理论上不该存在，
// 数据库层现在是 `NOT NULL`，但应用层判断逻辑本身必须独立不依赖那道闸）
// locale 为 null 的孤儿行也绝不会被任何具体语种命中。这组测试是变异①
// （"把 `OR {locale:null}` 通配加回 → 红"）的判死对象。
describe("selectActiveArticleTemplate / listActiveArticleTemplateOptions · locale 精确匹配，无通配", () => {
  it("ru 模板不对 en 请求命中，en 模板不对 ru 请求命中", async () => {
    const db = new FakeArticleTemplateDb();
    const stores = authFixture();
    const guarded = await authorization(stores, "admin.article_template.create");
    await createArticleTemplate(
      { ...guarded, template: { ...VALID_TEMPLATE, templateKey: "tpl-en-only", locale: "en" } },
      deps(db, stores),
    );
    await createArticleTemplate(
      { ...guarded, template: { ...VALID_TEMPLATE, templateKey: "tpl-ru-only", locale: "ru" } },
      deps(db, stores),
    );

    // The en template is selectable under locale "en" but not "ru".
    expect(
      (await selectActiveArticleTemplate(db.asPrismaClient(), { locale: "en", templateKey: "tpl-en-only" }))?.templateKey,
    ).toBe("tpl-en-only");
    expect(
      await selectActiveArticleTemplate(db.asPrismaClient(), { locale: "ru", templateKey: "tpl-en-only" }),
    ).toBeNull();

    // And symmetrically for the ru template.
    expect(
      (await selectActiveArticleTemplate(db.asPrismaClient(), { locale: "ru", templateKey: "tpl-ru-only" }))?.templateKey,
    ).toBe("tpl-ru-only");
    expect(
      await selectActiveArticleTemplate(db.asPrismaClient(), { locale: "en", templateKey: "tpl-ru-only" }),
    ).toBeNull();

    // listActiveArticleTemplateOptions: each locale query surfaces exactly its own template.
    const enOptions = await listActiveArticleTemplateOptions(db.asPrismaClient(), "en");
    expect(enOptions.map((option) => option.templateKey)).toContain("tpl-en-only");
    expect(enOptions.map((option) => option.templateKey)).not.toContain("tpl-ru-only");

    const ruOptions = await listActiveArticleTemplateOptions(db.asPrismaClient(), "ru");
    expect(ruOptions.map((option) => option.templateKey)).toContain("tpl-ru-only");
    expect(ruOptions.map((option) => option.templateKey)).not.toContain("tpl-en-only");
  });

  it("无通配：一份 locale 为 null 的孤儿行不会被任何具体语种命中（变异①判死对象）", async () => {
    const db = new FakeArticleTemplateDb();
    // Bypasses `storage()`/`requireLocale` entirely — this row could only
    // exist pre-P3 (or via direct DB tampering); after this migration the
    // column itself is `NOT NULL`, but the *application* matching logic
    // must independently refuse to wildcard-match it, not just rely on the
    // database rejecting the insert.
    db.rows.push({
      id: "template-orphan",
      templateKey: "tpl-orphan",
      templateName: "孤儿模板",
      locale: null,
      version: 1,
      schemaVersion: 1,
      status: "active",
      applicableArticleType: "novel_article",
      bodyTemplate: "<p>{novel_title}</p>",
      contentTemplate: [{ type: "paragraph", content: "{novel_title}" }],
      seoTemplate: { title: "{novel_title}" },
      slugTemplate: "",
      metaKeywordsTemplate: "",
      deletedAt: null,
      createdAt: new Date(NOW),
      updatedAt: new Date(NOW),
    });

    for (const locale of ["en", "ru"]) {
      expect(await selectActiveArticleTemplate(db.asPrismaClient(), { locale, templateKey: "tpl-orphan" })).toBeNull();
      const options = await listActiveArticleTemplateOptions(db.asPrismaClient(), locale);
      expect(options.map((option) => option.templateKey)).not.toContain("tpl-orphan");
    }
  });
});

describe("ensureDefaultArticleTemplate · 表空时落 system-default-v1，幂等", () => {
  let db: FakeArticleTemplateDb;

  beforeEach(() => {
    db = new FakeArticleTemplateDb();
  });

  it("表为空时创建 system-default-v1 v1 active", async () => {
    const row = await ensureDefaultArticleTemplate(db.asTransactionClient());
    expect(row).toMatchObject({
      templateKey: DEFAULT_ARTICLE_TEMPLATE_KEY,
      version: 1,
      status: "active",
      applicableArticleType: "novel_article",
    });
    expect(db.rows).toHaveLength(1);
  });

  it("表非空时不再创建（幂等）", async () => {
    await ensureDefaultArticleTemplate(db.asTransactionClient());
    const second = await ensureDefaultArticleTemplate(db.asTransactionClient());
    expect(second).toBeNull();
    expect(db.rows).toHaveLength(1);
  });
});
