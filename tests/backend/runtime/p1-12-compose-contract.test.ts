import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../../..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");
const compose = read("docker-compose.yml");
const dockerfile = read("Dockerfile");
const envExample = read(".env.example");
const releaseChecklist = read("docs/p2/V020_RELEASE_CHECKLIST.md");

const DOUBLE_GATE_FLAGS = [
  "FEATURE_NOVEL_CATALOG_SYNC",
  "NOVEL_CATALOG_SYNC_ALLOW_WRITE",
  "FEATURE_INDEXNOW_OUTBOX",
  "INDEXNOW_OUTBOX_ALLOW_WRITE",
  "FEATURE_INDEXNOW_DELIVERY",
  "INDEXNOW_DELIVERY_ALLOW_WRITE",
  "FEATURE_SITEMAP_AUTO_REFRESH",
  "SITEMAP_AUTO_REFRESH_ALLOW_WRITE",
  "FEATURE_PROMO_LINK_CLAIM",
  "PROMO_LINK_CLAIM_ALLOW_WRITE",
] as const;

function serviceBlock(name: string): string {
  const match = compose.match(new RegExp(`\\n  ${name}:\\n([\\s\\S]*?)(?=\\n  [a-z][a-z0-9_-]*:\\n|\\nnetworks:)`));
  expect(match, `missing service ${name}`).not.toBeNull();
  return match?.[1] ?? "";
}

