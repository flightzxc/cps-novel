# 试读章节补采（Preview Backfill）与账号级刹车 — 操作手册 2026-09-18

> **2026-09-18 Owner 两项决策已生效，先读这段。**
>
> **决策 1｜发布与 Preview 解耦。** 试读是文章页面的增强能力，不再是发布的硬前置条件。
> `preview_chapter_missing` / `preview_body_missing` 已降级为 **warning**：文章照常发布，
> 前台在没有试读时**整块隐藏试读模块**（不显示「暂无试读」这类空壳）。
> 所以本手册描述的补采**不再是发布的前置步骤**，而是「文章先上线、试读后台异步补齐」。
>
> **决策 2｜Preview 账号级确定性故障刹车。** 见本手册第二部分。

## 链路是怎么断的（2026-09-14 事故）

1. 目录扫描 → 建 `Novel` → `worker/handlers/novel-materialize.ts` 在**新建成功的那一刻**顺手排一张
   `moboreader.preview_refresh.v1` 任务。
2. 那一小时里 Worker 解不开渠道账号的凭据，每张任务都在 `loadMoboreaderPreviewScope` 抛
   `credential_validation_failed`。该任务类型注册的是 `maxAttempts: 1`，一次失败即终态 `failed`。
3. 推广领取链路当天被同一个凭据烧掉后补了两道防线（任务级 system hold + 入口凭据预检），
   **试读链路当时两样都没有**（决策 2 补上的就是这一半），而且它比推广链路更脆：

   - `enqueueContentCreationPreview` 的三个调用点全部挂在 `outcome === "created"` 上，
     书一旦已存在，任何入口都不会再排第二张试读任务；
   - 自动链路是「一本书一张单条目任务」，后台「重试失败条目」是按任务粒度的，等于要点几万次；
   - `scheduler/index.ts` 只调度轮播，没有任何周期任务回头补这些书。

结论：**一本书的试读任务一旦失败，系统里没有任何回路能把它捞回来**——这才是真正的断点。
（第一部分的补采工具补的是这条回路；第二部分的账号级刹车补的是"不要再一次性烧掉几万张"。）

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

---

## 第二部分：账号级确定性故障刹车（决策 2，已实现）

### 它拦的是什么

2026-09-14 那种事故：一个渠道账号的凭据解不开，79,183 张试读任务在 70 分钟内
全部烧成终态 `failed`（`maxAttempts: 1`，一张一本书）。

要的是**故障隔离**，不是把重试次数从 1 改成 3——凭据坏了时重试三次只会把
7.9 万次失败变成 23.7 万次。

### 触发条件

只有**账号级确定性**失败会拉闸，取值域就是推广链路已有的
`DETERMINISTIC_CREDENTIAL_FAILURE_CODES`（`src/lib/credentials/claim-readiness.ts`）：
`credential_missing` / `credential_expired` / `credential_ambiguous` /
`credential_validation_failed` / `credential_invalid`。
这些码全部只由 `channelAccountId` 决定，对该账号的每一张任务同真同假。

**不会**拉闸的（保持各自原有的每条重试/失败处理）：上游超时、连接重置、5xx、限流
（统一收敛到 `upstream_material_read_failed` / `upstream_preview_read_failed`）、
单书不存在、单书下架、章节缺失、单书 parsing 错误、能力/绑定配置问题。

这五个码的**全部产出点**都已逐一反查过，没有一处依赖网络结果：
AES-GCM 解密失败（`worker/credentials/crypto.ts`）、数 active 行与比 `expiresAt`
（`classifyCredentialRowsForClaim`）、base64 解码加 `exp` 比较
（`validateCredentialJwtLocally`，文件内零 fetch/http）、状态机判断
（`lifecycle.ts` / `credentials/service.ts`）。所以不存在
「上游超时 → 凭据被判 invalid → 后续 preview 看到 credential_missing → 拉闸」
这条把 transient 洗成 deterministic 的路径。判定还是**全等匹配**，
一段含有 `credential_validation_failed` 字样的长报错不会拉闸。

### 粒度与状态

粒度是**渠道账号 × 业务面（scope）**，不是渠道、不是任务。别的账号完全不受影响。

「凭据能不能解密」确实是账号级事实，但一行 hold 实际挡住哪条流水线要写清楚，
否则表名说的是「账号被 hold」、行为却只停试读。所以每行都带 `scope`，
取值域今天只有 `preview` 一个（`CHANNEL_ACCOUNT_HOLD_SCOPES` 是单一真源，
数据库 `channel_account_hold_scope_check` 是它的镜像，加值要一起改）。
推广领取链路保留它自己的任务级保护，**不**受这些行影响。

状态就一行 `channel_account_hold`：`released_at IS NULL` 即生效，
`channel_account_hold_active_uidx (channel_account_id, scope) WHERE released_at IS NULL`
保证每个账号的每条业务线至多一条。

三层生效：

1. **领取期**——`selectPending` 的下推谓词。被 hold 账号的条目直接不进候选集。
   条目**原样留在 pending**：不加租约、不加 attempt、不写 error、不 requeue，
   因此不存在「领取→发现 hold→退回→再领取」的空转。worker 只是领不到活，照常睡轮询间隔。
2. **入队期**——被 hold 的账号，新排的试读任务直接建成 `disabled` 并带
   `taskControl.kind=system_hold` 标记（工作被**保留**，不是被丢弃）。
   这一层保证 hold 期间可运行池不再增长。
3. **失败期**——试读 handler 遇到上述凭据类失败时，在该条目自己的
   `protectedWrite` 事务里幂等写下 hold 行（`INSERT ... ON CONFLICT DO NOTHING`）。

### 查看

```
npx tsx scripts/preview-account-hold.ts --list
```

列出每条 active hold、触发码、生效时间，以及它当前挡下了多少张任务。

### 解除

**先修凭据**，再解除。解除命令自带凭据预检，解不开就拒绝放行（退出码 65）：

```
npx tsx scripts/preview-account-hold.ts --release \
  --channel-account-id <uuid> --released-by <operator-id> \
  --reason "rotated credential 2026-09-18" \
  --confirm RELEASE_PREVIEW_ACCOUNT_HOLD
```

解除会：清掉 hold 行（`released_at` / `released_by` 必须成对，由 CHECK 约束保证）→
分块（每批 500）把本刹车挂起的任务放回 `pending` → 写一条
`preview.account_hold_released` 审计。

因功能开关关闭而 `disabled` 的任务**不带**这个标记，不会被顺手放行。

**中途崩溃了怎么办：直接重跑同一条命令。** 清 hold 与放回任务是两段写、
必然跨事务，所以「hold 已清、任务只放回一半」是真实可能的现场。
命令把这两件事当作两个各自收敛的事实：有 active hold 就清掉；
**无论有没有**，都接着把残留的 `disabled + system_hold` 任务放回去。
重跑会报 `resumed` 并带上这一次补完的条数；已经完全收敛时报 `no_active_hold`、
零改动。续跑同样要过凭据预检——放回任务本身就是有风险的动作。

### 历史事故数据怎么办

刹车只负责「下一次凭据故障不再烧掉几万张任务」。
2026-09-14 已经烧成终态的那 79,183 张不在它的职责范围内，
用第一部分的补采工具恢复即可——不要为了新机制去批量改写历史任务状态机。
