/**
 * P2-02B 真实 PostgreSQL 冒烟：模板生命周期（新建 → 停用 → 启用 → 软删）。
 *
 * 🔴 这个文件存在的理由是一条**单元测试抓不到**的缺陷：初始 migration 给
 * `article_template.status` 装的 CHECK 是 `('draft','active','retired')`，而服务层
 * 一直写 `inactive`（`softDeleteArticleTemplate` 更是硬写）。带 fake db 的单测全绿，
 * 真库上「停用」和「删除」却必然以 23514 check_violation 失败，再被 server action
 * 吞成不透明的 `template_write_failed`。只有真库能证明这条修好了。
 *
 * 连接身份刻意用 `web_app`（最小权限角色），而不是 migration_owner——新增列如果漏了
 * 授权，只有以真实运行时角色连接才会暴露。
 *
 * 门禁：`P2_02B_DATABASE_TEST=1` 且提供 `P2_02B_WEB_DATABASE_URL`，否则整个 describe
 * 跳过（与 `tests/integration/tagging/p2-06-5-postgres.test.ts` 同一约定）。
 *
 * 用例数现为 8（含"编辑改 key 被服务端闸门拒绝"）；运行器
 * `scripts/run-p2-02b-article-template-postgres-verification.sh` 钉死 `Tests 8 passed (8)`，
 * 增删用例必须同步改运行器里的期望数，否则门禁变量拼错导致的整文件跳过会无声通过。
 */
import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { hashAdminSessionToken } from "@/lib/auth/session";
import type { AdminIdentity, AdminSessionRecord } from "@/lib/auth/types";
import { requireAdminActionAccess } from "@/server/auth/guards";
import { P2_04_ADMIN_REGISTRY } from "@/app/api/admin/_lib/registry";
import {
  createArticleTemplate,
  setArticleTemplateStatus,
  softDeleteArticleTemplate,
  updateArticleTemplate,
} from "@/server/article-templates";
import { TestOnlyInMemoryAuthStores } from "../../backend/auth/test-only-in-memory-stores";

const enabled = process.env.P2_02B_DATABASE_TEST === "1";
const webUrl = process.env.P2_02B_WEB_DATABASE_URL ?? process.env.DATABASE_URL;

const NOW = new Date("2026-09-06T00:00:00.000Z");
const TOKEN = "smoke-session-token";
const ORIGIN = "https://admin.example.test";

const web = new PrismaClient({ datasourceUrl: webUrl });

function authFixture() {
  const stores = new TestOnlyInMemoryAuthStores();
  const identity: AdminIdentity = {
    id: "admin-1", username: "admin", role: "super_admin",
    status: "active", sessionVersion: 1, twoFactorEnabled: true,
  };
  const session: AdminSessionRecord = {
    id: "session-1", tokenHash: hashAdminSessionToken(TOKEN), identityId: identity.id,
    sessionVersion: 1,
    issuedAt: new Date(NOW.getTime() - 3_600_000),
    lastSeenAt: new Date(NOW.getTime() - 60_000),
    absoluteExpiresAt: new Date(NOW.getTime() + 23 * 3_600_000),
    twoFactorCompletedAt: new Date(NOW.getTime() - 30_000),
    revokedAt: null,
  };
  stores.identities.set(identity.id, identity);
  stores.sessions.set(session.id, session);
  return stores;
}

async function authorize(stores: TestOnlyInMemoryAuthStores, actionId: string) {
  const requestId = randomUUID();
  const guarded = await requireAdminActionAccess(
    { actionId, sessionToken: TOKEN, origin: ORIGIN, canonicalOrigin: ORIGIN, requestId },
    { identities: stores, sessions: stores, registry: P2_04_ADMIN_REGISTRY, now: NOW, env: {} as NodeJS.ProcessEnv },
  );
  return { authorization: guarded.serviceAuthorization!, requestId };
}

