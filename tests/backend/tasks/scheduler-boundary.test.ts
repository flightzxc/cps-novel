import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("P1-07 scheduler process boundary", () => {
  const source = readFileSync(path.join(process.cwd(), "scheduler/index.ts"), "utf8");

  it("is independent from Web, credentials, adapters, and external delivery", () => {
    expect(source).not.toMatch(/instrumentation|next\/|credential|decrypt|adapter|indexnow|fetch\s*\(/i);
    expect(source).not.toMatch(/src\/app|src\/components|src\/contracts/);
  });
});
