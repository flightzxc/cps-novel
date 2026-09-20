import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Phase 2C · 归档**消费端**接线的真实行为测试。
 *
 * 🔴 这一组刻意不做源码字符串匹配。归档环节此前已有契约测试，但那些只证明
 * "脚本里写了这句话"。这里要证明的是**行为**：真的 docker build 两个镜像、
 * 真的 save/load、真的起容器，然后看身份校验在各种被掉包的情形下是否真的拒绝。
 *
 * 覆盖 Owner 点名的四类负例：
 *   1. load 之后 tag 被改指到另一个镜像；
 *   2. manifest 的 image_tag 指向另一个镜像；
 *   3. 正确的旧镜像已缓存，但传入的是错误归档；
 *   4. 镜像缺失 —— 且此时**不得**触发 registry pull 或就地 build。
 */

const root = process.cwd();
const LIB = path.join(root, "scripts/preproduction/lib.sh");
const VERIFY = path.join(root, "scripts/preproduction/verify-release-archive.sh");
const TAG_A = "cps-novel-archive-test-a:probe";
const TAG_B = "cps-novel-archive-test-b:probe";
const SHARED_TAG = "cps-novel-archive-test-shared:probe";
const COMMIT_A = "a".repeat(40);
const COMMIT_B = "b".repeat(40);

const sh = (script: string, env: Record<string, string> = {}) =>
  spawnSync("bash", ["-c", script], {
    cwd: root,
    env: { ...process.env, ...env },
    encoding: "utf8",
  });

const dockerOk = spawnSync("docker", ["info", "--format", "{{.ServerVersion}}"], {
  encoding: "utf8",
}).status === 0;

let work = "";
let digestA = "";
let digestB = "";
let platform = "";

async function buildProbe(tag: string, commit: string) {
  const ctx = await mkdtemp(path.join(tmpdir(), "probe-ctx-"));
  await writeFile(
    path.join(ctx, "Dockerfile"),
    [
      "FROM alpine:3.20",
      `LABEL org.opencontainers.image.revision=${commit}`,
      `LABEL org.opencontainers.image.source=https://github.com/flightzxc/cps-novel`,
      `RUN echo ${commit} > /probe-id`,
      'CMD ["sleep", "300"]',
      "",
    ].join("\n"),
  );
  const built = spawnSync("docker", ["build", "-q", "-t", tag, ctx], { encoding: "utf8" });
  await rm(ctx, { recursive: true, force: true });
  if (built.status !== 0) throw new Error(`build ${tag} failed: ${built.stderr}`);
  const id = spawnSync("docker", ["image", "inspect", tag, "--format", "{{.Id}}"], {
    encoding: "utf8",
  }).stdout.trim();
  return id;
}

/** 造一份真实归档（docker save + zstd）以及与之配套的 manifest。 */
async function makeArchive(
  dir: string,
  tagToSave: string,
  manifestOverrides: Record<string, unknown> = {},
  // 🔴 build-manifest 会核对"归档里镜像的 revision == 批准的 commit"，
  // 所以造 B 的归档时必须传 COMMIT_B——这正是它该拦住的那类错配。
  commit: string = COMMIT_A,
) {
  const archiveName = `probe-${Math.random().toString(36).slice(2, 8)}.tar.zst`;
  const archivePath = path.join(dir, archiveName);
  const saved = sh(`docker save '${tagToSave}' | zstd -T0 -3 -q -o '${archivePath}'`);
  if (saved.status !== 0) throw new Error(`save failed: ${saved.stderr}`);
  const body = await readFile(archivePath);
  const sha = createHash("sha256").update(body).digest("hex");
  // 🔴 manifest 经**生产构建器同一条路径**生成（image-identity.mjs build-manifest），
  // 身份字段来自解析归档实际内容。测试自己拼 manifest 会和生产实现悄悄分叉。
  const manifestPath = path.join(dir, `${Math.random().toString(36).slice(2, 8)}.json`);
  const made = spawnSync("node", [
    path.join(root, "scripts/preproduction/image-identity.mjs"), "build-manifest",
    "--archive", archivePath, "--tag", SHARED_TAG, "--platform", platform,
    "--commit", commit, "--version", "0.0.0-probe",
    "--archive-filename", archiveName, "--archive-sha256", sha,
    "--built-at", "2026-09-20T00:00:00Z",
    "--source-repository", "https://github.com/flightzxc/cps-novel",
    "--out", manifestPath,
  ], { encoding: "utf8" });
  if (made.status !== 0) throw new Error(`build-manifest failed: ${made.stdout}${made.stderr}`);
  if (Object.keys(manifestOverrides).length > 0) {
    const current = JSON.parse(await readFile(manifestPath, "utf8"));
    await writeFile(manifestPath, `${JSON.stringify({ ...current, ...manifestOverrides }, null, 2)}\n`);
  }
  return { manifestPath, archivePath, archiveName, sha };
}

