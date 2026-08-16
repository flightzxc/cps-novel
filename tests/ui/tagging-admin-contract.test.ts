import { describe, expect, it } from "vitest";

import {
  ADMIN_TAGGING_ROUTES,
  P2_04_ADMIN_REGISTRY,
} from "@/app/api/admin/_lib/registry";
import {
  canonicalTagGetInput,
  canonicalTagMutation,
  novelTagGetInput,
  novelTagMutation,
  sourceLabelMappingGetInput,
  sourceLabelMappingMutation,
} from "@/app/api/admin/_lib/tagging-route";
import { toErrorEnvelope } from "@/app/api/admin/_lib/respond";
import {
  projectAdminCanonicalTagDetail,
  projectAdminNovelTags,
  projectAdminSourceLabelMapping,
} from "@/contracts";
import {
  TAGGING_ADMIN_ERROR_CODES,
  TaggingAdminError,
  type AdminCanonicalTagDetail,
  type AdminNovelTags,
  type AdminSourceLabelMappingItem,
} from "@/domain/tagging-admin";
import { errorEnvelopeCopy } from "@/features/admin-ui/error-copy";
import { ADMIN_CAPABILITY_CONFIG } from "@/lib/auth/capabilities";
import type { AdminIdentityStore, SessionStore } from "@/lib/auth/ports";
import { ADMIN_ABSOLUTE_TIMEOUT_MS, hashAdminSessionToken } from "@/lib/auth/session";
import type { AdminIdentity, AdminSessionRecord } from "@/lib/auth/types";
import { requireAdminRouteAccess } from "@/server/auth/guards";
import { resolveAdminRoute } from "@/server/auth/registry";
import {
  normalizeCanonicalTagGet,
  normalizeSourceLabelMappingGet,
} from "@/server/tagging/admin-service";

const REQUEST_ID = "550e8400-e29b-41d4-a716-446655440000";
const TAG_ID = "11111111-1111-4111-8111-111111111111";
const MAPPING_ID = "22222222-2222-4222-8222-222222222222";
const NOVEL_ID = "33333333-3333-4333-8333-333333333333";
const CHANNEL_APP_ID = "44444444-4444-4444-8444-444444444444";
const UPDATED_AT = "2026-08-17T10:00:00.000Z";
const NOW = new Date("2026-08-17T12:00:00.000Z");
const TOKEN = "tagging-admin-ui-test-token";
const ORIGIN = "https://admin.example.com";

describe("P2-06.5 Tagging Admin registry", () => {
  it("registers exactly six method-specific entries with frozen capabilities", () => {
    expect(ADMIN_TAGGING_ROUTES).toHaveLength(6);
    expect(ADMIN_TAGGING_ROUTES.map((route) => [route.id, route.path, route.methods, route.capability]))
      .toEqual([
        ["admin.api.canonical_tag.read", "/api/admin/canonical-tags", ["GET"], "content:view"],
        ["admin.api.canonical_tag.write", "/api/admin/canonical-tags", ["PUT"], "tag:manage"],
        ["admin.api.tag_mapping.read", "/api/admin/tag-mappings", ["GET"], "content:view"],
        ["admin.api.tag_mapping.write", "/api/admin/tag-mappings", ["PUT"], "tag:manage"],
        ["admin.api.novel_tag.read", "/api/admin/novels/tags", ["GET"], "content:view"],
        ["admin.api.novel_tag.write", "/api/admin/novels/tags", ["PUT"], "tag:manage"],
      ]);
  });

  it("resolves GET and PUT independently and default-denies every other method", () => {
    for (const pathname of [
      "/api/admin/canonical-tags",
      "/api/admin/tag-mappings",
      "/api/admin/novels/tags",
    ]) {
      expect(resolveAdminRoute(pathname, "GET", P2_04_ADMIN_REGISTRY)?.capability).toBe("content:view");
      expect(resolveAdminRoute(pathname, "PUT", P2_04_ADMIN_REGISTRY)?.capability).toBe("tag:manage");
      for (const method of ["POST", "PATCH", "DELETE"]) {
        expect(resolveAdminRoute(pathname, method, P2_04_ADMIN_REGISTRY)).toBeNull();
      }
    }
  });
});

