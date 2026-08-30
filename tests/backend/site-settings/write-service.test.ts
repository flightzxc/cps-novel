import type { PrismaClient } from "@prisma/client";
import { beforeEach, describe, expect, it } from "vitest";

import { hashAdminSessionToken } from "@/lib/auth/session";
import type { AdminIdentity, AdminSessionRecord } from "@/lib/auth/types";
import { requireAdminRouteAccess } from "@/server/auth/guards";
import {
  getSiteSetting,
  invalidateSiteSettingCache,
  SiteSettingMutationConflictError,
  SiteSettingNotSeededError,
  SiteSettingValidationError,
  updateAdminSiteSetting,
} from "@/server/site-settings/service";
import { P2_04_ADMIN_REGISTRY } from "@/app/api/admin/_lib/registry";

import { TestOnlyInMemoryAuthStores } from "../auth/test-only-in-memory-stores";

const NOW = new Date("2026-08-26T03:00:00.000Z");
const BEFORE = new Date("2026-08-26T02:00:00.000Z");
const TOKEN = "x6-site-setting-session";
const ORIGIN = "https://admin.example.com";
const SITE_URL = "https://novel.example.com";

const BASE_ROW = {
  siteName: "CPS Novel",
  siteDescription: "desc",
  homeMetaTitle: "title",
  homeMetaDescription: "meta desc",
  defaultOgImage: "https://novel.example.com/old-og.jpg",
  googleSearchConsoleVerification: "",
  footerCopyrightText: "",
  footerDisclaimerText: "",
  friendLinks: [],
  indexNowHost: "",
  indexNowKey: "",
  indexNowKeyLocation: "",
  ga4MeasurementId: null,
  updatedAt: BEFORE,
};

type Row = typeof BASE_ROW;
type Audit = Record<string, unknown> & {
  actorType: string;
  action: string;
  requestId: string;
};

class FakeSiteSettingDb {
  row: Row | null;
  readonly audits: Audit[] = [];
  updateCalls = 0;
  lastUpdateWindow: { gte: Date; lt: Date } | null = null;

  constructor(row: Row | null = BASE_ROW) {
    this.row = row ? structuredClone(row) : null;
  }

  private client() {
    return {
      siteSetting: {
        findUnique: async () => this.row ? structuredClone(this.row) : null,
        updateMany: async (args: {
          where: { id: number; updatedAt: { gte: Date; lt: Date } };
          data: Partial<Row>;
        }) => {
          this.updateCalls += 1;
          this.lastUpdateWindow = structuredClone(args.where.updatedAt);
          if (
            !this.row
            || args.where.id !== 1
            || this.row.updatedAt.getTime() < args.where.updatedAt.gte.getTime()
            || this.row.updatedAt.getTime() >= args.where.updatedAt.lt.getTime()
          ) {
            return { count: 0 };
          }
          this.row = { ...this.row, ...structuredClone(args.data) };
          return { count: 1 };
        },
      },
      operationAudit: {
        findFirst: async (args: { where: { actorType: string; action: string; requestId: string } }) =>
          this.audits.find((audit) =>
            audit.actorType === args.where.actorType
            && audit.action === args.where.action
            && audit.requestId === args.where.requestId,
          ) ?? null,
        create: async (args: { data: Audit }) => {
          this.audits.push(structuredClone(args.data));
          return { id: BigInt(this.audits.length) };
        },
      },
      $transaction: async <T>(run: (tx: unknown) => Promise<T>): Promise<T> => {
        const rowBefore = this.row ? structuredClone(this.row) : null;
        const auditCount = this.audits.length;
        try {
          return await run(this.client());
        } catch (error) {
          this.row = rowBefore;
          this.audits.splice(auditCount);
          throw error;
        }
      },
    };
  }

