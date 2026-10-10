# 海阅正式站 34 本试读重抓诊断（2026-10-10）

本次为 Owner 授权的运维诊断，不是发版。仅在 haiyue-vps 对指定的 34 个 source item ID 执行一次定向入队；没有修改代码、env、开关、白名单、nginx，也没有重启服务、下架、撤回或修改发布状态。公开网址冻结规则继续有效。Notion 不同步。

结果：新任务 **943f0f7f-1196-4792-b28f-2ea53bcdf7d1** 已以 `failed` 结束；34 个条目全部失败，没有成功书目，写入试读章节 **0 章**。与 10-07 相同的全部失败现象，本次已由 B-36 分解为两种确定的响应校验失败。

## 执行身份与前置检查

| 项目 | 实际结果 |
| --- | --- |
| 正式站 / 运行镜像 | haiyue-vps / `cps-novel:0.5.14-bf61b5e` |
| 当前发布目录 | `/opt/cps-novel/releases/bf61b5ea276a0981870cdfa63578a822a65836f3` |
| 执行容器 / 目录 / 数据库角色 | `cps-novel-worker-1` / `/app` / `worker_app` |
| 工具 | `scripts/preview-backfill-recovery.ts`；已先读文件头及 2026-09-18 恢复手册 |
| TypeScript 运行器 | 镜像全局安装的 tsx 4.21.0，Node 20.20.2；未安装或升级依赖 |
| 渠道应用 | `85c2fb3e-28f8-476a-83f2-9647e2206192` |
| 渠道账号 | `53f03fd8-951d-433e-ac66-784e82496a84` |
| 本次 request-id | `preview-diag-34-20261010`，执行前没有对应任务 |
| 源 ID 集合 | [source-item-ids.json](evidence/preview-diag-34-2026-10-10/source-item-ids.json)，与指定集合及 10-07 日志完全一致，34 个唯一 ID |
| 前置数据库检查 | `REPEATABLE READ READ ONLY`，`current_user=worker_app`，`transaction_read_only=on` |
| 34 本当前状态 | 全部 `novel.status=published`，无软删除、无试读章节、无 withdrawn 章节 |
| 上次试读条目 | 全部 `failed`，`code=upstream_preview_read_failed`，没有 B-36 的诊断 detail |
| 在途试读任务 | 全库 `moboreader.preview_refresh.v1` 的 pending / processing 任务为 0 |
| 生效中的试读暂停 | 该渠道关联账号的 active preview hold 为 0；任务结束后目标账号仍为 0 |
| 主 worker 白名单 | 包含 `moboreader.preview_refresh.v1` |
| 两项读取能力 | `getbydataid`、`getchapterinfo` 均 `enabled`，且 `side_effecting=false` |
| 凭据预检 | 调查及 apply 两次均为 `usable`，由 worker keyring 解密验证；没有输出凭据内容 |
| 调查规模 | `candidateCount=34`、`truncated=false`、`limit=34` |
| apply 入队规模 | 1 个任务、34 个条目、`eligibleCount=34`、无 skip reason |

调查与执行的完整参数见 [commands.txt](evidence/preview-diag-34-2026-10-10/commands.txt)。两次均保留 `--source-item-ids`；唯一生产写入口为同一命令追加 `--apply --confirm APPLY_PREVIEW_BACKFILL`。未复用旧 request-id，未直接执行业务 UPDATE/INSERT。

未另外发起运维 HTTP 请求。上游读取由授权任务沿既有 worker adapter 执行；没有修改该常驻进程的网络或环境配置。SSH 使用 `-o KexAlgorithms=curve25519-sha256`。

## 任务终态与时间

| 条目状态 | 数量 |
| --- | ---: |
| success | 0 |
| failed | 34 |
| skipped | 0 |
| pending | 0 |
| processing | 0 |