describe("P2-06.5 Tagging Admin query parsing", () => {
  it("passes canonical list values through and lets the server own normalization", () => {
    const parsed = canonicalTagGetInput(new URL(
      "https://admin.example.com/api/admin/canonical-tags?page=2&pageSize=50&search=%20genre%20&active=active",
    ));
    expect(parsed).toEqual({
      id: undefined,
      page: "2",
      pageSize: "50",
      search: " genre ",
      active: "active",
    });
    expect(normalizeCanonicalTagGet(parsed)).toMatchObject({
      mode: "list",
      page: 2,
      pageSize: 50,
      search: "genre",
      active: "active",
    });
  });

  it("preserves exact mapping scope/token bytes represented by the URL", () => {
    const parsed = sourceLabelMappingGetInput(new URL(
      "https://admin.example.com/api/admin/tag-mappings?rawLanguageScope=%20zh-Hans%20&rawToken=%20WuXia%20&active=all",
    ));
    expect(parsed.rawLanguageScope).toBe(" zh-Hans ");
    expect(parsed.rawToken).toBe(" WuXia ");
    expect(normalizeSourceLabelMappingGet(parsed)).toMatchObject({
      mode: "list",
      rawLanguageScope: " zh-Hans ",
      rawToken: " WuXia ",
    });
  });

  it("passes novel id and locale without route-layer normalization", () => {
    expect(novelTagGetInput(new URL(
      `https://admin.example.com/api/admin/novels/tags?novelId=${NOVEL_ID}&locale=zh-Hant`,
    ))).toEqual({ novelId: NOVEL_ID, locale: "zh-Hant" });
  });

  it("rejects detail/list mixtures in the server normalization boundary", () => {
    const canonical = canonicalTagGetInput(new URL(
      `https://admin.example.com/api/admin/canonical-tags?id=${TAG_ID}&page=1`,
    ));
    expect(() => normalizeCanonicalTagGet(canonical)).toThrowError(
      expect.objectContaining({ code: "invalid_tag_request", status: 400 }),
    );

    const mapping = sourceLabelMappingGetInput(new URL(
      `https://admin.example.com/api/admin/tag-mappings?id=${MAPPING_ID}&rawToken=x`,
    ));
    expect(() => normalizeSourceLabelMappingGet(mapping)).toThrowError(
      expect.objectContaining({ code: "invalid_tag_request", status: 400 }),
    );
  });
});

describe("P2-06.5 Tagging Admin mutation parsing", () => {
  it("accepts every CanonicalTag action only with its exact field set", () => {
    expect(canonicalTagMutation({
      action: "set_status",
      requestId: REQUEST_ID,
      canonicalTagId: TAG_ID,
      expectedUpdatedAt: UPDATED_AT,
      status: "inactive",
    }, REQUEST_ID)).toMatchObject({ action: "set_status", status: "inactive" });

    expect(canonicalTagMutation({
      action: "replace_translations",
      requestId: REQUEST_ID,
      canonicalTagId: TAG_ID,
      expectedUpdatedAt: UPDATED_AT,
      translations: [{ locale: "zh", displayName: "武侠" }],
    }, REQUEST_ID)).toMatchObject({ action: "replace_translations" });

    expect(canonicalTagMutation({
      action: "replace_aliases",
      requestId: REQUEST_ID,
      canonicalTagId: TAG_ID,
      expectedUpdatedAt: UPDATED_AT,
      aliases: ["武侠", " wuxia "],
    }, REQUEST_ID)).toMatchObject({ action: "replace_aliases", aliases: ["武侠", " wuxia "] });

    expect(canonicalTagMutation({
      action: "replace_keywords",
      requestId: REQUEST_ID,
      canonicalTagId: TAG_ID,
      expectedUpdatedAt: UPDATED_AT,
      keywords: [{
        keywordId: "kw-1",
        value: "武侠",
        scriptBuckets: ["cjk"],
        matchMode: "cjk_contiguous",
        riskFlags: [],
        active: true,
        lexiconVersion: "c1-v2",
      }],
    }, REQUEST_ID)).toMatchObject({ action: "replace_keywords" });
  });

  it("preserves exact mapping identity and requires nullable expectedUpdatedAt", () => {
    expect(sourceLabelMappingMutation({
      action: "approve_edge",
      requestId: REQUEST_ID,
      channelAppId: CHANNEL_APP_ID,
      rawLanguageScope: " zh-Hans ",
      rawToken: " WuXia ",
      canonicalTagId: TAG_ID,
      mappingVersion: "b2",
      expectedUpdatedAt: null,
    }, REQUEST_ID)).toEqual({
      action: "approve_edge",
      requestId: REQUEST_ID,
      channelAppId: CHANNEL_APP_ID,
      rawLanguageScope: " zh-Hans ",
      rawToken: " WuXia ",
      canonicalTagId: TAG_ID,
      mappingVersion: "b2",
      expectedUpdatedAt: null,
    });

    expect(sourceLabelMappingMutation({
      action: "deactivate_edge",
      requestId: REQUEST_ID,
      mappingId: MAPPING_ID,
      expectedUpdatedAt: UPDATED_AT,
    }, REQUEST_ID)).toMatchObject({ action: "deactivate_edge", mappingId: MAPPING_ID });
  });

  it("accepts explicit manual empty snapshot and keeps revision as a string", () => {
    expect(novelTagMutation({
      action: "replace_manual",
      requestId: REQUEST_ID,
      novelId: NOVEL_ID,
      expectedRevision: "0",
      canonicalTagIds: [],
    }, REQUEST_ID)).toEqual({
      action: "replace_manual",
      requestId: REQUEST_ID,
      novelId: NOVEL_ID,
      expectedRevision: "0",
      canonicalTagIds: [],
    });
    expect(() => novelTagMutation({
      action: "exit_manual",
      requestId: REQUEST_ID,
      novelId: NOVEL_ID,
      expectedRevision: 1,
    }, REQUEST_ID)).toThrowError(expect.objectContaining({ code: "invalid_tag_request" }));
  });

  it.each([
    ["request id mismatch", {
      action: "exit_manual", requestId: "different", novelId: NOVEL_ID, expectedRevision: "1",
    }],
    ["unknown action", {
      action: "merge_manual", requestId: REQUEST_ID, novelId: NOVEL_ID, expectedRevision: "1",
    }],
    ["unknown field", {
      action: "exit_manual", requestId: REQUEST_ID, novelId: NOVEL_ID, expectedRevision: "1", runId: "secret",
    }],
  ])("rejects %s", (_name, body) => {
    expect(() => novelTagMutation(body, REQUEST_ID)).toThrowError(
      expect.objectContaining({ code: "invalid_tag_request", status: 400 }),
    );
  });
});

