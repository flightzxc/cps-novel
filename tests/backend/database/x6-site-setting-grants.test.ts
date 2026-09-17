import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { resolveAdminRoute } from "@/server/auth/registry";
import { P2_04_ADMIN_REGISTRY } from "@/app/api/admin/_lib/registry";

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
    const updateGrant = grants.match(/GRANT UPDATE \(([\s\S]*?)\) ON site_setting TO web_app;/)?.[1] ?? "";
    for (const column of [
      "site_name", "site_description", "home_meta_title", "home_meta_description",
      "default_og_image", "google_search_console_verification", "footer_copyright_text",
      "footer_disclaimer_text", "friend_links", "indexnow_host", "indexnow_key",
      "indexnow_key_location", "ga4_measurement_id", "carousel_config_json", "updated_at",
    ]) {
      expect(updateGrant).toContain(column);
    }
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
    expect(records).toHaveLength(19);
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
    for (const field of [
      "site_name",
      "site_description",
      "home_meta_title",
      "home_meta_description",
      "default_og_image",
      "google_search_console_verification",
      "footer_copyright_text",
      "footer_disclaimer_text",
      "friend_links",
      "indexnow_host",
      "indexnow_key",
      "indexnow_key_location",
      "ga4_measurement_id",
      "carousel_config_json",
      "updated_at",
    ]) {
      expect(fields.get(field)?.write_roles).toEqual(["migration_owner", "web_app"]);
    }
    expect(fields.get("id")?.write_roles).toEqual(["migration_owner"]);
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
