import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Phase 2C · 应用镜像入口（`preprod_compose_app_up` / `preprod_compose_app_run`）
 * 的运行时契约。
 *
 * 缘起：B2 fresh-init 在 migration 入口以 `unknown flag: --no-build` 失败。
 * 目标机 Compose v5.5.1 的 `run` 子命令**没有** `--no-build`（`up` 仍然有），
 * 而此前两个入口都硬写了这个 flag。
 *
 * 🔴 光删掉那个 flag 是不合格的修法，本文件用真实 daemon 证明为什么：
 * merged config 里只要还留着 build: 段、批准镜像本地又缺失，
 * `docker compose run --pull never` 会**就地构建并以 0 退出**——目标机于是跑着
 * 一个没被批准、没经过归档校验的工件。见
 * 「核心 mutation：闸门撤掉之后，危险是真的」那一条。
 *
 * 因此这组用例覆盖的是**行为**，不是"脚本里写了这句话"：
 *   CASE 1  批准镜像在本地      → one-off PASS，不 build 不 pull
 *   CASE 2  批准镜像缺失        → FAIL CLOSED，不 build 不 pull
 *   CASE 3  Dockerfile 还在 + 镜像缺失 → 仍然 FAIL，不得就地构建（核心 mutation）
 *   CASE 4  身份判据不符（retag/掉包） → 身份闸门拒绝
 *   CASE 5  migration one-off 真能跑（且 argv 被目标 CLI 接受）
 *   CASE 6  verify-admin-auth one-off 的 secret / bind / env 照常可用
 *
 * 另外把"CLI flag 契约"本身变成用例：**脚本发出的每一个 flag，都必须在该子命令
 * 真实的 `--help` 里存在**。这正是上一轮 CI 没抓住的那一层。
 */

const root = process.cwd();
const LIB = path.join(root, "scripts/preproduction/lib.sh");
const PROBE_NETWORK = "cps_novel_oneoff_probe";
const BYPASS_NETWORK = "cps_novel_oneoff_probe_bypass";
const PRESENT_TAG = "cps-novel-oneoff-probe-present:probe";
const ABSENT_TAG = "cps-novel-oneoff-probe-absent:does-not-exist";
const BUILT_TAG = "cps-novel-oneoff-probe-built:does-not-exist";

const dockerOk =
  spawnSync("docker", ["info", "--format", "{{.ServerVersion}}"], { encoding: "utf8" }).status === 0;

const sh = (script: string, env: Record<string, string> = {}) =>
  spawnSync("bash", ["-c", script], { cwd: root, env: { ...process.env, ...env }, encoding: "utf8" });

const both = (r: { stdout: string | null; stderr: string | null }) => `${r.stdout ?? ""}${r.stderr ?? ""}`;

/** 从 `docker compose <sub> --help` 真实输出里抽出长 flag 集合。 */
function cliFlags(subcommand: string): Set<string> {
  const help = spawnSync("docker", ["compose", subcommand, "--help"], { encoding: "utf8" });
  const flags = new Set<string>();
  for (const match of (help.stdout ?? "").matchAll(/(?:^|\s)(--[a-zA-Z][a-zA-Z0-9-]*)/g)) flags.add(match[1]);
  return flags;
}

/** 从记录下来的 argv 里抽出脚本**发出**的长 flag（`--pull never` 的 never 不算 flag）。 */
function emittedFlags(argv: string[]): string[] {
  return argv.filter((token) => token.startsWith("--"));
}

const imageExists = (tag: string) =>
  spawnSync("docker", ["image", "inspect", tag], { encoding: "utf8" }).status === 0;
const untag = (tag: string) => spawnSync("docker", ["image", "rm", "-f", tag], { encoding: "utf8" });

