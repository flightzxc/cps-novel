import { randomUUID } from "node:crypto";

import type { PrismaClient } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { P2_04_ADMIN_REGISTRY } from "@/app/api/admin/_lib/registry";
import { toErrorEnvelope } from "@/app/api/admin/_lib/respond";
import { homepageNavMutation } from "@/app/api/admin/_lib/tagging-route";
import { projectAdminHomepageNav, projectAdminTagAuditEntry } from "@/contracts";
import { TAGGING_ADMIN_ERROR_CODES, TaggingAdminError } from "@/domain/tagging-admin";
import { errorEnvelopeCopy } from "@/features/admin-ui/error-copy";
import { ADMIN_ABSOLUTE_TIMEOUT_MS, hashAdminSessionToken } from "@/lib/auth/session";
import type { AdminIdentity, AdminSessionRecord } from "@/lib/auth/types";
import { clearPublicCategoryCountsCacheForTest } from "@/lib/site/public-list";
import { requireAdminRouteAccess } from "@/server/auth/guards";
import {
  listHomepageNavCandidates,
  replaceHomepageNavSelection,
} from "@/server/tagging/admin-service";
import * as projection from "@/server/tagging/effective-tag-projection";

import { classifyPublicListQuery } from "../fixtures/in-memory-public-db";
import { TestOnlyInMemoryAuthStores } from "../backend/auth/test-only-in-memory-stores";

/**
 * v0.5.15 首页题材导航勾选 · 保存接口与审计（单元层，假库）。
 *
 * 真实库（真实 web_app 角色、updated_at 逐行不变、并发）在
 * `tests/integration/tagging/homepage-nav-postgres.test.ts`；这里钉住不依赖数据库的约束：
 *   H6  不受分类写入开关约束，但读开关、tag:manage、两步验证、会话新鲜都要过；
 *   H7  不触发归属重算、不拿投影锁；
 *   H8  行锁是 FOR NO KEY UPDATE；H5 更新语句不碰 updated_at；
 *   幂等重放 / 冲突 / 校验 / 审计快照 / 解析器 / 错误文案。
 */

vi.mock("@/server/tagging/effective-tag-projection", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/tagging/effective-tag-projection")>()),
  reconcileAllEffectiveTags: vi.fn(async () => { throw new Error("homepage-nav must not reconcile"); }),
  lockEffectiveTagProjectionExclusive: vi.fn(async () => { throw new Error("homepage-nav must not lock the projection"); }),
}));

const NOW = new Date("2026-10-10T12:00:00.000Z");
const TOKEN = "homepage-nav-test-token";
const ORIGIN = "https://admin.example.com";
const ADMIN_ID = "admin-homepage-nav";
const PATH = "/api/admin/canonical-tags/homepage-nav";
const ENTRY_ID = "admin.api.canonical_tag.homepage_nav.write";
const NAMESPACE = "v0515:homepage-nav";

const env = (overrides: Record<string, string> = {}): NodeJS.ProcessEnv => ({
  NODE_ENV: "test",
  FEATURE_P2_06_5_TAGGING: "true",
  // 生产现状：写开关关闭。首页勾选必须在这种状态下仍可保存。
  FEATURE_P2_06_5_TAG_ADMIN_WRITE: "false",
  ...overrides,
}) as NodeJS.ProcessEnv;

// ───────────────────────────── 假库 ─────────────────────────────

type TagRow = {
  id: string;
  slug: string;
  sort_order: number;
  status: "active" | "inactive";
  is_homepage_visible: boolean;
  updated_at: Date;
};

type AuditRow = {
  actorType: string;
  actorId: string | null;
  action: string;
  entityType: string;
  entityId: string;
  requestId: string | null;
  beforeSnapshot: unknown;
  afterSnapshot: unknown;
  createdAt: Date;
};

type SqlLike = { sql?: string; text?: string; values?: readonly unknown[] };

const UPDATED_AT = new Date("2026-01-01T00:00:00.000Z");

function tag(slug: string, sortOrder: number, overrides: Partial<TagRow> = {}): TagRow {
  return { id: randomUUID(), slug, sort_order: sortOrder, status: "active", is_homepage_visible: true, updated_at: UPDATED_AT, ...overrides };
}

class FakeDb {
  readonly statements: string[] = [];
  readonly locks: unknown[] = [];
  transactions = 0;
  audits: AuditRow[] = [];
  constructor(public tags: TagRow[]) {}

