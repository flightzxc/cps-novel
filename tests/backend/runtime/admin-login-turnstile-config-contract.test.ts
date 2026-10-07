import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, symlink, writeFile, chmod } from "node:fs/promises";
import { readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

import {
  ADMIN_LOGIN_TURNSTILE_ENV,
  ADMIN_LOGIN_TURNSTILE_SECRET_NAME,
  TURNSTILE_SITE_KEY_PATTERN,
  isAdminLoginTurnstileEnabled,
  resolveAdminLoginTurnstileConfig,
} from "@/lib/auth/admin-login-turnstile";

import { SITE_MODE_CASES } from "./site-mode-fixture";

/**
 * B-39 — "新增配置三处一致" contract for the admin-login Turnstile switch.
 *
 * The three places that must agree:
 *   1. TS resolver            `src/lib/auth/admin-login-turnstile.ts`
 *   2. deployment preflight   `scripts/preproduction/lib.sh` / `preflight.sh` /
 *                             `secrets-preflight.sh` (+ `start-web.sh` at boot)
 *   3. Compose passthrough    root `docker-compose.yml` (default off) and
 *                             `infra/preproduction/docker-compose.yml`
 *                             (secret mount), plus the env examples, the X8
 *                             validator and the docs.
 *
 * Every name and default asserted below is DERIVED from the TS constants
 * (`ADMIN_LOGIN_TURNSTILE_ENV`, `ADMIN_LOGIN_TURNSTILE_SECRET_NAME`,
 * `TURNSTILE_SITE_KEY_PATTERN`) rather than retyped, so a change on one side
 * that is not mirrored on the other fails here. This is the same lesson as the
 * v0.4.2 assembly defect (the switch was valid in the env file and in the
 * preflight, but never reached the container) — see
 * `p1-12-compose-contract.test.ts`'s rate-gate case.
 *
 * Only Cloudflare's published dummy keys appear below.
 */

const root = process.cwd();
const read = (relative: string) => readFileSync(path.join(root, relative), "utf8");

const ENV = ADMIN_LOGIN_TURNSTILE_ENV;
const SECRET = ADMIN_LOGIN_TURNSTILE_SECRET_NAME;
const ALL_NAMES = Object.values(ENV);
const TEST_SITE_KEY = "1x00000000000000000000AA";
const TEST_SECRET = "1x0000000000000000000000000000000AA";

const rootCompose = read("docker-compose.yml");
const overlay = read("infra/preproduction/docker-compose.yml");
const envExample = read(".env.example");
const preprodEnvExample = read("infra/preproduction/preprod.env.example");
const libSh = read("scripts/preproduction/lib.sh");
const preflightSh = read("scripts/preproduction/preflight.sh");
const secretsPreflightSh = read("scripts/preproduction/secrets-preflight.sh");
const x8Validator = read("scripts/acceptance/x8-validate-compose.mjs");

function serviceBlock(compose: string, name: string): string {
  const match = compose.match(new RegExp(`\\n  ${name}:\\n([\\s\\S]*?)(?=\\n  [a-z][a-z0-9_-]*:\\n|\\nnetworks:|\\nvolumes:|\\nsecrets:)`));
  expect(match, `missing service ${name}`).not.toBeNull();
  return match?.[1] ?? "";
}

const code = (text: string) =>
  text
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");

describe("1. root docker-compose.yml: web-only passthrough, default off", () => {
  const web = serviceBlock(rootCompose, "web");

  it("passes every ADMIN_LOGIN_TURNSTILE_* variable to web, with defaults that mean OFF / empty", () => {
    const defaults: Record<string, string> = {
      [ENV.enabled]: "false",
      [ENV.siteKey]: "",
      [ENV.secretKey]: "",
      [ENV.secretKeyFile]: "",
    };
    expect(Object.keys(defaults).sort()).toEqual([...ALL_NAMES].sort());
    for (const [name, fallback] of Object.entries(defaults)) {
      expect(web, name).toContain(`      ${name}: \${${name}:-${fallback}}`);
    }
  });

  it("the enabled default really is OFF per the TS resolver (derived, not retyped)", () => {
    const match = web.match(new RegExp(`${ENV.enabled}: \\$\\{${ENV.enabled}:-([^}]*)\\}`));
    expect(match).not.toBeNull();
    const env = { [ENV.enabled]: match![1] } as unknown as NodeJS.ProcessEnv;
    expect(isAdminLoginTurnstileEnabled(env)).toBe(false);
    expect(resolveAdminLoginTurnstileConfig(env)).toEqual({ enabled: false });
  });

  it("never reaches worker, worker-light or scheduler (they serve no login)", () => {
    for (const name of ["worker", "worker-light", "scheduler"]) {
      expect(serviceBlock(rootCompose, name), name).not.toMatch(/ADMIN_LOGIN_TURNSTILE/);
    }
    expect(serviceBlock(overlay, "worker")).not.toMatch(/ADMIN_LOGIN_TURNSTILE|admin_login_turnstile/);
    expect(serviceBlock(overlay, "worker-light")).not.toMatch(/ADMIN_LOGIN_TURNSTILE|admin_login_turnstile/);
    expect(serviceBlock(overlay, "scheduler")).not.toMatch(/ADMIN_LOGIN_TURNSTILE|admin_login_turnstile/);
  });
});

describe("2. preproduction overlay: secret only ever as a file, source conditional", () => {
  const web = serviceBlock(overlay, "web");

  it("pins the direct secret empty and points the _FILE variable at the mounted Docker secret", () => {
    expect(web).toContain(`      ${ENV.secretKey}: ""`);
    expect(web).toContain(`      ${ENV.secretKeyFile}: /run/secrets/${SECRET}`);
    // the switch and the site key pass through from preprod.env; the overlay must not pin them
    expect(web).not.toContain(`${ENV.enabled}:`);
    expect(web).not.toContain(`${ENV.siteKey}:`);
  });

  it("mounts the secret into web only, and defines its source as ${SOURCE:-/dev/null}", () => {
    expect(web).toMatch(new RegExp(`\\n    secrets:\\n(?:      - [a-z_]+\\n)*      - ${SECRET}\\n`));
    const topLevel = overlay.slice(overlay.indexOf("\nsecrets:\n"));
    expect(topLevel).toContain(`  ${SECRET}:\n    file: \${ADMIN_LOGIN_TURNSTILE_SECRET_SOURCE:-/dev/null}`);
    // exactly one reference in the whole overlay's service section: web
    const services = overlay.slice(0, overlay.indexOf("\nnetworks:"));
    expect(services.match(new RegExp(`- ${SECRET}\\b`, "g"))).toHaveLength(1);
  });

  it("the secret file name is the same string in lib.sh, secrets-preflight.sh and the preprod env template", () => {
    expect(libSh).toContain(`/secrets/${SECRET}`);
    expect(code(secretsPreflightSh)).toContain(`${SECRET}\\tAPP\\t1001\\t1001`);
    expect(preprodEnvExample).toContain(`/opt/cps-novel/shared/secrets/${SECRET}`);
  });

  it("the secret is CONDITIONAL: absent from the mandatory inventory, consumer matrix and identity manifest", () => {
    for (const file of [
      "scripts/preproduction/secret-files.txt",
      "scripts/preproduction/secret-consumers.tsv",
      "scripts/preproduction/secret-identity-files.txt",
    ]) {
      expect(read(file), file).not.toContain(SECRET);
    }
  });
});

describe("3. env examples", () => {
  it(".env.example documents all but the _FILE variable, default off, no value", () => {
    expect(envExample).toMatch(new RegExp(`^${ENV.enabled}=false$`, "m"));
    expect(envExample).toMatch(new RegExp(`^${ENV.siteKey}=$`, "m"));
    expect(envExample).toMatch(new RegExp(`^${ENV.secretKey}=$`, "m"));
  });

  it("preprod.env.example: switch false, site key empty, and NO secret-key assignment at all", () => {
    expect(preprodEnvExample).toMatch(new RegExp(`^${ENV.enabled}=false$`, "m"));
    expect(preprodEnvExample).toMatch(new RegExp(`^${ENV.siteKey}=$`, "m"));
    expect(preprodEnvExample).not.toMatch(new RegExp(`^\\s*${ENV.secretKey}=`, "m"));
    expect(preprodEnvExample).not.toMatch(new RegExp(`^\\s*${ENV.secretKeyFile}=`, "m"));
  });

  it("no committed file carries a real-looking Turnstile key (only the published dummy ones)", () => {
    const tracked = spawnSync("git", ["ls-files"], { cwd: root, encoding: "utf8" }).stdout.split("\n").filter(Boolean);
    // Real Turnstile keys: site keys start 0x4…, secrets 0x4… (Cloudflare's "managed" keys).
    const realShape = /\b0x4[A-Za-z0-9_-]{20,}\b/;
    const offenders = tracked.filter((file) => {
      if (/\.(png|jpg|jpeg|gif|webp|ico|woff2?|zst|gz|tgz|tar)$/i.test(file)) return false;
      try {
        return realShape.test(readFileSync(path.join(root, file), "utf8"));
      } catch {
        return false;
      }
    });
    expect(offenders).toEqual([]);
  });
});

describe("4. startup: start-web.sh loads the secret only when the switch is exactly true, never fatally", () => {
  const harness = async (env: Record<string, string>) => {
    const dir = await mkdtemp(path.join(tmpdir(), "start-web-turnstile-"));
    const bin = path.join(dir, "bin");
    await mkdir(bin);
    const log = path.join(dir, "calls.log");
    await writeFile(path.join(bin, "tsx"), `#!/usr/bin/env bash\necho "tsx $*" >>"${log}"\n`, { mode: 0o755 });
    await writeFile(
      path.join(bin, "node"),
      `#!/usr/bin/env bash\necho "node $*" >>"${log}"\necho "secret_len=\${#ADMIN_LOGIN_TURNSTILE_SECRET_KEY}"\n`,
      { mode: 0o755 },
    );
    const result = spawnSync("bash", [path.join(root, "scripts/start-web.sh")], {
      cwd: root,
      encoding: "utf8",
      env: {
        PATH: `${bin}:${process.env.PATH}`,
        HOME: process.env.HOME,
        TRACKING_HASH_SALT: "salt",
        TOTP_ENCRYPTION_KEY: "key",
        ...env,
      },
    });
    return { dir, log: await readFile(log, "utf8").catch(() => ""), result };
  };

  async function secretFile(contents: string) {
    const dir = await mkdtemp(path.join(tmpdir(), "turnstile-secret-"));
    const file = path.join(dir, "secret");
    await writeFile(file, contents, { mode: 0o600 });
    return file;
  }

  it("switch off / unset / TRUE: the file is not even looked at (it may not exist) and the boot log is quiet", async () => {
    for (const value of [undefined, "false", "TRUE", "1"]) {
      const { result, log } = await harness({
        ...(value === undefined ? {} : { [ENV.enabled]: value }),
        [ENV.secretKeyFile]: "/nonexistent/turnstile-secret",
      });
      expect(result.status, `value=${value}`).toBe(0);
      expect(result.stderr).not.toMatch(/Turnstile|ADMIN_LOGIN_TURNSTILE/);
      expect(result.stdout).toContain("secret_len=0");
      expect(log).toContain("tsx scripts/admin-login-turnstile-preflight.ts");
    }
  });

  it("switch true + readable one-line file: the value reaches node (without being printed) and preflights run in order", async () => {
    const file = await secretFile(`${TEST_SECRET}\n`);
    const { result, log } = await harness({ [ENV.enabled]: "true", [ENV.secretKeyFile]: file });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`secret_len=${TEST_SECRET.length}`);
    expect(`${result.stdout}${result.stderr}`).not.toContain(TEST_SECRET);
    const calls = log.trim().split("\n");
    expect(calls).toEqual([
      "tsx scripts/credential-secret-preflight.ts",
      "tsx scripts/two-factor-enforcement-preflight.ts",
      "tsx scripts/admin-login-turnstile-preflight.ts",
      "node server.js",
    ]);
  });

  it.each([
    ["missing file", async () => "/nonexistent/turnstile-secret"],
    ["/dev/null (the off-state mount)", async () => "/dev/null"],
    ["empty file", async () => secretFile("")],
    ["multi-line file", async () => secretFile("a\nb\n")],
    ["relative path", async () => "relative/secret"],
  ])("switch true + %s: warns on stderr and keeps booting with NO secret (admin login then refuses; the public site stays up)", async (_label, makePath) => {
    const { result, log } = await harness({ [ENV.enabled]: "true", [ENV.secretKeyFile]: await makePath() });
    expect(result.status).toBe(0);
    expect(result.stderr).toContain("WARN: admin login Turnstile secret unavailable");
    expect(result.stdout).toContain("secret_len=0");
    expect(log).toContain("node server.js");
  });

  it("switch true with BOTH a direct value and a file is refused as ambiguous (the file is not silently preferred)", async () => {
    const file = await secretFile(`${TEST_SECRET}\n`);
    const { result } = await harness({ [ENV.enabled]: "true", [ENV.secretKeyFile]: file, [ENV.secretKey]: "direct-value" });
    expect(result.status).toBe(0);
    expect(result.stderr).toContain("mutually exclusive");
    expect(result.stderr).toContain("WARN: admin login Turnstile secret unavailable");
    expect(`${result.stdout}${result.stderr}`).not.toContain("direct-value");
  });

  it("the two pre-existing mandatory secrets are still fatal (B-39 did not soften them)", async () => {
    const { result, log } = await harness({ TOTP_ENCRYPTION_KEY: "" });
    expect(result.status).not.toBe(0);
    expect(log).not.toContain("node server.js");
  });
});

