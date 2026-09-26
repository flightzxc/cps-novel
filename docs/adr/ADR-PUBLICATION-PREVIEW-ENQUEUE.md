# ADR：试读只在文章发布后排队

日期：2026-09-26。状态：Owner 已批准设计，工单 1 实现待独立复核、未合并未上线。

依据：同日海阅对照 CPS 审计优化方案工单 1（外部审阅后修订），以及本轮《工单 1–4 开发与独立复核方案》。这是海阅既有服务与任务工厂的组合，不搬运 CPS 代码。

## 决策

建书（web 单篇、web 批量、worker materialize）与目录扫描收尾不再排试读；草稿生成保持无试读副作用。`applyPublishTransition` 在发布事务提交之后通知 publication dispatcher。重新发布同样触发试读；IndexNow/sitemap 仍保持既有首次发布语义。

批量发布收集真实写成功的 articleId，在循环结束的 `finally` 中只调一次规划器；中途意外失败也处理已提交前缀，拒绝/冲突/未处理条目不进入集合。产品批量上限仍是 200。单篇和批量共用规划器；每个 `(channelAccountId, channelAppId)` 一次事务、一个任务、多条书目。

公开资格复用 `buildPublicArticleWhere` 与 `isPromoReady`，仅已登记站点语种的小说文章，软删/权利状态/hidden（功能闸开启时）沿既有公开谓词处理。额外拒绝已删除的推广链接、来源软删或 novel/app 绑定不一致。账号和来源只使用文章实际绑定的 PromoLink；不根据“最近扫描”或任意可用账号猜测。多个语种文章共享同一本书时，按 articleId 稳定排序，取首个有资格的实际链接，每本书只规划一次。

## 事务与并发

发布、发布审计仍同事务；试读任务及其审计在发布完成后的独立事务中写入。某组 SQL 失败只回滚那组，其他组继续；规划查询失败也被 dispatcher 隔离。日志保留 requestId、账号、应用、错误类型及可用的 Prisma code，不记录原始 SQL 参数、凭据或上游内容。失败可用既有手动重建补偿；没有新增自动重试或补偿队列。

原工厂的 requestToken 与 scopeHash 保留。发布 token 包含本次成功来源子集，避免部分批次重试时先前已提交前缀占用 token、导致新成功书漏排。补充按 `(mode, novelId)` 排序取得 PostgreSQL transaction advisory lock，再检查该书任何来源下的待处理/处理中条目，父任务为 pending/processing/paused/disabled 均算在途。整组 scope 不同、账号不同、来源别名不同也不能重复排同一书。在途工作跳过原因是 `preview_in_flight`；新鲜内容仍为 `fresh_preview`。锁按 1,000 本分块，不扩大 PostgreSQL bind 参数上限。

手动重建与 recovery 命令入口、参数、凭据解析方式未变；它们复用同一个工厂，因此也获得条目级重叠去重。旧的 catalog staging 函数保留供历史恢复/测试使用，但没有新增自动调用者。保留历史任务本身，本轮没有取消或回填积压。

## 权限与开闸

无 schema/migration/grants 变更。web 只读凭据 id 元数据，不读取密文；worker 是唯一解密方。现有 web_app 已有 task/item 写权限及 account-hold 读权限；一次性数据库以真实角色证明。沿用 catalog feature/write 双闸、来源应用白名单、可选来源条目白名单、freshness 和 preview scope 的账号 hold。

本轮不调整 worker 族优先级、并发、主机级限速或白名单。试读仍优先于领取，运营须按验收报告估算领取停顿。

## 上线顺序（须另获 Owner 授权）

1. 先备份并按另批方案处理/隔离旧的 80,006 条积压，确保不被 worker 消费。
2. 部署经独立复核的代码；按既有流程保持双闸及来源应用配置一致。无新增 grants 或迁移。
3. 只有前置步骤完成才允许将 `moboreader.preview_refresh.v1` 纳入 worker 白名单，并登记发布记录。
4. 用已有手动重建入口仅补已发布的书；查看任务失败、账号 hold 与发布后入队失败日志。
5. 建议初始运营批次不超过 50 本，并等待试读队列消退再继续；是否新增产品限流/改变公平调度另由 Owner 决定。
