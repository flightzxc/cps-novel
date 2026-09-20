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

🔴 **本节所有命令都在 haiyue-vps 上执行，一律写成 `ssh haiyue-vps '<绝对路径命令>'`。**
不要再写依赖"当前终端在哪台机器、当前目录在哪"的裸命令——那是发布事故的常见起点。

设该 release 的仓库目录为 `$REL=/opt/cps-novel/releases/<approved_commit>`，
工件 staging 目录为 `/opt/cps-novel/shared/artifacts/staging`。

### 3.0 宿主机工具前置条件（缺失即失败，**不临时安装**）

| 工具 | 何时需要 | 用途 |
| --- | --- | --- |
| `bash` | 总是 | 脚本宿主 |
| `sha256sum` 或 `shasum` | 总是 | 归档校验和 |
| **`node`** | 总是 | manifest 按 JSON 数据解析 |
| `docker` | `--load` 时 | 装载与 inspect |
| `zstd` | `--load` 时 | 解压 |

校验器会先查这些工具，缺哪个就报 `reason=tool_missing_<name>` 并在**任何服务变更之前**退出。
🔴 不要在发布窗口里临时 `apt-get install` 补工具——那等于在未经验证的主机状态上继续发布。

### 3.1 批准记录

```bash
# APPROVED_GIT_COMMIT 来自 Owner 的批准记录，由操作者显式提供。
# 🔴 收到一份自洽的 archive + manifest **不等于**它被批准发布：
#    manifest 说自己是哪个 commit，只是它的自述。
export APPROVED_GIT_COMMIT=<Owner 批准记录里的 40-hex>
```

`release.sh` 会比对 `APPROVED_GIT_COMMIT` 与 manifest 内的 commit，不一致即
`reason=owner_approved_commit` 拒绝。

### 3.2 顺序不可调换

```bash
# 1) 离线完整性：manifest 形状 + 归档 SHA256（不碰 Docker）
ssh haiyue-vps '/opt/cps-novel/releases/<commit>/scripts/preproduction/verify-release-archive.sh \
  --manifest /opt/cps-novel/shared/artifacts/staging/<commit>.json'
# → VERIFY_OFFLINE=PASS

# 2) 装载并核对镜像身份
ssh haiyue-vps '/opt/cps-novel/releases/<commit>/scripts/preproduction/verify-release-archive.sh \
  --manifest /opt/cps-novel/shared/artifacts/staging/<commit>.json --load'
# → VERIFY=PASS
```

不依赖仓库脚本时的等价手工命令（同样全绝对路径）：

```bash
ssh haiyue-vps 'cd /opt/cps-novel/shared/artifacts/staging && \
  sha256sum -c <archive>.sha256 && \
  zstd -d -c <archive> | docker load && \
  docker image inspect <image_tag> --format "{{.Id}} {{.Os}}/{{.Architecture}} {{index .Config.Labels \"org.opencontainers.image.revision\"}}"'
```

必须全部成立：

| 项 | 判据 |
| --- | --- |
| 归档 SHA256 | == manifest 的 `archive_sha256` |
| **从 tag 解析出的 image ID** | == manifest 的 `image_config_digest` |
| revision 标签 | == manifest 的 `approved_git_commit` |
| 平台 | == manifest 的 `image_platform`（`linux/amd64`） |

🔴 **任何一项不一致 → STOP，不得继续部署。**

### 3.3 为什么必须从 tag 出发核对

按 `image_config_digest` 去 `inspect` 只能证明"那个镜像在本机存在"，这是个弱得多的命题：
本机可能早就缓存着它，而同名 **tag 却指向别的镜像**——而 Compose 用的正是 tag。
所以判据是「tag 解析出来的 ID == manifest 的 config digest」，不是反过来。

### 3.4 三种 digest 不是一回事

| 名称 | 是什么 | 在本链路里的角色 |
| --- | --- | --- |
| **image ID / config digest** | 镜像 config blob 的 sha256，`docker image inspect .Id` | ✅ **本链路的身份**。`save`/`load` 跨主机保持不变 |
| **registry manifest digest** | registry 上 manifest 的 sha256，即 `repo@sha256:` | ❌ 本链路**不存在**。`docker load` 后 `RepoDigests=[]` |
| **layer digest** | 单层 tar 的 sha256 | 不用于身份判定 |

🔴 **禁止把 config digest 拼成 `repo@sha256:` 去糊弄校验**——那是一个任何 registry 上都不
存在的引用，只会让身份校验"看起来通过"。`preprod_read_release_manifest()` 会以
`reason=manifest_image_tag_digest_forgery` 拒绝带 `@` 的 `image_tag`。

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
| staging | 传输落地点。校验通过后 `ssh haiyue-vps 'mv /opt/cps-novel/shared/artifacts/staging/<files> /opt/cps-novel/shared/artifacts/verified/'`；校验失败就地删除，不要留着 |
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
- **VPS 需要 `zstd` 与 `node`**（见 §3.0 的完整工具表）。这是 Phase 2C 的一次性前置准备，
  必须在发布窗口**之前**完成，不要在窗口内临时安装。
- **目标平台已有实测证据**：haiyue-vps Phase 1 输出 `Architecture: x86-64` / `uname: x86_64`，
  因此目标固定为 `linux/amd64`；构建端在输入与产出两侧都断言该平台，目标机装载后再断言一次。
- **版本身份漂移**：Git tag `v0.2.0` 与 `package.json` 的 `0.1.0` 不一致。
  身份以 approved commit + config digest + archive SHA256 为准，不要用 `0.1.0-*` 当身份。
