import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const migrationPath = path.join(
  root,
  "prisma/migrations/20260803090000_p1_initial_schema/migration.sql",
);
const dictionaryPath = path.join(
  root,
  "docs/governance/database-schema-dictionary.jsonl",
);

describe("P1-05B static database contracts", () => {
  it("keeps Schema and active dictionary records bidirectionally aligned", () => {
    const output = execFileSync(
      process.execPath,
      [path.join(root, "scripts/check-database-dictionary-drift.mjs"), "--static"],
      { encoding: "utf8" },
    );
    // SiteSetting plus the seven Tagging V3 models brought the schema to 51
    // models; Phase C step C-4 dropped CatalogScanTask/CatalogScanTaskItem,
    // bringing it back down to 49. C-30A (施工工单_C30_换小说_移植CPS换租客_
    // 2026-09-08.md §4A.1) adds three more (ArticleNovelRebindPreview/
    // Batch/BatchItem), bringing it to 52.
    expect(JSON.parse(output)).toMatchObject({ status: "ok", models: 52 });
  });

  it("keeps stable keys globally unique and records physical ownership", () => {
    const records = readFileSync(dictionaryPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const keys = records.map((record) => record.stable_key);
    expect(new Set(keys).size).toBe(keys.length);
    // v0.2.0 foundation introduced this repo's first field/constraint renames
    // (IndexNowOutboxAttempt.attemptState -> outcome, and its CHECK), which
    // per docs/governance/database-governance.md §10 must be retained as
    // `superseded` rather than deleted. Exactly these two stable_keys are
    // allowed to be non-active; every other record must still be exactly
    // "active" — an unqualified `["active","superseded"]` allowlist would
    // silently stop catching a future record mistakenly marked superseded.
    const SUPERSEDED_STABLE_KEYS = new Set([
      "db:public:indexnow_outbox_attempt:attempt_state",
      "db:public:indexnow_outbox_attempt:indexnow_outbox_attempt_attempt_state_check",
    ]);
    // Phase C step C-4 (`prisma/migrations/20260907091500_p3_drop_catalog_scan_task`)
    // dropped catalog_scan_task/catalog_scan_task_item wholesale; every one of
    // their table/field/constraint records moved to `superseded` per §10 (no
    // deletion on removal). Matched by table_name rather than an enumerated
    // list of 68 stable_keys -- still a narrow, table-scoped predicate, not
    // an open allowlist that could silently swallow an unrelated mistake.
    const SUPERSEDED_TABLE_NAMES = new Set(["catalog_scan_task", "catalog_scan_task_item"]);
    let catalogScanSupersededCount = 0;
    for (const record of records) {
      const isDroppedCatalogScan = SUPERSEDED_TABLE_NAMES.has(record.table_name as string);
      if (isDroppedCatalogScan) catalogScanSupersededCount += 1;
      const expectedStatus = SUPERSEDED_STABLE_KEYS.has(record.stable_key as string) || isDroppedCatalogScan
        ? "superseded"
        : "active";
      expect(record.status).toBe(expectedStatus);
    }
    expect(records.filter((record) => record.status === "superseded")).toHaveLength(
      SUPERSEDED_STABLE_KEYS.size + catalogScanSupersededCount,
    );
    expect(
      records
        .filter((record) => record.record_kind === "constraint")
        .every((record) =>
          record.managed_by === "application_contract" ? true : Boolean(record.physical_name),
        ),
    ).toBe(true);
  });

  it("contains required PostgreSQL-only objects without SQLite residue", () => {
    const sql = readFileSync(migrationPath, "utf8");
    const required = [
      "article_published_published_at_check",
      "article_promo_link_novel_fkey",
      "catalog_scan_active_scope_uidx",
      "catalog_scan_task_item_pending_global_idx",
      "catalog_scan_task_item_expired_lease_idx",
      "channel_sync_task_item_pending_global_idx",
      "channel_sync_task_item_expired_lease_idx",
      "generic_task_item_pending_global_idx",
      "generic_task_item_expired_lease_idx",
      "promo_public_code_immutable_trigger",
      "operation_audit_append_only",
      "NULLS NOT DISTINCT",
    ];
    for (const marker of required) expect(sql).toContain(marker);
    expect(sql).not.toMatch(/MATCH\s+FULL/i);
    expect(sql).not.toMatch(/sqlite|PRAGMA|busy_timeout|BEGIN\s+IMMEDIATE|AUTOINCREMENT/i);
    expect(sql).not.toMatch(/\bAS\s+[a-z]+[A-Z]\w*/);
  });
});