describe("5. deployment preflight: lib.sh function behaves, and tracks the TS rules", () => {
  const LIB = path.join(root, "scripts/preproduction/lib.sh");
  function runGate(env: Record<string, string | undefined>) {
    const clean: NodeJS.ProcessEnv = { NODE_ENV: "test", PATH: process.env.PATH, HOME: process.env.HOME };
    for (const [key, value] of Object.entries(env)) if (value !== undefined) clean[key] = value;
    return spawnSync("bash", ["-c", `set -euo pipefail\nsource "${LIB}"\npreprod_assert_admin_login_turnstile_config`], {
      encoding: "utf8",
      env: clean,
    });
  }

  it("unset / false -> PASS enabled=false, other variables ignored", () => {
    for (const env of [{}, { [ENV.enabled]: "false" }, { [ENV.enabled]: "", [ENV.siteKey]: "garbage!!" }]) {
      const result = runGate(env);
      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe("PREPROD_ADMIN_LOGIN_TURNSTILE_CONFIG=PASS enabled=false");
    }
  });

  it("true + valid site key -> PASS enabled=true and prints no key value", () => {
    const result = runGate({ [ENV.enabled]: "true", [ENV.siteKey]: TEST_SITE_KEY });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(
      `PREPROD_ADMIN_LOGIN_TURNSTILE_CONFIG=PASS enabled=true siteKey=set secret=file:${SECRET}`,
    );
    expect(result.stdout).not.toContain(TEST_SITE_KEY);
  });

  it.each(["TRUE", "True", "1", "yes", "on", " true", "true "])("switch value %j -> FAIL (the runtime would silently read it as OFF)", (value) => {
    const result = runGate({ [ENV.enabled]: value, [ENV.siteKey]: TEST_SITE_KEY });
    expect(result.status).toBe(65);
    expect(result.stdout).toContain(
      `admin_login_turnstile_config_invalid variable=${ENV.enabled} value=${value} reason=must_be_true_false_or_unset`,
    );
    // ...and the TS side indeed reads every one of them as OFF
    expect(isAdminLoginTurnstileEnabled({ [ENV.enabled]: value } as unknown as NodeJS.ProcessEnv)).toBe(false);
  });

  it("true without a site key -> FAIL site_key_missing; malformed -> FAIL site_key_invalid", () => {
    const missing = runGate({ [ENV.enabled]: "true" });
    expect(missing.status).toBe(65);
    expect(missing.stdout).toContain(`variable=${ENV.siteKey} reason=site_key_missing`);
    const invalid = runGate({ [ENV.enabled]: "true", [ENV.siteKey]: "short" });
    expect(invalid.status).toBe(65);
    expect(invalid.stdout).toContain(`variable=${ENV.siteKey} reason=site_key_invalid`);
  });

  it("a literal secret in the env file is refused whatever the switch says, and never echoed", () => {
    for (const enabled of [undefined, "false", "true"]) {
      const result = runGate({
        ...(enabled ? { [ENV.enabled]: enabled, [ENV.siteKey]: TEST_SITE_KEY } : {}),
        [ENV.secretKey]: TEST_SECRET,
      });
      expect(result.status, `enabled=${enabled}`).toBe(65);
      expect(result.stdout).toContain(`variable=${ENV.secretKey} reason=secret_must_not_be_in_env_file`);
      expect(`${result.stdout}${result.stderr}`).not.toContain(TEST_SECRET);
    }
  });

  it("dual run: the shell and the TS resolver accept/reject the same site keys", () => {
    const samples = [
      TEST_SITE_KEY,
      "2x00000000000000000000AB",
      // shaped like a real managed key, assembled so this file itself does not trip the "no real-looking key" scan above
      `0x4${"A".repeat(7)}${"x".repeat(14)}`,
      "short",
      "1234567",
      "12345678",
      "a".repeat(128),
      "a".repeat(129),
      "has space in it",
      "semi;colon-key1",
      "dash-and_under-OK1",
      "ünïcode-key-123456",
    ];
    for (const siteKey of samples) {
      const shell = runGate({ [ENV.enabled]: "true", [ENV.siteKey]: siteKey }).status === 0;
      let ts = true;
      try {
        resolveAdminLoginTurnstileConfig({
          [ENV.enabled]: "true",
          [ENV.siteKey]: siteKey,
          [ENV.secretKey]: TEST_SECRET,
          ADMIN_CANONICAL_ORIGIN: "https://zbcwf.example.test",
        } as unknown as NodeJS.ProcessEnv);
      } catch {
        ts = false;
      }
      expect(shell, `site key ${JSON.stringify(siteKey)}`).toBe(ts);
      expect(shell).toBe(TURNSTILE_SITE_KEY_PATTERN.test(siteKey));
    }
  });

  it("preflight.sh calls the gate (fail closed) before the git_commit check and prints its evidence before PASS", () => {
    const body = code(preflightSh);
    expect(body).toMatch(
      /admin_login_turnstile_evidence="\$\(preprod_assert_admin_login_turnstile_config\)"\s*\|\|\s*fail\s+"\$admin_login_turnstile_evidence"/,
    );
    expect(body.indexOf("preprod_assert_admin_login_turnstile_config")).toBeLessThan(body.indexOf('git_commit'));
    expect(body.indexOf('echo "$admin_login_turnstile_evidence"')).toBeLessThan(body.lastIndexOf('echo "PREPROD_PREFLIGHT=PASS"'));
  });
});

