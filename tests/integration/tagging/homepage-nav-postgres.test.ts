/**
 * v0.5.15 首页题材导航勾选 · 真实库用例（用真实 `web_app` 角色，真实 grants，真实迁移）。
 *
 * 环境：`scripts/run-effective-tag-projection-postgres-verification.sh` 起一次性 postgres:16.14，
 * 跑真实 `roles.sql` + 全部迁移（含 20261010160000_canonical_tag_homepage_visible）+ `grants.sql`，
 * 五个角色的连接串经 `B38_*_DATABASE_URL` 传入（与同目录其它 B-38 用例共用 `effective-tag-fixtures`）。
 *
 * 钉住的事实（对应 H1～H9 里需要真实库才能证明的几条）：
 *   1. 迁移后所有分类默认 true（含停用的），列 NOT NULL DEFAULT true；
 *   2. 用 web_app 真实保存成功（写开关为 false 的生产现状下），库内值正确；
 *   3. H5 保存前后所有 canonical_tag 行的 updated_at 逐行相等（取文本，微秒精度）；
 *   4. 审计行存在且内容正确（entityId = homepage-nav，前后为 slug 升序名单）；
 *   5. 名单冲突返回 409（homepage_nav_conflict），且库内值不变；
 *   6. 停用分类的值保存后不被改动；
 *   7. H1 保存后 `listPublicCategories` 的集合与顺序和保存前完全相同（页脚 / 详情页可链接集合同源于它）；
 *   另：全不选、非法编号 400、同请求号重放、并发两次保存只有一次成功、与归属表全量重算并发不死锁（H7/H8）。
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { ADMIN_ABSOLUTE_TIMEOUT_MS, hashAdminSessionToken } from "@/lib/auth/session";
import type { AdminIdentity, AdminSessionRecord } from "@/lib/auth/types";
import { clearPublicCategoryCountsCacheForTest } from "@/lib/site/public-list";
import { listPublicCategories } from "@/lib/site/queries";
import { requireAdminRouteAccess } from "@/server/auth/guards";
import type { AdminRegistry } from "@/server/auth/registry";
import { listHomepageNavCandidates, replaceHomepageNavSelection } from "@/server/tagging/admin-service";
import { reconcileAllEffectiveTags } from "@/server/tagging/effective-tag-projection";
import { TestOnlyInMemoryAuthStores } from "../../backend/auth/test-only-in-memory-stores";
import { envFor, seedListScenario } from "../site/site-fixtures";
import {
  assertIsolatedDatabase,
  connectRoles,
  disconnectRoles,
  enabled,
  resetDatabase,
  seedFoundation,
  type Foundation,
} from "./effective-tag-fixtures";

const roles = connectRoles();
const { owner, web } = roles;

let f: Foundation;

const TOKEN = "b38-homepage-nav-token";
const ORIGIN = "https://admin.example.test";
const NOW = new Date("2026-10-10T00:00:00.000Z");
const PATH = "/api/admin/canonical-tags/homepage-nav";
const ENTRY_ID = "admin.api.canonical_tag.homepage_nav.write" as const;
const REGISTRY: AdminRegistry = {
  pageRoots: [],
  routes: [{ id: ENTRY_ID, path: PATH, methods: ["PUT"], capability: "tag:manage" }],
  actions: [],
};
/** 生产现状：分类读开关 true、分类写开关 false。首页勾选必须在这种状态下能保存。 */
const adminEnv: NodeJS.ProcessEnv = {
  ...process.env,
  FEATURE_P2_06_5_TAGGING: "true",
  FEATURE_P2_06_5_TAG_ADMIN_WRITE: "false",
  FEATURE_NOVEL_TAG_AUTO: "false",
  AUTO_WRITE_AUTHORIZED: "NO",
};
const publicEnv = envFor({ autoTags: true, seoVisibility: true });

type Row = { id: string; slug: string; status: string; visible: boolean; updatedAt: string };

async function snapshot(): Promise<Row[]> {
  const rows = await owner.$queryRaw<Array<{ id: string; slug: string; status: string; is_homepage_visible: boolean; updated_at: string }>>`
    SELECT id, slug, status, is_homepage_visible, updated_at::text AS updated_at FROM canonical_tag ORDER BY slug`;
  return rows.map((row) => ({
    id: row.id, slug: row.slug, status: row.status, visible: row.is_homepage_visible, updatedAt: row.updated_at,
  }));
}

