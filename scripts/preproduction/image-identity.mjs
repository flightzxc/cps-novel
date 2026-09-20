#!/usr/bin/env node
// Phase 2C · 归档镜像身份的**唯一**内容模型。
//
// 构建器、归档校验器、preflight、deploy、rollback、运行容器校验全部经由本模块，
// 不各写一份规则。上一轮的事故正是"判据只有一份实现、但锚点选错"——
// 锚点选错要能一处改掉，而不是散在五个脚本里逐个追。
//
// 🔴 本模块判定的是**内容身份**，不是"某个 digest 眼熟"：
//   - 所有 digest 一律按归档内 blob 的**原始字节**复算，不 JSON.parse 后重新
//     stringify 再哈希（那会得到另一个哈希，且对字段顺序敏感）；
//   - descriptor 声明的 size 必须等于实际字节长度；
//   - mediaType 必须与被解释的对象类型一致；
//   - target → platform manifest → config 的引用关系必须实际走通；
//   - 接受的每一个值都必须来自**同一条**已验证的引用链。
//
// 🔴 经典 image store 与 containerd image store 对同一镜像报不同的 digest：
//     经典     : image inspect .Id = config digest，无 .Descriptor
//     containerd: image inspect .Id = manifest digest，有 .Descriptor
//   因此按**字段能力**读取，而不是按 Docker 版本号或 storage-driver 字符串猜。
//   字段存在但内容冲突时必须拒绝，不得退回另一个 SHA 再试一次。

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

// --- 退出码 ---------------------------------------------------------------
// 64 用法错误 / 65 内容不合格 / 66 输入不可用 / 69 缺依赖。
// 刻意区分 65 与 66：前者是工件有问题，后者多半是路径写错，运维处置不同。
const EX_USAGE = 64, EX_DATA = 65, EX_NOINPUT = 66, EX_UNAVAILABLE = 69;

function refuse(kind, reason, extra = {}, code = EX_DATA) {
  const tail = Object.entries(extra)
    .map(([k, v]) => ` ${k}=${v}`)
    .join("");
  console.log(`${kind}=REFUSED reason=${reason}${tail}`);
  process.exit(code);
}

const OCI_INDEX = new Set([
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
]);
const OCI_MANIFEST = new Set([
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
]);
const OCI_CONFIG = new Set([
  "application/vnd.oci.image.config.v1+json",
  "application/vnd.docker.container.image.v1+json",
]);

const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;

// --- tar 流式读取 ----------------------------------------------------------
//
// 🔴 不把归档整包读进内存。单次解压扫描：
//   - 小对象（index/manifest/config 一类）按上限缓冲；
//   - 大 layer 只记录名字与长度，用于"所需内容是否齐备"的存在性与长度核对
//     （其字节完整性已由整包 archive_sha256 覆盖）。
// 🔴 同时挡掉路径穿越、危险链接与重复关键条目造成的歧义。

const BLOCK = 512;
const MAX_BUFFERED_ENTRY = 1 << 20;      // 单个对象最多缓冲 1 MiB
const MAX_BUFFERED_TOTAL = 64 << 20;     // 全部缓冲合计上限 64 MiB

function parseOctal(buf) {
  // GNU base-256 扩展（最高位置 1）本仓构建器不会产生；出现即明确拒绝，不猜。
  if (buf[0] & 0x80) return null;
  const s = buf.toString("ascii").replace(/\0.*$/, "").trim();
  if (s === "") return 0;
  if (!/^[0-7]+$/.test(s)) return null;
  return parseInt(s, 8);
}

function safeEntryName(name) {
  if (name === "" || name.startsWith("/") || name.includes("\\")) return null;
  const parts = name.split("/");
  if (parts.some((p) => p === ".." )) return null;
  return name;
}

