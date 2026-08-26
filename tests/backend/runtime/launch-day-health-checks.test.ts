import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const RUNBOOK_PATH = path.join(
  process.cwd(),
  "docs/operations/LAUNCH_DAY_HEALTH_CHECKS.md",
);

describe("X10 launch-day health checks", () => {
  it("contains exactly five read-only SQL evidence groups", async () => {
    const runbook = await readFile(RUNBOOK_PATH, "utf8");
    const groups = runbook.match(/^## \d+\./gm) ?? [];
    const sqlBlocks = [...runbook.matchAll(/```sql\n([\s\S]*?)```/g)]
      .map((match) => match[1]);

    expect(groups).toHaveLength(5);
    expect(runbook).toContain("BEGIN TRANSACTION READ ONLY;");
    expect(runbook).toContain("action = 'task_item.failed'");
    expect(runbook).toContain("reason");
    expect(sqlBlocks).toHaveLength(7);
    expect(sqlBlocks.join("\n")).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|MERGE|TRUNCATE|ALTER|DROP|CREATE)\b/i);
  });

  it("does not select task internals or upstream PromoLink evidence", async () => {
    const runbook = await readFile(RUNBOOK_PATH, "utf8");
    const sql = [...runbook.matchAll(/```sql\n([\s\S]*?)```/g)]
      .map((match) => match[1])
      .join("\n");

    expect(sql).not.toMatch(/\b(?:execution_token|payload|result|error|request_summary|response_shape|redirect_code|web_url|app_url|raw_links)\b/i);
  });
});