  idOf(slug: string): string {
    return this.tags.find((row) => row.slug === slug)!.id;
  }

  visibleSlugs(): string[] {
    return this.tags.filter((row) => row.is_homepage_visible && row.status === "active").map((row) => row.slug).sort();
  }

  asPrismaClient(): PrismaClient {
    const sqlText = (query: SqlLike) => (query.sql ?? query.text ?? "").replace(/\s+/g, " ").trim();
    const tx = {
      $queryRaw: async (query: SqlLike) => {
        const text = sqlText(query);
        this.statements.push(text);
        if (text.includes("pg_advisory_xact_lock")) {
          this.locks.push(query.values?.[0]);
          return [{ locked: 1 }];
        }
        if (text.includes("FROM canonical_tag") && text.includes("FOR NO KEY UPDATE")) {
          return this.tags
            .filter((row) => row.status === "active")
            .sort((left, right) => left.sort_order - right.sort_order || (left.slug < right.slug ? -1 : 1))
            .map(({ id, slug, is_homepage_visible }) => ({ id, slug, is_homepage_visible }));
        }
        throw new Error(`unexpected $queryRaw: ${text}`);
      },
      $executeRaw: async (query: SqlLike) => {
        const text = sqlText(query);
        this.statements.push(text);
        if (!text.startsWith("UPDATE canonical_tag")) throw new Error(`unexpected $executeRaw: ${text}`);
        const ids = new Set(query.values?.[0] as string[]);
        let changed = 0;
        for (const row of this.tags) {
          if (row.status !== "active") continue;
          const next = ids.has(row.id);
          if (row.is_homepage_visible !== next) {
            row.is_homepage_visible = next;
            changed += 1;
          }
        }
        return changed;
      },
      operationAudit: {
        findFirst: async (args: { where: { requestId: string; action: { in: string[] } } }) => {
          const row = this.audits.find((audit) => audit.requestId === args.where.requestId
            && args.where.action.in.includes(audit.action));
          return row ? { action: row.action, afterSnapshot: row.afterSnapshot } : null;
        },
        create: async (args: { data: Omit<AuditRow, "createdAt"> }) => {
          this.audits.push({ ...args.data, createdAt: NOW });
          return args.data;
        },
      },
    };
    return {
      $transaction: async (callback: (client: typeof tx) => Promise<unknown>) => {
        this.transactions += 1;
        return callback(tx);
      },
    } as unknown as PrismaClient;
  }
}

function seedDb() {
  return new FakeDb([
    tag("alpha", 10),
    tag("beta", 20),
    tag("gamma", 30),
    tag("delta", 40, { is_homepage_visible: false }),
    tag("zeta", 60, { status: "inactive", is_homepage_visible: false }),
  ]);
}

// ───────────────────────────── 管理员会话夹具 ─────────────────────────────

function makeStores(options: { role?: string; twoFactor?: boolean } = {}) {
  const stores = new TestOnlyInMemoryAuthStores();
  const identity: AdminIdentity = {
    id: ADMIN_ID,
    username: "admin",
    role: options.role ?? "super_admin",
    status: "active",
    sessionVersion: 1,
    twoFactorEnabled: true,
  };
  const issuedAt = new Date(NOW.getTime() - 60 * 60 * 1000);
  const session: AdminSessionRecord = {
    id: "session-homepage-nav",
    tokenHash: hashAdminSessionToken(TOKEN),
    identityId: identity.id,
    sessionVersion: 1,
    issuedAt,
    lastSeenAt: new Date(NOW.getTime() - 60_000),
    absoluteExpiresAt: new Date(issuedAt.getTime() + ADMIN_ABSOLUTE_TIMEOUT_MS),
    twoFactorCompletedAt: options.twoFactor === false ? null : new Date(NOW.getTime() - 60_000),
    revokedAt: null,
  };
  stores.identities.set(identity.id, identity);
  stores.sessions.set(session.id, session);
  return { stores, identity, session };
}

async function issueTicket(stores: TestOnlyInMemoryAuthStores, requestId: string) {
  const guarded = await requireAdminRouteAccess({
    pathname: PATH,
    method: "PUT",
    sessionToken: TOKEN,
    origin: ORIGIN,
    canonicalOrigin: ORIGIN,
    requestId,
  }, { identities: stores, sessions: stores, registry: P2_04_ADMIN_REGISTRY, now: NOW, env: {} as NodeJS.ProcessEnv });
  expect(guarded.serviceAuthorization?.entryId).toBe(ENTRY_ID);
  return guarded.serviceAuthorization!;
}

