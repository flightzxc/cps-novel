import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { resolveAdminAction, resolveAdminRoute } from "@/server/auth/registry";
import { P1_08B_ADMIN_REGISTRY } from "@/server/credentials";

const EXPECTED_GET_ROUTES = [
  "/api/admin/channel-accounts",
  "/api/admin/credential-tasks/status",
  "/api/admin/credentials/metadata",
] as const;

const EXPECTED_ACTIONS = [
  "admin.channel_account.create",
  "admin.channel_account.disable",
  "admin.channel_account.enable",
  "admin.credential.replace",
  "admin.credential.validate",
  "admin.credential.supersede",
] as const;

async function routeHandlers(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return routeHandlers(target);
    if (entry.name !== "route.ts") return [];
    const source = await readFile(target, "utf8");
    if (!/export async function (?:GET|HEAD|OPTIONS)\b/.test(source)) return [];
    const relative = path.relative(path.resolve(process.cwd(), "src/app"), target);
    return [`/${relative.replace(/\/route\.ts$/, "").split(path.sep).join("/")}`];
  }));
  return nested.flat();
}

describe("P1-09 Admin registry parity", () => {
  it("registers every real GET Handler and no route without a Handler", async () => {
    const actual = (await routeHandlers(path.resolve(process.cwd(), "src/app/api/admin"))).sort();
    const registered = P1_08B_ADMIN_REGISTRY.routes.map((route) => route.path).sort();
    expect(actual).toEqual([...EXPECTED_GET_ROUTES].sort());
    expect(registered).toEqual(actual);
    for (const route of P1_08B_ADMIN_REGISTRY.routes) {
      expect(route.methods).toEqual(["GET"]);
      expect(route.capability).toBe("credential:manage");
      expect(resolveAdminRoute(route.path, "GET", P1_08B_ADMIN_REGISTRY)).not.toBeNull();
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
