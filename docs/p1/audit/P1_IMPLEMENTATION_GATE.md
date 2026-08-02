# P1-03 · 正式编程 Gate

> 当前 Gate：**Architecture Contract Gate = CLOSED**  
> Claude 正式编程授权：**否**  
> Codex 正式编程授权：**否**  
> 本轮允许：需求/架构/契约/测试计划修订与只读证据  
> 本轮禁止：前端、后端、数据库、Worker、Scheduler、Adapter、仓库骨架与基础设施正式实现

## 1. 当前判定

当前输入足以完成独立审计，也足以给出可执行修订要求；无需等待更多材料才能定性。但冻结需求、正式任务台账、candidate 和 Claude P1 包之间存在直接冲突，关键并发/权限/事务合同尚未冻结。

本 Gate 立即生效：

- Claude 不得开始用户端、后台 UI、设计系统或共享组件正式编码；
- Codex 不得开始 Prisma、Migration、Auth、Credential、Worker、Scheduler、Adapter、Docker、备份或部署正式编码；
- 双方不得以“骨架”“占位”“先写后改”为由创建会被后续实现依赖的临时合同；
- 不得修改 CPS；
- 不得改写 candidate-v0.2.1 或 Claude 原始六文件来消除审计证据。

## 2. 三阶段 Gate，避免循环依赖

### Stage A · Architecture Contract Gate（当前）

目标：冻结需求快照、正式任务映射、ownership、状态机、物理 Schema specification、SQL/事务伪合同、权限矩阵和测试计划。

本阶段不要求可执行 Schema、Worker、Auth、CI fixture 或并发测试结果。R-01～R-24 全部达到“架构合同级关闭”，并经新的独立 SOL 5.6 审计给出通过结论后，才允许进入 Stage B。

### Stage B · Foundation + Safe UI Verification Gate（仅在 Stage A 通过后）

在 R-02 冻结正式任务映射后，按能力范围和已批准依赖图有限放行：

- 正式仓库与共享契约骨架；
- PostgreSQL Schema/Migration/ACL；
- Worker claim/lease/fencing 与 Scheduler；
- Auth/API default-deny、Credential executor；
- SQLite 残留 CI、并发/负向/迁移/恢复测试。
- Claude 的 public UI、设计 token 与阅读器基础交互可按冻结后的正式依赖图与后端轨并行，只能消费已冻结合同或 mocks；
- admin UI 必须等待 Auth/API foundation 达到其正式依赖，除非 Weifeng 先批准修改台账依赖；任何 UI 都不得绕过未验证 mutation、启用 Adapter 或触发外部副作用。

该阶段取得真实 SQL、并发、ACL、CI、UI contract/visual 和恢复证据。未通过前，不允许集成或启用业务 Adapter、外部副作用能力、批量发布和生产数据路径。

### Stage C · Integration / Business Effect Gate

只有 Stage B 的基础不变量被执行证据验证后，才允许把 UI 接到真实 mutation/数据路径、实现已被正式分配的业务 Worker handler/外部副作用，并进入集成阶段。当前正式 P1 台账没有明确 Adapter 实现任务、Owner 与写入路径，因此 Adapter 必须保持 `UNPROVEN/registered_disabled`，直到 Weifeng 新增正式任务或明确归属；具体任务 ID 以 R-02 关闭后的正式映射为准。

## 3. Stage A 当前矩阵