async function harness(options: { db?: FakeDb; env?: NodeJS.ProcessEnv; requestId?: string } = {}) {
  const db = options.db ?? seedDb();
  const { stores, identity, session } = makeStores();
  const requestId = options.requestId ?? randomUUID();
  const authorization = await issueTicket(stores, requestId);
  const serviceEnv = options.env ?? env();
  const deps = { db: db.asPrismaClient(), identities: stores, sessions: stores, env: serviceEnv, now: NOW };
  return {
    db, stores, identity, session, requestId, authorization, deps,
    run(visible: readonly string[], expected: readonly string[], override: Partial<{ requestId: string }> = {}) {
      return replaceHomepageNavSelection({
        authorization,
        entryId: ENTRY_ID,
        mutation: {
          requestId: override.requestId ?? requestId,
          visibleCanonicalTagIds: visible,
          expectedVisibleCanonicalTagIds: expected,
        },
      }, deps);
    },
  };
}

function ids(db: FakeDb, ...slugs: string[]): string[] {
  return slugs.map((slug) => db.idOf(slug));
}

beforeEach(() => {
  vi.mocked(projection.reconcileAllEffectiveTags).mockClear();
  vi.mocked(projection.lockEffectiveTagProjectionExclusive).mockClear();
});

// ───────────────────────────── 保存：成功路径 ─────────────────────────────