// --- 真实仓库文件的 merged config ------------------------------------------
//
// 与 scripts/preproduction/verify-compose-identity.sh 同一套占位环境：渲染只读，
// 不接触 daemon、不创建任何资源。
const RENDER_ENV: Record<string, string> = {
  CPS_NOVEL_APP_IMAGE: "cps-novel-render-probe:v0",
  APP_VERSION: "0.1.0",
  GIT_COMMIT: "a".repeat(40),
  BUILD_DATE: "2026-09-21T00:00:00Z",
  NEXT_PUBLIC_BUILD_VERSION: "v0.1.0",
  P1_12_COMPOSE_PROJECT: "cps-novel",
  SITE_URL: "https://www.bangbangji.cloud",
  ADMIN_CANONICAL_ORIGIN: "https://zbcwf.bangbangji.cloud",
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
  WORKER_TASK_ALLOWLIST: "credential.validate.v1",
};

function renderConfig(files: string[], extraFormat: string[] = []) {
  return spawnSync(
    "docker",
    ["compose", "-p", "cps-novel", ...files.flatMap((f) => ["-f", f]), "config", ...extraFormat],
    { cwd: root, env: { ...process.env, ...RENDER_ENV }, encoding: "utf8" },
  );
}

describe.skipIf(!dockerOk)("Compose CLI flag 契约（按真实 --help 判定，不按版本号猜）", () => {
  it("记录在跑的 Compose 版本，并确认 run/up 的 --no-build 能力差异是真的", () => {
    const version = spawnSync("docker", ["compose", "version", "--short"], { encoding: "utf8" });
    expect(version.status).toBe(0);
    expect((version.stdout ?? "").trim()).toMatch(/^v?\d+\.\d+/);
    // 🔴 不断言"版本号 = v5.x"。判据是能力，不是版本字符串：`up` 有 --no-build，
    // `run` 在目标机（v5.5.1）上没有。脚本必须按能力走，而不是按版本号猜。
    expect(cliFlags("up").has("--no-build")).toBe(true);
    expect(cliFlags("run").has("--pull")).toBe(true);
  });

  it("🔴 源码里不得再无条件把 --no-build 写死在 run 上", async () => {
    const lib = await readFile(LIB, "utf8");
    // `run` 那一行只允许通过能力探测追加，不允许字面量硬写。
    expect(lib).not.toMatch(/preprod_compose run[^\n]*--no-build/);
    expect(lib).toContain("preprod_compose_subcommand_has_flag");
  });
});

describe.skipIf(!dockerOk)("真实仓库 compose 文件：preproduction 目标机没有构建源", () => {
  it("🔴 preproduction merged config 里三个应用服务都没有 build 段", () => {
    const rendered = renderConfig(["docker-compose.yml", "infra/preproduction/docker-compose.yml"]);
    expect(both(rendered)).not.toContain("error while interpolating");
    expect(rendered.status).toBe(0);
    const lines = (rendered.stdout ?? "").split("\n");
    expect(lines.filter((line) => /^ {4}build:$/.test(line))).toEqual([]);

    const json = renderConfig(
      ["docker-compose.yml", "infra/preproduction/docker-compose.yml"],
      ["--format", "json"],
    );
    expect(json.status).toBe(0);
    const config = JSON.parse(json.stdout ?? "{}") as {
      services: Record<string, Record<string, unknown>>;
    };
    for (const name of ["web", "worker", "scheduler"]) {
      expect(config.services[name], `${name} 缺失`).toBeTruthy();
      expect(config.services[name].build, `${name} 仍带 build 段`).toBeUndefined();
      expect(config.services[name].image).toBe(RENDER_ENV.CPS_NOVEL_APP_IMAGE);
      expect(config.services[name].pull_policy).toBe("never");
    }
  });

  it("构建机能力没有被误删：只加载根 compose 时 build 段仍在", () => {
    const json = renderConfig(["docker-compose.yml"], ["--format", "json"]);
    expect(json.status).toBe(0);
    const config = JSON.parse(json.stdout ?? "{}") as {
      services: Record<string, Record<string, unknown>>;
    };
    // build-release-archive.sh 只用根文件构建（-f docker-compose.yml build web）。
    for (const name of ["web", "worker", "scheduler"]) {
      expect(config.services[name].build, `${name} 的构建能力被误删`).toBeTruthy();
    }
  });

  it("🔴 CASE 6 前置：抹掉 build 没有误伤 one-off 需要的 user / secrets / network / env", () => {
    const json = renderConfig(
      ["docker-compose.yml", "infra/preproduction/docker-compose.yml"],
      ["--format", "json"],
    );
    const config = JSON.parse(json.stdout ?? "{}") as {
      services: Record<string, { user?: string; secrets?: { source: string }[]; networks?: Record<string, unknown>; environment?: Record<string, string> }>;
    };
    const web = config.services.web;
    expect(web.user).toBe("1001:1001");
    expect((web.secrets ?? []).map((s) => s.source).sort()).toEqual([
      "channel_credential_encryption_key_v1",
      "channel_credential_fingerprint_key",
      "totp_encryption_key",
      "tracking_hash_salt",
    ]);
    expect(Object.keys(web.networks ?? {})).toContain("runtime");
    // verify-admin-auth.ts 与 migration 都靠这些 env 找到密钥与数据库。
    expect(web.environment?.TOTP_ENCRYPTION_KEY_FILE).toBe("/run/secrets/totp_encryption_key");
    expect(web.environment?.DATABASE_URL).toBe(RENDER_ENV.P1_12_WEB_DATABASE_URL);
  });
});