describe("P1-12 Compose and image contracts", () => {
  it("defines exactly the four approved resident services", () => {
    const serviceSection = compose.slice(compose.indexOf("services:"), compose.indexOf("\nnetworks:"));
    const services = Array.from(serviceSection.matchAll(/^  ([a-z][a-z0-9_-]*):$/gm), (match) => match[1]);
    expect(services).toEqual(["postgres", "web", "worker", "scheduler"]);
  });

  it("fails closed on one exact application image variable without latest", () => {
    expect(compose).toContain("${CPS_NOVEL_APP_IMAGE:?CPS_NOVEL_APP_IMAGE is required}");
    expect(compose).not.toMatch(/CPS_APP_IMAGE|APP_IMAGE:-|latest/i);
    expect((compose.match(/CPS_NOVEL_APP_IMAGE/g) ?? [])).toHaveLength(2);
  });

  it("uses PostgreSQL 16.14 on the container network with a persistent volume and no published DB port", () => {
    const postgres = serviceBlock("postgres");
    expect(postgres).toContain("image: postgres:16.14");
    expect(postgres).toContain("postgres_data:/var/lib/postgresql/data");
    expect(postgres).toContain("pg_isready -U postgres -d cps_novel");
    expect(postgres).not.toMatch(/\n    ports:/);
    expect(serviceBlock("web")).toContain('"127.0.0.1:${P1_12_WEB_PORT:-3000}:3000"');
    expect(compose).not.toMatch(/network_mode:\s*host/);
  });

  it("contains no SQLite runtime, volume, probe, backup, pragma, or migrate-on-start behavior", () => {
    expect(`${compose}\n${dockerfile}`).not.toMatch(/sqlite|pragma|cps\.db|\/app\/data/i);
    expect(serviceBlock("web")).not.toMatch(/migrate/i);
    expect(serviceBlock("worker")).not.toMatch(/migrate/i);
    expect(serviceBlock("scheduler")).not.toMatch(/migrate/i);
  });

  it("mounts Credential keys into Web and Worker only as secret files", () => {
    const web = serviceBlock("web");
    const worker = serviceBlock("worker");
    for (const key of [
      "CHANNEL_CREDENTIAL_ACTIVE_KEY_VERSION",
      "CHANNEL_CREDENTIAL_ENCRYPTION_KEY_V1_FILE",
      "CHANNEL_CREDENTIAL_FINGERPRINT_KEY_FILE",
      "channel_credential_encryption_key_v1",
      "channel_credential_fingerprint_key",
    ]) {
      expect(web).toContain(key);
      expect(worker).toContain(key);
    }
    expect(web).not.toMatch(/CHANNEL_CREDENTIAL_ENCRYPTION_KEY_V1:/);
    expect(web).not.toMatch(/CHANNEL_CREDENTIAL_FINGERPRINT_KEY:/);
    expect(worker).not.toMatch(/CHANNEL_CREDENTIAL_ENCRYPTION_KEY_V1:/);
    expect(worker).not.toMatch(/CHANNEL_CREDENTIAL_FINGERPRINT_KEY:/);
    expect(compose).toContain(
      "file: ${CHANNEL_CREDENTIAL_ENCRYPTION_KEY_V1_FILE:?CHANNEL_CREDENTIAL_ENCRYPTION_KEY_V1_FILE is required}",
    );
    expect(compose).toContain(
      "file: ${CHANNEL_CREDENTIAL_FINGERPRINT_KEY_FILE:?CHANNEL_CREDENTIAL_FINGERPRINT_KEY_FILE is required}",
    );
    expect(web).toContain("TOTP_ENCRYPTION_KEY");
    expect(worker).not.toContain("TOTP_ENCRYPTION_KEY");
    expect(worker).toContain("WORKER_TASK_ALLOWLIST: ${WORKER_TASK_ALLOWLIST:?WORKER_TASK_ALLOWLIST is required}");
  });

  it("requires the deployment origin, timezone, tracking salt, and worker allowlist", () => {
    for (const name of ["web", "worker", "scheduler"]) {
      expect(serviceBlock(name)).toContain("SITE_URL: ${SITE_URL:?SITE_URL is required}");
      expect(serviceBlock(name)).toContain("TZ: ${TZ:?TZ is required}");
    }
    expect(serviceBlock("web")).toContain(
      "TRACKING_HASH_SALT: ${TRACKING_HASH_SALT:?TRACKING_HASH_SALT is required}",
    );
    expect(compose).not.toMatch(/WORKER_TASK_ALLOWLIST:\s*credential/);
  });

  it("passes the bounded promo readback policy only to the worker", () => {
    const worker = serviceBlock("worker");
    const web = serviceBlock("web");
    const scheduler = serviceBlock("scheduler");
    expect(worker).toContain(
      "PROMO_LINK_CLAIM_READBACK_ATTEMPTS: ${PROMO_LINK_CLAIM_READBACK_ATTEMPTS:-3}",
    );
    expect(worker).toContain(
      "PROMO_LINK_CLAIM_READBACK_INTERVAL_MS: ${PROMO_LINK_CLAIM_READBACK_INTERVAL_MS:-2000}",
    );
    expect(web).not.toContain("PROMO_LINK_CLAIM_READBACK_ATTEMPTS");
    expect(scheduler).not.toContain("PROMO_LINK_CLAIM_READBACK_ATTEMPTS");
    expect(envExample).toContain("PROMO_LINK_CLAIM_READBACK_ATTEMPTS=3");
    expect(envExample).toContain("PROMO_LINK_CLAIM_READBACK_INTERVAL_MS=2000");
    expect(releaseChecklist).toContain("PROMO_LINK_CLAIM_READBACK_ATTEMPTS=3");
    expect(releaseChecklist).toContain("PROMO_LINK_CLAIM_READBACK_INTERVAL_MS=2000");
    expect(releaseChecklist).toContain("getcode` 仍严格零 retry");
  });

  it("passes all ten double-gate variables only to their relevant processes, default off", () => {
    const expectedByService = {
      web: DOUBLE_GATE_FLAGS.filter((flag) => !flag.includes("INDEXNOW_DELIVERY")),
      worker: DOUBLE_GATE_FLAGS.filter((flag) => !flag.includes("INDEXNOW_OUTBOX")),
      scheduler: ["FEATURE_INDEXNOW_DELIVERY", "INDEXNOW_DELIVERY_ALLOW_WRITE"],
    };
    for (const [name, flags] of Object.entries(expectedByService)) {
      const block = serviceBlock(name);
      for (const flag of flags) {
        expect(block).toContain(`${flag}: \${${flag}:-false}`);
      }
    }
    expect(serviceBlock("web")).not.toMatch(/INDEXNOW_DELIVERY/);
    expect(serviceBlock("worker")).not.toMatch(/INDEXNOW_OUTBOX/);
    for (const flag of DOUBLE_GATE_FLAGS) {
      expect(compose).toContain(`${flag}: \${${flag}:-false}`);
    }
  });

  it("starts content, settings, and task capabilities at super_admin", () => {
    const web = serviceBlock("web");
    for (const capability of [
      "CONTENT_VIEW",
      "CONTENT_READ",
      "CONTENT_PUBLISH",
      "SETTINGS_MANAGE",
      "TASK_MANAGE",
    ]) {
      expect(web).toContain(`${capability}_ROLES: \${${capability}_ROLES:-super_admin}`);
      expect(web).toContain(`${capability}_USER_IDS: \${${capability}_USER_IDS:-}`);
    }
  });

  it("shares the fixed static Sitemap directory between UID 1001 Web and Worker", () => {
    for (const name of ["web", "worker"]) {
      const block = serviceBlock(name);
      expect(block).toContain("SITEMAP_STATIC_DIR: /app/runtime/static-sitemaps");
      expect(block).toContain("sitemap_static:/app/runtime/static-sitemaps");
    }
    expect(compose).toMatch(/\n  sitemap_static:\s*$/m);
    expect(dockerfile).toContain("mkdir -p /app/runtime/static-sitemaps");
    expect(dockerfile).toContain("chown -R nextjs:nodejs /app/runtime");
    expect(dockerfile.indexOf("mkdir -p /app/runtime/static-sitemaps")).toBeLessThan(
      dockerfile.indexOf("USER nextjs"),
    );
  });

  it("passes preview and worker failure reporter runtime controls", () => {
    const worker = serviceBlock("worker");
    for (const variable of [
      "MOBOREADER_CATALOG_SAFETY_MAX_PAGES",
      "MOBOREADER_PREVIEW_CHUNK_SIZE",
      "MOBOREADER_PREVIEW_CONCURRENCY",
      "MOBOREADER_PREVIEW_TIMEOUT_MS",
      "MOBOREADER_PREVIEW_FRESHNESS_MS",
      "MOBOREADER_PREVIEW_SOURCE_APP_CODES",
      "MOBOREADER_PREVIEW_SOURCE_ITEM_ALLOWLIST",
      "WORKER_FAILURE_WEBHOOK_URL",
      "WORKER_FAILURE_WEBHOOK_TIMEOUT_MS",
      "WORKER_FAILURE_WEBHOOK_COOLDOWN_SECONDS",
    ]) {
      expect(worker).toContain(`${variable}:`);
    }
  });

  it("documents the exact staged worker allowlist and X11 delivery hard gate", () => {
    expect(envExample).toContain(
      "WORKER_TASK_ALLOWLIST=credential.validate.v1,credential.supersede.v1,catalog_scan",
    );
    expect(envExample).toContain("After the C2b parser fix is accepted, append: moboreader.preview_refresh.v1");
    expect(envExample).toContain("With the claim double-gates in the SAME release change, append: promo_link.claim.v1");
    expect(envExample).toContain("With the Sitemap write-gate in the SAME release change, append: sitemap_refresh");
    expect(envExample).toContain("Only after X11 schedule/dedup/misfire=skip/worker-sweep acceptance");
    expect(envExample).toContain("IndexNow delivery double-gates in the SAME release change, append: indexnow_delivery");
    expect(envExample.match(/^WORKER_TASK_ALLOWLIST=/gm)).toHaveLength(1);
  });

  it("lists the complete required image, database, secret-file, and key inventory", () => {
    for (const variable of [
      "CPS_NOVEL_APP_IMAGE",
      "APP_VERSION",
      "GIT_COMMIT",
      "BUILD_DATE",
      "NEXT_PUBLIC_BUILD_VERSION",
      "P1_12_MIGRATION_DATABASE_URL",
      "P1_12_WEB_DATABASE_URL",
      "P1_12_WORKER_DATABASE_URL",
      "P1_12_SCHEDULER_DATABASE_URL",
      "P1_12_POSTGRES_ADMIN_PASSWORD_FILE",
      "P1_12_MIGRATION_OWNER_PASSWORD_FILE",
      "P1_12_WEB_APP_PASSWORD_FILE",
      "P1_12_WORKER_APP_PASSWORD_FILE",
      "P1_12_SCHEDULER_APP_PASSWORD_FILE",
      "P1_12_ANALYST_RO_PASSWORD_FILE",
      "P1_12_BACKUP_ROLE_PASSWORD_FILE",
      "TOTP_ENCRYPTION_KEY",
      "CHANNEL_CREDENTIAL_ACTIVE_KEY_VERSION",
      "CHANNEL_CREDENTIAL_ENCRYPTION_KEY_V1_FILE",
      "CHANNEL_CREDENTIAL_FINGERPRINT_KEY_FILE",
      "SITE_URL",
      "TRACKING_HASH_SALT",
      "TZ",
    ]) {
      expect(envExample).toMatch(new RegExp(`^${variable}=`, "m"));
    }
  });

  it("makes the local Compose helper satisfy every new fail-closed input", () => {
    const helper = read("scripts/lib/p1-12-local-env.sh");
    expect(helper).toContain('write_secret_once "$P1_12_SECRET_DIR/tracking-hash-salt.key" base64');
    expect(helper).toContain('export CHANNEL_CREDENTIAL_ENCRYPTION_KEY_V1_FILE="$P1_12_SECRET_DIR/credential-v1.key"');
    expect(helper).toContain('export CHANNEL_CREDENTIAL_FINGERPRINT_KEY_FILE="$P1_12_SECRET_DIR/credential-fingerprint.key"');
    expect(helper).not.toMatch(/export CHANNEL_CREDENTIAL_ENCRYPTION_KEY_V1=/);
    expect(helper).not.toMatch(/export CHANNEL_CREDENTIAL_FINGERPRINT_KEY=/);
    for (const variable of [
      "NEXT_PUBLIC_BUILD_VERSION",
      "TRACKING_HASH_SALT",
      "SITE_URL",
      "TZ",
      "WORKER_TASK_ALLOWLIST",
      "MOBOREADER_PREVIEW_SOURCE_APP_CODES",
      "CHANNEL_CREDENTIAL_ACTIVE_KEY_VERSION",
    ]) {
      expect(helper).toContain(`export ${variable}=`);
    }
  });

  it("keeps Scheduler free of credential/TOTP/recovery keys and indirect env files", () => {
    const scheduler = serviceBlock("scheduler");
    expect(scheduler).toContain("P1_12_SCHEDULER_DATABASE_URL");
    expect(scheduler).not.toMatch(/CHANNEL_CREDENTIAL|FINGERPRINT|TOTP|RECOVERY|DECRYPT/i);
    expect(compose).not.toMatch(/env_file:/);
  });

  it("sets non-root application users, healthchecks, and bounded json-file logs", () => {
    expect(compose).toContain('user: "1001:1001"');
    expect(dockerfile).toContain("USER nextjs");
    for (const name of ["postgres", "web", "worker", "scheduler"]) {
      expect(serviceBlock(name)).toContain("healthcheck:");
    }
    expect(compose).toContain("max-size: 10m");
    expect(compose).toContain('max-file: "3"');
  });

  it("runs Credential secret preflight before Web or Worker starts serving work", () => {
    const web = serviceBlock("web");
    const webStart = read("scripts/start-web.sh");
    const workerStart = read("worker/index.ts");
    expect(web).toContain('command: ["bash", "scripts/start-web.sh"]');
    expect(webStart.indexOf("credential-secret-preflight.ts")).toBeLessThan(
      webStart.indexOf("exec node server.js"),
    );
    expect(workerStart.indexOf("assertCredentialKeyringReady(process.env)")).toBeLessThan(
      workerStart.indexOf("const prisma = new PrismaClient()"),
    );
  });

  it("bakes one immutable metadata file and aligned OCI labels from required args", () => {
    expect(dockerfile).toContain("ARG NODE_BASE_IMAGE=node:20-alpine@sha256:");
    expect(dockerfile).toContain("FROM ${NODE_BASE_IMAGE} AS dependencies");
    expect(compose).toContain("NODE_BASE_IMAGE: ${P1_12_NODE_BASE_IMAGE:-node:20-alpine@sha256:");
    for (const argument of ["APP_VERSION", "GIT_COMMIT", "BUILD_DATE"]) {
      expect(dockerfile).toContain(`ARG ${argument}`);
      expect(compose).toContain(`${argument}: \${${argument}:?${argument} is required}`);
    }
    expect(compose).toContain(
      "NEXT_PUBLIC_BUILD_VERSION: ${NEXT_PUBLIC_BUILD_VERSION:?NEXT_PUBLIC_BUILD_VERSION is required}",
    );
    expect(dockerfile).toContain("ARG NEXT_PUBLIC_BUILD_VERSION");
    expect(dockerfile).toContain("ENV NEXT_PUBLIC_BUILD_VERSION=${NEXT_PUBLIC_BUILD_VERSION}");
    expect(dockerfile).toContain('> /app/.build-metadata.json');
    expect(dockerfile).toContain("chmod 0444 /app/.build-metadata.json");
    expect(dockerfile).toContain('org.opencontainers.image.version="${APP_VERSION}"');
    expect(dockerfile).toContain('org.opencontainers.image.revision="${GIT_COMMIT}"');
    expect(dockerfile).toContain('org.opencontainers.image.created="${BUILD_DATE}"');
  });

  const dockerComposeAvailable = spawnSync("docker", ["compose", "version"], {
    stdio: "ignore",
  }).status === 0;

  it.skipIf(!dockerComposeAvailable)("Compose rejects an unset or empty allowlist and accepts an explicit one", () => {
    const baseEnv: NodeJS.ProcessEnv = {
      ...process.env,
      CPS_NOVEL_APP_IMAGE: "cps-novel:compose-contract",
      APP_VERSION: "0.1.0",
      GIT_COMMIT: "a".repeat(40),
      BUILD_DATE: "2026-08-26T00:00:00Z",
      NEXT_PUBLIC_BUILD_VERSION: "v0.1.0",
      P1_12_COMPOSE_PROJECT: "cps-novel-compose-contract",
      P1_12_WEB_DATABASE_URL: "postgresql://web:pw@postgres/cps_novel",
      P1_12_WORKER_DATABASE_URL: "postgresql://worker:pw@postgres/cps_novel",
      P1_12_SCHEDULER_DATABASE_URL: "postgresql://scheduler:pw@postgres/cps_novel",
      P1_12_POSTGRES_ADMIN_PASSWORD_FILE: "/tmp/postgres",
      P1_12_MIGRATION_OWNER_PASSWORD_FILE: "/tmp/migration",
      P1_12_WEB_APP_PASSWORD_FILE: "/tmp/web",
      P1_12_WORKER_APP_PASSWORD_FILE: "/tmp/worker",
      P1_12_SCHEDULER_APP_PASSWORD_FILE: "/tmp/scheduler",
      P1_12_ANALYST_RO_PASSWORD_FILE: "/tmp/analyst",
      P1_12_BACKUP_ROLE_PASSWORD_FILE: "/tmp/backup",
      SITE_URL: "https://novel.example",
      TRACKING_HASH_SALT: "compose-contract-salt",
      TZ: "Asia/Tokyo",
      TOTP_ENCRYPTION_KEY: "totp-contract-key",
      CHANNEL_CREDENTIAL_ACTIVE_KEY_VERSION: "1",
      CHANNEL_CREDENTIAL_ENCRYPTION_KEY_V1_FILE: "/tmp/credential-v1",
      CHANNEL_CREDENTIAL_FINGERPRINT_KEY_FILE: "/tmp/credential-fingerprint",
    };
    delete baseEnv.WORKER_TASK_ALLOWLIST;
    const runConfig = (env: NodeJS.ProcessEnv) => spawnSync(
      "docker",
      ["compose", "-f", resolve(root, "docker-compose.yml"), "config"],
      { cwd: root, env, encoding: "utf8" },
    );

    const unset = runConfig(baseEnv);
    expect(unset.status).not.toBe(0);
    expect(unset.stderr).toContain("WORKER_TASK_ALLOWLIST is required");

    const empty = runConfig({ ...baseEnv, WORKER_TASK_ALLOWLIST: "" });
    expect(empty.status).not.toBe(0);
    expect(empty.stderr).toContain("WORKER_TASK_ALLOWLIST is required");

    const valid = runConfig({
      ...baseEnv,
      WORKER_TASK_ALLOWLIST: "credential.validate.v1,credential.supersede.v1,catalog_scan",
    });
    expect(valid.status, valid.stderr).toBe(0);
  });

  it("keeps migrations one-shot and reuses the P1-06 roles and grants", () => {
    const launcher = read("scripts/p1-12-compose-up.sh");
    expect(launcher).toContain('up -d postgres');
    expect(launcher).toContain("existing exact image tag has mismatched immutable metadata");
    expect(launcher).toContain("prisma migrate deploy");
    expect(launcher).toContain("infra/postgres/grants.sql");
    expect(launcher.indexOf("prisma migrate deploy")).toBeLessThan(launcher.indexOf("up -d web worker scheduler"));
    expect(read("infra/postgres/init-roles.sh")).toContain("/opt/cps-novel-postgres/roles.sql");
  });

  it("starts the real Worker entry and loops the existing one-shot Scheduler entry", () => {
    expect(serviceBlock("worker")).toContain('command: ["tsx", "worker/index.ts"]');
    expect(serviceBlock("scheduler")).toContain('command: ["bash", "scripts/run-scheduler-loop.sh"]');
    expect(read("scripts/run-scheduler-loop.sh")).toContain("tsx scheduler/index.ts");
  });

  it("ships syntactically valid runtime shell scripts", () => {
    for (const path of [
      "infra/postgres/init-roles.sh",
      "scripts/lib/p1-12-local-env.sh",
      "scripts/p1-12-compose-up.sh",
      "scripts/run-scheduler-loop.sh",
      "scripts/run-p1-12-runtime-verification.sh",
    ]) {
      execFileSync("bash", ["-n", resolve(root, path)]);
    }
  });
});
