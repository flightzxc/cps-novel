import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  ARTICLE_BLOG_ALLOW_WRITE_FLAG,
  ARTICLE_BLOG_FEATURE_FLAG,
  isArticleBlogEnabled,
  isArticleBlogWriteAllowed,
} from "@/lib/flags/feature-flags";

/**
 * C-28 (`规划_文章管理能力补齐_博客类型可见性换小说_2026-09-08.md` §三/C-28):
 * "开关登记（五处，缺一不可）" — same shape as
 * `./seo-visibility-flags-passthrough.test.ts` (C-25) and
 * `./tagging-flags-passthrough.test.ts` (PR6 fix lane F), covering exactly
 * the five places the plan's registration discipline requires:
 *
 *   1. `src/lib/flags/feature-flags.ts` — the two constants + reader
 *      functions.
 *   2. `docs/governance/feature-flag-registry.md` — the two table rows.
 *   3. `scripts/lib/x8-levels.json` — `false`/`false` at every level (0/uat/r
 *      — this capability has no Owner-approved open-the-gate step yet).
 *   4. `docs/p2/V020_RELEASE_CHECKLIST.md` §3 Level 0 — the checkbox line.
 *   5. `.env.example` + `docker-compose.yml`'s `web` service (both flags),
 *      PLUS `docker-compose.yml`'s `worker` service (`FEATURE_ARTICLE_BLOG`
 *      only, as of C-29 below).
 *
 * REVISED at C-29 (`规划_文章管理能力补齐_博客类型可见性换小说_2026-09-08.md`
 * §三/C-29): this file's original claim — that the whole pair is web-only,
 * "unlike `FEATURE_ARTICLE_SEO_VISIBILITY`'s worker-side sitemap/IndexNow
 * handlers" — no longer holds for `FEATURE_ARTICLE_BLOG` alone.
 * `src/lib/seo/sitemap.ts`'s `createSitemapFamilyBuilder` now reads
 * `isArticleBlogEnabled(env)` to decide whether to emit the `blogpage`
 * sitemap family at all (`env` defaults to `process.env`, so
 * `worker/handlers/sitemap-refresh.ts`'s call site reads the WORKER
 * process's own copy) — the exact same worker-consumption shape
 * `FEATURE_ARTICLE_SEO_VISIBILITY` already has, and it required the exact
 * same fix: `docker-compose.yml`'s `worker` service block now carries
 * `FEATURE_ARTICLE_BLOG` too. `ARTICLE_BLOG_ALLOW_WRITE` is UNCHANGED and
 * stays genuinely web-only (the worker never performs the blog write, only
 * reads the sibling flag to gate sitemap emission) — this file's §5/
 * consumers assertions below now check each flag's OWN worker footprint
 * separately instead of treating the pair as one unit.
 */
const root = resolve(import.meta.dirname, "../../..");

