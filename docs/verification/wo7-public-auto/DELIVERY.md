# 工单 7：建书首次定类与公开 auto 标签（dark 交付）

状态：实现分支交付，尚未合并、未上线。实际开关保持原状，G7=NO；未修改主机、部署、preflight、worker 白名单、CanonicalTag/B2/C1 冻结产物。无 schema 或 grants 变更。

> 2026-09-27 Opus 复核修订已追加：worker 关闸观察静默，三项千次调用守卫及全量/真实库门禁通过。最新命令、尾行和变异恢复见 [OPUS_REVISION.md](OPUS_REVISION.md)；下文原验收数据保留为首次交付记录。

## 1. 身份与裁决

- 分支：`feat/tagging-public-auto-projection`。
- worktree：`/Users/chenweifeng/Documents/cps海阅/wo7-public-auto-tags`。
- 基线：`69765e1995fc5ebd67f63b64349e3d02b587df20`。先 fetch，再 ls-remote 确认开发线 `bdf2d42add2084473d2aa325c8696c934f28cfd8`，祖先检查通过；未从 main 切。
- 聊天根目录不是 Git 仓库，托管 worktree 工具返回 `Not a git repository`；按工单指定路径使用 Git 创建独立 worktree。
- lockfile SHA-1：`0977d56ef89920fe44dc41a39d5e1089d2180afc`，与依赖来源 release-v0.4.5 一致。Turbopack 拒绝目录外 symlink，最终采用 worktree 内独立 APFS clone 依赖副本；未改 lockfile。
- Owner 补充裁决 1：不改变建书分组。定类侧排序去重后每 ≤5,000 本一个任务，N 本均满足首次定类资格时任务数 `ceil(N/5000)`，N=0 不建任务。每个任务的 ID 集合硬上限 5,000，超过直接拒绝；不以语种范围替代。
- Owner 补充裁决 2：分类目录始终按 `sortOrder, slug`。123 标签 bootstrap 的 `sortOrder=index*10` 唯一，第二键与 stableId 输出等价；补齐冻结产物和真实库 active sortOrder 唯一性守卫。ADR 合同原文保留。

## 2. 建书入口审计与接法

所有路径均相对上述 worktree；行号以当前实现为准。

| 入口 | 接法 |
| --- | --- |
| `src/app/(admin)/catalog-sync/_actions.ts`：`dryRunNovelMaterializeAction`（136 / 142 行） | 原第 140 行是 dry-run，不是第二个生产写入口。保持零首次定类。 |
| 同文件：`applyNovelMaterializeAction`（202 / 226 / 233 行） | 建书调用提交后，仅 `created` 调用 `initializeCreatedNovelTags`，再执行原有 revalidate；返回对象不变。 |
| `src/server/content-creation/batch.ts`：`applyContentCreationBatch`（267 / 272 行） | 已无生产调用方，保留 deprecated。循环后只提取 created 的 novelId，一次调用批量包装；50 本旧选择上限内至多一个定类任务。未接逐本任务。 |
| `worker/handlers/catalog-batch.ts:610`：`batch.materialize.v1` | 原按组生成 `novel.materialize.v1` 子任务的代码不变；原常量 50 只是数据库写入块，不是子任务总量上限。 |
| `worker/handlers/novel-materialize.ts:53` | 建书仍在 fenced `protectedWrite` 事务内；注册 `afterItemCommit`。回调在终态提交后判断子任务所有条目是否终态，从已持久化 success + created 结果提取 ID。 |
| `worker/runtime/worker.ts:284,346,471` | 正常 finalize、失败后的终态 fallback、租约恢复置 failed 三处调用受异常隔离的提交后观察器；retry/requeue 不触发。 |
| `src/server/content-creation/service.ts:250,265,305,307` 及兼容别名 | 仍是唯一 `novel.create` 写路径，事务函数和弃用别名无新增生产调用方。分类不进入建书事务。 |

首次定类包装首先检查 master、auto、G7，任一关闭即记录 `tagging_gates_closed`；不读书目快照、字典或任务状态，不建任务。关闭路径只增加常数级判断及日志，没有新增数据库往返。