const audit = {
  action: "tag.canonical.status",
  actorId: "admin-1",
  requestId: REQUEST_ID,
  reason: null,
  before: { status: "active", rawPayload: { secret: true } },
  after: { status: "inactive", evidence: ["forbidden"] },
  createdAt: UPDATED_AT,
} as const;

const authority = {
  taxonomy: {
    status: "READY",
    canonicalV1Count: 123,
    canonicalV1Sha256: "8bc8cdae8be2176bde170173e98bad2b9fa0e1770818174a57320816eefdccad",
    databaseActiveCount: 123,
    versions: ["v1"],
  },
  keywords: {
    status: "INCOMPLETE",
    activeKeywordCount: 0,
    versions: [],
    fingerprint: null,
  },
  classifier: {
    status: "OWNER_REVIEW_PENDING",
    version: "pending",
    titleWeight: null,
    descriptionWeight: null,
    threshold: null,
    maxTextTags: null,
    fingerprint: null,
  },
} as const;

describe("P2-06.5 Tagging Admin browser projections", () => {
  it("projects CanonicalTag field-by-field and strips audit extras", () => {
    const input = {
      tag: {
        id: TAG_ID,
        stableId: "genre.wuxia",
        slug: "wuxia",
        active: true,
        canonicalDefinition: "definition",
        facet: "genre",
        sortOrder: 10,
        taxonomyVersion: "v1",
        translations: [{ locale: "zh", displayName: "武侠", rawPayload: "forbidden" }],
        aliases: ["武侠"],
        keywordSummary: { total: 1, active: 1, lexiconVersions: ["c1-v2"] },
        keywords: [{
          keywordId: "kw-1",
          value: "武侠",
          scriptBuckets: ["cjk"],
          matchMode: "cjk_contiguous",
          riskFlags: [],
          active: true,
          lexiconVersion: "c1-v2",
          evidence: "forbidden",
        }],
        createdAt: UPDATED_AT,
        updatedAt: UPDATED_AT,
        lastMutation: audit,
        audit: [audit],
        rawPayload: { forbidden: true },
      },
      authority,
      runId: "forbidden",
    } as unknown as AdminCanonicalTagDetail;
    const view = projectAdminCanonicalTagDetail(input);
    expect(view.tag.stableId).toBe("genre.wuxia");
    expect(JSON.stringify(view)).not.toMatch(/rawPayload|evidence|runId|secret/);
  });

  it("projects exact mapping fields without source payload or internal evidence", () => {
    const input = {
      id: MAPPING_ID,
      channel: {
        channelAppId: CHANNEL_APP_ID,
        channelCode: "changdu",
        sourceAppCode: "app",
        externalAppId: "external",
        active: true,
        rawPayload: "forbidden",
      },
      rawLanguageScope: " zh-Hans ",
      rawToken: " WuXia ",
      target: { id: TAG_ID, stableId: "genre.wuxia", slug: "wuxia", active: true },
      mappingVersion: "b2",
      active: true,
      approvedBy: { id: "admin-1", username: "admin", passwordHash: "forbidden" },
      approvedAt: UPDATED_AT,
      createdAt: UPDATED_AT,
      updatedAt: UPDATED_AT,
      lastMutation: null,
      score: 0.9,
    } as unknown as AdminSourceLabelMappingItem;
    const view = projectAdminSourceLabelMapping(input);
    expect(view.rawLanguageScope).toBe(" zh-Hans ");
    expect(view.rawToken).toBe(" WuXia ");
    expect(JSON.stringify(view)).not.toMatch(/rawPayload|passwordHash|score/);
  });

  it("projects novel tag layers without run, score, evidence or raw payload", () => {
    const tag = {
      canonicalTagId: TAG_ID,
      stableId: "genre.wuxia",
      slug: "wuxia",
      displayName: "武侠",
      provenance: ["mapped", "auto"],
      runId: "forbidden",
      score: 4,
      evidence: { title: true },
      rawPayload: { source: true },
    };
    const input = {
      mode: "automatic",
      revision: "2",
      effective: [tag],
      manual: [],
      mapped: [tag],
      auto: [tag],
      lastManualMutation: null,
    } as unknown as AdminNovelTags;
    const view = projectAdminNovelTags(input);
    expect(view.effective[0]?.provenance).toEqual(["mapped", "auto"]);
    expect(JSON.stringify(view)).not.toMatch(/runId|score|evidence|rawPayload/);
  });
});