const activeVisibleIds = (rows: readonly Row[]) => rows.filter((row) => row.status === "active" && row.visible).map((row) => row.id);
const activeIds = (rows: readonly Row[]) => rows.filter((row) => row.status === "active").map((row) => row.id);
const idOf = (rows: readonly Row[], slug: string) => rows.find((row) => row.slug === slug)!.id;

async function save(visible: readonly string[], expected: readonly string[], requestId: string = randomUUID()) {
  const stores = new TestOnlyInMemoryAuthStores();
  const identity: AdminIdentity = {
    id: f.admin, username: "b38-homepage-nav", role: "super_admin", status: "active", sessionVersion: 1, twoFactorEnabled: true,
  };
  const issuedAt = new Date(NOW.getTime() - 60_000);
  const session: AdminSessionRecord = {
    id: randomUUID(), tokenHash: hashAdminSessionToken(TOKEN), identityId: identity.id, sessionVersion: 1,
    issuedAt, lastSeenAt: issuedAt, absoluteExpiresAt: new Date(issuedAt.getTime() + ADMIN_ABSOLUTE_TIMEOUT_MS),
    twoFactorCompletedAt: issuedAt, revokedAt: null,
  };
  stores.identities.set(identity.id, identity);
  stores.sessions.set(session.id, session);
  const guarded = await requireAdminRouteAccess({
    pathname: PATH, method: "PUT", sessionToken: TOKEN, origin: ORIGIN, canonicalOrigin: ORIGIN, requestId,
  }, { identities: stores, sessions: stores, registry: REGISTRY, env: adminEnv, now: NOW });
  return replaceHomepageNavSelection({
    authorization: guarded.serviceAuthorization!,
    entryId: ENTRY_ID,
    mutation: { requestId, visibleCanonicalTagIds: visible, expectedVisibleCanonicalTagIds: expected },
  }, { db: web, identities: stores, sessions: stores, env: adminEnv, now: NOW });
}

/** 前台首页 / 页脚 / 详情页可链接集合共用的那一份（完整，带 `homepageVisible`）。 */
async function publicCategoriesFull(locale: "en" | "es" | "ko") {
  clearPublicCategoryCountsCacheForTest();
  return listPublicCategories(web, locale, publicEnv);
}

/** 同一份去掉 `homepageVisible`：保存前后应当逐项相同（集合、顺序、名字、链接、排序号、updatedAt）。 */
async function publicCategories(locale: "en" | "es" | "ko") {
  return (await publicCategoriesFull(locale)).map(({ homepageVisible: _flag, ...rest }) => (void _flag, rest));
}

async function homepageNavAudits() {
  return owner.$queryRaw<Array<{
    action: string; actor_type: string; actor_id: string | null; entity_type: string; entity_id: string;
    request_id: string | null; before_snapshot: Record<string, unknown>; after_snapshot: Record<string, unknown>;
  }>>`
    SELECT action, actor_type, actor_id, entity_type, entity_id, request_id, before_snapshot, after_snapshot
    FROM operation_audit WHERE action = 'tag.canonical.homepage_nav.replace' ORDER BY created_at, id`;
}

