import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { P2_04_ADMIN_REGISTRY } from "@/app/api/admin/_lib/registry";
import { resolveAdminAction, resolveAdminRoute } from "@/server/auth/registry";
import { P1_08B_ADMIN_REGISTRY } from "@/server/credentials";

const EXPECTED_GET_ROUTES = [
  "/api/admin/channel-accounts",
  "/api/admin/credential-tasks/status",
  "/api/admin/credentials/metadata",
] as const;

/**
 * P2-04 read routes, registered on top of P1-08B rather than inside it.
 *
 * The filesystem scan below covers all of `src/app/api/admin`, so it necessarily
 * sees every phase's routes; the registry it compares against therefore has to
 * be the composed one the app actually resolves with
 * (`P2_04_ADMIN_REGISTRY`). The P1-08B-specific assertions further down stay
 * scoped to `P1_08B_ADMIN_REGISTRY.routes`, so this file still guards the
 * credential surface exactly as before.
 */
const EXPECTED_CONTENT_GET_ROUTES = [
  "/api/admin/novels",
  "/api/admin/novels/chapters",
  "/api/admin/novels/chapters/content",
  "/api/admin/novels/detail",
  "/api/admin/tags",
  "/api/admin/site-settings",
] as const;

const EXPECTED_TASK_ROUTES = [
  { path: "/api/admin/tasks", methods: ["GET"] },
  { path: "/api/admin/tasks/detail", methods: ["GET"] },
  { path: "/api/admin/tasks/items", methods: ["GET"] },
  { path: "/api/admin/tasks/retry-failed", methods: ["POST"] },
  { path: "/api/admin/tasks/manual-reviews", methods: ["GET"] },
  { path: "/api/admin/tasks/manual-reviews/resolve", methods: ["POST"] },
  { path: "/api/admin/promo-links", methods: ["GET"] },
] as const;

const EXPECTED_ACTIONS = [
  "admin.channel_account.create",
  "admin.channel_account.disable",
  "admin.channel_account.enable",
  "admin.credential.replace",
  "admin.credential.validate",
  "admin.credential.supersede",
] as const;

async function routeHandlers(directory: string): Promise<Array<{ path: string; methods: string[] }>> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return routeHandlers(target);
    if (entry.name !== "route.ts") return [];
    const source = await readFile(target, "utf8");
    const methods = [...source.matchAll(/export async function (GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/g)]
      .map((match) => match[1]);
    if (methods.length === 0) return [];
    const relative = path.relative(path.resolve(process.cwd(), "src/app"), target);
    return [{
      path: `/${relative.replace(/\/route\.ts$/, "").split(path.sep).join("/")}`,
      methods: methods.sort(),
    }];
  }));
  return nested.flat();
}

describe("P1-09 Admin registry parity", () => {
  it("registers every real Handler with its exact method and no route without a Handler", async () => {
    const actual = (await routeHandlers(path.resolve(process.cwd(), "src/app/api/admin")))
      .sort((left, right) => left.path.localeCompare(right.path));
    const expected = [
      ...EXPECTED_GET_ROUTES.map((routePath) => ({ path: routePath, methods: ["GET"] })),
      ...EXPECTED_CONTENT_GET_ROUTES.map((routePath) => ({ path: routePath, methods: ["GET"] })),
      ...EXPECTED_TASK_ROUTES.map((route) => ({ path: route.path, methods: [...route.methods] })),
    ].sort((left, right) => left.path.localeCompare(right.path));
    const registered = P2_04_ADMIN_REGISTRY.routes
      .map((route) => ({ path: route.path, methods: [...route.methods].sort() }))
      .sort((left, right) => left.path.localeCompare(right.path));
    expect(actual).toEqual(expected);
    expect(registered).toEqual(actual);
    for (const route of P1_08B_ADMIN_REGISTRY.routes) {
      expect(route.methods).toEqual(["GET"]);
      expect(route.capability).toBe("credential:manage");
      expect(resolveAdminRoute(route.path, "GET", P2_04_ADMIN_REGISTRY)).not.toBeNull();
    }
    for (const route of EXPECTED_TASK_ROUTES) {
      expect(resolveAdminRoute(route.path, route.methods[0], P2_04_ADMIN_REGISTRY)).toMatchObject({
        capability: "task:manage",
        methods: route.methods,
      });
    }
  });

  it("registers exactly the six credential mutations as Server Actions", async () => {
    expect(P1_08B_ADMIN_REGISTRY.actions.map((action) => action.id)).toEqual(EXPECTED_ACTIONS);
    const actionSource = await readFile(
      path.resolve(process.cwd(), "src/app/(admin)/channel-accounts/_actions.ts"),
      "utf8",
    );
    for (const actionId of EXPECTED_ACTIONS) {
      expect(resolveAdminAction(actionId, P1_08B_ADMIN_REGISTRY)).toMatchObject({
        capability: "credential:manage",
        mutation: true,
      });
      expect(actionSource).toContain(actionId);
    }
    const serviceSource = await readFile(
      path.resolve(process.cwd(), "src/server/credentials/service.ts"),
      "utf8",
    );
    expect(serviceSource).not.toContain("admin.api.");
  });

  it("keeps mutation routes unregistered and default-denied", () => {
    const mutationPaths = [
      "/api/admin/channel-accounts/create",
      "/api/admin/channel-accounts/disable",
      "/api/admin/channel-accounts/enable",
      "/api/admin/credentials/replace",
      "/api/admin/credentials/validate",
      "/api/admin/credentials/supersede",
    ];
    for (const pathname of mutationPaths) {
      expect(resolveAdminRoute(pathname, "POST", P1_08B_ADMIN_REGISTRY)).toBeNull();
    }
  });
});
