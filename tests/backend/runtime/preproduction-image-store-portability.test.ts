import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type Store, startDaemon, stopDaemon, dockerHostFor, daemonEvidence, hostDockerAvailable,
} from "./_lib/image-store-daemons";
import { craftArchive, readJson, writeJson, readTarZst, writeTarZst } from "./_lib/oci-archive-fixtures";

/**
 * Phase 2C-A · 归档镜像身份的 **image store 可移植性**。
 *
 * 2026-09-20 目标机（haiyue-vps，Docker 29.8.1，containerd image store）拒收了一份
 * 内容完全正确的归档：判据拿 `docker image inspect .Id` 去比 config digest，而
 * containerd store 的 `.Id` 报的是 **manifest digest**。经典 graphdriver 才报 config digest。
 *
 * 🔴 因此本组测试在**两种真实 image store 的 daemon** 上各跑一遍。
 *    CPU 架构与 image store 后端是两件事——此前"Mac 绿 + amd64 CI 绿"证明的是架构维度，
 *    完全没有触及 store 维度，所以那次目标机失败是单测抓不到的。
 *
 * 🔴 负例必须证明"修好之后没有把判据放松"：不能变成
 *    `actual == manifest_digest || actual == config_digest` 就放行。
 */

const root = process.cwd();
const IDENTITY = path.join(root, "scripts/preproduction/image-identity.mjs");
const VERIFY = path.join(root, "scripts/preproduction/verify-release-archive.sh");

const COMMIT_A = "1".repeat(40);
const COMMIT_B = "2".repeat(40);
const TAG_A = "cps-novel-imgstore-a:probe";
const TAG_B = "cps-novel-imgstore-b:probe";

const STORES: Store[] = ["classic", "containerd"];

// 🔴 缺 Docker 时**不静默跳过**。上一轮的教训是"总报 PASS"最危险；
//    没有真实 daemon 就没有证据，必须让整组测试显性失败，
//    除非操作者明确声明本次不验证（那时报告里也会留下未验证标记）。
const HOST_DOCKER = hostDockerAvailable();
const ACK_UNVERIFIED = process.env.PREPROD_ACK_IMAGE_STORE_UNVERIFIED === "1";

let work = "";
let platform = "";
const archive: Record<"a" | "b", string> = { a: "", b: "" };
const manifest: Record<"a" | "b", string> = { a: "", b: "" };
const evidence: Partial<Record<Store, ReturnType<typeof daemonEvidence>>> = {};

function sh(script: string, env: Record<string, string> = {}) {
  return spawnSync("bash", ["-c", script], {
    cwd: root, env: { ...process.env, ...env }, encoding: "utf8",
  });
}

function dockerOn(store: Store, args: string[], input?: string) {
  return spawnSync("docker", args, {
    env: { ...process.env, DOCKER_HOST: dockerHostFor(store) },
    encoding: "utf8", input, maxBuffer: 1024 * 1024 * 512,
  });
}

function sha256File(p: string) {
  return createHash("sha256").update(readFileSync(p)).digest("hex");
}

function buildOnHost(tag: string, commit: string) {
  const ctx = mkdtempSync(path.join(tmpdir(), "imgstore-ctx-"));
  writeFileSync(path.join(ctx, "Dockerfile"), [
    "FROM busybox:latest",
    `LABEL org.opencontainers.image.revision=${commit}`,
    "LABEL org.opencontainers.image.source=https://github.com/flightzxc/cps-novel",
    `RUN echo ${commit} > /probe-id`,
    // 🔴 刻意造一个 >1MiB 的层：解析器对超过缓冲上限的 entry 走的是
    // **不缓冲、纯流式**的哈希分支，而真实镜像的层几乎都在那条路径上。
    // 如果测试镜像的层全都小到会被缓冲，那条分支就一行没测到。
    // 用随机数据以免被压缩回 1MiB 以下。
    "RUN dd if=/dev/urandom of=/big.bin bs=1024 count=3072 2>/dev/null",
    'CMD ["sleep", "600"]',
    "",
  ].join("\n"));
  const built = spawnSync("docker", ["build", "-q", "-t", tag, ctx], { encoding: "utf8" });
  rmSync(ctx, { recursive: true, force: true });
  if (built.status !== 0) throw new Error(`build ${tag} failed: ${built.stderr}`);
}

