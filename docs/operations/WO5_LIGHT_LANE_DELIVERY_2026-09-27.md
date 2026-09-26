# 工单 5 交付：轻量通道与周期扫描

状态：已实现、待复核与发布。未合并、未开 PR、未推送、未发版，未操作部署主机。

## Git 与环境

- 分支：`feat/worker-light-lane-and-schedules`。
- 实现提交：`d502504`（与验收/变异检查点 `b33af0b` 代码树相同，仅提交 trailers 排版修正）；交付 HEAD 以最终回复和 `git rev-parse HEAD` 为准（证据文档另有提交）。
- 工作目录：`/Users/chenweifeng/Documents/cps海阅/wo5-light-lane`。
- 先 fetch 后 ls-remote，远端 `integration/v0.4.5-2026-09-26` 返回 `bdf2d42add2084473d2aa325c8696c934f28cfd8`；`merge-base --is-ancestor 69765e1 origin/integration/v0.4.5-2026-09-26` 成功。按工单从 `69765e1` 创建分支。
- 应用 worktree 工具返回当前聊天目录不是 Git 仓库，使用仓库原生 worktree 命令创建上述独立目录。
- 指定 `sol6-wo1-publication-preview` 的 lockfile SHA-1 为 `37af0790b0d34a89cb2f9bd1d192df5749eb3ff7`，与本单 `0977d56ef89920fe44dc41a39d5e1089d2180afc` 不同，未链接。联网安装缓慢，终止本任务安装进程后，从同哈希的 `release-v0.4.5` 复制独立 node_modules；安装记录逐包版本比对差异为 0，并在本单副本重新生成 Prisma Client。未改源依赖目录。
- [改动文件清单](evidence/wo5-2026-09-27/changed-files.txt)。

## 行为与接口

`worker-light` 复用现有 worker 入口、镜像、worker_app 角色、健康检查、告警配置和 sitemap 共享卷。首版只消费 `sitemap_refresh,sitemap.daily_fallback.v1,home_carousel.compute.v1`。配置策略由 `src/lib/tasks/worker-lanes.mjs` 单点提供，TypeScript 启动入口和 preflight 共用；AST 守卫通过 TypeScript 符号解析追踪 adapter 的导入及转导出。

`buildPeriodicSweepSchedule` 支持每分钟及指定时区的每日扫描。`ScheduledTaskInput.periodicSweep` 开启当前分钟校验与按任务类型在途合并；返回值新增 `skipped` / `skipReason`。生产 tick 从 PostgreSQL 读取时钟，取得 advisory lock 后再次核对时间窗口，错过不补跑；同桶唯一键保留。已有首页轮播和领取分片放行逻辑不改。

新增迁移 `20260926150000_periodic_sweep_skip_reason`：schedule_run.skip_reason 为可空 varchar(96)，持久化 `previous_scan_in_flight` / `misfire_skip`。现有 scheduler_app 表级授权覆盖新增字段及读写，grants 注明用途；真实角色验证和字典检查通过，不增加凭据权限。

每日东京时间 04:00 入队 `sitemap.daily_fallback.v1`。scheduler 只持有执行即报错的占位 handler；实际 handler 在受围栏保护的事务内调用现有 `enqueueSitemapRefresh(reason=daily_fallback)`。任一 sitemap 闸关闭时返回成功并记录“写闸关闭、跳过”。

`infra/local-x8` 没有独立 compose，X8 使用根配置和 production-like 覆盖层。本单同步其分级白名单、七服务清单、四个应用服务的健康等待与身份检查；新增 worker-light 不健康时不得提升 release identity 的用例。

## 全部任务的上游核实表

下表“上游”特指 MoboReader。分类任务、文章生成和控制任务的入队不等于调用上游。依据为实现提交中的行号。

| 任务类型 | MoboReader | 本单归属/状态 | 依据 |
|---|---|---|---|
| catalog_scan | 是 | main | worker/handlers/moboreader.ts:1325、1716，构造 adapter 和 rate gate |
| moboreader.preview_refresh.v1 | 是 | main（仅已批准配置消费） | worker/handlers/moboreader.ts:1592、1723 |
| promo_link.claim.v1 | 是 | main | worker/handlers/promo-link-claim.ts:1055、1175 |
| credential.validate.v1 | 否 | main | worker/handlers/credential.ts:26–35、95，本地解密/JWT 校验 |
| credential.supersede.v1 | 否 | main | worker/handlers/credential.ts:63–96，本地数据库事务 |
| batch.materialize.v1 | 否 | main | worker/handlers/catalog-batch.ts:359、544、610、693，枚举并创建子任务 |
| novel.materialize.v1 | 否 | main | worker/handlers/novel-materialize.ts:30–52，本地建书 |
| content.create.v1 | 否 | main | worker/handlers/content-create.ts:12–38，旧协议处理 |
| article.generate.v1 | 否 | main，暂不迁移 | worker/handlers/article-generate.ts:38、55；src/server/content-creation/generate.ts:167–297 |
| article.generate.batch.v1 | 否 | main，暂不迁移 | worker/handlers/article-generate-batch.ts:141–246、264，事务枚举与子任务 |
| article.generate.batch.v2 | 否 | main，暂不迁移 | worker/handlers/article-generate-batch.ts:141–246、265 |
| tagging.auto_classify | 否 | main（保持原有闸门） | worker/handlers/novel-tag-backfill.ts:42–135，本地分类 |
| home_carousel.compute.v1 | 否 | light | worker/handlers/home-carousel.ts:17–44，本地候选/展示表计算 |
| sitemap_refresh | 否 | light | worker/handlers/sitemap-refresh.ts:101–181，查库生成静态文件 |
| sitemap.daily_fallback.v1 | 否 | light | worker/handlers/sitemap-daily-fallback.ts:7–21，仅调用合并入队接口 |
| indexnow_delivery | 否（调用 IndexNow） | 保持关闭，留工单 6 | worker/handlers/indexnow-delivery.ts:149–237 |

