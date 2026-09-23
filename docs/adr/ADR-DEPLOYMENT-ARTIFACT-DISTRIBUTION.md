# ADR-DEPLOYMENT-ARTIFACT-DISTRIBUTION · 部署工件的运输方式

```text
ADR_ID              = DEPLOYMENT-ARTIFACT-DISTRIBUTION
DECISION_STATUS     = ACCEPTED（2026-09-20 第二次裁决，推翻同日第一次裁决）
DECISION_DATE       = 2026-09-20
DECIDED_BY          = Owner
SCOPE               = cps-novel（CPS 海阅）的部署工件运输；并记录 CPS 短剧现状以作对照
GHCR_STATUS         = POC_COMPLETED_NOT_SELECTED
BUILDS_ON           = ADR-PREPRODUCTION-MAINTENANCE-DEPLOYMENT（Phase 2B）
IMPLEMENTED_BY      = scripts/preproduction/build-release-archive.sh
                      scripts/preproduction/verify-release-archive.sh
RUNBOOK             = docs/operations/ARCHIVE_RELEASE_TRANSPORT.md
```

## 1. 决定

**cps-novel 的生产 artifact transport 是「不可变 Docker 归档 → SSH → docker load」，
与 CPS 短剧相同。GHCR 经完整 PoC 验证可用，但不被选为生产运输方式。**

```text
approved 40-hex Git commit
  → build immutable image（仓库既有 build contract）
  → 验证 build metadata（平台 / revision label / config digest）
  → docker save
  → zstd 压缩
  → SHA256 manifest
  → SCP/SSH → haiyue-vps
  → VPS 上校验 SHA256
  → docker load
  → 核对 image config digest
  → 核对 org.opencontainers.image.revision
  → Phase 2C release manifest → 部署
```

## 2. 🔴 两个 CPS 项目现在用同一套运输方式——这不是 LLM 的「统一」

| 项目 | Primary artifact transport |
| --- | --- |
| CPS 短剧 | immutable Docker archive → SSH → `docker load` |
| CPS 海阅（本仓） | immutable Docker archive → SSH → `docker load` |

**两边相同，是 Owner 在海阅这边完整跑过 GHCR PoC、评估实际运维复杂度之后主动裁决的结果，
不是任何 Agent 为了「两个项目形式统一」擅自对齐。**

🔴 反过来也成立：**未来的 Claude / Codex / Cursor / Luna 不得仅仅因为「两个项目应该一致」
或「registry 更现代」就把任一项目切换成另一套运输方式。** 要改必须有 Owner 的新决策，
并在本 ADR 追加一条记录。

## 3. 决策演进（不要抹掉这段）

```text
2026-09-20 第一次裁决  选定 GHCR 作为 cps-novel 的 primary transport
        ↓
        完成真实 PoC（见 §4，全部通过）
        ↓
        PoC 暴露出为达成 private package 所需的额外运维面（见 §5）
        ↓
2026-09-20 第二次裁决  Owner 主动改为 CPS 形态的不可变归档运输
```

保留这段是因为：不写下来的话，后来的人看到仓库里既有 GHCR 的痕迹又不用它，只能靠猜——
而最常见的猜测（「大概没跑通」）恰恰是错的。

## 4. GHCR PoC 结果：技术上跑通了

🔴 **不得把本 ADR 描述成「GHCR 不可用」。** 正确表述是：

> **GHCR technically works, but is not selected as the production transport for
> current cps-novel deployment.**

实测全部通过（run 35492063736，approved commit `8609fa0b…`）：

| 项 | 结果 |
| --- | --- |
| GitHub Actions 登录 GHCR（`GITHUB_TOKEN`，`packages: write`） | ✅ |
| push image | ✅ |
| 取得 `repo@sha256` digest | ✅ `sha256:75392b67…` |
| pull-by-digest | ✅ |
| `org.opencontainers.image.revision` == approved commit | ✅ |

## 5. 为什么不选它

PoC 同时暴露出一条真实约束：

```text
public repository + Actions/GITHUB_TOKEN 创建 package
  → 实际产出 public package
```

