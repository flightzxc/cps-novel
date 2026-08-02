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
    expect(JSON.parse(output)).toMatchObject({ status: "ok", models: 37 });
  });

  it("keeps stable keys globally unique and records physical ownership", () => {
    const records = readFileSync(dictionaryPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const keys = records.map((record) => record.stable_key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(records.every((record) => record.status === "active")).toBe(true);
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
