import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

/**
 * Phase 2C · 归档工件运输契约。
 *
 * Owner 2026-09-20 裁决：cps-novel 的生产 artifact transport 从 GHCR registry
 * 改为 CPS 短剧形态的离线不可变归档（build → docker save → zstd → SHA256 →
 * SCP → docker load → 核对 digest/label）。本文件钉的是这条链上的**拒绝路径**。
 *
 * 🔴 这里断言的全部是"什么情况下必须拒绝"，不是"正常路径能跑通"。
 * 正常路径要真的构建一个 ~1.2GB 镜像，不适合放进单测；它由交付报告里的
 * build → save → 删除本地镜像 → load → 校验 的完整回环实测覆盖。
 *
 * 下面每条用例都在脚本触碰 Docker **之前**返回，所以不需要 Docker 守护进程。
 */

const root = process.cwd();
const BUILD = "scripts/preproduction/build-release-archive.sh";
const VERIFY = "scripts/preproduction/verify-release-archive.sh";
const FAKE_COMMIT = "0".repeat(40);

function run(script: string, args: string[], env: Record<string, string> = {}) {
  const result = spawnSync(path.join(root, script), args, {
    cwd: root,
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
  return { status: result.status, out: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

const temps: string[] = [];
afterEach(async () => {
  while (temps.length > 0) await rm(temps.pop()!, { recursive: true, force: true });
});

async function makeArchivePair(overrides: Record<string, unknown> = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "cps-archive-"));
  temps.push(dir);
  const archiveName = "cps-novel-0.1.0-abcdef0.tar.zst";
  const body = randomBytes(2048);
  await writeFile(path.join(dir, archiveName), body);
  const sha = createHash("sha256").update(body).digest("hex");
  const manifest = {
    schemaVersion: 1,
    transport: "archive",
    approved_git_commit: "a".repeat(40),
    version: "0.1.0",
    image_tag: "cps-novel:0.1.0-abcdef0",
    image_config_digest: `sha256:${"b".repeat(64)}`,
    image_platform: "linux/amd64",
    archive_filename: archiveName,
    archive_sha256: sha,
    built_at: "2026-09-20T00:00:00Z",
    source_repository: "https://github.com/flightzxc/cps-novel",
    ...overrides,
  };
  const manifestPath = path.join(dir, "manifest.json");
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return { dir, manifestPath, archivePath: path.join(dir, archiveName), sha };
}

describe("归档构建器只接受被批准的 commit", () => {
  it("两支脚本都存在且可执行", () => {
    for (const script of [BUILD, VERIFY]) {
      expect(existsSync(path.join(root, script)), `${script} 不存在`).toBe(true);
      const probe = run(script, ["--help"], {});
      // 可执行位缺失时 spawn 会报 EACCES（status 为 null）
      expect(probe.status, `${script} 不可执行`).not.toBeNull();
    }
  });

  it("拒绝短码 commit —— 短码不构成发布身份", () => {
    const { status, out } = run(BUILD, [], { APPROVED_GIT_COMMIT: "abc1234" });
    expect(status).toBe(65);
    expect(out).toContain("ARCHIVE_BUILD=REFUSED reason=commit_shape");
  });

  it("拒绝与 HEAD 不符的 commit", () => {
    const { status, out } = run(BUILD, [], { APPROVED_GIT_COMMIT: FAKE_COMMIT });
    expect(status).toBe(65);
    expect(out).toContain("ARCHIVE_BUILD=REFUSED reason=unapproved_head");
  });

  it("拒绝脏工作区 —— 否则产物对应的源码无法事后复原", async () => {
    const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" })
      .stdout.trim();
    const dirt = path.join(root, `.archive-contract-dirt-${process.pid}`);
    await writeFile(dirt, "dirt\n");
    try {
      const { status, out } = run(BUILD, [], { APPROVED_GIT_COMMIT: head });
      expect(status).toBe(65);
      expect(out).toContain("ARCHIVE_BUILD=REFUSED reason=dirty_checkout");
    } finally {
      await rm(dirt, { force: true });
    }
  });
});

describe("归档构建器的身份断言写在脚本里，不能被悄悄拿掉", () => {
  it("平台、revision、config digest 三条断言齐全", async () => {
    const source = await readFile(path.join(root, BUILD), "utf8");
    // 平台：Dockerfile 的 digest pin 是隐式保证，这里要有显式断言
    expect(source).toContain("platform_mismatch");
    expect(source).toContain("RELEASE_TARGET_PLATFORM");
    // revision label 必须等于 approved commit
    expect(source).toContain("revision_label");
    expect(source).toContain("org.opencontainers.image.revision");
    // config digest 是跨主机稳定的身份（save/load 不保留 RepoDigest）
    expect(source).toContain("image_config_digest");
  });

  it("manifest 明确声明 tag 本身不是身份", async () => {
    const source = await readFile(path.join(root, BUILD), "utf8");
    expect(source).toContain("image_tag alone is NOT identity");
    for (const field of [
      "approved_git_commit",
      "image_config_digest",
      "archive_filename",
      "archive_sha256",
      "built_at",
      "source_repository",
    ]) {
      expect(source, `manifest 缺字段 ${field}`).toContain(field);
    }
  });

  it("先写 .partial 再改名 —— 中途失败不留下看似成功的半截归档", async () => {
    const source = await readFile(path.join(root, BUILD), "utf8");
    expect(source).toContain(".partial.");
    expect(source).toMatch(/mv "\$tmp_archive" "\$archive"/);
  });
});

describe("校验器：篡改一律拒绝", () => {
  it("完好的归档 + manifest 通过离线校验", async () => {
    const { manifestPath } = await makeArchivePair();
    const { status, out } = run(VERIFY, ["--manifest", manifestPath]);
    expect(out).toContain("VERIFY_OFFLINE=PASS");
    expect(status).toBe(0);
  });

  it("🔴 归档被篡改一个字节即拒绝", async () => {
    const { manifestPath, archivePath } = await makeArchivePair();
    const body = await readFile(archivePath);
    body[0] ^= 0xff; // 翻转一个 bit
    await writeFile(archivePath, body);
    const { status, out } = run(VERIFY, ["--manifest", manifestPath]);
    expect(status).toBe(65);
    expect(out).toContain("reason=archive_sha_mismatch");
  });

  it("🔴 manifest 里的 sha 被改成别的值即拒绝", async () => {
    const { manifestPath } = await makeArchivePair({ archive_sha256: "c".repeat(64) });
    const { status, out } = run(VERIFY, ["--manifest", manifestPath]);
    expect(status).toBe(65);
    expect(out).toContain("reason=archive_sha_mismatch");
  });

  it("拒绝形状不合法的 commit / config digest", async () => {
    const bad = await makeArchivePair({ approved_git_commit: "abc1234" });
    expect(run(VERIFY, ["--manifest", bad.manifestPath]).out).toContain(
      "reason=manifest_commit_shape",
    );
    const bad2 = await makeArchivePair({ image_config_digest: "not-a-digest" });
    expect(run(VERIFY, ["--manifest", bad2.manifestPath]).out).toContain(
      "reason=manifest_config_digest_shape",
    );
  });

  it("拒绝 transport 不是 archive 的 manifest —— 挡住误用 GHCR PoC 的 manifest", async () => {
    const { manifestPath } = await makeArchivePair({ transport: "registry" });
    const { status, out } = run(VERIFY, ["--manifest", manifestPath]);
    expect(status).toBe(65);
    expect(out).toContain("reason=manifest_transport");
  });

  it("归档文件缺失即拒绝，不会当成通过", async () => {
    const { manifestPath, archivePath } = await makeArchivePair();
    await rm(archivePath, { force: true });
    const { status, out } = run(VERIFY, ["--manifest", manifestPath]);
    expect(status).toBe(65);
    expect(out).toContain("reason=archive_unreadable");
  });

  it("manifest 不可读即拒绝", () => {
    const { status, out } = run(VERIFY, ["--manifest", "/nonexistent/manifest.json"]);
    expect(status).toBe(65);
    expect(out).toContain("reason=manifest_unreadable");
  });

  it("🔴 校验器用 config digest 而不是 tag 去 inspect", async () => {
    const source = await readFile(path.join(root, VERIFY), "utf8");
    expect(source).toContain('docker image inspect "$config_digest"');
    expect(source).toContain("loaded_digest_mismatch");
    expect(source).toContain("revision_mismatch");
  });
});

describe("GHCR 不再是生产运输路径", () => {
  it("可执行的 GHCR 发布工作流已从仓库移除", () => {
    expect(
      existsSync(path.join(root, ".github/workflows/ghcr-release.yml")),
      "GHCR 发布工作流仍在，存在被误当成生产发布路径的风险",
    ).toBe(false);
  });

  /**
   * 断言的是**正面口径**，不是"文中不许出现某个词"。
   *
   * 第一版这条写成 `not.toMatch(/GHCR\s*不可用/)`，结果被 ADR 里那句
   * 「不得把本 ADR 描述成『GHCR 不可用』」自己触发——**禁止性表述**和
   * **结论性表述**用同样的字眼，朴素正则分不开。钉正面结论才钉得住。
   */
  it("ADR 的 GHCR 状态是「PoC 成功但未被选用」", async () => {
    const adr = await readFile(
      path.join(root, "docs/adr/ADR-DEPLOYMENT-ARTIFACT-DISTRIBUTION.md"),
      "utf8",
    );
    // 状态字段是机器可读的唯一判据
    expect(adr).toMatch(/GHCR_STATUS\s*=\s*POC_COMPLETED_NOT_SELECTED/);
    // 正确表述必须原文在场
    expect(adr).toContain(
      "GHCR technically works, but is not selected as the production transport",
    );
    // PoC 的实测结果必须留档，否则后人无从判断它到底跑没跑通
    expect(adr).toContain("pull-by-digest");
    expect(adr).toContain("sha256:75392b67");
  });
});