上游集合只包含表中前三项；未将“不调用 MoboReader”等同于“允许进入轻量通道”。

### 文章生成保留原因

同小说 `FOR UPDATE` 锁已存在（generate.ts:116）；批次使用 RepeatableRead，子任务 token 按 parent/cursor 派生（article-generate-batch.ts:107、141、213）；worker 的 protectedWrite 与任务计数受租约围栏和事务保护。

但不同小说同名 slug 仍是查询后插入（generate.ts:212、250），没有跨小说的 slug 分配锁；通用数据库重试不把唯一冲突当瞬态错误。现有唯一索引能阻止重复行，不足以证明并发生成都能顺利完成。因此按工单约定三类保留 main，交 Owner 后续决定；本单未修改该链路。

## 验证结果

最终全量测试 **6,789 passed、0 failed、347 skipped**；无 Unhandled Error。typecheck 及生产构建通过。

见 [门禁命令与尾行](evidence/wo5-2026-09-27/verification.md) 和 [变异记录](evidence/wo5-2026-09-27/mutations.md)。

压力场景使用 PostgreSQL 16.14 和两个独立 OS 子进程运行真实 `runWorker`/store；领取业务负载用本地 HTTP 服务替代，每请求 200 ms，未调用真实 MoboReader。sitemap 使用真实 handler、数据库中的已发布文章和实际文件生成。主队列 20,000 条：等待 **17 ms**，执行 **73 ms**，总计 **90 ms**，轮询间隔 1,000 ms；完成时主队列剩余 19,999 条。此数据证明调度隔离，不是生产 sitemap 全量生成耗时预测。

真实库套件：本单 10 项、sitemap 11 项、phase-d 83 项、release 18 项全部通过。本单验证 scheduler_app 无权读取 encrypted_secret；错误 worker ID 无权续租/提交，过期回收只处理自己白名单，回收后旧 lease 被围栏拒绝，新 ID 获得更高 epoch。现有失败告警保留 workerId，两个进程各自拥有 webhook cooldown。

六个反证均变红并逐字恢复：四项指定变异，加 scheduler 直接刷新和新增上游 handler 漏登记。每项恢复后 `git diff --quiet=0` 且 status 为空。

三套 compose 渲染均成功；以下为无真实秘密的测试变量渲染片段，完整 worker-light 配置已留存：

- [根 compose](evidence/wo5-2026-09-27/compose-root-worker-light.json)
- [预生产合并配置](evidence/wo5-2026-09-27/compose-preproduction-worker-light.json)
- [production-like 合并配置](evidence/wo5-2026-09-27/compose-production-like-worker-light.json)

渲染契约逐项比对两个 worker 的 image、command、healthcheck、logging、secrets、volumes、stop_grace_period，以及除身份/通道/白名单以外的全部环境变量。预生产 worker-light 的 build 已清除、pull_policy=never。

## 发布时才需执行的 env 变更

本单未对主机执行以下动作。

```dotenv
WORKER_LANE=main
WORKER_LIGHT_ID=cps-novel-preprod-worker-light-1
WORKER_LIGHT_TASK_ALLOWLIST=sitemap_refresh,sitemap.daily_fallback.v1,home_carousel.compute.v1
```

保留现有 `WORKER_ID=cps-novel-preprod-worker-1`。从主 `WORKER_TASK_ALLOWLIST` 移出 **sitemap_refresh、home_carousel.compute.v1**；三种 article.generate 任务和原有其它批准项保留，尤其不要覆盖主机已有的试读白名单配置。新增轻量 ID 不得与主 ID 相同，白名单不得重叠。

双闸 `FEATURE_SITEMAP_AUTO_REFRESH` / `SITEMAP_AUTO_REFRESH_ALLOW_WRITE` 由共享 env 透传到 light。继续使用已有 `PREPROD_APPROVED_OPEN_WRITE_GATES` 中的 `sitemap_write`，不新增登记项，不改变其它开闸授权；IndexNow 和自动分类保持原有关闭状态。

先备份 env，暂停领取批次并确认处理中为 0；由发布执行者更新 env、执行新迁移及 grants，再按更新后的发布脚本启动并检查四个应用服务。不得让旧主 worker 和新轻量 worker 在白名单迁移期间同时消费相同类型。

### 回滚

回旧版（无 worker-light）前，先用**新版** compose 停 scheduler 和两个 worker，并等待 drain；旧版 compose 无法命名/停止新服务。然后恢复旧镜像、旧 env 和主白名单，把 sitemap 与轮播交回主 worker，移除已停止的 worker-light 容器；不删除 sitemap 卷。最后从旧版不可变发布目录运行原有回滚流程。新字段可保留，无需 down migration。

已入队的 `sitemap.daily_fallback.v1` 控制任务保留为不可消费的待处理记录，未来版本恢复时再处理，不转换成直接创建 sitemap_refresh 的任务。恢复旧主白名单必须在 light 已停止后完成。