（GitHub 文档：「by default if a workflow **creates** a package using the `GITHUB_TOKEN`,
the package **inherits the visibility and permissions model of the repository** where the
workflow is run」。）

要得到 private package，必须额外引入：classic PAT、private-first bootstrap、
package 删除重建、Manage Actions access 配置、每次发布后的额外可见性验证、
「public 仓库授权给 private package 时 fork 可能可读」这条敞口，
以及 source-label 在后续 push 时是否会重新关联这一条仍需继续验证的行为。

对照当前实际场景——**单台 VPS、低发布频率、已有一条 CPS 侧成熟验证过的归档运输链**——
这些复杂度换来的收益不足。

附带收益：生产路径不再需要 GHCR PAT，VPS 上不再需要 `docker login ghcr.io`，
也不需要 `read:packages` 凭据。**整条链上少了一个外部依赖与一份长期凭据。**

## 6. 只改运输，身份纪律一条不动

Phase 2B 建立的以下纪律全部原样保留：approved 40-hex commit、不可变镜像、
image/config digest、`org.opencontainers.image.revision` 标签、release manifest、
不可变 release 目录、稳定的 Compose/数据身份、rollback 契约。

**本次只修改 artifact transport 这一项。**

### 归档路线的身份构成

```text
identity = approved_git_commit
         + oci.platform_manifest.digest   （linux/amd64 实际使用的那份清单）
         + oci.config.digest              （清单引用的 config blob）
         + archive_sha256                 （传输完整性）
```

🔴 `image_tag` 只是人类可读的定位符，**单独不构成身份**——tag 在任何一台机器上都能被指到别的镜像。

🔴 **两个 digest 都要在案**，因为不同 image store 报不同的那一个（见 §8.1.1）。
两者都由构建期解析归档内容得出，随归档运输，目标机可精确复现。

🔴 **禁止退化成**：`git pull` / VPS 上临时 build / `latest` tag / 可变镜像引用。

### 关于「归档可重现性」的准确表述

`docker save` 的输出与其压缩结果**不保证跨次构建逐字节相同**。因此 `archive_sha256`
的作用是**传输完整性**（这一份归档在路上没被改动），不是「同一 commit 必然产出同一归档」。
跨主机稳定的是**内容 digest 本身**（manifest digest 与 config digest 都由内容唯一决定）。
不要把 archive SHA256 当成可重现性证明。

## 7. 现存的 GHCR PoC 工件

```text
ghcr.io/flightzxc/cps-novel
visibility = public
状态       = POC artifact only, NOT production source
```

它没有 VPS 消费者、没有生产依赖。**不得**在任何 runbook 或脚本中把它当作生产来源。
是否删除见 runbook；本轮不执行删除。

## 8. 未决项

### 8.1 ~~`release.sh` 不兼容~~ → 已接线（2026-09-20 第二轮）

原记录：`release.sh` 与 `preflight.sh` 都要求 manifest 的镜像字段匹配
`@sha256:`（registry manifest digest），而经典 graphdriver 上 `docker load` 进来的镜像
`RepoDigests=[]`，归档 manifest 因此喂不进消费端。

**已修复。** 消费链统一为：

```text
preprod_read_release_manifest()   lib.sh 里的唯一 manifest 解析器
  → deploy 与 rollback 共用，不存在第二份实现
  → JSON.parse 解析（不是 require()），校验 schemaVersion / transport / 字段形状 / 路径安全
  → 导出 PREPROD_RELEASE_{COMMIT,IMAGE_REF,IMAGE_DIGEST,PLATFORM,ARCHIVE,ARCHIVE_SHA256}

preprod_assert_local_image()      从 **tag** 解析 ID 并与 config digest 比对
preprod_assert_container_image()  启动后核对**实际容器**的 Image ID
preprod_compose_app_up/run()      应用镜像入口；闸门见 §8.1.3，不再只靠 CLI flag
```

配套：`infra/preproduction/docker-compose.yml` 给 web/worker/scheduler 加
`pull_policy: never`（绕过脚本直接 `docker compose up` 时的第二道闸）；
`preprod.env.example` 不再定义 `CPS_NOVEL_APP_IMAGE` / `GIT_COMMIT`，
`preprod_load_env()` 检测到 shared env 覆盖 manifest 指定值即失败。

