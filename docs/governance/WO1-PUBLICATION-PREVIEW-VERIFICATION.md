# 工单 1 开发验收（待主代理独立 review）

基线 `845ca02ac9351163dd69b0de328b2d8aad1e012f`，分支 `codex/wo1-publication-preview-20260926`。未合并、未上线。设计见 `docs/adr/ADR-PUBLICATION-PREVIEW-ENQUEUE.md`。

## 可复现命令

- `npm run typecheck`：0 错误。
- `npm exec vitest run -- --project node tests/backend/content-creation tests/backend/publish-gate tests/backend/publication tests/backend/tasks/moboreader.test.ts tests/backend/tasks/preview-account-hold.test.ts tests/backend/preview-recovery --reporter=dot`：42 文件、489 用例通过。
- `bash scripts/run-publication-preview-postgres-verification.sh`：12 个真角色用例，完整运行不允许跳过；随机一次性 PostgreSQL 16.14 容器，所有迁移+grants，从不重置已有库。每次退出自动清理。覆盖单篇/旧草稿/重新发布、跨账号/跨应用批量聚合、部分拒绝、意外失败前缀及相同请求重试、重复书、并发重叠、来源别名、新鲜跳过、hold 标记、关闭写闸、SQL 入队故障不回滚发布、web 密文读取被拒绝、实际 worker materialize、50/500 混合负载。
- `bash scripts/run-phase-d-postgres-verification.sh`：4 文件、83 用例通过，含目录扫描收尾零试读任务、手动试读与目标执行、fencing/crash recovery；一次性容器/卷/网络已清理。
- 真库字典检查：53 models / 1,235 records / 1,165 active records，drift=0；没有 schema/grants 改动。
- `python3 scripts/verify-publication-preview-mutations.py`：9 项关键变异，各自必须由断言失败杀死，且逐字节恢复。日志位于 `.tmp/wo1/mutations/`。选定的真库 mutation 使用显式 testNamePattern，完整验收不设置该变量。

全量 backend 另做过探索性运行：4 文件失败（3 项旧运行环境断言/耗时限制，另 1 文件为本次新增查询导致的旧 fake 缺字段，已修正并在 489 相关用例中重新通过）；并行运行另出现 Vitest onTaskUpdate 超时。没有把此运行记为全量通过。旧运行环境项分别要求两个真实 image-store daemon、secret-consumer 全场景在15秒内完成、以及 sandbox 中真实 Docker socket 可用；未为它们改业务代码或既有环境。

## 本地混合负载测量及局限

本地 PostgreSQL、真实 `processOneWorkerCycle` 调度/claim/finalize、真实 preview 与 promo-link-claim handler；两个 handler 均注入本地适配器，禁止网络与真实上游调用。每次本地读取人工等待 2ms。先成功处理同一领取任务的 5 个条目，保留后续领取条目，随后通过真实发布服务排试读并继续实际 worker 周期。N=500 采用 200+200+100 三次合法发布，未放宽 200 上限。

这是确定性的队列插队模拟：测试驱动器在同步发布操作期间不驱动 worker，之后恢复单 worker 周期；不模拟 web 与 worker 同时执行的时间重叠，也不模拟真实网络或主机限流。报告单列“发布耗时”与“入队完成后的领取等待”，不可把二者混称纯调度延迟。

| N | 基线领取吞吐(条/秒) | 发布耗时 | 试读 worker 总耗时 | 入队完成后至下一条领取完成 | 发布开始至试读全完成 |
|---|---:|---:|---:|---:|---:|
| 50 | 39.10 | 0.396s | 1.491s | 1.516s | 1.887s |
| 500 | 54.12 | 3.611s | 25.698s | 25.759s | 29.309s |

以上为最终完整验收的一次测量，受本地其他测试负载影响，不是稳定容量基线。试读条目持续可领期间，两档领取吞吐均为 0，下降 100%；这证实了现有 channel_sync 绝对优先，绝非新的公平性保证。测试断言试读全部成功后领取才增加第六条，且真实 worker 已写出章节。

独立于上述模拟，若生产每本试读至少两次调用、共享限速间隔 1,500ms、单 worker 顺序处理且无其他额外延迟，则调用槽预算约为 `N×2×1.5s`：50 本约 150s（2.5分钟），500 本约 1,500s（25分钟）。这是间隔预算推算，不是上游时延实测；请求耗时、重试、额外调用、已有积压会延长等待。建议首次运营每批最多 50 本、批间等待试读队列消退；现行接口上限仍是 200，由 Owner 决定是否进一步限流。

## 风险及运维

- 现有调度优先级未改；清旧积压不消除未来新试读插队。没有开任何真实白名单/写闸。
- 发布成功到试读入队存在进程崩溃窗口；本工单按批准的 best-effort 连带动作执行，失败查脱敏日志并手工补建，不宣称事务性 outbox。
- 持续在途（含暂停/禁用）任务会阻止同一本书新任务，避免积压重复；运营必须先处理旧积压。
- 无真实上游调用、无线上主机访问、无 PR/合并/部署。上线前步骤及人工补偿见 ADR。
