import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

vi.mock("@prisma/client", () => ({ PrismaClient: vi.fn(function () { return {}; }) }));
vi.mock("next/headers", () => ({ cookies: vi.fn() }));
const state = globalThis as unknown as { webPrisma?: unknown };
afterEach(() => { delete state.webPrisma; vi.unstubAllEnvs(); vi.resetModules(); vi.clearAllMocks(); });

describe("web Prisma pool", () => {
  it.each(["production", "development"])("shares public/admin instances across module reloads in %s", async (mode) => {
    vi.stubEnv("NODE_ENV", mode);
    const publicDeps = await import("@/app/_lib/public-deps");
    vi.resetModules();
    const adminDeps = await import("@/app/api/admin/_lib/deps");
    expect(adminDeps.prisma).toBe(publicDeps.prisma);
  });
  it("keeps the neutral and public entrypoints free of admin and credential dependencies", () => {
    for (const path of ["src/lib/db/web-prisma.ts", "src/app/_lib/public-deps.ts"]) {
      const source = readFileSync(path, "utf8");
      expect(source).not.toMatch(/from ["'][^"']*(?:admin|auth|credentials|worker|scheduler)/);
      expect(source).not.toContain("datasources:");
    }
  });
});
