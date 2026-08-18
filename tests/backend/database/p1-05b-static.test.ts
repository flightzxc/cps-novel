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
    // v0.2.0 foundation added the SiteSetting table (Stream F, migration
    // 20260818120000_v020_foundation_shared): 43 -> 44 Prisma models.
    expect(JSON.parse(output)).toMatchObject({ status: "ok", models: 44 });
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
    for (const record of records) {
      const expectedStatus = SUPERSEDED_STABLE_KEYS.has(record.stable_key as string)
        ? "superseded"
        : "active";
      expect(record.status).toBe(expectedStatus);
    }
    expect(records.filter((record) => record.status === "superseded")).toHaveLength(
      SUPERSEDED_STABLE_KEYS.size,
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
