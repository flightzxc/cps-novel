/**
 * 真实 PostgreSQL：后台"新建版本"之后，建文章选中的必须是新版本。
 *
 * 缺陷：`selectActiveArticleTemplate` 首选键 `system-default-v1` 只有 en 有；其余 14 个
 * 语种的默认模板键是 `system-default-<locale>-v1`，全部落到兜底分支，而兜底分支按
 * "创建时间最早的一行"取，永远是 v1——运营在后台给非英语模板建了 v2，新文章仍用 v1。
 *
 * 为什么要真库：单测夹具把每一行的 createdAt 写成同一时刻，同刻并列时
 * `version: "desc"` 次序键恰好把 v2 排前，缺陷被夹具本身藏住了。这里 v2 走真实的
 * `createArticleTemplate`（web_app 角色、真实事务、真实 created_at），v1 用
 * migration_owner 回拨 created_at，贴近生产：15 条默认模板是引导脚本几周前落的。
 * 选版在两个生产读角色下各跑一遍：web_app（后台单篇生成/再生成）与
 * worker_app（批量建内容）。
 *
 * 门禁：`ARTICLE_TEMPLATE_VERSION_DATABASE_TEST=1` 且提供三个连接串，否则整个
 * describe 跳过；由 `scripts/run-article-template-version-postgres-verification.sh`
 * 在一次性数据库上执行。
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
  selectActiveArticleTemplate,
  setArticleTemplateStatus,
} from "@/server/article-templates";
import { DEFAULT_ARTICLE_TEMPLATE_KEY } from "@/server/content-creation/default-article-template";
import { TestOnlyInMemoryAuthStores } from "../../backend/auth/test-only-in-memory-stores";

const enabled = process.env.ARTICLE_TEMPLATE_VERSION_DATABASE_TEST === "1";
const ownerUrl = process.env.ARTICLE_TEMPLATE_VERSION_OWNER_DATABASE_URL;
const webUrl = process.env.ARTICLE_TEMPLATE_VERSION_WEB_DATABASE_URL;
const workerUrl = process.env.ARTICLE_TEMPLATE_VERSION_WORKER_DATABASE_URL;

const NOW = new Date("2026-09-30T00:00:00.000Z");
const TOKEN = "template-version-session-token";
const ORIGIN = "https://admin.example.test";
const DAY_MS = 24 * 60 * 60 * 1000;
// created_at 由数据库真实时钟写入，回拨点相对当前时间取，不写死日历日。
const BOOTSTRAPPED_AT = new Date(Date.now() - 14 * DAY_MS);
const LATER_FAMILY_AT = new Date(Date.now() - 7 * DAY_MS);
const LOCALES = ["en", "ru", "ja"] as const;

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

describe.skipIf(!enabled).sequential("模板新版本生效（真实 PostgreSQL / web_app 写、web_app+worker_app 读）", () => {
  const owner = new PrismaClient({ datasourceUrl: ownerUrl });
  const web = new PrismaClient({ datasourceUrl: webUrl });
  const worker = new PrismaClient({ datasourceUrl: workerUrl });
  const stores = authFixture();
  const deps = () => ({ db: web, identities: stores, sessions: stores, now: NOW });

  async function authorize(actionId: string) {
    const requestId = randomUUID();
    const guarded = await requireAdminActionAccess(
      { actionId, sessionToken: TOKEN, origin: ORIGIN, canonicalOrigin: ORIGIN, requestId },
      { identities: stores, sessions: stores, registry: P2_04_ADMIN_REGISTRY, now: NOW, env: {} as NodeJS.ProcessEnv },
    );
    return { authorization: guarded.serviceAuthorization!, requestId };
  }

  async function createVersion(templateKey: string, locale: string, status: "active" | "draft" = "active") {
    return createArticleTemplate({
      ...(await authorize("admin.article_template.create")),
      template: {
        templateKey,
        templateName: `${templateKey} 版本`,
        locale,
        status,
        titleTemplate: "{novel_title}",
        contentTemplate: [{ type: "heading", content: "{novel_title}" }, { type: "paragraph", content: "{novel_description}" }],
        metaTitleTemplate: "{novel_title}",
        metaDescriptionTemplate: "{novel_description}",
      },
    }, deps());
  }

  async function backdate(templateKey: string, version: number, at: Date) {
    const updated = await owner.$executeRaw`
      UPDATE article_template SET created_at = ${at}
      WHERE template_key = ${templateKey} AND version = ${version}`;
    expect(updated).toBe(1);
  }

  async function expectSelected(locale: string, expected: { id: string; templateKey: string; version: number }) {
    for (const reader of [web, worker]) {
      const selected = await selectActiveArticleTemplate(reader, { locale, applicableArticleType: "novel_article" });
      expect({ id: selected?.id, templateKey: selected?.templateKey, version: selected?.version }).toEqual(expected);
    }
  }

  beforeAll(async () => {
    await Promise.all([owner.$connect(), web.$connect(), worker.$connect()]);
    // 一次性库前提：这几个语种下不能有别的模板，否则"最早的启用模板"不由本文件决定。
    const existing = await owner.articleTemplate.count({ where: { locale: { in: [...LOCALES] } } });
    expect(existing).toBe(0);
  });
  afterAll(async () => {
    await Promise.all([owner.$disconnect(), web.$disconnect(), worker.$disconnect()]);
  });

  it("en：system-default-v1 建 v2 后选中 v2", async () => {
    await createVersion(DEFAULT_ARTICLE_TEMPLATE_KEY, "en");
    await backdate(DEFAULT_ARTICLE_TEMPLATE_KEY, 1, BOOTSTRAPPED_AT);
    const v2 = await createVersion(DEFAULT_ARTICLE_TEMPLATE_KEY, "en");
    expect(v2.version).toBe(2);
    await expectSelected("en", { id: v2.id, templateKey: DEFAULT_ARTICLE_TEMPLATE_KEY, version: 2 });
  });

  it("🔴 ru：system-default-ru-v1 建 v2 后选中 v2（修复前恒选 v1）", async () => {
    await createVersion("system-default-ru-v1", "ru");
    await backdate("system-default-ru-v1", 1, BOOTSTRAPPED_AT);
    const v2 = await createVersion("system-default-ru-v1", "ru");
    expect(v2.version).toBe(2);
    await expectSelected("ru", { id: v2.id, templateKey: "system-default-ru-v1", version: 2 });
  });

  it("ru：后建的另一族版本号再高也不抢走默认族", async () => {
    await createVersion("ru-later", "ru");
    await backdate("ru-later", 1, LATER_FAMILY_AT);
    await createVersion("ru-later", "ru");
    const v3 = await createVersion("ru-later", "ru");
    expect(v3.version).toBe(3);
    const defaultV2 = await web.articleTemplate.findFirstOrThrow({ where: { templateKey: "system-default-ru-v1", version: 2 } });
    await expectSelected("ru", { id: defaultV2.id, templateKey: "system-default-ru-v1", version: 2 });
  });

  it("🔴 ja：草稿 v2 不接管；经 setArticleTemplateStatus 启用后接管", async () => {
    const v1 = await createVersion("system-default-ja-v1", "ja");
    await backdate("system-default-ja-v1", 1, BOOTSTRAPPED_AT);
    const v2 = await createVersion("system-default-ja-v1", "ja", "draft");
    await expectSelected("ja", { id: v1.id, templateKey: "system-default-ja-v1", version: 1 });

    await setArticleTemplateStatus({
      ...(await authorize("admin.article_template.status")),
      id: v2.id,
      status: "active",
    }, deps());
    await expectSelected("ja", { id: v2.id, templateKey: "system-default-ja-v1", version: 2 });
  });
});
