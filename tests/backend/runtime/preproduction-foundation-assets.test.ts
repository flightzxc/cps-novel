import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

/**
 * `scripts/preproduction/foundation-assets.sh` -- the orchestrator that
 * seeds the 9 foundation-asset row groups (channel/source_app/channel_app/
 * channel_capability/canonical_tag/canonical_tag_keyword/
 * canonical_tag_translation/source_label_mapping/article_template) on a
 * preproduction target by running four already-shipped CLIs in dependency
 * order. This is a pure orchestrator (no seed logic of its own), so what
 * needs covering here is exactly what the task asked for: argument parsing,
 * stage order, and the structural "FAIL/REFUSED lines go to stderr, PASS
 * lines go to stdout" convention every sibling `scripts/preproduction/*.sh`
 * already follows (`database.sh`'s own comment on this: "verify-release.sh
 * 会把 one-off 的 stdout 整条 >/dev/null" -- a reason on stdout would be
 * silently lost).
 *
 * Two layers, same split as `preproduction-compose-oneoff-runner.test.ts`:
 *  - Section A/B: no Docker needed at all -- argv/usage parsing, the
 *    PREPROD_FOUNDATION_OPERATOR/APPROVER env-var gates, and static source
 *    assertions (docs mount scoped to exactly the two CLIs that need it,
 *    every one-off call redirects stdin from /dev/null, no flag beyond what
 *    each CLI's own parser advertises).
 *  - Section C: a stub `docker` on PATH (same shape as the sibling file's
 *    CASE 5/6 -- `--help` forwards to the REAL docker so the lib.sh
 *    capability probes stay honest, `compose ... config` renders a minimal
 *    build-free service, `image inspect` reports present) that additionally
 *    fakes the four CLIs' own JSON reports so `plan`'s stage order and the
 *    stderr/stdout split can be proven against the real script without a
 *    real Postgres or a real application image.
 */

const root = process.cwd();
const SCRIPT = path.join(root, "scripts/preproduction/foundation-assets.sh");
const SOURCE = await readFile(SCRIPT, "utf8");

const dockerOk =
  spawnSync("docker", ["info", "--format", "{{.ServerVersion}}"], { encoding: "utf8" }).status === 0;

function baseEnv(overrides: Record<string, string> = {}) {
  return { ...process.env, ...overrides };
}

