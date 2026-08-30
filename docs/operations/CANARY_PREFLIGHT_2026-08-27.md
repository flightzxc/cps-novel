# 金丝雀预备轮 · 2026-08-27～30 最终回执

## 结论

**金丝雀候选未成立，发布结论为 NO-GO。** 本轮已经取得一本真实 en 书的非空物化预览，
但在正式 `catalog_scan` 页 2～8 的 140 条去重来源中没有捕获任何完整、部分或待绑定 promo，
因此没有同一本书同时满足「预览已物化 + `PromoLink=fetched` + Article 正确绑定」。

本轮在保守上游预算 48/48 用尽时停在第 8 页。页 9～11 **未读取**，不能记作零覆盖；
运行日志也没有 `Retry-After`、remaining 或 reset 时间，不能凭“没有 429”猜测新窗口。
没有调用 claimPromo、rawPayload 旧读路、fixture、Sitemap 或 IndexNow，没有发布内容、请求 `/go`
或跟随上游跳转，也没有把 unknown/其他语种冒充 en。

## 分支、提交、合并与镜像

| 对象 | 固定值 / 结果 |
|---|---|
| 实现分支 | `feature/canary-preflight@41538ba`，保留未移动 |
| parser 修复 | `5a6addfcd4390727e8afc1b78cf57b734125740b` |
| 正式定向消费 | `146d35d82ce3a461aadaeb6de1b4207648726742` |
| U6 backend 修复 | `fix/u6-backend-acceptance@4f76cdb` |
| U6 / U6b main merge | `457309d` / `72a991e`；U5、`30842b1`、`ce3cada` 祖先关系均 PASS |
| X8 main merge | `c80665e`，固定输入 `feature/x8@d37506c` |
| canary main merge | `56eb524`，固定输入 `feature/canary-preflight@41538ba` |
| C4 实跑阻塞修复 | `5b269126d6db22eb2df119098c06bdc057c719f0` |
| 最终运行镜像 | `cps-novel:0.1.0-5b26912`；`sha256:b14ed2fc18784630734cfc563fb1680a74ab41838d905c7daf2cb35ab4bb99f0` |
| revision label | `5b269126d6db22eb2df119098c06bdc057c719f0` |
| 远程操作 | 未 push、tag、部署生产 |

Claude 对 `vitest.config.ts` Node project `testTimeout=15000` 的 accept 已保留在 development-log；
U6 D-7 的 `PUBLISHABLE_LOCALES=["en"]` 已进入最终 main。`language=5` 仍为 unknown，
没有恢复旧材料或发起新探针。

## bookId 与正式定向消费验收

- `getchapterinfo.data.bookId` 仅改为 `requiredIdentifier("bookId", data.bookId)`；输出仍为 string，
  其他冻结字段没有放宽。number 转 string、string 原样、null 与空串拒绝均有回归；错误包含
  `bookId` 与对应 `typeof`，不包含原值。D-1 `chapterID` 和冻结字段回归保留。
- 下游 handler 只消费 `chapterList`，没有新增 bookId 比较、映射或数值假设。
- `claimTarget={family,taskId,itemId}` 只给 pending SQL 增加精确收窄条件；默认 FIFO、fencing、
  executionToken、leaseEpoch、heartbeat、recovery、finalize 与 protected write 均未改。
- `preview-one` 使用 worker 角色和原 handler，受 catalog 双闸、临时 allowlist、来源/账户约束及
  `getbydataid` / `getchapterinfo` 两个能力位约束。目标不可领时不回退到其他 item；结构化日志
  只记 actor/task/item/result，不记 token、请求坐标或正文。

### 单项真实 preview

| 指标 | 实测 |
|---|---|
| Novel | `cef98ce8-1c46-4a7c-93ae-cb384cd42769`，en，`The Billionaire behind the Silver Mask` |
| task / item | `71be9c61-ce60-4c16-b67c-21b84c3bd8de` / `180f9c55-3fbe-411c-beb6-70eadaf3f065` |
| 定向结果 | `success`，item attempt_count=1 |
| 上游返回章节数 | 3 |
| 实际物化章节数 | 3 |
| 非空正文数 / 字符数 | 3 / 20,675 |
| material type | `fallback_1` |
| 审计 | 43 `moboreader.preview.materialized`；44 `task_item.success`；与同一 task 关联 |
| 其他旧队列项 | 15 pending，attempt_count 合计 0，未被定向命令消费 |

这次真实调用完成 `getbydataid → getchapterinfo → materialize` 首次闭环，证明 numeric bookId
不再阻断 parser。最终拓扑因既有工厂重复任务还显示另外 15 个 processing task 下的 pending item，
总计 30 pending / 1 success；本轮没有为清队列而消费它们。

## 扩页覆盖

