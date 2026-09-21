import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const inventoryPath = path.join(root, "scripts/preproduction/secret-files.txt");
const matrixPath = path.join(root, "scripts/preproduction/secret-consumers.tsv");
const verifierPath = path.join(root, "scripts/preproduction/verify-secret-consumers.mjs");
const preflightPath = path.join(root, "scripts/preproduction/secrets-preflight.sh");
const identities = [
  "channel_credential_encryption_key_v1",
  "channel_credential_fingerprint_key",
  "totp_encryption_key",
  "tracking_hash_salt",
];

async function inventory() {
  return (await readFile(inventoryPath, "utf8")).trim().split("\n");
}

function validate(inventoryFile: string, matrixFile: string) {
  return spawnSync(process.execPath, [verifierPath, inventoryFile, matrixFile], { encoding: "utf8" });
}

async function matrixMutation(change: (lines: string[]) => string[]) {
  const dir = await mkdtemp(path.join(tmpdir(), "secret-matrix-"));
  const inventoryFile = path.join(dir, "inventory.txt");
  const matrixFile = path.join(dir, "matrix.tsv");
  await writeFile(inventoryFile, await readFile(inventoryPath));
  const lines = (await readFile(matrixPath, "utf8")).trimEnd().split("\n");
  await writeFile(matrixFile, `${change(lines).join("\n")}\n`);
  return validate(inventoryFile, matrixFile);
}

async function secretFixture() {
  const dir = await mkdtemp(path.join(tmpdir(), "secret-consumers-"));
  for (const name of await inventory()) {
    await writeFile(path.join(dir, name), `${name}-fixture\n`, { mode: 0o600 });
  }
  const hashes = await Promise.all(identities.map(async (name) => {
    const value = await readFile(path.join(dir, name));
    return `${createHash("sha256").update(value).digest("hex")}  ${name}`;
  }));
  await writeFile(path.join(dir, "secret-identity.sha256"), `${hashes.join("\n")}\n`, { mode: 0o600 });
  return dir;
}

