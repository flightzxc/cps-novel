# 海阅 IndexNow 生产开闸运维记录（2026-10-10）

## 当前状态

**阶段 0～2 全部 PASS；outbox 已开，三篇首次发布观察已完成，delivery 已验收并保持开启；未触发回关。**

Owner 本会话明确请求实施已核对的分阶段计划，先授权阶段 0～1；三篇首次发布观察通过后，另行明确请求“继续阶段 2”。本次采用 Owner 当前口径：HTTP 200/202 都算接受；任意一次 403/422 即整组回关。附件旧提示词“422 不超过 3 次”的容忍条件已由 Owner 的首次 422 即回关决定覆盖。重复的阶段 2 请求归并为同一次切换。

- 配置变更开始：2026-10-10 14:08:45.688730 JST（05:08:45.688730Z）。
- 配置读回完成：2026-10-10 14:09:18.949425 JST（05:09:18.949425Z）。
- 首次发布观察完成：2026-10-10 14:50:41.699193 JST（05:50:41.699193Z）。
- 正式站：`pulsenovels.com`，目标机仅 `haiyue-vps`；版本仍为 v0.5.14，Final `bf61b5ea276a0981870cdfa63578a822a65836f3`。
- 镜像仍为 `cps-novel:0.5.14-bf61b5e`，既有 manifest 的 descriptor、平台、revision 和运行容器身份核对均 PASS。
- 没有发新版本、build/pull 镜像、执行迁移、手工 SQL 写入、修改 nginx 或公开网址、存量回填、删除或重置任何记录。

## 阶段 0：只读前置核查

核查时刻：2026-10-10 14:06:56.661692 JST（05:06:56.661692Z）。

| 项目 | 结果 |
| --- | --- |
| 当前检出、health、五容器 | current 为批准 Final；health healthy / 0.5.14 / Final / metadata/database passed；web、worker、worker-light、scheduler、postgres healthy |
| env 前置 SHA256 | 与 v0.5.14 部署后值一致，见下方 SHA 链 |
| SiteSetting | singleton id=1；host=`pulsenovels.com`；keyLocation=`https://pulsenovels.com/indexnow-key.txt`；key 长度及有效长度均 32；仅哈希取证 |
| 公开 key route | 200，`Cache-Control: no-store`，响应体 32 字节；SHA256 与数据库有效 key 相同；没有打印或保存 key 原文 |
| 四个开关与登记 | 四项 false；仅原 catalog/promo/sitemap/auto_tag 登记，无 IndexNow 登记 |
| worker 通道 | light 含 `indexnow.sweep.v1`、不含 `indexnow_delivery`；main 不含两者；env 与实际容器一致 |
| SEO visibility | web、worker、worker-light 均 true；scheduler 不带 outbox 双闸 |
| 基线 | outbox=0、attempt=0、两种 IndexNow 任务及条目=0、sweep schedule=0，无存量待投递记录 |
| 空闲窗口 | article.publish.* / article.generate.* pending/processing=0，processing item=0，running batch=0 |
| preflight | public、IMAGE descriptor、worker lanes、secrets、write gates、完整 preflight 全 PASS |
| 同版本 X11 | v0.5.14 第一阶段已有 WO6 真实库链路 20 passed / 0 skipped，WO6_INTEGRATION、POSTGRES_VERIFICATION PASS，dictionary drift=0；本次未重跑或在生产模拟投递 |

首轮只读调用遗漏从 manifest 注入 `GIT_COMMIT`，preflight 返回 `reason=git_commit`。这属于执行包装器调用错误，未改变生产。补齐既有 manifest 读取及身份导出后重新核查 PASS；原失败记录保留，没有修改或绕过 preflight。

## 阶段 1：配置与服务读回

### 唯一 env 变更与 SHA 链

生产 env：`/opt/cps-novel/shared/env/preprod.env`。

```diff
-FEATURE_INDEXNOW_OUTBOX=false
-INDEXNOW_OUTBOX_ALLOW_WRITE=false
-PREPROD_APPROVED_OPEN_WRITE_GATES=catalog_write,promo_write,sitemap_write,auto_tag_write
+FEATURE_INDEXNOW_OUTBOX=true
+INDEXNOW_OUTBOX_ALLOW_WRITE=true
+PREPROD_APPROVED_OPEN_WRITE_GATES=catalog_write,promo_write,sitemap_write,auto_tag_write,indexnow_outbox
```