  asPrismaClient(): PrismaClient {
    return this.client() as unknown as PrismaClient;
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
  const issuedAt = new Date(NOW.getTime() - 60 * 60 * 1000);
  const session: AdminSessionRecord = {
    id: "session-1",
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
  return { stores, identity, session };
}

async function authorization(
  stores: TestOnlyInMemoryAuthStores,
  requestId = "550e8400-e29b-41d4-a716-446655440000",
) {
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
  return { authorization: guarded.serviceAuthorization!, requestId };
}

function dependencies(db: FakeSiteSettingDb, stores: TestOnlyInMemoryAuthStores) {
  return {
    db: db.asPrismaClient(),
    identities: stores,
    sessions: stores,
    now: NOW,
    env: { SITE_URL } as unknown as NodeJS.ProcessEnv,
  };
}

beforeEach(() => invalidateSiteSettingCache());

describe("updateAdminSiteSetting", () => {
  it("trims, conditionally updates, audits without the raw key, then invalidates the read cache", async () => {
    const db = new FakeSiteSettingDb();
    const { stores } = authFixture();
    const guarded = await authorization(stores);
    await getSiteSetting(db.asPrismaClient(), { ttlMs: 30_000, now: () => NOW.getTime() });

    const result = await updateAdminSiteSetting(
      {
        ...guarded,
        expectedUpdatedAt: BEFORE.toISOString(),
        reason: "  production SEO rollout  ",
        defaultOgImage: "  https://novel.example.com/new-og.jpg  ",
        indexNowHost: " novel.example.com ",
        indexNowKey: " raw-key-material ",
        indexNowKeyLocation: " https://novel.example.com/indexnow-key.txt ",
      },
      dependencies(db, stores),
    );

    expect(result).toMatchObject({ replayed: false, setting: {
      defaultOgImage: "https://novel.example.com/new-og.jpg",
      indexNowHost: "novel.example.com",
      indexNowKey: "raw-key-material",
      indexNowKeyLocation: "https://novel.example.com/indexnow-key.txt",
    } });
    expect(db.updateCalls).toBe(1);
    expect(db.lastUpdateWindow).toEqual({
      gte: BEFORE,
      lt: new Date(BEFORE.getTime() + 1),
    });
    expect(db.audits).toHaveLength(1);
    expect(db.audits[0]).toMatchObject({
      actorType: "admin",
      actorId: "admin-1",
      action: "site_setting.update",
      entityType: "SiteSetting",
      entityId: "1",
      reason: "production SEO rollout",
    });
    expect(JSON.stringify(db.audits[0])).not.toContain("raw-key-material");
    expect(JSON.stringify(db.audits[0])).toContain("indexNowKeyConfigured");

    const fresh = await getSiteSetting(db.asPrismaClient(), {
      ttlMs: 30_000,
      now: () => NOW.getTime(),
    });
    expect(fresh.defaultOgImage).toBe("https://novel.example.com/new-og.jpg");
  });

  it("requires at least one field and a non-empty merged defaultOgImage", async () => {
    const db = new FakeSiteSettingDb();
    const { stores } = authFixture();
    const guarded = await authorization(stores);
    await expect(updateAdminSiteSetting({
      ...guarded,
      expectedUpdatedAt: BEFORE.toISOString(),
      reason: "r",
    }, dependencies(db, stores))).rejects.toBeInstanceOf(SiteSettingValidationError);
    await expect(updateAdminSiteSetting({
      ...guarded,
      expectedUpdatedAt: BEFORE.toISOString(),
      reason: "r",
      defaultOgImage: "   ",
    }, dependencies(db, stores))).rejects.toBeInstanceOf(SiteSettingValidationError);
  });

  it("accepts only an all-empty or all-configured IndexNow triple", async () => {
    const db = new FakeSiteSettingDb();
    const { stores } = authFixture();
    const guarded = await authorization(stores);
    await expect(updateAdminSiteSetting({
      ...guarded,
      expectedUpdatedAt: BEFORE.toISOString(),
      reason: "r",
      indexNowHost: "novel.example.com",
    }, dependencies(db, stores))).rejects.toBeInstanceOf(SiteSettingValidationError);

    await expect(updateAdminSiteSetting({
      ...guarded,
      expectedUpdatedAt: BEFORE.toISOString(),
      reason: "r",
      indexNowHost: "other.example.com",
      indexNowKey: "key",
      indexNowKeyLocation: "https://novel.example.com/indexnow-key.txt",
    }, dependencies(db, stores))).rejects.toBeInstanceOf(SiteSettingValidationError);

    await expect(updateAdminSiteSetting({
      ...guarded,
      expectedUpdatedAt: BEFORE.toISOString(),
      reason: "r",
      indexNowHost: "novel.example.com",
      indexNowKey: "key",
      indexNowKeyLocation: "https://novel.example.com/not-the-local-route.txt",
    }, dependencies(db, stores))).rejects.toBeInstanceOf(SiteSettingValidationError);
  });

  it("replays the same bound request without a second write or audit and rejects payload drift", async () => {
    const db = new FakeSiteSettingDb();
    const { stores } = authFixture();
    const guarded = await authorization(stores);
    const input = {
      ...guarded,
      expectedUpdatedAt: BEFORE.toISOString(),
      reason: "r",
      defaultOgImage: "https://novel.example.com/new.jpg",
    };
    await updateAdminSiteSetting(input, dependencies(db, stores));
    const replay = await updateAdminSiteSetting(input, dependencies(db, stores));
    expect(replay.replayed).toBe(true);
    expect(db.updateCalls).toBe(1);
    expect(db.audits).toHaveLength(1);

    await expect(updateAdminSiteSetting(
      { ...input, defaultOgImage: "https://novel.example.com/different.jpg" },
      dependencies(db, stores),
    )).rejects.toMatchObject({
      code: "site_setting_conflict",
      status: 409,
      details: { reason: "idempotency_conflict" },
    });
  });

  it("returns 409 on a stale updatedAt and never writes an audit", async () => {
    const db = new FakeSiteSettingDb({ ...BASE_ROW, updatedAt: new Date(BEFORE.getTime() + 1) });
    const { stores } = authFixture();
    const guarded = await authorization(stores);
    await expect(updateAdminSiteSetting({
      ...guarded,
      expectedUpdatedAt: BEFORE.toISOString(),
      reason: "r",
      defaultOgImage: "https://novel.example.com/new.jpg",
    }, dependencies(db, stores))).rejects.toBeInstanceOf(SiteSettingMutationConflictError);
    expect(db.audits).toHaveLength(0);
  });

  it("treats a missing singleton as deployment damage and never upserts", async () => {
    const db = new FakeSiteSettingDb(null);
    const { stores } = authFixture();
    const guarded = await authorization(stores);
    await expect(updateAdminSiteSetting({
      ...guarded,
      expectedUpdatedAt: BEFORE.toISOString(),
      reason: "r",
      defaultOgImage: "https://novel.example.com/new.jpg",
    }, dependencies(db, stores))).rejects.toBeInstanceOf(SiteSettingNotSeededError);
    expect(db.updateCalls).toBe(0);
  });

  it("rechecks current-session 2FA and capability at service time", async () => {
    const db = new FakeSiteSettingDb();
    const { stores, identity, session } = authFixture();
    const guarded = await authorization(stores);
    stores.sessions.set(session.id, { ...session, twoFactorCompletedAt: null });
    await expect(updateAdminSiteSetting({
      ...guarded,
      expectedUpdatedAt: BEFORE.toISOString(),
      reason: "r",
      defaultOgImage: "https://novel.example.com/new.jpg",
    }, dependencies(db, stores))).rejects.toMatchObject({ code: "admin_two_factor_required" });

    stores.sessions.set(session.id, session);
    stores.identities.set(identity.id, { ...identity, role: "viewer" });
    await expect(updateAdminSiteSetting({
      ...guarded,
      expectedUpdatedAt: BEFORE.toISOString(),
      reason: "r",
      defaultOgImage: "https://novel.example.com/new.jpg",
    }, dependencies(db, stores))).rejects.toMatchObject({ code: "admin_capability_denied" });
  });
});