const untag = (tag: string) => spawnSync("docker", ["image", "rm", "-f", tag], { encoding: "utf8" });

describe.skipIf(!dockerOk)("归档消费端身份校验（真实 docker 行为）", () => {
  beforeAll(async () => {
    work = await mkdtemp(path.join(tmpdir(), "archive-consumer-"));
    digestA = await buildProbe(TAG_A, COMMIT_A);
    digestB = await buildProbe(TAG_B, COMMIT_B);
    platform = spawnSync("docker", ["image", "inspect", TAG_A, "--format", "{{.Os}}/{{.Architecture}}"], {
      encoding: "utf8",
    }).stdout.trim();
    expect(digestA).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(digestB).not.toBe(digestA);
  }, 300_000);

  afterAll(async () => {
    for (const t of [TAG_A, TAG_B, SHARED_TAG]) untag(t);
    if (work) await rm(work, { recursive: true, force: true });
  });

  it("正常：归档装载后 tag / digest / revision / 平台全部对上", async () => {
    spawnSync("docker", ["tag", TAG_A, SHARED_TAG]);
    const { manifestPath } = await makeArchive(work, SHARED_TAG);
    untag(SHARED_TAG);
    const r = sh(`'${VERIFY}' --manifest '${manifestPath}' --load`);
    expect(r.stdout).toContain("VERIFY=PASS");
    expect(r.status).toBe(0);
  }, 180_000);

  it("🔴 负例 1：load 之后 tag 被改指到另一个镜像 → 拒绝", async () => {
    spawnSync("docker", ["tag", TAG_A, SHARED_TAG]);
    const { manifestPath } = await makeArchive(work, SHARED_TAG);
    // 归档里装的是 A，但装载后有人把同名 tag 改指到 B
    const r = sh(
      `'${VERIFY}' --manifest '${manifestPath}' --load >/dev/null 2>&1;
       docker tag '${TAG_B}' '${SHARED_TAG}';
       source '${LIB}';
       preprod_read_release_manifest '${manifestPath}';
       preprod_assert_local_image '${SHARED_TAG}'`,
    );
    expect(r.status).not.toBe(0);
    // 锚点随 image store 不同（经典比 config digest，containerd 比 Descriptor），
    // 但两种形态都必须拒绝。
    expect(`${r.stdout}${r.stderr}`).toMatch(/IMAGE=REFUSED reason=(id_config_digest_mismatch|descriptor_digest_mismatch)/);
  }, 180_000);

  it("🔴 负例 2：manifest 的 image_tag 指向另一个镜像 → 拒绝", async () => {
    spawnSync("docker", ["tag", TAG_A, SHARED_TAG]);
    const { manifestPath } = await makeArchive(work, SHARED_TAG, { image_tag: TAG_B });
    const r = sh(`'${VERIFY}' --manifest '${manifestPath}' --load`);
    expect(r.status).not.toBe(0);
    // v2 下更早暴露：归档 index.json 里根本没有指向该 tag 的条目。
    expect(`${r.stdout}${r.stderr}`).toContain("reason=target_not_found_for_tag");
  }, 180_000);

  it("🔴 负例 3：正确镜像已缓存，但传入的是错误归档 → 拒绝", async () => {
    // manifest 描述 A（由 A 的归档生成），随后把归档文件换成 B 的内容并同步 sha，
    // 这样"归档与它旁边的 sha 自洽"这关过得去，破绽只在归档内容 ≠ manifest 所述。
    spawnSync("docker", ["tag", TAG_A, SHARED_TAG]);
    const good = await makeArchive(work, SHARED_TAG);            // manifest 描述 A
    spawnSync("docker", ["tag", TAG_B, SHARED_TAG]);
    const wrongBody = await makeArchive(work, SHARED_TAG, {}, COMMIT_B); // 归档内容 = B
    spawnSync("docker", ["tag", TAG_A, SHARED_TAG]);              // 本地缓存恢复为正确的 A
    const m = JSON.parse(await readFile(good.manifestPath, "utf8"));
    m.archive_filename = wrongBody.archiveName;
    m.archive_sha256 = wrongBody.sha;
    await writeFile(good.manifestPath, `${JSON.stringify(m, null, 2)}\n`);
    const r = sh(`'${VERIFY}' --manifest '${good.manifestPath}' --load`);
    expect(r.status).not.toBe(0);
    expect(`${r.stdout}${r.stderr}`).toMatch(/archive_manifest_.*_disagree/);
  }, 180_000);

  it("🔴 负例 4：镜像缺失 → 拒绝，且不得触发 pull / build", async () => {
    untag(SHARED_TAG);
    const r = sh(
      `source '${LIB}'; preprod_assert_local_image '${SHARED_TAG}'`,
    );
    expect(r.status).not.toBe(0);
    expect(`${r.stdout}${r.stderr}`).toContain("reason=image_missing");
  }, 60_000);

  it("🔴 pull_policy: never 下镜像缺失时 compose 真的不会去拉", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "nopull-"));
    const compose = path.join(dir, "docker-compose.yml");
    await writeFile(
      compose,
      [
        "services:",
        "  probe:",
        "    image: cps-novel-absent-probe:does-not-exist",
        "    pull_policy: never",
        '    command: ["true"]',
        "",
      ].join("\n"),
    );
    const r = sh(`docker compose -f '${compose}' -p nopullprobe up --no-build 2>&1 || true`);
    await rm(dir, { recursive: true, force: true });
    const out = `${r.stdout}${r.stderr}`;
    // 关键：不能出现从 registry 拉取的迹象，必须是"本地没有"这类失败
    expect(out).not.toMatch(/Pulling from|pull access denied|unauthorized/i);
    expect(out).toMatch(/not (found|present)|no such image|required to be present/i);
  }, 120_000);

  it("🔴 运行中容器的镜像身份：真容器，真 inspect", async () => {
    const nameOk = "cps-novel-probe-ok";
    const nameBad = "cps-novel-probe-bad";
    spawnSync("docker", ["tag", TAG_A, SHARED_TAG]);
    const { manifestPath } = await makeArchive(work, SHARED_TAG);
    spawnSync("docker", ["rm", "-f", nameOk, nameBad]);
    spawnSync("docker", ["run", "-d", "--name", nameOk, TAG_A, "sleep", "60"]);
    spawnSync("docker", ["run", "-d", "--name", nameBad, TAG_B, "sleep", "60"]);
    try {
      // preprod_compose 用桩替换（测的是身份比对，不是 compose 本身），
      // 但 docker inspect 的是**真实运行中的容器**。
      // 身份从 manifest 读，不再由调用方传 digest —— 传值就等于让调用方决定判据。
      const good = sh(
        `source '${LIB}'; preprod_compose() { docker ps -q --filter name=${nameOk}; };
         preprod_read_release_manifest '${manifestPath}';
         preprod_assert_container_image web`,
      );
      expect(`${good.stdout}${good.stderr}`).toContain("RUNTIME_IMAGE=PASS");
      expect(good.status).toBe(0);

      const bad = sh(
        `source '${LIB}'; preprod_compose() { docker ps -q --filter name=${nameBad}; };
         preprod_read_release_manifest '${manifestPath}';
         preprod_assert_container_image web`,
      );
      expect(bad.status).not.toBe(0);
      expect(`${bad.stdout}${bad.stderr}`).toMatch(/container_image_mismatch|container_manifest_digest_mismatch/);
    } finally {
      spawnSync("docker", ["rm", "-f", nameOk, nameBad]);
    }
  }, 180_000);
});

