import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const grants = readFileSync(resolve(process.cwd(), "infra/postgres/grants.sql"), "utf8");

describe("tagging runtime grants", () => {
  it("matches the dictionary read roles for every tagging-v3 table", () => {
    const sharedReadGrant = grants.match(
      /GRANT SELECT ON TABLE([\s\S]*?)TO web_app, analyst_ro;/,
    )?.[1] ?? "";
    for (const table of [
      "canonical_tag",
      "canonical_tag_translation",
      "canonical_tag_keyword",
      "source_label_mapping",
      "novel_tag_state",
      "novel_canonical_tag",
      "tag_classification_run",
    ]) {
      expect(sharedReadGrant, `${table} must be readable by public/admin Web and analyst_ro`).toContain(table);
    }
  });

  it("still denies the tagging tables to scheduler_app", () => {
    expect(grants).not.toMatch(/GRANT SELECT[^;]*(?:canonical_tag|source_label_mapping)[^;]*scheduler_app/s);
  });
});