任务于 **2026-10-10 18:09:12.857 JST** 入队，18:09:13.303742 JST 开始，18:10:05.551007 JST 完成，执行耗时约 **52.25 秒**。前台等待期间只读查询了两次进度；34 个条目 `attempt_count` 都是 1，父任务统计与条目计数一致。

成功书目：**无**。新任务所有条目的 `source_fetch_id` 对应章节写入量均为 0；34 本当前可读试读章节仍为 0。

## B-36 实际落库结构

依据提交 `f258c5ce042e941bf648b45f2cebc970921e1772`。本仓 adapter 的实际路径为 `src/lib/adapters/moboreader.ts` 和 `src/lib/adapters/moboreader-failure-diagnostic.ts`，并非 `src/integrations/moboreader`；持久化投影位于 `worker/observability/preview-read-failure.ts`。

数据库没有新增失败类别列：实际列为 **`public.channel_sync_task_item.error`（jsonb）**。顶层本次仍是 `code=upstream_preview_read_failed`；新增诊断是 `error.detail` 内的扁平字段，最多 8 键。

| JSON 路径 | 本次出现条目数 | 本次值或用途 |
| --- | ---: | --- |
| `error.detail.kind` | 34 | 两种类别，见下表 |
| `error.detail.stage` | 34 | `getchapterinfo` |
| `error.detail.errorClass` | 34 | `MoboreaderAdapterError` |
| `error.detail.adapterCode` | 34 | `malformed_payload` |
| `error.detail.receivedType` | 34 | `null` / `empty_string`，是类型分类，不是内容 |
| `error.detail.chapterIndex` | 13 | 0 起算，1 或 2 |
| `error.detail.chapterOrdinal` | 13 | 上游行的 `i`，2 或 3 |
| `error.detail.chapterCount` | 13 | 返回数组长度，均为 3 |

`valueLength`、`retryable` 可出现在脱敏 worker 日志中，但不属于本次落库 detail 字段。13 个空正文事件的日志均为 `valueLength=0`。没有读取或保存任何正文、上游响应体、凭据、请求头或自由文本异常。

## 失败分类与代表字段

| kind | stage | 数量 | receivedType / chapterIndex | 代表 source item ID |
| --- | --- | ---: | --- | --- |
| `chapter_content_invalid` | `getchapterinfo` | 13 | `empty_string`；index=1 共 8 本，index=2 共 5 本 | `031216f8-1a1b-463b-856a-74b4712c889b`：index=1 / ordinal=2；`056374b0-ec90-4b5d-9543-aef5b081aeaf`：index=2 / ordinal=3 |
| `chapter_list_not_array` | `getchapterinfo` | 21 | `null`；没有 chapterIndex | `02b6dff3-d973-4922-ad43-d4ab61a895b5`、`0325c057-214b-46d1-a1f5-5f481e03d7b1` |

34 条落库诊断与同任务的 34 条 `preview_read_failed` 日志逐字段一致。任务时间窗内，上游观测日志为 `getbydataid` 34 次、`getchapterinfo` 34 次，全部 HTTP 200 / outcome=ok。上游观测本身没有 taskId，因此这 68 条只作时间窗佐证；逐条归因以带任务 ID 的 B-36 日志和数据库为准。

## 判断与建议（只提建议，本轮不实施）