每页都由正式 `/catalog-sync` UI 创建 dry-run，成功后短时打开 apply 写闸创建正式任务，
任务终态后立即关闸。每个 task item 的任务尝试数均为 1；这只描述 worker task，**不将其当作
HTTP 次数**。

| 页 | dry-run task | apply task | 返回 / 去重来源 | fetched / deferred / incomplete | bound / conflict |
|---|---|---|---:|---:|---:|
| 2 | `77a56e27` | `4a6e993b` | 20 / 20 | 0 / 0 / 0 | 0 / 0 |
| 3 | `091a6430` | `44fbeed1` | 20 / 20 | 0 / 0 / 0 | 0 / 0 |
| 4 | `5546b40c` | `c31f5ed8` | 20 / 20 | 0 / 0 / 0 | 0 / 0 |
| 5 | `c3eb0371` | `cb29fe9d` | 20 / 20 | 0 / 0 / 0 | 0 / 0 |
| 6 | `3a5054f9` | `5faab885` | 20 / 20 | 0 / 0 / 0 | 0 / 0 |
| 7 | `c8799e13` | `85dfdb70` | 20 / 20 | 0 / 0 / 0 | 0 / 0 |
| 8 | `f625de21` | `853314e6` | 20 / 20 | 0 / 0 / 0 | 0 / 0 |
| 9～11 | 未执行 | 未执行 | 不进分母 | 未观察 | 未观察 |

统计：首次 apply 7 次，linked refresh 0 次，返回 140 条、数据库中 140 个去重来源；
完整 promo 覆盖率 **0/140 = 0%**，partial/deferred 也为 0。没有进入 S13 草稿创建或 linked
refresh，因为没有任何 `deferredUntilLinked`。历史 C2 5/20 与 X8 0/20 均未并入本轮分母。

预算按每个上游读取最多 3 次尝试预留：单书 preview 预留 6，14 个 catalog dry/apply 读取预留
42，合计 48/48。页 8 后既没有可证的新窗口，也没有可安全引用的限流 reset 信号，故合规停止。
当前结论精确为“本轮 140 条覆盖中没有上游 promo 形态”，不是“页 9～11 也没有 promo”。

## 五段业务验收与冻结门禁

| 阶段 | 结果 | 证据 / 前置阻断 |
|---|---|---|
| Promo 绑定 | **FAIL / 前置阻断** | PromoLink 总数 0，无法形成 Novel / Article / fetched PromoLink 同书关联 |
| 发布门禁评估 | **FAIL / 前置阻断** | 没有候选，不对无 promo 的书冒充候选调用 evaluator；没有取得该候选的完整 reasons |
| 实际发布 | **FAIL / 前置阻断** | 没有 `reasons=[]` 证据，正式发布入口未调用 |
| `/go` | **FAIL / 前置阻断** | 未发布，未请求 302，也未跟随上游 |
| TrackingEvent | **FAIL / 前置阻断** | `/go` 未执行；总数与本轮增量均为 0 |

| 冻结 reason | 本轮候选动态结果 |
|---|---|
| `locale_not_publishable` | 未评估；U6 已使 en 成为代码层可发布 locale，不冒充候选实测 |
| `required_metadata_missing` | 未评估 |
| `preview_chapter_missing` | 未评估；单项预览书自身已有 3 章，但它没有 promo |
| `preview_body_missing` | 未评估；单项预览书自身 3/3 正文非空 |
| `promo_link_missing` | 候选前置条件已失败：全拓扑 PromoLink=0 |
| `promo_link_not_ready` | 未评估 |
| `page_identity_conflict` | 未评估 |
| `rights_blocked` | 未评估 |
| `blocking_sync_exception` | 未评估 |

候选成立和发布 go/no-go 分开记录：前者 FAIL，因而后者 NO-GO。不能用 U6 单测中的 en 放行
代替真实候选 evaluator，也不能将后续四段标为“未适用”来掩盖验收未完成。

## C4 设置写路径与新增修复

`default_og_image` 初始为空。`https://novel.test/apple-icon` 先验证为 200、`image/png`；
第一次真实 UI 保存发现 foundation seed 的 PostgreSQL `timestamptz(6)` 带微秒，而浏览器 ISO/JS
Date 只能保留毫秒，精确 CAS 因此返回 409。没有手改数据库绕过。

`5b26912` 将 CAS 限定在浏览器表示的单一毫秒 `[expected, expected+1ms)`；任何成功的服务写入仍至少
推进 1ms，旧值并发写继续失败。定向 7/7、完整 Vitest、build 与真实 UI 均通过。最终 UI 保存后
重载仍为 `https://novel.test/apple-icon`，operation audit 82 为 `site_setting.update`。这是本地占位图，
**待 Owner 更换正式图**。

## 最终门禁全表