describe("v0.5.15 首页题材导航 · replaceHomepageNavSelection", () => {
  it("H6 写开关为 false 时仍可保存；读开关、tag:manage、两步验证都过了即可", async () => {
    const h = await harness({ env: env({ FEATURE_P2_06_5_TAG_ADMIN_WRITE: "false" }) });
    const result = await h.run(ids(h.db, "alpha", "delta"), ids(h.db, "alpha", "beta", "gamma"));
    expect(result).toEqual({ visibleCount: 2, changedCount: 3, replayed: false });
    expect(h.db.visibleSlugs()).toEqual(["alpha", "delta"]);
  });

  it("H6 写开关缺省（未设置）也同样可保存", async () => {
    const h = await harness({ env: { NODE_ENV: "test", FEATURE_P2_06_5_TAGGING: "true" } });
    await expect(h.run(ids(h.db, "alpha", "beta", "gamma", "delta"), ids(h.db, "alpha", "beta", "gamma")))
      .resolves.toMatchObject({ visibleCount: 4, changedCount: 1, replayed: false });
  });

  it("H6 读开关为 false 时拒绝（tagging_disabled / 403），且不开事务", async () => {
    const h = await harness({ env: env({ FEATURE_P2_06_5_TAGGING: "false" }) });
    await expect(h.run(ids(h.db, "alpha"), ids(h.db, "alpha", "beta", "gamma")))
      .rejects.toMatchObject({ code: "tagging_disabled", status: 403 });
    expect(h.db.transactions).toBe(0);
    expect(h.db.visibleSlugs()).toEqual(["alpha", "beta", "gamma"]);
  });

  it("H6 不是 guard 发的授权票据（伪造对象）→ admin_service_authorization_required", async () => {
    const h = await harness();
    await expect(replaceHomepageNavSelection({
      authorization: { ...h.authorization },
      entryId: ENTRY_ID,
      mutation: { requestId: h.requestId, visibleCanonicalTagIds: [], expectedVisibleCanonicalTagIds: [] },
    }, h.deps)).rejects.toMatchObject({ code: "admin_service_authorization_required" });
    expect(h.db.transactions).toBe(0);
  });

  it("H6 无 tag:manage：路由守卫直接拒绝 editor；守卫通过后身份被降权，服务内重读仍然拒绝", async () => {
    const editor = makeStores({ role: "editor" });
    await expect(issueTicket(editor.stores, randomUUID())).rejects.toMatchObject({ code: "admin_capability_denied", status: 403 });

    const h = await harness();
    h.stores.identities.set(h.identity.id, { ...h.identity, role: "editor" });
    await expect(h.run(ids(h.db, "alpha"), ids(h.db, "alpha", "beta", "gamma")))
      .rejects.toMatchObject({ code: "admin_capability_denied", status: 403 });
    expect(h.db.transactions).toBe(0);
    expect(h.db.visibleSlugs()).toEqual(["alpha", "beta", "gamma"]);
  });

  it("H6 两步验证不新鲜：守卫拒绝没做两步验证的会话；守卫通过后会话被撤销或失去两步验证，服务内重读仍然拒绝", async () => {
    const noSecondFactor = makeStores({ twoFactor: false });
    await expect(issueTicket(noSecondFactor.stores, randomUUID()))
      .rejects.toMatchObject({ code: "admin_two_factor_required", status: 403 });

    const lost = await harness();
    lost.stores.sessions.set(lost.session.id, { ...lost.session, twoFactorCompletedAt: null });
    await expect(lost.run(ids(lost.db, "alpha"), ids(lost.db, "alpha", "beta", "gamma")))
      .rejects.toMatchObject({ code: "admin_two_factor_required" });
    expect(lost.db.transactions).toBe(0);

    const revoked = await harness();
    revoked.stores.sessions.set(revoked.session.id, { ...revoked.session, revokedAt: NOW });
    await expect(revoked.run(ids(revoked.db, "alpha"), ids(revoked.db, "alpha", "beta", "gamma"))).rejects.toThrow();
    expect(revoked.db.transactions).toBe(0);
  });

  it("授权票据绑定的请求号 / 入口与调用不一致 → 拒绝", async () => {
    const h = await harness();
    await expect(h.run([], ids(h.db, "alpha", "beta", "gamma"), { requestId: randomUUID() }))
      .rejects.toMatchObject({ code: "admin_service_authorization_required" });
    await expect(replaceHomepageNavSelection({
      authorization: h.authorization,
      entryId: "admin.api.canonical_tag.write" as never,
      mutation: { requestId: h.requestId, visibleCanonicalTagIds: [], expectedVisibleCanonicalTagIds: [] },
    }, h.deps)).rejects.toMatchObject({ code: "admin_service_authorization_required" });
    expect(h.db.transactions).toBe(0);
  });

  it("H7 不触发归属重算、不拿投影锁；H8 行锁是 FOR NO KEY UPDATE（不是 FOR UPDATE）；H5 更新语句不碰 updated_at", async () => {
    const h = await harness();
    await h.run(ids(h.db, "gamma"), ids(h.db, "alpha", "beta", "gamma"));
    expect(projection.reconcileAllEffectiveTags).not.toHaveBeenCalled();
    expect(projection.lockEffectiveTagProjectionExclusive).not.toHaveBeenCalled();

    const select = h.db.statements.find((text) => text.includes("SELECT id, slug, is_homepage_visible"))!;
    expect(select).toContain("FOR NO KEY UPDATE");
    expect(h.db.statements.join("\n")).not.toMatch(/FOR UPDATE/);
    expect(select).toMatch(/WHERE status = 'active' ORDER BY sort_order, slug FOR NO KEY UPDATE/);

    const update = h.db.statements.find((text) => text.startsWith("UPDATE canonical_tag"))!;
    expect(update).toContain("SET is_homepage_visible =");
    expect(update).not.toMatch(/updated_at/i);
    expect(update).toContain("status = 'active'");
    expect(update).toContain("IS DISTINCT FROM");
    // 假库也没有改 updated_at。
    expect(h.db.tags.every((row) => row.updated_at === UPDATED_AT)).toBe(true);
  });

  it("锁顺序：先请求号咨询锁，再命名空间锁 v0515:homepage-nav，再取行锁", async () => {
    const h = await harness();
    await h.run(ids(h.db, "alpha", "beta"), ids(h.db, "alpha", "beta", "gamma"));
    expect(h.db.locks).toEqual([h.requestId, NAMESPACE]);
    const lockStatements = h.db.statements.filter((text) => text.includes("pg_advisory_xact_lock"));
    expect(lockStatements).toHaveLength(2);
    const order = h.db.statements.map((text) => (text.includes("pg_advisory_xact_lock") ? "lock"
      : text.includes("FOR NO KEY UPDATE") ? "rows" : text.startsWith("UPDATE") ? "update" : "?"));
    expect(order).toEqual(["lock", "lock", "rows", "update"]);
  });

  it("停用分类的值保存后不被改动（也不参与当前可见集合的比较）", async () => {
    const db = seedDb();
    // 停用分类 zeta 的 is_homepage_visible 刻意设为 true：它既不该进"当前可见集合"，也不该被 UPDATE 碰。
    db.tags.find((row) => row.slug === "zeta")!.is_homepage_visible = true;
    const h = await harness({ db });
    await h.run([], ids(db, "alpha", "beta", "gamma"));
    expect(db.tags.find((row) => row.slug === "zeta")!.is_homepage_visible).toBe(true);
    expect(db.tags.filter((row) => row.status === "active").every((row) => !row.is_homepage_visible)).toBe(true);
  });

  it("全不选（空名单）可以保存；期望名单乱序、大小写不同仍按集合比较通过", async () => {
    const h = await harness();
    const expectedShuffled = ids(h.db, "gamma", "alpha", "beta").map((id) => id.toUpperCase());
    await expect(h.run([], expectedShuffled)).resolves.toEqual({ visibleCount: 0, changedCount: 3, replayed: false });
    expect(h.db.visibleSlugs()).toEqual([]);
  });

  it("名单没有变化：changedCount=0，仍写一条审计", async () => {
    const h = await harness();
    const same = ids(h.db, "alpha", "beta", "gamma");
    await expect(h.run(same, same)).resolves.toEqual({ visibleCount: 3, changedCount: 0, replayed: false });
    expect(h.db.audits).toHaveLength(1);
    expect(h.db.audits[0]!.afterSnapshot).toMatchObject({ added: [], removed: [] });
  });

  // ─────────────────────────── 冲突 / 校验 ───────────────────────────

  it("expected 名单与库内现值不一致 → 409 homepage_nav_conflict，库内值不变、不写审计", async () => {
    const h = await harness();
    // 页面以为 delta 也勾着，但库里 delta 是未勾（别人刚改过）。
    await expect(h.run(ids(h.db, "alpha"), ids(h.db, "alpha", "beta", "gamma", "delta")))
      .rejects.toMatchObject({ code: "homepage_nav_conflict", status: 409 });
    // 页面名单缺了库里已勾的 gamma。
    await expect(h.run(ids(h.db, "alpha"), ids(h.db, "alpha", "beta")))
      .rejects.toMatchObject({ code: "homepage_nav_conflict", status: 409 });
    expect(h.db.visibleSlugs()).toEqual(["alpha", "beta", "gamma"]);
    expect(h.db.audits).toHaveLength(0);
  });

  it("名单含不存在或已停用的分类 → 400 invalid_homepage_nav，库内值不变、不写审计", async () => {
    const h = await harness();
    const expected = ids(h.db, "alpha", "beta", "gamma");
    await expect(h.run([...ids(h.db, "alpha"), randomUUID()], expected))
      .rejects.toMatchObject({ code: "invalid_homepage_nav", status: 400 });
    await expect(h.run([...ids(h.db, "alpha"), h.db.idOf("zeta")], expected))
      .rejects.toMatchObject({ code: "invalid_homepage_nav", status: 400 });
    expect(h.db.visibleSlugs()).toEqual(["alpha", "beta", "gamma"]);
    expect(h.db.audits).toHaveLength(0);
  });

  it("形状错误一律 invalid_tag_request / 400：非数组、非 UUID、重复、超过 1000 条", async () => {
    const h = await harness();
    const expected = ids(h.db, "alpha", "beta", "gamma");
    const alpha = h.db.idOf("alpha");
    const bad: Array<[string, unknown, unknown]> = [
      ["visible 不是数组", "not-an-array", expected],
      ["expected 不是数组", [], null],
      ["visible 含非 UUID", ["not-a-uuid"], expected],
      ["expected 含非 UUID", [], ["nope"]],
      ["visible 含非字符串", [123], expected],
      ["visible 重复", [alpha, alpha], expected],
      ["visible 重复（大小写不同的同一个 id）", [alpha, alpha.toUpperCase()], expected],
      ["expected 重复", [], [alpha, alpha]],
      ["visible 超过 1000 条", Array.from({ length: 1001 }, () => randomUUID()), expected],
      ["expected 超过 1000 条", [], Array.from({ length: 1001 }, () => randomUUID())],
    ];
    for (const [name, visible, expectedInput] of bad) {
      await expect(h.run(visible as string[], expectedInput as string[]), name)
        .rejects.toMatchObject({ code: "invalid_tag_request", status: 400 });
    }
    expect(h.db.transactions).toBe(0);
    expect(h.db.visibleSlugs()).toEqual(["alpha", "beta", "gamma"]);
  });

  // ─────────────────────────── 幂等 ───────────────────────────

  it("同 requestId + 同 payload 重放：返回 replayed=true 与第一次的计数，不再改库、不再写审计", async () => {
    const h = await harness();
    const visible = ids(h.db, "alpha", "delta");
    const expected = ids(h.db, "alpha", "beta", "gamma");
    const first = await h.run(visible, expected);
    expect(first).toEqual({ visibleCount: 2, changedCount: 3, replayed: false });
    const updatesAfterFirst = h.db.statements.filter((text) => text.startsWith("UPDATE")).length;

    // 重放时 expected 与现值已经不同（第一次已经保存过）——重放不看现值，直接回放第一次的结果。
    const replay = await h.run(visible, expected);
    expect(replay).toEqual({ visibleCount: 2, changedCount: 3, replayed: true });
    expect(h.db.audits).toHaveLength(1);
    expect(h.db.statements.filter((text) => text.startsWith("UPDATE"))).toHaveLength(updatesAfterFirst);
    expect(h.db.visibleSlugs()).toEqual(["alpha", "delta"]);
  });

  it("同 requestId + 同一批 id 换了顺序仍算同一个 payload（按集合规范化）", async () => {
    const h = await harness();
    const visible = ids(h.db, "alpha", "delta");
    const expected = ids(h.db, "alpha", "beta", "gamma");
    await h.run(visible, expected);
    await expect(h.run([...visible].reverse(), [...expected].reverse())).resolves.toMatchObject({ replayed: true });
  });

  it("同 requestId + 不同 payload → 409 idempotency_conflict，不改库", async () => {
    const h = await harness();
    await h.run(ids(h.db, "alpha", "delta"), ids(h.db, "alpha", "beta", "gamma"));
    await expect(h.run(ids(h.db, "beta"), ids(h.db, "alpha", "beta", "gamma")))
      .rejects.toMatchObject({ code: "idempotency_conflict", status: 409 });
    expect(h.db.visibleSlugs()).toEqual(["alpha", "delta"]);
    expect(h.db.audits).toHaveLength(1);
  });

  it("同 requestId 已被另一类分类写入（如停用分类）使用过 → 409 idempotency_conflict", async () => {
    const h = await harness();
    h.db.audits.push({
      actorType: "admin", actorId: ADMIN_ID, action: "tag.canonical.status", entityType: "CanonicalTag",
      entityId: h.db.idOf("alpha"), requestId: h.requestId, beforeSnapshot: {}, afterSnapshot: {}, createdAt: NOW,
    });
    await expect(h.run(ids(h.db, "alpha"), ids(h.db, "alpha", "beta", "gamma")))
      .rejects.toMatchObject({ code: "idempotency_conflict", status: 409 });
    expect(h.db.visibleSlugs()).toEqual(["alpha", "beta", "gamma"]);
  });

  // ─────────────────────────── 审计 ───────────────────────────

  it("审计快照：动作 / 实体 / 操作人 / 请求号，前后为按 slug 升序的名单，added / removed 为本次差异", async () => {
    const h = await harness();
    // 保存前可见 alpha、beta、gamma；保存后 beta、delta：新增 delta，去掉 alpha、gamma。
    await h.run(ids(h.db, "delta", "beta"), ids(h.db, "gamma", "beta", "alpha"));
    expect(h.db.audits).toHaveLength(1);
    const audit = h.db.audits[0]!;
    expect(audit).toMatchObject({
      actorType: "admin",
      actorId: ADMIN_ID,
      action: "tag.canonical.homepage_nav.replace",
      entityType: "CanonicalTag",
      entityId: "homepage-nav",
      requestId: h.requestId,
      beforeSnapshot: { homepageNav: ["alpha", "beta", "gamma"] },
      afterSnapshot: {
        homepageNav: ["beta", "delta"],
        added: ["delta"],
        removed: ["alpha", "gamma"],
        visibleCount: 2,
        changedCount: 3,
      },
    });
    expect((audit.afterSnapshot as { payloadFingerprint: string }).payloadFingerprint).toMatch(/^[0-9a-f]{64}$/);
    // 快照里不出现分类编号，只有 slug。
    expect(JSON.stringify([audit.beforeSnapshot, audit.afterSnapshot])).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
  });

  it("后台审计列表能展示：homepageNav / added / removed 过得了两层白名单，payloadFingerprint 等内部键被剥掉", () => {
    const entry = projectAdminTagAuditEntry({
      action: "tag.canonical.homepage_nav.replace",
      actorId: ADMIN_ID,
      requestId: "r-1",
      reason: null,
      before: { homepageNav: ["a", "b"] },
      after: { homepageNav: ["b"], added: [], removed: ["a"], payloadFingerprint: "x".repeat(64), visibleCount: 1, changedCount: 1 },
      createdAt: NOW.toISOString(),
    });
    expect(entry.before).toEqual({ homepageNav: ["a", "b"] });
    expect(entry.after).toEqual({ homepageNav: ["b"], added: [], removed: ["a"] });
  });
});

