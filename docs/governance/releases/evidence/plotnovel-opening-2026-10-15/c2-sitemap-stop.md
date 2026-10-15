# 丙2验收停手：站点地图与试读完成时序差异

原提示词要求任何读回异常即停手。本次仅只读核查，尚未发起5篇的公开HTTP验收。

| 项目 | 读回 |
| --- | --- |
| 生成任务48eba852-5fd8-479b-a74a-0b850ff6af71 | completed，50/50成功，failed0/skipped0 |
| 本批已发布文章 | 50篇，全为英语PlotNovel |
| 有效试读 | 50/50本，各3章，共150章 |
| IndexNow | 50/50 accepted，熔断关闭、无429等待、due0、deadLetter0 |
| 静态站点地图 | 50/50书页网址；81/150章节网址，差69 |
| 轮播服务快照 | PlotNovel0条（首页HTTP未检查） |
| 外部请求 | 本轮0次，累计仍1/30 |

时序（UTC；客户端为Asia/Tokyo）：最后sitemap任务2cc950ef-c15b-40a4-aef5-1d271267e43e于05:00:43.975850完成；本批50本试读任务60ad99a6-aad6-460e-80bf-10f8c49511fa于05:01:17.367472才完成。之后没有新的sitemap任务；当前静态release仍2cc950ef。对应JST14:00:43与14:01:17。该时序与章节缺口一致，尚未把它认定为已完成代码根因审查。

固定抽样为发布时间/文章ID升序第1、13、26、38、50篇，分布于5个相关English novelpage分片；没有换样规避差异。第一次辅助包装器在打印诊断前触发覆盖断言，31a只读复查先输出实际计数，31b仅核对任务时序；两次失败原证据均保留，没有改门禁或数据。

未手动刷新、未改数据/代码/env/能力/公开网址，未补码或收口635条人工复核，claimPromo仍关闭。重复点击159a24f6按Owner说明被准入拦截、0篇，本轮不处理。按钮/小字、章节HTTP、go跳转、中间页、泄漏计数、首页轮播及外部sitemap验收均未开始，不能宣称丙2PASS或PlotNovel完整验收完成。

待Owner批准的具体操作：按原手册docs/operations/sitemap-manual.md在web容器执行原CLI，只入队，由现有worker生成并发布。

```bash
docker exec cps-novel-web-1 tsx scripts/generate-static-sitemaps.ts --dry-run </dev/null
docker exec cps-novel-web-1 tsx scripts/generate-static-sitemaps.ts --apply --reason 'PlotNovel金丝雀试读完成后补齐站点地图章节' --request-id plotnovel-sitemap-after-preview-20261015 </dev/null
```

两条命令均尚未执行。获批准后先预演、再入队，等终态并核对旧网址写法不变及50书页/150章节覆盖，然后继续固定5篇公开验收；全程不改代码、不重发文章、不调用getcode、不回关已有页面。
