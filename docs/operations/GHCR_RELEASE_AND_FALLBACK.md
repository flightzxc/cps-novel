# GHCR 发布与 fallback Runbook

> 决策依据：`docs/adr/ADR-DEPLOYMENT-ARTIFACT-DISTRIBUTION.md`
> 构建契约：`scripts/preproduction/build-release-artifact.sh`（Phase 2B 既有）
> 工作流：`.github/workflows/ghcr-release.yml`
> 建立日期：2026-09-20

## 0. 这份 runbook 不做什么

本文件只覆盖「把一个 Owner 批准的 commit 变成 GHCR 上的不可变工件」。

🔴 **不覆盖、也不授权**：SSH 到 haiyue-vps、VPS 上 `docker login`、创建 VPS 侧 GHCR
token、VPS 拉取镜像、`docker up/restart`、Nginx、Certbot、PostgreSQL、migration、
生产/预生产密钥、DNS/TLS、公网流量切换。这些属于 Phase 2C 部署工单。

## 1. 正常发布

### 1.1 前置

- 拿到 Owner 批准的 **40-hex** commit（短码不接受，工作流会直接拒绝）；
- 该 commit 必须已经推到远端，否则 checkout 取不到；
- 首次发布后按 §3 实际核对一次 package 可见性（**首次发布必看**）。

### 1.2 触发

GitHub → Actions → **GHCR release** → Run workflow：

| 输入 | 值 |
| --- | --- |
| `approved_commit` | Owner 批准的完整 40-hex SHA |
| `publish` | `dry-run`（只构建校验）或 `push`（真正推送） |

先用 `dry-run` 跑一次是推荐做法：它会完整构建并打标签，只是不推送。

### 1.3 工作流内部做了什么

```text
校验 approved_commit 形状（40-hex）
  → checkout 该 commit（不是分支 HEAD）
  → 确认 checkout 出来的就是它，且工作区干净
  → （publish=push 时）用 GITHUB_TOKEN 登录 ghcr.io
  → scripts/preproduction/build-release-artifact.sh [--push]
      内部：再次校验 commit/HEAD/干净度
            → 复用 scripts/lib/p1-12-local-env.sh 派生镜像身份
            → docker compose build web
            → tag 成 $REGISTRY_IMAGE:$APP_VERSION-$SHORT
            → push（若 --push）
            → 从 RepoDigests 取 repo@sha256，取不到就拒绝
            → 写 release manifest 到 .tmp/preproduction-release/<commit>.json
  → 按 digest 拉回来，核对 org.opencontainers.image.revision == approved commit
```

🔴 **不要绕过这个脚本自己写一套 build**。脚本里的四条拒绝
（`commit_shape` / `registry_image_shape` / `unapproved_head` / `dirty_checkout`）
是「发布只认批准过的 commit」这条纪律的实现，绕过去就等于关掉它。
工作流的 `contract` job 会在这些拒绝路径失效时变红。

### 1.4 验收（缺一不可）

| 项 | 判据 |
| --- | --- |
| 构建 | `RELEASE_BUILD=PASS` |
| manifest | `RELEASE_MANIFEST=` 指向的文件存在，`commit` 与批准的一致 |
| digest 形状 | `image` 匹配 `^.+@sha256:[0-9a-f]{64}$` |
| pull-by-digest | `docker pull <digest>` 成功 |
| revision 标签 | `org.opencontainers.image.revision` == approved commit |
| package 关联 | GHCR 上该 package 关联到 `flightzxc/cps-novel` |
| package 可见性 | 见 §3 |

> `dry-run` 模式下脚本会以 `reason=immutable_registry_digest_missing` 退出 65 —— 这是
> **预期**：没推送就没有 registry digest。工作流据此判定「构建成功、只差推送」，
> 不伪造 digest，也不把它当失败。

## 2. 🔴 失败预算：最多两次

GHCR 不允许无限排障。

### Attempt 1 失败 → 只诊断

允许查：`GITHUB_TOKEN` 权限、package/repository 关联、镜像命名空间、
workflow 配置、registry/网络响应。

若找到**明确、低风险、确定性**的原因，可以修一次，然后进入 Attempt 2。

