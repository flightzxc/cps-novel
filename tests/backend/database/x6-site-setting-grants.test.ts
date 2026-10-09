import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { resolveAdminRoute } from "@/server/auth/registry";
import { P2_04_ADMIN_REGISTRY } from "@/app/api/admin/_lib/registry";

import { managedSiteSettingUpdateColumns } from "./_lib/site-setting-write-contract";

const root = resolve(import.meta.dirname, "../../..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

describe("X6 SiteSetting infrastructure and registry contracts", () => {
  it("registers one exact GET/PATCH route under settings:manage", () => {
    expect(resolveAdminRoute("/api/admin/site-settings", "GET", P2_04_ADMIN_REGISTRY)).toMatchObject({
      id: "admin.api.site_settings",
      capability: "settings:manage",
    });
    expect(resolveAdminRoute("/api/admin/site-settings", "PATCH", P2_04_ADMIN_REGISTRY)).toMatchObject({
      id: "admin.api.site_settings",
      capability: "settings:manage",
    });
    expect(resolveAdminRoute("/api/admin/site-settings/1", "PATCH", P2_04_ADMIN_REGISTRY)).toBeNull();
    expect(resolveAdminRoute("/api/admin/site-settings", "POST", P2_04_ADMIN_REGISTRY)).toBeNull();
  });

  it("grants Web and Worker reads and only the governed settings columns to Web UPDATE", () => {
    const grants = read("infra/postgres/grants.sql");
    expect(grants).toContain("GRANT SELECT ON TABLE site_setting TO web_app, worker_app;");
    const updateColumns = [...grants.matchAll(/GRANT UPDATE \(([^;]*?)\) ON site_setting TO web_app;/g)]
      .flatMap((match) => match[1].split(",").map((column) => column.trim()));
    expect([...new Set(updateColumns)].sort()).toEqual(managedSiteSettingUpdateColumns());
    expect(grants).not.toMatch(/GRANT[^;]+site_setting[^;]+analyst_ro/s);
    // PR6 lane E gave scheduler_app a column-scoped SELECT (id,
    // carousel_config_json) exception -- see
    // tests/backend/database/carousel-grants.test.ts for that positive
    // assertion. This file keeps enforcing that scheduler_app gets nothing
    // beyond it: no whole-table SELECT (which would also expose
    // indexnow_key) and no INSERT/UPDATE/DELETE.
    expect(grants).not.toMatch(/GRANT SELECT ON TABLE[^;]*site_setting[^;]*scheduler_app/s);
    expect(grants).not.toMatch(/GRANT (?:INSERT|UPDATE|DELETE)[^;]+site_setting[^;]+scheduler_app/s);
    expect(grants).not.toMatch(/GRANT (?:INSERT|DELETE)[^;]+site_setting[^;]+web_app/s);
    expect(grants).not.toMatch(/GRANT UPDATE ON TABLE site_setting TO web_app/);
  });

  it("keeps the SiteSetting dictionary synchronized with the column grants", () => {
    const records = read("docs/governance/database-schema-dictionary.jsonl")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .filter((record) => record.table_name === "site_setting");
    // 19 + 2: 运营 V2 (20260930100000_site_setting_yandex) adds the
    // yandex_verification and yandex_metrica_id field records.
    // 21 + 1: PN-15 (20261009150000_site_setting_site_search_enabled) adds the
    // site_search_enabled field record.
    expect(records).toHaveLength(22);
    const fields = new Map(records.filter((record) => record.record_kind === "field")
      .map((record) => [record.field_name, record]));
    // PR6 lane E: scheduler_app reads exactly `id` and `carousel_config_json`
    // (the column-scoped grant asserted in
    // tests/backend/database/carousel-grants.test.ts) to time the
    // home-carousel cron; every other column, including indexnow_key, stays
    // Web/Worker-only.
    const schedulerReadableFields = new Set(["id", "carousel_config_json"]);
    for (const record of fields.values()) {
      expect(record.read_roles).not.toContain("analyst_ro");
      if (schedulerReadableFields.has(record.field_name)) {
        expect(record.read_roles).toEqual(["web_app", "worker_app", "scheduler_app"]);
      } else {
        expect(record.read_roles).toEqual(["web_app", "worker_app"]);
        expect(record.read_roles).not.toContain("scheduler_app");
      }
    }
    const writableFields = [...fields.values()]
      .filter((record) => record.write_roles.includes("web_app"))
      .map((record) => record.field_name).sort();
    expect(writableFields).toEqual(managedSiteSettingUpdateColumns());
    for (const field of managedSiteSettingUpdateColumns()) {
      expect(fields.get(field)?.write_roles).toEqual(["migration_owner", "web_app"]);
    }
    expect(fields.get("id")?.write_roles).toEqual(["migration_owner"]);
  });

  it("PN-15: site_search_enabled is in the web_app column-level UPDATE list, readable by web/worker only, never by scheduler/analyst", () => {
    const grants = read("infra/postgres/grants.sql");
    const updateColumns = [...grants.matchAll(/GRANT UPDATE \(([^;]*?)\) ON site_setting TO web_app;/g)]
      .flatMap((match) => match[1].split(",").map((column) => column.trim()));
    // web_app may UPDATE the new column (column-level grant, not table-level).
    expect(updateColumns).toContain("site_search_enabled");
    // scheduler_app's column-scoped SELECT stays exactly (id, carousel_config_json).
    const schedulerSelect = grants.match(/GRANT SELECT \(([^)]*)\) ON site_setting TO scheduler_app;/);
    expect(schedulerSelect).not.toBeNull();
    expect(schedulerSelect![1].split(",").map((column) => column.trim())).toEqual(["id", "carousel_config_json"]);
    expect(grants).not.toMatch(/GRANT[^;]+site_setting[^;]+analyst_ro/s);
    // Dictionary record: Web/Worker read, Web writes (via the guarded service), nobody else.
    const record = read("docs/governance/database-schema-dictionary.jsonl")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .find((candidate) => candidate.stable_key === "db:public:site_setting:site_search_enabled");
    expect(record).toMatchObject({
      record_kind: "field",
      table_name: "site_setting",
      field_name: "site_search_enabled",
      data_type: "boolean",
      nullable: false,
      default: "false",
      introduced_in_migration: "20261009150000_site_setting_site_search_enabled",
      status: "active",
      read_roles: ["web_app", "worker_app"],
      write_roles: ["migration_owner", "web_app"],
    });
    expect(record.read_roles).not.toContain("scheduler_app");
    expect(record.read_roles).not.toContain("analyst_ro");
  });

  it("ships a syntactically valid self-cleaning disposable verification", () => {
    const script = resolve(root, "scripts/run-x6-site-setting-postgres-verification.sh");
    execFileSync("bash", ["-n", script]);
    const source = read("scripts/run-x6-site-setting-postgres-verification.sh");
    expect(source).toContain("X6_SITE_SETTING_POSTGRES_VERIFICATION=PASS");
    expect(source).toContain("DISPOSABLE_DATABASE_CLEANED=");
  });

  it("adds no X6 migration", () => {
    const migrationLock = read("prisma/migrations/migration_lock.toml");
    expect(migrationLock).not.toContain("X6");
    expect(read("prisma/schema.prisma")).toContain("model SiteSetting");
  });
});
