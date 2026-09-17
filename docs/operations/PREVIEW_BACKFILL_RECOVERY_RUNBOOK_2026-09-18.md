# 试读章节补采（Preview Backfill）恢复手册 — 2026-09-18

## 这个手册解决什么

后台批量发布小说文章时，门禁整批拒绝，提示 **「未通过发布门禁：没有可信试读章节」**。
该提示对应 `PublishGateReason = preview_chapter_missing`：这本书在库里**没有一章已落地、正文非空的试读章节**，
页面即使发出去，读者点进来也没有可读内容。门禁本身是对的，需要修的是上游的试读采集链路。

## 链路是怎么断的（2026-09-14 事故）

1. 目录扫描 → 建 `Novel` → `worker/handlers/novel-materialize.ts` 在**新建成功的那一刻**顺手排一张
   `moboreader.preview_refresh.v1` 任务。
2. 那一小时里 Worker 解不开渠道账号的凭据，每张任务都在 `loadMoboreaderPreviewScope` 抛
   `credential_validation_failed`。该任务类型注册的是 `maxAttempts: 1`，一次失败即终态 `failed`。
3. 推广领取链路当天被同一个凭据烧掉后补了两道防线（任务级 system hold + 入口凭据预检），
   **试读链路两样都没有**，而且它比推广链路更脆：

   - `enqueueContentCreationPreview` 的三个调用点全部挂在 `outcome === "created"` 上，
     书一旦已存在，任何入口都不会再排第二张试读任务；
   - 自动链路是「一本书一张单条目任务」，后台「重试失败条目」是按任务粒度的，等于要点几万次；
   - `scheduler/index.ts` 只调度轮播，没有任何周期任务回头补这些书。

结论：**一本书的试读任务一旦失败，系统里没有任何回路能把它捞回来**——这才是真正的断点。

## 恢复工具

`scripts/preview-backfill-recovery.ts`。默认只读；`--apply` 需要同时满足：

- 显式 `--limit`（没有默认值：候选集合可能就是整个书库，必须由人声明这一轮放多少）；
- `--confirm APPLY_PREVIEW_BACKFILL`；
- **凭据预检通过**。预检解析出和正式链路同一个渠道账号、同一条 active 凭据并验证它能解密；
  解不开就以退出码 65 拒绝执行，绝不重演 2026-09-14「几万条任务在 20 分钟内烧成终态」。

必须在 **Worker 侧**执行：`novel_source_item` 没有 `web_app` 授权，凭据预检也要 Worker 的密钥环，
所以 `DATABASE_URL` 必须是 `worker_app` 那条。

### 1. 只读普查

```
npx tsx scripts/preview-backfill-recovery.ts \
  --channel-app-id <uuid> --request-id <稳定 id> --limit 2000
```

输出里看三件事：`preflight.status` 必须是 `usable`；`candidateCount` / `truncated` 是这一轮的规模；
`failureBreakdown` 给出每本书当初卡在哪个原因（事故批次全部是 `credential_validation_failed`）。

### 2. 先拿单本演练

```
npx tsx scripts/preview-backfill-recovery.ts \
  --channel-app-id <uuid> --request-id <稳定 id> --limit 1 \
  --source-item-ids <novel_source_item_id> \
  --apply --confirm APPLY_PREVIEW_BACKFILL
```

等 Worker 跑完，确认该书 `novel_chapter` 出现 3 条 `status='preview'` 且 `novel_chapter_content.body` 非空，
再去后台对这本书的文章点一次发布。

### 3. 分批放量

去掉 `--source-item-ids`，按 `--limit` / `--batch-size`（每张任务上限 500，默认 200）分批推进。
每批的 `request_token` 是 `preview_backfill:<request-id>:<批次号>`，而 `channel_sync_task.request_token`
是 `UNIQUE`——同一个 `--request-id` 重跑不会重复建任务，只会把已建的那批拒掉，可以安全重入。

## 候选集合的口径

一本书进入候选，当且仅当它**正是发布门禁正在拒绝的那种书**：

- 有活着的 `NovelSourceItem` 且已绑定活着的 `Novel`；
- 没有任何「活着 + `status='preview'` + 正文非空」的章节
  （同时覆盖门禁的 `preview_chapter_missing` 与 `preview_body_missing`）；
- 没有 `withdrawn` 章节（`materializeChangduPreview` 对这类书会抛
  `withdrawn_chapter_requires_manual_review`，那是要走人工权利复核的，不能用补采绕过）；
- 没有在途的试读任务。

新鲜度不在这里重算：`enqueueMoboreaderPreviewRefreshTask` 已经会跳过 `lastRefreshedAt` 在窗口内的书，
并计入 `skipReasonCounts.fresh_preview`。

## 这个工具不做什么

- 不碰发布门禁。没有可读章节的书，补采之前和之后都发不出去。
- 不碰推广链接门禁。`promo_link_missing` / `promo_link_not_ready` 与试读是两道独立门禁，
  数据库侧还有 `article_published_promo_link_check` 兜底。
- 不自己写 `NovelChapter` / `NovelChapterContent`，也不直接调上游：它只是把书重新送回正式的
  `enqueueContentCreationPreview → Worker → materializeChangduPreview` 链路，
  沿途的 feature flag、写入闸门、审计全部照旧生效。

## 仍然敞口的一条（需要 Owner 决策，不在本工具范围内）

试读链路至今没有推广领取链路那样的「账号级确定性失败即刹车」保护。
凭据再坏一次，几万张新排的试读任务仍然会在几分钟内全部烧成终态，
只不过现在有了这个工具可以再捞回来。要不要给试读链路也加一道 hold，
以及加在任务级还是账号级（自动链路是一本书一张任务，任务级 hold 对它无效），
是一个需要拍板的设计决定。
