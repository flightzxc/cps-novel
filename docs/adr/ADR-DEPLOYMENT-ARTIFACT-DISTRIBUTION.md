# ADR-DEPLOYMENT-ARTIFACT-DISTRIBUTION · 部署工件的运输方式

```text
ADR_ID              = DEPLOYMENT-ARTIFACT-DISTRIBUTION
DECISION_STATUS     = ACCEPTED
DECISION_DATE       = 2026-09-20
DECIDED_BY          = Owner（GHCR Bootstrap 工单）
SCOPE               = cps-novel（CPS 海阅）的部署工件运输；并记录 CPS 短剧的现状以作对照
BUILDS_ON           = ADR-PREPRODUCTION-MAINTENANCE-DEPLOYMENT（Phase 2B）
IMPLEMENTED_BY      = .github/workflows/ghcr-release.yml
                      scripts/preproduction/build-release-artifact.sh（Phase 2B 既有，本轮未改）
RUNBOOK             = docs/operations/GHCR_RELEASE_AND_FALLBACK.md
```

## 1. 决定

**两个 CPS 项目使用不同的部署工件运输方式，这是刻意的，不是遗留不一致。**

### CPS 短剧（参照项目）

```text
Primary artifact transport:
  approved commit → 构建不可变镜像 → docker save → 归档 → SHA256
  → SSH/SCP → docker load
```

### CPS 海阅（cps-novel，本仓）

```text
Primary artifact transport:
  Owner-approved 40-hex commit
    → GitHub Actions（.github/workflows/ghcr-release.yml）
    → 仓库既有 Docker build contract
    → ghcr.io/flightzxc/cps-novel
    → 不可变 repo@sha256 digest
    → release manifest
    → Phase 2C VPS pull-by-digest
```

### CPS 海阅的 fallback

```text
Fallback artifact transport（仅在 FALLBACK_REQUIRED=YES 时启用）:
  与 CPS 短剧同形态的离线不可变归档运输
```

## 2. 🔴 给未来的 Claude / Codex / Cursor / Luna

**不得仅仅为了「两个 CPS 项目统一」，就把其中一个项目的 artifact transport
擅自切换成另一个项目的那套。**

这条差异是经过决策的结果，不是没人来得及统一。看到两个项目运输方式不同时，
正确反应是读本 ADR，而不是提一个「对齐」的重构。要改，必须有 Owner 的新决策，
并在本 ADR 追加一条记录。

## 3. 为什么不同

**CPS 短剧不动**：它已经有一条成熟稳定的 archive 发布链在生产上跑着。
为了形式统一去重构一条正在服务生产流量的发布流程，收益是审美上的，风险是真实的。

**cps-novel 走 GHCR**：它是新建的部署体系，Phase 2B 已经围绕 **registry digest**
建立了 release manifest 与身份契约——`ADR-PREPRODUCTION-MAINTENANCE-DEPLOYMENT`
写明「发布工件的权威身份只有 approved 40-hex commit + registry `repo@sha256:...`」，
`build-release-artifact.sh` 在拿不到 `repo@sha256` 时直接拒绝
（`reason=immutable_registry_digest_missing`）。这套契约本来就以 registry 为前提，
GHCR 是与之最贴合的运输方式，而不是额外引入的一层。

换句话说：短剧是「已有成熟链路，不重构」；海阅是「新链路，从一开始就按 digest 设计」。

## 4. 不可变身份

两条路线都只认不可变身份，可变 tag 一律不构成发布身份。

**GHCR 路线（primary）** 的身份至少包含：

- Owner 批准的 40-hex Git commit；
- `ghcr.io/flightzxc/cps-novel@sha256:...`；
- 镜像标签 `org.opencontainers.image.revision`，必须等于该 commit；
- release manifest（`.tmp/preproduction-release/<commit>.json`）里 commit 与 digest 一致。

**归档 fallback 路线** 的身份至少包含：

- Owner 批准的 40-hex Git commit；
- 归档文件的 SHA256；
- Docker image / config digest；
- `org.opencontainers.image.revision` 标签。

🔴 **两条路线都禁止退化成**：

```text
git pull main            # 运输的是源码不是工件，且 main 不是批准过的 commit
VPS 上临时 build         # 产物不可重现，身份无法事前批准
latest tag               # 可变引用，不构成身份
```

## 5. fallback 的触发与边界

fallback **只记录，不在本轮实现**。真正命中 `FALLBACK_REQUIRED=YES` 之后另开小工单。

触发条件（见 runbook 的失败预算一节）：GHCR 连续两次尝试失败，且失败原因属于
auth / package 权限 / registry 连通性 / push-pull 可靠性，并且没有明确、低风险、
确定性的修复。

🔴 **不得用以下方式硬顶过去**：扩大 token scope、把 package 改成 public、
动用 repository admin、放松仓库安全设置、修改 VPS SSH/安全配置。
这些都不是"修好了"，是把问题换成了一个更难发现的问题。

## 6. 权限姿态

发布工作流只用 `GITHUB_TOKEN`，**不为 CI 创建 PAT**。权限最小化：

```yaml
permissions:
  contents: read      # 文件顶层默认
# packages: write 只加在真正推送的那个 job 上
```

本仓库 Actions 的默认 `GITHUB_TOKEN` 权限是 `read`；job 级显式声明覆盖该默认值。

## 7. 未决项（Owner）

### 7.1 package 可见性（已澄清，非冲突）

本仓库是 **public**，但 package 不会因此变成 public。GitHub 官方文档：

> the package automatically inherits the access permissions **(but not the visibility)**
> of the linked repository
>
> When you first publish a package, the default visibility is **private**.

package 继承的是**访问权限**而非可见性；首次发布默认 **private**。
因此「仓库 public → package 必然 public」是错误推论，与「package 保持 private」不冲突。

🔴 但这只是**默认值**。推送后必须实际核对一次可见性，不要只凭文档断言——
组织策略、后来的手动改动都可能让默认值不成立。核对方式见 runbook §3。

### 7.2 版本身份漂移

Git tag `v0.2.0` 与 `package.json` 的 `0.1.0` 不一致。Phase 2B 已记录该漂移并
声明「commit 与 digest 才是权威」（`build-release-artifact.sh` 把这句话写进了
manifest 的 `versionIdentityIssue` 字段）。Phase 2C 必须在使用人类可读版本号作为
发布策略之前解决它。本 ADR 不解决。

## 8. 后果

- 海阅的发布从此有一个可被下游按 digest 消费的不可变工件，VPS 侧是 pull-by-digest，
  不再需要把镜像通过 SSH 搬过去；
- 代价是发布链多了一个外部依赖（GHCR 的可用性与鉴权），这正是要保留 fallback 的原因；
- 两个 CPS 项目的运输方式长期不同，需要本 ADR 一直存在来解释这件事。