🔴 **三种 digest 的区分写进了 runbook §3.4**：image ID / config digest 是本链路的身份；
registry manifest digest（`repo@sha256:`）在本链路**不存在**；把前者拼成后者是伪造引用，
解析器以 `manifest_image_tag_digest_forgery` 拒绝。

### 8.1.1 目标 Docker 兼容性：已实测（2026-09-20 结案）

**此前标为"待目标机验证"的那一项成立了，并已修复。** 记录实测事实：

| 项 | 状态 |
| --- | --- |
| 同一 daemon 内 save → load → 身份一致 | ✅ 本机实测 |
| 归档格式（`docker save` OCI + zstd） | ✅ 与 Docker 29 兼容 |
| 目标平台 `linux/amd64` | ✅ 构建输入 + 构建后 + 装载后三处断言；VPS 实测 `x86_64` |
| 目标机 image store 后端 | ✅ **已实测**：`haiyue-vps` = Docker 29.8.1 + `overlayfs` + `io.containerd.snapshotter.v1` |

#### 实测到的差异

| 读数 | 经典 graphdriver（overlay2） | containerd image store |
| --- | --- | --- |
| `docker image inspect .Id` | **config digest** | **OCI manifest digest** |
| `docker image inspect .Descriptor` | **键不存在** | `{mediaType, digest, size}` |
| `docker image inspect .RepoDigests` | `[]` | `[repo@sha256:<manifest digest>]` |
| `docker inspect <容器> .Image` | config digest | manifest digest |
| `docker inspect <容器> .ImageManifestDescriptor` | **键不存在** | 有，且带 `platform` |

🔴 **被证伪的三条既有论断**（原文曾写在本 ADR 与 runbook 中）：

1. ~~"`.Id` 就是 config digest"~~ —— 只在经典 graphdriver 上成立。
2. ~~"`docker save`/`load` 不保留 RepoDigest"~~ —— containerd store 上 `RepoDigests` **非空**，
   填的是本地 OCI manifest digest。它**不是** registry manifest digest（该镜像从未推过任何 registry），
   容易被误读成 registry 引用。
3. ~~"config digest 才跨主机稳定"~~ —— 表述不准。config digest 作为**内容哈希**始终稳定；
   不稳定的是"宿主机用哪个字段把它报出来"。在 containerd store 上 config digest
   **无法**作为镜像引用解析（`docker image inspect sha256:<config>` → `No such image`）。

🔴 **Docker 29 的 dind 默认就是 containerd snapshotter**（实测：不传 flag 即为
`overlayfs + io.containerd.snapshotter.v1`，要经典后端必须显式
`--feature=containerd-snapshotter=false`）。所以这不是边缘配置，而是正在变成默认形态。

#### 修复：身份从归档内容定义，判据按字段能力选

```text
归档 index.json
  └─ 按 image_tag **唯一命中**的 target descriptor   （绝不取 manifests[0]）
      └─（是 index 时再下一跳）linux/amd64 platform manifest
          └─ config descriptor → config blob
```

三个 descriptor（mediaType / digest / size）全部写进 release manifest
（`schemaVersion: 2`，见 §8.1.2），每一个 digest 都按归档内 blob 的**原始字节**复算。

🔴 **被引用的每一个 content descriptor 都验到字节，layer 也不例外。**
layer 不缓冲进内存，而是在同一次流式扫描里边读边 `sha256.update()`，
entry 结束得到实际 digest 再与 `layers[].digest` 核对
（实测：324MB 归档 0.83s→0.87s、RSS 115.2MB→116.7MB）。
另有一条覆盖**全部** blob 的不变式：`blobs/sha256/<hex>` 的 `<hex>` 必须等于该文件的内容哈希，
未被本 tag 引用的 blob 也不放过。

