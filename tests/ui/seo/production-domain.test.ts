import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { getSiteUrl } from "@/lib/seo/site-url";
import { resolveAdminHost } from "@/lib/site/admin-origin";

/**
 * RC-8: pulsenovels.com is frozen (2026-09-03, Owner) as the single production
 * site origin. This test does not change getSiteUrl's fail-fast contract --
 * `.env.example`'s SITE_URL line stays empty on purpose (see
 * docs/operations/PRODUCTION_DOMAIN_2026-09-03.md). It only pins that the
 * documented production example, once fed through the same resolver every
 * consumer uses, resolves to exactly https://pulsenovels.com, so the frozen
 * value cannot silently drift from what operators are told to set.
 *
 * RC-9 (2026-09-03, Owner): admin-host isolation adds the same guard for
 * `ADMIN_CANONICAL_ORIGIN` -- its documented production example must resolve
 * to a distinct host (`zbcwf.pulsenovels.com`), not the same host as
 * `SITE_URL`. `src/proxy.ts` fails closed if the two ever collide in
 * production; this test only pins what operators are told to set.
 */

const root = resolve(import.meta.dirname, "../../..");
const envExample = readFileSync(resolve(root, ".env.example"), "utf8");

describe("production domain freeze (RC-8)", () => {
  it("documents SITE_URL's production example as https://pulsenovels.com in .env.example", () => {
    const match = envExample.match(
      /^# Production origin is frozen \([^)]*\): SITE_URL=(\S+)$/m,
    );
    expect(match, ".env.example must document the frozen production SITE_URL example").not.toBeNull();

    const documentedExample = match![1];
    expect(getSiteUrl({ SITE_URL: documentedExample })).toBe("https://pulsenovels.com");
  });

  it("keeps the actual SITE_URL= assignment empty (fail-fast, no default)", () => {
    expect(envExample).toMatch(/^SITE_URL=$/m);
  });
});

describe("admin-host isolation (RC-9)", () => {
  it("documents ADMIN_CANONICAL_ORIGIN's production example as https://zbcwf.pulsenovels.com in .env.example", () => {
    const match = envExample.match(
      /^# Production admin origin is frozen \([^)]*\): ADMIN_CANONICAL_ORIGIN=(\S+)$/m,
    );
    expect(match, ".env.example must document the frozen production ADMIN_CANONICAL_ORIGIN example").not.toBeNull();

    const documentedExample = match![1];
    expect(resolveAdminHost(documentedExample)).toEqual({ ok: true, host: "zbcwf.pulsenovels.com" });
  });

  it("resolves ADMIN_CANONICAL_ORIGIN's documented host to a different host than SITE_URL's", () => {
    const siteMatch = envExample.match(/^# Production origin is frozen \([^)]*\): SITE_URL=(\S+)$/m);
    const adminMatch = envExample.match(
      /^# Production admin origin is frozen \([^)]*\): ADMIN_CANONICAL_ORIGIN=(\S+)$/m,
    );
    expect(siteMatch).not.toBeNull();
    expect(adminMatch).not.toBeNull();

    const siteHost = new URL(getSiteUrl({ SITE_URL: siteMatch![1] })).hostname;
    const adminHost = resolveAdminHost(adminMatch![1]);
    expect(adminHost.ok).toBe(true);
    expect(adminHost.ok && adminHost.host).not.toBe(siteHost);
  });

  it("keeps the actual ADMIN_CANONICAL_ORIGIN= assignment empty (fail-fast, no default)", () => {
    expect(envExample).toMatch(/^ADMIN_CANONICAL_ORIGIN=$/m);
  });
});