async function withEnvFile(extra: string[] = []): Promise<{ dir: string; file: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), "foundation-assets-env-"));
  const file = path.join(dir, "preprod.env");
  await writeFile(
    file,
    [
      "P1_12_COMPOSE_PROJECT=cps-novel",
      "P1_12_WEB_DATABASE_URL=postgresql://web_app:placeholder@postgres/cps_novel",
      ...extra,
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  return { dir, file };
}

function run(args: string[], env: Record<string, string>) {
  return spawnSync("bash", [SCRIPT, ...args], { cwd: root, env: baseEnv(env), encoding: "utf8" });
}

// ---------------------------------------------------------------------------
// Section A: argument parsing / usage -- no Docker, no env-file content
// needed beyond what preprod_load_env itself requires (P1_12_COMPOSE_PROJECT).
// ---------------------------------------------------------------------------
describe("参数解析：usage 与子命令分发", () => {
  let envDir: string, envFile: string;
  beforeAll(async () => {
    ({ dir: envDir, file: envFile } = await withEnvFile());
  });
  afterAll(async () => {
    if (envDir) await rm(envDir, { recursive: true, force: true });
  });

  it("不带子命令 -> usage 走 stderr，exit 64，stdout 为空", () => {
    const r = run([], { PREPROD_ENV_FILE: envFile });
    expect(r.status).toBe(64);
    expect(r.stderr).toContain("usage: foundation-assets.sh status|plan|apply");
    expect(r.stdout).toBe("");
  });

  it("未知子命令 -> usage 走 stderr，exit 64", () => {
    const r = run(["bogus"], { PREPROD_ENV_FILE: envFile });
    expect(r.status).toBe(64);
    expect(r.stderr).toContain("usage: foundation-assets.sh status|plan|apply");
    expect(r.stdout).toBe("");
  });

  it("三个子命令都存在：status/plan/apply 不落到 usage 分支（不产出 usage 文案）", () => {
    // 三个子命令各自会在更早的 env-var 闸门上被拒绝（下面的 Section B 覆盖），
    // 但绝不应该是 usage 兜底分支——这里只断言它们没有打印 usage 文案。
    for (const sub of ["status", "plan", "apply"]) {
      const r = run([sub], { PREPROD_ENV_FILE: envFile });
      expect(r.stderr, `${sub} 不应打印 usage`).not.toContain("usage: foundation-assets.sh");
    }
  });
});

// ---------------------------------------------------------------------------
// Section B: PREPROD_FOUNDATION_OPERATOR / _APPROVER gates, and the
// structural "FAIL/REFUSED -> stderr, exit 65" convention -- still no Docker.
// ---------------------------------------------------------------------------
describe("操作者/审批人闸门：REFUSED 一律走 stderr，PASS 相关行不落到 stdout", () => {
  let envDir: string, envFile: string;
  beforeAll(async () => {
    ({ dir: envDir, file: envFile } = await withEnvFile());
  });
  afterAll(async () => {
    if (envDir) await rm(envDir, { recursive: true, force: true });
  });

  it("status 缺 PREPROD_FOUNDATION_OPERATOR -> REFUSED reason=operator_required，走 stderr，exit 65，stdout 空", () => {
    const r = run(["status"], { PREPROD_ENV_FILE: envFile });
    expect(r.status).toBe(65);
    expect(r.stderr).toContain("FOUNDATION_STATUS=REFUSED reason=operator_required");
    expect(r.stdout).toBe("");
  });

  it("plan 缺 PREPROD_FOUNDATION_OPERATOR -> 同款拒绝，走 stderr", () => {
    const r = run(["plan"], { PREPROD_ENV_FILE: envFile });
    expect(r.status).toBe(65);
    expect(r.stderr).toContain("FOUNDATION_PLAN=REFUSED reason=operator_required");
    expect(r.stdout).toBe("");
  });

  it("apply 缺 PREPROD_FOUNDATION_OPERATOR -> 同款拒绝，走 stderr（比 approver 检查先触发）", () => {
    const r = run(["apply"], { PREPROD_ENV_FILE: envFile });
    expect(r.status).toBe(65);
    expect(r.stderr).toContain("FOUNDATION_APPLY=REFUSED reason=operator_required");
    expect(r.stdout).toBe("");
  });

  it("apply 有 operator 但缺 PREPROD_FOUNDATION_APPROVER -> REFUSED reason=approver_required，走 stderr", () => {
    const r = run(["apply"], { PREPROD_ENV_FILE: envFile, PREPROD_FOUNDATION_OPERATOR: "preprod-op" });
    expect(r.status).toBe(65);
    expect(r.stderr).toContain("FOUNDATION_APPLY=REFUSED reason=approver_required");
    expect(r.stdout).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Section C: static source assertions -- structural constraints that must
// hold regardless of runtime behavior (mirrors the sibling test file's own
// "🔴 源码里不得再无条件把 --no-build 写死" static check).
// ---------------------------------------------------------------------------
describe("静态结构约束", () => {
  it("常量块与工单给出的期望值逐字一致（回归锚点）", () => {
    expect(SOURCE).toContain("channel) echo 1 ;;");
    expect(SOURCE).toContain("source_app) echo 1 ;;");
    expect(SOURCE).toContain("channel_app) echo 1 ;;");
    expect(SOURCE).toContain("channel_capability) echo 4 ;;");
    expect(SOURCE).toContain("canonical_tag) echo 123 ;;");
    expect(SOURCE).toContain("canonical_tag_keyword) echo 360 ;;");
    expect(SOURCE).toContain("canonical_tag_translation) echo 1968 ;;");
    expect(SOURCE).toContain("source_label_mapping) echo 196 ;;");
    expect(SOURCE).toContain("article_template) echo 15 ;;");
    expect(SOURCE).toContain('readonly FOUNDATION_LEXICON_VERSION="canonical-tag-v1-keyword-seeds-v1"');
  });

  it("docs 只读挂载只出现在 tagging / translation-overlay 两个分支里", () => {
    const mountFn = SOURCE.slice(
      SOURCE.indexOf("foundation_stage_mount_args() {"),
      SOURCE.indexOf("\n}", SOURCE.indexOf("foundation_stage_mount_args() {")),
    );
    expect(mountFn).toContain("tagging|translation-overlay) FOUNDATION_MOUNT_ARGS=(-v \"$root/docs:/app/docs:ro\") ;;");
    // 只有这一个 case 分支写挂载 -- moboreader / article-template 完全不出现
    // "/app/docs" 字样。
    expect((mountFn.match(/\/app\/docs/g) ?? []).length).toBe(1);
  });

  it("每一处 preprod_compose_app_run 调用都带 </dev/null（承重：ssh heredoc 场景下会吃掉剩余输入）", () => {
    const calls = SOURCE.split("preprod_compose_app_run").length - 1;
    const guarded = SOURCE.split("preprod_compose_app_run \\\n").length - 1;
    expect(calls).toBeGreaterThan(0);
    // 两处调用（run_stage 与 read_runtime_facts）都是多行续行形式；逐一核对
    // 紧跟其后的整段文本里出现 </dev/null。
    for (const chunk of SOURCE.split("preprod_compose_app_run").slice(1)) {
      const nextCallStart = chunk.indexOf("preprod_compose_app_run");
      const window = nextCallStart === -1 ? chunk : chunk.slice(0, nextCallStart);
      expect(window, "调用块缺少 </dev/null").toContain("</dev/null");
    }
    expect(guarded).toBeGreaterThan(0);
  });

  it("统一用 P1_12_WEB_DATABASE_URL 喂 DATABASE_URL，从不扩权限到别的角色变量", () => {
    const occurrences = SOURCE.match(/-e DATABASE_URL="\$P1_12_WEB_DATABASE_URL"/g) ?? [];
    expect(occurrences.length).toBeGreaterThanOrEqual(2); // run_stage + read_runtime_facts
    expect(SOURCE).not.toContain("P1_12_MIGRATION_DATABASE_URL");
    expect(SOURCE).not.toContain("POSTGRES_ADMIN");
  });

  it("moboreader 分支不带 --approver（该 CLI 的解析器不认识这个 flag）", () => {
    const stageFn = SOURCE.slice(SOURCE.indexOf("run_stage() {"), SOURCE.indexOf("\ncase \"${1:-}\" in"));
    const moboreaderCase = stageFn.slice(stageFn.indexOf("moboreader)"), stageFn.indexOf("tagging)"));
    expect(moboreaderCase).not.toContain("--approver");
  });

  it("article-template 分支不带 --request-id/--reason（该 CLI 的 usage 里没有这两个 flag）", () => {
    const stageFn = SOURCE.slice(SOURCE.indexOf("run_stage() {"), SOURCE.indexOf("\ncase \"${1:-}\" in"));
    const articleCase = stageFn.slice(stageFn.indexOf("article-template)"), stageFn.indexOf("*)\n      echo \"run_stage: unknown stage"));
    expect(articleCase).not.toContain("--request-id");
    expect(articleCase).not.toContain("--reason");
  });

  it("SHA-256 判据匹配的是 CLI 抛出的 .message 文案，不是错误码本身（两个 CLI 的 catch 只打印 error.message）", () => {
    expect(SOURCE).toContain('grep -q "SHA-256 mismatch"');
    // 反面锚点：不要退化成按 code 名字匹配 -- 两个源 CLI 的 main() 都只
    // console.error(error.message)，从不打印 error.code。
    expect(SOURCE).not.toMatch(/grep -q "sha256_mismatch"/);
  });

  it("ANALYZE 收尾与校验都经 postgres 超级用户通道，不经过 web_app 的 DATABASE_URL / 应用一次性容器", () => {
    expect(SOURCE).toContain('-U postgres -d cps_novel -Atqc');
    expect(SOURCE).toContain('-U postgres -d cps_novel -c "ANALYZE;"');
    const analyzeBlock = SOURCE.slice(
      SOURCE.indexOf("foundation_missing_stats_tables() {"),
      SOURCE.indexOf("\n}", SOURCE.indexOf("foundation_run_analyze() {")),
    );
    expect(analyzeBlock).not.toContain("preprod_compose_app_run");
    expect(analyzeBlock).not.toContain("P1_12_WEB_DATABASE_URL");
  });

  it("零统计判据只认 pg_stats 有没有条目，不用 last_analyze（PG15+ 共享内存计数器非正常关闭会清零，产生假阳性）", () => {
    expect(SOURCE).toContain("FROM pg_stats s");
    // 反面锚点：脚本自己的解释性注释可以提到 last_analyze 这个反例名字，但
    // 真正跑的 SQL 绝不能查 pg_stat_user_tables（唯一暴露 last_analyze /
    // last_autoanalyze 的视图）。
    const sqlBlock = SOURCE.slice(
      SOURCE.indexOf("foundation_missing_stats_tables() {"),
      SOURCE.indexOf("\n}", SOURCE.indexOf("foundation_missing_stats_tables() {")),
    );
    expect(sqlBlock).not.toContain("pg_stat_user_tables");
  });

  it("ANALYZE 收尾排在 cmd_apply 的阶段循环之后，且 status 里的 db_statistics 每次都实算（不读 state_file 缓存）", () => {
    const applyBody = SOURCE.slice(SOURCE.indexOf("cmd_apply() {"), SOURCE.lastIndexOf('case "${1:-}" in'));
    const loopEnd = applyBody.indexOf('echo "FOUNDATION_APPLY_STAGE=$stage outcome=PASS"');
    const analyzeCall = applyBody.indexOf("foundation_run_analyze");
    expect(loopEnd).toBeGreaterThan(-1);
    expect(analyzeCall).toBeGreaterThan(loopEnd);

    const statusBody = SOURCE.slice(SOURCE.indexOf("cmd_status() {"), SOURCE.indexOf("\ncmd_plan() {"));
    expect(statusBody).toContain("foundation_missing_stats_tables");
    expect(statusBody).not.toContain("state_file");
  });
});

// ---------------------------------------------------------------------------
// Section D: stage order + stdout/stderr split against the real script,
// driven by a stub `docker` that fakes the four CLIs' JSON reports.
// ---------------------------------------------------------------------------
describe.skipIf(!dockerOk)("阶段顺序 + FAIL 走 stderr（桩 docker，真实脚本）", () => {
  let stubDir = "";
  let argvLog = "";

  const MOBOREADER_OK = JSON.stringify({
    mode: "dry-run", wrote: false, replayed: false, missing: [], created: [],
    capabilityStatuses: { getlistpc: "registered_disabled", a: "registered_disabled", b: "registered_disabled", c: "registered_disabled" },
    auditId: null,
  });
  const TAGGING_OK = JSON.stringify({
    mode: "dry-run", outcome: "eligible",
    databaseBefore: { canonicalTag: 123, canonicalTagTranslation: 123, canonicalTagKeyword: 360, sourceLabelMapping: 196 },
  });
  const OVERLAY_OK = JSON.stringify({ mode: "dry-run", outcome: "eligible", databaseBefore: 1968 });
  const TEMPLATE_OK = JSON.stringify({
    mode: "dry-run", wrote: false,
    planned: { create: 0, update: 0, unchanged: 15, softDeleted: 0 },
    locales: Array.from({ length: 15 }, (_, i) => `locale-${i}`),
  });

  async function writeStub(script: string) {
    await writeFile(path.join(stubDir, "docker"), script, { mode: 0o755 });
  }

  /** Builds the stub docker script. Behavior is entirely driven by env vars the test sets when invoking the real script (STUB_*), so one stub file serves every test case below. */
  function stubScript(realDocker: string): string {
    return [
      "#!/usr/bin/env bash",
      `printf '%s\\n' "$*" >> '${argvLog}'`,
      "for arg in \"$@\"; do",
      `  if [[ "$arg" == "--help" ]]; then exec '${realDocker}' "$@"; fi`,
      "done",
      'if [[ "$1" == "image" && "$2" == "inspect" ]]; then exit 0; fi',
      'if [[ "$1" == "compose" ]]; then',
      '  for arg in "$@"; do',
      '    if [[ "$arg" == "config" ]]; then',
      '      printf "name: cps-novel\\nservices:\\n  web:\\n    image: probe\\n"; exit 0;',
      "    fi",
      "  done",
      '  is_run=0',
      '  for arg in "$@"; do if [[ "$arg" == "run" ]]; then is_run=1; fi; done',
      '  if [[ "$is_run" == "1" ]]; then',
      '    argv="$*"',
      '    if [[ "$argv" == *"register-moboreader-foundation.ts"* ]]; then',
      '      if [[ "${STUB_MOBOREADER_FAIL:-}" == "1" ]]; then echo "moboreader stub failure" >&2; exit 1; fi',
      `      printf '%s\\n' '${MOBOREADER_OK}'; exit 0;`,
      '    fi',
      '    if [[ "$argv" == *"tagging-bootstrap.ts"* ]]; then',
      '      if [[ "${STUB_TAGGING_FAIL:-}" == "sha" ]]; then echo "canonical-tag-v1.json SHA-256 mismatch: expected aaa, got bbb" >&2; exit 1; fi',
      '      if [[ "${STUB_TAGGING_FAIL:-}" == "other" ]]; then echo "some other tagging failure" >&2; exit 1; fi',
      `      printf '%s\\n' '${TAGGING_OK}'; exit 0;`,
      '    fi',
      '    if [[ "$argv" == *"canonical-tag-translation-overlay.ts"* ]]; then',
      `      printf '%s\\n' '${OVERLAY_OK}'; exit 0;`,
      '    fi',
      '    if [[ "$argv" == *"article-template-bootstrap.ts"* ]]; then',
      `      printf '%s\\n' '${TEMPLATE_OK}'; exit 0;`,
      '    fi',
      '    # 落到这里的是 read_runtime_facts 的 node -e 查询。',
      '    echo "channel_app_id=${STUB_CHANNEL_APP_ID:-}"',
      '    echo "accounts=${STUB_ACCOUNTS:-1}"',
      '    echo "credentials=${STUB_CREDENTIALS:-1}"',
      '    exit 0',
      '  fi',
      '  is_exec=0',
      '  for arg in "$@"; do if [[ "$arg" == "exec" ]]; then is_exec=1; fi; done',
      '  if [[ "$is_exec" == "1" ]]; then',
      '    argv="$*"',
      '    if [[ "$argv" == *"ANALYZE;"* ]]; then',
      '      if [[ "${STUB_ANALYZE_EXEC_FAIL:-}" == "1" ]]; then echo "analyze stub failure" >&2; exit 1; fi',
      '      exit 0',
      '    fi',
      '    if [[ "$argv" == *"string_agg"* ]]; then',
      '      printf \'%s\\n\' "${STUB_ANALYZE_MISSING_TABLES:-}"',
      '      exit 0',
      '    fi',
      '    exit 0',
      '  fi',
      '  exit 0',
      "fi",
      "exit 0",
      "",
    ].join("\n");
  }

  beforeAll(async () => {
    stubDir = await mkdtemp(path.join(tmpdir(), "foundation-assets-stub-"));
    argvLog = path.join(stubDir, "argv.log");
    const realDocker = spawnSync("bash", ["-lc", "command -v docker"], { encoding: "utf8" }).stdout.trim();
    expect(realDocker).toBeTruthy();
    await writeStub(stubScript(realDocker));
  });

  afterEach(async () => {
    await writeFile(argvLog, "");
  });

  afterAll(async () => {
    if (stubDir) await rm(stubDir, { recursive: true, force: true });
  });

  function runPlan(env: Record<string, string>) {
    return spawnSync("bash", [SCRIPT, "plan"], {
      cwd: root,
      env: baseEnv({
        PATH: `${stubDir}:${process.env.PATH ?? ""}`,
        PREPROD_ENV_FILE: path.join(stubDir, "preprod.env"),
        PREPROD_FOUNDATION_OPERATOR: "preprod-foundation-operator",
        CPS_NOVEL_APP_IMAGE: "cps-novel-stub:probe",
        ...env,
      }),
      encoding: "utf8",
    });
  }

  function runApply(env: Record<string, string>) {
    return spawnSync("bash", [SCRIPT, "apply"], {
      cwd: root,
      env: baseEnv({
        PATH: `${stubDir}:${process.env.PATH ?? ""}`,
        PREPROD_ENV_FILE: path.join(stubDir, "preprod.env"),
        PREPROD_FOUNDATION_OPERATOR: "preprod-foundation-operator",
        PREPROD_FOUNDATION_APPROVER: "preprod-foundation-approver",
        CPS_NOVEL_APP_IMAGE: "cps-novel-stub:probe",
        ...env,
      }),
      encoding: "utf8",
    });
  }

  beforeAll(async () => {
    await writeFile(
      path.join(stubDir, "preprod.env"),
      ["P1_12_COMPOSE_PROJECT=cps-novel", "P1_12_WEB_DATABASE_URL=postgresql://web_app:placeholder@postgres/cps_novel", ""].join("\n"),
      { mode: 0o600 },
    );
  });

  it("阶段顺序：四个 CLI 按 moboreader -> tagging -> translation-overlay -> article-template 依次被调用，且 tagging 带上了 stage 1 产出的 --channel-app", async () => {
    const r = runPlan({ STUB_CHANNEL_APP_ID: "11111111-1111-1111-1111-111111111111" });
    expect(r.status, both(r)).toBe(0);
    expect(r.stdout).toContain("FOUNDATION_PLAN=PASS");

    const log = await readFile(argvLog, "utf8");
    const scriptOrder = [
      "register-moboreader-foundation.ts",
      "tagging-bootstrap.ts",
      "canonical-tag-translation-overlay.ts",
      "article-template-bootstrap.ts",
    ];
    const positions = scriptOrder.map((needle) => log.indexOf(needle));
    for (const p of positions) expect(p).toBeGreaterThan(-1);
    for (let i = 1; i < positions.length; i += 1) {
      expect(positions[i], `${scriptOrder[i]} 应该晚于 ${scriptOrder[i - 1]} 被调用`).toBeGreaterThan(positions[i - 1]);
    }

    const taggingLine = log.split("\n").find((line) => line.includes("tagging-bootstrap.ts"));
    expect(taggingLine).toContain("--channel-app changdu-app=11111111-1111-1111-1111-111111111111");

    // docs 挂载只在 tagging / translation-overlay 的调用行里出现。
    const moboLine = log.split("\n").find((line) => line.includes("register-moboreader-foundation.ts"));
    const overlayLine = log.split("\n").find((line) => line.includes("canonical-tag-translation-overlay.ts"));
    const templateLine = log.split("\n").find((line) => line.includes("article-template-bootstrap.ts"));
    expect(moboLine).not.toContain("/app/docs");
    expect(templateLine).not.toContain("/app/docs");
    expect(taggingLine).toContain("/app/docs:ro");
    expect(overlayLine).toContain("/app/docs:ro");
  }, 60_000);

  it("channel_app 尚未就绪时：tagging 报 BLOCKED_DEPENDENCY（stdout，非失败），plan 仍然继续跑到 article-template 并整体 PASS", async () => {
    const r = runPlan({ STUB_CHANNEL_APP_ID: "" });
    expect(r.status, both(r)).toBe(0);
    expect(r.stdout).toContain("FOUNDATION_PLAN_STAGE=tagging outcome=BLOCKED_DEPENDENCY reason=channel_app_not_ready");
    expect(r.stdout).toContain("FOUNDATION_PLAN_STAGE=article-template outcome=ELIGIBLE");
    expect(r.stdout).toContain("FOUNDATION_PLAN=PASS");

    const log = await readFile(argvLog, "utf8");
    // BLOCKED_DEPENDENCY 是靠脚本自己短路跳过的 -- 不应该真的把 tagging-bootstrap.ts
    // 派给桩 docker 执行。
    expect(log).not.toContain("tagging-bootstrap.ts");
  }, 60_000);

  it("🔴 某一阶段失败 -> 该阶段与整体的 FAIL 行必须落在 stderr，此前阶段的 PASS 相关行仍在 stdout，exit 65", async () => {
    const r = runPlan({
      STUB_CHANNEL_APP_ID: "11111111-1111-1111-1111-111111111111",
      STUB_TAGGING_FAIL: "sha",
    });
    expect(r.status).toBe(65);

    // moboreader 先于 tagging 跑完，它的 PASS 相关行必须还在 stdout。
    expect(r.stdout).toContain("FOUNDATION_PLAN_STAGE=moboreader outcome=ELIGIBLE");
    expect(r.stdout).not.toContain("VERSION_MISMATCH");
    expect(r.stdout).not.toContain("FOUNDATION_PLAN=FAIL");

    // 失败相关的行必须都在 stderr，一行都不能漏到 stdout。
    expect(r.stderr).toContain("FOUNDATION_PLAN_STAGE=tagging outcome=VERSION_MISMATCH");
    expect(r.stderr).toContain("FOUNDATION_PLAN=FAIL reason=version_mismatch stage=tagging");

    // 因为失败，翻译叠加与模板两个后续阶段完全不应该被派发。
    const log = await readFile(argvLog, "utf8");
    expect(log).not.toContain("canonical-tag-translation-overlay.ts");
    expect(log).not.toContain("article-template-bootstrap.ts");
  }, 60_000);

  it("一个非 SHA 相关的阶段失败：同样落在 stderr，detail 原样带出方便排查", async () => {
    const r = runPlan({
      STUB_CHANNEL_APP_ID: "11111111-1111-1111-1111-111111111111",
      STUB_TAGGING_FAIL: "other",
    });
    expect(r.status).toBe(65);
    expect(r.stderr).toContain("FOUNDATION_PLAN_STAGE=tagging outcome=FAIL detail=some other tagging failure");
    expect(r.stdout).not.toContain("outcome=FAIL");
  }, 60_000);

  // ---------------------------------------------------------------------
  // ANALYZE closer (docs/governance/ENVIRONMENT_PROVISIONING_CHECKLIST.md
  // §2). The four dry-run stubs above already represent "fully satisfied"
  // (missing:[] / counts at exactly the expected constants /
  // planned.create:0), so `apply` skips every stage's real --apply call
  // (ALREADY_SATISFIED) and goes straight to the ANALYZE closer -- these
  // tests only need the stub's `compose exec ... postgres psql` branch.
  // ---------------------------------------------------------------------
  it("apply 全部阶段 ALREADY_SATISFIED 之后，ANALYZE 收尾在最后跑且校验通过 -> 两条 PASS 都在 stdout", async () => {
    let sharedDir = "";
    try {
      sharedDir = await mkdtemp(path.join(tmpdir(), "foundation-assets-shared-"));
      const r = runApply({
        STUB_CHANNEL_APP_ID: "11111111-1111-1111-1111-111111111111",
        STUB_ANALYZE_MISSING_TABLES: "",
        PREPROD_SHARED_ROOT: sharedDir,
      });
      expect(r.status, both(r)).toBe(0);
      expect(r.stdout).toContain("FOUNDATION_APPLY_STAGE=moboreader outcome=ALREADY_SATISFIED");
      expect(r.stdout).toContain("FOUNDATION_APPLY_STAGE=article-template outcome=ALREADY_SATISFIED");
      expect(r.stdout).toContain("FOUNDATION_ANALYZE=PASS");
      expect(r.stdout).toContain("FOUNDATION_APPLY=PASS");
      // 顺序断言：ANALYZE 收尾必须排在最后一个阶段之后。
      expect(r.stdout.indexOf("FOUNDATION_APPLY_STAGE=article-template")).toBeLessThan(
        r.stdout.indexOf("FOUNDATION_ANALYZE=PASS"),
      );
      expect(r.stdout.indexOf("FOUNDATION_ANALYZE=PASS")).toBeLessThan(r.stdout.indexOf("FOUNDATION_APPLY=PASS"));

      const log = await readFile(argvLog, "utf8");
      expect(log).toContain("ANALYZE;");
      // ANALYZE 与校验必须走 exec -U postgres，不经过应用一次性容器
      // （不带 -e DATABASE_URL=，不带 register-moboreader-foundation.ts 等脚本路径）。
      const analyzeLine = log.split("\n").find((line) => line.includes("ANALYZE;"));
      expect(analyzeLine).toContain(" exec ");
      expect(analyzeLine).toContain("-U postgres");
      expect(analyzeLine).not.toContain("DATABASE_URL");
    } finally {
      if (sharedDir) await rm(sharedDir, { recursive: true, force: true });
    }
  }, 60_000);

  it("🔴 校验发现有表零统计 -> FOUNDATION_ANALYZE=FAIL 连同表名一起走 stderr，exit 65，此前各阶段的 PASS 相关行仍在 stdout", async () => {
    let sharedDir = "";
    try {
      sharedDir = await mkdtemp(path.join(tmpdir(), "foundation-assets-shared-"));
      const r = runApply({
        STUB_CHANNEL_APP_ID: "11111111-1111-1111-1111-111111111111",
        STUB_ANALYZE_MISSING_TABLES: "channel_app,canonical_tag",
        PREPROD_SHARED_ROOT: sharedDir,
      });
      expect(r.status).toBe(65);
      expect(r.stdout).toContain("FOUNDATION_APPLY_STAGE=article-template outcome=ALREADY_SATISFIED");
      expect(r.stdout).not.toContain("FOUNDATION_ANALYZE");
      expect(r.stdout).not.toContain("FOUNDATION_APPLY=PASS");
      expect(r.stderr).toContain("FOUNDATION_ANALYZE=FAIL tables=channel_app,canonical_tag");
    } finally {
      if (sharedDir) await rm(sharedDir, { recursive: true, force: true });
    }
  }, 60_000);

  it("ANALYZE 本身执行失败（非校验失败）-> REFUSED reason=analyze_failed 走 stderr，带可复制的恢复命令", async () => {
    let sharedDir = "";
    try {
      sharedDir = await mkdtemp(path.join(tmpdir(), "foundation-assets-shared-"));
      const r = runApply({
        STUB_CHANNEL_APP_ID: "11111111-1111-1111-1111-111111111111",
        STUB_ANALYZE_EXEC_FAIL: "1",
        PREPROD_SHARED_ROOT: sharedDir,
      });
      expect(r.status).toBe(65);
      expect(r.stderr).toContain("FOUNDATION_APPLY_STAGE=analyze outcome=REFUSED reason=analyze_failed");
      expect(r.stderr).toContain("recovery=");
      expect(r.stdout).not.toContain("FOUNDATION_APPLY=PASS");
    } finally {
      if (sharedDir) await rm(sharedDir, { recursive: true, force: true });
    }
  }, 60_000);
});

function both(r: { stdout: string | null; stderr: string | null }): string {
  return `${r.stdout ?? ""}${r.stderr ?? ""}`;
}
