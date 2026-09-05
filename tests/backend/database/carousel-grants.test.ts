import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../../..");
const grants = readFileSync(resolve(root, "infra/postgres/grants.sql"), "utf8");

/**
 * PR6 lane E: a real X8 uat run crashed the `scheduler` container with
 * `42501 permission denied for table site_setting` (scheduler -> main ->
 * getHomeCarouselConfig -> prisma.siteSetting.findUnique), and a parallel
 * audit of `information_schema.role_table_grants` found `worker_app` could
 * INSERT/UPDATE but not SELECT the four home_carousel_* data tables it reads
 * back inside the same transaction, and could not DELETE
 * `home_carousel_serving` even though `computeHomeCarouselInTx` clears it
 * with `deleteMany` before re-populating it. This file locks the minimal fix
 * in place: Scheduler gets a column-scoped read of just the two config
 * columns it needs (never the S2 `indexnow_key` sibling column), Worker gets
 * exactly the SELECT/DELETE its own query shapes require, and nothing wider.
 */
describe("home-carousel runtime grants (PR6 lane E)", () => {
  it("grants scheduler_app only the two SiteSetting columns the carousel cron needs", () => {
    expect(grants).toContain("GRANT SELECT (id, carousel_config_json) ON site_setting TO scheduler_app;");
    // No other statement may mention both site_setting and scheduler_app --
    // this is the column-scoped grant above and nothing more.
    const siteSettingScheduler = grants.match(/^GRANT[^\n]*site_setting[^\n]*scheduler_app[^\n]*$/gm) ?? [];
    expect(siteSettingScheduler).toEqual(["GRANT SELECT (id, carousel_config_json) ON site_setting TO scheduler_app;"]);
    // Scheduler must never receive whole-table SELECT on SiteSetting -- that
    // would also expose indexnow_key, which is the exact regression this
    // lane must not reintroduce.
    expect(grants).not.toMatch(/GRANT SELECT ON TABLE[^;]*site_setting[^;]*scheduler_app/s);
    expect(grants).not.toMatch(/GRANT SELECT ON TABLE[^;]*\bsite_setting\b[^;]*TO[^;]*scheduler_app/s);
  });

  it("still denies scheduler_app any access to the home_carousel_* tables", () => {
    for (const table of [
      "home_carousel_manual_slot",
      "home_carousel_auto_batch",
      "home_carousel_auto_candidate",
      "home_carousel_serving",
      "home_carousel_change_log",
    ]) {
      expect(grants, `${table} must stay outside scheduler_app's grant surface`).not.toMatch(
        new RegExp(`GRANT[^;]*${table}[^;]*scheduler_app`, "s"),
      );
    }
  });

  it("grants worker_app SELECT on the four home_carousel data tables it reads back in computeHomeCarouselInTx", () => {
    const workerSelectGrant = grants.match(
      /GRANT SELECT ON TABLE home_carousel_manual_slot, home_carousel_auto_batch,\s*\n\s*home_carousel_auto_candidate, home_carousel_serving TO worker_app;/,
    );
    expect(
      workerSelectGrant,
      "worker_app needs SELECT on manual_slot/auto_batch/auto_candidate/serving: computeHomeCarouselInTx's findMany/update/deleteMany all evaluate a WHERE clause against these tables",
    ).not.toBeNull();
  });

  it("grants worker_app DELETE on home_carousel_serving but not on the other three tables", () => {
    expect(grants).toContain("GRANT DELETE ON TABLE home_carousel_serving TO worker_app;");
    for (const table of ["home_carousel_manual_slot", "home_carousel_auto_batch", "home_carousel_auto_candidate"]) {
      expect(grants, `${table} has no deleteMany call in computeHomeCarouselInTx and must not receive DELETE`).not.toMatch(
        new RegExp(`GRANT DELETE ON TABLE[^;]*\\b${table}\\b[^;]*worker_app`, "s"),
      );
    }
  });

  it("keeps home_carousel_change_log INSERT-only for worker_app", () => {
    expect(grants).toMatch(/GRANT INSERT ON TABLE\s*\n\s*credential_change_log, operation_audit, indexnow_outbox_attempt,\s*\n\s*home_carousel_change_log\s*\nTO worker_app;/);
    expect(grants).not.toMatch(/GRANT SELECT[^;]*home_carousel_change_log[^;]*worker_app/s);
    expect(grants).not.toMatch(/GRANT (?:UPDATE|DELETE)[^;]*home_carousel_change_log[^;]*worker_app/s);
  });

  it("keeps web_app and analyst_ro grants on the five home_carousel tables unchanged", () => {
    const sharedReadGrant = grants.match(/GRANT SELECT ON TABLE([\s\S]*?)TO web_app, analyst_ro;/)?.[1] ?? "";
    for (const table of [
      "home_carousel_manual_slot",
      "home_carousel_auto_batch",
      "home_carousel_auto_candidate",
      "home_carousel_serving",
      "home_carousel_change_log",
    ]) {
      expect(sharedReadGrant).toContain(table);
    }
  });
});
