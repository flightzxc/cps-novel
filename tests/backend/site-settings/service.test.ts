import type { PrismaClient } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  getGa4MeasurementId,
  getIndexNowDeliveryConfig,
  getSiteSetting,
  invalidateSiteSettingCache,
  isIndexNowConfigured,
  SiteSettingNotSeededError,
  type IndexNowDeliveryConfig,
} from "@/server/site-settings/service";

const ROW = {
  siteName: "CPS Novel",
  siteDescription: "desc",
  homeMetaTitle: "title",
  homeMetaDescription: "meta desc",
  defaultOgImage: "",
  googleSearchConsoleVerification: "",
  footerCopyrightText: "",
  footerDisclaimerText: "",
  friendLinks: [],
  indexNowHost: "example.com",
  indexNowKey: "key123",
  indexNowKeyLocation: "https://example.com/key123.txt",
  ga4MeasurementId: "G-TEST",
  updatedAt: new Date("2026-08-18T00:00:00Z"),
};

function dbReturning(row: unknown): PrismaClient {
  return { siteSetting: { findUnique: vi.fn().mockResolvedValue(row) } } as unknown as PrismaClient;
}

beforeEach(() => {
  invalidateSiteSettingCache();
});

describe("getSiteSetting", () => {
  it("returns a typed snapshot from the singleton row", async () => {
    const db = dbReturning(ROW);
    const snapshot = await getSiteSetting(db, { ttlMs: 0 });
    expect(snapshot.siteName).toBe("CPS Novel");
    expect(snapshot.indexNowHost).toBe("example.com");
    expect(snapshot.ga4MeasurementId).toBe("G-TEST");
  });

  it("queries id=1", async () => {
    const db = dbReturning(ROW);
    await getSiteSetting(db, { ttlMs: 0 });
    expect(db.siteSetting.findUnique).toHaveBeenCalledWith({ where: { id: 1 } });
  });

  it("throws SiteSettingNotSeededError when the row is missing", async () => {
    const db = dbReturning(null);
    await expect(getSiteSetting(db, { ttlMs: 0 })).rejects.toBeInstanceOf(SiteSettingNotSeededError);
  });

  it("caches within the TTL window and does not re-query", async () => {
    const db = dbReturning(ROW);
    let nowMs = 1_000;
    const now = () => nowMs;
    await getSiteSetting(db, { ttlMs: 30_000, now });
    nowMs += 10_000;
    await getSiteSetting(db, { ttlMs: 30_000, now });
    expect(db.siteSetting.findUnique).toHaveBeenCalledTimes(1);
  });

  it("re-queries once the TTL window has elapsed", async () => {
    const db = dbReturning(ROW);
    let nowMs = 1_000;
    const now = () => nowMs;
    await getSiteSetting(db, { ttlMs: 30_000, now });
    nowMs += 30_001;
    await getSiteSetting(db, { ttlMs: 30_000, now });
    expect(db.siteSetting.findUnique).toHaveBeenCalledTimes(2);
  });

  it("bypasses the cache entirely when ttlMs is 0", async () => {
    const db = dbReturning(ROW);
    await getSiteSetting(db, { ttlMs: 0 });
    await getSiteSetting(db, { ttlMs: 0 });
    expect(db.siteSetting.findUnique).toHaveBeenCalledTimes(2);
  });

  it("invalidateSiteSettingCache forces the next read to re-query", async () => {
    const db = dbReturning(ROW);
    await getSiteSetting(db, { ttlMs: 30_000 });
    invalidateSiteSettingCache();
    await getSiteSetting(db, { ttlMs: 30_000 });
    expect(db.siteSetting.findUnique).toHaveBeenCalledTimes(2);
  });
});

describe("getIndexNowDeliveryConfig", () => {
  it("projects only the three IndexNow fields", async () => {
    const db = dbReturning(ROW);
    const config = await getIndexNowDeliveryConfig(db, { ttlMs: 0 });
    expect(config).toEqual({
      host: "example.com",
      key: "key123",
      keyLocation: "https://example.com/key123.txt",
    });
  });
});

describe("isIndexNowConfigured", () => {
  const full: IndexNowDeliveryConfig = { host: "h", key: "k", keyLocation: "l" };

  it("is true when all three fields are non-blank", () => {
    expect(isIndexNowConfigured(full)).toBe(true);
  });

  it("is false when host is empty", () => {
    expect(isIndexNowConfigured({ ...full, host: "" })).toBe(false);
  });

  it("is false when key is pure whitespace", () => {
    expect(isIndexNowConfigured({ ...full, key: "   " })).toBe(false);
  });

  it("is false when keyLocation is pure whitespace", () => {
    expect(isIndexNowConfigured({ ...full, keyLocation: "\t\n" })).toBe(false);
  });
});

describe("getGa4MeasurementId", () => {
  it("returns the field value", async () => {
    const db = dbReturning(ROW);
    expect(await getGa4MeasurementId(db, { ttlMs: 0 })).toBe("G-TEST");
  });

  it("returns null when unset", async () => {
    const db = dbReturning({ ...ROW, ga4MeasurementId: null });
    expect(await getGa4MeasurementId(db, { ttlMs: 0 })).toBeNull();
  });
});
