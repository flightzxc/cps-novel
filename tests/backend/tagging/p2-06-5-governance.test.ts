import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const schema = readFileSync(path.join(root, "prisma/schema.prisma"), "utf8");
const migration = readFileSync(path.join(root, "prisma/migrations/20260816160000_p2_06_5_tagging_v3/migration.sql"), "utf8");
const grants = readFileSync(path.join(root, "infra/postgres/grants.sql"), "utf8");
const scheduler = readFileSync(path.join(root, "scheduler/index.ts"), "utf8");

describe("P2-06.5 static database governance", () => {
  it("registers exactly seven additive Tagging models and nullable raw scope", () => {
    for (const model of ["CanonicalTag", "CanonicalTagTranslation", "CanonicalTagKeyword", "SourceLabelMapping", "NovelTagState", "NovelCanonicalTag", "TagClassificationRun"]) {
      expect(schema).toContain(`model ${model} {`);
    }
    expect(schema).toMatch(/rawLanguageScope\s+String\?/);
    expect((schema.match(/^model\s+/gm) ?? [])).toHaveLength(51);
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
    const workerWriteGrant = grants.match(/-- Worker can mutate business\/task state\.[\s\S]*?TO worker_app;/)?.[0] ?? "";
    expect(workerWriteGrant).toMatch(/novel_tag_state, novel_canonical_tag, tag_classification_run/);
    expect(grants).toContain("source_label_mapping, novel_tag_state, novel_canonical_tag");
    expect(grants).toContain("GRANT INSERT ON TABLE operation_audit TO web_app");
  });

  it("keeps auto classification explicit and the pure Tagging core dependency-free", () => {
    // PR6 fix (B-1): this line used to pin the literal `SCHEDULES: readonly
    // ScheduleDefinition[] = Object.freeze([])`, i.e. "the scheduler process
    // registers no schedule at all". That was never the P2-06.5 governance
    // invariant — it was an accident of the scheduler shipping empty. The
    // invariant this suite owns is narrower and survives B-1 registering the
    // home-carousel cron: the scheduler must never reach into Tagging, so
    // auto classification stays explicit/manual (`AUTO_WRITE_AUTHORIZED=NO`).
    // Asserted on the import statements specifically (a schedule for some
    // *other* domain is allowed; a tagging/auto_classify import is not),
    // then re-asserted across the whole file to catch a dynamic import or a
    // bare string task type.
    const schedulerImports = scheduler.match(/^import[\s\S]*?from "[^"]+";$/gm) ?? [];
    expect(schedulerImports.length).toBeGreaterThan(0);
    for (const statement of schedulerImports) {
      expect(statement, `scheduler must not import Tagging: ${statement}`).not.toMatch(/tagging|auto_classify|canonical-tag|novel-tag/i);
    }
    expect(scheduler).not.toMatch(/tagging|auto_classify|novel-tag-backfill/i);
    const core = ["contracts.ts", "classifier.ts", "classifier-config.ts", "keyword-artifact.ts", "keyword-eligibility.ts", "stable-json.ts", "task-contract.ts"]
      .map((file) => readFileSync(path.join(root, "src/lib/tagging", file), "utf8"))
      .join("\n");
    expect(core).not.toMatch(/@prisma|next\/|worker\/|server\/|scheduler\//);
    const cli = readFileSync(path.join(root, "scripts/p2-06-5-production/tagging-backfill.ts"), "utf8");
    expect(cli).toContain("P2_06_5_TAGGING_TASK_DATABASE_URL");
    expect(cli).not.toMatch(/process\.env\.DATABASE_URL|scheduler/i);
  });
});