describe.each(SITE_MODE_CASES)("6. $mode preflight.sh end to end (real script, no mocks)", (site) => {
  const BASE_ENV: Record<string, string> = {
    P1_12_COMPOSE_PROJECT: "cps-novel",
    SITE_URL: site.SITE_URL,
    ADMIN_CANONICAL_ORIGIN: site.ADMIN_CANONICAL_ORIGIN,
    PUBLIC_TRACKING_WRITE_DISABLED: "1",
    ADMIN_TWO_FACTOR_ENFORCEMENT: "true",
    FEATURE_INDEXNOW_OUTBOX: "false",
    INDEXNOW_OUTBOX_ALLOW_WRITE: "false",
    FEATURE_INDEXNOW_DELIVERY: "false",
    INDEXNOW_DELIVERY_ALLOW_WRITE: "false",
    PREPROD_APPROVED_OPEN_WRITE_GATES: "",
    FEATURE_SITEMAP_AUTO_REFRESH: "false",
    SITEMAP_AUTO_REFRESH_ALLOW_WRITE: "false",
    FEATURE_NOVEL_CATALOG_SYNC: "false",
    NOVEL_CATALOG_SYNC_ALLOW_WRITE: "false",
    FEATURE_PROMO_LINK_CLAIM: "false",
    PROMO_LINK_CLAIM_ALLOW_WRITE: "false",
    FEATURE_NOVEL_TAG_AUTO: "false",
    AUTO_WRITE_AUTHORIZED: "NO",
    ARTICLE_BLOG_ALLOW_WRITE: "false",
    ARTICLE_NOVEL_REBIND_ALLOW_WRITE: "false",
    // deliberately no GIT_COMMIT: a clean run stops at reason=git_commit, which
    // proves every gate before it (including this one) was passed.
  };

  async function runPreflight(overrides: Record<string, string>) {
    const dir = await mkdtemp(path.join(tmpdir(), "preflight-turnstile-env-"));
    const file = path.join(dir, "preprod.env");
    const merged = { ...BASE_ENV, ...overrides };
    await writeFile(file, `${Object.entries(merged).map(([k, v]) => `${k}=${v}`).join("\n")}\n`, "utf8");
    return spawnSync("bash", [path.join(root, "scripts/preproduction/preflight.sh")], {
      encoding: "utf8",
      env: { NODE_ENV: "test", PATH: process.env.PATH, HOME: process.env.HOME, PREPROD_ENV_FILE: file },
    });
  }

  it("an env file that never heard of Turnstile (every host before B-39) still passes this gate", async () => {
    const r = await runPreflight({});
    expect(r.status).toBe(65);
    expect(r.stdout).toContain("PREPROD_PREFLIGHT=FAIL reason=git_commit");
    expect(r.stdout).not.toContain("admin_login_turnstile");
  });

  it("explicitly off, and on with a valid site key, both clear the gate", async () => {
    for (const overrides of [
      { [ENV.enabled]: "false" },
      { [ENV.enabled]: "true", [ENV.siteKey]: TEST_SITE_KEY },
    ]) {
      const r = await runPreflight(overrides);
      expect(r.stdout).toContain("PREPROD_PREFLIGHT=FAIL reason=git_commit");
    }
  });

  it("on without a site key / with a typo'd switch / with a literal secret: FAIL at this gate", async () => {
    const missing = await runPreflight({ [ENV.enabled]: "true" });
    expect(missing.status).toBe(65);
    expect(missing.stdout).toContain(
      `PREPROD_PREFLIGHT=FAIL reason=admin_login_turnstile_config_invalid variable=${ENV.siteKey} reason=site_key_missing`,
    );
    const typo = await runPreflight({ [ENV.enabled]: "TRUE", [ENV.siteKey]: TEST_SITE_KEY });
    expect(typo.stdout).toContain("PREPROD_PREFLIGHT=FAIL reason=admin_login_turnstile_config_invalid");
    const literal = await runPreflight({ [ENV.secretKey]: TEST_SECRET });
    expect(literal.stdout).toContain("reason=secret_must_not_be_in_env_file");
    expect(`${literal.stdout}${literal.stderr}`).not.toContain(TEST_SECRET);
  });
});