worker 终态检查使用未完成条目的存在性查询，不在每本提交后统计整个剩余集合。结果读取每段最多 5,000；最终 ID 全局去重排序再分段。requestId 为 `(子任务 ID, 段序号, 段内排序 ID 哈希)` 的指纹。每段独立捕获失败并继续后段；重跑同一结果集复用 requestId，不重复入队。仍过滤 manual 与已经有 currentAutoRunId 的书。

观察器是提交后的 best-effort 接线，不承诺跨进程崩溃的持久自动补偿；入队失败记录原因，重放同一批可幂等重试。本单未增加周期扫描或存量回填。

## 3. 公开投影与 CPS 核实

- 唯一 membership 投影仍在 `src/lib/site/public-taxonomy.ts`。关闭分支保留原 SQL、返回字段、顺序、翻译回退与缺失 Map 项的行为。
- 开启时：manual FULL_SNAPSHOT（含空）独占；automatic 为映射与当前 run 的 active auto 标签并集。映射归属优先；映射按 sortOrder/slug，文本按 score DESC、stableId。
- 所有消费面复用同一投影：public-load、category-queries（分类页及 browse）、queries（书卡与详情）、chrome（首页/页脚）、sitemap。src 全树复查 SQL 表名与 Prisma delegate，未发现其他公开归属计算；后台管理读取不属于公开旁路。
- `target_source_item AS MATERIALIZED` 与 `COLLATE "C"` 保留。公开读路径不运行分类器、不写标签。
- CPS 只通过 `git show 3a76877:<path>` 核实 resolver、drama-actions、import-service、changdu-promote-drama。参考其 automatic union、映射优先和建剧分类接线；不接入 CPS 代码或数据库。
- **海阅 CanonicalTag 没有 isFallback 字段，也没有兜底标签概念；本单没有增加兜底识别或补空行为。** CPS 自身的 fallback 展示不搬入海阅。

## 4. 验证与证据

见同目录 `validation.txt`（命令和尾行）、`explain.txt`（完整四份执行计划）、`mutations.txt`（五项故障与恢复）、`changed-files.txt`（完整改动清单）。

最终结果：tsc 0；定向 80 passed；全量 453 files / 6,781 tests passed，0 failed，无 Unhandled Error；独立 PG16 26 passed、skipped=0、字典 drift=0；build exit=0。收尾优化追加 23 项回归通过，排序编辑合同守卫所在套件 23 项通过。

- 冻结旧投影来自 `69765e1`，放在 tests/fixtures，仅更改测试导入路径；真实库中同一 fixture 下新旧五个消费面逐项和 JSON 字节相等，覆盖自动、manual 空集合和标签翻译回退。
- 开启用例验证仅靠文本非空的分类进入分类页、书卡、详情、首页/页脚和 sitemap；关闭仍为空时 404 且不进 sitemap。历史 run、空指针、停用标签不暴露，manual 非空/空快照均独占。
- 真实库使用显式 web_app、worker_app 连接并断言 current_user；验证三张 tagging 表可读、web 入队、worker 真正分类落快照，及提交后失败隔离。Owner 仅构造 fixture。
- 批量单测用上限 2 模拟 5 本 → 3 段，验证边界、排序、重放、失败后段继续；真实库以并发重放证明只建三任务，且同语种批外存量书不进入。
- 查询预算两种 flag 状态均保持原上限：主页 5、详情 6、章节 7；主页 taxonomy 两次调用、每次一个 SQL，无新增往返。
- 性能数据：一次性 PG16.14，80,000 书目、80,000 当前 auto 快照、1,760,000 来源标签关联，目标 25 本；分别断言 channel_app 列统计缺失和存在。计划未出现百万级源条目索引探测。单次执行时间受缓存和并发负载影响，不作为预生产 SLA；本单证明查询形状与往返预算未退化。
- 后台 `admin-tagging-regression` 禁止 auto 写入口断言保持不动；额外运行 admin-secret-boundary。未改客户端组件。
- 全量中未启用的其他真实库套件照常 skipped；本工单独立真实库运行器必须 skipped=0。
- 测试期间初次全量因 Docker sandbox 权限出现两项失败，获得本机 Docker 访问后重跑；构建先修复依赖 symlink，再按 Turbopack 临时端口要求在允许上下文执行。未通过放宽断言解决。


