# 工单 6：IndexNow 扫描与轻量公平轮转

状态：Owner 在工单 6 计划中选择并批准实施；生产开闸仍需独立批准。

现有海阅每个投递条目只提交一个 URL，HTTP 超时 10 秒；首次发布及人工释放都会直接建条，单独降低扫描上限无法限制全部排队。只读参照 `/Users/chenweifeng/Documents/产品原型及文档/cps项目/cps-admin` 的 `git show 3a76877:src/instrumentation.ts` 与 `git show 3a76877:src/lib/indexnow-delivery-service.ts`：CPS 每分钟预查 pending/retry/stale-processing，HTTP 批量最多 500 URL。本单不移植其协议或代码，不修改既有投递/重试语义。

采用 `indexnow.sweep.v1` 分钟控制任务，delivery 双闸关闭不产生时间桶；开启时保留空扫描，避免只预查 pending/retry 而漏掉 processing 恢复。scheduler 不增加 outbox 读取权限。

定时 handler 显式限制 200 条候选，保留底层 API 默认值与首次发布行为。light runtime 在投递组与其它有效轻量类型之间交替选择；组内复用既有领取排序、租约、恢复和 fencing，组空即尝试另一组。main 不走轮转，且拒绝两个 IndexNow 类型。多个 light 实例各自轮转，不承诺跨进程全局顺序。

200 / 2,000 / 10,000 条各耗满 10 秒时，纯 HTTP 服务时间分别为 33 分 20 秒 / 5 小时 33 分 20 秒 / 27 小时 46 分 40 秒。轮转保护其它任务免于等待全部积压，但不增加吞吐，也不抢占正在执行的请求；等待仍含当前请求最多 10 秒、数据库工作及其它轻量组内部排队。扫描恢复阶段沿用原有 stale 查询，其回收条数不受 200 候选上限控制。

批准轻量集合不等于环境消费白名单。预生产只新增扫描类型，投递类型仅在 V020 步骤 8–9 与双闸同次加入 light；四变量及 preflight 默认硬关不变。验证与发布草稿见工单 6 交付文档。
