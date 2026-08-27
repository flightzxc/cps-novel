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
const acceptanceReport = read("docs/operations/X8_LOCAL_PRODUCTION_LIKE_ACCEPTANCE_2026-08-26.md");

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
    expect(entry).toContain("-e WORKER_TASK_ALLOWLIST=moboreader.preview_refresh.v1");
    expect(entry).not.toContain("write_x8_gate_state");
    expect(envHelper).toContain("export WORKER_TASK_ALLOWLIST=credential.validate.v1,credential.supersede.v1,catalog_scan");
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
    expect(envHelper).toContain("export ADMIN_CANONICAL_ORIGIN=https://novel.test");
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
    expect(envHelper).toContain(
      "export WORKER_TASK_ALLOWLIST=credential.validate.v1,credential.supersede.v1,catalog_scan",
    );
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
      expect(envHelper).toContain(`export ${flag}=false`);
    }
    expect(launcher).toContain("write_x8_gate_state apply");
    expect(launcher).toContain("write_x8_gate_state closed");
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
});