async function fullStubFixture(allowAppPostgres = false) {
  const fixture = await secretFixture();
  const bin = path.join(fixture, "bin");
  const log = path.join(fixture, "docker.log");
  // nginx-d stands in for /opt/cps-novel/shared/maintenance: the fourth
  // traverse-only directory, which also holds the maintenance page nginx
  // must be able to READ (not just traverse) and the marker it must be able
  // to STAT while it exists.
  const traverse = ["nginx-a", "nginx-b", "nginx-c", "nginx-d"].map((name) => path.join(fixture, name));
  await mkdir(bin);
  for (const directory of traverse) await mkdir(directory);

  const maintenancePage = path.join(fixture, "nginx-d", "__preprod_maintenance.html");
  const maintenanceMarker = path.join(fixture, "nginx-d", "enabled");
  // The marker is deliberately NOT created here: between deploys it does not
  // exist, and that has to be the default fixture shape so the happy path
  // exercises the honest "absent" branch, not a lucky "always present" one.
  await writeFile(maintenancePage, "<h1>Maintenance in progress</h1>\n", { mode: 0o644 });

  await writeFile(path.join(bin, "id"), [
    "#!/usr/bin/env bash",
    '[[ "$1" == "-u" ]] && echo 1000 || echo 1000',
    "",
  ].join("\n"), { mode: 0o700 });
  await writeFile(path.join(bin, "stat"), [
    "#!/usr/bin/env bash",
    'path="${@: -1}"',
    'format="$2"',
    'if [[ "$format" == "%a" || "$format" == "%Lp" ]]; then',
    '  case "${path##*/}" in preprod-curl.conf|backup_role.pgpass|secret-identity.sha256) echo 600 ;; *) echo 640 ;; esac',
    'elif [[ "$format" == "%u:%g" ]]; then',
    '  [[ "${path##*/}" == "backup_role.pgpass" ]] && echo 0:0 || echo 1000:1000',
    "else exit 1; fi",
    "",
  ].join("\n"), { mode: 0o700 });
  await writeFile(path.join(bin, "getfacl"), [
    "#!/usr/bin/env bash",
    'path="${@: -1}"; name="${path##*/}"',
    "echo 'user::rw-'",
    'case "$name" in',
    "  channel_credential_encryption_key_v1|channel_credential_fingerprint_key|totp_encryption_key|tracking_hash_salt|admin-smoke-password) echo 'user:1001:r--' ; echo 'mask::r--' ;;",
    "  postgres_admin_password|migration_owner_password|web_app_password|worker_app_password|scheduler_app_password|analyst_ro_password|backup_role_password) echo 'user:999:r--' ; echo 'mask::r--' ;;",
    "  nginx-preprod.htpasswd) echo 'user:33:r--' ; echo 'mask::r--' ;;",
    "  nginx-a|nginx-b|nginx-c|nginx-d) echo 'user:33:--x' ; echo 'mask::--x' ;;",
    "esac",
    "echo 'group::---'",
    "echo 'other::---'",
    "",
  ].join("\n"), { mode: 0o700 });
  await writeFile(path.join(bin, "docker"), [
    "#!/usr/bin/env bash",
    'printf "%s\\n" "$*" >>"$SECRET_PROBE_LOG"',
    'if [[ "$1" == "info" ]]; then echo \"[\\\"name=seccomp\\\"]\"; exit 0; fi',
    'if [[ "$1" == "image" && "$2" == "inspect" ]]; then exit 0; fi',
    '[[ "$1" == "run" ]] || exit 97',
    "user=''; source_path=''",
    'while (($#)); do case "$1" in --user) user="$2"; shift 2 ;; --mount) source_path="${2#*src=}"; source_path="${source_path%%,dst=*}"; shift 2 ;; *) shift ;; esac; done',
    'name="${source_path##*/}"',
    'case "$user:$name" in',
    "  1001:1001:channel_credential_encryption_key_v1|1001:1001:channel_credential_fingerprint_key|1001:1001:totp_encryption_key|1001:1001:tracking_hash_salt|1001:1001:admin-smoke-password) exit 0 ;;",
    "  999:999:postgres_admin_password|999:999:migration_owner_password|999:999:web_app_password|999:999:worker_app_password|999:999:scheduler_app_password|999:999:analyst_ro_password|999:999:backup_role_password) exit 0 ;;",
    "  0:0:backup_role.pgpass) exit 0 ;;",
    "  33:33:__preprod_maintenance.html) exit 0 ;;",
    "  33:33:enabled) exit 0 ;;",
    "esac",
    'if [[ "${ALLOW_APP_POSTGRES:-0}" == "1" && "$user" == "1001:1001" && "$name" == "postgres_admin_password" ]]; then exit 0; fi',
    "exit 1",
    "",
  ].join("\n"), { mode: 0o700 });

  return {
    fixture,
    log,
    maintenancePage,
    maintenanceMarker,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      PREPROD_TEST_MODE: "1",
      PREPROD_SECRET_ROOT: fixture,
      PREPROD_TEST_NGINX_TRAVERSE_PATHS: traverse.join(":"),
      PREPROD_TEST_MAINTENANCE_PAGE: maintenancePage,
      PREPROD_TEST_MAINTENANCE_MARKER: maintenanceMarker,
      CPS_NOVEL_APP_IMAGE: "approved-app:test",
      SECRET_PROBE_LOG: log,
      ALLOW_APP_POSTGRES: allowAppPostgres ? "1" : "0",
    },
  };
}

