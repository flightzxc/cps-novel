/**
 * Unified SiteSetting read accessor (v0.2.0 foundation, Stream F).
 *
 * CPS never had an interface here to be "compatible" with — `siteSetting`
 * was queried by 25 independent call sites across 14 files, each hand-rolling
 * `prisma.siteSetting.findFirst({ where: { id: 1 } })` with no cache, no TTL,
 * no shared type (`P2-07-12-移植审计-2026-08-12/DECISION-CHECK.md` 核查 2).
 * This module is a net-new design, not a port: every future read of
 * `site_setting` — IndexNow config, SEO metadata defaults, footer content —
 * must go through `getSiteSetting` (or one of the narrow typed getters
 * below), never a bare `db.siteSetting.findUnique(...)` call.
 */
import type { Prisma, PrismaClient } from "@prisma/client";

export type SiteSettingSnapshot = Readonly<{
  siteName: string;
  siteDescription: string;
  homeMetaTitle: string;
  homeMetaDescription: string;
  defaultOgImage: string;
  googleSearchConsoleVerification: string;
  footerCopyrightText: string;
  footerDisclaimerText: string;
  /** Raw parsed JSON value; shape/validation is owned by the footer feature, not this accessor. */
  friendLinks: unknown;
  indexNowHost: string;
  indexNowKey: string;
  indexNowKeyLocation: string;
  ga4MeasurementId: string | null;
  updatedAt: Date;
}>;

type SiteSettingRow = {
  siteName: string;
  siteDescription: string;
  homeMetaTitle: string;
  homeMetaDescription: string;
  defaultOgImage: string;
  googleSearchConsoleVerification: string;
  footerCopyrightText: string;
  footerDisclaimerText: string;
  friendLinks: unknown;
  indexNowHost: string;
  indexNowKey: string;
  indexNowKeyLocation: string;
  ga4MeasurementId: string | null;
  updatedAt: Date;
};

/**
 * The v0.2.0 foundation migration seeds the singleton row (id=1) and the
 * database CHECK `site_setting_singleton_check` forbids any other id from
 * ever existing. A missing row means the migration was rolled back or the
 * seed row was manually deleted — fail closed rather than fabricating
 * defaults, matching this project's "render-time missing value fails
 * closed" discipline (`src/lib/seo/README.md`).
 */
export class SiteSettingNotSeededError extends Error {
  constructor() {
    super(
      "site_setting singleton row (id=1) is missing; the v0.2.0 foundation " +
        "migration seeds it and the site_setting_singleton_check CHECK forbids " +
        "any other row — this must never happen outside a broken migration state",
    );
    this.name = "SiteSettingNotSeededError";
  }
}

function toSnapshot(row: SiteSettingRow): SiteSettingSnapshot {
  return Object.freeze({
    siteName: row.siteName,
    siteDescription: row.siteDescription,
    homeMetaTitle: row.homeMetaTitle,
    homeMetaDescription: row.homeMetaDescription,
    defaultOgImage: row.defaultOgImage,
    googleSearchConsoleVerification: row.googleSearchConsoleVerification,
    footerCopyrightText: row.footerCopyrightText,
    footerDisclaimerText: row.footerDisclaimerText,
    friendLinks: row.friendLinks,
    indexNowHost: row.indexNowHost,
    indexNowKey: row.indexNowKey,
    indexNowKeyLocation: row.indexNowKeyLocation,
    ga4MeasurementId: row.ga4MeasurementId,
    updatedAt: row.updatedAt,
  });
}

type CacheEntry = { value: SiteSettingSnapshot; expiresAtMs: number };
let cache: CacheEntry | null = null;

export const DEFAULT_SITE_SETTING_TTL_MS = 30_000;

export type GetSiteSettingOptions = {
  /** Milliseconds to serve a cached snapshot before re-querying. 0 disables caching. Default 30s. */
  ttlMs?: number;
  /** Injectable clock for tests. Defaults to `Date.now`. */
  now?: () => number;
};

/**
 * Reads the singleton SiteSetting row, applying a small process-local TTL
 * cache (CPS had zero caching across all 25 call sites). Pass `ttlMs: 0` to
 * force a fresh read (e.g. immediately after an admin write).
 */
export async function getSiteSetting(
  db: PrismaClient | Prisma.TransactionClient,
  options: GetSiteSettingOptions = {},
): Promise<SiteSettingSnapshot> {
  const ttlMs = options.ttlMs ?? DEFAULT_SITE_SETTING_TTL_MS;
  const nowMs = (options.now ?? Date.now)();

  if (ttlMs > 0 && cache && cache.expiresAtMs > nowMs) {
    return cache.value;
  }

  const row = await db.siteSetting.findUnique({ where: { id: 1 } });
  if (!row) throw new SiteSettingNotSeededError();

  const snapshot = toSnapshot(row);
  cache = ttlMs > 0 ? { value: snapshot, expiresAtMs: nowMs + ttlMs } : null;
  return snapshot;
}

/** Drops the process-local cache. Call after any admin write to site_setting. */
export function invalidateSiteSettingCache(): void {
  cache = null;
}

// ---------------------------------------------------------------------------
// Narrow typed getters for the most common call sites, mirroring the shape
// of CPS's own direct queries (instrumentation.ts / indexnow.ts /
// indexnow-delivery-service.ts / src/app/indexnow-key.txt/route.ts all read
// exactly these three fields from the same single source — DECISION-CHECK.md
// 核查 2b confirmed CPS has no "static key.txt vs DB config" dual source,
// contrary to the transplant plan's original assumption).
// ---------------------------------------------------------------------------

export type IndexNowDeliveryConfig = Readonly<{
  host: string;
  key: string;
  keyLocation: string;
}>;

export async function getIndexNowDeliveryConfig(
  db: PrismaClient | Prisma.TransactionClient,
  options: GetSiteSettingOptions = {},
): Promise<IndexNowDeliveryConfig> {
  const settings = await getSiteSetting(db, options);
  return Object.freeze({
    host: settings.indexNowHost,
    key: settings.indexNowKey,
    keyLocation: settings.indexNowKeyLocation,
  });
}

/** Trim-authoritative: all three IndexNow fields must be present, matching CPS's `deliverDueIndexNow` gate. */
export function isIndexNowConfigured(config: IndexNowDeliveryConfig): boolean {
  return (
    config.host.trim().length > 0 &&
    config.key.trim().length > 0 &&
    config.keyLocation.trim().length > 0
  );
}

/** CPS parity: `site-settings.ts`'s sole export was this single-field getter. */
export async function getGa4MeasurementId(
  db: PrismaClient | Prisma.TransactionClient,
  options: GetSiteSettingOptions = {},
): Promise<string | null> {
  const settings = await getSiteSetting(db, options);
  return settings.ga4MeasurementId;
}