describe("7. secrets-preflight: the Turnstile secret is checked if and only if the switch is exactly true", () => {
  const matrixNames = readFileSync(path.join(root, "scripts/preproduction/secret-files.txt"), "utf8").trim().split("\n");
  const identities = readFileSync(path.join(root, "scripts/preproduction/secret-identity-files.txt"), "utf8").trim().split("\n");
  const SCRIPT = path.join(root, "scripts/preproduction/secrets-preflight.sh");

  async function fixture() {
    const dir = await mkdtemp(path.join(tmpdir(), "turnstile-secrets-"));
    for (const name of matrixNames) await writeFile(path.join(dir, name), `${name}-fixture\n`, { mode: 0o640 });
    const lines = identities.map((name) => {
      const value = readFileSync(path.join(dir, name));
      return `${createHash("sha256").update(value).digest("hex")}  ${name}`;
    });
    await writeFile(path.join(dir, "secret-identity.sha256"), `${lines.join("\n")}\n`, { mode: 0o600 });
    return dir;
  }

  function hostOnly(dir: string, extra: Record<string, string> = {}) {
    return spawnSync("bash", [SCRIPT, "--host-only"], {
      encoding: "utf8",
      env: { ...process.env, PREPROD_SECRET_ROOT: dir, PREPROD_TEST_MODE: "1", ...extra },
    });
  }

  it.each([[undefined], ["false"], ["TRUE"], ["1"], [""]])(
    "switch %j and no Turnstile file anywhere: PASS (a release made before any key exists)",
    async (value) => {
      const dir = await fixture();
      const result = hostOnly(dir, value === undefined ? {} : { [ENV.enabled]: value });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("SECRET_PREFLIGHT=HOST_ONLY CONSUMER_ACCESS=UNVERIFIED");
    },
  );

  it("switch true: a missing file, an empty file and a symlink all FAIL secret_file", async () => {
    const missing = await fixture();
    expect(hostOnly(missing, { [ENV.enabled]: "true" }).stdout).toContain("SECRET_PREFLIGHT=FAIL reason=secret_file");

    const empty = await fixture();
    await writeFile(path.join(empty, SECRET), "", { mode: 0o640 });
    expect(hostOnly(empty, { [ENV.enabled]: "true" }).stdout).toContain("SECRET_PREFLIGHT=FAIL reason=secret_file");

    const linked = await fixture();
    await writeFile(path.join(linked, "real-target"), "x\n", { mode: 0o640 });
    await symlink(path.join(linked, "real-target"), path.join(linked, SECRET));
    expect(hostOnly(linked, { [ENV.enabled]: "true" }).stdout).toContain("SECRET_PREFLIGHT=FAIL reason=secret_file");
  });

  it("switch true: broad permissions FAIL secret_mode, a proper file PASSes", async () => {
    const dir = await fixture();
    await writeFile(path.join(dir, SECRET), `${TEST_SECRET}\n`, { mode: 0o640 });
    const ok = hostOnly(dir, { [ENV.enabled]: "true" });
    expect(ok.status).toBe(0);
    expect(`${ok.stdout}${ok.stderr}`).not.toContain(TEST_SECRET);

    await chmod(path.join(dir, SECRET), 0o644);
    const broad = hostOnly(dir, { [ENV.enabled]: "true" });
    expect(broad.status).not.toBe(0);
    expect(broad.stdout).toContain("SECRET_PREFLIGHT=FAIL reason=secret_mode");
  });

  it("the same broad-permission file is IGNORED while the switch is off (it is not part of the mandatory set)", async () => {
    const dir = await fixture();
    await writeFile(path.join(dir, SECRET), `${TEST_SECRET}\n`, { mode: 0o644 });
    expect(hostOnly(dir).status).toBe(0);
    expect(hostOnly(dir, { [ENV.enabled]: "false" }).status).toBe(0);
  });

  it("a consumer matrix file with no trailing newline cannot swallow the conditional row", async () => {
    const dir = await fixture();
    const matrix = path.join(dir, "matrix.tsv");
    await writeFile(matrix, readFileSync(path.join(root, "scripts/preproduction/secret-consumers.tsv"), "utf8").trimEnd());
    const result = hostOnly(dir, { [ENV.enabled]: "true", PREPROD_SECRET_CONSUMER_MATRIX: matrix });
    // matrix valid, conditional row parsed on its own line -> reaches (and fails) the file check
    expect(result.stdout).toContain("SECRET_CONSUMER_MATRIX=PASS count=15");
    expect(result.stdout).toContain("SECRET_PREFLIGHT=FAIL reason=secret_file");
  });

  describe("full consumer-access mode (stubbed docker / getfacl / stat / id)", () => {
    async function fullFixture(options: { postgresCanRead?: boolean; aclPermissions?: string } = {}) {
      const dir = await fixture();
      await writeFile(path.join(dir, SECRET), `${TEST_SECRET}\n`, { mode: 0o640 });
      const bin = path.join(dir, "bin");
      const log = path.join(dir, "docker.log");
      const traverse = ["nginx-a", "nginx-b", "nginx-c", "nginx-d"].map((name) => path.join(dir, name));
      await mkdir(bin);
      for (const directory of traverse) await mkdir(directory);
      const page = path.join(dir, "nginx-d", "__preprod_maintenance.html");
      await writeFile(page, "<h1>Maintenance in progress</h1>\n", { mode: 0o644 });
      const app = `channel_credential_encryption_key_v1|channel_credential_fingerprint_key|totp_encryption_key|tracking_hash_salt|admin-smoke-password|${SECRET}`;
      const appUid = (name: string) => `1001:1001:${name}`;
      await writeFile(path.join(bin, "id"), `#!/usr/bin/env bash\necho 1000\n`, { mode: 0o700 });
      await writeFile(
        path.join(bin, "stat"),
        [
          "#!/usr/bin/env bash",
          'path="${@: -1}"; format="$2"',
          'if [[ "$format" == "%a" || "$format" == "%Lp" ]]; then',
          '  case "${path##*/}" in preprod-curl.conf|backup_role.pgpass|secret-identity.sha256) echo 600 ;; *) echo 640 ;; esac',
          'elif [[ "$format" == "%u:%g" ]]; then',
          '  [[ "${path##*/}" == "backup_role.pgpass" ]] && echo 0:0 || echo 1000:1000',
          "else exit 1; fi",
          "",
        ].join("\n"),
        { mode: 0o700 },
      );
      await writeFile(
        path.join(bin, "getfacl"),
        [
          "#!/usr/bin/env bash",
          'path="${@: -1}"; name="${path##*/}"',
          "echo 'user::rw-'",
          'case "$name" in',
          `  ${app}) echo 'user:1001:${options.aclPermissions ?? "r--"}' ; echo 'mask::r--' ;;`,
          "  postgres_admin_password|migration_owner_password|web_app_password|worker_app_password|scheduler_app_password|analyst_ro_password|backup_role_password) echo 'user:999:r--' ; echo 'mask::r--' ;;",
          "  nginx-preprod.htpasswd) echo 'user:33:r--' ; echo 'mask::r--' ;;",
          "  nginx-a|nginx-b|nginx-c|nginx-d) echo 'user:33:--x' ; echo 'mask::--x' ;;",
          "esac",
          "echo 'group::---'",
          "echo 'other::---'",
          "",
        ].join("\n"),
        { mode: 0o700 },
      );
      await writeFile(
        path.join(bin, "docker"),
        [
          "#!/usr/bin/env bash",
          'printf "%s\\n" "$*" >>"$SECRET_PROBE_LOG"',
          'if [[ "$1" == "info" ]]; then echo "[\\"name=seccomp\\"]"; exit 0; fi',
          'if [[ "$1" == "image" && "$2" == "inspect" ]]; then exit 0; fi',
          '[[ "$1" == "run" ]] || exit 97',
          "user=''; source_path=''",
          'while (($#)); do case "$1" in --user) user="$2"; shift 2 ;; --mount) source_path="${2#*src=}"; source_path="${source_path%%,dst=*}"; shift 2 ;; *) shift ;; esac; done',
          'name="${source_path##*/}"',
          'case "$user:$name" in',
          `  ${["channel_credential_encryption_key_v1", "channel_credential_fingerprint_key", "totp_encryption_key", "tracking_hash_salt", "admin-smoke-password", SECRET].map(appUid).join("|")}) exit 0 ;;`,
          "  999:999:postgres_admin_password|999:999:migration_owner_password|999:999:web_app_password|999:999:worker_app_password|999:999:scheduler_app_password|999:999:analyst_ro_password|999:999:backup_role_password) exit 0 ;;",
          "  0:0:backup_role.pgpass) exit 0 ;;",
          "  33:33:__preprod_maintenance.html) exit 0 ;;",
          "esac",
          `if [[ "${options.postgresCanRead ? "1" : "0"}" == "1" && "$user" == "999:999" && "$name" == "${SECRET}" ]]; then exit 0; fi`,
          "exit 1",
          "",
        ].join("\n"),
        { mode: 0o700 },
      );
      return {
        dir,
        log,
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          PREPROD_TEST_MODE: "1",
          PREPROD_SECRET_ROOT: dir,
          PREPROD_TEST_NGINX_TRAVERSE_PATHS: traverse.join(":"),
          PREPROD_TEST_MAINTENANCE_PAGE: page,
          PREPROD_TEST_MAINTENANCE_MARKER: path.join(dir, "nginx-d", "enabled"),
          CPS_NOVEL_APP_IMAGE: "approved-app:test",
          SECRET_PROBE_LOG: log,
        } as NodeJS.ProcessEnv,
      };
    }

    const full = (env: NodeJS.ProcessEnv, extra: Record<string, string> = {}) =>
      spawnSync("bash", [SCRIPT], { encoding: "utf8", env: { ...env, ...extra } });

    it("switch true + a correct file: PASS, probed as the app uid (readable) and the postgres uid (not readable)", async () => {
      const f = await fullFixture();
      const result = full(f.env, { [ENV.enabled]: "true" });
      expect(result.stdout).toContain("SECRET_PREFLIGHT=PASS CONSUMER_ACCESS=VERIFIED");
      const probes = (await readFile(f.log, "utf8")).split("\n").filter((line) => line.includes(`/${SECRET}`));
      expect(probes.some((line) => line.includes("--user 1001:1001"))).toBe(true);
      expect(probes.some((line) => line.includes("--user 999:999"))).toBe(true);
      expect(`${result.stdout}${result.stderr}`).not.toContain(TEST_SECRET);
    });

    it("switch off: PASS and the Turnstile file is never probed", async () => {
      const f = await fullFixture();
      const result = full(f.env);
      expect(result.stdout).toContain("SECRET_PREFLIGHT=PASS CONSUMER_ACCESS=VERIFIED");
      expect((await readFile(f.log, "utf8"))).not.toContain(SECRET);
    });

    it("switch true: a postgres-readable file FAILs the negative probe", async () => {
      const f = await fullFixture({ postgresCanRead: true });
      const result = full(f.env, { [ENV.enabled]: "true" });
      expect(result.status).not.toBe(0);
      expect(result.stdout).toContain("SECRET_PREFLIGHT=FAIL reason=negative_access_postgres");
    });

    it("switch true: a wrong named-ACL permission FAILs consumer_acl", async () => {
      const f = await fullFixture({ aclPermissions: "rw-" });
      const result = full(f.env, { [ENV.enabled]: "true" });
      expect(result.status).not.toBe(0);
      expect(result.stdout).toMatch(/SECRET_PREFLIGHT=FAIL reason=consumer_acl/);
    });
  });
});

