# v0.6.5 四本金丝雀结果：PASS，停止等待48本授权

主控复核ops@94dec9dd及脚本SHA256通过后，仅在haiyue-vps按post-review-runbook执行。
已验证审核脚本原字节、冻结baseline原字节、部署0.6.5/Final b378910、原生web uid1001及
web_app身份；核对事务READ ONLY。提交一次，duplicate=false，未重放/重试，没有提交48本。

- requestId：`promo-reclaim-53-2026-10-20-canary`。
- 批次：`0dcc1e9d-5900-4987-b686-3210b66f4602`，父批次及子领码任务均completed。
- 独占窗口：`2026-10-21T07:43:06.640Z`–`2026-10-21T07:47:02.480Z` UTC；即`2026-10-21T16:43:06.640+09:00`–`2026-10-21T16:47:02.480+09:00` JST。
- 窗口起止均无其它领码或pending/processing目录扫描在途，窗口内新增任务只含本轮父批次及其领码子任务；未发现其它领码/扫描干扰。
- actor为原active admin/super_admin，账户为冻结的MoboReader运营账户`53f03fd8-951d-433e-ac66-784e82496a84`；channelAccounts只有MoboReader，enabled=true，凭据临期warning=0。

| 书名 | 语种 | 本轮结果 | 有码／有网址 | 按意图记录推定的每本 getcode 上限 |
|---|---|---|---|---:|
| Fran | en | already_available | 是／是 | 0 |
| Heart | en | already_available | 是／是 | 0 |
| Obsession | fr | already_available | 是／是 | 0 |
| SOLD | en | already_available | 是／是 | 0 |
| MINE | en | resolved_by_catalog_scan（未提交） | 是／是 | 0 |


4本全部为already_available，有码有网址、失败0。这是原handler确认已有上游推广链接的结果，
不称为生成4个新码。MINE按主控先前查实的目录扫描84a47861来源单列；没有把MINE重新提交，
没有把它计入本轮already_available。对账53 = 1（目录扫描已解决）+ 4（金丝雀回读已有）+ 48（待另批）。

**窗口总调用数**：getcode=0，getvideoinfo=4（4个事件均HTTP200/outcome=ok，仅按窗口汇总）。
窗口新增全局领码意图=0，本轮范围新增意图=0，全局原有意图33559→33559；getcode事件总数与
新增意图总数一致。逐本只标“按意图记录推定的每本 getcode 上限”，5行均0，不伪造逐本实际HTTP次数。
原窗口计数包装器独立重算PASS：[计数结果](window-counts.log.txt)、[脱敏事件](upstream-events-sanitized.jsonl)、[快照](counter-snapshot.json)。

未决意图0、转人工0、429/熔断0。六服务均healthy且容器ID未变，窗口error=0、permission denied=0；
635条PlotNovel人工复核count与摘要由原status前后校验一致，摘要`f95469197e264588a1a9a99c298632d13a8b65882f64342770d29f225717b454`。
未改公开网址、nginx、env、compose、grants、角色或任务白名单，无sudo。最终健康仍0.6.5/Final。

执行前自写传输包装器有换行转义错误，remote Python在解析阶段拒绝，未执行任何数据库查询或提交。
修正包装器后先验证语法，再重新做预检；原审核ops脚本未改。失败stderr和修正记录保留，不记作产品门禁失败。
所有原始上游日志只在内存过滤，落盘仅白名单事件字段，不含推广码、URL原值、口令或凭据。

[机器结果](result.json)、[结论行](summary.txt)、[原status终态](status-002.json)、[只读前快照](preflight.json)、[只读后快照](postflight.json)、[服务日志汇总](service-window.json)。
现在窗口已关闭、执行停止。48本原范围及摘要不变，须Owner看过本报告后另说“批准重领”，
才进入48本plan/submit；本轮未创建48本submit清单或批次，失败书也未重试。
tag/生成CHANGELOG/唯一发版日志/Notion按原计划待重领总体结果明确后补齐，当前不宣称整版收官。