| 类别 | 判断 | 建议 |
| --- | --- | --- |
| `chapter_content_invalid`（13 本） | **我方解析策略需要改进，上游空正文触发。** 当前 parser 逐行校验整个数组；一条空正文使整份响应失败，尚未进入物化。index=1/2 说明此前 1/2 条已通过逐行的序号、章节 ID 和非空正文检查，但不代表后续 bookId、语种、去重等整体验证已通过。 | 排进下一版 adapter 评估：与上游确认空正文的语义，在保持整体身份、语种、去重及可信试读边界校验的前提下，考虑保留合法且正文非空的返回章节，明确记录空行及部分成功。不得凭收费边界猜测试读资格、不得凭空补正文或直接放宽全部校验。同步向上游反馈这 13 本的空正文位置。 |
| `chapter_list_not_array`（21 本） | **上游数据或接口语义问题，先反馈上游。** 实际 `data.chapterList` 为 null，无法得到数组或章节；HTTP 200 不能证明业务数据可用。仅凭该类型不能判定书已下线、无试读、权限受限或上游异常。 | 提供这 21 本 source ID、stage、kind、receivedType 给上游确认。若 null 是正式约定的“无试读”，再评估下一版 adapter 显式归为无试读 skipped；若应当返回章节，则由上游补齐或修复。不能把 null 静默当作成功或据此下架。 |
| 偶发网络 / 限流类 | **本次 0 本。** 没有 `request_timeout`、`transport_error`、`http_status`、`rate_limited`。 | 没有证据支持直接重试会恢复。等上游数据修复或下一版解析策略经验证后，再由 Owner 授权定向补抓；本次不追加重试。 |

上述归属是基于结构化诊断与当前 parser 控制流的判断，不是上游已确认的业务原因。尤其不能从空字符串推定付费章节，也不能从 null 推定撤回。

## 与 10-07 对比及冻结验证

| 项目 | 10-07 | 本次 |
| --- | --- | --- |
| 任务 ID | `36e3a15b-61f3-4960-8bcf-c585f648db1f` | `943f0f7f-1196-4792-b28f-2ea53bcdf7d1` |
| request-id | `preview-retry-34-20261007` | `preview-diag-34-20261010` |
| success / failed / skipped | 0 / 34 / 0 | 0 / 34 / 0 |
| 可诊断性 | 通用 `upstream_preview_read_failed`，没有 B-36 kind/stage | 13 本空正文 + 21 本 null 章节列表 |
| 本次试读写入 | — | 0 章，无成功书目 |

操作前后 34 本的发布状态、软删除状态、slug、locale、试读章节数逐本一致；全部仍 published。主 worker 的容器 ID、StartedAt、镜像、健康状态、白名单成员检查、当前发布目录一致；env 文件和两份 nginx 文件的 SHA256 一致。未发生本次操作引起的发版或重启。

## 证据与复核

- [调查输出](evidence/preview-diag-34-2026-10-10/survey.json)、[执行输出](evidence/preview-diag-34-2026-10-10/apply.json)：JSON 输出已去掉幂等标识字段 requestToken 和样本条目自由文本 lastPreviewFailureMessage；保留完整范围与入队结果。
- [只读前置 SQL](evidence/preview-diag-34-2026-10-10/preflight.sql) / [结果](evidence/preview-diag-34-2026-10-10/preflight-results.json)。
- [汇总 SQL](evidence/preview-diag-34-2026-10-10/summary.sql) / [结果](evidence/preview-diag-34-2026-10-10/summary-results.json)：包括终态计数、kind/stage 分组、代表字段、实际 detail 键及逐本写入量。
- [只读后置 SQL](evidence/preview-diag-34-2026-10-10/postflight.sql) / [结果](evidence/preview-diag-34-2026-10-10/postflight-results.json)。
- [脱敏 worker 诊断](evidence/preview-diag-34-2026-10-10/worker-diagnostics.json)、[前运行态](evidence/preview-diag-34-2026-10-10/runtime-before.json)、[后运行态](evidence/preview-diag-34-2026-10-10/runtime-after.json)。
- [一致性验证](evidence/preview-diag-34-2026-10-10/verification.json)、[文件校验和](evidence/preview-diag-34-2026-10-10/checksums.json)。

本交付仅追加本记录和该证据目录的文档提交，遵守 Agent / Model trailer；不改 CHANGELOG、版本台账、发版日志，不打 tag、不触发部署。提交后推送到 `release/v0.5.14-2026-10-09` 并从远端回读比对。
