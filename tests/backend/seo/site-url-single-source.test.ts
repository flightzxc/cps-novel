import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Single-source guard for site-URL configuration (v0.2.0 integration).
 *
 * Why this exists: during this round the same getSiteUrl logic was
 * independently implemented three times (Stream B `_shared.ts`, Stream D
 * `site-url.ts`, Stream E `internal-site-url.ts`), and Stream E's copy
 * briefly reintroduced the two exact defects the round had already banned —
 * a `NEXT_PUBLIC_SITE_URL` fallback and a hardcoded fail-open default to
 * CPS's production domain. That escape was caught by human review, not by
 * any existing guard (Stream B's negative tests only covered its own copy).
 * After consolidation onto `src/lib/seo/site-url.ts`, this test pins the
 * repo-wide invariants so the drift cannot silently return.
 *
 * Scanning note: lines whose trimmed form starts with `//`, `*`, or `/*`
 * (comments) are ignored, so historical references in explanatory comments
 * don't trip the guard. Only live code counts.
 */

const SRC_ROOT = join(process.cwd(), "src");
// Same scan roots as publish-gate's no-bypass scanner: a copy pasted into
// worker/ or scripts/ must trip this guard too.
const SCAN_ROOTS = ["src", "worker", "scheduler", "scripts"]
  .map((dir) => join(process.cwd(), dir))
  .filter((dir) => {
    try {
      return statSync(dir).isDirectory();
    } catch {
      return false;
    }
  });

function collectSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      collectSourceFiles(full, out);
    } else if (/\.(ts|tsx|mjs)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

function nonCommentLines(file: string): Array<{ line: number; text: string }> {
  return readFileSync(file, "utf8")
    .split("\n")
    .map((text, i) => ({ line: i + 1, text }))
    .filter(({ text }) => {
      const trimmed = text.trim();
      return !(
        trimmed.startsWith("//") ||
        trimmed.startsWith("*") ||
        trimmed.startsWith("/*")
      );
    });
}

describe("site-url single source", () => {
  const files = SCAN_ROOTS.flatMap((root) => collectSourceFiles(root));

  it("never mentions the CPS production domain in live code", () => {
    const hits = files.flatMap((file) =>
      nonCommentLines(file)
        .filter(({ text }) => text.includes("enpulsedrama"))
        .map(({ line }) => `${file}:${line}`),
    );
    expect(hits).toEqual([]);
  });

  it("never reads NEXT_PUBLIC_SITE_URL in live code", () => {
    const hits = files.flatMap((file) =>
      nonCommentLines(file)
        .filter(({ text }) => text.includes("NEXT_PUBLIC_SITE_URL"))
        .map(({ line }) => `${file}:${line}`),
    );
    expect(hits).toEqual([]);
  });

  it("has exactly one SiteUrlConfigurationError class and one getSiteUrl implementation", () => {
    const classDefs = files.filter((file) =>
      nonCommentLines(file).some(({ text }) =>
        text.includes("class SiteUrlConfigurationError"),
      ),
    );
    const fnDefs = files.filter((file) =>
      nonCommentLines(file).some(({ text }) =>
        // function declaration or arrow/const re-implementation — a re-export
        // line (`export { getSiteUrl ... } from`) intentionally does not match
        /function getSiteUrl\(|getSiteUrl\s*=/.test(text),
      ),
    );
    const canonical = join(SRC_ROOT, "lib", "seo", "site-url.ts");
    expect(classDefs).toEqual([canonical]);
    expect(fnDefs).toEqual([canonical]);
  });
});