describe.skipIf(!enabled).sequential("v0.5.15 首页题材导航勾选（真实 web_app 角色）", () => {
  beforeAll(async () => {
    await assertIsolatedDatabase(owner);
    await resetDatabase(owner);
    f = await seedFoundation(owner);
    await seedListScenario(owner, f, { novels: 200, seed: 20_261_010 });
    await reconcileAllEffectiveTags(web);
  }, 240_000);
  beforeEach(() => { clearPublicCategoryCountsCacheForTest(); });
  afterAll(async () => { await disconnectRoles(roles); });

  it("用的是真实 web_app 角色", async () => {
    expect(await web.$queryRaw`SELECT current_user AS role`).toEqual([{ role: "web_app" }]);
  });

  it("1·迁移后所有分类默认 true（含停用的）；列是 BOOLEAN NOT NULL DEFAULT true", async () => {
    const rows = await snapshot();
    expect(rows.length).toBe(12);
    expect(rows.every((row) => row.visible)).toBe(true);
    expect(rows.some((row) => row.status === "inactive")).toBe(true);
    const [column] = await owner.$queryRaw<Array<{ data_type: string; is_nullable: string; column_default: string }>>`
      SELECT data_type, is_nullable, column_default FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'canonical_tag' AND column_name = 'is_homepage_visible'`;
    expect(column).toEqual({ data_type: "boolean", is_nullable: "NO", column_default: "true" });
  });

  it("2·3·4·7·用 web_app 真实保存成功；H5 updated_at 逐行不变；审计行内容正确；H1 前台分类集合与顺序不变", async () => {
    const before = await snapshot();
    const publicBefore = { en: await publicCategories("en"), es: await publicCategories("es"), ko: await publicCategories("ko") };
    const publicBeforeFull = { en: await publicCategoriesFull("en") };
    expect(publicBefore.en.length).toBeGreaterThan(3);

    const keep = ["alpha", "gamma", "omega"].map((slug) => idOf(before, slug));
    const requestId = randomUUID();
    const result = await save(keep, activeVisibleIds(before), requestId);
    // 12 个分类里 11 个启用：保存前 11 个启用的都勾着，保存后只勾 3 个 → 去掉 8 个。
    expect(result).toEqual({ visibleCount: 3, changedCount: 8, replayed: false });

    const after = await snapshot();
    // 2·库内值正确：勾的 3 个 true，其余启用的 false。
    expect(after.filter((row) => row.status === "active" && row.visible).map((row) => row.slug).sort())
      .toEqual(["alpha", "gamma", "omega"]);
    expect(after.filter((row) => row.status === "active" && !row.visible)).toHaveLength(8);
    // 3·H5：所有行（含停用的）updated_at 逐行相等，取文本微秒精度。
    expect(after.map((row) => [row.id, row.updatedAt])).toEqual(before.map((row) => [row.id, row.updatedAt]));

    // 4·审计：一条，内容正确。
    const audits = await homepageNavAudits();
    expect(audits).toHaveLength(1);
    const audit = audits[0]!;
    expect(audit).toMatchObject({
      action: "tag.canonical.homepage_nav.replace",
      actor_type: "admin",
      actor_id: f.admin,
      entity_type: "CanonicalTag",
      entity_id: "homepage-nav",
      request_id: requestId,
    });
    const activeSlugsSorted = before.filter((row) => row.status === "active").map((row) => row.slug).sort();
    expect(audit.before_snapshot).toEqual({ homepageNav: activeSlugsSorted });
    expect(audit.after_snapshot).toMatchObject({
      homepageNav: ["alpha", "gamma", "omega"],
      added: [],
      removed: activeSlugsSorted.filter((slug) => !["alpha", "gamma", "omega"].includes(slug)),
      visibleCount: 3,
      changedCount: 8,
    });

    // 7·H1：页脚 / 首页导航 / 详情页可链接集合共用的分类列表，集合与顺序与保存前完全相同（逐项深比较），
    // 唯一变的是每一项上的 homepageVisible（只有首页导航读它）。
    expect(await publicCategories("en")).toEqual(publicBefore.en);
    expect(await publicCategories("es")).toEqual(publicBefore.es);
    expect(await publicCategories("ko")).toEqual(publicBefore.ko);
    for (const locale of ["en", "es", "ko"] as const) {
      const full = await publicCategoriesFull(locale);
      expect(full.every((tag) => tag.homepageVisible === ["alpha", "gamma", "omega"].includes(tag.slug)), locale).toBe(true);
    }
    // 保存前 homepageVisible 全是 true（迁移默认值）。
    expect(publicBeforeFull.en.every((tag) => tag.homepageVisible)).toBe(true);
  });

  it("面板数据：全部启用分类 + 当前勾选 + 英语书数 / 有书语种数；读到的勾选与库一致", async () => {
    const rows = await snapshot();
    const candidates = await listHomepageNavCandidates(web, adminEnv);
    expect(candidates.items).toHaveLength(11); // zeta 停用，不出现
    expect(candidates.items.map((item) => item.slug)).not.toContain("zeta");
    expect(candidates.visibleCount).toBe(3);
    expect(candidates.items.filter((item) => item.isHomepageVisible).map((item) => item.slug).sort())
      .toEqual(["alpha", "gamma", "omega"]);
    expect(candidates.items.every((item) => Number.isInteger(item.enBookCount) && Number.isInteger(item.localeCount))).toBe(true);
    expect(candidates.items.some((item) => item.enBookCount > 0)).toBe(true);
    expect(candidates.audit).toHaveLength(1);
    expect(candidates.audit[0]).toMatchObject({ action: "tag.canonical.homepage_nav.replace" });
    expect(activeVisibleIds(rows).sort()).toEqual(candidates.items.filter((item) => item.isHomepageVisible).map((item) => item.id).sort());
  });

  it("5·名单冲突 → 409 homepage_nav_conflict，库内值不变、不多审计", async () => {
    const before = await snapshot();
    const auditsBefore = (await homepageNavAudits()).length;
    // 页面以为是全部启用分类都勾着（过期名单），库里现在只有 3 个。
    await expect(save([idOf(before, "alpha")], activeIds(before)))
      .rejects.toMatchObject({ code: "homepage_nav_conflict", status: 409 });
    expect(await snapshot()).toEqual(before);
    expect((await homepageNavAudits()).length).toBe(auditsBefore);
  });

  it("非法编号 → 400 invalid_homepage_nav（不存在的 / 停用的），库内值不变", async () => {
    const before = await snapshot();
    const expected = activeVisibleIds(before);
    await expect(save([...expected, randomUUID()], expected)).rejects.toMatchObject({ code: "invalid_homepage_nav", status: 400 });
    await expect(save([...expected, idOf(before, "zeta")], expected)).rejects.toMatchObject({ code: "invalid_homepage_nav", status: 400 });
    expect(await snapshot()).toEqual(before);
  });

  it("6·停用分类的值保存后不被改动：zeta 保存前后都是 true，且不出现在当前可见集合里", async () => {
    const before = await snapshot();
    expect(before.find((row) => row.slug === "zeta")).toMatchObject({ status: "inactive", visible: true });
    await save(activeIds(before), activeVisibleIds(before));
    const after = await snapshot();
    expect(after.find((row) => row.slug === "zeta")).toEqual(before.find((row) => row.slug === "zeta"));
    expect(after.filter((row) => row.status === "active").every((row) => row.visible)).toBe(true);
    expect(after.map((row) => [row.id, row.updatedAt])).toEqual(before.map((row) => [row.id, row.updatedAt]));
  });

  it("全不选（空名单）可保存；前台分类列表仍然不变", async () => {
    const before = await snapshot();
    const publicBefore = await publicCategories("en");
    await expect(save([], activeVisibleIds(before))).resolves.toMatchObject({ visibleCount: 0, replayed: false });
    const after = await snapshot();
    expect(after.filter((row) => row.status === "active").every((row) => !row.visible)).toBe(true);
    expect(after.map((row) => [row.id, row.updatedAt])).toEqual(before.map((row) => [row.id, row.updatedAt]));
    expect(await publicCategories("en")).toEqual(publicBefore);
  });

  it("同请求号重放：replayed=true，不再改库、不再写审计", async () => {
    const before = await snapshot();
    const visible = ["beta", "delta"].map((slug) => idOf(before, slug));
    const requestId = randomUUID();
    const first = await save(visible, activeVisibleIds(before), requestId);
    expect(first).toMatchObject({ visibleCount: 2, replayed: false });
    const auditsAfterFirst = (await homepageNavAudits()).length;
    const mid = await snapshot();
    const second = await save(visible, activeVisibleIds(before), requestId);
    expect(second).toEqual({ ...first, replayed: true });
    expect(await snapshot()).toEqual(mid);
    expect((await homepageNavAudits()).length).toBe(auditsAfterFirst);
    await expect(save([idOf(before, "alpha")], activeVisibleIds(before), requestId))
      .rejects.toMatchObject({ code: "idempotency_conflict", status: 409 });
  });

  it("并发：两个不同请求号拿同一份 expected 同时保存，只有一个成功，另一个 409", async () => {
    const before = await snapshot();
    const expected = activeVisibleIds(before);
    const results = await Promise.allSettled([
      save([idOf(before, "alpha")], expected),
      save([idOf(before, "beta")], expected),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ code: "homepage_nav_conflict", status: 409 });
    expect((await snapshot()).filter((row) => row.status === "active" && row.visible)).toHaveLength(1);
  });

  it("H7/H8·与归属表全量重算并发不死锁（FOR NO KEY UPDATE 不与重算的外键检查冲突）", async () => {
    for (let round = 0; round < 6; round += 1) {
      const current = await snapshot();
      const next = current.filter((row) => row.status === "active" && row.slug.charCodeAt(0) % 2 === round % 2)
        .map((row) => row.id);
      const [saved, reconciled] = await Promise.allSettled([
        save(next, activeVisibleIds(current)),
        reconcileAllEffectiveTags(web),
      ]);
      expect(saved.status, `round ${round} save`).toBe("fulfilled");
      expect(reconciled.status, `round ${round} reconcile`).toBe("fulfilled");
    }
  }, 120_000);
});
