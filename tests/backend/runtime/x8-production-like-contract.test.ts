import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";
import { parsePreviewOneArgs, runPreviewOne } from "../../../scripts/x8-preview-one";

const root = resolve(import.meta.dirname, "../../..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");
const overlay = read("infra/production-like/docker-compose.yml");
const fullNginx = read("infra/production-like/nginx/full.conf.template");
const bootstrapNginx = read("infra/production-like/nginx/bootstrap.conf.template");
const limitZones = read("infra/production-like/nginx/snippets/limit-zones.conf");
const capacityLocations = read("infra/production-like/nginx/snippets/capacity-locations.conf");
const proxyHeaders = read("infra/production-like/nginx/snippets/proxy-headers.conf");
const launcher = read("scripts/x8-production-like.sh");
const envHelper = read("scripts/lib/x8-production-like-env.sh");
const grants = read("infra/postgres/grants.sql");
const dockerignore = read(".dockerignore");
const classifierConfigSource = read("src/lib/tagging/classifier-config.ts");
const keywordEligibilitySource = read("src/lib/tagging/keyword-eligibility.ts");
const acceptanceReport = read("docs/operations/X8_LOCAL_PRODUCTION_LIKE_ACCEPTANCE_2026-08-26.md");

/**
 * RC-2b moved the per-level `WORKER_TASK_ALLOWLIST` / double-gate values out of
 * literal `export FOO=bar` lines in `scripts/lib/x8-production-like-env.sh` and
 * into `scripts/lib/x8-levels.json`, which both that helper and
 * `scripts/acceptance/x8-validate-compose.mjs` read. The Level 0 expectations
 * below are unchanged and still spelled out literally here — only where the
 * helper reads them from has moved, so these assertions now check the table
 * plus the wiring that consumes it.
 */
const x8Levels = JSON.parse(read("scripts/lib/x8-levels.json")) as Record<
  string,
  {
    workerTaskAllowlist: string;
    promoClaimRoles: string;
    adminTwoFactorEnforcement: string;
    flags: Record<string, string>;
  }
>;
const LEVEL_0_ALLOWLIST = "credential.validate.v1,credential.supersede.v1,catalog_scan,home_carousel.compute.v1";

describe("X8 targeted preview operator boundary", () => {
  const options = {
    taskId: "00000000-0000-4000-8000-000000000001",
    itemId: "00000000-0000-4000-8000-000000000002",
    actor: "test-operator",
  };
  const args = ["--task-id", options.taskId, "--item-id", options.itemId, "--actor", options.actor];
  const env = {
    NODE_ENV: "test", P1_12_COMPOSE_PROJECT: "cps-novel-x8-local", SITE_URL: "https://novel.test",
    FEATURE_NOVEL_CATALOG_SYNC: "true", NOVEL_CATALOG_SYNC_ALLOW_WRITE: "true",
    WORKER_TASK_ALLOWLIST: "moboreader.preview_refresh.v1",
  } satisfies NodeJS.ProcessEnv;

  it("requires an exact target and an attributable operator handle", () => {
    expect(parsePreviewOneArgs(args)).toEqual(options);
    for (const invalid of [[], args.slice(0, 4), [...args, "--unknown", "value"], [...args, "--actor", "other"], [...args.slice(0, 5), "Bearer secret"]]) {
      expect(() => parsePreviewOneArgs(invalid)).toThrow();
    }
  });

  it.each([
    [{ FEATURE_NOVEL_CATALOG_SYNC: "false" }, "preview_write_gates_closed"],
    [{ NOVEL_CATALOG_SYNC_ALLOW_WRITE: "false" }, "preview_write_gates_closed"],
    [{ WORKER_TASK_ALLOWLIST: "catalog_scan" }, "preview_only_allowlist_required"],
    [{ WORKER_TASK_ALLOWLIST: "" }, "preview_only_allowlist_required"],
    [{ P1_12_COMPOSE_PROJECT: "production" }, "local_topology_required"],
    [{ SITE_URL: "https://other.example" }, "local_topology_required"],
  ])("blocks before any database or upstream call: %j", async (overrides, reason) => {
    const logger = vi.fn();
    expect(await runPreviewOne({} as never, options, { env: { ...env, ...overrides }, logger }))
      .toEqual({ outcome: "blocked", reason });
    expect(logger).toHaveBeenLastCalledWith(expect.objectContaining({ ...options, phase: "finished", outcome: "blocked", reason }));
  });

  it("rejects privileged database roles instead of silently bypassing grants", async () => {
    const db = { $queryRaw: vi.fn().mockResolvedValue([{ role: "postgres" }]) };
    expect(await runPreviewOne(db as never, options, { env, logger: () => undefined }))
      .toEqual({ outcome: "blocked", reason: "worker_role_required" });
  });

  it("runs a disposable preview-only worker without changing the permanent allowlist", () => {
    const entry = launcher.slice(launcher.indexOf("preview_one()"), launcher.indexOf("accept_x8()"));
    expect(entry).toContain("x8_compose run --rm --no-deps -T");
    expect(entry).toContain("operator_image=\"$(docker inspect --format '{{.Config.Image}}' \"$web_container\")\"");
    expect(entry).toContain("CPS_NOVEL_APP_IMAGE=\"$operator_image\" x8_compose run");
    expect(entry).toContain("-e WORKER_TASK_ALLOWLIST=moboreader.preview_refresh.v1");
    expect(entry).toContain("src/lib/adapters/moboreader.ts:/app/src/lib/adapters/moboreader.ts:ro");
    expect(read("scripts/x8-preview-one.ts")).toContain("createMoboreaderReadAdapter({ maxAttempts: 1 })");
    expect(entry).not.toContain("write_x8_gate_state");
    // The permanent allowlist still defaults to exactly Level 0; RC-2b only
    // moved that value into scripts/lib/x8-levels.json.
    expect(x8Levels["0"].workerTaskAllowlist).toBe(LEVEL_0_ALLOWLIST);
    expect(envHelper).toContain('X8_LEVEL="${X8_LEVEL:-0}"');
  });
});