describe.skipIf(!enabled).sequential("P2-02B 模板生命周期（真实 PostgreSQL / web_app 角色）", () => {
  const stores = authFixture();
  const deps = () => ({ db: web, identities: stores, sessions: stores, now: NOW });
  const key = `smoke-${Date.now()}`;
  let templateId = "";
  let v2Id = "";

  beforeAll(async () => { await web.$connect(); });
  afterAll(async () => { await web.$disconnect(); });

  it("新建：写入成功，version 自动分配为 1，五个 CPS 新列落库", async () => {
    const g = await authorize(stores, "admin.article_template.create");
    const row = await createArticleTemplate({
      authorization: g.authorization, requestId: g.requestId,
      template: {
        templateKey: key,
        templateName: "冒烟模板",
        locale: "en",
        status: "active",
        applicableArticleType: "novel_article",
        titleTemplate: "{novel_title}",
        contentTemplate: [
          { type: "heading", content: "{novel_title}" },
          { type: "image", content: "" },
          { type: "paragraph", content: "{novel_description}" },
          { type: "cta", content: "Start Reading" },
        ],
        slugTemplate: "{novel_title}",
        metaKeywordsTemplate: "novel, read",
        metaTitleTemplate: "{novel_title}",
        metaDescriptionTemplate: "{novel_description}",
      },
    }, deps());
    templateId = row.id;
    expect(row.version).toBe(1);
    expect(row.templateName).toBe("冒烟模板");
    expect(row.applicableArticleType).toBe("novel_article");
    expect(row.slugTemplate).toBe("{novel_title}");
    expect(row.metaKeywordsTemplate).toBe("novel, read");
    expect(row.bodyTemplate).toContain("{if cover_url}");
  });

  it("同 key 再建一条：version 自动变成 2（唯一键 (template_key, version) 未被违反）", async () => {
    const g = await authorize(stores, "admin.article_template.create");
    const row = await createArticleTemplate({
      authorization: g.authorization, requestId: g.requestId,
      template: {
        templateKey: key, templateName: "冒烟模板 v2", locale: "en", status: "draft",
        titleTemplate: "{novel_title}",
        contentTemplate: [{ type: "paragraph", content: "{novel_description}" }],
      },
    }, deps());
    expect(row.version).toBe(2);
    v2Id = row.id;
  });

  it("🔴 停用：真库上必须成功——修复前这里会以 23514 check_violation 失败", async () => {
    const g = await authorize(stores, "admin.article_template.status");
    const row = await setArticleTemplateStatus(
      { authorization: g.authorization, requestId: g.requestId, id: templateId, status: "inactive" },
      deps(),
    );
    expect(row.status).toBe("inactive");
    const persisted = await web.articleTemplate.findUniqueOrThrow({ where: { id: templateId } });
    expect(persisted.status).toBe("inactive");
  });

  it("启用：改回 active", async () => {
    const g = await authorize(stores, "admin.article_template.status");
    const row = await setArticleTemplateStatus(
      { authorization: g.authorization, requestId: g.requestId, id: templateId, status: "active" },
      deps(),
    );
    expect(row.status).toBe("active");
  });

  it("编辑：更新落库且 locale 白名单在真库路径上生效", async () => {
    const g = await authorize(stores, "admin.article_template.update");
    const row = await updateArticleTemplate({
      authorization: g.authorization, requestId: g.requestId, id: templateId,
      template: {
        templateKey: key, templateName: "冒烟模板（已改名）", locale: "ja", status: "active",
        titleTemplate: "{novel_title}",
        contentTemplate: [{ type: "paragraph", content: "{novel_description}" }],
      },
    }, deps());
    expect(row.templateName).toBe("冒烟模板（已改名）");
    expect(row.locale).toBe("ja");

    const bad = await authorize(stores, "admin.article_template.update");
    await expect(updateArticleTemplate({
      authorization: bad.authorization, requestId: bad.requestId, id: templateId,
      template: {
        templateKey: key, templateName: "x", locale: "eng", status: "active",
        titleTemplate: "{novel_title}",
        contentTemplate: [{ type: "paragraph", content: "{novel_description}" }],
      },
    }, deps())).rejects.toThrow("template_locale_invalid");
  });

  it("🔴 编辑改 key 被服务端闸门拒绝：v2 行整行不动，库里不出现新 key 的行，也不留 update 审计", async () => {
    // (key, 2) → (renamed, 2)：新 key 下没有 v2，数据库唯一约束 (template_key, version) 放行这次改写，
    // 只有应用层闸门能拦。不拦的话 v2 会静默脱离原家族、凭空开出一个新家族。
    const renamed = `${key}-renamed`;
    const before = await web.articleTemplate.findUniqueOrThrow({ where: { id: v2Id } });
    const g = await authorize(stores, "admin.article_template.update");
    await expect(updateArticleTemplate({
      authorization: g.authorization, requestId: g.requestId, id: v2Id,
      template: {
        templateKey: renamed, templateName: "v2 想顺手改 key", locale: "en", status: "draft",
        titleTemplate: "{novel_title}",
        contentTemplate: [{ type: "paragraph", content: "{novel_description}" }],
      },
    }, deps())).rejects.toThrow("template_key_immutable");

    const after = await web.articleTemplate.findUniqueOrThrow({ where: { id: v2Id } });
    expect(after).toEqual(before);
    expect(after.templateKey).toBe(key);
    expect(await web.articleTemplate.count({ where: { templateKey: renamed } })).toBe(0);
    expect(await web.articleTemplate.count({ where: { templateKey: key } })).toBe(2);
    const audits = await web.operationAudit.findMany({
      where: { entityType: "ArticleTemplate", entityId: v2Id },
      select: { action: true },
    });
    expect(audits.map((a) => a.action)).toEqual(["article_template.create"]);
  });

  it("🔴 软删：真库上必须成功——修复前 softDelete 硬写 inactive 同样会撞 CHECK", async () => {
    const g = await authorize(stores, "admin.article_template.delete");
    const row = await softDeleteArticleTemplate(
      { authorization: g.authorization, requestId: g.requestId, id: templateId },
      deps(),
    );
    expect(row.status).toBe("inactive");
    expect(row.deletedAt).not.toBeNull();
  });

  it("四次写入都留下了 operation_audit 记录", async () => {
    const audits = await web.operationAudit.findMany({
      where: { entityType: "ArticleTemplate", entityId: templateId },
      select: { action: true },
    });
    expect(audits.map((a) => a.action).sort()).toEqual([
      "article_template.create", "article_template.delete",
      "article_template.status", "article_template.status", "article_template.update",
    ].sort());
  });
});
