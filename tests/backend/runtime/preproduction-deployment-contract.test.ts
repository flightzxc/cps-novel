import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const text = (relative: string) => readFile(path.join(root, relative), "utf8");

describe("Phase 2B preproduction deployment contract", () => {
  it("keeps Host Nginx 1.24-compatible, fixed-host, protected, and anti-indexed", async () => {
    const nginx = await text("infra/preproduction/nginx/cps-novel-preprod.conf.template");
    const protectedSnippet = await text("infra/preproduction/nginx/cps-novel-preprod-protected.conf");
    const securitySnippet = await text("infra/preproduction/nginx/cps-novel-preprod-security.conf");
    expect(nginx).toContain("listen 443 ssl http2;");
    expect(nginx).not.toContain("http2 on;");
    expect(nginx).not.toMatch(/return 301[^;]*\$host/);
    expect(nginx).toContain("return 301 https://www.bangbangji.cloud$request_uri;");
    expect(nginx).toContain("return 301 https://zbcwf.bangbangji.cloud$request_uri;");
    expect(protectedSnippet).toContain("auth_basic_user_file /opt/cps-novel/shared/secrets/nginx-preprod.htpasswd");
    expect(protectedSnippet).toContain("cps-novel-preprod-security.conf");
    expect(securitySnippet).toContain('X-Robots-Tag "noindex, nofollow, noarchive" always');
    expect(nginx.match(/\.well-known\/acme-challenge/g)?.length).toBe(4);
    expect(nginx).toContain("limit_req_status 429;");
    expect(nginx).toContain("dashboard|novels|catalog-sync");
    expect(nginx).toContain("location ^~ /api/admin/");
  });

  it("pins stable Compose/data identity and closes dangerous preproduction writes", async () => {
    const rootCompose = await text("docker-compose.yml");
    const overlay = await text("infra/preproduction/docker-compose.yml");
    const env = await text("infra/preproduction/preprod.env.example");
    expect(rootCompose).toContain('"127.0.0.1:${P1_12_WEB_PORT:-3000}:3000"');
    expect(rootCompose).not.toMatch(/ports:[\s\S]{0,100}["']?5432:/);
    expect(rootCompose).toContain("PUBLIC_TRACKING_WRITE_DISABLED: ${PUBLIC_TRACKING_WRITE_DISABLED:-}");
    expect(rootCompose).toContain("stop_grace_period: ${WORKER_STOP_GRACE_PERIOD:-45s}");
    expect(overlay).toContain("name: cps_novel_runtime");
    expect(overlay).toContain("name: cps_novel_postgres_data");
    expect(overlay).toContain("name: cps_novel_sitemap_static");
    expect(env).toContain("P1_12_COMPOSE_PROJECT=cps-novel");
    expect(env).toContain("PUBLIC_TRACKING_WRITE_DISABLED=1");
    expect(env).toContain("FEATURE_ARTICLE_SEO_VISIBILITY=true");
    for (const closed of [
      "NOVEL_CATALOG_SYNC_ALLOW_WRITE=false",
      "PROMO_LINK_CLAIM_ALLOW_WRITE=false",
      "INDEXNOW_OUTBOX_ALLOW_WRITE=false",
      "INDEXNOW_DELIVERY_ALLOW_WRITE=false",
      "AUTO_WRITE_AUTHORIZED=NO",
      "ARTICLE_BLOG_ALLOW_WRITE=false",
      "ARTICLE_NOVEL_REBIND_ALLOW_WRITE=false",
    ]) expect(env).toContain(closed);
  });

  it("orders real service lifecycle and leaves failures in maintenance", async () => {
    const release = await text("scripts/preproduction/release.sh");
    const ordered = [
      "maintenance_on",
      "preprod_compose stop scheduler",
      "preprod_compose stop worker",
      "preprod_compose stop web",
      'database.sh\" migrate-approved',
      // Phase 2C：应用服务改走 preprod_compose_app_up（内含不可变工件闸门，见 lib.sh），
      // 生命周期顺序不变。
      "preprod_compose_app_up web",
      'verify-release.sh\"',
      "preprod_compose_app_up worker",
      "preprod_compose_app_up scheduler",
      "PREPROD_RELEASE_VERIFIED=YES maintenance_off",
    ];
    let offset = release.indexOf("deploy() {");
    for (const token of ordered) {
      const next = release.indexOf(token, offset);
      expect(next, token).toBeGreaterThan(offset);
      offset = next;
    }
    expect(release).toContain('echo "RELEASE=FAILED maintenance=ON"');
    expect(release).toContain("SCHEMA_COMPATIBLE_WITH_PREVIOUS");
    expect(release).not.toMatch(/migrate (down|reset)/);
  });

  it("refuses fresh init without exact empty-volume confirmation", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "preprod-db-test-"));
    const envFile = path.join(dir, "preprod.env");
    await writeFile(envFile, "P1_12_COMPOSE_PROJECT=cps-novel\n", { mode: 0o600 });
    const result = spawnSync("bash", [path.join(root, "scripts/preproduction/database.sh"), "fresh-init"], {
      env: { ...process.env, PREPROD_ENV_FILE: envFile }, encoding: "utf8",
    });
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain("explicit_empty_confirmation_required");
  });

  it("fails the persistent path when the stable volume is absent", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "preprod-db-test-"));
    const envFile = path.join(dir, "preprod.env");
    const bin = path.join(dir, "bin");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(bin));
    await writeFile(envFile, "P1_12_COMPOSE_PROJECT=cps-novel\n", { mode: 0o600 });
    const docker = path.join(bin, "docker");
    await writeFile(docker, "#!/usr/bin/env bash\nexit 1\n", { mode: 0o700 });
    const result = spawnSync("bash", [path.join(root, "scripts/preproduction/database.sh"), "persistent-check"], {
      env: { ...process.env, PREPROD_ENV_FILE: envFile, PATH: `${bin}:${process.env.PATH}` }, encoding: "utf8",
    });
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain("volume_missing");
  });

  it("rejects a TOTP-preserving account transfer when key identities differ", () => {
    const result = spawnSync("bash", [
      path.join(root, "scripts/preproduction/account-transfer.sh"), "export",
      "--file", "/tmp/never-created.dump", "--two-factor", "preserve",
    ], {
      env: {
        ...process.env,
        PGHOST: "invalid", PGPORT: "5432", PGDATABASE: "invalid", PGUSER: "invalid", PGPASSFILE: "/dev/null",
        SOURCE_TOTP_KEY_FINGERPRINT: "a".repeat(64), TARGET_TOTP_KEY_FINGERPRINT: "b".repeat(64),
      }, encoding: "utf8",
    });
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain("totp_key_identity_mismatch");
  });
});