// ---------------------------------------------------------------------------
// 行为层：一个与生产同形状（image + build + overlay）的最小 rig，跑真 daemon。
// ---------------------------------------------------------------------------
let rig = "";
const rigFile = (relative: string) => path.join(rig, relative);

/** 在 rig 里以真实 lib.sh 执行一段脚本。PREPROD_REPO_ROOT 由 lib.sh 自身位置推导。 */
function rigRun(script: string, env: Record<string, string> = {}) {
  return spawnSync("bash", ["-c", `source '${rigFile("scripts/preproduction/lib.sh")}'\n${script}`], {
    cwd: rig,
    env: {
      ...process.env,
      PREPROD_ENV_FILE: rigFile("env/preprod.env"),
      ...env,
    },
    encoding: "utf8",
  });
}

describe.skipIf(!dockerOk)("one-off 应用容器的真实运行时行为", () => {
  beforeAll(async () => {
    rig = await mkdtemp(path.join(tmpdir(), "preprod-oneoff-rig-"));
    await mkdir(rigFile("infra/preproduction"), { recursive: true });
    await mkdir(rigFile("scripts/preproduction"), { recursive: true });
    await mkdir(rigFile("env"), { recursive: true });
    await mkdir(rigFile("shared"), { recursive: true });

    // 被测对象是真实实现本身，不是它的副本语义：直接把仓库里的脚本拷进来。
    await cp(LIB, rigFile("scripts/preproduction/lib.sh"));
    await cp(
      path.join(root, "scripts/preproduction/image-identity.mjs"),
      rigFile("scripts/preproduction/image-identity.mjs"),
    );

    // rig 的"根 compose"刻意复刻生产形状：同一个服务既有 image: 又有 build:，
    // 且 build.args 里有一个必填变量（对应生产的 BUILD_DATE）。
    await writeFile(
      rigFile("docker-compose.yml"),
      [
        "x-app-runtime: &app-runtime",
        "  image: ${CPS_NOVEL_APP_IMAGE:?CPS_NOVEL_APP_IMAGE is required}",
        "  build:",
        "    context: .",
        "    args:",
        "      PROBE_BUILD_ARG: ${PROBE_BUILD_ARG:?PROBE_BUILD_ARG is required}",
        '  user: "1001:1001"',
        "  networks:",
        "    - runtime",
        "",
        "services:",
        "  app:",
        "    <<: *app-runtime",
        '    command: ["true"]',
        "    environment:",
        "      PROBE_ENV: ${PROBE_ENV:-probe-env-value}",
        "",
        "networks:",
        "  runtime:",
        `    name: \${PROBE_NETWORK_NAME:-${PROBE_NETWORK}}`,
        "",
      ].join("\n"),
    );
    await writeFile(
      rigFile("Dockerfile"),
      ["FROM alpine:3.20", "ARG PROBE_BUILD_ARG", "RUN echo built > /probe-built", 'CMD ["true"]', ""].join("\n"),
    );
    // rig overlay 用与生产 overlay **同一语法**抹掉 build，并保留 one-off 需要的
    // secrets —— CASE 6 靠它证明 secret 挂载没被这次改动影响。
    await writeFile(
      rigFile("infra/preproduction/docker-compose.yml"),
      [
        "services:",
        "  app:",
        "    build: !reset null",
        "    pull_policy: never",
        "    secrets:",
        "      - probe_secret",
        "",
        "secrets:",
        "  probe_secret:",
        "    file: ${PREPROD_SHARED_ROOT}/probe_secret",
        "",
      ].join("\n"),
    );
    await writeFile(
      rigFile("env/preprod.env"),
      [
        "P1_12_COMPOSE_PROJECT=cps-novel",
        "PROBE_BUILD_ARG=probe",
        `PREPROD_SHARED_ROOT=${rigFile("shared")}`,
        "",
      ].join("\n"),
      { mode: 0o600 },
    );
    await writeFile(rigFile("shared/probe_secret"), "probe-secret-value\n", { mode: 0o644 });
    await writeFile(rigFile("shared/admin-password"), "probe-admin-password\n", { mode: 0o644 });
    await chmod(rigFile("shared/probe_secret"), 0o644);

    // 批准镜像的替身：alpine 打上 rig 专用 tag。行为测的是 Compose 与闸门，
    // 不是应用镜像内容。
    if (!imageExists("alpine:3.20")) {
      expect(spawnSync("docker", ["pull", "alpine:3.20"], { encoding: "utf8" }).status).toBe(0);
    }
    expect(spawnSync("docker", ["tag", "alpine:3.20", PRESENT_TAG], { encoding: "utf8" }).status).toBe(0);
    untag(ABSENT_TAG);
    untag(BUILT_TAG);
  }, 300_000);

  afterAll(async () => {
    for (const tag of [PRESENT_TAG, ABSENT_TAG, BUILT_TAG]) untag(tag);
    spawnSync("docker", ["network", "rm", PROBE_NETWORK, BYPASS_NETWORK], { encoding: "utf8" });
    if (rig) await rm(rig, { recursive: true, force: true });
  });

  it("CASE 1：批准镜像在本地 → one-off 跑通，不 build 不 pull", () => {
    const before = spawnSync("docker", ["image", "inspect", PRESENT_TAG, "--format", "{{.Id}}"], {
      encoding: "utf8",
    }).stdout.trim();
    const r = rigRun(`preprod_load_env; preprod_compose_app_run app sh -c 'echo ONEOFF_OK'`, {
      CPS_NOVEL_APP_IMAGE: PRESENT_TAG,
    });
    const out = both(r);
    expect(out).toContain("ONEOFF_OK");
    expect(r.status).toBe(0);
    expect(out).not.toMatch(/Building|Sending build context|Step 1\//i);
    expect(out).not.toMatch(/Pulling from|Pull complete/i);
    const after = spawnSync("docker", ["image", "inspect", PRESENT_TAG, "--format", "{{.Id}}"], {
      encoding: "utf8",
    }).stdout.trim();
    expect(after).toBe(before);
  }, 180_000);

  it("CASE 2：批准镜像缺失 → FAIL CLOSED（approved_image_missing），不 build 不 pull", () => {
    const r = rigRun(`preprod_load_env; preprod_compose_app_run app sh -c 'echo SHOULD_NOT_RUN'`, {
      CPS_NOVEL_APP_IMAGE: ABSENT_TAG,
    });
    const out = both(r);
    expect(r.status).not.toBe(0);
    expect(out).toContain("APP_RUNTIME=REFUSED reason=approved_image_missing");
    expect(out).not.toContain("SHOULD_NOT_RUN");
    expect(out).not.toMatch(/Building|Sending build context/i);
    expect(out).not.toMatch(/Pulling from|Pull complete/i);
    expect(imageExists(ABSENT_TAG)).toBe(false);
  }, 120_000);

  it("CASE 2b：镜像未指定 → FAIL CLOSED（app_image_unset）", () => {
    const r = rigRun(`preprod_load_env; preprod_compose_app_run app true`, { CPS_NOVEL_APP_IMAGE: "" });
    expect(r.status).not.toBe(0);
    expect(both(r)).toContain("APP_RUNTIME=REFUSED reason=app_image_unset");
  }, 60_000);

  it("🔴 CASE 3 核心 mutation：Dockerfile 还在 + 镜像缺失，闸门撤掉之后 compose 真的会就地构建", () => {
    // 先证明危险是真的：绕过闸门、只加载根 compose（build: 段还在），
    // 用与生产同样的 `run --pull never` 去跑一个本地不存在的镜像。
    untag(BUILT_TAG);
    const bypass = spawnSync(
      "docker",
      [
        "compose", "-p", "cps-novel-oneoff-probe-bypass",
        "-f", rigFile("docker-compose.yml"),
        "run", "--rm", "--no-deps", "--pull", "never", "app", "true",
      ],
      {
        cwd: rig,
        env: {
          ...process.env,
          CPS_NOVEL_APP_IMAGE: BUILT_TAG,
          PROBE_BUILD_ARG: "probe",
          PROBE_NETWORK_NAME: BYPASS_NETWORK,
        },
        encoding: "utf8",
      },
    );
    expect(bypass.status, "缺镜像时 compose 本应就地构建；若这里不再构建，本用例的前提需要重新核实").toBe(0);
    expect(imageExists(BUILT_TAG), "compose 没有就地构建 —— mutation 前提不成立").toBe(true);
    untag(BUILT_TAG);

    // 再证明加了闸门（overlay 抹掉 build + 镜像存在性预检）之后，同一情形被拒绝。
    const guarded = rigRun(`preprod_load_env; preprod_compose_app_run app true`, {
      CPS_NOVEL_APP_IMAGE: BUILT_TAG,
    });
    expect(guarded.status).not.toBe(0);
    expect(both(guarded)).toContain("APP_RUNTIME=REFUSED reason=approved_image_missing");
    expect(imageExists(BUILT_TAG), "闸门之后仍然发生了就地构建").toBe(false);
  }, 300_000);

  it("🔴 overlay 被漏掉（merged config 里 build 段回来了）→ 拒绝 build_capability_present", () => {
    const r = rigRun(
      [
        "preprod_load_env",
        // 模拟"有人只加载了根 compose"：闸门查的是合并结果，所以这里必须暴露。
        `preprod_compose() { docker compose --env-file "$PREPROD_ENV_FILE" -p cps-novel -f '${rigFile("docker-compose.yml")}' "$@"; }`,
        "preprod_compose_app_run app true",
      ].join("\n"),
      { CPS_NOVEL_APP_IMAGE: PRESENT_TAG },
    );
    expect(r.status).not.toBe(0);
    expect(both(r)).toContain("APP_RUNTIME=REFUSED reason=build_capability_present");
  }, 120_000);

  it("🔴 CASE 4：镜像在本地但身份判据不符（retag / 掉包）→ 拒绝 app_image_identity", () => {
    const r = rigRun(`preprod_load_env; preprod_compose_app_run app true`, {
      CPS_NOVEL_APP_IMAGE: PRESENT_TAG,
      // deploy / rollback 路径上这些由 preprod_read_release_manifest 导出；
      // 这里给一组与本地镜像不符的值，闸门必须把它按身份不符拒掉。
      PREPROD_RELEASE_TARGET_DIGEST: `sha256:${"b".repeat(64)}`,
      PREPROD_RELEASE_TARGET_MEDIATYPE: "application/vnd.oci.image.manifest.v1+json",
      PREPROD_RELEASE_TARGET_SIZE: "1234",
      PREPROD_RELEASE_CONFIG_DIGEST: `sha256:${"c".repeat(64)}`,
      PREPROD_RELEASE_PLATFORM: "linux/amd64",
      PREPROD_RELEASE_REVISION: "d".repeat(40),
    });
    expect(r.status).not.toBe(0);
    expect(both(r)).toContain("APP_RUNTIME=REFUSED reason=app_image_identity");
  }, 120_000);

  it("preprod_compose_app_up 走同一道闸门（镜像缺失即拒绝，不进 compose）", () => {
    const r = rigRun(`preprod_load_env; preprod_compose_app_up app`, { CPS_NOVEL_APP_IMAGE: ABSENT_TAG });
    expect(r.status).not.toBe(0);
    expect(both(r)).toContain("APP_RUNTIME=REFUSED reason=approved_image_missing");
    const ps = spawnSync("docker", ["ps", "-a", "--filter", "name=cps-novel-app", "--format", "{{.Names}}"], {
      encoding: "utf8",
    });
    expect(ps.stdout ?? "").not.toContain("cps-novel-app-1");
  }, 120_000);

  it("🔴 CASE 6：one-off 的 -e / -v / compose secret 在抹掉 build 之后全部照常", () => {
    const r = rigRun(
      [
        "preprod_load_env",
        "preprod_compose_app_run \\",
        "  -e PROBE_ONEOFF_ENV=oneoff-env-value \\",
        `  -v '${rigFile("shared/admin-password")}:/run/preprod-admin/password:ro' \\`,
        "  app sh -c 'echo uid=$(id -u); echo env=$PROBE_ONEOFF_ENV;",
        "    echo secret=$(cat /run/secrets/probe_secret); echo bind=$(cat /run/preprod-admin/password)'",
      ].join("\n"),
      { CPS_NOVEL_APP_IMAGE: PRESENT_TAG },
    );
    const out = both(r);
    expect(r.status).toBe(0);
    expect(out).toContain("uid=1001");
    expect(out).toContain("env=oneoff-env-value");
    expect(out).toContain("secret=probe-secret-value");
    expect(out).toContain("bind=probe-admin-password");
  }, 180_000);
});

// ---------------------------------------------------------------------------
// 调用方层：桩 docker 记录 argv，用**真实 CLI 的 --help** 校验这些 argv 合法。
// ---------------------------------------------------------------------------
describe.skipIf(!dockerOk)("两个 one-off 调用方发出的 argv 必须被目标 CLI 接受", () => {
  let stubDir = "";
  let argvLog = "";

  beforeAll(async () => {
    stubDir = await mkdtemp(path.join(tmpdir(), "preprod-oneoff-stub-"));
    argvLog = path.join(stubDir, "argv.log");
    const realDocker = spawnSync("bash", ["-lc", "command -v docker"], { encoding: "utf8" }).stdout.trim();
    expect(realDocker).toBeTruthy();
    // 桩只拦截会产生副作用的子命令；`--help` 一律转发给**真实 docker**，
    // 这样 preprod_compose_subcommand_has_flag 的能力探测仍然是真的。
    await writeFile(
      path.join(stubDir, "docker"),
      [
        "#!/usr/bin/env bash",
        `printf '%s\\n' "$*" >> '${argvLog}'`,
        'for arg in "$@"; do if [[ "$arg" == "--help" ]]; then exec ' + `'${realDocker}'` + ' "$@"; fi; done',
        'if [[ "$1" == "image" && "$2" == "inspect" ]]; then exit 0; fi',
        'if [[ "$1" == "compose" ]]; then',
        '  for arg in "$@"; do',
        '    if [[ "$arg" == "config" ]]; then',
        // 渲染一份"没有 build 段"的最小配置，让闸门走到下一步。
        '      printf "name: cps-novel\\nservices:\\n  web:\\n    image: probe\\n"; exit 0;',
        "    fi",
        "  done",
        "  exit 0",
        "fi",
        "exit 0",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    await writeFile(
      path.join(stubDir, "preprod.env"),
      [
        "P1_12_COMPOSE_PROJECT=cps-novel",
        "P1_12_MIGRATION_DATABASE_URL=postgresql://migration_owner:placeholder@postgres/cps_novel",
        "",
      ].join("\n"),
      { mode: 0o600 },
    );
  });

  afterAll(async () => {
    if (stubDir) await rm(stubDir, { recursive: true, force: true });
  });

  it("🔴 CASE 5：database.sh migrate-approved 经 one-off 入口，且 argv 全部合法", async () => {
    await writeFile(argvLog, "");
    const r = spawnSync("bash", [path.join(root, "scripts/preproduction/database.sh"), "migrate-approved"], {
      cwd: root,
      env: {
        ...process.env,
        PATH: `${stubDir}:${process.env.PATH ?? ""}`,
        PREPROD_ENV_FILE: path.join(stubDir, "preprod.env"),
        PREPROD_APPROVED_MIGRATION: "YES",
        CPS_NOVEL_APP_IMAGE: "cps-novel-stub:probe",
      },
      encoding: "utf8",
    });
    expect(both(r)).toContain("DATABASE_MIGRATION=PASS");
    expect(r.status).toBe(0);

    // 能力探测本身也会打到桩上（`compose run --help`），要先滤掉。
    const calls = (await readFile(argvLog, "utf8"))
      .split("\n")
      .filter((line) => line.length > 0 && !line.includes("--help"));
    const runCall = calls.find((line) => / run /.test(line));
    expect(runCall, "migrate-approved 没有走 compose run").toBeTruthy();
    const argv = (runCall ?? "").split(" ");
    expect(runCall).toContain("--rm");
    expect(runCall).toContain("--no-deps");
    expect(runCall).toContain("--pull never");
    expect(runCall).toContain("-e DATABASE_URL=");
    expect(runCall).toContain("web npx --no-install prisma migrate deploy");
    // 🔴 本轮事故的回归锚点：发出的每个 flag 都必须在真实 `run --help` 里存在。
    // `run [OPTIONS] SERVICE [COMMAND...]` —— 服务名之后是容器命令，不是 compose
    // 的 flag（`npx --no-install` 属于容器命令），所以边界取到服务名为止。
    const runIndex = argv.indexOf("run");
    const serviceIndex = argv.indexOf("web", runIndex);
    expect(serviceIndex).toBeGreaterThan(runIndex);
    const supported = cliFlags("run");
    for (const flag of emittedFlags(argv.slice(runIndex + 1, serviceIndex))) {
      expect(supported.has(flag), `docker compose run 不认识 ${flag}`).toBe(true);
    }
    const globalFlags = new Set(["--env-file"]);
    for (const flag of emittedFlags(argv.slice(0, runIndex))) {
      expect(globalFlags.has(flag), `docker compose 全局不认识 ${flag}`).toBe(true);
    }
  }, 120_000);

  it("🔴 preprod_compose_app_up 发出的 argv 同样全部合法", async () => {
    await writeFile(argvLog, "");
    const r = sh(`source '${LIB}'; preprod_load_env; preprod_compose_app_up web`, {
      PATH: `${stubDir}:${process.env.PATH ?? ""}`,
      PREPROD_ENV_FILE: path.join(stubDir, "preprod.env"),
      CPS_NOVEL_APP_IMAGE: "cps-novel-stub:probe",
    });
    expect(r.status).toBe(0);
    const calls = (await readFile(argvLog, "utf8"))
      .split("\n")
      .filter((line) => line.length > 0 && !line.includes("--help"));
    const upCall = calls.find((line) => / up /.test(line));
    expect(upCall).toBeTruthy();
    const argv = (upCall ?? "").split(" ");
    const upIndex = argv.indexOf("up");
    const serviceIndex = argv.indexOf("web", upIndex);
    expect(serviceIndex).toBeGreaterThan(upIndex);
    const supported = cliFlags("up");
    for (const flag of emittedFlags(argv.slice(upIndex + 1, serviceIndex))) {
      expect(supported.has(flag), `docker compose up 不认识 ${flag}`).toBe(true);
    }
    // up 侧仍然保留 --no-build（该子命令确实支持），契约没有被削弱。
    expect(upCall).toContain("--pull never");
    expect(upCall).toContain("--no-build");
  }, 120_000);

  it("CASE 6 静态面：verify-release.sh 的 one-off 仍然带齐 secret / bind / env 入参", async () => {
    const verify = await readFile(path.join(root, "scripts/preproduction/verify-release.sh"), "utf8");
    const oneOff = verify.slice(verify.indexOf("preprod_compose_app_run"));
    for (const token of [
      "-e DATABASE_URL=",
      "-e PREPROD_ADMIN_USERNAME=",
      "-e PREPROD_ADMIN_PASSWORD_FILE=/run/preprod-admin/password",
      "-e TOTP_ENCRYPTION_KEY_FILE=/run/secrets/totp_encryption_key",
      ":/run/preprod-admin/password:ro",
      "web tsx scripts/preproduction/verify-admin-auth.ts",
    ]) expect(oneOff, token).toContain(token);
    const supported = cliFlags("run");
    expect(supported.has("--rm")).toBe(true);
  });
});
