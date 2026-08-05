import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const canonicalRelativePath = "src/lib/locale/locale-canonical.ts";
const canonicalPath = path.join(root, canonicalRelativePath);
const localeReadyForFinalIntegration = existsSync(canonicalPath);

function sourceFiles(directory: string): string[] {
  const output: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (["node_modules", ".next", ".git"].includes(entry.name)) continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) output.push(...sourceFiles(absolute));
    else if (/\.(?:ts|tsx|js|mjs|cjs)$/.test(entry.name)) output.push(absolute);
  }
  return output;
}

describe.skipIf(!localeReadyForFinalIntegration)("P1-13 locale canonical single source — WAITING_FOR_CLAUDE_IN_FINAL_INTEGRATION", () => {
  it("provides the frozen locale API from the one declared implementation source", () => {
    const source = readFileSync(canonicalPath, "utf8");
    for (const symbol of ["resolveSiteLocale", "isPublishableLocale", "listPublishableLocales"]) {
      expect(source, `${symbol} must be exported by ${canonicalRelativePath}`).toMatch(
        new RegExp(`export\\s+(?:function|const)\\s+${symbol}\\b`),
      );
    }
  });

  it("keeps locale mapping literals out of every other executable source", () => {
    const offenders = sourceFiles(root)
      .map((absolute) => ({
        relative: path.relative(root, absolute),
        source: readFileSync(absolute, "utf8"),
      }))
      .filter(({ relative }) => relative !== canonicalRelativePath)
      .filter(({ source }) =>
        /(?:sourceLanguageCode|source_locale|sourceLocale)[\s\S]{0,240}(?:en-US|zh-CN|ja-JP)|(?:en-US|zh-CN|ja-JP)[\s\S]{0,240}(?:sourceLanguageCode|source_locale|sourceLocale)/.test(source),
      )
      .map(({ relative }) => relative);
    expect(offenders).toEqual([]);
  });
});