/** save → zstd → build-manifest，走的是生产构建器同一条路径。 */
function packageImage(key: "a" | "b", tag: string, commit: string) {
  const name = `${key}.tar.zst`;
  const target = path.join(work, name);
  const saved = sh(`docker save ${tag} | zstd -q -1 -o ${JSON.stringify(target)}`);
  if (saved.status !== 0) throw new Error(`save ${tag} failed: ${saved.stderr}`);
  const sha = sha256File(target);
  const out = path.join(work, `${commit}.json`);
  const made = spawnSync("node", [
    IDENTITY, "build-manifest",
    "--archive", target, "--tag", tag, "--platform", platform,
    "--commit", commit, "--version", "0.0.0-test",
    "--archive-filename", name, "--archive-sha256", sha,
    "--built-at", "2026-09-20T00:00:00Z", "--source-repository", "test",
    "--out", out,
  ], { encoding: "utf8" });
  if (made.status !== 0) throw new Error(`build-manifest failed: ${made.stdout}${made.stderr}`);
  archive[key] = target;
  manifest[key] = out;
}

beforeAll(() => {
  if (!HOST_DOCKER) return;
  work = mkdtempSync(path.join(tmpdir(), "imgstore-work-"));
  spawnSync("docker", ["pull", "-q", "busybox:latest"], { encoding: "utf8" });
  buildOnHost(TAG_A, COMMIT_A);
  buildOnHost(TAG_B, COMMIT_B);
  platform = spawnSync("docker",
    ["image", "inspect", TAG_A, "--format", "{{.Os}}/{{.Architecture}}"],
    { encoding: "utf8" }).stdout.trim();
  packageImage("a", TAG_A, COMMIT_A);
  packageImage("b", TAG_B, COMMIT_B);
  for (const store of STORES) {
    startDaemon(store);
    const e = daemonEvidence(dockerHostFor(store));
    // 🔴 起来过 ≠ 现在可用。就绪之后立刻再取一次证据，空值即当场失败，
    // 不让整组测试带着一台已经死掉的 daemon 继续跑。
    if (!e.driver) {
      throw new Error(`${store} daemon reported no driver right after becoming ready: ${JSON.stringify(e)}`);
    }
    evidence[store] = e;
  }
}, 600_000);

afterAll(() => {
  for (const store of STORES) {
    dockerOn(store, ["rm", "-f", "imgstore-probe"]);
    stopDaemon(store);
  }
  spawnSync("docker", ["image", "rm", "-f", TAG_A, TAG_B], { encoding: "utf8" });
  if (work) rmSync(work, { recursive: true, force: true });
}, 120_000);

describe("真实 daemon 可用性", () => {
  it("🔴 两种 image store 都有真实 daemon，否则本组结论无效", () => {
    if (!HOST_DOCKER && ACK_UNVERIFIED) {
      console.warn("IMAGE_STORE_PORTABILITY=UNVERIFIED reason=host_docker_unavailable");
      return;
    }
    expect(HOST_DOCKER, "缺少宿主 Docker：无法产出测试归档，本组不能算通过").toBe(true);
    for (const store of STORES) {
      const e = evidence[store];
      expect(e, `${store} daemon 未就绪`).toBeDefined();
      // 证据留痕：实际 Server 版本与 store 形态，而不是我们声称它是什么。
      console.log(`IMAGE_STORE=${store} serverVersion=${e!.serverVersion} driver=${e!.driver} driverStatus=${e!.driverType}`);
    }
    expect(evidence.classic!.driver).toBe("overlay2");
    expect(evidence.containerd!.driver).toBe("overlayfs");
    expect(evidence.containerd!.driverType).toContain("io.containerd.snapshotter.v1");
  });
});