describe("C-28/C-29: FEATURE_ARTICLE_BLOG / ARTICLE_BLOG_ALLOW_WRITE are registered in all required places", () => {
  it("1. src/lib/flags/feature-flags.ts: exact `=== \"true\"` parsing, default off, for both flags", () => {
    const env = (values: Record<string, string | undefined>) =>
      values as unknown as NodeJS.ProcessEnv;
    expect(ARTICLE_BLOG_FEATURE_FLAG).toBe("FEATURE_ARTICLE_BLOG");
    expect(ARTICLE_BLOG_ALLOW_WRITE_FLAG).toBe("ARTICLE_BLOG_ALLOW_WRITE");

    expect(isArticleBlogEnabled(env({}))).toBe(false);
    expect(isArticleBlogEnabled(env({ FEATURE_ARTICLE_BLOG: "false" }))).toBe(false);
    expect(isArticleBlogEnabled(env({ FEATURE_ARTICLE_BLOG: "TRUE" }))).toBe(false); // exact match, not case-insensitive
    expect(isArticleBlogEnabled(env({ FEATURE_ARTICLE_BLOG: "true" }))).toBe(true);

    expect(isArticleBlogWriteAllowed(env({}))).toBe(false);
    expect(isArticleBlogWriteAllowed(env({ ARTICLE_BLOG_ALLOW_WRITE: "false" }))).toBe(false);
    expect(isArticleBlogWriteAllowed(env({ ARTICLE_BLOG_ALLOW_WRITE: "true" }))).toBe(true);
  });

  it("2. docs/governance/feature-flag-registry.md documents both flags and each flag's own worker-footprint rationale", () => {
    const registry = readFileSync(resolve(root, "docs/governance/feature-flag-registry.md"), "utf8");
    expect(registry).toContain("FEATURE_ARTICLE_BLOG");
    expect(registry).toContain("ARTICLE_BLOG_ALLOW_WRITE");
    // ARTICLE_BLOG_ALLOW_WRITE is still the one that needs the "why is this
    // web-only" note (C-25's single-gate row precedent, mirrored).
    expect(registry).toMatch(/ARTICLE_BLOG_ALLOW_WRITE[\s\S]{0,600}web-only/i);
    // FEATURE_ARTICLE_BLOG needs the mirror-image note as of C-29: it is
    // explicitly NOT web-only anymore.
    expect(registry).toMatch(/FEATURE_ARTICLE_BLOG[\s\S]{0,600}NOT web-only/i);
  });

  it("3. scripts/lib/x8-levels.json: false/false at every level (0/uat/r) — no Owner-approved open-the-gate step yet", () => {
    const levels = JSON.parse(readFileSync(resolve(root, "scripts/lib/x8-levels.json"), "utf8")) as Record<
      string,
      { flags: Record<string, string> }
    >;
    for (const level of ["0", "uat", "r"]) {
      expect(levels[level]!.flags.FEATURE_ARTICLE_BLOG).toBe("false");
      expect(levels[level]!.flags.ARTICLE_BLOG_ALLOW_WRITE).toBe("false");
    }
  });

  it("4. docs/p2/V020_RELEASE_CHECKLIST.md §3 Level 0 carries a checkbox for both flags, wording matching x8-levels.json", () => {
    const checklist = readFileSync(resolve(root, "docs/p2/V020_RELEASE_CHECKLIST.md"), "utf8");
    const level0Section = checklist.slice(
      checklist.indexOf("### Level 0："),
      checklist.indexOf("### Level UAT："),
    );
    expect(level0Section).toContain("FEATURE_ARTICLE_BLOG=false");
    expect(level0Section).toContain("ARTICLE_BLOG_ALLOW_WRITE=false");
  });

  describe("5. .env.example + docker-compose.yml passthrough", () => {
    const envExample = readFileSync(resolve(root, ".env.example"), "utf8");
    const compose = readFileSync(resolve(root, "docker-compose.yml"), "utf8");

    /** Same service-block slicer as `./seo-visibility-flags-passthrough.test.ts`'s own. */
    function serviceBlock(serviceName: string): string {
      const marker = `\n  ${serviceName}:\n`;
      const start = compose.indexOf(marker);
      if (start === -1) throw new Error(`service "${serviceName}" not found in docker-compose.yml`);
      const rest = compose.slice(start + marker.length);
      const nextServiceHeader = rest.match(/\n {2}[a-zA-Z][\w-]*:\n/);
      return rest.slice(0, nextServiceHeader ? nextServiceHeader.index : undefined);
    }

    it(".env.example documents both flags with their default", () => {
      expect(envExample).toContain("FEATURE_ARTICLE_BLOG=false");
      expect(envExample).toContain("ARTICLE_BLOG_ALLOW_WRITE=false");
    });

    it("docker-compose.yml passes both flags to web with the exact fail-closed default", () => {
      expect(serviceBlock("web")).toContain("FEATURE_ARTICLE_BLOG: ${FEATURE_ARTICLE_BLOG:-false}");
      expect(serviceBlock("web")).toContain("ARTICLE_BLOG_ALLOW_WRITE: ${ARTICLE_BLOG_ALLOW_WRITE:-false}");
    });

    it("C-29: docker-compose.yml ALSO passes FEATURE_ARTICLE_BLOG to worker (sitemap blog family gate)", () => {
      expect(serviceBlock("worker")).toContain("FEATURE_ARTICLE_BLOG: ${FEATURE_ARTICLE_BLOG:-false}");
    });

    it("docker-compose.yml does NOT pass ARTICLE_BLOG_ALLOW_WRITE to worker or scheduler — the worker never performs the blog write", () => {
      expect(serviceBlock("worker")).not.toContain("ARTICLE_BLOG_ALLOW_WRITE");
      expect(serviceBlock("scheduler")).not.toContain("ARTICLE_BLOG_ALLOW_WRITE");
    });

    it("docker-compose.yml does NOT pass either flag to scheduler — enqueue-only, no read or write path to gate", () => {
      expect(serviceBlock("scheduler")).not.toContain("FEATURE_ARTICLE_BLOG");
      expect(serviceBlock("scheduler")).not.toContain("ARTICLE_BLOG_ALLOW_WRITE");
    });
  });

  it("consumers: isArticleBlogWriteAllowed has zero occurrences under worker/ or scheduler/ (unchanged since C-28 — grepped before adding any C-29 code)", async () => {
    const { readFile, readdir } = await import("node:fs/promises");
    const path = await import("node:path");
    async function collect(dir: string): Promise<string[]> {
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
      const nested = await Promise.all(
        entries.map(async (entry) => {
          const target = path.join(dir, entry.name);
          if (entry.isDirectory()) return collect(target);
          if (![".ts", ".tsx"].includes(path.extname(entry.name))) return [];
          return [target];
        }),
      );
      return nested.flat();
    }
    const files = [...(await collect(resolve(root, "worker"))), ...(await collect(resolve(root, "scheduler")))];
    for (const file of files) {
      const source = await readFile(file, "utf8");
      expect(source, file).not.toMatch(/isArticleBlogWriteAllowed/);
    }
  });

  it("consumers (C-29): worker/handlers/sitemap-refresh.ts's dependency chain reaches isArticleBlogEnabled indirectly, via createSitemapFamilyBuilder — this is intentional, NOT a direct-import claim like the write-gate check above", () => {
    // Direct grep under worker/ would find nothing for `isArticleBlogEnabled`
    // (the handler only imports `createSitemapFamilyBuilder` from
    // `src/lib/seo/sitemap.ts`, which lives outside `worker/`), so a
    // literal-string absence assertion here would be true but MISLEADING —
    // it would look identical to genuine non-consumption. The actual
    // behavioral proof that FEATURE_ARTICLE_BLOG gates the worker's sitemap
    // output lives in `tests/backend/seo/sitemap-blog.test.ts` (flag-off ->
    // zero blogpage files even with eligible candidates in the DB). This
    // test only pins the textual wiring point so a future refactor that
    // removes the `createSitemapFamilyBuilder` call from the handler (and
    // silently drops the flag dependency with it) is caught here too.
    const handlerSource = readFileSync(
      resolve(root, "worker/handlers/sitemap-refresh.ts"),
      "utf8",
    );
    expect(handlerSource).toContain("createSitemapFamilyBuilder");
  });
});
