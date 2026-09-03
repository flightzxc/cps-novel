import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { getSiteUrl } from "@/lib/seo/site-url";

/**
 * RC-8: pulsenovels.com is frozen (2026-09-03, Owner) as the single production
 * site origin. This test does not change getSiteUrl's fail-fast contract --
 * `.env.example`'s SITE_URL line stays empty on purpose (see
 * docs/operations/PRODUCTION_DOMAIN_2026-09-03.md). It only pins that the
 * documented production example, once fed through the same resolver every
 * consumer uses, resolves to exactly https://pulsenovels.com, so the frozen
 * value cannot silently drift from what operators are told to set.
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
