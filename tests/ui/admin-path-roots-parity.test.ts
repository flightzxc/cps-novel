import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { ADMIN_HOST_PATH_ROOTS } from "@/lib/site/admin-origin";
import { ADMIN_PAGE_ROOTS } from "@/server/auth/registry";

/**
 * RC-9: `scripts/lib/admin-path-roots.json` is the nginx defense-in-depth
 * layer's copy of the admin path list — used by
 * `infra/production-like/nginx/full.conf.template`'s two admin-path
 * `location` regexes (deny it on the public server, allow it on the admin
 * server). It is authored by hand rather than generated at render time, so
 * this test is the only thing standing between it and silently drifting
 * away from `ADMIN_PAGE_ROOTS` (the app-layer single source, also consumed
 * by `src/lib/site/admin-origin.ts`'s `isAdminPath`).
 */

const root = resolve(import.meta.dirname, "../..");
const adminPathRootsJson = JSON.parse(
  readFileSync(resolve(root, "scripts/lib/admin-path-roots.json"), "utf8"),
) as { pageRoots: string[]; apiNamespace: string };
const fullNginxTemplate = readFileSync(
  resolve(root, "infra/production-like/nginx/full.conf.template"),
  "utf8",
);

const jsonAdminPaths = new Set([...adminPathRootsJson.pageRoots, adminPathRootsJson.apiNamespace]);

describe("scripts/lib/admin-path-roots.json parity", () => {
  it("is exactly ADMIN_PAGE_ROOTS plus /login, /two-factor, and /api/admin", () => {
    expect(Array.isArray(adminPathRootsJson.pageRoots)).toBe(true);
    expect(adminPathRootsJson.apiNamespace).toBe("/api/admin");
    expect(jsonAdminPaths).toEqual(new Set([...ADMIN_PAGE_ROOTS, "/login", "/two-factor", "/api/admin"]));
  });

  it("matches src/lib/site/admin-origin.ts's own ADMIN_HOST_PATH_ROOTS (the proxy's single source)", () => {
    expect(jsonAdminPaths).toEqual(new Set(ADMIN_HOST_PATH_ROOTS));
  });

  it("every ADMIN_PAGE_ROOTS entry (plus /login and /two-factor) appears literally in the nginx admin-path regex", () => {
    for (const root of [...ADMIN_PAGE_ROOTS, "/login", "/two-factor"]) {
      const bareSegment = root.slice(1); // "/dashboard" -> "dashboard"
      expect(fullNginxTemplate, bareSegment).toContain(bareSegment);
    }
    expect(fullNginxTemplate).toContain("/api/admin");
  });
});
