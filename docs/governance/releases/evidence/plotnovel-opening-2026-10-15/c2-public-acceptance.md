# 丙2固定五篇公开验收（2026-10-15）

接受范围：已有口令码书的试读与公开发布链路。claimPromo保持registered_disabled；635条人工复核不动，领码金丝雀未被改判通过。业务代码/Final/tag/env/公开网址保持，本轮不提交新领码或文章批次。

## 原CLI预演及一次刷新

Owner确认此前81/150章节是既有时序：首发触发刷新早于试读最终落库；MoboReader新书同样如此，每日04:00 JST兜底刷新会补齐。此处按Owner裁决记录，不归为v0.6.0或PlotNovel缺陷。Owner明确批准原CLI预演后刷新一次。

```bash
docker exec cps-novel-web-1 tsx scripts/generate-static-sitemaps.ts --dry-run </dev/null
docker exec cps-novel-web-1 tsx scripts/generate-static-sitemaps.ts --apply --reason 'PlotNovel金丝雀试读完成后补齐站点地图章节' --request-id plotnovel-sitemap-after-preview-20261015 </dev/null
```

预演各语种合计130113 URL（en60257），完整counts见32日志。web_app身份、原CLI actor system/sitemap-cli；apply一次返回queued，仅入队。现有worker任务431d9fdb-87d0-4006-b5ba-1042326e5eba于06:46:43.100196Z开始、06:47:10.071181Z完成，26.970985秒；completed / success1 / failed0 / skipped0。新current正是该任务；50书页/150章节齐全，每本精确包含1、2、3章。没有直接生成文件或第二次apply。

## 固定五篇结果

按published_at/article_id固定排名1、13、26、38、50，沿用停点前样本；书页/文章页共用同一个公开网址，只计一次GET，章节href从实际书页DOM获取。

| 样本 | 书页与article ID | 书/第1章HTTP | /go | 中间页 | 书页/章节口令匹配行数 | 结论 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | [reborn-to-reach-the-stars](https://pulsenovels.com/novel/reborn-to-reach-the-stars-pd1v7iks2) (`126d0a75-b7db-47c1-bdc5-a314646d2ec3`) | 200 / 200 | 302，相对Location正确 | 200 / no-store / robots正确 | 0 / 0 | PASS |
| 2 | [ten-years-wasted-on-a-faithless-love](https://pulsenovels.com/novel/ten-years-wasted-on-a-faithless-love-p97mamio8) (`62acd3af-e552-4227-8f3a-44a96b99a25c`) | 200 / 200 | 302，相对Location正确 | 200 / no-store / robots正确 | 0 / 0 | PASS |
| 3 | [seventeen-stolen-papers-and-seven-days-left](https://pulsenovels.com/novel/seventeen-stolen-papers-and-seven-days-left-p0zswdg2q) (`931bbe3e-17bd-48f5-84de-e786581817a9`) | 200 / 200 | 302，相对Location正确 | 200 / no-store / robots正确 | 0 / 0 | PASS |
| 4 | [bound-to-the-cuckold-revenge-system](https://pulsenovels.com/novel/bound-to-the-cuckold-revenge-system-put0wsbu6) (`ca5796e1-e3e4-4b39-add1-987e21b2cd98`) | 200 / 200 | 302，相对Location正确 | 200 / no-store / robots正确 | 0 / 0 | PASS |
| 5 | [demoted-husband-departed-soul](https://pulsenovels.com/novel/demoted-husband-departed-soul-peer2q0k3) (`f8d872b0-8171-4c26-b719-6d7045267696`) | 200 / 200 | 302，相对Location正确 | 200 / no-store / robots正确 | 0 / 0 | PASS |

五本每个书页和章节页均有实际CTA锚点，文案Read on PlotNovel App，小字Free app · your book code is on the next page；锚点均为文章正文绑定的站内/go码，canonical逐字匹配。各书3个真实试读链接，抽取第1章reader-body非空。/go均302到相对路径/go/<同站内码>/app，未跟随；单独GET中间页均200、Cache-Control含no-store、robots恰为noindex/nofollow/nocache。

五个中间页口令卡片与本书数据库值在临时内存逐项比较为true，复制按钮Copy code、三步说明和两个商店按钮均PASS；Apple id6749878264、Google Play com.plot.novel_app与Owner给定值一致；免责文字匹配0。卡片值、原始HTML、章节内容、MoboReader Location明文均不保存、不输出。只检查SSR DOM及响应，不声称执行了浏览器剪贴板点击或商店安装。

HTML与XML以本批50个真实上游码做逐行包含计数，并检查HTML entity/Next unicode转义形态；书页5、章节5、sitemap索引1/相关去重分片5、首页1均匹配0。口令只在独立SSH检查器服务器内存与被检中间页临时内存中出现，stdio仅传响应正文并返回计数/布尔，不回传DB码。原始响应不写文件、不截图。中间页仅校验本书卡片正确且其它书码0；它本身展示口令是预期，不以0码作为该页判据。

首页200，featured-hero轮播中PlotNovel匹配0，数据库serving快照也为0；不把首页其它合法书格混作轮播。外部sitemap索引和五个English分片均200，覆盖固定5书及它们全部15章，不含/go URL。

MoboReader同一个/go/hpsuxf95w4前后均302，Location SHA256均为cd3e05e05efaaf1b87106c931bc37d8852f5881773ac88cad333b7723acbb2e5，完全一致。

## 请求明细与只读收尾

累计29/30次主动外部GET，全部显式proxy http://127.0.0.1:7899 / noproxy空 / retry0，不跟随跳转，不另发HEAD。1次旧Mobo基线+本轮28次：5书/文章、5章节、5go、5中间页、1Mobo回验、1sitemap索引、5分片、1首页。逐条时间、URL、类型见external-requests.jsonl；每次的状态/受控头检查/布尔与计数见c2-public-result.json。试读/IndexNow worker调用另按任务计数，没有占用该主动验收预算。

收尾再次确认50篇英语已发布、50本各3章有效试读、IndexNow50/50 accepted，熔断关闭、无429等待、due0/deadLetter0/无在途投递批次。claimPromo/getlistpc仍disabled，两项试读enabled；635个人审的ID/status/response_shape摘要与丙1逐字一致。所有容器CID与丙1重建后的记录一致、四应用healthy、backup-timer running，Final/env摘要不变。

辅助检查如实留证：34首次把正常processing过早当终态断言，34a/34b只读等待到completed；35辅助脚本引用转义错误在执行检查前失败，35a修复后通过50/150精确覆盖，无刷新重提。36复用丙1脚本时错误附带“全剧场推广聚合摘要跨阶段必须不变”断言；该聚合包含全部推广和updated_at，丙1基线早于Owner后续操作，并非本轮前置快照，因此不适用作丙2门禁。36a保留两个摘要及不一致事实，按原丙2门禁核对635个人审摘要、能力、50篇/试读/IndexNow和服务身份；不声称全剧场推广跨阶段未变，不归因该差异，也没有为消除差异修改任何推广。原始门禁未削弱；未改业务数据或重跑HTTP。

## 后续边界

阶段丙在Owner修订后的范围内验收PASS，2026-10-15 15:50:13 JST完成公开抽查。PlotNovel已开通已有口令码书的试读与公开发布链路；领码保持关闭、635个人审等待上游答复，未恢复getcode，未补码/人工收口。后续放量由Owner或运营后台执行，单批不超过500篇，不在本会话执行。不开启getlistpc、不撤回既有页面、不回退镜像或数据。
