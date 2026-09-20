# 归档工件运输 Runbook（cps-novel 生产 primary）

> 决策依据：`docs/adr/ADR-DEPLOYMENT-ARTIFACT-DISTRIBUTION.md`
> 构建入口：`scripts/preproduction/build-release-archive.sh`
> 校验入口：`scripts/preproduction/verify-release-archive.sh`（**VPS 侧跑的就是这一支**）
> 建立日期：2026-09-20（取代同日的 GHCR runbook）

## 0. 这份 runbook 覆盖什么

`approved commit → 归档 → SCP → VPS 校验 → docker load → 身份核对`，到「可以交给
`release.sh` 部署」为止。

🔴 **不覆盖也不授权**：实际部署、Nginx、Certbot、PostgreSQL、migration、
生产/预生产密钥、DNS/TLS、公网流量切换。

🔴 **GHCR 不是生产来源。** `ghcr.io/flightzxc/cps-novel` 是 Phase 2C PoC 的遗留工件
（`POC artifact only, NOT production source`），没有任何生产消费者。不要从它拉镜像。

## 1. 构建归档（构建主机）

```bash
APPROVED_GIT_COMMIT=<40-hex> scripts/preproduction/build-release-archive.sh
```

前置：工作区干净、`HEAD` 等于该 commit、本机有 `zstd` 与 `docker`。

成功输出：

```text
ARCHIVE_BUILD=PASS
ARCHIVE_FILE=<...>/cps-novel-<version>-<short>.tar.zst
ARCHIVE_SHA256=<64hex>
IMAGE_CONFIG_DIGEST=sha256:<64hex>
IMAGE_PLATFORM=linux/amd64
RELEASE_MANIFEST=<...>/<commit>.json
```

拒绝路径（任一命中都不产出归档）：`commit_shape` / `unapproved_head` /
`dirty_checkout` / `zstd_missing` / `derived_commit` / `platform_mismatch` /
`revision_label` / `archive_exists` / `manifest_exists`。

### 🔴 平台断言不是形式主义

本仓 Dockerfile 把基础镜像钉成 `node:20-alpine@sha256:fb4cd12…`，那是一个
**amd64 单架构 manifest**，所以即使在 arm64 的 Mac 上构建，产物也是 `linux/amd64`。
但这层保证是**隐式**的——谁把 `NODE_BASE_IMAGE` 换成 tag 或多架构索引 digest，
arm64 机器就会静默产出 arm64 镜像，一路通过打包与传输，**直到 VPS 上起不来才发现**。
脚本因此显式断言 `RELEASE_TARGET_PLATFORM`（默认 `linux/amd64`）。

## 2. 传输到 VPS

需要随工件一起送过去的**三个文件**：

```text
cps-novel-<version>-<short>.tar.zst          归档
cps-novel-<version>-<short>.tar.zst.sha256   校验和
<commit>.json                                release manifest
```

```bash
# staging 目录见 §4；示例用 rsync，断点续传 + 保留权限，优于裸 scp
rsync -avP --chmod=F600 \
  "<archive>" "<archive>.sha256" "<manifest>" \
  haiyue-vps:/opt/cps-novel/shared/artifacts/staging/
```

`scp` 亦可：`scp <三个文件> haiyue-vps:/opt/cps-novel/shared/artifacts/staging/`。
大文件建议 `rsync -P`，中断后可续。

## 3. VPS 上的校验与装载

**顺序不可调换。先离线校验完整性，再决定要不要装进 Docker。**

```bash
cd /opt/cps-novel/shared/artifacts/staging

# 1) 离线完整性：manifest 形状 + 归档 SHA256
scripts/preproduction/verify-release-archive.sh --manifest <commit>.json
# → VERIFY_OFFLINE=PASS

# 2) 装载并核对镜像身份
scripts/preproduction/verify-release-archive.sh --manifest <commit>.json --load
# → VERIFY=PASS
```

不想依赖仓库脚本时的等价手工命令：

```bash
shasum -a 256 -c cps-novel-*.tar.zst.sha256      # 或 sha256sum -c
zstd -d -c cps-novel-*.tar.zst | docker load
docker image inspect <image_config_digest> \
  --format '{{.Id}} {{.Os}}/{{.Architecture}} {{index .Config.Labels "org.opencontainers.image.revision"}}'
```

