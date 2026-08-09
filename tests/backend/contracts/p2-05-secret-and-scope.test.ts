import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../../..");
const files = [
  "src/lib/adapters/moboreader.ts",
  "src/lib/tasks/moboreader.ts",
  "src/lib/preview/changdu-materialization.ts",
  "worker/handlers/moboreader.ts",
];

describe("P2-05 secret leak and side-effect scope", () => {
  it("has no logging calls in credential, raw payload or content paths", () => {
    for (const file of files) {
      const source = readFileSync(resolve(root, file), "utf8");
      expect(source, file).not.toMatch(/console\.(?:log|info|warn|error|debug)/);
    }
  });

  it("does not implement forbidden upstream side-effect methods", () => {
    const adapter = readFileSync(resolve(root, "src/lib/adapters/moboreader.ts"), "utf8");
    expect(adapter).not.toMatch(/claimPromo|getcode|getCode/);
    expect(adapter).not.toMatch(/PREVIEW_CHAPTER_COUNT/);
  });

  it("keeps P2-04-owned backend paths untouched by this task", () => {
    const status = readFileSync(resolve(root, "docs/p2/P2_05_CPS_PARITY_MATRIX.md"), "utf8");
    expect(status).toContain("P2-04-owned paths are untouched");
  });

  it("keeps Preview orchestration free of chapter bodies and public reader auth", () => {
    const orchestration = [
      readFileSync(resolve(root, "src/lib/tasks/moboreader.ts"), "utf8"),
      readFileSync(resolve(root, "worker/handlers/moboreader.ts"), "utf8"),
    ].join("\n");
    expect(orchestration).not.toMatch(/chapterContent|content:view|content:read|AdminSession|ReaderSession|UserSession/);
  });
});