| 门禁 | 最终结果 |
|---|---|
| Node / npm | PASS：Node 20.20.2 / npm 11.6.2 |
| npm ci | PASS：锁文件安装 491 packages；未自动修复 8 个既存 high advisory |
| Prisma generate / validate | PASS：6.19.2；validate 使用显式 parser-only URL，不写业务库 |
| parser、D-1、冻结字段 | PASS；adapter 文件 29 tests，四形态与非泄漏错误断言在内 |
| 定向领取 / FIFO / fencing / 双闸 / allowlist | PASS，Node 与 P1-07/P2-05 PostgreSQL 覆盖均保留 |
| typecheck | PASS |
| lint | PASS：0 error / 3 条既存 IndexNow unused-arg warning |
| 完整 Node + UI Vitest | PASS：210 files passed / 10 skipped；2535 passed / 0 failed / 111 conditional skipped |
| build | PASS：Next.js 生产构建与 15 个静态页完成 |
| migration / schema diff | PASS：4 migrations；no difference detected |
| 数据库字典 | PASS：44 models / 952 records / 950 active / 44 tables / 190 constraints / 185 indexes / 2 triggers |
| S12 PostgreSQL core | PASS：10 files / 118 tests；X6 4 与 X9 3 在 core 中条件跳过后由独立脚本实跑 |
| X6 PostgreSQL | PASS：4/4；grants、字典、隔离库 cleanup 全 PASS |
| X9 PostgreSQL | PASS：3/3；CAS/audit、worker denial、字典、cleanup 全 PASS |
| C4 真实 UI | PASS：保存、重载、audit；首次微秒 CAS 失败已修复且如实保留 |
| X8 accept | PASS：commit `5b26912`；topology、PG runtime、limiters、backup/restore、五组 SQL 均 PASS |
| merge ancestry | PASS：U5、U6、U6b、X8、canary 固定提交均为 main 祖先 |
| git diff --check / 工作树 | PASS（最终报告提交前） |

完整 Vitest 的 111 条 conditional skip 中包含未注入真实数据库的 10 个 integration 文件；
它们不被冒称通过。相应 PostgreSQL core、X6 与 X9 已由隔离 PostgreSQL 16.14 独立实跑并清理。

## 凭证、闸门、磁盘与敏感收尾

- token 只从仓库外 `/private/tmp/novel-upstream-credential.jwt` 的 0600 文件在本地浏览器自动化进程中
  读取，浏览器请求 host 只放行 `novel.test`；token 从未作为命令行参数或报告内容，也没有在字段有值时
  截图。validation 任务 `db5dafea-4e46-46b3-9d05-a3ee375a0afa` 成功后立即删除该文件。
- 收尾时通过 `/channel-accounts` 正式 UI 创建 supersede 任务
  `7ec7ce80-08ba-49d7-9ab0-d466aacdc1a3`；task=completed、item=success，审计 85/86/87，
  最终凭证为 2 superseded / 0 active。
- `getbydataid` / `getchapterinfo` 通过正式 CLI 各先 dry-run 再 apply，恢复
  `registered_disabled`，审计 83/84；`getlistpc=enabled`、`claimPromo=registered_disabled`。
- catalog gate 最终 `closed`，运行 env 的 feature 与 write flag 均为 false；常驻 worker allowlist
  恢复并保持 `credential.validate.v1,credential.supersede.v1,catalog_scan`。
- claimPromo、Sitemap auto refresh、IndexNow delivery 的 feature/write 双闸最终全部 false。
- 按 Owner 授权用 Docker Desktop 设置把虚拟磁盘配额 56GB 扩为 128GB。VM 前后为
  `55G/51G/1.2G/98% → 126G/51G/69G/43%`；宿主机保持 `1.8Ti/16Gi/1.2Ti/2%`。
  前后 `docker system df`：43 images、9 containers、49 volumes 不变；卷用量仅随正常运行
  `3.181GB → 3.198GB`。未运行 system prune、带 `-a` 的清理，也未删除镜像、容器或卷。
- token 文件、临时 UI/TOTP/任务 runner 均销毁；运行日志、证据目录、进程参数与工作树完成 JWT/私钥
  模式扫描后才能提交本报告。扫描只报告命中计数，不输出潜在敏感值。

## 独立后续项

- `preview_refresh` 没有 catalog_scan/claim 的 6h TTL，pending 项不会按该 TTL 自动过期；本轮不补。
  当前重复 pending 队列说明生产泄漏面仍需单独排期。
- C5 任务中心「重跑此书预览」UI 后续实现；本轮仅提供正式 CLI 能力。
- 页 9～11 需等可证的新限流窗口再继续；若仍无 promo，Owner 决定是否解冻 claimPromo 立项。
- X11、R1/R2 测试闸保留下轮清单；`language=5` 继续 unknown。