describe("stable secret negative checks", () => {
  const required = [
    "postgres_admin_password", "migration_owner_password", "web_app_password", "worker_app_password",
    "scheduler_app_password", "analyst_ro_password", "backup_role_password", "backup_role.pgpass",
    "channel_credential_encryption_key_v1", "channel_credential_fingerprint_key", "totp_encryption_key",
    "tracking_hash_salt", "nginx-preprod.htpasswd", "preprod-curl.conf", "admin-smoke-password",
  ];
  const identities = ["channel_credential_encryption_key_v1", "channel_credential_fingerprint_key", "totp_encryption_key", "tracking_hash_salt"];

  async function fixture() {
    const dir = await mkdtemp(path.join(tmpdir(), "preprod-secrets-"));
    for (const name of required) await writeFile(path.join(dir, name), `${name}-fixture\n`, { mode: 0o640 });
    const lines = await Promise.all(identities.map(async (name) => {
      const value = await readFile(path.join(dir, name));
      return `${createHash("sha256").update(value).digest("hex")}  ${name}`;
    }));
    await writeFile(path.join(dir, "secret-identity.sha256"), `${lines.join("\n")}\n`, { mode: 0o600 });
    return dir;
  }

  function check(dir: string) {
    return spawnSync("bash", [path.join(root, "scripts/preproduction/secrets-preflight.sh"), "--host-only"], {
      env: { ...process.env, PREPROD_SECRET_ROOT: dir, PREPROD_TEST_MODE: "1" }, encoding: "utf8",
    });
  }

  it("passes without disclosing values, then rejects broad permissions", async () => {
    const dir = await fixture();
    const pass = check(dir);
    expect(pass.status).toBe(0);
    expect(pass.stdout).toContain("SECRET_CONSUMER_MATRIX=PASS count=15");
    expect(pass.stdout).toContain("SECRET_PREFLIGHT=HOST_ONLY CONSUMER_ACCESS=UNVERIFIED");
    expect(pass.stdout).not.toContain("SECRET_PREFLIGHT=PASS");
    await chmod(path.join(dir, "web_app_password"), 0o644);
    const fail = check(dir);
    expect(fail.status).not.toBe(0);
    expect(fail.stdout).toContain("SECRET_PREFLIGHT=FAIL reason=secret_mode");
  });

  it("rejects stable encryption identity drift", async () => {
    const dir = await fixture();
    await writeFile(path.join(dir, "totp_encryption_key"), "different\n", { mode: 0o640 });
    const result = check(dir);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain("SECRET_PREFLIGHT=FAIL reason=secret_identity_mismatch");
  });
});