- 备份：`/opt/cps-novel/shared/env/preprod.env.bak-indexnow-stage1-20261010T050845Z`，写入前验证与旧 env 字节相同。
- 变更前 SHA256：`c4c49569eb2fbbb5b14d7ba827b59770cc562de3706383ad404ddd9d8bc0da6c`。
- 变更后 SHA256：`6ee8e8dbbe27b0512d4118ddcb2c8dd198b442a054302584e1b79119b4ca7d58`。
- 在临时副本还原上述三行原始字节后，对备份运行真实 `cmp`：PASS；其余字节和两个白名单不变。
- 下一阶段必须以阶段 1 的变更后 SHA 为前置，不能再次要求初始部署 SHA。
- 修改后 preflight：public / IMAGE / worker lanes / secrets PASS；approved 和 open 同时包含 `indexnow_outbox`，不含 `indexnow_delivery`。

### 服务重建与验收

使用既有 lib helper、既有 manifest，重新加载 env，通过 `preprod_compose_app_up` 的 `--no-deps` 路径，依次重建并显式等待健康及核对镜像身份。每次重建前均重复只读空闲窗口门禁，全部为 0。

| 服务 | 重建完成 JST（UTC） | 读回 |
| --- | --- | --- |
| web | 14:09:01.896982（05:09:01.896982Z） | healthy；outbox 两项均 true；镜像身份 PASS；error=0、permission denied=0 |
| worker | 14:09:10.105917（05:09:10.105917Z） | healthy；outbox 两项 true、delivery 两项 false；白名单不变、invalid=[]；镜像身份 PASS；error=0、permission denied=0 |
| worker-light | 14:09:18.086093（05:09:18.086093Z） | healthy；outbox 两项 true、delivery 两项 false；含 sweep、不含 delivery、invalid=[]；镜像身份 PASS；error=0、permission denied=0 |
| scheduler | 未重建 | CID 和 StartedAt 均不变；不带 outbox 双闸；delivery 两项 false |
| postgres | 未重建 | CID 和 StartedAt 均不变；healthy |

重建后内部及公开 health 均为 healthy / 0.5.14 / Final。公开取样经 `http://127.0.0.1:7899`，共 2 次（key route、health），无自动重试或跟随跳转；自动 IndexNow 外呼=0。

### 首次发布观察：PASS（Owner 提供三篇网址后补验）

配置完成时 outbox、attempt、sweep schedule 均为 0，最初停在观察待补。Owner 随后安排首次发布并提供三篇页面网址；执行者未代发布。三篇在 2026-10-10 14:39:54 JST（05:39:54Z）发布，本次只读补验完成于 14:50:41.699193 JST（05:50:41.699193Z）。

| 页面 short ID | locale | article ID | outbox / delivery 任务 / 条目 | HTTP / canonical |
| --- | --- | --- | --- | --- |
| pn8w150zv | en | 2a20c872-a938-4188-be05-886fa9cca3d7 | 各 1 条，均 pending | 200，无跳转，与 outbox URL 完全一致 |
| p2j93jiyj | en | 9e45f0d5-f9c8-4d61-93a1-c0673460e4ee | 各 1 条，均 pending | 200，无跳转，与 outbox URL 完全一致 |
| p48zq4bs4 | fr | bc10e6c5-7c3f-4b65-92f2-4b6fb72e0d25 | 各 1 条，均 pending | 200，无跳转，与 outbox URL 完全一致 |

三篇都是 published / novel_article / seoVisibility=public；outbox locale 与文章及 HTML lang 一致，revision 与文章 updatedAt 的毫秒时间戳一致，无 hidden、无重复。投递条目 targetType=indexnow_outbox、targetId 与 outbox ID 一致。总 outbox=3、pending delivery 任务=3、attempt=0、sweep schedule=0，均无新增外呼或扫描。web/worker/worker-light 自重建以来 error/permission denied 仍为 0；worker/worker-light/scheduler delivery 双闸读回均 false，主通道不含两种 IndexNow 类型，light 不含 delivery，env SHA 不变。

