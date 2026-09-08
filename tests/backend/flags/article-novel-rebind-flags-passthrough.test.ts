import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  ARTICLE_NOVEL_REBIND_ALLOW_WRITE_FLAG,
  ARTICLE_NOVEL_REBIND_FEATURE_FLAG,
  isArticleNovelRebindEnabled,
  isArticleNovelRebindWriteAllowed,
} from "@/lib/flags/feature-flags";

/**
 * C-30A (施工工单_C30_换小说_移植CPS换租客_2026-09-08.md §4A.5/附录 E):
 * "开关登记（五处，缺一不可）" — same shape as
 * `./article-blog-flags-passthrough.test.ts` (C-28/C-29), covering exactly
 * the five places the construction order's registration discipline requires:
 *
 *   1. `src/lib/flags/feature-flags.ts` — the two constants + reader
 *      functions.
 *   2. `docs/governance/feature-flag-registry.md` — the two table rows +
 *      the preview single-gate exception note.
 *   3. `docker-compose.yml`'s `web` service block (web-only — grepped, no
 *      worker/scheduler consumer).
 *   4. `scripts/lib/x8-levels.json` — `false`/`false` at every level
 *      (0/uat/r — no Owner-approved open-the-gate step yet).
 *   5. `scripts/acceptance/x8-validate-compose.mjs`'s web assertion array.
 */
const root = resolve(import.meta.dirname, "../../..");

describe("C-30A: FEATURE_ARTICLE_NOVEL_REBIND / ARTICLE_NOVEL_REBIND_ALLOW_WRITE are registered in all required places", () => {
  it("1. src/lib/flags/feature-flags.ts: exact `=== \"true\"` parsing, default off, for both flags", () => {
    const env = (values: Record<string, string | undefined>) => values as unknown as NodeJS.ProcessEnv;
    expect(ARTICLE_NOVEL_REBIND_FEATURE_FLAG).toBe("FEATURE_ARTICLE_NOVEL_REBIND");
    expect(ARTICLE_NOVEL_REBIND_ALLOW_WRITE_FLAG).toBe("ARTICLE_NOVEL_REBIND_ALLOW_WRITE");

    expect(isArticleNovelRebindEnabled(env({}))).toBe(false);
    expect(isArticleNovelRebindEnabled(env({ FEATURE_ARTICLE_NOVEL_REBIND: "false" }))).toBe(false);
    expect(isArticleNovelRebindEnabled(env({ FEATURE_ARTICLE_NOVEL_REBIND: "TRUE" }))).toBe(false); // exact match, not case-insensitive
    expect(isArticleNovelRebindEnabled(env({ FEATURE_ARTICLE_NOVEL_REBIND: "true" }))).toBe(true);

    expect(isArticleNovelRebindWriteAllowed(env({}))).toBe(false);
    expect(isArticleNovelRebindWriteAllowed(env({ ARTICLE_NOVEL_REBIND_ALLOW_WRITE: "false" }))).toBe(false);
    expect(isArticleNovelRebindWriteAllowed(env({ ARTICLE_NOVEL_REBIND_ALLOW_WRITE: "true" }))).toBe(true);
  });

  it("2. docs/governance/feature-flag-registry.md documents both flags and the preview single-gate exception", () => {
    const registry = readFileSync(resolve(root, "docs/governance/feature-flag-registry.md"), "utf8");
    expect(registry).toContain("FEATURE_ARTICLE_NOVEL_REBIND");
    expect(registry).toContain("ARTICLE_NOVEL_REBIND_ALLOW_WRITE");
    // 🔴 the single-gate exception for the batch preview snapshot write must
    // be spelled out here, not left implicit — same discipline
    // FEATURE_ARTICLE_SEO_VISIBILITY's own single-gate row follows.
    expect(registry).toMatch(/预览快照[\s\S]{0,400}只受总闸/);
  });

  it("3. docker-compose.yml passes both flags to web with the exact fail-closed default, and to neither worker nor scheduler", () => {
    const compose = readFileSync(resolve(root, "docker-compose.yml"), "utf8");

    function serviceBlock(serviceName: string): string {
      const marker = `\n  ${serviceName}:\n`;
      const start = compose.indexOf(marker);
      if (start === -1) throw new Error(`service "${serviceName}" not found in docker-compose.yml`);
      const rest = compose.slice(start + marker.length);
      const nextServiceHeader = rest.match(/\n {2}[a-zA-Z][\w-]*:\n/);
      return rest.slice(0, nextServiceHeader ? nextServiceHeader.index : undefined);
    }

    expect(serviceBlock("web")).toContain("FEATURE_ARTICLE_NOVEL_REBIND: ${FEATURE_ARTICLE_NOVEL_REBIND:-false}");
    expect(serviceBlock("web")).toContain(
      "ARTICLE_NOVEL_REBIND_ALLOW_WRITE: ${ARTICLE_NOVEL_REBIND_ALLOW_WRITE:-false}",
    );
    expect(serviceBlock("worker")).not.toContain("FEATURE_ARTICLE_NOVEL_REBIND");
    expect(serviceBlock("worker")).not.toContain("ARTICLE_NOVEL_REBIND_ALLOW_WRITE");
    expect(serviceBlock("scheduler")).not.toContain("FEATURE_ARTICLE_NOVEL_REBIND");
    expect(serviceBlock("scheduler")).not.toContain("ARTICLE_NOVEL_REBIND_ALLOW_WRITE");
  });

  it("4. scripts/lib/x8-levels.json: false/false at every level (0/uat/r) — no Owner-approved open-the-gate step yet", () => {
    const levels = JSON.parse(readFileSync(resolve(root, "scripts/lib/x8-levels.json"), "utf8")) as Record<
      string,
      { flags: Record<string, string> }
    >;
    for (const level of ["0", "uat", "r"]) {
      expect(levels[level]!.flags.FEATURE_ARTICLE_NOVEL_REBIND).toBe("false");
      expect(levels[level]!.flags.ARTICLE_NOVEL_REBIND_ALLOW_WRITE).toBe("false");
    }
  });

  it("5. scripts/acceptance/x8-validate-compose.mjs asserts both flags in its web loop", () => {
    const source = readFileSync(resolve(root, "scripts/acceptance/x8-validate-compose.mjs"), "utf8");
    expect(source).toContain('"FEATURE_ARTICLE_NOVEL_REBIND"');
    expect(source).toContain('"ARTICLE_NOVEL_REBIND_ALLOW_WRITE"');
  });

  it("consumers: neither flag reader is imported under worker/ or scheduler/ (grepped before registering only under web)", async () => {
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
      expect(source, file).not.toMatch(/isArticleNovelRebindEnabled|isArticleNovelRebindWriteAllowed/);
    }
  });
});
