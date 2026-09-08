import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  ARTICLE_SEO_VISIBILITY_FEATURE_FLAG,
  isArticleSeoVisibilityEnabled,
} from "@/lib/flags/feature-flags";

/**
 * C-25 (`规划_文章管理能力补齐_博客类型可见性换小说_2026-09-08.md` §三/C-25):
 * "开关登记（五处，缺一不可）" — this repo has a documented history of a flag's
 * *semantics* being written up without ever reaching the actual runtime
 * configuration (PR6 fix lane F: `FEATURE_P2_06_5_TAGGING` and its three
 * siblings were zero-hit across `docker-compose.yml`/`.env.example`/
 * `scripts/lib/x8-levels.json` for a full round before that fix — see
 * `./tagging-flags-passthrough.test.ts`, whose shape this file follows).
 * This is the same static-registration check for `FEATURE_ARTICLE_SEO_VISIBILITY`,
 * covering exactly the five places the analysis doc's C-25 section requires:
 *
 *   1. `src/lib/flags/feature-flags.ts` — the constant + reader function.
 *   2. `docs/governance/feature-flag-registry.md` — the table row.
 *   3. `scripts/lib/x8-levels.json` — Level 0/UAT/R.
 *   4. `docs/p2/V020_RELEASE_CHECKLIST.md` §3 Level 0 — the checkbox item.
 *   5. `.env.example` + `docker-compose.yml`'s `web` service — the runtime
 *      passthrough (deliberately web-only: this flag only gates public-site
 *      *reads*, and worker/scheduler have no public-site read path to gate,
 *      per the analysis doc's own "worker/scheduler 不消费本开关，不接").
 */
const root = resolve(import.meta.dirname, "../../..");

describe("C-25: FEATURE_ARTICLE_SEO_VISIBILITY is registered in all five required places", () => {
  it("1. src/lib/flags/feature-flags.ts: exact `=== \"true\"` parsing, default off", () => {
    // `as unknown as NodeJS.ProcessEnv`: same convention as this repo's other
    // env-override tests (e.g. `tests/ui/admin-two-factor-enforcement-switch.test.ts`)
    // — Next.js's global augmentation makes `NodeJS.ProcessEnv` require
    // `NODE_ENV`, which a plain single-key test literal never carries.
    const env = (value?: string) =>
      (value === undefined ? {} : { FEATURE_ARTICLE_SEO_VISIBILITY: value }) as unknown as NodeJS.ProcessEnv;
    expect(ARTICLE_SEO_VISIBILITY_FEATURE_FLAG).toBe("FEATURE_ARTICLE_SEO_VISIBILITY");
    expect(isArticleSeoVisibilityEnabled(env())).toBe(false);
    expect(isArticleSeoVisibilityEnabled(env("false"))).toBe(false);
    expect(isArticleSeoVisibilityEnabled(env("TRUE"))).toBe(false); // exact match, not case-insensitive
    expect(isArticleSeoVisibilityEnabled(env("true"))).toBe(true);
  });

  it("2. docs/governance/feature-flag-registry.md documents the flag and its single-gate rationale", () => {
    const registry = readFileSync(resolve(root, "docs/governance/feature-flag-registry.md"), "utf8");
    expect(registry).toContain("FEATURE_ARTICLE_SEO_VISIBILITY");
    // The registry's own discipline is "一 flag 一函数、双闸" for every
    // *protected write* pair above this row -- this flag is deliberately the
    // one row that is NOT a pair, so the doc must say why (else a future
    // reviewer reads "only one flag" as a missed second gate, exactly the
    // failure mode the analysis doc warns about).
    expect(registry).toMatch(/FEATURE_ARTICLE_SEO_VISIBILITY[\s\S]{0,2000}single gate/i);
  });

  it("3. scripts/lib/x8-levels.json: false at Level 0, true at Level UAT, false at Level R (pending Owner approval)", () => {
    const levels = JSON.parse(readFileSync(resolve(root, "scripts/lib/x8-levels.json"), "utf8")) as Record<
      string,
      { flags: Record<string, string> }
    >;
    expect(levels["0"].flags.FEATURE_ARTICLE_SEO_VISIBILITY).toBe("false");
    expect(levels.uat.flags.FEATURE_ARTICLE_SEO_VISIBILITY).toBe("true");
    expect(levels.r.flags.FEATURE_ARTICLE_SEO_VISIBILITY).toBe("false");
  });

  it("4. docs/p2/V020_RELEASE_CHECKLIST.md §3 Level 0 carries a checkbox for the flag, wording matching x8-levels.json", () => {
    const checklist = readFileSync(resolve(root, "docs/p2/V020_RELEASE_CHECKLIST.md"), "utf8");
    const level0Section = checklist.slice(
      checklist.indexOf("### Level 0："),
      checklist.indexOf("### Level UAT："),
    );
    expect(level0Section).toContain("FEATURE_ARTICLE_SEO_VISIBILITY=false");
  });

  describe("5. .env.example + docker-compose.yml's web service", () => {
    const envExample = readFileSync(resolve(root, ".env.example"), "utf8");
    const compose = readFileSync(resolve(root, "docker-compose.yml"), "utf8");

    /**
     * Same service-block slicer as `./tagging-flags-passthrough.test.ts`'s
     * `serviceBlock` — relies on this file's existing two-space-per-level
     * indentation so an assertion below can never accidentally match a
     * same-named var in a different service.
     */
    function serviceBlock(serviceName: string): string {
      const marker = `\n  ${serviceName}:\n`;
      const start = compose.indexOf(marker);
      if (start === -1) throw new Error(`service "${serviceName}" not found in docker-compose.yml`);
      const rest = compose.slice(start + marker.length);
      const nextServiceHeader = rest.match(/\n {2}[a-zA-Z][\w-]*:\n/);
      return rest.slice(0, nextServiceHeader ? nextServiceHeader.index : undefined);
    }

    it(".env.example documents the flag with its default", () => {
      expect(envExample).toContain("FEATURE_ARTICLE_SEO_VISIBILITY=false");
    });

    it("docker-compose.yml passes the flag to web with the exact fail-closed default", () => {
      expect(serviceBlock("web")).toContain(
        "FEATURE_ARTICLE_SEO_VISIBILITY: ${FEATURE_ARTICLE_SEO_VISIBILITY:-false}",
      );
    });

    it("docker-compose.yml does NOT pass the flag to worker or scheduler (they have no public-site read path)", () => {
      expect(serviceBlock("worker")).not.toContain("FEATURE_ARTICLE_SEO_VISIBILITY");
      expect(serviceBlock("scheduler")).not.toContain("FEATURE_ARTICLE_SEO_VISIBILITY");
    });
  });
});