describe("P2-06.5 Tagging Admin error contract", () => {
  it.each([
    ["invalid_tag_request", 400],
    ["tagging_disabled", 403],
    ["canonical_tag_not_found", 404],
    ["revision_conflict", 409],
  ] as const)("preserves %s and its HTTP status", (code, status) => {
    expect(toErrorEnvelope(new TaggingAdminError(code, status))).toEqual({
      ok: false,
      code,
      status,
    });
  });

  it("has frontend-authored copy for every stable tagging code", () => {
    for (const code of TAGGING_ADMIN_ERROR_CODES) {
      expect(errorEnvelopeCopy({ ok: false, status: 409, code })).not.toBe("操作失败，请稍后重试");
    }
  });
});

function authDependencies(input: { role: string; twoFactorCompleted: boolean }) {
  const identity: AdminIdentity = {
    id: "admin-1",
    username: "admin",
    role: input.role,
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
    absoluteExpiresAt: new Date(issuedAt.getTime() + ADMIN_ABSOLUTE_TIMEOUT_MS),
    twoFactorCompletedAt: input.twoFactorCompleted ? new Date(NOW.getTime() - 60_000) : null,
    revokedAt: null,
  };
  const identities: AdminIdentityStore = {
    async findById(id) { return id === identity.id ? identity : null; },
    async findByNormalizedUsername() { return null; },
  };
  const sessions: SessionStore = {
    async findByTokenHash(tokenHash) { return tokenHash === session.tokenHash ? session : null; },
    async create() {},
    async touchLastSeen() { return true; },
    async revoke() { return true; },
  };
  return {
    identities,
    sessions,
    registry: P2_04_ADMIN_REGISTRY,
    now: NOW,
    env: {} as NodeJS.ProcessEnv,
  };
}

describe("P2-06.5 tag:manage route guard", () => {
  const request = {
    pathname: "/api/admin/canonical-tags",
    method: "PUT",
    sessionToken: TOKEN,
    origin: ORIGIN,
    canonicalOrigin: ORIGIN,
    requestId: REQUEST_ID,
  };

  it("keeps tag:manage defaulted to super_admin and requires 2FA", () => {
    expect(ADMIN_CAPABILITY_CONFIG["tag:manage"]).toMatchObject({
      defaultRoles: ["super_admin"],
      requiresTwoFactor: true,
    });
  });

  it("rejects a non-authorized identity even after 2FA", async () => {
    await expect(requireAdminRouteAccess(
      request,
      authDependencies({ role: "editor", twoFactorCompleted: true }),
    )).rejects.toMatchObject({ code: "admin_capability_denied", status: 403 });
  });

  it("rejects super_admin until the current session completes 2FA", async () => {
    await expect(requireAdminRouteAccess(
      request,
      authDependencies({ role: "super_admin", twoFactorCompleted: false }),
    )).rejects.toMatchObject({ code: "admin_two_factor_required", status: 403 });
  });

  it("issues the write-bound ticket only after capability and 2FA pass", async () => {
    await expect(requireAdminRouteAccess(
      request,
      authDependencies({ role: "super_admin", twoFactorCompleted: true }),
    )).resolves.toMatchObject({
      serviceAuthorization: {
        capability: "tag:manage",
        entryId: "admin.api.canonical_tag.write",
        requestId: REQUEST_ID,
      },
    });
  });
});
