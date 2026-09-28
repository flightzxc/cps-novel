# 工单 6：生产开闸草稿（待 Owner 审批，未执行）

X11 已实现，待生产开闸验收。本文件不代表生产授权；所有步骤仍未勾选。
执行基线为 V020 §3.1，开闸前先完成其步骤 1–2：核实部署版本、四个变量均为 false、SiteSetting host 与生产 SITE_URL 相符、公开 key 文件可访问。真实 key 不进入日志或证据。

两组变量的完整定义：
- outbox 双闸：`FEATURE_INDEXNOW_OUTBOX`、`INDEXNOW_OUTBOX_ALLOW_WRITE`。
- delivery 双闸：`FEATURE_INDEXNOW_DELIVERY`、`INDEXNOW_DELIVERY_ALLOW_WRITE`。
- light 白名单：`WORKER_LIGHT_TASK_ALLOWLIST`，容器内映射为 worker-light 的 `WORKER_TASK_ALLOWLIST`。
- main 白名单：`WORKER_TASK_ALLOWLIST`；任何阶段均不得包含 `indexnow.sweep.v1` 或 `indexnow_delivery`。

| V020 步骤 | env / 白名单变更 | 必过证据 | 回关动作 |
| --- | --- | --- | --- |
| 3 | 先在 `PREPROD_APPROVED_OPEN_WRITE_GATES` 登记 `indexnow_outbox`，outbox 两项一起 true；delivery 两项仍 false。light 已含 `indexnow.sweep.v1`，仍不含 `indexnow_delivery` | compose 与容器配置读回一致；scheduler 零扫描入队，无 HTTP 外呼 | outbox 两项一起 false，保留全部 outbox/任务/attempt 记录 |
| 4 | 不变 | 抽查 URL、locale、revision、去重与任务量；首次发布会立即建首条投递任务，pending 增长应与发布量对应 | 异常即回关 outbox，停止后续步骤 |
| 5 | 不变 | Sitemap fixture、正式 locale dry-run、目录权限、分片、lastmod、HTTP route 全部 PASS | 失败停在本步；若发现 outbox 数据异常，同时回关 outbox |
| 6 | Sitemap 双闸与 light 的 `sitemap_refresh` 同次生效；IndexNow delivery 仍 false | 首刷成功、共享卷和公开 sitemap 200、配置读回一致 | 任一侧无法生效，整体恢复本步之前的 Sitemap 配置与白名单 |
| 7 | 不变，不得提前开启 delivery | 同候选版本本地真实角色/真实循环/模拟 HTTP 的分钟桶、去重、在途合并、skip、恢复、失败重试、压力及公平轮转证据齐全；生产核验注册、版本、DB 时钟、权限及关闭时零扫描 | 不通过则不进入 8–9；生产开关保持关闭 |
| 8–9 | 经 Owner 审批，保留 outbox 登记，同次登记 `indexnow_delivery`、delivery 两项一起 true，且同次仅向 light 添加 `indexnow_delivery`，扫描类型继续保留 | 生效前核对预期配置与实际版本；生效后核对当前分钟控制任务、light 执行归属、扫描结果、投递 attempt 与 HTTP 结果、队列增长、sitemap 延迟；补齐生产 X11 运行证据 | 任一配置未一致生效、403/422 出现或既有 stop condition 命中：整体回关 delivery 双闸，并同步撤销 delivery 登记、从 light 移除 `indexnow_delivery`；outbox 异常则同时回关 outbox 双闸 |

步骤 8 与 9 是一个发布变更，不能先开闸、后加白名单。该变更覆盖 scheduler 与 worker-light 的有效环境；沿用实际发布流程重建相关消费者并逐一读回，不能仅修改 env 文件而不确认进程已生效。

“原子”指一个经审批的配置/发布单元及整体回滚，不保证多个进程在同一纳秒切换。切换前暂停消费并等待当前请求结束，整组配置就绪后恢复；回关优先停 scheduler 新入队及 light 消费，等待正在执行的请求结束后以关闭配置恢复，不能声称回关能撤销已经发送的 HTTP。HTTP 最长 10 秒，退出还需数据库完成时间；按既有 drain 流程观察。

回关后验证：两个 delivery 变量 false、light 不含投递、main 无两个 IndexNow 类型、后续分钟零新扫描、无新 HTTP。保留失败和积压，禁止通过删除任务、重置 retry 状态制造“健康”。若 outbox 保持开放，会继续产生首投 pending；这是有意保留的待投递积压。

仅恢复空闲状态时，不需要新增 scheduler outbox SELECT。开闸后的空扫描是恢复机制的一部分；关闭环境不会产生它们。单条一个 URL、每次扫描至多 200 条；投递与其它 light 任务轮转，不能抢占当前 HTTP。观察中如积压长期上升，暂停开闸并单独评估容量，不在本单变更 HTTP 批量协议或退避算法。

预生产维持四变量 false，禁止登记 IndexNow 两项。正式模式 preflight 采用登记制：outbox 先登记；delivery 登记依赖 outbox，且与 light 白名单投递项同时增删。所有阶段先跑 preflight 并核对 PREPROD_SITE_MODE=public，再执行发布并读回消费者配置；未登记组必须双 false。回关 outbox 时若仍登记 delivery，须同步回关 delivery、撤销其登记并移除 light 投递项，随后撤销 outbox 登记；保留全部任务与 outbox 记录。本草稿仍需逐步 Owner 审批。