🔴 **不能用"`archive_sha256` 已覆盖"替代逐层复算。** `archive_sha256` 是**传输完整性**——
证明这一份文件在路上没被改动；而伪造者同时控制归档与随行 manifest 时可以把两边一起重算。
descriptor chain 的价值恰恰在于**独立于"是谁把文件递给你的"**。链条验到 config 就停，
等于镜像真正的文件系统内容完全没验：改掉层内若干字节、保持文件名与 size 不变，
在没有逐层复算的实现里会一路绿灯。

消费端按**字段能力**选锚点，不按 Docker 版本号或 storage-driver 字符串猜：

```text
image inspect 有 .Descriptor   → 以 Descriptor 比 target descriptor；冲突即拒绝
image inspect 无 .Descriptor   → .Id 比 config digest
容器有 .ImageManifestDescriptor → 比**选中的平台 manifest**，不是外层 index
容器无该字段                    → .Image 比 config digest
两种情况都另外核对平台与 revision
```

🔴 **禁止**实现成 `actual == manifest_digest || actual == config_digest` 然后放行：
那样一个装着错误镜像、但恰好某个 digest 对上的环境也会通过。字段在场但内容冲突时必须
拒绝，不得回退到另一个 SHA 再试一次。这条有专门的变异测试守着。

### 8.1.2 为什么升到 schemaVersion 2

v1 只有一个 `image_config_digest`，而且那个值是构建机 `docker inspect .Id` 的直接抄录。
在 containerd 构建机上抄下来的其实是 manifest digest —— 字段名说是 config，内容却不是。
**自动给 v1 补字段等于把一个已知错误的值换个名字继续用**，所以 v1 被明确拒绝并提示重建，
不原地升级、不静默降级。v1 工件保留作诊断材料。

### 8.1.3 目标 Compose 兼容性：`run` 没有 `--no-build`（2026-09-21 结案）

**现象。** B2 fresh-init 在 migration 入口失败：

```text
fresh-init → initdb PASS → roles PASS → migrate-approved
  → preprod_compose_app_run → unknown flag: --no-build
```

不是目标机损坏。也**不是** Compose 改了 flag——这一点第一版记错了，必须纠正：
`docker compose run --no-build` **从来就不存在**。实测 `docker/compose-bin` 各版本：

| Compose | `run --no-build` | `run --pull` | `up --no-build` |
| --- | --- | --- | --- |
| v2.24.0 / v2.29.7 / v2.32.0 | 无 | **无** | 有 |
| v2.36.0 / v5.0.1 / v5.5.1 | 无 | 有 | 有 |

这个 flag 在 `e274902`（2026-09-20）被写进 `preprod_compose_app_run`，而当时仓库里
**没有任何测试引用过这两个应用镜像入口**（`git grep preprod_compose_app_run -- tests/`
在 45859da 上为空）。也就是说这条命令行从写下到 B2 那天，**一次都没有被真的执行过**。

所以真正的教训是「one-off 这条路从没真跑过」，而不是「Compose 升级了」。对应的控制
不是"盯版本号"，而是：**脚本发出的每个 flag 必须对着该子命令真实的 `--help` 核过**，
并且这条路径要有真 daemon 的用例。顺带同一个坑的第二处：`--pull` 在 v2.32.0 及更早
也不存在，所以它同样按能力追加，"不 pull"真正承重的是 overlay 的 `pull_policy: never`。

**为什么"删掉那个 flag"不是合格修法。** 实测矩阵（`docker compose` v5.5.1 与
v5.0.1 行为一致，rig 与生产同形状：服务同时带 `image:` 与 `build:`）：

| merged config 里的 build 段 | 本地有批准镜像 | `run --rm --no-deps --pull never` |
| --- | --- | --- |
| 在 | 有 | PASS，不 build 不 pull |
| 在 | **无** | 🔴 **就地 build，exit 0** |
| 无 | 有 | PASS，不 build 不 pull |
| 无 | **无** | FAIL：`No such image`，不 build 不 pull |

也就是说：只要 build 段还在 merged config 里，`--pull never` 挡不住构建；
一旦镜像因为运输/装载问题缺失，目标机会**静默地**跑上一个没被批准、没经过归档
校验、身份与 release manifest 无关的工件，而部署脚本一路绿灯。

**决定。** 不可变工件纪律从 CLI flag 下沉到不依赖 flag 的 merged-config / 本地镜像事实：

