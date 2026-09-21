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
    // also matched /api/health-anything (measured evidence). A bare `^~
    // /api/health` (no trailing slash) prefix must not exist anywhere, but
    // `^~ /api/health/` (WITH a trailing slash, MINOR-7 fix) legitimately
    // does, on the admin host only, to keep /api/health/worker and
    // /api/health/backup reachable -- distinguish the two by requiring a
    // non-slash character right after "/api/health" for the banned form.
    const publicHealth = nginx.indexOf("location = /api/health {");
    expect(publicHealth).toBeGreaterThan(-1);
    expect(nginx).not.toMatch(/location \^~ \/api\/health[^/]/);
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

  it("MINOR-7: restores /api/health/ sub-route coverage on the admin host without reopening the prefix-match hole", async () => {
    const nginx = await text("infra/preproduction/nginx/cps-novel-preprod.conf.template");

    // /api/health/worker and /api/health/backup (see src/app/api/health/)
    // were served by the old `^~ /api/health` prefix match before it was
    // narrowed to the exact `=` match to close the /api/health-anything
    // hole. The admin-only sub-route block below must exist exactly once,
    // be maintenance-gated (protected.conf), and deliberately NOT reuse the
    // nomaintenance snippet -- only the exact-match /api/health block is
    // exempt from maintenance.
    expect(nginx.split("location ^~ /api/health/ {").length - 1).toBe(1);
    const healthSubrouteStart = nginx.indexOf("location ^~ /api/health/ {");
    const healthSubrouteBody = nginx.slice(healthSubrouteStart, nginx.indexOf("\n    }", healthSubrouteStart));
    expect(healthSubrouteBody).toContain("cps-novel-preprod-protected.conf");
    expect(healthSubrouteBody).not.toContain("cps-novel-preprod-protected-nomaintenance.conf");
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
    // N2 fix: install-nginx.sh DOES register INT/TERM handlers again -- but
    // only to echo the retained (mktemp-random, otherwise anonymous)
    // $file_backup_dir path before re-raising the signal, never to delete
    // anything. `rm -rf "$file_backup_dir"` legitimately still appears
    // elsewhere, as explicit cleanup on the two confirmed-successful exit
    // paths near the bottom of the script -- what must never happen is that
    // cleanup running from an INT/TERM handler, which is what this still
    // asserts against.
    expect(install).toMatch(/trap 'on_interrupt INT' INT/);
    expect(install).toMatch(/trap 'on_interrupt TERM' TERM/);
    const onInterruptStart = install.indexOf("on_interrupt() {");
    expect(onInterruptStart).toBeGreaterThan(-1);
    const onInterruptBody = install.slice(onInterruptStart, install.indexOf("\n}", onInterruptStart));
    expect(onInterruptBody).toContain('echo "NGINX_INSTALL_INTERRUPTED backup_dir=$file_backup_dir" >&2');
    expect(onInterruptBody).not.toMatch(/\brm\b/);
    // It must also re-raise the signal (not swallow it and let the script
    // carry on past the point it was told to stop): reset the disposition to
    // default, then send itself the same signal it caught.
    expect(onInterruptBody).toContain('trap - INT TERM');
    expect(onInterruptBody).toContain('kill -s "$1" "$$"');
    expect(install).not.toMatch(/trap[^\n]*rm -rf "\$file_backup_dir"/);

    // N2 fix: every REFUSED line that deliberately keeps $file_backup_dir
    // around now names it, so an operator re-running after either of these
    // doesn't have to guess which anonymous /tmp directory is the one that
    // matters.
    expect(install).toContain("reason=backup_dir_missing backup_dir=$file_backup_dir");
    expect(install).toContain("reason=rollback_state_invalid backup_dir=$file_backup_dir");

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

  it("N1: keeps the default-site handover record after a successful install, on both success paths", async () => {
    const install = await text("scripts/preproduction/install-nginx.sh");

    // Before this fix, `sudo rm -f "$default_site_backup" "$default_site_state"`
    // ran on both confirmed-successful exit paths -- the ordinary
    // NGINX_INSTALL=PASS path at the bottom, and the "rolled back to a
    // config that itself now passes nginx -t" branch of the
    // reason=nginx_test_failed path above it. For Ubuntu's stock
    // `kind=symlink` default site the target under sites-available/ still
    // survives that deletion, but for a `kind=file` default site the
    // content becomes unrecoverable the moment those two lines run. This is
    // the load-bearing guard: that exact deletion command must not exist
    // anywhere in the file any more, on either path. (The explanatory
    // comments near both success paths legitimately mention the variable
    // names in prose, so this checks for the `sudo rm -f` command shape
    // specifically, not a bare substring match on the names.)
    expect(install).not.toMatch(/sudo rm -f "\$default_site_backup"/);
    expect(install).not.toMatch(/sudo rm -f "\$default_site_state"/);
    expect(install).not.toMatch(/rm -f "\$default_site_backup" "\$default_site_state"/);

    // $file_backup_dir (the snippet/site-config backups) is still genuinely
    // disposable and must still be cleaned up on both confirmed-successful
    // exit paths -- this fix must not have also swept that cleanup away.
    // Anchor each `rm -rf "$file_backup_dir"` to its own success path by
    // requiring it appear before that path's own REFUSED/PASS line.
    const finalPassIndex = install.lastIndexOf('echo "NGINX_INSTALL=PASS"');
    const finalCleanupIndex = install.lastIndexOf('rm -rf "$file_backup_dir"', finalPassIndex);
    expect(finalCleanupIndex).toBeGreaterThan(-1);
    expect(finalCleanupIndex).toBeLessThan(finalPassIndex);

    const nginxTestFailedIndex = install.indexOf("reason=nginx_test_failed");
    expect(nginxTestFailedIndex).toBeGreaterThan(-1);
    const rollbackSuccessCleanupIndex = install.lastIndexOf('rm -rf "$file_backup_dir"', nginxTestFailedIndex);
    expect(rollbackSuccessCleanupIndex).toBeGreaterThan(-1);
    expect(rollbackSuccessCleanupIndex).toBeLessThan(nginxTestFailedIndex);
    // The two cleanup sites must be genuinely distinct occurrences (one per
    // success path), not the same line matched twice.
    expect(rollbackSuccessCleanupIndex).not.toBe(finalCleanupIndex);

    // A later run must not trip over the retained files: the write side
    // (recording $default_site_state and $default_site_backup) only runs
    // inside the block gated on $default_site itself still existing -- a
    // successful prior run already `rm -f`'d it -- so the whole handover,
    // including this write, is naturally skipped on the next invocation,
    // and default_site_disabled stays 0.
    const handoverGuardIndex = install.indexOf('if { [[ -e "$default_site" ]] || [[ -L "$default_site" ]]; }');
    expect(handoverGuardIndex).toBeGreaterThan(-1);
    const handoverGuardEnd = install.indexOf("\nfi\n", handoverGuardIndex);
    expect(handoverGuardEnd).toBeGreaterThan(handoverGuardIndex);
    const handoverBody = install.slice(handoverGuardIndex, handoverGuardEnd);
    expect(handoverBody).toContain("default_site_state");
    expect(handoverBody).toContain('sudo cp -a "$default_site" "$default_site_backup"');
    expect(handoverBody).toContain('sudo rm -f "$default_site"');
    expect(handoverBody).toContain("default_site_disabled=1");
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
    // N3 fix: the post-maintenance_off call must pass --expect-live, so it
    // cannot pass vacuously by silently taking the 503 branch if the
    // maintenance marker were somehow still present.
    expect(release).toContain('verify-release.sh" --anonymous-only --expect-live');
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
    // N3 fix, same reasoning as deploy() above.
    expect(release.indexOf('verify-release.sh" --anonymous-only --expect-live', rollbackStart)).toBeGreaterThan(
      rollbackStart,
    );
  });

  it("N3: --expect-live makes the post-maintenance anonymous re-check self-checking, not vacuously passable", async () => {
    const verifyRelease = await text("scripts/preproduction/verify-release.sh");

    // The flag must be parsed independently of --anonymous-only (both can be
    // given together), not require a fixed single-positional order.
    expect(verifyRelease).toMatch(/--expect-live\)\s*expect_live=1/);

    // The maintenance-marker check must run BEFORE run_anonymous_matrix is
    // ever called in the anonymous_only branch -- otherwise the matrix's own
    // marker-aware 503 branch would already have consumed the "marker
    // present" case and returned PASS without this guard ever having a
    // chance to fire (the exact vacuous-pass shape this fix exists to
    // close).
    const anonymousOnlyBranchStart = verifyRelease.indexOf('if [[ "$mode" == "anonymous_only" ]]; then');
    expect(anonymousOnlyBranchStart).toBeGreaterThan(-1);
    // Anchor on the actual bare call (alone on its own 2-space-indented
    // line), not just the substring "run_anonymous_matrix" -- the comment
    // explaining this ordering legitimately names the function twice before
    // the real call does, so a bare indexOf would find the comment instead.
    const branchTail = verifyRelease.slice(anonymousOnlyBranchStart);
    const runMatrixCallMatch = /\n {2}run_anonymous_matrix\n/.exec(branchTail);
    expect(runMatrixCallMatch, `expected a bare run_anonymous_matrix call:\n${branchTail}`).not.toBeNull();
    const runMatrixCallIndex = anonymousOnlyBranchStart + (runMatrixCallMatch as RegExpExecArray).index;
    const expectLiveGuardIndex = verifyRelease.indexOf("expect_live", anonymousOnlyBranchStart);
    expect(expectLiveGuardIndex).toBeGreaterThan(anonymousOnlyBranchStart);
    expect(expectLiveGuardIndex).toBeLessThan(runMatrixCallIndex);

    const guardBody = verifyRelease.slice(expectLiveGuardIndex, runMatrixCallIndex);
    expect(guardBody).toMatch(/\[\[\s*-f\s*"\$maintenance_marker"\s*\]\]/);
    expect(guardBody).toContain("exit 65");
    expect(guardBody).toContain("RELEASE_VERIFY=FAIL");

    // release.sh must actually pass the flag on both post-maintenance calls
    // (also pinned directly on release.sh in the deploy()/rollback() tests
    // above; re-asserted here to keep this guard's own test self-contained).
    const release = await text("scripts/preproduction/release.sh");
    expect(release.split('verify-release.sh" --anonymous-only --expect-live').length - 1).toBe(2);
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

describe("verify-nginx-matrix.sh upstream-down case", () => {
  it("accepts both 502 and 504 as upstream-unreachable, and still asserts the anti-index header", async () => {
    const matrix = await text("scripts/preproduction/verify-nginx-matrix.sh");

    // Measured on the real (Linux) target with `bash -x`: once the mock
    // upstream container is stopped, Docker Desktop on macOS resets the
    // connection during proxy_pass (nginx -> 502), while native Linux
    // Docker leaves the SYN unanswered until `proxy_connect_timeout 3s`
    // fires (nginx -> 504). Both are the edge legitimately reporting
    // "upstream unreachable" for the same failure condition. Narrowing
    // this back to 502-only previously made the whole matrix die silently
    // under `set -e` (exit 1, zero output) on Linux -- pin both codes here
    // so that regression can't come back unnoticed.
    const stopOffset = matrix.indexOf('docker stop "$mock"');
    expect(stopOffset).toBeGreaterThan(-1);
    const nextBlankLine = matrix.indexOf("\n\n", stopOffset);
    const caseBody = matrix.slice(stopOffset, nextBlankLine === -1 ? matrix.length : nextBlankLine);

    expect(caseBody).toMatch(/\[\[\s*"\$code"\s*==\s*"502"\s*\|\|\s*"\$code"\s*==\s*"504"\s*\]\]/);
    expect(caseBody).toContain("case=upstream_down");
    expect(caseBody).toContain("exit 65");

    // The actual security invariant this case exists to protect: the
    // error response must still carry the anti-index header, whichever of
    // the two legitimate codes nginx returned. Must not be weakened while
    // relaxing the status-code check above.
    expect(caseBody).toContain('grep -qi \'^X-Robots-Tag: noindex, nofollow, noarchive\' "$tmp/headers"');
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

describe("preprod runtime network subnet must match the baked pg_hba.conf replication rule", () => {
  // Host incident (measured, not hypothetical): infra/preproduction/
  // docker-compose.yml's `runtime` network had no ipam config, so Docker
  // auto-allocated a subnet for cps_novel_runtime -- observed as
  // 172.16.1.0/24 on the affected host. infra/postgres/hba-replication-rule.sh
  // is sourced once, at initdb time, to append a pg_hba.conf rule for
  // backup_role scoped to X8_RUNTIME_SUBNET (default 172.18.0.0/16) --
  // and that rule is never re-derived afterward. The two subnets drifted
  // apart, so every replication connection was rejected ("no pg_hba.conf
  // entry for replication connection from host ..."), which made
  // pg_basebackup -- and therefore PITR -- impossible. This test pins the
  // fix (an explicit ipam block on the compose network) in place: if
  // either side's subnet changes without updating the other, the test
  // must fail for that reason, not pass by accident.
  //
  // There is a THIRD copy of this same default that must stay locked to
  // the other two: the base docker-compose.yml's
  // `postgres.environment.X8_RUNTIME_SUBNET` (`${X8_RUNTIME_SUBNET:-...}`)
  // is what actually gets read by infra/postgres/init-roles.sh (via
  // hba-replication-rule.sh) at real initdb time on the host -- it is the
  // value that ends up baked into the live pg_hba.conf. The preproduction
  // compose's `ipam.config[0].subnet` only pins the *network*; without
  // also pinning this third default, all static checks can pass while the
  // value actually baked into pg_hba.conf still drifts.

  function extractComposeRuntimeSubnet(composeYaml: string): string {
    // Top-level `networks:` key starts a line with no leading whitespace.
    // Slice from there to the next top-level key (or EOF) so we don't
    // accidentally match a `subnet:` that belongs to some other stanza.
    const networksIdx = composeYaml.search(/^networks:/m);
    expect(
      networksIdx,
      "expected a top-level `networks:` key in infra/preproduction/docker-compose.yml",
    ).toBeGreaterThanOrEqual(0);
    const afterNetworks = composeYaml.slice(networksIdx + "networks:".length);
    const nextTopLevelKeyIdx = afterNetworks.search(/\n[A-Za-z0-9_.-]+:/);
    const networksBlock =
      nextTopLevelKeyIdx === -1 ? afterNetworks : afterNetworks.slice(0, nextTopLevelKeyIdx);

    expect(
      networksBlock,
      "expected the `networks:` block to declare the `runtime` network named cps_novel_runtime",
    ).toMatch(/runtime:\s*\n\s*name:\s*cps_novel_runtime/);

    const subnetMatch = networksBlock.match(/ipam:\s*\n\s*config:\s*\n\s*-\s*subnet:\s*([0-9.]+\/[0-9]+)/);
    expect(
      subnetMatch,
      `expected an ipam.config[0].subnet under the runtime network, found block:\n${networksBlock}`,
    ).not.toBeNull();
    return subnetMatch![1];
  }

  // Shared by hba-replication-rule.sh (`X8_RUNTIME_SUBNET:-<cidr>}` in its
  // own `${X8_RUNTIME_SUBNET:-...}` default) and the base docker-compose.yml
  // (`X8_RUNTIME_SUBNET: ${X8_RUNTIME_SUBNET:-<cidr>}` under
  // `postgres.environment`) -- both spell the default the same way, so one
  // extractor covers either source text.
  function extractX8RuntimeSubnetDefault(source: string, sourceLabel: string): string {
    const match = source.match(/X8_RUNTIME_SUBNET:-([0-9.]+\/[0-9]+)\}/);
    expect(match, `expected ${sourceLabel} to default X8_RUNTIME_SUBNET to a CIDR subnet`).not.toBeNull();
    return match![1];
  }

  it("keeps the compose-declared runtime subnet equal to hba-replication-rule.sh's default", async () => {
    const composeYaml = await text("infra/preproduction/docker-compose.yml");
    const hbaScript = await text("infra/postgres/hba-replication-rule.sh");

    const composeSubnet = extractComposeRuntimeSubnet(composeYaml);
    const hbaSubnet = extractX8RuntimeSubnetDefault(hbaScript, "infra/postgres/hba-replication-rule.sh");

    expect(
      composeSubnet,
      `infra/preproduction/docker-compose.yml's runtime network subnet (${composeSubnet}) must equal ` +
        `infra/postgres/hba-replication-rule.sh's default X8_RUNTIME_SUBNET (${hbaSubnet}). A mismatch ` +
        `means Docker will allocate (or auto-reallocate on recreate) an address range that the ` +
        `pg_hba.conf replication rule baked in at initdb time does not permit: replication ` +
        `connections are rejected, pg_basebackup fails, and there is no physical base backup to ` +
        `anchor PITR recovery.`,
    ).toBe(hbaSubnet);
  });

  it("keeps the base docker-compose.yml's X8_RUNTIME_SUBNET default locked to the same value", async () => {
    // This is the copy that is actually live at real initdb time: the base
    // docker-compose.yml's `postgres.environment.X8_RUNTIME_SUBNET` is what
    // infra/postgres/init-roles.sh reads (via hba-replication-rule.sh) when
    // it bakes the pg_hba.conf replication rule on a brand-new PGDATA. The
    // preceding test only compares the preproduction compose's *network*
    // subnet against hba-replication-rule.sh's own fallback default; if
    // this third copy drifts, that comparison can stay green while the
    // value actually baked into a live pg_hba.conf does not match either.
    const baseComposeYaml = await text("docker-compose.yml");
    const hbaScript = await text("infra/postgres/hba-replication-rule.sh");

    const baseComposeSubnet = extractX8RuntimeSubnetDefault(baseComposeYaml, "docker-compose.yml");
    const hbaSubnet = extractX8RuntimeSubnetDefault(hbaScript, "infra/postgres/hba-replication-rule.sh");

    expect(
      baseComposeSubnet,
      `docker-compose.yml's postgres.environment.X8_RUNTIME_SUBNET default (${baseComposeSubnet}) must ` +
        `equal infra/postgres/hba-replication-rule.sh's default (${hbaSubnet}). This is the value that ` +
        `is actually read at real initdb time (via infra/postgres/init-roles.sh), so a drift here bakes ` +
        `a pg_hba.conf replication rule scoped to a subnet nothing else agrees on, even if the ` +
        `preproduction compose's pinned network subnet still matches hba-replication-rule.sh's default.`,
    ).toBe(hbaSubnet);
  });
});
