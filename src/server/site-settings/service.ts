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
import { createHash } from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";

import type { AdminIdentityStore, SessionStore } from "@/lib/auth/ports";
import { withDbRetry } from "@/lib/db/db-retry";
import { getSiteUrl } from "@/lib/seo/site-url";
import {
  requireFreshAdminServiceMutation,
  type AdminServiceAuthorization,
} from "@/server/auth/guards";

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
  readonly code = "site_setting_not_seeded" as const;
  readonly status = 500 as const;

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

// ---------------------------------------------------------------------------
// Admin write surface (X6)
// ---------------------------------------------------------------------------

const SITE_SETTING_AUDIT_ACTION = "site_setting.update";
const SITE_SETTING_ENTITY_ID = "1";
const SITE_SETTING_ENTRY_ID = "admin.api.site_settings";
const WRITABLE_FIELDS = [
  "defaultOgImage",
  "indexNowHost",
  "indexNowKey",
  "indexNowKeyLocation",
] as const;

type WritableField = (typeof WRITABLE_FIELDS)[number];
type WritableValues = Readonly<Record<WritableField, string>>;

export type AdminSiteSettingView = Readonly<WritableValues & {
  updatedAt: string;
}>;

export type SiteSettingMutationResult = Readonly<{
  setting: AdminSiteSettingView;
  replayed: boolean;
}>;

export type UpdateSiteSettingInput = Readonly<{
  authorization: AdminServiceAuthorization;
  requestId: string;
  expectedUpdatedAt: unknown;
  reason: unknown;
  defaultOgImage?: unknown;
  indexNowHost?: unknown;
  indexNowKey?: unknown;
  indexNowKeyLocation?: unknown;
}>;

export type SiteSettingWriteDependencies = Readonly<{
  db: PrismaClient;
  identities: AdminIdentityStore;
  sessions: SessionStore;
  now?: Date;
  env?: NodeJS.ProcessEnv;
}>;

export class SiteSettingValidationError extends Error {
  readonly code = "site_setting_invalid" as const;
  readonly status = 400 as const;

  constructor(message: string) {
    super(message);
    this.name = "SiteSettingValidationError";
  }
}

export class SiteSettingMutationConflictError extends Error {
  readonly code = "site_setting_conflict" as const;
  readonly status = 409 as const;
  readonly details?: Readonly<{ reason: "idempotency_conflict" }>;

  constructor(idempotencyConflict = false) {
    super(
      idempotencyConflict
        ? "The mutation request id is already bound to a different SiteSetting update"
        : "SiteSetting changed after it was read",
    );
    this.name = "SiteSettingMutationConflictError";
    if (idempotencyConflict) {
      this.details = Object.freeze({ reason: "idempotency_conflict" as const });
    }
  }
}

class SiteSettingConcurrentUpdateSignal extends Error {}

function adminView(snapshot: SiteSettingSnapshot): AdminSiteSettingView {
  return Object.freeze({
    defaultOgImage: snapshot.defaultOgImage,
    indexNowHost: snapshot.indexNowHost,
    indexNowKey: snapshot.indexNowKey,
    indexNowKeyLocation: snapshot.indexNowKeyLocation,
    updatedAt: snapshot.updatedAt.toISOString(),
  });
}

export async function getAdminSiteSetting(
  db: PrismaClient | Prisma.TransactionClient,
): Promise<AdminSiteSettingView> {
  return adminView(await getSiteSetting(db, { ttlMs: 0 }));
}

function requiredText(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string") {
    throw new SiteSettingValidationError(`${field} must be a string`);
  }
  const normalized = value.trim();
  if (!normalized) throw new SiteSettingValidationError(`${field} is required`);
  if (normalized.length > maxLength) {
    throw new SiteSettingValidationError(`${field} is too long`);
  }
  return normalized;
}

function expectedTimestamp(value: unknown): Date {
  const normalized = requiredText(value, "expectedUpdatedAt", 64);
  const parsed = new Date(normalized);
  if (!Number.isFinite(parsed.getTime())) {
    throw new SiteSettingValidationError("expectedUpdatedAt must be an ISO-8601 timestamp");
  }
  return parsed;
}

function normalizedPatch(input: UpdateSiteSettingInput): Partial<Record<WritableField, string>> {
  const patch: Partial<Record<WritableField, string>> = {};
  for (const field of WRITABLE_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(input, field)) continue;
    const value = input[field];
    if (typeof value !== "string") {
      throw new SiteSettingValidationError(`${field} must be a string`);
    }
    const normalized = value.trim();
    const maxLength = field === "defaultOgImage" ? 4096 : 255;
    if (normalized.length > maxLength) {
      throw new SiteSettingValidationError(`${field} is too long`);
    }
    patch[field] = normalized;
  }
  if (Object.keys(patch).length === 0) {
    throw new SiteSettingValidationError("At least one SiteSetting field is required");
  }
  return patch;
}

