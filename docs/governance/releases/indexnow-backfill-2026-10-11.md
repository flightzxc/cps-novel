# IndexNow 存量回填第一次放行（2026-10-11 JST）

状态：**第一次放行验收 PASS，试推 500 篇完成；第二次放行未执行。** Owner 授权仅覆盖本次 500 篇。B-41 方案 §6、附录 C、[ADR](../../adr/ADR-B41-INDEXNOW-BATCH-DELIVERY.md)、三个脚本文件头及线上 `--help`、[v0.5.15 F.2](v0.5.15-preproduction.md#f2-首次发布补核通过2026-10-11-0333-jst) 均已核对。公开网址冻结继续遵守。

## 执行边界与运行方式

- 线上 `0.5.15` / Final `db623505539c3ca55f55b1270aab829b8db102d7`，health database / metadataConsistency passed；worker-light GIT_COMMIT 同值，数据库角色 `worker_app`。
- deploy 身份通过 `ssh -o KexAlgorithms=curve25519-sha256 haiyue-vps`；实际容器 `cps-novel-worker-light-1`、计数容器 `cps-novel-postgres-1`。所有运维命令前台执行，docker exec 不加 -i，stdin 接 /dev/null，stdout/stderr 落主机日志，末行 EXIT。
- 只有第 4 步写库、只有该 docker exec 临时带 `INDEXNOW_BACKFILL_ALLOW_WRITE=true`。执行前后四个出站/投递开关均 true，容器自身回填写闸均不存在（printenv EXIT=1 是预期不存在，不是失败）。没有改代码、env、开关、白名单、nginx、公开网址，没有重启或重建服务，没有手工 SQL 写入、删除或重置记录，没有恢复熔断。
- 本机代理抽样三次，全部显式 `--proxy http://127.0.0.1:7899`，不跟随跳转、不重试；HTML 仅存 .tmp，不进 Git。完整清单只在主机及容器中，不进 Git。

## 第 0–1 步：只读前置与 N 确认

前置状态：breaker closed、无 429 wait、deadLetters=0、dueUrls=0、keyValidation=verified、无在途批次。article.publish.* / article.generate.* pending 或 processing 任务为 0。

PostgreSQL 独立计数使用 REPEATABLE READ / READ ONLY，transaction_read_only=on；文章口径 status=published / deleted_at IS NULL，outbox 按篇 EXISTS 判重，含任何 source/status/revision。当前全部为 novel_article，没有博客导致的口径差异。

**N=30,807 − 6 = 30,801**；count-only count=30801，scanned=30807、alreadyHasDelivery=6、ineligible=0、eligible=30801。两个独立口径完全一致，按 Owner 明确规则将此 N 视为已确认，没有用历史约数替代实际计数。

| 语种 | published | 有 outbox 的篇数 | 独立 N |
|---|---:|---:|---:|
| ALL | 30807 | 6 | 30801 |
| ar | 39 | 0 | 39 |
| de | 852 | 0 | 852 |
| en | 14076 | 3 | 14073 |
| es | 2795 | 0 | 2795 |
| fr | 2622 | 2 | 2620 |
| id | 1614 | 0 | 1614 |
| ja | 648 | 0 | 648 |
| ko | 782 | 0 | 782 |
| pl | 126 | 0 | 126 |
| pt-BR | 2435 | 1 | 2434 |
| ru | 2986 | 0 | 2986 |
| th | 986 | 0 | 986 |
| vi | 828 | 0 | 828 |
| zh-Hant | 18 | 0 | 18 |

切换时间 `2026-10-07T10:39:15Z`：候选中切换前发布 **28745** 篇、切换后 **2056** 篇、publishedAtMissing=0；按语种统计见 count-only 原始日志。切换前文章首次在正式域名公开的时间依 B-41 Owner 裁决为切换时刻，本次没有改其发布时间或网址。

## 第 2–3 步：清单归档与预演

- 生成命令：`tsx scripts/indexnow-backfill-manifest.ts --expected-count 30801 --cutover-at 2026-10-07T10:39:15Z --output /tmp/indexnow-backfill-20261011.json`，EXIT=0；生成后立即 docker cp 到主机。
- 主机路径：`/opt/cps-novel/shared/indexnow-backfill/20261011/indexnow-backfill-20261011.json`；条目 count=expected_count=entries.length=30801，schema_version=2，release_commit 为上述完整 Final。
- **文件 SHA256**：`54d8c26f61a4f4ea5ae8881bcd88d3b6e67c7a706bf3acea857770d6c3585a5b`；主机和容器文件一致，收尾重新读取主机文件同摘要。
- **清单 content_sha256**：`672a513641b42b99609147b3e31c14e1e94f43993bb985f896798695804a1de8`；这是脚本内部规范化 payload 的摘要，与文件字节 SHA256 区分记录。apply 的完整性校验通过。
- 预演：`tsx scripts/indexnow-backfill-apply.ts --manifest /tmp/indexnow-backfill-20261011.json --limit 500 --canary-locales en,ja,ru,pl,ar,zh-Hant`，没有 --confirm 或回填写闸；EXIT=0，可推 **500**、漂移 **0**、已有记录 **0**、写入 **0**、HTTP 请求 **0**。

选样按文章 ID 排序、六语种轮询，预演与试推同组：en=111、ja=111、ru=111、pl=110、ar=39、zh-Hant=18，共 500。

## 第 4 步：唯一一次 500 篇试推

```bash
docker exec -e INDEXNOW_BACKFILL_ALLOW_WRITE=true cps-novel-worker-light-1 tsx scripts/indexnow-backfill-apply.ts --manifest /tmp/indexnow-backfill-20261011.json --limit 500 --canary-locales en,ja,ru,pl,ar,zh-Hant --confirm </dev/null
```

EXIT=0；chunks=1、selectedUrls=eligibleUrls=enqueuedUrls=acceptedUrls=accepted200Urls=500、httpRequests=1。accepted202Urls / driftedUrls / alreadyHasDeliveryUrls / duplicateUrls / ineligibleUrls / disabledUrls / notAcceptedUrls / cancelledUrls 均 0。

- request_batch_id：`392aefcf-b923-41cc-8fb6-339d50beccbd`；HTTP **200**；500 条 completed/accepted attempts 共用该批次，batch_size=500。
- 请求时间 UTC：`2026-10-10T18:57:04.051+00:00`。
- 接受响应完成 UTC：`2026-10-10T18:57:05.624+00:00`；JST：`2026-10-11T03:57:05.624+09:00`。
- 关联任务 `a851f294-5bc1-4ac9-9390-437570d71e46` completed、total=success=1 / failed=0；条目 `796530b8-a13a-418b-9bae-8dd8d897079e` indexnow_batch / success，完成时间 UTC `2026-10-10T18:57:05.657111+00:00`。
- 脚本 chunk elapsedMs=32629（约 32.6 秒，比预估 1–3 分钟快，满足不超过 10 分钟）。人工另核 acceptedRows=500、cancelledRows=0；全站死信及格式/域名错误取消记录为 0，未触发任何停止条件。

## 第 5 步：试推后只读验收

| 指标 | 前 | 后 | 增量 |
|---|---:|---:|---:|
| accepted URLs | 6 | 506 | 500 |
| distinct HTTP requests | 4 | 5 | 1 |
| HTTP200 URLs / requests | 5 / 3 | 505 / 4 | 500 / 1 |
| HTTP202 URLs / requests | 1 / 1 | 1 / 1 | 0 / 0 |
| 成功批量任务条目 | 4 | 5 | 1 |
| 到期积压 / 死信 | 0 / 0 | 0 / 0 | 0 / 0 |

前后熔断均关闭、无 429 等待、keyValidation 均 verified、无在途批次、无取消或 invalid URLs。分钟扫描任务与批量投递任务分开：scan success 771→773，不能当成 HTTP 请求数。完整脱敏 status 前后输出保存于证据目录。

从该批通过只读 SQL ORDER BY random() 抽样三条，先从 ar/zh-Hant 随机取一条，再从其余记录随机取两条；抽样均在同一已验收批次内。

- ar / `e866f27f-74cf-45c8-8eea-f5ece3128643`：[原网址](https://pulsenovels.com/ar/novel/%D8%A7%D9%84%D8%B9%D9%88%D8%AF%D8%A9-%D8%A7%D9%84%D9%85%D8%B0%D9%87%D9%84%D8%A9-%D9%84%D9%84%D8%B2%D9%88%D8%AC%D8%A9-%D8%A7%D9%84%D9%85%D9%86%D8%A8%D9%88%D8%B0%D8%A9-%D8%B0%D8%A7%D8%AA-%D8%A7%D9%84%D9%87%D9%88%D9%8A%D8%A9-%D8%A7%D9%84%D8%BA%D8%A7%D9%85%D8%B6%D8%A9-pbc5w8cmp)；HTTP 200；canonical 逐字等于网址；只请求 1 次。
- pl / `28e67868-c71c-4aad-8984-16afa03badf7`：[原网址](https://pulsenovels.com/pl/novel/odrzucona-luna-powraca-jako-najwy%C5%BCszy-bia%C5%82y-wilk-pp1ai0sol)；HTTP 200；canonical 逐字等于网址；只请求 1 次。
- en / `fda33af0-a9a0-406a-945c-b733f1c2bd0c`：[原网址](https://pulsenovels.com/novel/le-13e-hussards-types-profils-esquisses-et-croquis-militaires-%C3%A1-pied-et-%C3%A1-cheval-pfmc9y94l)；HTTP 200；canonical 逐字等于网址；只请求 1 次。

## 给运营的观察时间点与第二次放行前提

可开始查看 Bing Webmaster → IndexNow，siteUrl=`https://pulsenovels.com/`：**UTC 2026-10-10T18:58:56.421821+00:00 / JST 2026-10-11T03:58:56.421821+09:00**。本次记录了可观察时间点，没有代运营登录或声称 Bing 已抓取、已收录。

第二次放行仍为待办，必须 Owner 另行授权，并观察至少约一天的 Bing 提交/抓取数据及 HTTP200/202 分布。按本批响应完成时间，至少一天对应 UTC `2026-10-11T18:57:05.624Z` / JST `2026-10-12T03:57:05.624+09:00`。

- 主机上的清单文件必须仍在，并核对文件摘要及完整性。
- 清单 release_commit 必须等于届时线上 GIT_COMMIT；若期间发新版本，重新生成清单，已推文章由原脚本按篇自动跳过，不能修改旧清单绕过版本检查。
- 再次核对线上状态、业务在途任务及原写入门禁。本次未执行整份清单、未执行第二次放行、未执行 indexnow-delivery-resume。
- 清单原计数 30801；本次已推 500，按当前无其他变化估算剩余 30301，不能将此估算当作下一次的实时确认数量。

## 治理与证据

原始 stdout/stderr/EXIT、只读 SQL、结构化结论及文件摘要见 [证据目录](evidence/indexnow-backfill-2026-10-11/)，主机日志统一在 `/opt/cps-novel/shared/indexnow-backfill/20261011/`；`.tmp/indexnow-backfill-20261011/` 留有运维包装器及页面临时产物。整份清单未进入仓库。

异常及恢复：**无真实门禁失败，无重跑，无熔断恢复，无包装器恢复。** 预期未设置环境变量的 printenv EXIT=1 已明确处理为 ABSENT。两个 CPS 参考仓 HEAD / git status --porcelain=v1 与任务开始前逐字一致；没有本机重型任务或重型锁。

在 release/v0.5.15-2026-10-10 追加一个文档提交（Agent: codex / Model: GPT-6），CHANGELOG 仅由指定七位 SHA 环境参数运行生成器更新；提交后推送并回读，再向海阅 Notion 手账追加一条本次运维记录并回读。Git/Notion 回读收据留在主机同目录和 .tmp，最终回报给出实际提交及同步结果；本文与 result.json 记录技术验收已完成。