describe.runIf(HOST_DOCKER).each(STORES)("image store = %s", (store) => {
  const env = () => ({ DOCKER_HOST: dockerHostFor(store) });
  const loadA = () => sh(`${JSON.stringify(VERIFY)} --manifest ${JSON.stringify(manifest.a)} --dir ${JSON.stringify(work)} --load`, env());

  beforeAll(() => {
    dockerOn(store, ["image", "rm", "-f", TAG_A, TAG_B]);
  }, 60_000);

  it("正确归档通过，并记录实际使用的锚点", () => {
    const r = loadA();
    expect(r.stdout, r.stdout + r.stderr).toContain("VERIFY=PASS");
    expect(r.status).toBe(0);
    // 🔴 锚点必须随 store 不同而不同——相同就说明能力探测没起作用。
    expect(r.stdout).toContain(store === "containerd" ? "anchor=descriptor" : "anchor=config_id");
  }, 120_000);

  it("🔴 tag 被改指到另一个镜像即拒绝", () => {
    loadA();
    // 把 B 也装进来，再把 A 的 tag 抢过去
    sh(`zstd -dc ${JSON.stringify(archive.b)} | docker load`, env());
    expect(dockerOn(store, ["tag", TAG_B, TAG_A]).status).toBe(0);
    const r = sh(`${JSON.stringify(VERIFY)} --manifest ${JSON.stringify(manifest.a)} --dir ${JSON.stringify(work)}`, env());
    expect(r.status).toBe(0); // 离线部分仍应通过：归档本身没问题
    const probe = sh(
      `source ${JSON.stringify(path.join(root, "scripts/preproduction/lib.sh"))}
       preprod_read_release_manifest ${JSON.stringify(manifest.a)}
       preprod_assert_local_image "$PREPROD_RELEASE_IMAGE_REF"`, env());
    expect(probe.stdout, probe.stdout + probe.stderr).toContain("IMAGE=REFUSED");
    expect(probe.status).not.toBe(0);
  }, 120_000);

  it("🔴 本地已有正确镜像 A，送入只含 B 的错误归档也必须拒绝", () => {
    dockerOn(store, ["image", "rm", "-f", TAG_A, TAG_B]);
    loadA();                                     // A 就位且 tag 正确
    // manifest 仍声称是 A 的 commit，但归档换成 B 的内容
    const bogus = path.join(work, "swapped.tar.zst");
    copyFileSync(archive.b, bogus);
    const m = readJson(manifest.a);
    m.archive_filename = "swapped.tar.zst";
    m.archive_sha256 = sha256File(bogus);
    const mp = path.join(work, "swapped.json");
    writeJson(mp, m);
    const r = sh(`${JSON.stringify(VERIFY)} --manifest ${JSON.stringify(mp)} --dir ${JSON.stringify(work)} --load`, env());
    expect(r.stdout, r.stdout).toContain("REFUSED");
    expect(r.status).not.toBe(0);
  }, 120_000);

  it("🔴 tag 正确但实际容器跑的是旧镜像时，容器校验拒绝", () => {
    dockerOn(store, ["image", "rm", "-f", TAG_A, TAG_B]);
    loadA();
    sh(`zstd -dc ${JSON.stringify(archive.b)} | docker load`, env());
    dockerOn(store, ["rm", "-f", "imgstore-probe"]);
    // 容器刻意用 B 起，而 manifest 说的是 A
    const up = dockerOn(store, ["run", "-d", "--name", "imgstore-probe", TAG_B, "sleep", "600"]);
    expect(up.status, up.stderr).toBe(0);
    const inspected = dockerOn(store, ["inspect", "imgstore-probe", "--format", "{{json .}}"]).stdout;
    const m = readJson<{ oci: { platform_manifest: { digest: string }; config: { digest: string } } }>(manifest.a);
    const r = spawnSync("node", [
      IDENTITY, "assert-container",
      "--platform-manifest-digest", m.oci.platform_manifest.digest,
      "--config-digest", m.oci.config.digest,
      "--platform", platform, "--service", "web",
    ], { input: inspected, encoding: "utf8" });
    expect(r.stdout, r.stdout).toContain("RUNTIME_IMAGE=REFUSED");
    expect(r.status).not.toBe(0);
  }, 180_000);

  it("容器跑的就是被批准的镜像时通过，且锚点随 store 变化", () => {
    dockerOn(store, ["image", "rm", "-f", TAG_A, TAG_B]);
    loadA();
    dockerOn(store, ["rm", "-f", "imgstore-probe"]);
    const up = dockerOn(store, ["run", "-d", "--name", "imgstore-probe", TAG_A, "sleep", "600"]);
    expect(up.status, up.stderr).toBe(0);
    const inspected = dockerOn(store, ["inspect", "imgstore-probe", "--format", "{{json .}}"]).stdout;
    const m = readJson<{ oci: { platform_manifest: { digest: string }; config: { digest: string } } }>(manifest.a);
    const r = spawnSync("node", [
      IDENTITY, "assert-container",
      "--platform-manifest-digest", m.oci.platform_manifest.digest,
      "--config-digest", m.oci.config.digest,
      "--platform", platform, "--service", "web",
    ], { input: inspected, encoding: "utf8" });
    expect(r.stdout, r.stdout).toContain("RUNTIME_IMAGE_ONE=PASS");
    expect(r.stdout).toContain(
      store === "containerd" ? "anchor=manifest_descriptor" : "anchor=config_id",
    );
  }, 180_000);

  it("🔴 镜像缺失时拒绝，且不触发 pull 或就地 build", () => {
    dockerOn(store, ["image", "rm", "-f", TAG_A, TAG_B]);
    const before = dockerOn(store, ["image", "ls", "-q"]).stdout.trim();
    const probe = sh(
      `source ${JSON.stringify(path.join(root, "scripts/preproduction/lib.sh"))}
       preprod_read_release_manifest ${JSON.stringify(manifest.a)}
       preprod_assert_local_image "$PREPROD_RELEASE_IMAGE_REF"`, env());
    expect(probe.stdout).toContain("IMAGE=REFUSED reason=image_missing");
    const after = dockerOn(store, ["image", "ls", "-q"]).stdout.trim();
    expect(after, "拒绝路径不得把镜像拉下来或就地构建").toBe(before);
  }, 120_000);
});