| Gate ID | Architecture Contract 条件 | 对应修订 | 当前状态 | 设计级关闭证据 |
| --- | --- | --- | --- | --- |
| G-A01 | 冻结基线可复现 | R-01 | 未满足 | 冻结页、P1 台账、四库规范化快照、SHA-256、Owner 批准 |
| G-A02 | 冲突/任务编号/状态已对账 | R-02 | 未满足 | P1-03 等正式任务映射、supersedes、零未解释冲突 |
| G-A03 | 正式仓库身份与物理隔离合同 | R-03 | 部分满足 | canonical target/remote reservation、preflight 设计、shadow-repo 处置、CPS clean；实际建仓归 Stage B |
| G-A04 | 一个路径一个写 Owner | R-04 | 未满足 | 与冻结基线及 P1 台账一致的 ownership/CODEOWNERS 设计 |
| G-A05 | 已证内部跨侧合同可生成且冻结 | R-05 | 未满足 | DTO/enums/errors/version/transaction 真源；未证外部合同 disabled |
| G-A06 | Worker fencing 事务不变量 | R-06 | 未满足 | DB 时钟、token/generation、同事务跨表 guard、故障注入测试计划 |
| G-A07 | Scheduler 确定时间与原子 enqueue | R-07 | 未满足 | `scheduled_for`、revision/DST、CronRun↔Task、misfire/catch-up 合同 |
| G-A08 | 全部状态机统一 | R-08 | 未满足 | expected state/revision、actor/reason、active predicate、UI/DB/Worker 真源 |
| G-A09 | 外部 effect 与本地 audit 分离 | R-09 | 未满足 | 永久 effect key、attempt fingerprint、intent/outcome/unknown/reconcile 合同 |
| G-A10 | AuthN/AuthZ 默认拒绝 | R-10 | 未满足 | 页面/API/action/service 四层矩阵、internal identity、负向测试计划 |
| G-A11 | Credential 可部署拓扑 | R-11、R-16 | 未满足 | 独立 credential executor、角色/连接池/secret 分发、crypto/rotation 合同 |
| G-A12 | 物理 Schema 无歧义 | R-12 | 未满足 | PG 类型/约束/FK/索引/ACL/SQL migration 权威与 drift 计划 |
| G-A13 | PG 角色/迁移/恢复设计正确 | R-13～R-15 | 未满足 | 完整角色图、默认 ACL、单一迁移协调、physical PITR 计划 |
| G-A14 | 永久短码与 scope 并发安全 | R-17、R-18 | 未满足 | tombstone/硬删禁令/collation/retry；持久 membership/exclusion |
| G-A15 | 写闸门分类闭合 | R-19 | 未满足 | 产品 mutation、外部 effect、安全基础写三类注册表 |
| G-A16 | 后台/public/theme 合同完整 | R-20～R-22 | 未满足 | parity/人工处置、public read/health/sitemap、完整 reader 基线 |
| G-A17 | SQLite 门禁与 CPS 偏离可追踪 | R-23、R-24 | 未满足 | CI 规则/fixture 计划；原子分类；A→R→G→证据映射 |
| G-A18 | 新一轮独立审计 | R-01～R-24 | 未满足 | SOL 5.6 三视角复审；Owner/Reviewer 为真实不同执行体 |

## 4. Stage B 验证矩阵（本轮不执行）

| Gate ID | Foundation 执行证据 | 前置 |
| --- | --- | --- |
| G-F01 | canonical repo/remote/branch/worktree 校验成功；无 CPS symlink/path dependency；隔离资源命名可检 | G-A03 |
| G-F02 | Migration 集成测试证明部分唯一/CHECK/ACL/view/function 未被 Prisma 漂移；生产禁用 db push | G-A12/G-A13 |
| G-F03 | 多 Worker 故障注入证明过期 fence 不能提交受保护写；side-effect outcome 仍可安全补录 | G-A06/G-A09 |
| G-F04 | 10 Scheduler 并发、事务失败、DST/misfire/catch-up 测试通过 | G-A07 |
| G-F05 | 页面/API/action/service AuthN/AuthZ 负向测试；capability 撤销与延迟任务策略验证 | G-A10 |
| G-F06 | Web/Scheduler 无密文 SELECT/解密 key；credential executor、轮换、host allowlist、日志脱敏验证 | G-A11 |
| G-F07 | SQLite 残留 CI fixtures 和合法 PG 对照通过 | G-A17 |
| G-F08 | 备份/WAL/restore 配置与一次 disposable 最小恢复 smoke test；完整定时 PITR/RPO/RTO 演练留给集成后的正式恢复任务 | G-A13 |
| G-F09 | Public/reader contract 与 visual tests；admin UI 在 Auth/API 前置满足后验证；各 UI 能力按冻结依赖图完成 | G-A16 |

