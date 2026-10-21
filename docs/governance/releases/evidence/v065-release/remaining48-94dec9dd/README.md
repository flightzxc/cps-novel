# v0.6.5 剩余48本：PASS；53本恢复完成

Owner明确“批准剩下48本”后，以主控已审核ops@94dec9dd及原脚本在haiyue-vps执行。
原baseline不改，plan重新核对精确48本及四项前提、原actor/账户、MINE及635条摘要；
清单文件SHA256 `46537917902afee740455aa17c6c6bb9c4894ed926653f3c4fb1c5ab770bddff`，48ID摘要仍`19231defb2d3488135d80e3ff6a61baf02e6438e72f916ac9b1c464605e917d6`。
原生web uid1001/web_app运行；核对事务READ ONLY，原函数事务钩子处理账户/凭据，enabled双闸true。

只提交一次、duplicate=false；requestId `promo-reclaim-53-2026-10-20`，批次`4ab3f194-e194-47ba-b9a4-c0c4a55b181e`，
父批次及子领码任务均completed。没有重放、重试、缩范围或补领批次。

独占窗口：`2026-10-21T07:59:28.822Z`–`2026-10-21T08:03:42.242Z` UTC，即`2026-10-21T16:59:28.822+09:00`–`2026-10-21T17:03:42.242+09:00` JST。
48本全部already_available、推广码和网址均存在、失败0。先前4本金丝雀最终只读回查仍already_available、
有码有网址、意图上限0；MINE仍为resolved_by_catalog_scan、单条upstream_existing带码链接、意图0、在途0，未重提。
对账53 = 1（目录扫描解决）+ 4（金丝雀）+ 48（本轮）= 53本均已恢复带码链接及网址。
这是精确回读确认已有上游链接，不称为新生成52个推广码。本轮未执行getcode写入分支；写入与恢复分支的代码门禁以第一阶段证据为准。

**按意图记录推定的每本 getcode 上限**：53本均0，MINE=0。逐本明细见[books53.json](books53.json)，
不伪造逐本实际HTTP次数。**本轮窗口总调用数**：getcode=0=getcode新增全局/范围意图0，getvideoinfo=48，全部HTTP200/outcome=ok。
先前金丝雀独立窗口为getcode0/getvideoinfo4；两窗分别取证，不包含窗口外目录扫描请求。
原窗口计数包装器重算PASS：[计数结果](window-counts.log.txt)、[脱敏事件](upstream-events-sanitized.jsonl)。

窗口两端无其它领码/目录扫描在途，窗口新增任务只含本轮父子批次；无未决/转人工/429/熔断。
六服务均healthy、容器ID未变，error/permission denied均0。635条PlotNovel人工复核count及摘要
`f95469197e264588a1a9a99c298632d13a8b65882f64342770d29f225717b454` 最终不变。部署身份仍0.6.5/Final b378910，env/nginx原SHA不变，
没有改grants/角色/compose/任务白名单、公开网址或现有推广码，不用sudo。

自写传输包装器的换行转义在本地语法检查时失败，未连接生产；修正后先通过语法检查再执行。
审核ops脚本未变，原停点与权限证据均保留。所有落盘上游日志仅白名单字段，不含推广码、URL原值、口令或凭据。

[机器结果](result.json)、[原始结论行](summary.txt)、[完整清单](manifest.json)、[plan](plan.json)、[终态](status-002.json)、
[最终金丝雀回查](canary-final.json)、[前快照](preflight.json)、[后快照](postflight.json)、[六服务日志汇总](service-window.json)。
生产执行到此结束，不再提交书目。后续仅按原计划补齐annotated v0.6.5、生成CHANGELOG、台账/发布与重领记录、唯一发版日志及Notion同步回读；工件Final保持不变。
