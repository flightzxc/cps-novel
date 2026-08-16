import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const schema = readFileSync(path.join(root, "prisma/schema.prisma"), "utf8");
const migration = readFileSync(path.join(root, "prisma/migrations/20260816160000_p2_06_5_tagging_v3/migration.sql"), "utf8");
const grants = readFileSync(path.join(root, "infra/postgres/grants.sql"), "utf8");

describe("P2-06.5 static database governance", () => {
  it("registers exactly seven additive Tagging models and nullable raw scope", () => {
    for (const model of ["CanonicalTag", "CanonicalTagTranslation", "CanonicalTagKeyword", "SourceLabelMapping", "NovelTagState", "NovelCanonicalTag", "TagClassificationRun"]) {
      expect(schema).toContain(`model ${model} {`);
    }
    expect(schema).toMatch(/rawLanguageScope\s+String\?/);
    expect((schema.match(/^model\s+/gm) ?? [])).toHaveLength(50);
  });

  it("keeps the migration structural and exact", () => {
    expect(migration).toContain('TEXT COLLATE "C" NOT NULL');
    expect(migration).toContain('source_label_mapping_edge_key');
    expect(migration).toContain('novel_canonical_tag_source_shape_check');
    expect(migration).toContain('novel_tag_state_current_auto_run_id_fkey');
    expect(migration).toContain('tag_classification_run_id_novel_key');
    expect(migration).not.toMatch(/INSERT\s+INTO/i);
    expect(migration).not.toMatch(/123\s+Tag|196\s+mapping|https?:\/\//i);
    expect(migration).not.toMatch(/UPDATE\s+"?novel_source_item"?\s+SET/i);
  });

  it("keeps Scheduler outside Tagging grants while Web and Worker are least-privileged writers", () => {
    const schedulerGrant = grants.match(/GRANT SELECT, INSERT, UPDATE ON TABLE schedule_run[^;]+TO scheduler_app;/s)?.[0] ?? "";
    expect(schedulerGrant).not.toMatch(/canonical_tag|source_label_mapping|novel_tag_state/);
    expect(grants).toMatch(/GRANT INSERT, UPDATE ON TABLE novel_tag_state, tag_classification_run,[\s\S]*?TO worker_app;/);
    expect(grants).toContain("source_label_mapping, novel_tag_state, novel_canonical_tag");
    expect(grants).toContain("GRANT INSERT ON TABLE operation_audit TO web_app");
  });
});