describe("X8 local production-like contracts", () => {
  it("extends rather than changing the frozen four-service base topology", () => {
    expect(overlay).toContain("ports: !reset []");
    expect(overlay).toContain('"127.0.0.1:${X8_HTTP_PORT:-80}:80"');
    expect(overlay).toContain('"127.0.0.1:${X8_HTTPS_PORT:-443}:443"');
    expect(overlay).toContain("name: cps_novel_x8_edge");
    expect(overlay).toContain("name: cps_novel_x8_runtime");
    expect(overlay).toContain("name: cps_novel_x8_postgres_data");
    expect(overlay).toContain("name: cps_novel_x8_sitemap_static");
    expect(overlay).toContain("name: cps_novel_x8_wal_archive");
    expect(overlay).not.toMatch(/network_mode:\s*host/);
  });

  it("keeps local evidence and upstream samples out of the production image context", () => {
    for (const path of [
      ".tmp",
      "node_modules",
      "test-results",
      "tests",
      "docs",
      "artifacts",
      "output",
      ".playwright-cli",
    ]) {
      expect(dockerignore.split(/\r?\n/)).toContain(path);
    }
  });

  it("keeps frozen tagging runtime authorities inside the production image context", () => {
    expect(dockerignore.split(/\r?\n/)).toContain("docs");
    for (const source of [classifierConfigSource, keywordEligibilitySource]) {
      expect(source).not.toMatch(/\.\.\/\.\.\/\.\.\/docs\//);
      expect(source).toContain("./artifacts/");
    }
    expect(JSON.parse(read("src/lib/tagging/artifacts/classifier-config-final.json"))).toEqual(
      JSON.parse(read("docs/p2/p2-06-5-lane-c/final/2026-08-17/classifier-config-final.json")),
    );
    expect(JSON.parse(read("src/lib/tagging/artifacts/keyword-eligibility-v1.json"))).toEqual(
      JSON.parse(read("docs/p2/p2-06-5-lane-c/lexicon-overrides/2026-08-16/keyword-eligibility-v1.json")),
    );
    expect(JSON.parse(read("src/lib/tagging/artifacts/keyword-eligibility-v2.json"))).toEqual(
      JSON.parse(read("docs/p2/p2-06-5-lane-c/lexicon-overrides/2026-08-17/keyword-eligibility-v2.json")),
    );
  });

  it("keeps the durable acceptance report free of credential-shaped material", () => {
    expect(acceptanceReport).not.toMatch(/postgres(?:ql)?:\/\//i);
    expect(acceptanceReport).not.toMatch(/otpauth:\/\//i);
    expect(acceptanceReport).not.toMatch(/-----BEGIN [A-Z ]+-----/);
    expect(acceptanceReport).not.toMatch(/[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/);
    expect(acceptanceReport).not.toMatch(/https?:\/\/[^/\s:@]+:[^@\s/]+@/);
    expect(acceptanceReport).not.toMatch(/\b[A-Z0-9]{4}(?:-[A-Z0-9]{4}){2}\b/);
  });

  it("loads the X2 PostgreSQL runtime configuration and keeps backup credentials narrow", () => {
    expect(overlay).toContain("config_file=/etc/postgresql/postgresql.conf");
    expect(overlay).toContain('"-c", "listen_addresses=*"');
    expect(overlay).toContain("postgresql.conf.example:/etc/postgresql/postgresql.conf:ro");
    expect(overlay).toContain("wal_archive:/var/lib/postgresql/wal-archive");
    expect(overlay).toContain("PGUSER: backup_role");
    expect(overlay).toContain("backup.pgpass:ro");
    expect(overlay).not.toMatch(/PGPASSWORD:/);
    expect(read("infra/production-like/backup-timer.sh")).toContain(
      "/opt/cps-novel-x8/backup-logical.sh --output",
    );
    expect(launcher.indexOf("infra/postgres/grants.sql")).toBeLessThan(
      launcher.indexOf("CREATE EXTENSION IF NOT EXISTS pg_stat_statements"),
    );
    const grantsInvocation = launcher.slice(
      launcher.lastIndexOf("x8_compose exec", launcher.indexOf("infra/postgres/grants.sql")),
      launcher.indexOf("infra/postgres/grants.sql"),
    );
    expect(grantsInvocation).toContain("-U postgres -d cps_novel");
    expect(grantsInvocation).not.toContain("-U migration_owner");
    expect(grants).toContain(
      "GRANT UPDATE (novel_id, status, updated_at) ON novel_source_item TO web_app;",
    );
    expect(grants).not.toContain("GRANT UPDATE ON TABLE novel_source_item TO web_app");
    expect(launcher).toMatch(/function render_nginx_configs|render_nginx_configs\(\)/);
    expect(launcher.slice(launcher.indexOf("render_nginx_configs()"), launcher.indexOf("validate_rendered_topology()")))
      .toContain("return 0");
  });

  it("implements the three-stage local TLS transition without a production fallback", () => {
    expect(bootstrapNginx).toContain("listen 80;");
    expect(bootstrapNginx).not.toContain("listen 443");
    expect(fullNginx).toContain("return 308 https://$host$request_uri;");
    expect(fullNginx).toContain("ssl_certificate /etc/nginx/tls/__X8_DOMAIN__.pem;");
    const upFlow = launcher.slice(launcher.indexOf("\nup_x8()"), launcher.indexOf("\nverify_postgres()"));
    expect(upFlow.indexOf("bootstrap.conf")).toBeLessThan(upFlow.indexOf("ensure_local_certificate"));
    expect(upFlow.indexOf("ensure_local_certificate")).toBeLessThan(upFlow.indexOf("full.conf"));
    expect(envHelper).toContain("export SITE_URL=https://novel.test");
    // RC-9 admin-host isolation (2026-09-03, Owner): the admin origin is a
    // distinct domain from SITE_URL at every X8_LEVEL (scripts/lib/
    // x8-production-like-env.sh), was previously the same
    // "https://novel.test" this test pinned pre-RC-9.
    expect(envHelper).toContain('export X8_ADMIN_DOMAIN="${X8_ADMIN_DOMAIN:-zbcwf.novel.test}"');
    expect(envHelper).toContain('export ADMIN_CANONICAL_ORIGIN="https://${X8_ADMIN_DOMAIN}"');
  });

  it("freezes the novel, go, browse, deep-page, and AI capacity gates", () => {
    expect(limitZones).toContain("~*(ClaudeBot|GPTBot|Bytespider)");
    expect(limitZones).toContain("zone=x8_novel_global:1m rate=10r/s");
    expect(limitZones).toContain("zone=x8_go_human:1m rate=10r/s");
    expect(limitZones).toContain("zone=x8_ai_site:1m rate=10r/m");
    expect(limitZones).toContain("zone=x8_ai_go:1m rate=1r/m");
    expect(limitZones).toContain("zone=x8_deep_page:1m rate=6r/m");
    expect(capacityLocations).toContain("limit_conn x8_novel_conc 8;");
    expect(capacityLocations).toContain("limit_conn x8_go_conc 16;");
    expect(capacityLocations).toContain("limit_conn x8_browse_conc 6;");
    expect(capacityLocations).toContain("limit_req zone=x8_novel_global burst=20 nodelay;");
    expect(capacityLocations).toContain("limit_req zone=x8_ai_go burst=1 nodelay;");
    expect(capacityLocations).toContain("limit_req zone=x8_deep_page burst=2 nodelay;");
    expect(`${fullNginx}\n${capacityLocations}`).not.toContain("proxy_ignore_headers");
  });

  it("overwrites client forwarding headers and keeps sensitive routes no-store", () => {
    expect(proxyHeaders).toContain("proxy_set_header X-Real-IP $remote_addr;");
    expect(proxyHeaders).toContain("proxy_set_header X-Forwarded-For $remote_addr;");
    expect(proxyHeaders).not.toMatch(/CF-Connecting-IP|proxy_add_x_forwarded_for/);
    for (const route of ["location ^~ /go/", "location ^~ /api/", "location = /sitemap.xml"]) {
      expect(`${fullNginx}\n${capacityLocations}`).toContain(route);
    }
    expect(`${fullNginx}\n${capacityLocations}`).toContain('add_header Cache-Control "no-store" always;');
    expect(fullNginx).toContain("location ^~ /dev-preview/");
  });

  it("keeps all non-catalog write gates closed and the worker allowlist at Level 0", () => {
    expect(x8Levels["0"].workerTaskAllowlist).toBe(LEVEL_0_ALLOWLIST);
    for (const flag of [
      "FEATURE_PROMO_LINK_CLAIM",
      "PROMO_LINK_CLAIM_ALLOW_WRITE",
      "FEATURE_SITEMAP_AUTO_REFRESH",
      "SITEMAP_AUTO_REFRESH_ALLOW_WRITE",
      "FEATURE_INDEXNOW_OUTBOX",
      "INDEXNOW_OUTBOX_ALLOW_WRITE",
      "FEATURE_INDEXNOW_DELIVERY",
      "INDEXNOW_DELIVERY_ALLOW_WRITE",
    ]) {
      expect(x8Levels["0"].flags[flag], `Level 0 ${flag}`).toBe("false");
    }
    // Level 0 must not hand the admin UI the promo:claim grant either.
    expect(x8Levels["0"].promoClaimRoles).toBe("");
    // ...and the helper must actually consume that table rather than keeping
    // its own copy of the values.
    expect(envHelper).toContain('level_config="$(x8_level_config "$X8_LEVEL")"');
    expect(envHelper).toContain('export "$level_key=$level_value"');
    expect(launcher).toContain("write_x8_gate_state apply");
    expect(launcher).toContain("write_x8_gate_state closed");
  });

  it("keeps the level table the single source of truth for both assertion sides", () => {
    const validator = read("scripts/acceptance/x8-validate-compose.mjs");
    expect(envHelper).toContain('X8_LEVELS_FILE="$X8_PROJECT_ROOT/scripts/lib/x8-levels.json"');
    expect(validator).toContain('"..", "lib", "x8-levels.json"');
    expect(Object.keys(x8Levels).filter((key) => key !== "_comment").sort()).toEqual(["0", "r", "uat"]);
    // Each rung only ever adds task types to the one below it.
    const [level0, levelUat, levelR] = ["0", "uat", "r"].map((key) => x8Levels[key].workerTaskAllowlist.split(","));
    expect(levelUat.slice(0, level0.length)).toEqual(level0);
    expect(levelR.slice(0, levelUat.length)).toEqual(levelUat);
    // IndexNow stays hard-gated at every rung until X11 lands.
    for (const level of ["0", "uat", "r"]) {
      for (const flag of [
        "FEATURE_INDEXNOW_OUTBOX",
        "INDEXNOW_OUTBOX_ALLOW_WRITE",
        "FEATURE_INDEXNOW_DELIVERY",
        "INDEXNOW_DELIVERY_ALLOW_WRITE",
      ]) {
        expect(x8Levels[level].flags[flag], `${level} ${flag}`).toBe("false");
      }
      expect(x8Levels[level].workerTaskAllowlist).not.toContain("indexnow_delivery");
    }
    expect(x8Levels.uat.workerTaskAllowlist).not.toContain("sitemap_refresh");
    expect(x8Levels.r.workerTaskAllowlist).toContain("sitemap_refresh");
    for (const level of ["0", "uat", "r"]) expect(x8Levels[level].workerTaskAllowlist).toContain("home_carousel.compute.v1");
  });

  it("PR6 fix B-1 #4: the scheduler actually registers the schedule the allowlist reserves a slot for", async () => {
    // `home_carousel.compute.v1` sat in every level's WORKER_TASK_ALLOWLIST
    // while scheduler/index.ts's SCHEDULES was still frozen empty (P1-07
    // shipped the runtime with zero production schedules) — the allowlist
    // let the worker consume the task type, but nothing ever produced one.
    const { SCHEDULES } = await import("../../../scheduler/index");
    const { HOME_CAROUSEL_SCHEDULE_KEY, HOME_CAROUSEL_TASK_TYPE } = await import("../../../src/server/home-carousel");
    const definition = SCHEDULES.find((schedule) => schedule.scheduleKey === HOME_CAROUSEL_SCHEDULE_KEY);
    expect(definition).toBeDefined();
    const sample = definition!.build(new Date("2026-09-05T19:00:00.000Z"));
    expect(sample.taskType).toBe(HOME_CAROUSEL_TASK_TYPE);
    for (const level of ["0", "uat", "r"]) expect(x8Levels[level].workerTaskAllowlist).toContain(sample.taskType);
  });

  it("RC-10: disables ADMIN_TWO_FACTOR_ENFORCEMENT only at Level UAT, and exports/asserts it end to end", () => {
    // Canonical values are "true"/"false" (Owner correction, 2026-09-04,
    // same day as the initial cut) -- "required"/"disabled" remain accepted
    // synonyms at the parsing layer (src/lib/auth/two-factor-enforcement.ts)
    // but the level table and every exported/rendered value use true/false.
    expect(x8Levels["0"].adminTwoFactorEnforcement).toBe("true");
    expect(x8Levels.uat.adminTwoFactorEnforcement).toBe("false");
    expect(x8Levels.r.adminTwoFactorEnforcement).toBe("true");
    // scripts/lib/x8-production-like-env.sh's x8_level_config() must read the
    // field from the same table (not a second hard-coded copy), and
    // prepare_x8_environment()'s existing `while IFS='=' read` loop exports
    // whatever x8_level_config() prints — no separate export line needed.
    expect(envHelper).toContain("`ADMIN_TWO_FACTOR_ENFORCEMENT=${entry.adminTwoFactorEnforcement}`");
    // scripts/acceptance/x8-validate-compose.mjs must assert the same table,
    // on web only (an admin-UI/session concern, same category as
    // PROMO_CLAIM_ROLES) and explicitly forbid it on worker/scheduler.
    const validator = read("scripts/acceptance/x8-validate-compose.mjs");
    expect(validator).toContain("levelEntry.adminTwoFactorEnforcement");
    expect(validator).toContain(
      "ADMIN_TWO_FACTOR_ENFORCEMENT is an admin-UI/session switch and must not reach worker/scheduler",
    );
    // docker-compose.yml's web service must default to the fail-closed value.
    const compose = read("docker-compose.yml");
    expect(compose).toContain("ADMIN_TWO_FACTOR_ENFORCEMENT: ${ADMIN_TWO_FACTOR_ENFORCEMENT:-true}");
  });

  it("ships valid shell and five read-only launch-day SQL groups", () => {
    for (const path of [
      "infra/production-like/postgres-entrypoint.sh",
      "infra/production-like/backup-timer.sh",
      "scripts/lib/x8-production-like-env.sh",
      "scripts/x8-production-like.sh",
      "scripts/x8-limiters-smoke.sh",
    ]) {
      execFileSync("bash", ["-n", resolve(root, path)]);
    }
    const healthSql = read("infra/production-like/launch-day-health-checks.sql");
    expect(healthSql).toContain("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;");
    expect(healthSql.match(/X8_HEALTH_SQL_GROUP_/g)).toHaveLength(5);
    expect(healthSql.trimEnd().endsWith("COMMIT;")).toBe(true);
  });

  it("M2 warns on UAT/R catalog gate drift without overwriting operator state", () => {
    expect(envHelper).toContain("warn_x8_gate_drift()");
    expect(envHelper).toContain("X8 catalog-write gate drift");
    expect(envHelper).toContain("gate catalog-write on");
    expect(envHelper).not.toMatch(/warn_x8_gate_drift\(\)[\s\S]*write_x8_gate_state "\$expected"/);
    expect(launcher).toMatch(/up_x8\(\)[\s\S]*prepare_x8_environment[\s\S]*warn_x8_gate_drift/);
  });

  it("uses the real PostgreSQL two-int advisory lock signature", () => {
    const bootstrap = read("scripts/bootstrap-admin-identity.ts");
    const foundation = read("scripts/register-moboreader-foundation.ts");
    const sitemapRefresh = read("src/lib/tasks/sitemap-refresh.ts");
    expect(bootstrap).toContain("${BOOTSTRAP_ADMIN_ADVISORY_LOCK.namespace}::int");
    expect(bootstrap).toContain("${BOOTSTRAP_ADMIN_ADVISORY_LOCK.scope}::int");
    expect(bootstrap).toContain(")::text AS lock_result");
    expect(foundation).toContain("pg_advisory_xact_lock(hashtextextended");
    expect(foundation).toContain(")::text AS lock_result");
    expect(sitemapRefresh).toContain("${SITEMAP_REFRESH_ADVISORY_LOCK.namespace}::int");
    expect(sitemapRefresh).toContain("${SITEMAP_REFRESH_ADVISORY_LOCK.scope}::int");
    expect(sitemapRefresh).toContain(")::text AS lock_result");
  });

  const composeAvailable = spawnSync("docker", ["compose", "version"], { stdio: "ignore" }).status === 0;

  it.skipIf(!composeAvailable)("renders to the exact isolated six-service topology", () => {
    const result = spawnSync(
      "bash",
      [
        "-c",
        [
          "source scripts/lib/x8-production-like-env.sh",
          "prepare_x8_environment",
          "docker compose -p \"$P1_12_COMPOSE_PROJECT\" -f docker-compose.yml -f infra/production-like/docker-compose.yml config --format json",
        ].join("; "),
      ],
      { cwd: root, encoding: "utf8" },
    );
    expect(result.status, result.stderr).toBe(0);
    const validate = spawnSync("node", [resolve(root, "scripts/acceptance/x8-validate-compose.mjs")], {
      cwd: root,
      input: result.stdout,
      encoding: "utf8",
    });
    expect(validate.status, validate.stderr).toBe(0);
    expect(validate.stdout).toContain("X8_COMPOSE_ISOLATION=PASS");
  });

  /**
   * PR6 fix (lane F): renders all three X8_LEVEL rungs (not just the
   * default "0" the test above covers) and checks the P2-06.5 tagging
   * double-gate lands on web + worker with exactly the values
   * `scripts/lib/x8-levels.json` promises for that level -- the same
   * table-driven double-check `x8-validate-compose.mjs` itself does, run
   * here independently so a bug in the validator's own flag list can't
   * hide a real passthrough gap.
   */
  it.skipIf(!composeAvailable)(
    "renders the P2-06.5 tagging double-gate across Level 0 / UAT / R with the frozen per-level values",
    () => {
      const taggingFlagNames = [
        "FEATURE_P2_06_5_TAGGING",
        "FEATURE_P2_06_5_TAG_ADMIN_WRITE",
        "FEATURE_NOVEL_TAG_AUTO",
        "AUTO_WRITE_AUTHORIZED",
      ] as const;
      for (const level of ["0", "uat", "r"] as const) {
        const result = spawnSync(
          "bash",
          [
            "-c",
            [
              "source scripts/lib/x8-production-like-env.sh",
              "prepare_x8_environment",
              "docker compose -p \"$P1_12_COMPOSE_PROJECT\" -f docker-compose.yml -f infra/production-like/docker-compose.yml config --format json",
            ].join("; "),
          ],
          { cwd: root, encoding: "utf8", env: { ...process.env, X8_LEVEL: level } },
        );
        expect(result.status, `${level}: ${result.stderr}`).toBe(0);
        const validate = spawnSync("node", [resolve(root, "scripts/acceptance/x8-validate-compose.mjs")], {
          cwd: root,
          input: result.stdout,
          encoding: "utf8",
          env: { ...process.env, X8_LEVEL: level },
        });
        expect(validate.status, `${level}: ${validate.stderr}`).toBe(0);
        const rendered = JSON.parse(result.stdout) as {
          services: { web: { environment: Record<string, string> }; worker: { environment: Record<string, string> } };
        };
        for (const flag of taggingFlagNames) {
          expect(rendered.services.web.environment[flag], `${level} web ${flag}`).toBe(x8Levels[level].flags[flag]);
          expect(rendered.services.worker.environment[flag], `${level} worker ${flag}`).toBe(
            x8Levels[level].flags[flag],
          );
        }
      }
    },
  );

  /**
   * PR6 fix (lane F) mutation coverage: `x8-validate-compose.mjs`'s ADR
   * guard hard-codes the expected value for `FEATURE_NOVEL_TAG_AUTO` /
   * `AUTO_WRITE_AUTHORIZED` instead of reading it from
   * `levelEntry.flags` -- this proves that guard actually fires by taking
   * one real Level UAT render and mutating just the rendered JSON in
   * memory (never touching `scripts/lib/x8-levels.json` on disk), so a
   * future edit that flips either value to "true"/"YES" at any X8_LEVEL
   * cannot silently pass by also "agreeing" with a correspondingly edited
   * table.
   */
  it.skipIf(!composeAvailable)(
    "ADR guard: the validator fails closed if FEATURE_NOVEL_TAG_AUTO or AUTO_WRITE_AUTHORIZED is ever not false/NO",
    () => {
      const result = spawnSync(
        "bash",
        [
          "-c",
          [
            "source scripts/lib/x8-production-like-env.sh",
            "prepare_x8_environment",
            "docker compose -p \"$P1_12_COMPOSE_PROJECT\" -f docker-compose.yml -f infra/production-like/docker-compose.yml config --format json",
          ].join("; "),
        ],
        { cwd: root, encoding: "utf8", env: { ...process.env, X8_LEVEL: "uat" } },
      );
      expect(result.status, result.stderr).toBe(0);
      const rendered = JSON.parse(result.stdout);

      const mutateAutoTrue = structuredClone(rendered);
      mutateAutoTrue.services.web.environment.FEATURE_NOVEL_TAG_AUTO = "true";
      mutateAutoTrue.services.worker.environment.FEATURE_NOVEL_TAG_AUTO = "true";
      const autoTrueResult = spawnSync("node", [resolve(root, "scripts/acceptance/x8-validate-compose.mjs")], {
        cwd: root,
        input: JSON.stringify(mutateAutoTrue),
        encoding: "utf8",
        env: { ...process.env, X8_LEVEL: "uat" },
      });
      expect(autoTrueResult.status).not.toBe(0);
      expect(autoTrueResult.stderr).toContain("ADR guard");
      expect(autoTrueResult.stderr).toContain("FEATURE_NOVEL_TAG_AUTO");

      const mutateAuthorizedYes = structuredClone(rendered);
      mutateAuthorizedYes.services.web.environment.AUTO_WRITE_AUTHORIZED = "YES";
      mutateAuthorizedYes.services.worker.environment.AUTO_WRITE_AUTHORIZED = "YES";
      const authorizedYesResult = spawnSync("node", [resolve(root, "scripts/acceptance/x8-validate-compose.mjs")], {
        cwd: root,
        input: JSON.stringify(mutateAuthorizedYes),
        encoding: "utf8",
        env: { ...process.env, X8_LEVEL: "uat" },
      });
      expect(authorizedYesResult.status).not.toBe(0);
      expect(authorizedYesResult.stderr).toContain("ADR guard");
      expect(authorizedYesResult.stderr).toContain("AUTO_WRITE_AUTHORIZED");
    },
  );
});