1. `infra/preproduction/docker-compose.yml` 用 `build: !reset null` 把
   web / worker / scheduler 的构建源从 **merged config** 里抹掉。目标机上不存在
   构建源，`run` 有没有 `--no-build` 都不再重要。
   - 必须是 `!reset`：普通 `build: null` 覆盖不掉基文件（实测 merged config 里
     build 段仍在）。`!reset` 在 v5.0.1 / v5.5.1 上均已实测生效，且 CPS 短剧的
     生产 overlay 早已用同一语法清空 `ports`。
   - 构建机不受影响：`build-release-archive.sh` 只加载根 compose 构建，从不加载
     本 overlay；根 compose 的 `build:` 原样保留。
   - `!reset` 不改变插值时机：基文件 `build.args` 里的必填变量（`BUILD_DATE` 等）
     仍然必填，本次改动对 env 契约零影响（实测）。
2. `preprod_assert_app_runtime_immutable()` 在**每一次** `up` / `run` 之前 fail
   closed，断言的全是 merged config / 本地镜像的事实，一条都不依赖 flag：
   镜像变量有值 → merged config 没有 build 段（overlay 被漏掉 `-f`、被换掉、被
   降级写法都在这里暴露）→ 渲染后每个跑批准镜像的服务都带 `pull_policy: never`
   → 批准镜像已在本地 → manifest 已加载时再过完整身份比对。这与 CPS 短剧的
   `frozen_image_missing` 预检是同一条不变量（`PRODUCTION_UPDATE_SOP` §15：
   "compose 文件里有 `build:` 段不等于允许构建"）。
   - 拒绝一律走 **stderr**：`verify-release.sh` 把 one-off 的 stdout 整条
     `>/dev/null`，理由若走 stdout，现场就只剩一个裸的非零退出码。
   - 没加载 manifest 时（独立的 `migrate-approved` 恢复路径）只证明了"这个 tag
     在本地存在"，因此显式打 `identity=unverified_no_manifest`，不冒充已核身份。

`--no-build` 与 `--pull never` 退化为锦上添花的第二道，且只在**该子命令的
`--help` 真的有它**时才追加——不支持就不加，契约不因此变松，因为它本来就不靠
flag 站住。

**不选 B 方案（专用 `docker run` one-off runner）的理由。** migration 与
verify-admin-auth 这两个 one-off 需要与正式服务完全一致的 network / user /
workdir / env / secrets / bind mounts。手抄一份 `docker run` 等于再造一套会各自
漂移的运行时，而 A 方案让 one-off 继续复用同一份 merged config，重复度为零。
CPS 短剧那侧的 `docker run --pull never` one-off 是另一类用途（`--network none`
的自包含探针，不需要数据库与 secrets），不构成反例。

**回归锚点。** `tests/backend/runtime/preproduction-compose-oneoff-runner.test.ts`
用真 daemon 跑上表全部四格，并把"脚本发出的每个 flag 必须存在于该子命令真实
`--help`"变成用例——这正是上一轮 CI 缺的那一层。

### 8.2 版本身份漂移

Git tag `v0.2.0` 与 `package.json` 的 `0.1.0` 不一致。本轮不改。生产身份继续依赖
approved commit + config digest + archive SHA256，不依赖人类可读版本号。

> **后续（2026-09-23，Owner 裁决）**：上述版本漂移已于 v0.3.0 统一——`package.json`
> 与环境变量模板的版本号一致。生产身份判定原则不变，仍以 approved commit +
> config digest + archive SHA256 为准。

## 9. 后果

- 发布链不再依赖 GHCR 的可用性与鉴权，也不需要在 VPS 上放 registry 凭据；
- 代价是工件要经 SCP 搬运（数百 MB 级），发布耗时取决于上行带宽；
- 构建主机成为发布链的一环：必须保证构建出的镜像平台与 VPS 一致
  （`build-release-archive.sh` 已加显式平台断言，默认 `linux/amd64`）；
- 两个 CPS 项目的运输方式现在相同，需要本 ADR 一直存在来解释「为什么相同」，
  正如它此前解释「为什么不同」。