// ───────────────────────────── 请求体解析 ─────────────────────────────

describe("v0.5.15 首页题材导航 · 请求体解析 homepageNavMutation", () => {
  const REQUEST_ID = "550e8400-e29b-41d4-a716-446655440000";
  const ID = "11111111-1111-4111-8111-111111111111";

  it("只接受 requestId / visibleCanonicalTagIds / expectedVisibleCanonicalTagIds 三个键", () => {
    expect(homepageNavMutation({
      requestId: REQUEST_ID, visibleCanonicalTagIds: [ID], expectedVisibleCanonicalTagIds: [],
    }, REQUEST_ID)).toEqual({ requestId: REQUEST_ID, visibleCanonicalTagIds: [ID], expectedVisibleCanonicalTagIds: [] });
  });

  it.each([
    ["多余的键", { requestId: REQUEST_ID, visibleCanonicalTagIds: [], expectedVisibleCanonicalTagIds: [], action: "set_status" }],
    ["多余的键（试图夹带分类编号）", { requestId: REQUEST_ID, visibleCanonicalTagIds: [], expectedVisibleCanonicalTagIds: [], canonicalTagId: ID }],
    ["缺 visibleCanonicalTagIds", { requestId: REQUEST_ID, expectedVisibleCanonicalTagIds: [] }],
    ["缺 expectedVisibleCanonicalTagIds", { requestId: REQUEST_ID, visibleCanonicalTagIds: [] }],
    ["缺 requestId", { visibleCanonicalTagIds: [], expectedVisibleCanonicalTagIds: [] }],
    ["请求号与守卫发的不一致", { requestId: "different", visibleCanonicalTagIds: [], expectedVisibleCanonicalTagIds: [] }],
    ["visible 不是数组", { requestId: REQUEST_ID, visibleCanonicalTagIds: "x", expectedVisibleCanonicalTagIds: [] }],
    ["expected 含非字符串", { requestId: REQUEST_ID, visibleCanonicalTagIds: [], expectedVisibleCanonicalTagIds: [1] }],
    ["整个体不是对象（数组）", []],
    ["整个体是 null", null],
  ])("拒绝：%s", (_name, body) => {
    expect(() => homepageNavMutation(body, REQUEST_ID)).toThrowError(
      expect.objectContaining({ code: "invalid_tag_request", status: 400 }),
    );
  });
});

