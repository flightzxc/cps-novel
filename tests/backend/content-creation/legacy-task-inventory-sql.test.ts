import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

const SQL = path.resolve(process.cwd(), "docs/p2/novel-article-decoupling/LEGACY_TASK_INVENTORY.sql");

describe("LEGACY_TASK_INVENTORY.sql text (P1-7)", () => {
  it("is read-only and keeps lease columns on generic_task_item only", async () => {
    const source = await readFile(SQL, "utf8");
    expect(source).not.toMatch(/\b(UPDATE|DELETE)\b/i);

    const query1 = source.slice(0, source.indexOf("-- 2)"));
    expect(query1).toContain("FROM generic_task");
    expect(query1).not.toMatch(/\blocked_until\b/);
    expect(query1).not.toMatch(/\blease_epoch\b/);

    const query3 = source.slice(source.indexOf("-- 3)"), source.indexOf("-- 4)"));
    expect(query3).toContain("FROM generic_task_item i");
    expect(query3).toContain("i.locked_until");
    expect(query3).toContain("i.lease_epoch");

    expect(source).toContain("article.generate.batch.v1");
  });
});
