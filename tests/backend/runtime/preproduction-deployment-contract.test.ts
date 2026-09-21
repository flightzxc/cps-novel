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

  it("exempts /api/health from the maintenance gate without weakening auth, and allowlists admin static assets minimally", async () => {
    const nginx = await text("infra/preproduction/nginx/cps-novel-preprod.conf.template");
    const protectedSnippet = await text("infra/preproduction/nginx/cps-novel-preprod-protected.conf");
    const nomaintenanceSnippet = await text("infra/preproduction/nginx/cps-novel-preprod-protected-nomaintenance.conf");

    // The nomaintenance snippet must keep Basic Auth and the security
    // headers, but must NOT gate on the maintenance marker -- that `if`
    // runs in the rewrite phase, before auth_basic's access phase, so
    // leaving it in would make maintenance win over authentication again.
    expect(protectedSnippet).toContain("if (-f /opt/cps-novel/shared/maintenance/enabled) { return 503; }");
    expect(nomaintenanceSnippet).not.toContain("maintenance/enabled");
    expect(nomaintenanceSnippet).not.toMatch(/return 503/);
    expect(nomaintenanceSnippet).toContain('auth_basic "CPS Novel Preproduction";');
    expect(nomaintenanceSnippet).toContain("auth_basic_user_file /opt/cps-novel/shared/secrets/nginx-preprod.htpasswd");
    expect(nomaintenanceSnippet).toContain("cps-novel-preprod-security.conf");

    // Both hosts' /api/health locations must be exact matches on the
    // nomaintenance snippet -- a `^~` prefix on the admin host previously
    // also matched /api/health-anything (measured evidence).
    const publicHealth = nginx.indexOf("location = /api/health {");
    expect(publicHealth).toBeGreaterThan(-1);
    expect(nginx).not.toContain("location ^~ /api/health");
    const occurrences = nginx.split("location = /api/health {").length - 1;
    expect(occurrences).toBe(2);
    // Each exact-match /api/health block must include the nomaintenance
    // snippet, not the maintenance-gated one.
    for (const block of nginx.split("location = /api/health {").slice(1)) {
      const body = block.slice(0, block.indexOf("\n    }"));
      expect(body).toContain("cps-novel-preprod-protected-nomaintenance.conf");
    }

    // Admin host gets exactly one new asset location: /_next/static/ only.
    // No next/image import exists under src/app/(admin) or
    // src/app/(admin-auth), so /_next/image and /favicon.ico are
    // deliberately not allowlisted.
    expect(nginx).toContain("location ^~ /_next/static/");
    expect(nginx.split("location ^~ /_next/static/").length - 1).toBe(2);
    expect(nginx).not.toContain("/_next/image");
    expect(nginx).not.toContain("favicon.ico");

    // IPv6 stays unserved everywhere; this is a recorded decision, not an
    // oversight. Matched as an active directive (start of a non-comment
    // line), not a substring, since the file's own comment explains the
    // decision using that same bracket syntax in prose.
    expect(nginx).not.toMatch(/^\s*listen \[::]/m);
  });

  it("keeps the protected and nomaintenance nginx snippets from diverging", async () => {
    const protectedSnippet = await text("infra/preproduction/nginx/cps-novel-preprod-protected.conf");
    const nomaintenanceSnippet = await text("infra/preproduction/nginx/cps-novel-preprod-protected-nomaintenance.conf");

    // Real divergence test, not just an itemized allowlist of expected
    // lines in the sibling test: the nomaintenance snippet's non-comment,
    // non-blank lines must equal the protected snippet's non-comment,
    // non-blank lines with exactly the maintenance `if` gate removed.
    // Anything else that diverges between the two (a changed
    // auth_basic_user_file path, a dropped security-header include, an
    // extra directive added to one but not the other) fails here instead of
    // only being caught if it happens to collide with one of the itemized
    // assertions elsewhere -- this is the test the ADR's Consequences
    // section actually claims exists.
    const functionalLines = (source: string) =>
      source.split("\n").map((line) => line.trim()).filter((line) => line.length > 0 && !line.startsWith("#"));
    const protectedFunctional = functionalLines(protectedSnippet).filter((line) => !line.includes("maintenance/enabled"));
    expect(functionalLines(nomaintenanceSnippet)).toEqual(protectedFunctional);
  });

  it("keeps the bootstrap stage HTTP-only and incapable of serving application content", async () => {
    const bootstrap = await text("infra/preproduction/nginx/cps-novel-preprod-bootstrap.conf.template");
    expect(bootstrap).not.toContain("ssl_certificate");
    expect(bootstrap).not.toContain("proxy_pass");
    expect(bootstrap).not.toContain("upstream");
    expect(bootstrap).not.toMatch(/^\s*listen \[::]/m);
    expect(bootstrap).toContain("listen 80 default_server;");
    expect(bootstrap).toContain("server_name www.bangbangji.cloud;");
    expect(bootstrap).toContain("server_name zbcwf.bangbangji.cloud;");
    expect(bootstrap.match(/\.well-known\/acme-challenge/g)?.length).toBe(2);
    expect(bootstrap).toContain("cps-novel-preprod-security.conf");
  });

  it("hands the default site over before testing, and only reloads after a passing test", async () => {
    const install = await text("scripts/preproduction/install-nginx.sh");
    const defaultSiteOffset = install.indexOf("sites-enabled/default");
    const firstNginxTestOffset = install.indexOf("nginx -t");
    expect(defaultSiteOffset).toBeGreaterThan(-1);
    expect(firstNginxTestOffset).toBeGreaterThan(-1);
    expect(defaultSiteOffset).toBeLessThan(firstNginxTestOffset);
    // The site config is written to its live path before the test runs (see
    // report: this repo's nginx.conf glob only picks up files at fixed
    // system paths, so there is no way to `nginx -t` a candidate without
    // placing it there); a full rollback of every touched path is the
    // safety net instead of a reload-before-test ordering bug.
    expect(install).toContain("rollback_all");
    expect(install).toContain("--bootstrap");
    expect(install.indexOf("rollback_all")).toBeLessThan(install.indexOf("systemctl reload nginx"));
  });

  it("never destroys nginx backups on interrupt, and restore_one fails closed (MAJOR-3/MINOR-6)", async () => {
    const install = await text("scripts/preproduction/install-nginx.sh");

    // Only the disposable rendered-candidate file is auto-deleted; the old
    // combined trap also wiped $file_backup_dir on INT/TERM, which is what
    // let a SIGTERM during `sudo nginx -t` destroy the live site config
    // (see release-path reviewer finding MAJOR-3).
    expect(install).toContain('trap \'rm -f "$rendered"\' EXIT');
    // No trap is registered for INT/TERM at all any more (only the disposable
    // rendered-candidate file is cleaned up automatically, via EXIT above).
    // `rm -rf "$file_backup_dir"` legitimately still appears elsewhere, as
    // explicit cleanup on the two confirmed-successful exit paths near the
    // bottom of the script -- what must never happen is that cleanup running
    // from an INT/TERM trap, which is what this asserts against.
    expect(install).not.toMatch(/trap[^\n]*INT TERM/);
    expect(install).not.toMatch(/trap[^\n]*rm -rf "\$file_backup_dir"/);

    // restore_one must refuse to delete a live file when the backup
    // directory itself is missing/unreadable, rather than reading "no
    // backup" as "this file should not exist".
    const restoreOneStart = install.indexOf("restore_one() {");
    expect(restoreOneStart).toBeGreaterThan(-1);
    const restoreOneBody = install.slice(restoreOneStart, install.indexOf("sudo rm -f \"$dst\"", restoreOneStart));
    expect(restoreOneBody).toContain("backup_dir_missing");
    expect(restoreOneBody).toMatch(/!\s*-d\s*"\$file_backup_dir"/);

    // MINOR-6: a rollback that restores a state which itself fails `nginx
    // -t` must be reported distinctly and must not reload -- not silently
    // swallowed by `set -e` with no NGINX_INSTALL= line, and not the same
    // reason as an ordinary candidate-config test failure.
    expect(install).toContain("reason=rollback_state_invalid");
    const secondTestOffset = install.indexOf("if sudo nginx -t; then");
    expect(secondTestOffset).toBeGreaterThan(install.indexOf("rollback_all\n"));
    const invalidReasonOffset = install.indexOf("reason=rollback_state_invalid");
    expect(invalidReasonOffset).toBeGreaterThan(secondTestOffset);
    // The only reload between the second `nginx -t` and the distinct
    // REFUSED line must be inside that `if` block's own success branch
    // (the ordinary nginx_test_failed path) -- not on the failure path that
    // falls through to reason=rollback_state_invalid. Anchor on the
    // success branch's closing `exit 65\n  fi` (2-space indent, matching
    // the outer `if sudo nginx -t; then`) and assert no further reload
    // exists after it, before the distinct reason.
    const successBranchEnd = install.indexOf("exit 65\n  fi\n", secondTestOffset);
    expect(successBranchEnd).toBeGreaterThan(secondTestOffset);
    const afterSuccessBranch = install.slice(successBranchEnd, invalidReasonOffset);
    expect(afterSuccessBranch).not.toContain("systemctl reload nginx");

    // The default-site backup/state files are restored FROM inside
    // rollback_all() (a `cp -a`, still expected there) but must not be
    // DELETED there -- that must wait until the caller's post-rollback
    // `nginx -t` has actually confirmed success (MINOR-6's ordering fix).
    const rollbackAllBody = install.slice(install.indexOf("rollback_all() {"), install.indexOf("if ! sudo nginx -t; then"));
    expect(rollbackAllBody).toContain('sudo cp -a "$default_site_backup" "$default_site"');
    expect(rollbackAllBody).not.toContain('rm -f "$default_site_backup"');
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
      // MAJOR-1 fix: the full verify-release.sh call above always runs
      // while maintenance is still on, so its anonymous-surface 401
      // expectations are dead code in the only automated path unless a
      // SECOND, cheap call happens after maintenance_off and before
      // RELEASE=PASS.
      'verify-release.sh\" --anonymous-only',
    ];
    let offset = release.indexOf("deploy() {");
    for (const token of ordered) {
      const next = release.indexOf(token, offset);
      expect(next, token).toBeGreaterThan(offset);
      offset = next;
    }
    expect(release.indexOf('verify-release.sh" --anonymous-only')).toBeLessThan(release.indexOf('echo "RELEASE=PASS"'));
    expect(release).toContain('echo "RELEASE=FAILED maintenance=ON"');
    expect(release).toContain("SCHEMA_COMPATIBLE_WITH_PREVIOUS");
    expect(release).not.toMatch(/migrate (down|reset)/);
  });

  it("rollback() also re-verifies anonymous surfaces after maintenance_off, before ROLLBACK=PASS", async () => {
    const release = await text("scripts/preproduction/release.sh");
    const rollbackStart = release.indexOf("rollback() {");
    expect(rollbackStart).toBeGreaterThan(-1);
    const ordered = [
      "maintenance_on",
      "preprod_compose stop scheduler",
      "preprod_compose stop worker",
      "preprod_compose stop web",
      "preprod_compose_app_up web",
      'verify-release.sh\"',
      "preprod_compose_app_up worker",
      "preprod_compose_app_up scheduler",
      "PREPROD_RELEASE_VERIFIED=YES maintenance_off",
      // MAJOR-1 fix, same reasoning as deploy() above.
      'verify-release.sh\" --anonymous-only',
    ];
    let offset = rollbackStart;
    for (const token of ordered) {
      const next = release.indexOf(token, offset);
      expect(next, token).toBeGreaterThan(offset);
      offset = next;
    }
    expect(release.indexOf('verify-release.sh" --anonymous-only', rollbackStart)).toBeLessThan(
      release.indexOf('echo "ROLLBACK=PASS"'),
    );
    expect(release).toContain('echo "ROLLBACK=FAILED maintenance=ON"');
  });

  it("rollback() replays the previous release's grants before bringing the app back up", async () => {
    const release = await text("scripts/preproduction/release.sh");
    const rollbackStart = release.indexOf("rollback() {");
    expect(rollbackStart).toBeGreaterThan(-1);
    // MAJOR-2 fix: rollback() must replay the previous release's own
    // grants.sql (this checkout's copy, since rollback runs from the
    // previous immutable release directory) before the app comes back up --
    // otherwise the restored old app keeps running against whatever grants
    // the release being rolled back FROM last committed.
    const ordered = [
      "preprod_compose stop web",
      // The redirect form (`<"$root/...`) is matched, not a bare substring,
      // so this finds the actual command rather than its own header
      // comment (which also mentions the path in prose).
      '<"$root/infra/postgres/grants.sql"',
      "preprod_compose_app_up web",
    ];
    let offset = rollbackStart;
    for (const token of ordered) {
      const next = release.indexOf(token, offset);
      expect(next, token).toBeGreaterThan(offset);
      offset = next;
    }
    // The grants replay uses the identical shape database.sh's
    // migrate-approved case uses.
    const grantsReplayOffset = release.indexOf('<"$root/infra/postgres/grants.sql"', rollbackStart);
    expect(grantsReplayOffset).toBeGreaterThan(-1);
    const rollbackGrantsCommand = release.slice(
      release.lastIndexOf("preprod_compose exec", grantsReplayOffset),
      grantsReplayOffset,
    );
    expect(rollbackGrantsCommand).toContain("-U postgres");
    expect(rollbackGrantsCommand).toContain("--single-transaction");
    expect(rollbackGrantsCommand).toContain("-v ON_ERROR_STOP=1");
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
    // Reason lines for `persistent-check` go to stderr, not stdout: the only
    // production caller runs `database.sh persistent-check >/dev/null`
    // (scripts/preproduction/verify-release.sh:108), so a reason printed to
    // stdout would be silently swallowed there -- see
    // scripts/preproduction/lib.sh's own comment on this exact trap
    // ("拒绝走 stderr、PASS 走 stdout"), which database.sh's persistent-check
    // case now follows for every FAIL/REFUSED line.
    expect(result.stderr).toContain("volume_missing");
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