// ───────────────────────────── 错误码与文案 ─────────────────────────────

describe("v0.5.15 首页题材导航 · 错误码与中文文案", () => {
  it("两个新错误码进了错误码表，HTTP 状态与信封都保持原样", () => {
    expect(TAGGING_ADMIN_ERROR_CODES).toContain("homepage_nav_conflict");
    expect(TAGGING_ADMIN_ERROR_CODES).toContain("invalid_homepage_nav");
    expect(toErrorEnvelope(new TaggingAdminError("homepage_nav_conflict", 409)))
      .toEqual({ ok: false, code: "homepage_nav_conflict", status: 409 });
    expect(toErrorEnvelope(new TaggingAdminError("invalid_homepage_nav", 400)))
      .toEqual({ ok: false, code: "invalid_homepage_nav", status: 400 });
  });

  it("中文文案逐字符固定", () => {
    expect(errorEnvelopeCopy({ ok: false, status: 409, code: "homepage_nav_conflict" }))
      .toBe("首页导航名单已被别人改过，请刷新后再保存");
    expect(errorEnvelopeCopy({ ok: false, status: 400, code: "invalid_homepage_nav" }))
      .toBe("名单里有不存在或已停用的分类");
  });
});

// ───────────────────────────── 面板数据 ─────────────────────────────