### Attempt 2 仍失败 → 停

若失败仍属于 auth / GHCR package 权限 / registry 连通性 / push-pull 可靠性，
且没有明确低风险修复：

```text
STOP GHCR
FALLBACK_REQUIRED=YES
```

🔴 **不得用以下方式硬顶**：扩大 token scope、把 package 改成 public、
动用 repository admin、放松仓库安全设置、修改 VPS SSH/安全配置。

命中 `FALLBACK_REQUIRED=YES` 后**另开小工单**走 §4，不要在 GHCR 工单里顺手实现第二套 pipeline。

## 3. package 可见性（首次发布必读）

本仓库是 **public**，但**这不会让 package 变成 public**。GitHub 官方文档两句：

> the package automatically inherits the access permissions **(but not the visibility)**
> of the linked repository
> —— *Configuring a package's access control and visibility*
>
> When you first publish a package, the default visibility is **private**.
> —— *Working with the Container registry*

package 继承的是**访问权限**（谁能读写），不是**可见性**（是否匿名可拉）。
首次发布默认 private。所以「仓库 public → package 必然 public」是错误推论。

> 2026-09-20 本 runbook 初版曾写反过这一点，把它当成需要 Owner 裁决的阻塞项。
> 查官方文档后更正。留着这条记录，是为了让后来的人知道这里曾经被判断错过一次。

### 🔴 仍然必须实际核对

文档说的是**默认值**，不是保证。组织策略、别人后来的手动改动，都可能让默认值不成立。
每次首次发布后核对一次：

- GitHub → 你的头像 → Packages → `cps-novel` → 右侧应显示 **Private**；
- 或在 package settings 里确认 "Danger Zone → Change visibility" 当前是 Private；
- 也可匿名验证：未登录状态 `docker pull ghcr.io/flightzxc/cps-novel@sha256:...`
  应当失败（public package 允许匿名拉取）。

若核对发现是 **public**：这不是"按预期"，要停下来报告 Owner。
🔴 **不得**为了让流程继续而把它留在 public，也不得用扩权方式绕过。

> 注：`gh` CLI 的本地 token 若缺 `read:packages` scope，`gh api user/packages` 会返回 403。
> 核对请走 GitHub UI，或换一个带 `read:packages` 的 token。

## 4. Fallback：CPS 短剧形态的离线不可变归档运输

**本轮只记录，不实现。** 命中 `FALLBACK_REQUIRED=YES` 后另开工单。

```text
approved commit
  → 构建不可变镜像（同一套 build contract，不另起炉灶）
  → docker save
  → 归档 / 压缩
  → 生成 SHA256 manifest
  → SCP/SSH → haiyue-vps
  → 在 VPS 上校验 SHA256
  → docker load
  → 核对 image/config digest 与 org.opencontainers.image.revision 标签
```

fallback 的身份**至少**包含四项，缺一不可：

1. Owner 批准的 Git commit；
2. 归档文件的 SHA256；
3. Docker image / config digest；
4. `org.opencontainers.image.revision` 标签。

🔴 **禁止退化成**：`git pull main` / VPS 上临时 build / `latest` tag。
这三种都让「线上跑的是哪个 commit」不可事前批准、不可事后核对。

## 5. 已知环境约束

- **Docker Hub 在部分本机网络不可达**（实测 `auth.docker.io` i/o timeout）。
  BuildKit 不读本地镜像库、`FROM` 一律经 registry，因此本机构建时需要通过
  `docker-compose.yml` 既有的 `P1_12_NODE_BASE_IMAGE` 覆盖点指向一个可达的
  registry 副本。GitHub Actions runner 不受此限制，无需该覆盖。
  覆盖前必须核对副本与 Dockerfile 固定 digest 的 config digest 一致。
- **版本身份漂移**：Git tag `v0.2.0` 与 `package.json` 的 `0.1.0` 不一致。
  发布身份以 commit + digest 为准，不要用 `0.1.0-*` 这个可变 tag 当身份。
  彻底解决属 Phase 2C，见 `ADR-PREPRODUCTION-MAINTENANCE-DEPLOYMENT` 的 Consequences。