describe("secret consumer matrix", () => {
  it("is a bidirectional exact classification of the 15-file inventory", async () => {
    const result = validate(inventoryPath, matrixPath);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("SECRET_CONSUMER_MATRIX=PASS count=15");

    const rows = (await readFile(matrixPath, "utf8")).trim().split("\n").slice(1).map((row) => row.split("\t"));
    expect(rows.filter(([, kind]) => kind === "APP")).toHaveLength(5);
    expect(rows.filter(([, kind]) => kind === "POSTGRES")).toHaveLength(7);
    expect(rows.filter(([, kind]) => kind === "HOST_NGINX")).toHaveLength(1);
    expect(rows.filter(([, kind]) => kind === "HOST_DEPLOY")).toHaveLength(1);
    expect(rows.filter(([, kind]) => kind === "BACKUP_ROOT")).toHaveLength(1);
  });

  it("rejects duplicate assignments", async () => {
    const result = await matrixMutation((lines) => [...lines, lines[1]]);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain("reason=duplicate_assignment");
  });

  it("rejects an unclassified inventory secret", async () => {
    const result = await matrixMutation((lines) => lines.filter((line) => !line.startsWith("admin-smoke-password\t")));
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain("reason=unclassified_secret");
  });

  it("rejects matrix secrets absent from inventory", async () => {
    const result = await matrixMutation((lines) => [...lines, "not-in-inventory\tAPP\t1001\t1001"]);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain("reason=unknown_secret");
  });

  it("rejects unknown consumer classes and mismatched numeric identities", async () => {
    const unknown = await matrixMutation((lines) => lines.map((line) => line.startsWith("admin-smoke-password\t")
      ? "admin-smoke-password\tUNKNOWN\t1001\t1001" : line));
    expect(unknown.stdout).toContain("reason=unknown_consumer_class");
    const mismatch = await matrixMutation((lines) => lines.map((line) => line.startsWith("admin-smoke-password\t")
      ? "admin-smoke-password\tAPP\t999\t999" : line));
    expect(mismatch.stdout).toContain("reason=consumer_identity_mismatch");
  });

  it("keeps the stable identity manifest scope at exactly four files", async () => {
    const actual = (await readFile(path.join(root, "scripts/preproduction/secret-identity-files.txt"), "utf8")).trim().split("\n");
    expect(actual).toEqual(identities);
  });
});