async function scanArchive(archivePath) {
  const zstd = spawn("zstd", ["-dc", archivePath], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  zstd.stderr.on("data", (c) => { stderr += c.toString(); });
  // 🔴 监听器必须在**读 stdout 之前**挂好。`close` 只发一次；如果等 for-await
  // 结束后才挂，zstd 可能已经退出，那个 await 就会永远不返回——一次静默的永久挂起。
  const closed = new Promise((resolve) => {
    zstd.on("close", (c) => resolve(c));
    zstd.on("error", () => resolve(-1));
  });

  const entries = new Map();      // name -> { size }
  const blobs = new Map();        // name -> Buffer
  let buffered = 0;

  let pending = Buffer.alloc(0);
  let mode = "header";            // header | data | skip
  let current = null;
  let remaining = 0, padding = 0;
  let chunks = null;
  let zeroBlocks = 0;
  let failure = null;

  const fail = (reason, extra) => {
    if (!failure) failure = { reason, extra: extra || {} };
    zstd.kill("SIGTERM");
  };

  for await (const chunk of zstd.stdout) {
    if (failure) break;
    pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
    let offset = 0;

    for (;;) {
      if (failure) break;
      if (mode === "header") {
        if (pending.length - offset < BLOCK) break;
        const head = pending.subarray(offset, offset + BLOCK);
        offset += BLOCK;

        if (head.every((b) => b === 0)) {
          // 连续两个全零块 = 归档结束标记
          if (++zeroBlocks >= 2) { mode = "done"; break; }
          continue;
        }
        zeroBlocks = 0;

        const rawName = head.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
        const prefix = head.subarray(345, 500).toString("utf8").replace(/\0.*$/, "");
        const typeflag = String.fromCharCode(head[156]);
        const size = parseOctal(head.subarray(124, 12 + 124));
        if (size === null) { fail("archive_unsupported_size_encoding", { entry: rawName }); break; }

        const full = prefix ? `${prefix}/${rawName}` : rawName;
        const name = safeEntryName(full);
        if (name === null) { fail("archive_unsafe_entry_path", { entry: JSON.stringify(full) }); break; }

        // 🔴 已知且安全的类型之外一律拒绝，不静默跳过：
        //   1/2 = 硬链接/符号链接（可指向归档外）
        //   L/K = GNU 长名扩展、x/g = pax 扩展头（都能改写下一条目的路径）
        if (typeflag === "1" || typeflag === "2") {
          fail("archive_link_entry_rejected", { entry: name, typeflag });
          break;
        }
        if (typeflag === "L" || typeflag === "K" || typeflag === "x" || typeflag === "g") {
          fail("archive_extended_header_unsupported", { entry: name, typeflag });
          break;
        }

        if (typeflag === "5") { mode = "header"; continue; }   // 目录
        if (typeflag !== "0" && typeflag !== "\0") {
          fail("archive_unsupported_entry_type", { entry: name, typeflag });
          break;
        }

        // 🔴 同一路径出现两次 = 归属歧义，拒绝而不是"后者覆盖前者"。
        if (entries.has(name)) { fail("archive_duplicate_entry", { entry: name }); break; }
        entries.set(name, { size });

        remaining = size;
        padding = (BLOCK - (size % BLOCK)) % BLOCK;
        const keep = size <= MAX_BUFFERED_ENTRY && buffered + size <= MAX_BUFFERED_TOTAL;
        if (keep) { current = name; chunks = []; mode = "data"; }
        else { current = null; chunks = null; mode = "skip"; }
        if (remaining === 0) {
          if (current) { blobs.set(current, Buffer.alloc(0)); }
          current = null; chunks = null;
          mode = padding > 0 ? "skip" : "header";
          remaining = padding; padding = 0;
        }
        continue;
      }

      if (mode === "data" || mode === "skip") {
        const avail = pending.length - offset;
        if (avail === 0) break;
        const take = Math.min(avail, remaining);
        if (mode === "data" && take > 0) chunks.push(pending.subarray(offset, offset + take));
        offset += take;
        remaining -= take;
        if (remaining > 0) break;

        if (mode === "data") {
          const body = Buffer.concat(chunks);
          blobs.set(current, body);
          buffered += body.length;
          current = null; chunks = null;
        }
        if (padding > 0) { remaining = padding; padding = 0; mode = "skip"; continue; }
        mode = "header";
        continue;
      }

      break; // done
    }

    pending = offset > 0 ? pending.subarray(offset) : pending;
    if (mode === "done") { zstd.kill("SIGTERM"); break; }
  }

  const code = await closed;

  if (failure) refuse("ARCHIVE", failure.reason, failure.extra);
  // zstd 被我们主动 kill 掉的情况不算失败（读到结束标记就够了）。
  if (mode !== "done" && code !== 0) {
    refuse("ARCHIVE", "archive_unreadable",
      { detail: JSON.stringify(stderr.trim().slice(0, 120)) }, EX_NOINPUT);
  }
  return { entries, blobs };
}

// --- 引用链解析与验证 ------------------------------------------------------

function blobPath(digest) { return `blobs/sha256/${digest.slice(7)}`; }

function readVerifiedBlob({ entries, blobs }, descriptor, allowed, what) {
  if (!descriptor || typeof descriptor !== "object") refuse("IDENTITY", `${what}_descriptor_missing`);
  const { mediaType, digest, size } = descriptor;
  if (typeof digest !== "string" || !DIGEST_RE.test(digest)) refuse("IDENTITY", `${what}_digest_shape`);
  if (typeof mediaType !== "string" || !allowed.has(mediaType)) {
    refuse("IDENTITY", `${what}_mediatype_unsupported`, { mediaType: JSON.stringify(mediaType) });
  }
  const path = blobPath(digest);
  if (!entries.has(path)) refuse("IDENTITY", `${what}_blob_absent`, { digest });
  const body = blobs.get(path);
  if (!body) refuse("IDENTITY", `${what}_blob_too_large_to_verify`, { digest });

  // 🔴 原始字节复算，不经 JSON 往返。
  const actual = `sha256:${createHash("sha256").update(body).digest("hex")}`;
  if (actual !== digest) refuse("IDENTITY", `${what}_digest_mismatch`, { expected: digest, actual });
  if (typeof size === "number" && size !== body.length) {
    refuse("IDENTITY", `${what}_size_mismatch`, { declared: size, actual: body.length });
  }
  const declaredSize = entries.get(path).size;
  if (declaredSize !== body.length) refuse("IDENTITY", `${what}_entry_size_mismatch`);

  let parsed;
  try { parsed = JSON.parse(body.toString("utf8")); }
  catch { refuse("IDENTITY", `${what}_not_json`, { digest }); }
  return { descriptor: { mediaType, digest, size: body.length }, parsed };
}

function selectTarget(index, tag) {
  if (!index || typeof index !== "object" || !Array.isArray(index.manifests)) {
    refuse("IDENTITY", "index_shape");
  }
  const short = tag.includes(":") ? tag.slice(tag.indexOf(":") + 1) : tag;
  const fullNameOf = (m) => ((m && m.annotations) || {})["io.containerd.image.name"];
  const matchesFullName = (m) => {
    const named = fullNameOf(m);
    return named === tag
      || named === `docker.io/library/${tag}`
      || named === `docker.io/${tag}`;
  };

  // 🔴 绝不取 manifests[0]。只认**显式指向本 image_tag** 的条目；
  //    命中 0 条或多于 1 条都拒绝，不"挑一个看起来对的"。
  //
  // 🔴 `org.opencontainers.image.ref.name` 只存 **tag 后缀**（`v1`、`probe`…），
  //    不含仓库名。拿它当命中判据的话，`repo-a:probe` 的归档会被 `repo-b:probe`
  //    匹配上 —— 两个毫不相干的镜像互相冒认。（这不是假设：2026-09-20 的
  //    consumer 负例 2 实际撞上了。）所以完整名注解在场时它是唯一判据，
  //    只有整份 index 都没有完整名注解的旧布局才退到后缀匹配。
  const anyFullName = index.manifests.some((m) => fullNameOf(m) !== undefined);
  const hits = anyFullName
    ? index.manifests.filter(matchesFullName)
    : index.manifests.filter((m) => {
        const ref = ((m && m.annotations) || {})["org.opencontainers.image.ref.name"];
        return ref !== undefined && ref === short;
      });
  if (hits.length === 0) refuse("IDENTITY", "target_not_found_for_tag", { tag });
  if (hits.length > 1) refuse("IDENTITY", "target_ambiguous_for_tag", { tag, matches: hits.length });
  return hits[0];
}

function resolveIdentity(scanned, tag, wantPlatform) {
  const { entries, blobs } = scanned;

  const layout = blobs.get("oci-layout");
  if (!layout) refuse("IDENTITY", "oci_layout_absent");
  let layoutJson;
  try { layoutJson = JSON.parse(layout.toString("utf8")); } catch { refuse("IDENTITY", "oci_layout_not_json"); }
  if (layoutJson.imageLayoutVersion !== "1.0.0") {
    refuse("IDENTITY", "oci_layout_version_unsupported",
      { version: JSON.stringify(layoutJson.imageLayoutVersion) });
  }

  const idxRaw = blobs.get("index.json");
  if (!idxRaw) refuse("IDENTITY", "index_absent");
  let index;
  try { index = JSON.parse(idxRaw.toString("utf8")); } catch { refuse("IDENTITY", "index_not_json"); }

  const targetDesc = selectTarget(index, tag);
  const isIndex = OCI_INDEX.has(targetDesc.mediaType);
  const target = readVerifiedBlob(scanned, targetDesc,
    isIndex ? OCI_INDEX : OCI_MANIFEST, "target");

  // target 与平台 manifest 可以是同一对象，但语义必须分开记。
  let platformDesc, platformManifest;
  if (isIndex) {
    const [os, arch] = wantPlatform.split("/");
    const hits = (target.parsed.manifests || []).filter(
      (m) => m && m.platform && m.platform.os === os && m.platform.architecture === arch,
    );
    if (hits.length === 0) refuse("IDENTITY", "platform_manifest_not_found", { platform: wantPlatform });
    if (hits.length > 1) refuse("IDENTITY", "platform_manifest_ambiguous", { platform: wantPlatform });
    platformDesc = hits[0];
    platformManifest = readVerifiedBlob(scanned, platformDesc, OCI_MANIFEST, "platform_manifest");
  } else {
    platformDesc = target.descriptor;
    platformManifest = target;
  }

  const configResult = readVerifiedBlob(scanned, platformManifest.parsed.config, OCI_CONFIG, "config");
  const config = configResult.parsed;

  const actualPlatform = `${config.os}/${config.architecture}`;
  if (actualPlatform !== wantPlatform) {
    refuse("IDENTITY", "config_platform_mismatch", { expected: wantPlatform, actual: actualPlatform });
  }
  const revision = ((config.config && config.config.Labels) || {})["org.opencontainers.image.revision"];
  if (typeof revision !== "string" || !/^[0-9a-f]{40}$/.test(revision)) {
    refuse("IDENTITY", "config_revision_shape");
  }

  // 🔴 所选镜像所需的层必须**全部在归档内**，不能指望运行时从网络补齐。
  const layers = platformManifest.parsed.layers;
  if (!Array.isArray(layers) || layers.length === 0) refuse("IDENTITY", "layers_shape");
  for (const [i, l] of layers.entries()) {
    if (!l || typeof l.digest !== "string" || !DIGEST_RE.test(l.digest)) {
      refuse("IDENTITY", "layer_digest_shape", { index: i });
    }
    const e = entries.get(blobPath(l.digest));
    if (!e) refuse("IDENTITY", "layer_blob_absent", { index: i, digest: l.digest });
    if (typeof l.size === "number" && l.size !== e.size) {
      refuse("IDENTITY", "layer_size_mismatch", { index: i, declared: l.size, actual: e.size });
    }
  }

  return {
    image_tag: tag,
    image_platform: actualPlatform,
    image_revision: revision,
    oci: {
      target: target.descriptor,
      platform_manifest: {
        mediaType: platformManifest.descriptor.mediaType,
        digest: platformManifest.descriptor.digest,
        size: platformManifest.descriptor.size,
      },
      config: configResult.descriptor,
    },
    layer_count: layers.length,
  };
}

// --- release manifest（schemaVersion 2）-------------------------------------

function readManifest(path) {
  let raw;
  try { raw = readFileSync(path, "utf8"); }
  catch { refuse("MANIFEST", "manifest_unreadable", {}, EX_NOINPUT); }
  let m;
  try { m = JSON.parse(raw); } catch { refuse("MANIFEST", "manifest_not_json"); }
  if (m === null || typeof m !== "object" || Array.isArray(m)) refuse("MANIFEST", "manifest_not_object");

  // 🔴 v1 明确拒绝并提示重建，不原地补字段、不静默降级。
  //    v1 把 docker inspect .Id 当作 config digest 写死，在 containerd image store
  //    上那个值其实是 manifest digest —— 自动"升级"等于把一个已知错误的值
  //    换个字段名继续用。
  if (m.schemaVersion === 1) {
    refuse("MANIFEST", "manifest_schema_v1_unsupported",
      { hint: "rebuild_release_archive_with_current_builder" });
  }
  if (m.schemaVersion !== 2) refuse("MANIFEST", "manifest_schema_version");
  if (m.transport !== "archive") refuse("MANIFEST", "manifest_transport");

  const str = (k, re) => {
    const v = m[k];
    if (typeof v !== "string" || !re.test(v)) refuse("MANIFEST", `manifest_${k}`);
    return v;
  };
  const commit = str("approved_git_commit", /^[0-9a-f]{40}$/);
  const tag = str("image_tag", /^[A-Za-z0-9][A-Za-z0-9._/-]*:[A-Za-z0-9][A-Za-z0-9._-]*$/);
  // 🔴 带 @ 的 image_tag 是把某个 digest 拼成 registry 引用。本链路没有 registry
  //    manifest digest 这个东西，拼出来的引用在任何 registry 上都不存在。
  if (tag.includes("@")) refuse("MANIFEST", "manifest_image_tag_digest_forgery");
  const platform = str("image_platform", /^[a-z0-9]+\/[a-z0-9_]+$/);
  const revision = str("image_revision", /^[0-9a-f]{40}$/);
  const archive = str("archive_filename", /^[A-Za-z0-9][A-Za-z0-9._-]*$/);
  if (archive.includes("/") || archive.includes("..")) refuse("MANIFEST", "manifest_archive_path");
  const archiveSha = str("archive_sha256", /^[0-9a-f]{64}$/);
  if (revision !== commit) refuse("MANIFEST", "manifest_revision_commit_disagree");

  const oci = m.oci;
  if (!oci || typeof oci !== "object") refuse("MANIFEST", "manifest_oci_missing");
  const desc = (k, allowed) => {
    const d = oci[k];
    if (!d || typeof d !== "object") refuse("MANIFEST", `manifest_oci_${k}_missing`);
    if (typeof d.digest !== "string" || !DIGEST_RE.test(d.digest)) refuse("MANIFEST", `manifest_oci_${k}_digest`);
    if (typeof d.size !== "number" || !Number.isInteger(d.size) || d.size <= 0) {
      refuse("MANIFEST", `manifest_oci_${k}_size`);
    }
    if (typeof d.mediaType !== "string" || !allowed.has(d.mediaType)) {
      refuse("MANIFEST", `manifest_oci_${k}_mediatype`);
    }
    return d;
  };
  const target = desc("target", new Set([...OCI_INDEX, ...OCI_MANIFEST]));
  const platformManifest = desc("platform_manifest", OCI_MANIFEST);
  const config = desc("config", OCI_CONFIG);
  // single-manifest 布局下 target == platform manifest；是 index 时两者必须不同。
  if (OCI_INDEX.has(target.mediaType) && target.digest === platformManifest.digest) {
    refuse("MANIFEST", "manifest_oci_index_self_reference");
  }
  if (!OCI_INDEX.has(target.mediaType) && target.digest !== platformManifest.digest) {
    refuse("MANIFEST", "manifest_oci_target_platform_disagree");
  }
  if (config.digest === platformManifest.digest) refuse("MANIFEST", "manifest_oci_config_manifest_collision");

  return {
    commit, tag, platform, revision, archive, archiveSha,
    target, platformManifest, config,
  };
}

// --- 本地镜像 / 运行容器的身份判定 ------------------------------------------
//
// 🔴 按**字段能力**读取，不按 Docker 版本号或 storage-driver 字符串猜身份。
// 🔴 禁止实现成 `actual == manifest_digest || actual == config_digest` 然后放行：
//    那样一个装着错误镜像、但恰好某个 digest 对上的环境也会通过。
//    有 Descriptor 就必须用 Descriptor 判，冲突即拒绝，不回退到 .Id 再试一次。

function assertImage(inspectJson, want) {
  let arr;
  try { arr = JSON.parse(inspectJson); } catch { refuse("IMAGE", "inspect_not_json"); }
  const d = Array.isArray(arr) ? arr[0] : arr;
  if (!d || typeof d !== "object") refuse("IMAGE", "inspect_empty");

  const descriptor = d.Descriptor;
  const hasDescriptor = descriptor && typeof descriptor === "object"
    && typeof descriptor.digest === "string" && descriptor.digest !== "";

  if (hasDescriptor) {
    // containerd image store：Descriptor 语义明确，是权威来源。
    if (descriptor.digest !== want.targetDigest) {
      refuse("IMAGE", "descriptor_digest_mismatch",
        { expected: want.targetDigest, actual: descriptor.digest });
    }
    if (typeof descriptor.mediaType === "string" && descriptor.mediaType !== want.targetMediaType) {
      refuse("IMAGE", "descriptor_mediatype_mismatch",
        { expected: want.targetMediaType, actual: descriptor.mediaType });
    }
    if (typeof descriptor.size === "number" && descriptor.size !== want.targetSize) {
      refuse("IMAGE", "descriptor_size_mismatch",
        { expected: want.targetSize, actual: descriptor.size });
    }
  } else {
    // 经典 graphdriver：无 Descriptor，.Id 即 config digest（已实证）。
    if (typeof d.Id !== "string" || d.Id !== want.configDigest) {
      refuse("IMAGE", "id_config_digest_mismatch",
        { expected: want.configDigest, actual: JSON.stringify(d.Id) });
    }
  }

  const platform = `${d.Os}/${d.Architecture}`;
  if (platform !== want.platform) {
    refuse("IMAGE", "platform_mismatch", { expected: want.platform, actual: platform });
  }
  const labels = (d.Config && d.Config.Labels) || {};
  if (labels["org.opencontainers.image.revision"] !== want.revision) {
    refuse("IMAGE", "revision_mismatch",
      { expected: want.revision, actual: JSON.stringify(labels["org.opencontainers.image.revision"]) });
  }
  console.log(`IMAGE=PASS anchor=${hasDescriptor ? "descriptor" : "config_id"}`);
}

function assertContainer(inspectJson, want, service) {
  let arr;
  try { arr = JSON.parse(inspectJson); } catch { refuse("RUNTIME_IMAGE", "inspect_not_json", { service }); }
  const d = Array.isArray(arr) ? arr[0] : arr;
  if (!d || typeof d !== "object") refuse("RUNTIME_IMAGE", "inspect_empty", { service });

  const imd = d.ImageManifestDescriptor;
  const hasImd = imd && typeof imd === "object" && typeof imd.digest === "string" && imd.digest !== "";

  if (hasImd) {
    // 🔴 与**选中的平台 manifest** 比，而不是盲目拿外层 index digest 比：
    //    多平台 index 下容器跑的是某一个平台的 manifest，外层 index digest 永远不等。
    if (imd.digest !== want.platformManifestDigest) {
      refuse("RUNTIME_IMAGE", "container_manifest_digest_mismatch",
        { service, expected: want.platformManifestDigest, actual: imd.digest });
    }
    if (imd.platform && typeof imd.platform === "object") {
      const p = `${imd.platform.os}/${imd.platform.architecture}`;
      if (p !== want.platform) {
        refuse("RUNTIME_IMAGE", "container_platform_mismatch",
          { service, expected: want.platform, actual: p });
      }
    }
  } else {
    if (typeof d.Image !== "string" || d.Image !== want.configDigest) {
      refuse("RUNTIME_IMAGE", "container_image_mismatch",
        { service, expected: want.configDigest, actual: JSON.stringify(d.Image) });
    }
  }
  console.log(`RUNTIME_IMAGE_ONE=PASS service=${service} anchor=${hasImd ? "manifest_descriptor" : "config_id"}`);
}

// --- CLI -------------------------------------------------------------------

function arg(argv, name, required = true) {
  const i = argv.indexOf(name);
  if (i === -1 || i + 1 >= argv.length) {
    if (required) { console.error(`missing ${name}`); process.exit(EX_USAGE); }
    return undefined;
  }
  return argv[i + 1];
}

const argv = process.argv.slice(2);
const cmd = argv[0];

if (cmd === "resolve") {
  const archive = arg(argv, "--archive");
  const tag = arg(argv, "--tag");
  const platform = arg(argv, "--platform", false) || "linux/amd64";
  const identity = resolveIdentity(await scanArchive(archive), tag, platform);
  process.stdout.write(`${JSON.stringify(identity, null, 2)}\n`);
} else if (cmd === "build-manifest") {
  // 🔴 manifest 的**唯一**生成实现。构建器与测试都走这里，
  //    否则测试拼出来的 manifest 与生产构建器产出的会悄悄分叉，
  //    而分叉的表现是"测试全绿、真发布时身份不符"。
  const archive = arg(argv, "--archive");
  const tag = arg(argv, "--tag");
  const platform = arg(argv, "--platform", false) || "linux/amd64";
  const commit = arg(argv, "--commit");
  const out = arg(argv, "--out");
  const id = resolveIdentity(await scanArchive(archive), tag, platform);
  if (id.image_revision !== commit) {
    refuse("MANIFEST", "build_revision_not_approved",
      { approved: commit, archive: id.image_revision });
  }
  const body = {
    schemaVersion: 2,
    transport: "archive",
    approved_git_commit: commit,
    version: arg(argv, "--version"),
    image_tag: tag,
    image_platform: id.image_platform,
    image_revision: id.image_revision,
    archive_filename: arg(argv, "--archive-filename"),
    archive_sha256: arg(argv, "--archive-sha256"),
    oci: id.oci,
    layer_count: id.layer_count,
    built_at: arg(argv, "--built-at"),
    source_repository: arg(argv, "--source-repository", false) || "",
    identityNote: "Identity = approved_git_commit + oci.platform_manifest.digest + oci.config.digest + archive_sha256. image_tag alone is NOT identity. Which digest a host reports depends on its image store; both are recorded here.",
    versionIdentityIssue: "git tag may differ from package.json version; commit and digests are authoritative",
  };
  // wx：已存在即失败，绝不覆盖既有正式工件。
  writeFileSync(out, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  process.stdout.write(`${JSON.stringify(id, null, 2)}\n`);
} else if (cmd === "read-manifest") {
  const m = readManifest(arg(argv, "--manifest"));
  // bash 侧逐行 read；顺序即契约，调用方不自己解析 manifest。
  process.stdout.write([
    m.commit, m.tag, m.platform, m.revision, m.archive, m.archiveSha,
    m.target.digest, m.target.mediaType, String(m.target.size),
    m.platformManifest.digest, m.platformManifest.mediaType, String(m.platformManifest.size),
    m.config.digest, String(m.config.size),
  ].join("\n"));
} else if (cmd === "verify-archive-against-manifest") {
  // 🔴 归档实际内容 ↔ manifest 声明，双向核对。
  //    只证明"manifest 自洽"没有意义：伪造者两边一起写就通过了。
  const manifestPath = arg(argv, "--manifest");
  const archive = arg(argv, "--archive");
  const m = readManifest(manifestPath);
  const id = resolveIdentity(await scanArchive(archive), m.tag, m.platform);
  const pairs = [
    ["target_digest", id.oci.target.digest, m.target.digest],
    ["target_mediatype", id.oci.target.mediaType, m.target.mediaType],
    ["target_size", String(id.oci.target.size), String(m.target.size)],
    ["platform_manifest_digest", id.oci.platform_manifest.digest, m.platformManifest.digest],
    ["platform_manifest_size", String(id.oci.platform_manifest.size), String(m.platformManifest.size)],
    ["config_digest", id.oci.config.digest, m.config.digest],
    ["config_size", String(id.oci.config.size), String(m.config.size)],
    ["revision", id.image_revision, m.revision],
    ["platform", id.image_platform, m.platform],
  ];
  for (const [what, actual, declared] of pairs) {
    if (actual !== declared) {
      refuse("IDENTITY", `archive_manifest_${what}_disagree`, { declared, actual });
    }
  }
  console.log("IDENTITY=PASS");
  console.log(`  target            ${id.oci.target.digest} (${id.oci.target.mediaType})`);
  console.log(`  platform_manifest ${id.oci.platform_manifest.digest}`);
  console.log(`  config            ${id.oci.config.digest}`);
  console.log(`  platform          ${id.image_platform}`);
  console.log(`  revision          ${id.image_revision}`);
  console.log(`  layers            ${id.layer_count}`);
} else if (cmd === "assert-image") {
  assertImage(readFileSync(0, "utf8"), {
    targetDigest: arg(argv, "--target-digest"),
    targetMediaType: arg(argv, "--target-mediatype"),
    targetSize: Number(arg(argv, "--target-size")),
    configDigest: arg(argv, "--config-digest"),
    platform: arg(argv, "--platform"),
    revision: arg(argv, "--revision"),
  });
} else if (cmd === "assert-container") {
  assertContainer(readFileSync(0, "utf8"), {
    platformManifestDigest: arg(argv, "--platform-manifest-digest"),
    configDigest: arg(argv, "--config-digest"),
    platform: arg(argv, "--platform"),
  }, arg(argv, "--service"));
} else {
  console.error("usage: image-identity.mjs resolve|read-manifest|verify-archive-against-manifest|assert-image|assert-container");
  process.exit(EX_USAGE);
}