describe("消费端契约：不再有 registry-only 的旧约束", () => {
  it("preflight.sh 不再用 @sha256 正则卡应用镜像", async () => {
    const preflight = await readFile(path.join(root, "scripts/preproduction/preflight.sh"), "utf8");
    // 只允许出现在解释性注释里，不得再作为判据
    expect(preflight).not.toMatch(/^\s*\[\[\s*"\$\{CPS_NOVEL_APP_IMAGE[^\n]*@sha256/m);
    expect(preflight).toContain("preprod_assert_local_image");
  });

  it("shared env 不再提供 CPS_NOVEL_APP_IMAGE / GIT_COMMIT 覆盖源", async () => {
    const env = await readFile(path.join(root, "infra/preproduction/preprod.env.example"), "utf8");
    expect(env).not.toMatch(/^CPS_NOVEL_APP_IMAGE=/m);
    expect(env).not.toMatch(/^GIT_COMMIT=/m);
  });

  it("三个应用服务都有 pull_policy: never", async () => {
    const overlay = await readFile(path.join(root, "infra/preproduction/docker-compose.yml"), "utf8");
    const svc = overlay.split(/\n(?=  \w)/);
    for (const name of ["web:", "worker:", "scheduler:"]) {
      const block = svc.find((b) => b.trimStart().startsWith(name));
      expect(block, `${name} 段缺失`).toBeTruthy();
      expect(block, `${name} 缺 pull_policy: never`).toContain("pull_policy: never");
    }
  });

  it("deploy 与 rollback 用同一个 manifest 读取器与同一套预检", async () => {
    const release = await readFile(path.join(root, "scripts/preproduction/release.sh"), "utf8");
    const deploy = release.slice(release.indexOf("deploy() {"), release.indexOf("rollback() {"));
    const rollback = release.slice(release.indexOf("rollback() {"));
    for (const [name, body] of [["deploy", deploy], ["rollback", rollback]] as const) {
      expect(body, `${name} 未调用统一读取器`).toContain("read_manifest");
      expect(body, `${name} 未跑 preflight`).toContain("preflight.sh");
      expect(body, `${name} 未核对运行中容器身份`).toContain("preprod_assert_container_image");
    }
    // 🔴 回滚不得动数据库。断言的是**实际调用**，不是"文里有没有出现 restore 这个词"——
    // 第一版写成 not.toMatch(/restore|down migration/i)，结果被那句
    // "deliberately no down migration and no restore" 的注释自己触发。
    // 禁止性注释与真实动作用同样的字眼，这是本轮第二次踩到。
    const rollbackCode = rollback
      .split("\n")
      .filter((line) => !line.trim().startsWith("#"))
      .join("\n");
    expect(rollbackCode, "回滚不得调用 database.sh").not.toMatch(/database\.sh/);
    expect(rollbackCode, "回滚不得操作 postgres 服务").not.toMatch(/(stop|up|restart)[^\n]*postgres/);
    expect(rollbackCode, "回滚不得触碰数据卷").not.toMatch(/cps_novel_postgres_data/);
  });
});
