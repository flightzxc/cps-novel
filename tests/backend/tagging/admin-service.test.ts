import { describe, expect, it } from "vitest";

import {
  normalizeCanonicalTagGet,
  normalizeSourceLabelMappingGet,
} from "@/server/tagging";
import { hasAdminCapability } from "@/lib/auth/capabilities";
import { isTagAdminWriteEnabled } from "@/lib/flags/feature-flags";

const uuid = "550e8400-e29b-41d4-a716-446655440000";

describe("P2-06.5 Admin Tag contracts", () => {
  it("normalizes bounded list queries and keeps exact mapping identities unchanged", () => {
    expect(normalizeCanonicalTagGet({ page: "2", pageSize: "25", search: " romance ", active: "active" }))
      .toEqual({ mode: "list", page: 2, pageSize: 25, offset: 25, search: "romance", active: "active" });
    expect(normalizeSourceLabelMappingGet({
      channelAppId: uuid,
      canonicalTagId: uuid,
      rawLanguageScope: " language:number:2 ",
      rawToken: " Fantasy ",
    })).toMatchObject({
      mode: "list",
      rawLanguageScope: " language:number:2 ",
      rawToken: " Fantasy ",
    });
  });

  it("keeps detail mode exclusive and rejects malformed pagination", () => {
    expect(normalizeCanonicalTagGet({ id: uuid })).toEqual({ mode: "detail", id: uuid });
    expect(() => normalizeCanonicalTagGet({ id: uuid, page: 1 })).toThrowError(expect.objectContaining({
      code: "invalid_tag_request",
      status: 400,
    }));
    expect(() => normalizeCanonicalTagGet({ pageSize: 101 })).toThrowError(expect.objectContaining({
      code: "invalid_tag_request",
    }));
    expect(() => normalizeSourceLabelMappingGet({ rawToken: "" })).toThrowError(expect.objectContaining({
      code: "invalid_tag_request",
    }));
  });

  it("registers tag:manage as a 2FA-protected super-admin capability", () => {
    const identity = (id: string, role: string) => ({
      id,
      username: id,
      role,
      status: "active" as const,
      sessionVersion: 1,
      twoFactorEnabled: true,
    });
    const superAdmin = { identity: identity("admin-1", "super_admin") };
    const viewer = { identity: identity("viewer-1", "viewer") };
    expect(hasAdminCapability(superAdmin, "tag:manage", { ...process.env })).toBe(true);
    expect(hasAdminCapability(viewer, "tag:manage", { ...process.env })).toBe(false);
    expect(hasAdminCapability(viewer, "tag:manage", {
      ...process.env,
      TAG_MANAGE_USER_IDS: "viewer-1",
    })).toBe(true);
  });

  it("parses the Admin write gate by exact true only", () => {
    expect(isTagAdminWriteEnabled({ ...process.env, FEATURE_P2_06_5_TAG_ADMIN_WRITE: "true" })).toBe(true);
    for (const value of ["TRUE", "1", "yes", " true ", undefined]) {
      expect(isTagAdminWriteEnabled({ ...process.env, FEATURE_P2_06_5_TAG_ADMIN_WRITE: value })).toBe(false);
    }
  });
});