Stage B 未完成不影响本次 REVISE 的可判定性，但会阻止 Stage C。完整 PITR、RPO/RTO、globals/约束/业务不变量/key 恢复演练在集成完成后的正式恢复任务执行，并在最终审计前关闭，避免与集成形成循环。

## 5. 本轮允许的动作

只允许：

- 读取 CPS、candidate、Claude 六文件、冻结基线、正式台账和事实库；
- 新建版本化需求快照、冲突对账、ADR、状态机、权限矩阵、物理 Schema specification、接口合同和测试计划；
- 新建 candidate 下一版本和 Claude P1 修订版，保留 supersedes/changelog；
- 声明 canonical target/remote、设计 repo preflight/ownership/CODEOWNERS，不实际创建正式工程骨架；
- 请求 Weifeng 对产品/风险未决项作可追溯裁决；
- 进行不写生产系统、不触发上游副作用的只读审计验证。

这些动作不是正式编程授权。

## 6. 本轮禁止的动作

禁止：

- 初始化或创建正式应用仓库骨架；
- 创建或修改正式 Prisma Schema/Migration；
- 实现 Worker、Scheduler、Adapter、Auth、Credential 服务；
- 创建正式 API、Server Action、后台或前台页面；
- 创建正式 Docker/Compose/CI/CD/备份脚本或测试 fixture；
- 启动或迁移正式/预生产数据库；
- 调用任何有副作用的渠道接口；
- 写入 CPS、在 CPS 建分支或临时文件；
- 把 candidate/UNPROVEN 状态直接写成已确认；
- 让 Claude 审计自己的修订，或让 Codex 在复审前改写总体架构后直接开工。

## 7. Stage A 二次审计最小输入

二次 SOL 5.6 审计请求必须一次性提供：

1. 新 candidate 版本目录与 changelog；
2. Claude 六份修订版或逐文件审计响应；
3. R-01～R-24 的架构合同级关闭证据索引；
4. 冻结基线、正式 P1 台账、四库规范化快照和可追溯 Owner 批准；
5. 所有输入 SHA-256 与规范化说明；
6. canonical target/remote reservation 和 repo preflight 设计；
7. CPS before/after HEAD、status 和关键路径哈希；
8. ownership/CODEOWNERS 设计；
9. 共享合同与状态机单一真源；
10. PG/Worker/Scheduler/Auth/Credential/Schema/backup 的设计级验收矩阵；
11. 未决项清单，明确 Product Owner、disabled path 和后续 Gate；
12. 声明本阶段仍无正式业务实现。

缺任一项，Stage A 保持关闭。

## 8. 权限与 Gate 转换

- SOL 5.6 独立审计负责给出审计结论；
- GPT+Notion 负责记录 Gate 与证据状态，不替代 Product Owner 作产品/风险裁决；
- Weifeng 负责 D/W 类产品、品牌、展示和风险接受裁决；
- Claude/Codex 只在各自所有权内修订方案；Reviewer 必须是不同执行体；
- 只有一次新的独立 SOL 5.6 审计通过，才可从 Stage A 进入 Stage B；
- Stage B 必须以执行证据关闭，才可进入 Stage C；
- 任何 CPS 污染、基线冲突、FROZEN 漂移、ownership 重叠或审计前业务实现都会使 Gate 保持或重新变为关闭。

当前不得开始 P1 正式编程。

RESULT=P1_SOL56_ARCHITECTURE_AUDIT_REVISE
