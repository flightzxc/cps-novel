import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");

const CJK = /[\u3400-\u9fff\u3000-\u303f\uff00-\uffef]/;

const SCAN_ROOTS = [
  "src/app/page.tsx",
  "src/app/layout.tsx",
  "src/app/browse",
  "src/app/novel",
  "src/features/public-ui",
  "src/lib/site/chrome.ts",
];

function walk(abs: string, acc: string[]): void {
  const stats = statSync(abs);
  if (stats.isDirectory()) {
    for (const entry of readdirSync(abs)) {
      walk(join(abs, entry), acc);
    }
    return;
  }
  if (/\.(ts|tsx)$/.test(abs)) acc.push(abs);
}

function collectFiles(): string[] {
  const files: string[] = [];
  for (const root of SCAN_ROOTS) {
    const abs = join(repoRoot, root);
    try {
      walk(abs, files);
    } catch {
      // optional path
    }
  }
  return files.filter((file) => !file.endsWith("/fixtures/mock-content.ts"));
}

/**
 * Strip block comments and line comments without treating `http://` inside
 * strings as comments. Good enough for this scan: remaining CJK after this
 * pass is UI copy, not JSDoc.
 */
function stripComments(source: string): string {
  let out = "";
  let i = 0;
  let state: "code" | "squote" | "dquote" | "template" | "line" | "block" = "code";

  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];

    if (state === "line") {
      if (ch === "\n") {
        state = "code";
        out += ch;
      }
      i += 1;
      continue;
    }
    if (state === "block") {
      if (ch === "*" && next === "/") {
        state = "code";
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }
    if (state === "squote") {
      out += ch;
      if (ch === "\\") {
        out += source[i + 1] ?? "";
        i += 2;
        continue;
      }
      if (ch === "'") state = "code";
      i += 1;
      continue;
    }
    if (state === "dquote") {
      out += ch;
      if (ch === "\\") {
        out += source[i + 1] ?? "";
        i += 2;
        continue;
      }
      if (ch === '"') state = "code";
      i += 1;
      continue;
    }
    if (state === "template") {
      out += ch;
      if (ch === "\\") {
        out += source[i + 1] ?? "";
        i += 2;
        continue;
      }
      if (ch === "`") state = "code";
      i += 1;
      continue;
    }

    if (ch === "/" && next === "/") {
      state = "line";
      i += 2;
      continue;
    }
    if (ch === "/" && next === "*") {
      state = "block";
      i += 2;
      continue;
    }
    if (ch === "'") {
      state = "squote";
      out += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      state = "dquote";
      out += ch;
      i += 1;
      continue;
    }
    if (ch === "`") {
      state = "template";
      out += ch;
      i += 1;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

describe("public UI copy has no hardcoded CJK", () => {
  it("scans production public tree + public-ui (comments and mock-content excepted)", () => {
    const hits: string[] = [];

    for (const file of collectFiles()) {
      const source = readFileSync(file, "utf8");
      const code = stripComments(source);
      const lines = code.split("\n");
      for (let index = 0; index < lines.length; index += 1) {
        if (CJK.test(lines[index])) {
          hits.push(`${relative(repoRoot, file)}:${index + 1}: ${lines[index].trim()}`);
        }
      }
    }

    expect(hits, hits.join("\n")).toEqual([]);
  });
});
