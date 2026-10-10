# 海阅 IndexNow 生产开闸运维记录（2026-10-10）

## 当前状态

**阶段 0 PASS；阶段 1 配置已生效，首次发布观察待补；delivery 关闭；阶段 2 未执行。**

Owner 本会话明确请求实施已核对的分阶段计划，授权阶段 0～1。另确认首次 HTTP 422 即回关，阶段 1 的首次发布观察完成后才能进入阶段 2；阶段 2 仍须 Owner 明确说“继续阶段 2”。

- 配置变更开始：2026-10-10 14:08:45.688730 JST（05:08:45.688730Z）。
- 配置读回完成：2026-10-10 14:09:18.949425 JST（05:09:18.949425Z）。
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

### 首次发布观察：待补

配置完成时 outbox、attempt、sweep schedule 仍均为 0。已请 Owner 或运营在后台首次发布 1～3 篇合格文章，并提供文章 ID 或页面网址；执行者未代发布。观察未完成，不标记整个阶段 1 已验收，也不进入阶段 2。

补验须满足：每篇一条 pending outbox、正确 locale/revision、无 hidden 或重复、URL 等于正式域 canonical，对应 pending delivery 任务及条目；attempt 和 sweep schedule 相对零基线无新增。每篇页面各取样一次，总外部取样预算不超过 10。

## 阶段 2 前提、判据与回关

阶段 2 未授权、未执行。首次发布观察补齐后，仍须 Owner 明确说“继续阶段 2”。重新检查最新 env SHA、站点设置、空闲窗口；同一配置单元开启 delivery 双闸、登记 `indexnow_delivery`、仅向 light 追加 delivery 类型。开闸期间不做超过 100 篇的批量首次发布。

配置生效及回关均按 WO6：先停止 scheduler 新入队和 worker-light 消费，按既有 SIGTERM/drain 流程等待在途完成，整组配置就绪后恢复；不得宣称已发送的 HTTP 能被撤销。第一、六、十二分钟取三份 SQL 快照，间隔中检查异常。

首次 403 或 422、config_missing、错误 URL/canonical、配置未一致生效、终态失败率超过 5% 或 pending 连续增长：立即停止并整体回关 delivery。终态失败率按本窗口发生投递的不同 outbox 计算：permanent_failed/dead_letter 数量 ÷ 已发生投递 outbox 数量；无投递时为尚未验收。

### 回关执行方法

1. 优先停止 scheduler 与 worker-light；等待在途请求和数据库提交结束，保留所有记录。
2. 校验当时 env SHA并备份；同次将 `FEATURE_INDEXNOW_DELIVERY`、`INDEXNOW_DELIVERY_ALLOW_WRITE` 改为 false，撤销 delivery 登记，从 light 白名单移除 delivery 类型；不改其它登记或白名单。
3. 使用既有 manifest、重新加载 env、preflight PASS 后，重建 worker、worker-light、scheduler，显式等待健康及镜像身份 PASS。
4. 核对关闭双闸、light 不含 delivery、main 无两种 IndexNow 类型；后续分钟零新扫描、无新 HTTP。
5. outbox 默认保留开启；若 outbox 数据本身异常，同步关闭 outbox 双闸并撤销登记，重建 web、worker、worker-light。不得删任务或重置 retry 制造健康。
6. 阶段 1 单独回关时，先核对无 env 漂移；只恢复本次三行（或在确认当前 SHA 完全等于本记录阶段 1 后值时恢复本次备份），preflight PASS 后重建上述三个服务。

## 证据与治理

证据目录：[indexnow-opening-2026-10-10](evidence/indexnow-opening-2026-10-10/)。包含只读核查及原调用失败、受限 diff/cmp/SHA 链、preflight、重建及镜像身份、容器读回、发布观察状态、公开请求账本；没有密钥原文或完整 env。

本次只追加配置运维记录和 v0.5.14 快照，不新增版本、修改 Final tag、重新生成 CHANGELOG 或增加正式发版级 development-log 条目。Git 文档推送回读及 Notion 手账同步回读的收据另存于证据目录；首次发布观察仍待 Owner/运营安排。

- Git 首份治理提交 `b5f376b4bf515aa3ec283eddf04d6c55149aea8e` 已推送并回读 PASS；release 分支远端一致，v0.5.14 annotated tag peeled 仍为批准 Final。收据：`github-readback.json`。
- Notion [海阅版本管理与发版手账](https://app.notion.com/p/3e4601b5fd3481b5a39bcf48408015c2) 当前快照及本次开闸条目已同步，2026-10-10 14:13:04.885 JST（05:13:04.885Z）回读 PASS；去除本次新增条目和快照追加句后，原历史/规则/模板正文一致。收据：`notion-readback.json`。
- 阶段 1 配置已生效；首次发布观察仍待补。阶段 2 未执行，delivery 仍关闭；没有首批 accepted URL。
