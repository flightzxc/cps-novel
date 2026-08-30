# 金丝雀预备轮 · 2026-08-27 进度与阻塞回执

## 结论

**候选尚未成立；本报告不是最终验收 PASS。** parser 与正式定向消费入口已提交，
静态检查通过。真实 PostgreSQL 测试因 Docker 磁盘满尚未启动；真实上游验收还缺少
Owner 经正式 UI 导入并 validation 的新 token。依照既定顺序，首次真实 preview 前未合并 main。

这不是“扫描十页仍零 promo”的业务结论：本轮新页读取为 0，覆盖率无分母。
本轮没有使用 fixture、claimPromo、rawPayload promo 恢复、发布白名单注入或生产环境。

## 分支、提交与镜像

| 对象 | 本次状态 |
|---|---|
| 工作分支 | `feature/canary-preflight`，从 `feature/x8@d37506c` 创建 |
| parser | `5a6addfcd4390727e8afc1b78cf57b734125740b` |
| 定向能力 | `146d35d82ce3a461aadaeb6de1b4207648726742` |
| main | 仍为 `00867ce`，U5 保留；X8 与预备轮尚未合入 |
| 本地六服务镜像 | 仍为 `cps-novel:0.1.0-d37506c`，尚未以本轮提交重建 |
| 远程操作 | 未 push、tag 或部署生产 |

Claude 已 accept `vitest.config.ts` Node project 的 `testTimeout=15000`，已在
development-log 登记；本轮没有修改该共享路径或其他 UI 路径。

## 已实现的边界

- parser 生产改动只有 `bookId: requiredIdentifier("bookId", data.bookId)`，输出仍为 string。
  number、string、null、空串四形态已覆盖，错误带字段名和 typeof、不输出原值。
  下游 worker 仅消费 chapterList，没有增加 bookId 比较或映射。
- 可选 `claimTarget={family,taskId,itemId}` 仅收窄 pending 候选 SQL；无参数保留原排序与行为。
  executionToken、leaseEpoch、heartbeat、recoverExpiredItem、finalize、protectedWrite 未修改。
- `scripts/x8-production-like.sh preview-one --task-id … --item-id … --actor …` 启动单次临时
  worker，必须使用 worker_app、双闸和仅含 preview 的临时 allowlist；常驻 Level 0 allowlist 不变。
  通过原 handler 检查渠道/账户/来源 allowlist 和两个只读能力位，目标不可领不消费其他 pending 项。
- 结构化日志包含 operator handle、taskId/itemId、workerId 与结果；以本 worker 的提交审计
  核对终态，不能把另一 worker 的结果归为本次成功。日志不包含 token、请求坐标或正文。
- 保留原 recovery 优先级：若本轮先进行正常租约恢复，命令返回 `not_consumed`，不会循环清队列。

## 单项真实 preview

| 指标 | 实测/状态 |
|---|---|
| 本轮消费的真实 preview item | 0；等待凭证与包含修复的镜像 |
| 上游返回章节数 | N/A，未调用 getchapterinfo |
| 实际物化章节数 | 本轮增量 0；拓扑当前 preview 章节总数 0 |
| 非空正文数 | N/A，未执行物化验收，不把未读上游当成空正文响应 |
| materialize 审计关联 | N/A，未执行 |
| 原有队列 | 16 pending；attempt_count 总和 0；没有消费其余项目 |
| 凭证状态 | 1 superseded / 0 active；未恢复旧凭证 |

下次仍先只消费现有任务中的 1 个 en item；不能用测试中的三章样本预设真实返回为三章。

## 扩页覆盖（每页计划 20 条）

| 页 | dry-run | 首次 apply | linked refresh | 新读取/去重书籍 | 完整 promo / en fetched |
|---|---|---|---|---|---|
| 2 | 未执行 | 未执行 | 未执行 | 0 / 0 | N/A |
| 3 | 未执行 | 未执行 | 未执行 | 0 / 0 | N/A |
| 4 | 未执行 | 未执行 | 未执行 | 0 / 0 | N/A |
| 5 | 未执行 | 未执行 | 未执行 | 0 / 0 | N/A |
| 6 | 未执行 | 未执行 | 未执行 | 0 / 0 | N/A |
| 7 | 未执行 | 未执行 | 未执行 | 0 / 0 | N/A |
| 8 | 未执行 | 未执行 | 未执行 | 0 / 0 | N/A |
| 9 | 未执行 | 未执行 | 未执行 | 0 / 0 | N/A |
| 10 | 未执行 | 未执行 | 未执行 | 0 / 0 | N/A |
| 11 | 未执行 | 未执行 | 未执行 | 0 / 0 | N/A |

首次 apply 0 次、linked refresh 0 次、去重新书 0 本；历史 C2 5/20、X8 0/20 均不进入本轮分母。
尚无数据可区分完整 promo 缺失、仅非 en promo 或绑定/预览受阻。本轮真实上游调用为 0；
后续仍按每次读取最多三次 HTTP 尝试、48 次/已确认窗口预算执行，不把 task attempt_count 当 HTTP 次数。

## 五段验收