describe("secret consumer preflight model", () => {
  it("labels host-only execution as consumer access unverified", async () => {
    const dir = await secretFixture();
    const result = spawnSync("bash", [preflightPath, "--host-only"], {
      env: { ...process.env, PREPROD_TEST_MODE: "1", PREPROD_SECRET_ROOT: dir }, encoding: "utf8",
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("SECRET_PREFLIGHT=HOST_ONLY CONSUMER_ACCESS=UNVERIFIED");
    expect(result.stdout).not.toContain("SECRET_PREFLIGHT=PASS");
  });

  it("uses the selected local image and the hardened no-pull probe command", async () => {
    const script = await readFile(preflightPath, "utf8");
    expect(script).toContain("--pull never --network none --read-only --cap-drop ALL");
    expect(script).toContain("--security-opt no-new-privileges --user \"$uid:$gid\"");
    expect(script).toContain("--entrypoint /bin/sh \"$CPS_NOVEL_APP_IMAGE\" -c 'exec 3</run/check'");
    expect(script).not.toContain("alpine:3.20");
    expect(script).not.toMatch(/docker\s+pull/);
  });

  it("fails on rootless or userns Docker before any probe", async () => {
    const fixture = await secretFixture();
    const bin = path.join(fixture, "bin");
    const log = path.join(fixture, "docker.log");
    await mkdir(bin);
    await writeFile(path.join(bin, "getfacl"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o700 });
    await writeFile(path.join(bin, "docker"), [
      "#!/usr/bin/env bash",
      'printf "%s\\n" "$*" >>"$SECRET_PROBE_LOG"',
      'if [[ "$1" == "info" ]]; then echo \"[\\\"name=rootless\\\"]\"; exit 0; fi',
      "exit 97",
      "",
    ].join("\n"), { mode: 0o700 });
    const result = spawnSync("bash", [preflightPath], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, PREPROD_TEST_MODE: "1", PREPROD_SECRET_ROOT: fixture,
        CPS_NOVEL_APP_IMAGE: "approved-app:test", SECRET_PROBE_LOG: log }, encoding: "utf8",
    });
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain("reason=unsupported_docker_user_namespace_for_secret_acl");
    expect(await readFile(log, "utf8")).not.toContain("run ");
  });

  it("fails for a missing local probe image without pulling or running", async () => {
    const fixture = await secretFixture();
    const bin = path.join(fixture, "bin");
    const log = path.join(fixture, "docker.log");
    await mkdir(bin);
    await writeFile(path.join(bin, "getfacl"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o700 });
    await writeFile(path.join(bin, "docker"), [
      "#!/usr/bin/env bash",
      'printf "%s\\n" "$*" >>"$SECRET_PROBE_LOG"',
      'if [[ "$1" == "info" ]]; then echo \"[\\\"name=seccomp\\\"]\"; exit 0; fi',
      'if [[ "$1" == "image" && "$2" == "inspect" ]]; then exit 1; fi',
      "exit 97",
      "",
    ].join("\n"), { mode: 0o700 });
    const result = spawnSync("bash", [preflightPath], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, PREPROD_TEST_MODE: "1", PREPROD_SECRET_ROOT: fixture,
        CPS_NOVEL_APP_IMAGE: "approved-app:test", SECRET_PROBE_LOG: log }, encoding: "utf8",
    });
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain("reason=probe_image_missing");
    const calls = await readFile(log, "utf8");
    expect(calls).not.toContain("run ");
    expect(calls).not.toContain("pull");
  });

  it("runs all positive and cross-consumer negative probes with no registry access", async () => {
    const setup = await fullStubFixture();
    const result = spawnSync("bash", [preflightPath], { env: setup.env, encoding: "utf8" });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain("SECRET_PREFLIGHT=PASS CONSUMER_ACCESS=VERIFIED");
    // The marker fixture is absent by default (the normal between-deploys
    // state): this must be reported explicitly, never folded into a silent
    // PASS, so "never checked" can't be misread as "confirmed visible".
    expect(result.stdout).toContain("MAINTENANCE_MARKER_PROBE=SKIPPED reason=marker_absent");
    const calls = (await readFile(setup.log, "utf8")).trim().split("\n");
    const runs = calls.filter((call) => call.startsWith("run "));
    expect(runs).toHaveLength(32);
    for (const call of runs) {
      expect(call).toContain("--pull never --network none --read-only --cap-drop ALL");
      expect(call).toContain("--security-opt no-new-privileges");
      expect(call).toContain("--entrypoint /bin/sh approved-app:test -c exec 3</run/check");
    }
    expect(calls.some((call) => call.startsWith("pull "))).toBe(false);
  });

  it("fails when APP can read even one PostgreSQL secret", async () => {
    const setup = await fullStubFixture(true);
    const result = spawnSync("bash", [preflightPath], { env: setup.env, encoding: "utf8" });
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain("reason=negative_access_app");
  });

  it("fails closed when a traverse directory grants any access to others", async () => {
    const { fixture, env } = await fullStubFixture();
    // 🔴 只把一个 traverse 目录的 other 位放开，其余一切不变：named ACL 仍然
    // 只有唯一的 u:33:--x、计数仍是 1、mask 仍含 x。补丁前这会一路 PASS，
    // 而任何 UID 都能穿越并列出 secrets 目录 —— "只给 UID 33 traverse"
    // 这条不变式其实没有被强制。已在真实 Linux ACL 上实证（UID 4242 能 ls）。
    await writeFile(path.join(fixture, "bin", "getfacl"), [
      "#!/usr/bin/env bash",
      'path="${@: -1}"; name="${path##*/}"',
      "echo 'user::rw-'",
      'case "$name" in',
      "  channel_credential_encryption_key_v1|channel_credential_fingerprint_key|totp_encryption_key|tracking_hash_salt|admin-smoke-password) echo 'user:1001:r--' ; echo 'mask::r--' ;;",
      "  postgres_admin_password|migration_owner_password|web_app_password|worker_app_password|scheduler_app_password|analyst_ro_password|backup_role_password) echo 'user:999:r--' ; echo 'mask::r--' ;;",
      "  nginx-preprod.htpasswd) echo 'user:33:r--' ; echo 'mask::r--' ;;",
      "  nginx-a|nginx-b|nginx-c|nginx-d) echo 'user:33:--x' ; echo 'mask::--x' ;;",
      "esac",
      "echo 'group::---'",
      // 单点改动：nginx-b 放开 other 的遍历位
      'if [[ "$name" == "nginx-b" ]]; then echo \'other::--x\'; else echo \'other::---\'; fi',
      "",
    ].join("\n"), { mode: 0o700 });

    const result = spawnSync("bash", [preflightPath], { env, encoding: "utf8" });
    expect(`${result.stdout}${result.stderr}`).toContain("reason=nginx_traverse_other");
    expect(result.status).not.toBe(0);
  });

  it("fails closed when the maintenance directory is missing the www-data traverse ACL", async () => {
    const { fixture, env } = await fullStubFixture();
    // 🔴 Reproduces the real defect measured on the target verbatim: the
    // other three traverse directories keep their `u:33:--x` entry, but
    // nginx-d (stand-in for /opt/cps-novel/shared/maintenance) has none --
    // `other::---` still holds, so this is not the "other opened up" case
    // above, it is the actual production shape (drwxr-x--- with no ACL for
    // www-data at all). Before this guard existed for a 4th directory, that
    // shape simply wasn't checked here, so nginx could never traverse into
    // the maintenance directory and the whole gate silently never fired.
    await writeFile(path.join(fixture, "bin", "getfacl"), [
      "#!/usr/bin/env bash",
      'path="${@: -1}"; name="${path##*/}"',
      "echo 'user::rw-'",
      'case "$name" in',
      "  channel_credential_encryption_key_v1|channel_credential_fingerprint_key|totp_encryption_key|tracking_hash_salt|admin-smoke-password) echo 'user:1001:r--' ; echo 'mask::r--' ;;",
      "  postgres_admin_password|migration_owner_password|web_app_password|worker_app_password|scheduler_app_password|analyst_ro_password|backup_role_password) echo 'user:999:r--' ; echo 'mask::r--' ;;",
      "  nginx-preprod.htpasswd) echo 'user:33:r--' ; echo 'mask::r--' ;;",
      "  nginx-a|nginx-b|nginx-c) echo 'user:33:--x' ; echo 'mask::--x' ;;",
      "esac",
      "echo 'group::---'",
      "echo 'other::---'",
      "",
    ].join("\n"), { mode: 0o700 });

    const result = spawnSync("bash", [preflightPath], { env, encoding: "utf8" });
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain("reason=unexpected_named_acl");
  });

  it("fails closed when the maintenance page is not readable by www-data", async () => {
    const { fixture, env } = await fullStubFixture();
    // 🔴 Same fixture as the happy path, minus the one whitelist line that
    // lets uid 33 open the maintenance page for reading. Reproduces the
    // second half of the real defect: even with the directory ACL fixed,
    // nginx's `error_page 503` still can't render the page it is supposed
    // to serve if the file itself isn't readable by www-data.
    await writeFile(path.join(fixture, "bin", "docker"), [
      "#!/usr/bin/env bash",
      'printf "%s\\n" "$*" >>"$SECRET_PROBE_LOG"',
      'if [[ "$1" == "info" ]]; then echo \"[\\\"name=seccomp\\\"]\"; exit 0; fi',
      'if [[ "$1" == "image" && "$2" == "inspect" ]]; then exit 0; fi',
      '[[ "$1" == "run" ]] || exit 97',
      "user=''; source_path=''",
      'while (($#)); do case "$1" in --user) user="$2"; shift 2 ;; --mount) source_path="${2#*src=}"; source_path="${source_path%%,dst=*}"; shift 2 ;; *) shift ;; esac; done',
      'name="${source_path##*/}"',
      'case "$user:$name" in',
      "  1001:1001:channel_credential_encryption_key_v1|1001:1001:channel_credential_fingerprint_key|1001:1001:totp_encryption_key|1001:1001:tracking_hash_salt|1001:1001:admin-smoke-password) exit 0 ;;",
      "  999:999:postgres_admin_password|999:999:migration_owner_password|999:999:web_app_password|999:999:worker_app_password|999:999:scheduler_app_password|999:999:analyst_ro_password|999:999:backup_role_password) exit 0 ;;",
      "  0:0:backup_role.pgpass) exit 0 ;;",
      "  33:33:enabled) exit 0 ;;",
      "esac",
      'if [[ "${ALLOW_APP_POSTGRES:-0}" == "1" && "$user" == "1001:1001" && "$name" == "postgres_admin_password" ]]; then exit 0; fi',
      "exit 1",
      "",
    ].join("\n"), { mode: 0o700 });

    const result = spawnSync("bash", [preflightPath], { env, encoding: "utf8" });
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain("reason=maintenance_page_unreadable");
  });

  it("locks backup-timer to the root consumer model", async () => {
    const overlay = await readFile(path.join(root, "infra/preproduction/docker-compose.yml"), "utf8");
    const block = overlay.slice(overlay.indexOf("  backup-timer:"), overlay.indexOf("\nvolumes:"));
    expect(block).toContain("image: postgres:16.14");
    expect(block).toContain("command: [\"/bin/bash\"");
    expect(block).not.toMatch(/^\s+user:/m);
  });
});