describe.runIf(HOST_DOCKER)("判据规则本身（合成 inspect 输入）", () => {
  /**
   * 🔴 这一组用**合成的 inspect JSON**，不是拿 mock 冒充 containerd 实跑证据
   * （实跑证据在上面两个真实 daemon 的分组里）。这里钉的是判据**规则**：
   * 有些错误形态在真实 daemon 上不会自然出现，但一旦判据被写松就会被放行。
   */
  const want = () => {
    const m = readJson<any>(manifest.a);
    return {
      target: m.oci.target, config: m.oci.config,
      platform: m.image_platform, revision: m.image_revision,
    };
  };
  const assertImage = (inspect: unknown) => {
    const w = want();
    return spawnSync("node", [
      IDENTITY, "assert-image",
      "--target-digest", w.target.digest,
      "--target-mediatype", w.target.mediaType,
      "--target-size", String(w.target.size),
      "--config-digest", w.config.digest,
      "--platform", w.platform, "--revision", w.revision,
    ], { input: JSON.stringify([inspect]), encoding: "utf8" });
  };
  const baseClassic = () => {
    const w = want();
    const [os, architecture] = w.platform.split("/");
    return {
      Id: w.config.digest, Os: os, Architecture: architecture,
      Config: { Labels: { "org.opencontainers.image.revision": w.revision } },
    };
  };

  it("经典形态（无 Descriptor，.Id = config digest）通过", () => {
    const r = assertImage(baseClassic());
    expect(r.stdout, r.stdout).toContain("IMAGE=PASS anchor=config_id");
  });

  it("🔴 Descriptor 在场但不符时必须拒绝 —— 不得回退到 .Id 再试一次", () => {
    // 这正是被禁止的 `actual == target || actual == config` 写法会放行的形态：
    // Descriptor 指向别的对象，而 .Id 恰好等于期望的 config digest。
    const w = want();
    const r = assertImage({
      ...baseClassic(),
      Descriptor: { mediaType: w.target.mediaType, digest: `sha256:${"e".repeat(64)}`, size: w.target.size },
    });
    expect(r.stdout, r.stdout).toContain("descriptor_digest_mismatch");
    expect(r.status).not.toBe(0);
  });

  it("🔴 Descriptor 的 mediaType 与期望不符即拒绝", () => {
    const w = want();
    const r = assertImage({
      ...baseClassic(),
      Descriptor: { mediaType: "application/vnd.oci.image.index.v1+json", digest: w.target.digest, size: w.target.size },
    });
    expect(r.stdout, r.stdout).toContain("descriptor_mediatype_mismatch");
  });

  it("🔴 Descriptor 的 size 与期望不符即拒绝", () => {
    const w = want();
    const r = assertImage({
      ...baseClassic(),
      Descriptor: { mediaType: w.target.mediaType, digest: w.target.digest, size: w.target.size + 1 },
    });
    expect(r.stdout, r.stdout).toContain("descriptor_size_mismatch");
  });

  it("🔴 锚点对上了，平台不对仍必须拒绝", () => {
    const r = assertImage({ ...baseClassic(), Architecture: "s390x" });
    expect(r.stdout, r.stdout).toContain("platform_mismatch");
  });

  it("🔴 锚点对上了，revision 不对仍必须拒绝", () => {
    const r = assertImage({
      ...baseClassic(),
      Config: { Labels: { "org.opencontainers.image.revision": COMMIT_B } },
    });
    expect(r.stdout, r.stdout).toContain("revision_mismatch");
  });

  it("🔴 revision 标签缺失即拒绝，不当作通过", () => {
    const r = assertImage({ ...baseClassic(), Config: { Labels: {} } });
    expect(r.stdout, r.stdout).toContain("revision_mismatch");
  });

  it("🔴 Descriptor 为空对象时按经典形态判，不得因为字段存在就放行", () => {
    const r = assertImage({ ...baseClassic(), Descriptor: {}, Id: `sha256:${"f".repeat(64)}` });
    expect(r.stdout, r.stdout).toContain("id_config_digest_mismatch");
  });

  it("🔴 容器判据比的是 platform manifest，不是外层 target", () => {
    const m = readJson<any>(manifest.a);
    // 合成一个 target ≠ platform manifest 的期望，再喂进外层 target digest：
    // 若实现拿 target 去比，这里会错误通过。
    const r = spawnSync("node", [
      IDENTITY, "assert-container",
      "--platform-manifest-digest", `sha256:${"a".repeat(64)}`,
      "--config-digest", m.oci.config.digest,
      "--platform", m.image_platform, "--service", "web",
    ], {
      input: JSON.stringify([{
        Image: `sha256:${"b".repeat(64)}`,
        ImageManifestDescriptor: { mediaType: m.oci.platform_manifest.mediaType, digest: m.oci.target.digest, size: m.oci.target.size },
      }]),
      encoding: "utf8",
    });
    expect(r.stdout, r.stdout).toContain("container_manifest_digest_mismatch");
  });
});

