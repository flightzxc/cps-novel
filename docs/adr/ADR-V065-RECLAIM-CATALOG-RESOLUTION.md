# v0.6.5：目录扫描已解决的 MINE 从金丝雀提交范围排除

状态：Owner/主控 2026-10-21 裁定；新 ops SHA 仍须主控复核后方可生产执行。

主控已只读查实：MoboReader 的非定时 apply/catalog_scan 任务 84a47861 于
2026-10-21 10:27:05 JST 开始，11:06 JST 完成；开始11秒后将 MINE
`c838c281-c9ba-482a-aa80-05792e8fdc4a` 以 upstream_existing/fetched 捡回，
没有调用 getcode，与重领无关。53本只有这一行获得带码链接，其余52本没有。
这是主控提供的已核实结论；本次实现不重复连接生产调查来源。

原停点 d9a124e8 保留。MINE 记作 resolved_by_catalog_scan，不再提交；金丝雀为
原冻结 baseline.canaryIds 排除上述完整 UUID 后的4本，余48范围和 baseline
原字节不变。始终对账 53 = 1 + 4 + 48。

ops 只读检查 MINE 的剧场/标题/语种身份、恰好1条带码链接且 origin=upstream_existing、
任何领码意图0、在途领码条目0；不满足就停。金丝雀提交数量必须4、无重复、
与原五本减 MINE 完全一致；旧5本和以 MINE 替换任一本均拒绝。
确认短语改为 PROMO_RECLAIM_CANARY_4，避免仍标注5本；旧确认短语拒绝。
requestId 仍为独立的 promo-reclaim-53-2026-10-20-canary；原 requestId 下尚无批次，
若发现已存在不同输入，则沿原 enqueueCatalogBatch 的重放一致性规则拒绝。

窗口开始与结束均拒绝任何 pending/processing 的 catalog_scan（不按剧场放宽）；
submit 只读预检、原提交事务校验钩子和 status 均检查，plan 亦检查。
这提供核对时点的检查，不是阻止其它操作人随后创建任务的锁；窗口期间 Owner/运营
仍须暂停其它领码及目录扫描提交。若状态核对发现扫描，立即停手回报。

按钮逐字复制的账户校验、原 enqueueCatalogBatch、enabled 双闸、临期审计不变；
web 容器原生 web_app，不读取 raw_payload、不读推广码原值，不更改 grants/角色。
每本 getcode 仍只报告按意图记录推定的上限，MINE=0，窗口总调用数另以宿主日志核对；
635条 PlotNovel 人工复核摘要不变。发布 Final、镜像、迁移、公开网址均不变。

本次只本地实现、真实 grants 冒烟和推送复核；主控明确批准新 SHA 后才提交4本。
余48本仍待 Owner 看过金丝雀结果并另说“批准重领”。