describe("real Linux Docker bind-mount ACL behavior", () => {
  it.skipIf(process.platform !== "linux")("allows only each declared numeric consumer", async () => {
    const probeImage = "docker:29-dind";
    expect(spawnSync("sh", ["-c", "command -v setfacl"]).status).toBe(0);
    expect(spawnSync("docker", ["image", "inspect", probeImage]).status).toBe(0);
    const security = spawnSync("docker", ["info", "--format", "{{json .SecurityOptions}}"], { encoding: "utf8" });
    expect(security.status).toBe(0);
    expect(security.stdout).not.toMatch(/rootless|userns/i);

    const dir = await mkdtemp(path.join(tmpdir(), "real-secret-acl-"));
    const files = ["app", "postgres", "nginx", "host", "backup"];
    try {
      for (const name of files) await writeFile(path.join(dir, name), `${name}\n`, { mode: 0o600 });
      // Linux may clear extended ACLs when ownership changes. Establish the
      // final neutral owners first, then install the ACL exactly as Owner would.
      expect(spawnSync("sudo", ["-n", "chown", "2000:2000", ...files.slice(0, 4).map((name) => path.join(dir, name))]).status).toBe(0);
      expect(spawnSync("sudo", ["-n", "chown", "0:0", path.join(dir, "backup")]).status).toBe(0);
      expect(spawnSync("sudo", ["-n", "setfacl", "-m", "u:1001:r--", path.join(dir, "app")]).status).toBe(0);
      expect(spawnSync("sudo", ["-n", "setfacl", "-m", "u:999:r--", path.join(dir, "postgres")]).status).toBe(0);
      expect(spawnSync("sudo", ["-n", "setfacl", "-m", "u:33:r--", path.join(dir, "nginx")]).status).toBe(0);
      expect(spawnSync("sudo", ["-n", "setfacl", "-m", "u:33:--x", dir]).status).toBe(0);

      const aclState = (name: string) => spawnSync("getfacl", ["-cpn", path.join(dir, name)], { encoding: "utf8" });
      const probe = (uid: number, name: string) => spawnSync("docker", ["run", "--rm", "--pull", "never",
        "--network", "none", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
        "--user", `${uid}:${uid}`, "--mount", `type=bind,src=${path.join(dir, name)},dst=/run/check,readonly`,
        "--entrypoint", "/bin/sh", probeImage, "-c",
        "id; ls -ldn /run /run/check; stat -c 'mode=%a owner=%u:%g' /run/check; exec 3</run/check"],
      { encoding: "utf8" });

      const failureContext = (name: string, result: ReturnType<typeof probe>) => {
        const acl = aclState(name);
        return [
          `getfacl status=${acl.status}`,
          acl.stdout,
          acl.stderr,
          `docker status=${result.status}`,
          result.stdout,
          result.stderr,
        ].join("\n");
      };

      const appPositive = probe(1001, "app");
      expect(appPositive.status, failureContext("app", appPositive)).toBe(0);
      expect(probe(999, "app").status).not.toBe(0);
      const postgresPositive = probe(999, "postgres");
      expect(postgresPositive.status, failureContext("postgres", postgresPositive)).toBe(0);
      expect(probe(1001, "postgres").status).not.toBe(0);
      const nginxPositive = probe(33, "nginx");
      expect(nginxPositive.status, failureContext("nginx", nginxPositive)).toBe(0);
      expect(probe(1001, "nginx").status).not.toBe(0);
      expect(probe(999, "nginx").status).not.toBe(0);
      expect(probe(1001, "host").status).not.toBe(0);
      expect(probe(999, "host").status).not.toBe(0);
      const backupPositive = probe(0, "backup");
      expect(backupPositive.status, failureContext("backup", backupPositive)).toBe(0);
      expect(probe(1001, "backup").status).not.toBe(0);
      expect(probe(999, "backup").status).not.toBe(0);

      const nginxHostPath = spawnSync("docker", ["run", "--rm", "--pull", "never", "--network", "none",
        "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--user", "33:33",
        "--mount", `type=bind,src=${dir},dst=/run/secrets,readonly`, "--entrypoint", "/bin/sh", probeImage,
        "-c", "exec 3</run/secrets/nginx"]);
      expect(nginxHostPath.status).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
