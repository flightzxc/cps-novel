import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { hashAdminSessionToken } from "@/lib/auth/session";
import type { AdminIdentity, AdminSessionRecord } from "@/lib/auth/types";
import { requireAdminRouteAccess } from "@/server/auth/guards";
import { P2_04_ADMIN_REGISTRY } from "@/app/api/admin/_lib/registry";
import { updateAdminSiteSetting } from "@/server/site-settings/service";

import { TestOnlyInMemoryAuthStores } from "../../backend/auth/test-only-in-memory-stores";

const enabled = process.env.X6_SITE_SETTING_DATABASE_TEST === "1";
const requiredUrl = (name: string) => {
  const value = process.env[name];
  if (enabled && !value) throw new Error(`${name} is required`);
  return value ?? process.env.DATABASE_URL;
};

const owner = new PrismaClient({ datasourceUrl: requiredUrl("X6_OWNER_DATABASE_URL") });
const web = new PrismaClient({ datasourceUrl: requiredUrl("X6_WEB_DATABASE_URL") });
const worker = new PrismaClient({ datasourceUrl: requiredUrl("X6_WORKER_DATABASE_URL") });
const analyst = new PrismaClient({ datasourceUrl: requiredUrl("X6_ANALYST_DATABASE_URL") });
const scheduler = new PrismaClient({ datasourceUrl: requiredUrl("X6_SCHEDULER_DATABASE_URL") });

const NOW = new Date("2026-08-26T06:00:00.000Z");
const TOKEN = "x6-postgres-session";
const ORIGIN = "https://admin.novel.example";
const SITE_URL = "https://novel.example";

async function expectDenied(run: () => Promise<unknown>) {
  await expect(run()).rejects.toThrow();
}

function authStores() {
  const stores = new TestOnlyInMemoryAuthStores();
  const identity: AdminIdentity = {
    id: randomUUID(),
    username: "x6-admin",
    role: "super_admin",
    status: "active",
    sessionVersion: 1,
    twoFactorEnabled: true,
  };
  const issuedAt = new Date(NOW.getTime() - 60 * 60 * 1000);
  const session: AdminSessionRecord = {
    id: randomUUID(),
    tokenHash: hashAdminSessionToken(TOKEN),
    identityId: identity.id,
    sessionVersion: 1,
    issuedAt,
    lastSeenAt: new Date(NOW.getTime() - 60_000),
    absoluteExpiresAt: new Date(NOW.getTime() + 23 * 60 * 60 * 1000),
    twoFactorCompletedAt: new Date(NOW.getTime() - 30_000),
    revokedAt: null,
  };
  stores.identities.set(identity.id, identity);
  stores.sessions.set(session.id, session);
  return stores;
}

describe.skipIf(!enabled).sequential("X6 SiteSetting PostgreSQL role boundary", () => {
  beforeAll(async () => {
    const [{ database_name: databaseName }] = await owner.$queryRawUnsafe<Array<{ database_name: string }>>(
      "SELECT current_database() AS database_name",
    );
    if (!databaseName.includes("x6_site_setting")) {
      throw new Error(`Refusing X6 setup against ${databaseName}`);
    }
    await owner.siteSetting.update({
      where: { id: 1 },
      data: {
        defaultOgImage: "https://novel.example/old-og.jpg",
        indexNowHost: "",
        indexNowKey: "",
        indexNowKeyLocation: "",
      },
    });
  });

  afterAll(async () => {
    await Promise.all([
      owner.$disconnect(),
      web.$disconnect(),
      worker.$disconnect(),
      analyst.$disconnect(),
      scheduler.$disconnect(),
    ]);
  });

  it("runs the guarded write and sanitized audit as web_app", async () => {
    const stores = authStores();
    const before = await web.siteSetting.findUniqueOrThrow({ where: { id: 1 } });
    const requestId = randomUUID();
    const guarded = await requireAdminRouteAccess(
      {
        pathname: "/api/admin/site-settings",
        method: "PATCH",
        sessionToken: TOKEN,
        origin: ORIGIN,
        canonicalOrigin: ORIGIN,
        requestId,
      },
      {
        identities: stores,
        sessions: stores,
        registry: P2_04_ADMIN_REGISTRY,
        now: NOW,
        env: { SITE_URL } as unknown as NodeJS.ProcessEnv,
      },
    );
    const result = await updateAdminSiteSetting(
      {
        authorization: guarded.serviceAuthorization!,
        requestId,
        expectedUpdatedAt: before.updatedAt.toISOString(),
        reason: "x6 disposable verification",
        defaultOgImage: "https://novel.example/new-og.jpg",
        indexNowHost: "novel.example",
        indexNowKey: "x6-disposable-indexnow-key",
        indexNowKeyLocation: "https://novel.example/indexnow-key.txt",
      },
      {
        db: web,
        identities: stores,
        sessions: stores,
        now: NOW,
        env: { SITE_URL } as unknown as NodeJS.ProcessEnv,
      },
    );

    expect(result.replayed).toBe(false);
    const persisted = await owner.siteSetting.findUniqueOrThrow({ where: { id: 1 } });
    expect(persisted.indexNowKey).toBe("x6-disposable-indexnow-key");
    const audit = await owner.operationAudit.findFirstOrThrow({
      where: { actorType: "admin", action: "site_setting.update", requestId },
    });
    expect(JSON.stringify({
      before: audit.beforeSnapshot,
      after: audit.afterSnapshot,
    })).not.toContain("x6-disposable-indexnow-key");
    expect(audit.reason).toBe("x6 disposable verification");
  });

  it("limits web_app to the four managed fields plus updated_at", async () => {
    await expectDenied(() => web.$executeRawUnsafe("UPDATE site_setting SET site_name='denied' WHERE id=1"));
    await expectDenied(() => web.$executeRawUnsafe("INSERT INTO site_setting (id, updated_at) VALUES (1, now())"));
    await expectDenied(() => web.$executeRawUnsafe("DELETE FROM site_setting WHERE id=1"));

    const writable = await owner.$queryRawUnsafe<Array<{ column_name: string }>>(`
      SELECT column_name
      FROM information_schema.column_privileges
      WHERE table_schema='public' AND table_name='site_setting'
        AND grantee='web_app' AND privilege_type='UPDATE'
      ORDER BY column_name
    `);
    expect(writable.map(({ column_name: columnName }) => columnName)).toEqual([
      "default_og_image",
      "indexnow_host",
      "indexnow_key",
      "indexnow_key_location",
      "updated_at",
    ]);
  });

  it("allows worker_app to read but not mutate SiteSetting", async () => {
    const rows = await worker.$queryRawUnsafe<Array<{ indexnow_key: string }>>(
      "SELECT indexnow_key FROM site_setting WHERE id=1",
    );
    expect(rows[0].indexnow_key).toBe("x6-disposable-indexnow-key");
    await expectDenied(() => worker.$executeRawUnsafe("UPDATE site_setting SET indexnow_key='denied' WHERE id=1"));
  });

  it("denies Analyst and Scheduler all SiteSetting reads, including the key", async () => {
    for (const client of [analyst, scheduler]) {
      await expectDenied(() => client.$queryRawUnsafe("SELECT indexnow_key FROM site_setting WHERE id=1"));
      await expectDenied(() => client.$queryRawUnsafe("SELECT * FROM site_setting WHERE id=1"));
    }
  });
});