| 阶段 | 结果 | 证据/阻断 |
|---|---|---|
| Promo 绑定 | FAIL / 前置阻断 | 当前 fetched PromoLink 总数 0，无同一本 en Novel/Article/PromoLink 候选 |
| 发布门禁评估 | FAIL / 前置阻断 | 尚未对候选调用正式 evaluator，完整 reasons 未取得 |
| 实际发布 | FAIL / 前置阻断 | 未取得 reasons=[]，未调用发布入口 |
| `/go` | FAIL / 前置阻断 | 未发布，未请求跳转或跟随上游 |
| TrackingEvent | FAIL / 前置阻断 | 未请求 /go；当前总数 0，本轮增量 0 |

冻结门禁逐项：`locale_not_publishable`、`required_metadata_missing`、`preview_chapter_missing`、
`preview_body_missing`、`promo_link_missing`、`promo_link_not_ready`、`page_identity_conflict`、
`rights_blocked`、`blocking_sync_exception` **均未完成候选动态评估**。当前代码发布白名单为空，
U6/D-7 未在本地 main 落地；这只是代码状态，不能冒充正式 evaluator 的实测 reasons。

候选成立与发布 go/no-go 分开判定；当前两者都缺少必要验收证据。

## 门禁全表（合并前，本轮实际执行）

| 门禁 | 结果 |
|---|---|
| Node | PASS，20.20.2 |
| npm ci | PASS；491 packages added / 492 audited；既存 8 high，未自动升级 |
| Prisma generate / validate | PASS，6.19.2；未连接上游或业务库进行 schema 写入 |
| parser、D-1 与 preview 既有回归 | PASS，3 files / 53 tests |
| 定向相关 Node 回归初跑 | PASS，21 files / 214 tests；不含真实 PG 运行 |
| typecheck | PASS |
| lint | PASS，0 error / 3 条既存 IndexNow unused-arg warning |
| 完整 Vitest 最后一次运行 | 209 files passed / 10 skipped；2507 tests passed / 0 failed / 111 skipped |
| build | PASS，在 npm ci 后重跑 |
| 静态数据库字典 | PASS，44 models / 952 records / 950 active |
| 真实数据库字典 | 未执行，不能以静态检查代替 |
| 定向 P1-07 / P2-05 PostgreSQL | BLOCKED，Docker 创建隔离卷报 no space left on device；测试未开始 |
| S12 八组 PostgreSQL | 未完成本轮真实复跑，不沿用历史通过计数 |
| X9 PostgreSQL accept | 未执行 |
| X8 accept | 未执行本轮复跑；当前运行镜像仍为 d37506c |
| 项目隔离 | PASS；CPS clean@d77c3b968285698529cf97c7f0f97b286d7a2a9c，无 symlink/submodule/runtime 引用 |
| shell 语法 / git diff --check | PASS |
| 改动文件敏感模式扫描 | JWT / 私钥模式 0 命中；本轮无新真实 token，未声称 token 精确扫描已执行 |

完整 Vitest 中数据库套件的实际跳过数如下；这里的 skipped **不等于通过**：

| 套件 | passed / failed / skipped |
|---|---|
| P1-05B | 0 / 0 / 10 |
| P1-06 | 0 / 0 / 7 |
| P1-07（含新增定向） | 0 / 0 / 26 |
| P1-08B auth | 0 / 0 / 8 |
| P1-08B credential | 0 / 0 / 15 |
| P1-13 | 0 / 0 / 6 |
| P2-04 | 0 / 0 / 4 |
| P2-05（含新增定向） | 0 / 0 / 28 |
| X6 site-setting | 0 / 0 / 4 |
| X9 task-admin | 0 / 0 / 3 |

## 当前安全状态与继续条件

- catalog 双闸均 false；claimPromo、Sitemap、IndexNow 保持关闭。
- getbydataid/getchapterinfo 为 registered_disabled；getlistpc enabled；claimPromo registered_disabled。
- 常驻 worker allowlist 保持 `credential.validate.v1,credential.supersede.v1,catalog_scan`。
- 本轮未导入凭证、未开启能力位/双闸；因此没有新的 token 需要 supersede。
  PostgreSQL 失败运行的隔离容器/网络/卷与临时 secret 目录已由原 cleanup 清理，回执 PASS。
- `/settings` 尚被登录页阻断，未读取或写入 default OG image。后续若为空，通过真实 UI
  填 `https://novel.test/apple-icon`，保存重载和审计核对；已有值不覆盖，填入后标明待 Owner 换正式图。
- 等待 Owner 确认仅清理 Docker 未使用构建缓存；不删除镜像、容器或数据卷。
  同时等待 Owner 在已打开的本地后台登录、通过正式凭证 UI 导入手测 200 的新 token 并完成 validation。
- 继续顺序：真实 PG 回归 → 预备轮镜像/单项真实 preview → 固定 X8 d37506c 与修复合入 main →
  最终 main 全量门禁/镜像 → 页 2–11 逐页扫描及候选验收 → 设置/安全收尾与最终报告。

## 独立后续项

preview_refresh 没有 catalog_scan/claim 的 6h TTL，pending 不会因该 TTL 自动过期。
生产环境可能积累陈旧任务，需单独排期；本轮未补 TTL。
C5“重跑此书预览”UI、X11、R1/R2 测试闸均保留在后续清单。