describe.runIf(HOST_DOCKER)("归档与 manifest 层面的负例（与 store 无关）", () => {
  const verifyOffline = (m: string, extra = "") =>
    sh(`${JSON.stringify(VERIFY)} --manifest ${JSON.stringify(m)} --dir ${JSON.stringify(work)} ${extra}`);

  it("🔴 target 与 config 来自不同镜像，被拼进同一个 manifest → 拒绝", () => {
    const a = readJson<any>(manifest.a);
    const b = readJson<any>(manifest.b);
    a.oci.config = b.oci.config;              // A 的清单 + B 的 config
    const p = path.join(work, "frankenstein.json");
    writeJson(p, a);
    const r = verifyOffline(p);
    expect(r.stdout, r.stdout).toContain("archive_manifest_config_digest_disagree");
    expect(r.status).not.toBe(0);
  });

  it("🔴 descriptor 在场但 size 与实际字节数不符 → 拒绝", () => {
    const a = readJson<any>(manifest.a);
    a.oci.target.size = a.oci.target.size + 1;
    const p = path.join(work, "badsize.json");
    writeJson(p, a);
    const r = verifyOffline(p);
    expect(r.stdout, r.stdout).toContain("archive_manifest_target_size_disagree");
  });

  it("🔴 声明的平台与归档实际内容不符 → 拒绝", () => {
    const a = readJson<any>(manifest.a);
    a.image_platform = platform === "linux/amd64" ? "linux/arm64" : "linux/amd64";
    const p = path.join(work, "badplatform.json");
    writeJson(p, a);
    const r = verifyOffline(p);
    expect(r.stdout, r.stdout).toMatch(/config_platform_mismatch|platform_manifest_not_found/);
  });

  it("🔴 revision 与 approved commit 不一致 → 拒绝", () => {
    const a = readJson<any>(manifest.a);
    a.image_revision = COMMIT_B;
    const p = path.join(work, "badrev.json");
    writeJson(p, a);
    const r = verifyOffline(p);
    expect(r.stdout, r.stdout).toContain("manifest_revision_commit_disagree");
  });

  it("🔴 schemaVersion 1 明确拒绝并提示重建，不静默升级", () => {
    const legacy = {
      schemaVersion: 1, transport: "archive",
      approved_git_commit: COMMIT_A, version: "0.0.0-test",
      image_tag: TAG_A, image_config_digest: `sha256:${"0".repeat(64)}`,
      image_platform: platform, archive_filename: "a.tar.zst",
      archive_sha256: sha256File(archive.a),
    };
    const p = path.join(work, "legacy.json");
    writeJson(p, legacy);
    const r = verifyOffline(p);
    expect(r.stdout).toContain("manifest_schema_v1_unsupported");
    expect(r.stdout).toContain("rebuild_release_archive_with_current_builder");
  });

  it("🔴 缺少身份字段 → 拒绝", () => {
    const a = readJson<any>(manifest.a);
    delete a.oci.platform_manifest;
    const p = path.join(work, "noident.json");
    writeJson(p, a);
    expect(verifyOffline(p).stdout).toContain("manifest_oci_platform_manifest_missing");
  });

  it("🔴 未知 mediaType → 拒绝", () => {
    const a = readJson<any>(manifest.a);
    a.oci.target.mediaType = "application/vnd.example.unknown+json";
    const p = path.join(work, "badmedia.json");
    writeJson(p, a);
    expect(verifyOffline(p).stdout).toContain("manifest_oci_target_mediatype");
  });

  it("🔴 归档被改一个字节 → 拒绝", () => {
    const tampered = path.join(work, "tampered.tar.zst");
    const body = readFileSync(archive.a);
    body[body.length - 1] ^= 0xff;
    writeFileSync(tampered, body);
    const a = readJson<any>(manifest.a);
    a.archive_filename = "tampered.tar.zst";
    const p = path.join(work, "tampered.json");
    writeJson(p, a);
    expect(verifyOffline(p).stdout).toContain("archive_sha_mismatch");
  });

  it("🔴 archive SHA 与**批准记录**不符 → 拒绝（即便与随行 manifest 自洽）", () => {
    const r = verifyOffline(manifest.a, `--expected-archive-sha256 ${"0".repeat(64)}`);
    expect(r.stdout, r.stdout).toContain("archive_sha_not_approved");
    expect(r.status).not.toBe(0);
  });

  it("🔴 commit 与批准记录不符 → 拒绝", () => {
    const r = verifyOffline(manifest.a, `--approved-commit ${COMMIT_B}`);
    expect(r.stdout).toContain("commit_not_approved");
  });

  it("🔴 index 中同一 tag 有多个候选（归属歧义）→ 拒绝，不挑一个", () => {
    const dup = path.join(work, "ambiguous.tar.zst");
    craftArchive(archive.a, dup, (_e, index: any) => {
      index.manifests = [...index.manifests, { ...index.manifests[0] }];
    });
    const a = readJson<any>(manifest.a);
    a.archive_filename = "ambiguous.tar.zst";
    a.archive_sha256 = sha256File(dup);
    const p = path.join(work, "ambiguous.json");
    writeJson(p, a);
    expect(verifyOffline(p).stdout).toContain("target_ambiguous_for_tag");
  });

  it("🔴 所需的层在归档里缺失 → 拒绝（不指望运行时从网络补齐）", () => {
    const src = readTarZst(archive.a);
    const idx = JSON.parse(src.find((e) => e.name === "index.json")!.body.toString("utf8"));
    const manifestBlob = src.find((e) => e.name === `blobs/sha256/${idx.manifests[0].digest.slice(7)}`)!;
    const layers = JSON.parse(manifestBlob.body.toString("utf8")).layers;
    const victim = `blobs/sha256/${layers[0].digest.slice(7)}`;
    const missing = path.join(work, "missinglayer.tar.zst");
    writeTarZst(missing, src.filter((e) => e.name !== victim));
    const a = readJson<any>(manifest.a);
    a.archive_filename = "missinglayer.tar.zst";
    a.archive_sha256 = sha256File(missing);
    const p = path.join(work, "missinglayer.json");
    writeJson(p, a);
    expect(verifyOffline(p).stdout).toContain("layer_blob_absent");
  });

  // 🔴 下面两条钉的是内容身份的根：blob 的**原始字节**必须复算出它自己的 digest。
  // 少了这一步，"digest 对得上"就退化成"文件名对得上"——而文件名是攻击者可控的。
  it("🔴 manifest blob 内容与其 digest 文件名不符 → 拒绝", () => {
    const entries = readTarZst(archive.a);
    const idx = JSON.parse(entries.find((e) => e.name === "index.json")!.body.toString("utf8"));
    const target = `blobs/sha256/${idx.manifests[0].digest.slice(7)}`;
    const victim = entries.find((e) => e.name === target)!;
    // 内容改了，文件名与 index.json 里的 digest 都原样不动
    const mutated = JSON.parse(victim.body.toString("utf8"));
    mutated.annotations = { ...(mutated.annotations ?? {}), injected: "yes" };
    victim.body = Buffer.from(JSON.stringify(mutated), "utf8");
    idx.manifests[0].size = victim.body.length;   // size 对上，只剩 digest 这一道
    entries.find((e) => e.name === "index.json")!.body = Buffer.from(`${JSON.stringify(idx)}\n`, "utf8");
    const bad = path.join(work, "blobtamper.tar.zst");
    writeTarZst(bad, entries);

    const a = readJson<any>(manifest.a);
    a.archive_filename = "blobtamper.tar.zst";
    a.archive_sha256 = sha256File(bad);
    a.oci.target = { ...a.oci.target, size: victim.body.length };
    a.oci.platform_manifest = { ...a.oci.platform_manifest, size: victim.body.length };
    const p = path.join(work, "blobtamper.json");
    writeJson(p, a);
    const r = verifyOffline(p);
    expect(r.stdout, r.stdout).toContain("target_digest_mismatch");
    expect(r.status).not.toBe(0);
  });

  it("🔴 config blob 内容与其 digest 文件名不符 → 拒绝", () => {
    const entries = readTarZst(archive.a);
    const idx = JSON.parse(entries.find((e) => e.name === "index.json")!.body.toString("utf8"));
    const mEntry = entries.find((e) => e.name === `blobs/sha256/${idx.manifests[0].digest.slice(7)}`)!;
    const parsedManifest = JSON.parse(mEntry.body.toString("utf8"));
    const cfgName = `blobs/sha256/${parsedManifest.config.digest.slice(7)}`;
    const cfg = entries.find((e) => e.name === cfgName)!;
    const cfgJson = JSON.parse(cfg.body.toString("utf8"));
    // 把 revision 改成另一个 commit：内容变了，但 digest 文件名不动。
    cfgJson.config.Labels["org.opencontainers.image.revision"] = COMMIT_B;
    cfg.body = Buffer.from(JSON.stringify(cfgJson), "utf8");
    // 让 manifest 声明的 config.size 与新长度一致，并同步 manifest 自身的 digest，
    // 这样唯一的破绽就只剩 config blob 的内容哈希。
    parsedManifest.config.size = cfg.body.length;
    const mBody = Buffer.from(JSON.stringify(parsedManifest), "utf8");
    const mDigest = createHash("sha256").update(mBody).digest("hex");
    mEntry.name = `blobs/sha256/${mDigest}`;
    mEntry.body = mBody;
    idx.manifests[0].digest = `sha256:${mDigest}`;
    idx.manifests[0].size = mBody.length;
    entries.find((e) => e.name === "index.json")!.body = Buffer.from(`${JSON.stringify(idx)}\n`, "utf8");
    const bad = path.join(work, "cfgtamper.tar.zst");
    writeTarZst(bad, entries);

    const a = readJson<any>(manifest.a);
    a.archive_filename = "cfgtamper.tar.zst";
    a.archive_sha256 = sha256File(bad);
    a.oci.target = { ...a.oci.target, digest: `sha256:${mDigest}`, size: mBody.length };
    a.oci.platform_manifest = { ...a.oci.platform_manifest, digest: `sha256:${mDigest}`, size: mBody.length };
    a.oci.config = { ...a.oci.config, size: cfg.body.length };
    const p = path.join(work, "cfgtamper.json");
    writeJson(p, a);
    const r = verifyOffline(p);
    expect(r.stdout, r.stdout).toContain("config_digest_mismatch");
    expect(r.status).not.toBe(0);
  });

  it("🔴 归档**内部** descriptor 声明的 size 与实际字节数不符 → 拒绝", () => {
    // 与上面那条不同：这里改的是归档 index.json 里的 size，不是 release manifest 里的。
    // 前者由引用链自身的完整性检查负责，后者由 manifest↔归档 双向比对负责，
    // 两道闸各管一头，缺任一道都会让"descriptor 在场但对不上"蒙混过去。
    const bad = path.join(work, "innersize.tar.zst");
    craftArchive(archive.a, bad, (_e, index: any) => {
      index.manifests[0].size = index.manifests[0].size + 1;
    });
    const a = readJson<any>(manifest.a);
    a.archive_filename = "innersize.tar.zst";
    a.archive_sha256 = sha256File(bad);
    const p = path.join(work, "innersize.json");
    writeJson(p, a);
    const r = verifyOffline(p);
    expect(r.stdout, r.stdout).toContain("target_size_mismatch");
    expect(r.status).not.toBe(0);
  });

  it("🔴 config descriptor 的 size 与 config blob 实际字节数不符 → 拒绝", () => {
    // 构造一条**自洽的**引用链：改掉 manifest 里 config.size，重算 manifest digest
    // 并同步 index.json。这样 digest 全都对得上，唯一的破绽是 config 声明长度不实。
    const entries = readTarZst(archive.a);
    const idx = JSON.parse(entries.find((e) => e.name === "index.json")!.body.toString("utf8"));
    const oldDigest = idx.manifests[0].digest.slice(7);
    const mEntry = entries.find((e) => e.name === `blobs/sha256/${oldDigest}`)!;
    const parsed = JSON.parse(mEntry.body.toString("utf8"));
    parsed.config.size = parsed.config.size + 7;
    const body = Buffer.from(JSON.stringify(parsed), "utf8");
    const newDigest = createHash("sha256").update(body).digest("hex");
    mEntry.name = `blobs/sha256/${newDigest}`;
    mEntry.body = body;
    idx.manifests[0].digest = `sha256:${newDigest}`;
    idx.manifests[0].size = body.length;
    entries.find((e) => e.name === "index.json")!.body = Buffer.from(`${JSON.stringify(idx)}\n`, "utf8");
    const bad = path.join(work, "cfgsize.tar.zst");
    writeTarZst(bad, entries);

    const a = readJson<any>(manifest.a);
    a.archive_filename = "cfgsize.tar.zst";
    a.archive_sha256 = sha256File(bad);
    a.oci.target = { ...a.oci.target, digest: `sha256:${newDigest}`, size: body.length };
    a.oci.platform_manifest = { ...a.oci.platform_manifest, digest: `sha256:${newDigest}`, size: body.length };
    const p = path.join(work, "cfgsize.json");
    writeJson(p, a);
    const r = verifyOffline(p);
    expect(r.stdout, r.stdout).toContain("config_size_mismatch");
    expect(r.status).not.toBe(0);
  });

  /**
   * 🔴 工单点名的那条：layer 被改一个字节，但
   *   - 文件名 blobs/sha256/<digest> 保持不变
   *   - layer size 保持不变
   *   - archive SHA256 与 release manifest 的 archive_sha256 **一起重算**
   * 于是传输完整性这关完全过得去。只有逐层内容哈希能抓住它。
   *
   * 这条同时证明 reason 必须明确指向 layer，而不是被 archive_sha_mismatch 提前挡掉——
   * 后者只说明"文件在路上变了"，前者才说明"这份归档装的不是被批准的那个镜像"。
   */
  it("🔴 layer 被改 1 字节（size/文件名不变、archive SHA 同步重算）→ layer digest mismatch", () => {
    const entries = readTarZst(archive.a);
    const idx = JSON.parse(entries.find((e) => e.name === "index.json")!.body.toString("utf8"));
    const mBlob = entries.find((e) => e.name === `blobs/sha256/${idx.manifests[0].digest.slice(7)}`)!;
    const layers = JSON.parse(mBlob.body.toString("utf8")).layers;
    // 🔴 挑最大的那一层：必须 >1MiB，才能确保走的是不缓冲的流式哈希分支。
    const biggest = layers.reduce((a: any, b: any) => (b.size > a.size ? b : a));
    const victimName = `blobs/sha256/${biggest.digest.slice(7)}`;
    const victim = entries.find((e) => e.name === victimName)!;
    expect(victim.body.length, "被篡改的层必须超过缓冲上限，否则测不到流式分支")
      .toBeGreaterThan(1024 * 1024);
    const before = victim.body.length;
    // 翻转最后一个字节：长度不变、文件名不变
    victim.body = Buffer.from(victim.body);
    victim.body[victim.body.length - 1] ^= 0xff;
    expect(victim.body.length, "长度必须保持不变，否则会被 size 检查提前抓住").toBe(before);

    const bad = path.join(work, "layertamper.tar.zst");
    writeTarZst(bad, entries);

    const a = readJson<any>(manifest.a);
    a.archive_filename = "layertamper.tar.zst";
    a.archive_sha256 = sha256File(bad);   // 🔴 传输完整性这关刻意让它过
    const p = path.join(work, "layertamper.json");
    writeJson(p, a);

    const r = verifyOffline(p);
    expect(r.stdout, r.stdout).toContain("layer_digest_mismatch");
    expect(r.stdout, "不得被 archive SHA 提前挡掉——那样等于没验 layer")
      .not.toContain("archive_sha_mismatch");
    expect(r.status).not.toBe(0);
  });

  it("🔴 归档里任何 blob 的内容与其 digest 文件名不符即拒绝（含未被引用的）", () => {
    const entries = readTarZst(archive.a);
    // 追加一个文件名不是其内容哈希的 blob：本次 tag 根本不引用它，
    // 但它的存在说明这份归档已经不可信。
    entries.push({ name: `blobs/sha256/${"9".repeat(64)}`, body: Buffer.from("not-the-right-bytes") });
    const bad = path.join(work, "strayblob.tar.zst");
    writeTarZst(bad, entries);
    const a = readJson<any>(manifest.a);
    a.archive_filename = "strayblob.tar.zst";
    a.archive_sha256 = sha256File(bad);
    const p = path.join(work, "strayblob.json");
    writeJson(p, a);
    const r = verifyOffline(p);
    expect(r.stdout, r.stdout).toContain("blob_content_digest_mismatch");
    expect(r.status).not.toBe(0);
  });

  it("🔴 归档内出现符号链接条目 → 拒绝", () => {
    // 手工拼一个带 symlink typeflag 的 tar：路径穿越的经典载体。
    const raw = path.join(work, "symlink.tar");
    const head = Buffer.alloc(512, 0);
    head.write("evil", 0, "utf8");
    head.write("0000644\0", 100, "ascii");
    head.write(`${(0).toString(8).padStart(11, "0")}\0`, 124, "ascii");
    head.write(`${(0).toString(8).padStart(11, "0")}\0`, 136, "ascii");
    head.write("        ", 148, "ascii");
    head.write("2", 156, "ascii");                       // typeflag = symlink
    head.write("/etc/passwd", 157, "utf8");
    head.write("ustar\0", 257, "ascii"); head.write("00", 263, "ascii");
    let sum = 0; for (const b of head) sum += b;
    head.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "ascii");
    writeFileSync(raw, Buffer.concat([head, Buffer.alloc(1024, 0)]));
    const z = path.join(work, "symlink.tar.zst");
    spawnSync("zstd", ["-q", "-f", "-o", z, raw], { encoding: "utf8" });
    const r = spawnSync("node", [IDENTITY, "resolve", "--archive", z, "--tag", TAG_A], { encoding: "utf8" });
    expect(r.stdout, r.stdout).toContain("archive_link_entry_rejected");
  });
});
