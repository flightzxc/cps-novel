import type { Prisma, PrismaClient } from "@prisma/client";
import { beforeEach, describe, expect, it } from "vitest";

import { hashAdminSessionToken } from "@/lib/auth/session";
import type { AdminIdentity, AdminSessionRecord } from "@/lib/auth/types";
import { requireAdminActionAccess } from "@/server/auth/guards";
import { P2_04_ADMIN_REGISTRY } from "@/app/api/admin/_lib/registry";
import {
  createArticleTemplate,
  ensureDefaultArticleTemplate,
  selectActiveArticleTemplate,
} from "@/server/article-templates";
import { DEFAULT_ARTICLE_TEMPLATE_KEY } from "@/server/content-creation/default-article-template";
import { isTemplateRenderError } from "@/lib/seo/template";

import { TestOnlyInMemoryAuthStores } from "../auth/test-only-in-memory-stores";

/**
 * M6 bite tests (交接提示词 B-2 / 施工规格 ACCEPTANCE_MATRIX row "M6 Template").
 *
 * Two of Opus's "存活变异" from the CHANGES_REQUIRED report are reproduced
 * verbatim as the mutation targets these tests exist to kill:
 *   - "从 `storage()` 删掉 `validateStoredArticleTemplate(stored)`（允许未登记
 *     变量保存）→ 全绿" — killed by "创建模板拒绝未登记变量" below, which
 *     drives the real `createArticleTemplate` (not a re-implementation of
 *     `storage()`) with a body referencing a field outside `fields.ts`'s
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
  locale: string | null;
  version: number;
  schemaVersion: number;
  status: string;
  bodyTemplate: string;
  seoTemplate: unknown;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

let nextId = 0;

/** Minimal in-memory `articleTemplate` + `operationAudit` double — same discipline as `FakeSiteSettingDb` (`tests/backend/site-settings/write-service.test.ts`). */
class FakeArticleTemplateDb {
  readonly rows: TemplateRow[] = [];
  readonly audits: Array<Record<string, unknown>> = [];

  private matches(row: TemplateRow, where: Record<string, unknown>): boolean {
    if (where.id !== undefined && row.id !== where.id) return false;
    if (where.templateKey !== undefined && row.templateKey !== where.templateKey) return false;
    if (where.status !== undefined && row.status !== where.status) return false;
    if ("deletedAt" in where && where.deletedAt === null && row.deletedAt !== null) return false;
    if (where.OR) {
      const options = where.OR as ReadonlyArray<{ locale?: string | null }>;
      if (!options.some((option) => row.locale === option.locale)) return false;
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
            locale: (args.data.locale as string | null) ?? null,
            version: args.data.version as number,
            schemaVersion: args.data.schemaVersion as number,
            status: args.data.status as string,
            bodyTemplate: args.data.bodyTemplate as string,
            seoTemplate: args.data.seoTemplate,
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
  locale: "en",
  version: 1,
  status: "active" as const,
  titleTemplate: "{novel_title}",
  bodyTemplate: "<article><h1>{novel_title}</h1><p>{novel_description}</p></article>",
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
        { ...guarded, template: { ...VALID_TEMPLATE, templateKey: "tpl-bad", bodyTemplate: "<p>{author}</p>" } },
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
});

describe("ensureDefaultArticleTemplate · 表空时落 system-default-v1，幂等", () => {
  let db: FakeArticleTemplateDb;

  beforeEach(() => {
    db = new FakeArticleTemplateDb();
  });

  it("表为空时创建 system-default-v1 v1 active", async () => {
    const row = await ensureDefaultArticleTemplate(db.asTransactionClient());
    expect(row).toMatchObject({ templateKey: DEFAULT_ARTICLE_TEMPLATE_KEY, version: 1, status: "active" });
    expect(db.rows).toHaveLength(1);
  });

  it("表非空时不再创建（幂等）", async () => {
    await ensureDefaultArticleTemplate(db.asTransactionClient());
    const second = await ensureDefaultArticleTemplate(db.asTransactionClient());
    expect(second).toBeNull();
    expect(db.rows).toHaveLength(1);
  });
});