const dockerComposeOk = spawnSync("docker", ["compose", "version"], { stdio: "ignore" }).status === 0;

describe.skipIf(!dockerComposeOk)("8. rendered Compose: the switch really arrives in the container, and the secret mount is conditional", () => {
  const RENDER_ENV: Record<string, string> = {
    CPS_NOVEL_APP_IMAGE: "cps-novel-render-probe:v0",
    APP_VERSION: "0.1.0",
    GIT_COMMIT: "a".repeat(40),
    BUILD_DATE: "2026-10-07T00:00:00Z",
    NEXT_PUBLIC_BUILD_VERSION: "v0.1.0",
    P1_12_COMPOSE_PROJECT: "cps-novel",
    SITE_URL: SITE_MODE_CASES[1].SITE_URL,
    ADMIN_CANONICAL_ORIGIN: SITE_MODE_CASES[1].ADMIN_CANONICAL_ORIGIN,
    TZ: "Asia/Tokyo",
    P1_12_WEB_DATABASE_URL: "postgresql://web_app:placeholder@postgres/cps_novel",
    P1_12_WORKER_DATABASE_URL: "postgresql://worker_app:placeholder@postgres/cps_novel",
    P1_12_SCHEDULER_DATABASE_URL: "postgresql://scheduler_app:placeholder@postgres/cps_novel",
    P1_12_POSTGRES_ADMIN_PASSWORD_FILE: "/opt/cps-novel/shared/secrets/postgres_admin_password",
    P1_12_MIGRATION_OWNER_PASSWORD_FILE: "/opt/cps-novel/shared/secrets/migration_owner_password",
    P1_12_WEB_APP_PASSWORD_FILE: "/opt/cps-novel/shared/secrets/web_app_password",
    P1_12_WORKER_APP_PASSWORD_FILE: "/opt/cps-novel/shared/secrets/worker_app_password",
    P1_12_SCHEDULER_APP_PASSWORD_FILE: "/opt/cps-novel/shared/secrets/scheduler_app_password",
    P1_12_ANALYST_RO_PASSWORD_FILE: "/opt/cps-novel/shared/secrets/analyst_ro_password",
    P1_12_BACKUP_ROLE_PASSWORD_FILE: "/opt/cps-novel/shared/secrets/backup_role_password",
    CHANNEL_CREDENTIAL_ACTIVE_KEY_VERSION: "1",
    CHANNEL_CREDENTIAL_ENCRYPTION_KEY_V1_FILE: "/opt/cps-novel/shared/secrets/channel_credential_encryption_key_v1",
    CHANNEL_CREDENTIAL_FINGERPRINT_KEY_FILE: "/opt/cps-novel/shared/secrets/channel_credential_fingerprint_key",
    WORKER_LIGHT_ID: "compose-light",
    WORKER_LIGHT_TASK_ALLOWLIST: "sitemap_refresh,sitemap.daily_fallback.v1,home_carousel.compute.v1",
    WORKER_TASK_ALLOWLIST: "credential.validate.v1",
  };

  type Rendered = {
    services: Record<string, { environment?: Record<string, string>; secrets?: Array<{ source: string }> }>;
    secrets?: Record<string, { file?: string }>;
  };

  function render(files: string[], env: Record<string, string> = {}): Rendered {
    const result = spawnSync(
      "docker",
      ["compose", "-p", "cps-novel", ...files.flatMap((file) => ["-f", file]), "config", "--format", "json"],
      { cwd: root, encoding: "utf8", env: { ...process.env, ...RENDER_ENV, ...env } },
    );
    expect(result.status, result.stderr).toBe(0);
    return JSON.parse(result.stdout) as Rendered;
  }

  const rootOnly = ["docker-compose.yml"];
  const withOverlay = ["docker-compose.yml", "infra/preproduction/docker-compose.yml"];

  it.each([
    ["root compose alone", rootOnly],
    ["root + preproduction overlay", withOverlay],
  ])("%s: web gets the default-off values; worker/worker-light/scheduler get none", (_label, files) => {
    const rendered = render(files);
    const web = rendered.services.web!.environment!;
    expect(web[ENV.enabled]).toBe("false");
    expect(web[ENV.siteKey]).toBe("");
    for (const name of ["worker", "worker-light", "scheduler"]) {
      const keys = Object.keys(rendered.services[name]!.environment ?? {});
      expect(keys.filter((key) => key.startsWith("ADMIN_LOGIN_TURNSTILE_")), name).toEqual([]);
    }
  });

  it("an explicit enable + site key from the environment arrive in web (root and overlay)", () => {
    for (const files of [rootOnly, withOverlay]) {
      const web = render(files, { [ENV.enabled]: "true", [ENV.siteKey]: TEST_SITE_KEY }).services.web!.environment!;
      expect(web[ENV.enabled]).toBe("true");
      expect(web[ENV.siteKey]).toBe(TEST_SITE_KEY);
    }
  });

  it("root compose alone passes the direct secret and the _FILE path through to web as given (local / X8 style)", () => {
    const web = render(rootOnly, { [ENV.secretKey]: TEST_SECRET, [ENV.secretKeyFile]: "/run/x" }).services.web!.environment!;
    expect(web[ENV.secretKey]).toBe(TEST_SECRET);
    expect(web[ENV.secretKeyFile]).toBe("/run/x");
  });

  it("overlay pins the direct secret EMPTY even if the environment tries to supply one, and fixes the _FILE path", () => {
    const web = render(withOverlay, { [ENV.secretKey]: TEST_SECRET, [ENV.secretKeyFile]: "/elsewhere" }).services.web!.environment!;
    expect(web[ENV.secretKey]).toBe("");
    expect(web[ENV.secretKeyFile]).toBe(`/run/secrets/${SECRET}`);
  });

  it("the overlay mounts the secret into web only, from /dev/null unless a source is supplied", () => {
    const rendered = render(withOverlay);
    expect(rendered.services.web!.secrets!.map((entry) => entry.source)).toContain(SECRET);
    for (const name of ["worker", "worker-light", "scheduler"]) {
      expect((rendered.services[name]!.secrets ?? []).map((entry) => entry.source), name).not.toContain(SECRET);
    }
    expect(rendered.secrets![SECRET]!.file).toBe("/dev/null");
    const sourced = render(withOverlay, { ADMIN_LOGIN_TURNSTILE_SECRET_SOURCE: "/opt/cps-novel/shared/secrets/x" });
    expect(sourced.secrets![SECRET]!.file).toBe("/opt/cps-novel/shared/secrets/x");
  });

  describe("through the real preprod_compose (lib.sh), which derives the secret source from the switch", () => {
    async function renderViaLib(env: Record<string, string>) {
      const dir = await mkdtemp(path.join(tmpdir(), "preprod-compose-turnstile-"));
      const envFile = path.join(dir, "preprod.env");
      await writeFile(envFile, `${Object.entries(env).map(([k, v]) => `${k}=${v}`).join("\n")}\n`, "utf8");
      const result = spawnSync(
        "bash",
        ["-c", `set -euo pipefail\nsource "${path.join(root, "scripts/preproduction/lib.sh")}"\npreprod_load_env\npreprod_compose config --format json`],
        {
          cwd: root,
          encoding: "utf8",
          env: { PATH: process.env.PATH, HOME: process.env.HOME, PREPROD_ENV_FILE: envFile },
        },
      );
      expect(result.status, result.stderr).toBe(0);
      return JSON.parse(result.stdout) as Rendered;
    }

    const base = { ...RENDER_ENV, PREPROD_SHARED_ROOT: "/opt/cps-novel/shared" };

    it("switch absent or false -> /dev/null, nothing about the host file is required", async () => {
      for (const extra of [{}, { [ENV.enabled]: "false" }, { [ENV.enabled]: "TRUE" }]) {
        const rendered = await renderViaLib({ ...base, ...extra });
        expect(rendered.secrets![SECRET]!.file, JSON.stringify(extra)).toBe("/dev/null");
      }
    });

    it("switch exactly true -> <PREPROD_SHARED_ROOT>/secrets/<name>, and the switch + site key reach web", async () => {
      const rendered = await renderViaLib({ ...base, [ENV.enabled]: "true", [ENV.siteKey]: TEST_SITE_KEY });
      expect(rendered.secrets![SECRET]!.file).toBe(`/opt/cps-novel/shared/secrets/${SECRET}`);
      const web = rendered.services.web!.environment!;
      expect(web[ENV.enabled]).toBe("true");
      expect(web[ENV.siteKey]).toBe(TEST_SITE_KEY);
      expect(web[ENV.secretKey]).toBe("");
      expect(web[ENV.secretKeyFile]).toBe(`/run/secrets/${SECRET}`);
    });

    it("an inherited ADMIN_LOGIN_TURNSTILE_SECRET_SOURCE cannot redirect the mount (preprod_compose owns it)", async () => {
      const dir = await mkdtemp(path.join(tmpdir(), "preprod-compose-turnstile-"));
      const envFile = path.join(dir, "preprod.env");
      await writeFile(envFile, `${Object.entries(base).map(([k, v]) => `${k}=${v}`).join("\n")}\n`, "utf8");
      const result = spawnSync(
        "bash",
        ["-c", `set -euo pipefail\nsource "${path.join(root, "scripts/preproduction/lib.sh")}"\npreprod_load_env\npreprod_compose config --format json`],
        {
          cwd: root,
          encoding: "utf8",
          env: { PATH: process.env.PATH, HOME: process.env.HOME, PREPROD_ENV_FILE: envFile, ADMIN_LOGIN_TURNSTILE_SECRET_SOURCE: "/etc/shadow" },
        },
      );
      expect(result.status, result.stderr).toBe(0);
      expect((JSON.parse(result.stdout) as Rendered).secrets![SECRET]!.file).toBe("/dev/null");
    });
  });
});