describe("v0.5.15 首页题材导航 · listHomepageNavCandidates", () => {
  const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

  function candidatesDb() {
    const matrix = [
      { locale: "en", canonical_tag_id: A, slug: "alpha", n: 40 },
      { locale: "ja", canonical_tag_id: A, slug: "alpha", n: 3 },
      { locale: "fr", canonical_tag_id: A, slug: "alpha", n: 1 },
      { locale: "ja", canonical_tag_id: B, slug: "beta", n: 5 },
    ];
    const queried: string[] = [];
    const db = {
      canonicalTag: {
        findMany: async (args: { where: unknown }) => {
          queried.push(`canonicalTag.findMany ${JSON.stringify(args.where)}`);
          return [
            // 故意乱序：同 sortOrder 的两个分类按 slug 排，C 的排序号最大。
            { id: C, slug: "gamma", facet: null, sortOrder: 30, isHomepageVisible: false,
              translations: [] },
            { id: B, slug: "beta", facet: "theme", sortOrder: 10, isHomepageVisible: true,
              translations: [{ locale: "en", displayName: "Beta" }] },
            { id: A, slug: "alpha", facet: "genre", sortOrder: 10, isHomepageVisible: true,
              translations: [{ locale: "zh", displayName: "阿尔法" }, { locale: "en", displayName: "Alpha" }] },
          ];
        },
      },
      operationAudit: {
        findMany: async () => [{
          action: "tag.canonical.homepage_nav.replace", actorId: ADMIN_ID, requestId: "r-1", reason: null,
          beforeSnapshot: { homepageNav: ["alpha"] }, afterSnapshot: { homepageNav: ["alpha", "beta"], added: ["beta"], removed: [], payloadFingerprint: "f" },
          createdAt: NOW,
        }],
      },
      $queryRaw: async (query: SqlLike) => {
        const kind = classifyPublicListQuery(query);
        if (kind === "matrix") return matrix;
        if (kind === "totals") return [{ locale: "en", n: 40 }];
        throw new Error(`unexpected raw query: ${kind}`);
      },
    };
    return { db: db as unknown as PrismaClient, queried };
  }

  beforeEach(() => { clearPublicCategoryCountsCacheForTest(); });

  it("读开关为 false 时抛 tagging_disabled", async () => {
    const { db } = candidatesDb();
    await expect(listHomepageNavCandidates(db, env({ FEATURE_P2_06_5_TAGGING: "false" })))
      .rejects.toMatchObject({ code: "tagging_disabled", status: 403 });
  });

  it("只读启用中的分类；按前台同一把尺子排序；带英语书数与有书语种数；不看写开关", async () => {
    const { db, queried } = candidatesDb();
    const result = await listHomepageNavCandidates(db, env({ FEATURE_P2_06_5_TAG_ADMIN_WRITE: "false" }));
    expect(queried[0]).toContain('"status":"active"');
    expect(result.items.map((item) => item.slug)).toEqual(["alpha", "beta", "gamma"]);
    expect(result.items).toEqual([
      { id: A, slug: "alpha", facet: "genre", sortOrder: 10, zhName: "阿尔法", enName: "Alpha", isHomepageVisible: true, enBookCount: 40, localeCount: 3 },
      { id: B, slug: "beta", facet: "theme", sortOrder: 10, zhName: null, enName: "Beta", isHomepageVisible: true, enBookCount: 0, localeCount: 1 },
      { id: C, slug: "gamma", facet: null, sortOrder: 30, zhName: null, enName: null, isHomepageVisible: false, enBookCount: 0, localeCount: 0 },
    ]);
    expect(result.visibleCount).toBe(2);
    expect(result.audit).toHaveLength(1);
    expect(result.audit[0]).toMatchObject({
      action: "tag.canonical.homepage_nav.replace",
      before: { homepageNav: ["alpha"] },
      after: { homepageNav: ["alpha", "beta"], added: ["beta"], removed: [] },
    });
    // payloadFingerprint 不出服务边界。
    expect(JSON.stringify(result.audit)).not.toContain("payloadFingerprint");
  });

  it("契约投影逐字段复制，丢掉多余字段", () => {
    const view = projectAdminHomepageNav({
      items: [{
        id: A, slug: "alpha", facet: null, sortOrder: 1, zhName: null, enName: null,
        isHomepageVisible: true, enBookCount: 1, localeCount: 1, secret: "x",
      } as never],
      visibleCount: 1,
      audit: [],
    });
    expect(view.items[0]).toEqual({
      id: A, slug: "alpha", facet: null, sortOrder: 1, zhName: null, enName: null,
      isHomepageVisible: true, enBookCount: 1, localeCount: 1,
    });
    expect(JSON.stringify(view)).not.toContain("secret");
  });
});