每篇页面仅取样一次，经既有代理、无重试或跟随跳转；本轮累计外部取样 5 次（原 2 次加本次 3 次），仍在 10 次预算内。原“待补”SQL 快照和原 Notion 回读收据保留为历史。新增证据：`phase1-first-publish-readonly.log`、`phase1-first-publish-canonical.json`、`phase1-first-publish-result.json`。

核对的网址：

- https://pulsenovels.com/novel/his-luna-by-mistake-a-mother-by-fate-pn8w150zv
- https://pulsenovels.com/novel/the-enforcers-sin-stolen-by-my-fathers-best-friend-p2j93jiyj
- https://pulsenovels.com/fr/novel/les-epouses-du-manoir-vane-p48zq4bs4

## 阶段 2 前提、判据与回关

阶段 2 已获 Owner 单独授权并执行。前置重验 env SHA、站点设置、首次发布观察、空闲窗口、既有 manifest/preflight 全 PASS；基线为 3 条 pending、attempt=0、sweep=0。同一配置单元开启 delivery 双闸、登记 `indexnow_delivery`、仅向 light 追加 delivery 类型。开闸观察期间无新增首次发布，未执行超过 100 篇的批量首次发布。

配置生效及回关均按 WO6：先停止 scheduler 新入队和 worker-light 消费，按既有 SIGTERM/drain 流程等待在途完成，整组配置就绪后恢复；不得宣称已发送的 HTTP 能被撤销。第一、六、十二分钟取三份 SQL 快照，间隔中检查异常。

首次 403 或 422、config_missing、错误 URL/canonical、配置未一致生效、终态失败率超过 5% 或 pending 连续增长：立即停止并整体回关 delivery。终态失败率按本窗口发生投递的不同 outbox 计算：permanent_failed/dead_letter 数量 ÷ 已发生投递 outbox 数量；无投递时为尚未验收。

### 回关执行方法

1. 优先停止 scheduler 与 worker-light；等待在途请求和数据库提交结束，保留所有记录。
2. 校验当时 env SHA并备份；同次将 `FEATURE_INDEXNOW_DELIVERY`、`INDEXNOW_DELIVERY_ALLOW_WRITE` 改为 false，撤销 delivery 登记，从 light 白名单移除 delivery 类型；不改其它登记或白名单。
3. 使用既有 manifest、重新加载 env、preflight PASS 后，重建 worker、worker-light、scheduler，显式等待健康及镜像身份 PASS。
4. 核对关闭双闸、light 不含 delivery、main 无两种 IndexNow 类型；后续分钟零新扫描、无新 HTTP。
5. outbox 默认保留开启；若 outbox 数据本身异常，同步关闭 outbox 双闸并撤销登记，重建 web、worker、worker-light。不得删任务或重置 retry 制造健康。
6. 阶段 1 单独回关时，先核对无 env 漂移；只恢复本次三行（或在确认当前 SHA 完全等于本记录阶段 1 后值时恢复本次备份），preflight PASS 后重建上述三个服务。

## 阶段 2：delivery 开启与生产验收

- 开始：2026-10-10 15:04:58 JST（06:04:58Z）。
- env 变更：2026-10-10 15:05:08 JST（06:05:08Z）；全部消费者配置读回完成：2026-10-10 15:05:40 JST（06:05:40Z）。
- 12 分钟验收完成：2026-10-10 15:17:43 JST（06:17:43Z）。观察程序从消费者重建开始检查 stop condition，服务启动等待期间也持续检查；完整生效后约每 5 秒只读检查数据库及配置，按分钟检查 pending 增长。
- 备份：`/opt/cps-novel/shared/env/preprod.env.bak-indexnow-stage2-20261010T060508Z`。
- SHA 链：`6ee8e8dbbe27b0512d4118ddcb2c8dd198b442a054302584e1b79119b4ca7d58` → `95c3020a42459af6850fe67a87b2fced886ac25be888f5d555f5cf910412bae7`；恢复指定四行后真实 `cmp` PASS，其余字节相同。