describe("9. X8 validator and docs mention every variable", () => {
  it("x8-validate-compose.mjs asserts the switch, the site key, the secret pair, and the worker/worker-light/scheduler ban", () => {
    for (const name of [ENV.enabled, ENV.siteKey, ENV.secretKey, ENV.secretKeyFile]) {
      expect(x8Validator, name).toContain(name);
    }
    expect(x8Validator).toContain('startsWith("ADMIN_LOGIN_TURNSTILE_")');
    expect(x8Validator).toContain('services["worker-light"]');
  });

  it("the feature-flag registry and the enablement doc cover every variable and the secret file name", () => {
    const registry = read("docs/governance/feature-flag-registry.md");
    const doc = read("docs/operations/ADMIN_LOGIN_TURNSTILE_ENABLEMENT_2026-10-07.md");
    for (const name of ALL_NAMES) {
      expect(registry, `registry ${name}`).toContain(name);
      expect(doc, `doc ${name}`).toContain(name);
    }
    expect(doc).toContain(SECRET);
    expect(registry).toContain(SECRET);
  });

  it("the secret never reaches health output, the public site, or any client component", () => {
    const filesUnder = (dir: string): string[] =>
      readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((entry) => {
        const relative = path.join(dir, entry.name);
        return entry.isDirectory() ? filesUnder(relative) : [relative];
      });
    // health endpoints and the server-side health service never look at it
    for (const file of [...filesUnder("src/server/health"), ...filesUnder("src/app/api/health")]) {
      expect(read(file), file).not.toMatch(/ADMIN_LOGIN_TURNSTILE|admin-login-turnstile/);
    }
    // only the login page, its action and the login form's *type* import touch the module
    const importers = [...filesUnder("src"), ...filesUnder("scripts"), ...filesUnder("worker"), ...filesUnder("scheduler")]
      .filter((file) => /\.(ts|tsx|mjs)$/.test(file))
      .filter((file) => /admin-login-turnstile/.test(read(file)) && /from\s+["'][^"']*admin-login-turnstile["']/.test(read(file)))
      .sort();
    expect(importers).toEqual(
      [
        "scripts/admin-login-turnstile-preflight.ts",
        "src/app/(admin-auth)/login/_actions.ts",
        "src/app/(admin-auth)/login/_components/login-form.tsx",
        "src/app/(admin-auth)/login/page.tsx",
      ].sort(),
    );
    // and the one client component that imports it does so as a type only (erased from the client bundle)
    const form = read("src/app/(admin-auth)/login/_components/login-form.tsx");
    expect(form).toMatch(/import type \{ AdminLoginTurnstilePublicState \} from "@\/lib\/auth\/admin-login-turnstile";/);
    expect(form).not.toMatch(/^import \{[^}]*\} from "@\/lib\/auth\/admin-login-turnstile"/m);
    expect(read("src/app/(admin-auth)/login/_components/turnstile-widget.tsx")).not.toMatch(/admin-login-turnstile/);
  });

  it("the widget's script URL is the one the TS module documents (single Cloudflare host for script and siteverify)", async () => {
    const { TURNSTILE_SCRIPT_SRC, TURNSTILE_SITEVERIFY_URL } = await import("@/lib/auth/admin-login-turnstile");
    expect(read("src/app/(admin-auth)/login/_components/turnstile-widget.tsx")).toContain(`"${TURNSTILE_SCRIPT_SRC}"`);
    expect(new URL(TURNSTILE_SCRIPT_SRC).host).toBe("challenges.cloudflare.com");
    expect(new URL(TURNSTILE_SITEVERIFY_URL).host).toBe("challenges.cloudflare.com");
  });

  it("the enablement doc is linked from the preprod runbook", () => {
    expect(read("docs/operations/PREPRODUCTION_DEPLOYMENT_RUNBOOK.md")).toContain("ADMIN_LOGIN_TURNSTILE_ENABLEMENT_2026-10-07.md");
  });
});