实测执行计划时间（单次，含缓存顺序影响）：

| 统计状态 | auto | Execution Time |
| --- | --- | --- |
| channel-app-missing-stats | false | 6.283 ms |
| channel-app-missing-stats | true | 3.758 ms |
| all-analyzed | false | 3.117 ms |
| all-analyzed | true | 3.359 ms |

## 5. 开闸前检查清单草稿（供未来审批，本单不执行）

1. **审批身份**：记录部署 SHA、字典/关键词/config 指纹；另行批准 G7、master/auto、worker 消费和 preflight 登记制变更。本分支不会通过现有 preflight 开 auto 写闸。
2. **按语种抽样**：预生产只读选取 automatic、currentAutoRunId 为空且未删除的书；每个实际存在语种固定 seed 抽样至少 100 本，不足则全取，兼顾有/无映射、长短简介。保存 ID 清单，禁止直接用全语种范围代替样本。
3. **dry-run**：在经批准的隔离验证进程或数据库副本执行现有脚本，每次 `--novel-id` 明确指定样本。默认 dry-run 不写标签，但会写 GenericTask/条目/审计；必须实际消费 dry_run 任务并检查条目结果，脚本返回 enqueued 不等于分类已完成。不得临时把生产 worker 白名单改开来做本轮验证。
4. **人工质量指标**：每语种/分层记录 precision、误标类型、无命中比例、仅 auto 新增覆盖、映射重复比例、文本截断比例、每书 0–3 文本标签分布、失败/跳过原因和人工复核样本数。C1 约 73% 仅历史校准参考；具体放行阈值由 Owner 批准，不能跨语种套用。
5. **运行指标**：入队延迟、分类 p50/p95、每秒书数、任务积压、错误率、锁等待、数据库 CPU/IO、公开页面 query buffers/loops 与查询次数，及正式领取吞吐影响。隔离副本先验证，正式回填避开领取期间。
6. **未来回填命令模板**：以下由已批准环境提供 `P2_06_5_TAGGING_TASK_DATABASE_URL` 和相关闸；运行镜像已有 tsx 4.21.0。不要在命令行粘贴连接串或凭证。本单不执行：

   ```bash
   # 样本 dry-run：逐个使用已审核清单的实际 UUID，request-id 固定且唯一
   tsx scripts/p2-06-5-production/tagging-backfill.ts \
     --lifecycle initialize_missing --novel-id '<sample-uuid>' \
     --request-id '<approval-id>-sample-001' --dry-run

   # 只有另行批准存量回填时才使用语种范围；这里不是建书自动接线
   tsx scripts/p2-06-5-production/tagging-backfill.ts \
     --lifecycle initialize_missing --locale en \
     --request-id '<approval-id>-en-initialize-missing' --apply
   ```

   现有 CLI 的 locale 范围会枚举该语种存量，并非本单新增的 5,000 ID 硬上限范围。大语种先评估入队内存/事务成本；若不能满足窗口，审批前另行提供显式 ID 清单的运维入口，不能声称现有 CLI 支持 `--novel-ids`。避免 `--all`；其 apply 另有确认及指纹要求。

7. **耗时估算**：采用 `T = 入队耗时 + N / 实测有效吞吐`，再留重试与负载余量。本地 25 本英语、单关键词合成 fixture 仅供量级参考，不代表完整 360 关键词、多语种或预生产硬件能力。审批前必须以冻结 C1/B2 和每语种样本实测替换，按 N 与并发预算计算时间窗。
   本次隔离测量：`WO7_THROUGHPUT novels=25 locale=en fixture_keywords=1 enqueue_ms=18.18 classify_ms=875.36 books_per_second=28.56`。仅按此合成吞吐，80,000 本分类约 46.7 分钟；按 2–4 倍余量约 93–187 分钟，另加实际入队耗时。此区间不是生产承诺，完整冻结词典与语种抽样实测是审批前置条件。

8. **放行后验收与回退**：验证新书获得当前快照、auto-only 分类可达、manual 空集合不回退、sitemap 与页面一致。公共 auto 可关闭回退旧投影；另行停用写授权/消费以停止新写入，不删除历史快照。停止条件及回退操作须列入该次 Owner 审批记录。