function validateMergedValues(
  before: SiteSettingSnapshot,
  patch: Partial<Record<WritableField, string>>,
  env: NodeJS.ProcessEnv,
): { values: WritableValues; patch: Partial<Record<WritableField, string>> } {
  const values: Record<WritableField, string> = {
    defaultOgImage: patch.defaultOgImage ?? before.defaultOgImage.trim(),
    indexNowHost: patch.indexNowHost ?? before.indexNowHost.trim(),
    indexNowKey: patch.indexNowKey ?? before.indexNowKey.trim(),
    indexNowKeyLocation: patch.indexNowKeyLocation ?? before.indexNowKeyLocation.trim(),
  };

  if (!values.defaultOgImage) {
    throw new SiteSettingValidationError("defaultOgImage must remain non-empty");
  }

  const indexNowValues = [values.indexNowHost, values.indexNowKey, values.indexNowKeyLocation];
  const configuredCount = indexNowValues.filter(Boolean).length;
  if (configuredCount !== 0 && configuredCount !== indexNowValues.length) {
    throw new SiteSettingValidationError(
      "indexNowHost, indexNowKey, and indexNowKeyLocation must be all empty or all configured",
    );
  }

  if (configuredCount === indexNowValues.length) {
    const siteOrigin = getSiteUrl({ SITE_URL: env.SITE_URL });
    const siteUrl = new URL(siteOrigin);
    if (values.indexNowHost.toLowerCase() !== siteUrl.host.toLowerCase()) {
      throw new SiteSettingValidationError("indexNowHost must match the SITE_URL host");
    }
    const expectedLocation = new URL("/indexnow-key.txt", siteOrigin).href;
    let parsedLocation: URL;
    try {
      parsedLocation = new URL(values.indexNowKeyLocation);
    } catch {
      throw new SiteSettingValidationError("indexNowKeyLocation must be an absolute URL");
    }
    if (parsedLocation.href !== expectedLocation) {
      throw new SiteSettingValidationError(
        "indexNowKeyLocation must point to this deployment's /indexnow-key.txt route",
      );
    }
    values.indexNowHost = siteUrl.host;
    values.indexNowKeyLocation = expectedLocation;
    if (patch.indexNowHost !== undefined) patch.indexNowHost = values.indexNowHost;
    if (patch.indexNowKeyLocation !== undefined) {
      patch.indexNowKeyLocation = values.indexNowKeyLocation;
    }
  }

  return { values: Object.freeze(values), patch };
}

function requestFingerprint(input: {
  actorId: string;
  expectedUpdatedAt: Date;
  reason: string;
  patch: Partial<Record<WritableField, string>>;
}): string {
  return createHash("sha256")
    .update(JSON.stringify({
      actorId: input.actorId,
      expectedUpdatedAt: input.expectedUpdatedAt.toISOString(),
      reason: input.reason,
      patch: WRITABLE_FIELDS.flatMap((field) =>
        input.patch[field] === undefined ? [] : [[field, input.patch[field]]],
      ),
    }))
    .digest("hex");
}

function auditSnapshot(values: WritableValues, updatedAt: Date): Prisma.JsonObject {
  return {
    defaultOgImage: values.defaultOgImage,
    indexNowHost: values.indexNowHost,
    indexNowKeyConfigured: values.indexNowKey.length > 0,
    indexNowKeyLocation: values.indexNowKeyLocation,
    updatedAt: updatedAt.toISOString(),
  };
}

type SiteSettingReplayReader = Pick<
  Prisma.TransactionClient,
  "operationAudit" | "siteSetting"
>;

async function findCommittedUpdate(
  db: SiteSettingReplayReader,
  binding: { requestId: string; actorId: string; fingerprint: string },
): Promise<AdminSiteSettingView | null> {
  const audit = await db.operationAudit.findFirst({
    where: {
      actorType: "admin",
      action: SITE_SETTING_AUDIT_ACTION,
      requestId: binding.requestId,
    },
    select: {
      actorId: true,
      entityType: true,
      entityId: true,
      afterSnapshot: true,
    },
  });
  if (!audit) return null;
  const snapshot = audit.afterSnapshot;
  const storedFingerprint =
    snapshot && typeof snapshot === "object" && !Array.isArray(snapshot)
      ? (snapshot as Prisma.JsonObject).requestFingerprint
      : null;
  if (
    audit.actorId !== binding.actorId
    || audit.entityType !== "SiteSetting"
    || audit.entityId !== SITE_SETTING_ENTITY_ID
    || storedFingerprint !== binding.fingerprint
  ) {
    throw new SiteSettingMutationConflictError(true);
  }
  const row = await db.siteSetting.findUnique({ where: { id: 1 } });
  if (!row) throw new SiteSettingNotSeededError();
  return adminView(toSnapshot(row));
}