```diff
-FEATURE_INDEXNOW_DELIVERY=false
-INDEXNOW_DELIVERY_ALLOW_WRITE=false
-PREPROD_APPROVED_OPEN_WRITE_GATES=catalog_write,promo_write,sitemap_write,auto_tag_write,indexnow_outbox
-WORKER_LIGHT_TASK_ALLOWLIST=sitemap_refresh,sitemap.daily_fallback.v1,home_carousel.compute.v1,indexnow.sweep.v1,article.publish.batch.v1,article.publish.v1
+FEATURE_INDEXNOW_DELIVERY=true
+INDEXNOW_DELIVERY_ALLOW_WRITE=true
+PREPROD_APPROVED_OPEN_WRITE_GATES=catalog_write,promo_write,sitemap_write,auto_tag_write,indexnow_outbox,indexnow_delivery
+WORKER_LIGHT_TASK_ALLOWLIST=sitemap_refresh,sitemap.daily_fallback.v1,home_carousel.compute.v1,indexnow.sweep.v1,article.publish.batch.v1,article.publish.v1,indexnow_delivery
```

变更前后 preflight 均 PASS（public、写闸登记、worker lanes、镜像 descriptor、权限）。先停止 scheduler 与 worker-light；两个旧容器均优雅退出 exit=0，全部在途条目/发布生成任务/运行批次为 0。随后重新加载 env 与既有 manifest，依次重建 worker、worker-light、scheduler，每个显式等待 healthy 并核对镜像身份。web 与 postgres 的 CID/启动时间保持不变。

三个消费者 delivery 双闸均为 true；web/worker/worker-light outbox 双闸及 SEO visibility 仍 true，scheduler 不带 outbox 双闸。轻量 requested/effective 白名单只新增 delivery，保留 sweep，invalid=[]；主通道两种 IndexNow 类型均不存在。各应用自启动 error/permission denied 均为 0，公开 health 200 / healthy / 0.5.14 / Final。

| 快照 | 实际保存 JST（UTC） | accepted / pending | 自动 HTTP 总数 | sweep 分钟桶 | 403/422 / config_missing / 终态失败 |
| --- | --- | --- | --- | --- | --- |
| 约第 1 分钟（64s） | 2026-10-10 15:06:44 JST（06:06:44Z） | 3 / 0 | 3 | 2 | 0 / 0 / 0 |
| 约第 6 分钟（361s） | 2026-10-10 15:11:41 JST（06:11:41Z） | 3 / 0 | 3 | 7 | 0 / 0 / 0 |
| 约第 12 分钟（723s） | 2026-10-10 15:17:43 JST（06:17:43Z） | 3 / 0 | 3 | 13 | 0 / 0 / 0 |

| 首批 URL | locale | HTTP | 接受时间 JST（UTC） |
| --- | --- | --- | --- |
| https://pulsenovels.com/fr/novel/les-epouses-du-manoir-vane-p48zq4bs4 | fr | 202 | 2026-10-10 15:05:29 JST（06:05:29Z） |
| https://pulsenovels.com/novel/the-enforcers-sin-stolen-by-my-fathers-best-friend-p2j93jiyj | en | 200 | 2026-10-10 15:05:29 JST（06:05:29Z） |
| https://pulsenovels.com/novel/his-luna-by-mistake-a-mother-by-fate-pn8w150zv | en | 200 | 2026-10-10 15:05:30 JST（06:05:30Z） |

共 3 次真实自动 IndexNow 请求，每次 1 个 URL；HTTP 200 两次、202 一次，attempt 均 outcome=accepted / attemptState=completed；三个 delivery 任务 completed、条目 success。扫过 2026-10-10 15:05:00 JST（06:05:00Z） 至 2026-10-10 15:17:00 JST（06:17:00Z） 共 13 个连续分钟桶，全部 enqueued、无 skip；最终 sweep 任务及条目均完成。pending 从 3 降到 0 后保持 0；终态失败率按本窗口投递的不同 outbox 计算，为 **0/3 = 0%**。无 403/422、config_missing、URL/canonical 错误、配置不一致或连续积压，未触发回关。全部记录保留，没有重发、删除、重置或存量回填。