describe("10. the admin host's response headers allow the Turnstile iframe and still forbid framing us", () => {
  // The widget is an iframe/script from challenges.cloudflare.com embedded in OUR
  // page. X-Frame-Options only governs who may frame the admin pages, and the
  // admin host sets no Content-Security-Policy at all, so nothing blocks the
  // embed. If a CSP is ever added anywhere, it must keep allowing Cloudflare or
  // the login silently becomes unusable the moment the switch is on.
  function configFiles(dir: string): string[] {
    return readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((entry) => {
      const relative = path.join(dir, entry.name);
      return entry.isDirectory() ? configFiles(relative) : [relative];
    });
  }

  it("admin edge snippets: X-Frame-Options DENY (others cannot embed us), no CSP, no frame-src/COEP restriction", () => {
    for (const file of [
      "infra/preproduction/nginx/cps-novel-edge-admin-security.conf",
      "infra/preproduction/nginx/cps-novel-preprod-security.conf",
    ]) {
      const text = read(file);
      expect(text, file).toContain('add_header X-Frame-Options "DENY" always;');
      expect(text, file).not.toMatch(/Content-Security-Policy/i);
      expect(text, file).not.toMatch(/Cross-Origin-Embedder-Policy/i);
      // camera/microphone/geolocation are the only Permissions-Policy entries; Turnstile needs none of them
      expect(text, file).toMatch(/Permissions-Policy "camera=\(\), microphone=\(\), geolocation=\(\)"/);
    }
  });

  it("no nginx template, Next config, proxy or app code sets a CSP unless it allows challenges.cloudflare.com", () => {
    const candidates = [
      ...configFiles("infra"),
      "next.config.ts",
      "src/proxy.ts",
      ...configFiles("src/app").filter((file) => /\.(ts|tsx)$/.test(file)),
    ];
    for (const file of candidates) {
      let text: string;
      try {
        text = read(file);
      } catch {
        continue;
      }
      if (!/Content-Security-Policy|frame-ancestors|connect-src|frame-src/i.test(code(text))) continue;
      expect(text, `${file} sets a CSP: it must allow challenges.cloudflare.com for script and frame`).toMatch(
        /challenges\.cloudflare\.com/,
      );
    }
  });
});