export async function updateAdminSiteSetting(
  input: UpdateSiteSettingInput,
  deps: SiteSettingWriteDependencies,
): Promise<SiteSettingMutationResult> {
  const context = await requireFreshAdminServiceMutation(
    input.authorization,
    "settings:manage",
    {
      identities: deps.identities,
      sessions: deps.sessions,
      now: deps.now,
      env: deps.env,
      entryId: SITE_SETTING_ENTRY_ID,
      requestId: input.requestId,
    },
  );
  const reason = requiredText(input.reason, "reason", 1000);
  const expectedUpdatedAt = expectedTimestamp(input.expectedUpdatedAt);
  const requestedPatch = normalizedPatch(input);
  const env = deps.env ?? process.env;

  const initial = await deps.db.siteSetting.findUnique({ where: { id: 1 } });
  if (!initial) throw new SiteSettingNotSeededError();
  const validated = validateMergedValues(toSnapshot(initial), requestedPatch, env);
  const fingerprint = requestFingerprint({
    actorId: context.identity.id,
    expectedUpdatedAt,
    reason,
    patch: validated.patch,
  });
  const binding = { requestId: input.requestId, actorId: context.identity.id, fingerprint };
  const prior = await findCommittedUpdate(deps.db, binding);
  if (prior) {
    // A replay may land on a different Web process from the original commit.
    // The committed Audit proves it is now safe to clear this process's cache.
    invalidateSiteSettingCache();
    return Object.freeze({ setting: prior, replayed: true });
  }

  const candidateNow = deps.now ?? new Date();
  const updatedAt = new Date(
    Math.max(candidateNow.getTime(), expectedUpdatedAt.getTime() + 1),
  );
  // PostgreSQL stores this column at microsecond precision, while Prisma's
  // JavaScript Date projection (and the browser ISO value) can only preserve
  // milliseconds. The foundation seed uses CURRENT_TIMESTAMP, so its first
  // write can otherwise never match the exact stored value. Keep the CAS
  // bounded to the one millisecond represented by expectedUpdatedAt; any
  // committed service write advances updatedAt by at least one millisecond
  // and therefore remains outside this exclusive window.
  const expectedUpdatedAtExclusive = new Date(expectedUpdatedAt.getTime() + 1);

  try {
    const result = await withDbRetry(
      () => deps.db.$transaction(async (tx) => {
        const replay = await findCommittedUpdate(tx, binding);
        if (replay) return { setting: replay, wrote: false } as const;

        const beforeRow = await tx.siteSetting.findUnique({ where: { id: 1 } });
        if (!beforeRow) throw new SiteSettingNotSeededError();
        const before = toSnapshot(beforeRow);
        const currentValidation = validateMergedValues(before, { ...validated.patch }, env);
        const write = await tx.siteSetting.updateMany({
          where: {
            id: 1,
            updatedAt: { gte: expectedUpdatedAt, lt: expectedUpdatedAtExclusive },
          },
          data: { ...currentValidation.patch, updatedAt },
        });
        if (write.count !== 1) throw new SiteSettingConcurrentUpdateSignal();

        const afterRow = await tx.siteSetting.findUnique({ where: { id: 1 } });
        if (!afterRow) throw new SiteSettingNotSeededError();
        const after = toSnapshot(afterRow);
        await tx.operationAudit.create({
          data: {
            actorType: "admin",
            actorId: context.identity.id,
            action: SITE_SETTING_AUDIT_ACTION,
            entityType: "SiteSetting",
            entityId: SITE_SETTING_ENTITY_ID,
            requestId: input.requestId,
            reason,
            beforeSnapshot: auditSnapshot(
              {
                defaultOgImage: before.defaultOgImage,
                indexNowHost: before.indexNowHost,
                indexNowKey: before.indexNowKey,
                indexNowKeyLocation: before.indexNowKeyLocation,
              },
              before.updatedAt,
            ),
            afterSnapshot: {
              ...auditSnapshot(
                {
                  defaultOgImage: after.defaultOgImage,
                  indexNowHost: after.indexNowHost,
                  indexNowKey: after.indexNowKey,
                  indexNowKeyLocation: after.indexNowKeyLocation,
                },
                after.updatedAt,
              ),
              requestFingerprint: fingerprint,
            },
          },
        });
        return { setting: adminView(after), wrote: true } as const;
      }),
      {
        op: "site-settings.updateAdminSiteSetting",
        itemId: SITE_SETTING_ENTITY_ID,
        idempotencyKey: input.requestId,
      },
    );
    // `wrote=false` means the transaction observed a matching commit made by a
    // concurrent request. In either case the commit is durable before cache
    // invalidation, including on a different Web process.
    invalidateSiteSettingCache();
    return Object.freeze({ setting: result.setting, replayed: !result.wrote });
  } catch (error) {
    if (!(error instanceof SiteSettingConcurrentUpdateSignal)) throw error;
    const committed = await findCommittedUpdate(deps.db, binding);
    if (committed) {
      invalidateSiteSettingCache();
      return Object.freeze({ setting: committed, replayed: true });
    }
    throw new SiteSettingMutationConflictError();
  }
}