必须全部成立：

| 项 | 判据 |
| --- | --- |
| 归档 SHA256 | == manifest 的 `archive_sha256` |
| 装载后 image ID | == manifest 的 `image_config_digest` |
| revision 标签 | == manifest 的 `approved_git_commit` |
| 平台 | == manifest 的 `image_platform` |

🔴 **任何一项不一致 → STOP，不得继续部署。** 不要"重传一次看看"就放行；
先确认是传输损坏还是工件本身被换过。

### 为什么用 config digest 而不是 tag 去 inspect

tag 在任何一台机器上都能被指向别的镜像。`docker save`/`load` **不保留 RepoDigest**，
所以 registry 那套 `repo@sha256:` 在这里不存在；**config digest 是唯一跨主机稳定的身份**。

## 4. Artifact staging 与保留

```text
/opt/cps-novel/shared/artifacts/
├── staging/      刚传上来、尚未校验
├── verified/     校验通过、已 docker load
└── （无第三层）
```

🔴 **不要把归档放进 `releases/<sha>/`**。那里是不可变的源码 release 目录，
混入数百 MB 的二进制工件会让它既难备份又难比对。工件与源码 release 分开存放。

| 阶段 | 规则 |
| --- | --- |
| staging | 传输落地点。校验通过后 `mv` 到 `verified/`；校验失败就地删除，不要留着 |
| verified | 已 `docker load` 成功的工件 |
| retention | **至少保留 2 份**：当前发布 + 上一个可回滚版本 |
| cleanup | 超出保留数的按 `built_at` 从旧到新删除；**永远不删当前 `current` 指向的那一份和它的前一份** |

保留数量参考 CPS 侧做法即可。**本轮不为此建立 artifact repository 或自动 GC**——
两份足够支撑 Phase 2B 已定义的 rollback 契约。

## 5. 失败处理

| 现象 | 处置 |
| --- | --- |
| `archive_sha_mismatch` | 传输损坏或工件被替换。删除 staging 里那份，重传；两次仍不符 → STOP 报告 |
| `loaded_digest_mismatch` | 装进来的不是 manifest 描述的镜像。STOP，不要 retag 绕过 |
| `revision_mismatch` | 镜像与 approved commit 不对应。STOP |
| `platform_mismatch` | 构建主机平台错了。回构建主机重做，**不要在 VPS 上重建镜像** |

🔴 **禁止的"绕过"**：在 VPS 上 `git pull` 后重新 build、用 `latest` tag、
手工 `docker tag` 让身份"看起来对上"。这三种都让线上跑的东西不可事前批准、不可事后核对。

## 6. GHCR PoC 工件的处置建议

当前存在 `ghcr.io/flightzxc/cps-novel`（visibility = **public**），是 PoC 产物。

**建议 Owner 手工删除**，理由：它不再有任何用途，留着只会让将来的人误以为那是生产来源；
且它当前是 public。

UI 路径（本轮**不执行**）：

```text
GitHub → 头像 → Packages → cps-novel → Package settings
  → Danger Zone → Delete this package
```

删除前提（官方限制）：`You cannot delete a public package if any version of the
package has more than 5,000 downloads` —— 本 package 下载量为个位数，不受限。

删除后 30 天内可恢复，但一旦同名空间被新 package 占用即不可恢复。

## 7. 已知环境约束

- **Docker Hub 在部分本机网络不可达**（实测 `auth.docker.io` i/o timeout）。
  BuildKit 不读本地镜像库、`FROM` 一律经 registry，本机构建时需通过
  `docker-compose.yml` 既有的 `P1_12_NODE_BASE_IMAGE` 覆盖点指向可达的 registry 副本。
  覆盖前必须核对副本与 Dockerfile 固定 digest 的 config digest 一致。
- **VPS 需要 `zstd`**。校验与解压都用到它；若 VPS 上没有，需先安装
  （`apt-get install -y zstd`）。这是 Phase 2C 的一项前置条件。
- **版本身份漂移**：Git tag `v0.2.0` 与 `package.json` 的 `0.1.0` 不一致。
  身份以 approved commit + config digest + archive SHA256 为准，不要用 `0.1.0-*` 当身份。
