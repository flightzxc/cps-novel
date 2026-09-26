import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { parseSitemapArgs, runSitemapCli } from "../../../scripts/generate-static-sitemaps";
import { requestAuditedSitemapRefresh } from "@/server/sitemap-admin/service";

describe("sitemap CLI and gates", () => {
  it("defaults to dry-run and refuses ambiguous or incomplete apply commands", () => {
    expect(parseSitemapArgs([]).apply).toBe(false);
    expect(() => parseSitemapArgs(["--apply"])).toThrow();
    expect(() => parseSitemapArgs(["--apply", "--dry-run", "--reason", "test"])).toThrow();
    expect(() => parseSitemapArgs(["--generate"])).toThrow();
  });
  it.each([
    {}, { FEATURE_SITEMAP_AUTO_REFRESH: "true" }, { SITEMAP_AUTO_REFRESH_ALLOW_WRITE: "true" },
  ])("fails closed without both gates before any database transaction", async (env) => {
    const transaction = vi.fn();
    const db = { $transaction: transaction } as unknown as PrismaClient;
    expect(await requestAuditedSitemapRefresh({ actorType: "system", actorId: "cli", requestId: "r", reason: "test" }, db, { ...env, NODE_ENV: "test" })).toEqual({ status: "disabled" });
    expect(transaction).not.toHaveBeenCalled();
  });
  it("refuses apply on elevated roles before writes", async () => {
    const transaction = vi.fn();
    const db = { $queryRaw: vi.fn().mockResolvedValue([{ role: "migration_owner" }]), $transaction: transaction } as unknown as PrismaClient;
    await expect(runSitemapCli(db, parseSitemapArgs(["--apply", "--reason", "test"]))).rejects.toThrow("web_app");
    expect(transaction).not.toHaveBeenCalled();
  });
});