当前状态为 **outbox 已开／首次发布观察已完成／delivery 已验收**。当前 env SHA 为 `95c3020a42459af6850fe67a87b2fced886ac25be888f5d555f5cf910412bae7`；未来任何配置变更或回关须以前述当前 SHA 为前置，先检查漂移并备份。开启后业务正常自动投递；本次 12 分钟观察已结束，没有新增长期监控配置。

公开取样累计 **7/10 次**，stage 2 新增 key route 与 health 各一次；自动投递 3 次单独统计，不计入人工取样预算。key route 再验 200/no-store，数据库有效 key 与响应体 SHA256 相同；证据只存长度/哈希，不保存原文。

运营此前在 Bing 后台没有看到提交时，delivery 仍关闭、attempt=0；该时刻没有本系统的 IndexNow 外呼。现在三篇的真实接口接受已核实，Bing 后台展示/最终收录尚未另行验收。依据 [IndexNow 官方协议](https://www.indexnow.org/documentation)，200 表示提交成功，202 表示已收到而 key 验证待处理；按 Owner 本次口径两者均通过。接受不保证立即抓取或收录，参见 [官方 FAQ](https://www.indexnow.org/faq)。

原始日志、三份快照、只读 SQL、SHA/diff/cmp、容器与日志读回、首批 accepted URL、取样账本均保存于本证据目录。阶段 0～1 历史日志和回读收据保持不变。

## 证据与治理

证据目录：[indexnow-opening-2026-10-10](evidence/indexnow-opening-2026-10-10/)。包含只读核查及原调用失败、受限 diff/cmp/SHA 链、preflight、重建及镜像身份、容器读回、发布观察状态、公开请求账本；没有密钥原文或完整 env。

本次只追加配置运维记录和 v0.5.14 快照，不新增版本、修改 Final tag、重新生成 CHANGELOG 或增加正式发版级 development-log 条目。Git 文档推送回读及 Notion 手账同步回读的收据另存于证据目录；阶段 1 首次发布观察现已补齐。

- Git 首份治理提交 `b5f376b4bf515aa3ec283eddf04d6c55149aea8e` 已推送并回读 PASS；release 分支远端一致，v0.5.14 annotated tag peeled 仍为批准 Final。收据：`github-readback.json`。
- Notion [海阅版本管理与发版手账](https://app.notion.com/p/3e4601b5fd3481b5a39bcf48408015c2) 当前快照及本次开闸条目已同步，2026-10-10 14:13:04.885 JST（05:13:04.885Z）回读 PASS；去除本次新增条目和快照追加句后，原历史/规则/模板正文一致。收据：`notion-readback.json`。
- 阶段 1 配置与首次发布观察全部 PASS；随后另获授权执行阶段 2，三个网址均 accepted，delivery 保持开启。
- 首次发布补验已同步 Notion 当前快照与本次开闸手账，2026-10-10 14:52:29.107 JST（05:52:29.107Z）回读 PASS；四处定点修改逐项验证，撤销这四处修改后其余正文保持一致。新增收据：`phase1-first-publish-notion-readback.json`；原待补收据保留为历史。

- 阶段 2 Notion 当前快照与独立验收手账已同步，2026-10-10 15:22:11.030 JST（06:22:11.030Z）回读 PASS；新增段仅有 Notion 的空括号转义和单个空行折叠，逐项验证内容后撤销两处定点修改，其余正文逐字一致。阶段 0～1 原手账改为历史标题保留。收据：`phase2-notion-readback.json`。

- 阶段 2 治理提交 `c98f648091b6568cc3843e67f13d2ba946f435b8` 已推送并回读 PASS，release 分支远端一致，tag object 与 peeled Final 不变；没有重新部署治理提交。收据：`phase2-github-readback.json`。收尾只读核对于 2026-10-10T06:31:31.227694+00:00（UTC；JST 2026-10-10 15:31:31）PASS：当前 env SHA 未变、outbox/delivery 均开启，四应用 healthy、health/镜像/Final 一致，三篇仍 accepted。收据：`phase2-closure-readonly.log`。
