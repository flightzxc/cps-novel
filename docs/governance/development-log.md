# 开发日志

按时间倒序或正序均可，本文件用于记录每次实质性开发动作的摘要，供后续任务与审计回溯。

---

## 2026-09-03 · RC-1 推广链接领取正式后台入口

- 在 `/catalog-sync` 的来源条目表格加多选复选框 + "领取推广链接"工具栏按钮，打开
  `PromoLinkClaimDialog`（新文件）确认对话框：展示已选数量/上限、跨渠道应用阻断、
  `ChannelCapability`（claimPromo）未开启的前置提示、apply 模式下 claimPromo
  不可逆的双向文案警示，以及六种 outcome（enqueued/enqueued_disabled/duplicate/
  active_conflict/no_eligible_sources/capability_disabled）各自独立的结果面板。
- 新增 Server Action `enqueuePromoLinkClaimAction`（`catalog-sync/_actions.ts`）：
  单一 action（不像 catalog-scan 拆 dry_run/apply 两个 action id）——两种模式共用同一个
  `promo:claim` 能力位，不存在需要靠静态 action id 隔离的、随 mode 变化的能力位。走
  `requireAdminActionAccess` → `requireFreshAdminServiceMutation` 两段式新鲜校验；
  提交前先查 `ChannelCapability`（按 `channelAppId` 维度，不是账户维度）是否
  `enabled`，未开启则返回结构化 `capability_disabled`，不创建任务行；items 的
  `offerType` 服务端硬编码为 `"read"`，不接受调用方传入；`novelSourceItemIds` 只接受
  显式数组，类型层面就不存在筛选描述符可传（CPS v8.3.6 的
  `submitChangduPromoClaim` 是运行时判 `data.selection` 拒绝，本仓是类型层面直接
  没有这个位置）。
- 在 `src/app/api/admin/_lib/registry.ts` 新增 `ADMIN_PROMO_LINK_CLAIM_ACTIONS`
  （`admin.promo_link_claim.enqueue`，`promo:claim`，`mutation:true`），composed
  进 `P2_04_ADMIN_REGISTRY.actions`，未编辑任何既有分组。
- `/promo-links` 页保持只读不变（未碰数据/API），只更新自述文案与页头注释，说明
  领取从 `/catalog-sync` 发起、结果在本页与 `/tasks` 体现，并加两条跳转链接。
- `docs/governance/port-registry.md` 新增 "RC-1 v8.3.6 生产 tag 参考基线" 小节
  （peeled commit `16f2e4cfca51f46af0dede899ecf6242a770bbd0`）与两条登记：Server
  Action 的 `ADAPT`（对齐 `submitChangduPromoClaim`，`src/app/(admin)/sync/
  actions.ts:724-766`）、表单交互形态的 `PATTERN_ONLY`（对齐
  `changdu-sync-panel.tsx:598-966`，不搬代码，只借鉴交互顺序）。
- 测试：`tests/ui/promo-link-claim-actions.test.ts`（23，鉴权/输入校验/能力位前置
  检查/工厂参数形状/五种 status 分类）、`tests/ui/promo-claim-outcome-copy.test.ts`
  （18，穷举覆盖 + 跳过原因标签 + 双闸检查单 + 不可逆提示分方向措辞）、扩展
  `tests/ui/catalog-sync-client.test.tsx`（+18，工具栏/对话框/跨渠道应用/能力位
  前置/超限/apply 警示/五种结果分支的整体渲染验收）、扩展
  `tests/ui/admin-content-registry.test.ts`（登记新 action id 与其能力位绑定）。
  全部通过；`test:ui` 全量 90 files / 1448 tests PASS；`test:backend` 全量
  127/128 files（1 file 预置失败 `publish-gate/no-bypass.test.ts` 指向
  `scripts/s1-exact-target-structural-smoke.ts`，与本轮无关——已用 `git stash`
  切回基线 `1b9f82c` 复现同一失败确认是既有基线问题，不是本轮引入）。
  `typecheck`/`lint`（0 error）/`next build` 均 PASS。
- 明确没做：未改 `src/lib/tasks/promo-link-claim.ts` 工厂逻辑或任何 `worker/**`
  handler；未改 flag 默认值或 `.env.example`；未改 `docker-compose.yml`；未写数据库
  （本机跑着 `cps-novel-local`/`cps-novel-x8-local` 两套既有 Postgres 容器，均未连接
  也未启动新容器）；未 merge、未 push、未打 tag。

## 2026-08-30 · 金丝雀预备轮实跑、扩页止损与 C4 微秒 CAS 修复

- 将固定 `feature/x8@d37506c` 以 merge commit `c80665e` 合入 main，再将
  `feature/canary-preflight@41538ba` 以 merge commit `56eb524` 合入；development-log 冲突保留
  X8、U5/U6/U6b 与 canary 双方完整登记，没有整树覆盖。U5 `00867ce`、U6 `30842b1`、
  U6b `ce3cada`、X8 `d37506c`、canary `41538ba` 祖先检查均 PASS。Claude 已 accept
  Node project `testTimeout=15000` 的 custodian 记录随 X8 保留。
- 在正式 `/channel-accounts` UI 导入仓库外 0600 token 并 validation 成功；浏览器 host 限定
  `novel.test`，token 不进参数、日志、截图或报告，成功后源文件立即销毁。真实定向消费一项 en
  preview：上游 3 章、物化 3 章、非空 3 章 / 20,675 字符；其余 15 个旧 pending item 未消费。
  `getbydataid → getchapterinfo → materialize` 首次全链闭环，parser numeric bookId 修复实证 PASS。
- 通过正式 `/catalog-sync` UI 对页 2～8 逐页 dry-run / apply；7 次 apply、140 条去重来源，
  fetched/deferred/incomplete/bound/conflict 均为 0。按每个读取最多三次尝试预留，preview 6 +
  catalog 42 = 48/48；没有 Retry-After/remaining/reset 证据可确认新窗口，因此页 9～11 未执行，
  不纳入分母。候选未成立，Promo 绑定、evaluator、发布、`/go`、TrackingEvent 五段均记
  FAIL / 前置阻断，发布 NO-GO；没有调用 claimPromo/rawPayload fixture/Sitemap/IndexNow。
- C4 真实 `/settings` 首次写入暴露 foundation seed `timestamptz(6)` 微秒与浏览器 JavaScript Date
  毫秒精度不对称：旧 exact CAS 永久 409。提交 `5b26912` 将 CAS 收窄为单毫秒半开区间，
  保留成功写至少推进 1ms 与旧值并发拒绝语义；补单测后重建镜像，真实 UI 保存、重载与
  `site_setting.update` 审计 PASS。占位图为 `https://novel.test/apple-icon`，待 Owner 更换正式图。
- 最终 main 实跑：typecheck、lint（0 error / 3 既存 warning）、完整 Vitest 210 files passed /
  10 skipped、2535 passed / 0 failed / 111 conditional skipped、build PASS；隔离 PostgreSQL core
  118/118、X6 4/4、X9 3/3、字典与 cleanup PASS。镜像 `cps-novel:0.1.0-5b26912`
  (`sha256:b14ed2fc…`) 的 X8 topology/PG/limiters/backup-restore/launch SQL accept 全 PASS。
- 收尾：两个 preview 读取能力经正式 CLI dry-run/apply 恢复 `registered_disabled`（审计 83/84）；
  凭证经 UI supersede task 完成（审计 85/86/87），最终 active=0；catalog gate closed，常驻
  allowlist 未扩展，claimPromo/Sitemap/IndexNow 双闸全 false。Docker Desktop 虚拟磁盘经 Owner
  授权从 56GB 扩到 128GB，VM 空闲 1.2G→69G；43 images、9 containers、49 volumes 均保留，
  未执行 system prune 或任何 `-a` 清理。
- 独立登记：preview_refresh 无 catalog_scan/claim 的 6h TTL，pending 不自动过期；本轮不补。
  C5「重跑此书预览」UI、页 9～11、X11、R1/R2 留后续。完整证据见
  [金丝雀预备轮最终回执](../operations/CANARY_PREFLIGHT_2026-08-27.md)。

## 2026-08-27 · U6b 注释溯源合入与获批 Docker 构建缓存清理

- 按 Owner 追加指令，将固定 `feature/pr-u6-polish@ce3cada` 以 merge commit `72a991e`
  合入本地 main；父提交为 `6ed0faf` / `ce3cada`，无冲突，U5 与 U6 backend 四项修复均保留。
  `fix/u6-backend-acceptance@4f76cdb`、`feature/canary-preflight@41538ba` 未移动。
- Claude 已复核 accept U6b。独立检查确认：5 个生产文件去注释后的 TypeScript AST 打印结果
  与固定 U6 `30842b1` 完全一致；另 1 个 UI 文件只替换测试标题，测试体与断言逐字不变。
  `language=5` 的来源说明改为 X8 getlistpc 样本，仍缺成对 languageName、仍为 unknown；
  未恢复旧产物、未发送新探针。清理 D-7 后的陈旧注释不改变白名单、查询或路由逻辑。
- 合并后 Node 20.20.2 实跑 typecheck PASS；lint 0 error / 3 条既存 warning；完整 Node
  123 files passed / 10 skipped、1137 tests passed / 95 skipped；完整 UI 85 files / 1369 tests
  PASS。合计 2506 passed / 0 failed / 95 conditional skipped；Node CLI 15s、UI 默认不变。
  本次注释补丁未重复安装依赖、Prisma 或 build，不将上一轮结果记为本次新跑。
- Owner 随后明确授权仅执行 `docker builder prune -f`。在 `desktop-linux` / Docker Desktop
  实际执行一次，前后均运行 `docker system df`：Build Cache 402 / 32.57GB → 368 / 26.84GB，
  实收 **5.727GB**，剩余可回收 0B；本次清理前可回收值亦为 5.727GB，并非先前的 9.97GB。
  镜像引用、9 个容器 ID、49 个卷名逐项前后一致，三个 `cps-novel:0.1.0-*` 回滚镜像完整保留。
- 只读检查 Docker 文件系统剩余 5.7G（55G 总量、47G 已用、90%）；未进一步删除资源，
  未运行 system prune 或带 `-a` 的清理。尚未重试金丝雀 PG / 镜像构建，释放空间不等于其验收通过；
  后续若仍不足，停下由 Owner 扩大 Docker Desktop 虚拟磁盘配额。
- token 文件交接协议已接受，但本次尚未收到仓库外 0600 文件的绝对路径及手测 200 确认；
  未查找或读取未知凭证文件，未登录、导入 token、重建拓扑、打开业务闸或调用上游。
- 详见 [U6b 与 Docker 缓存清理回执](../operations/U6B_DOCKER_CACHE_2026-08-27.md)。

## 2026-08-27 · U6 D-7 放行的 backend 补测与 custodian 签收

### 四项阻塞与签收

- 固定接收 `feature/pr-u6-polish@30842b18f6789a0a9890a75d476f69b299e10d73`，
  在其上建立 `fix/u6-backend-acceptance`；保留 U5 与金丝雀分支，不重写原 U6 提交。
- 登记：U6 直接修改了 6 个 Codex 独占的 backend 测试文件：
  `tests/backend/content-creation/publish-gate-e2e.test.ts`、
  `tests/backend/publish-gate/evaluator.test.ts`、
  `tests/backend/indexnow/eligibility.test.ts`、`tests/backend/indexnow/outbox.test.ts`、
  `tests/backend/seo/static-sitemap.test.ts`、
  `tests/backend/seo/novel-hreflang-empty-whitelist.test.ts`。
  **Codex custodian 已复核并 accept 30842b1 的上述内容**；D-7 对 en 放行所需的断言变化保留，
  此处按 X12 / `5459e0b` 先例补登记，不将越界未登记作为后续惯例。
- hreflang 白名单测试改名为 `novel-hreflang-whitelist.test.ts`：保留真实 en 查询一次的断言，
  新增仅在单个测试内 mock 空白名单的零查询回归，结束恢复 mock；同步修正主测试的失效指针。
- sitemap 在真实 refresh → generator 链补测非空子文件数组、零 entries 的失败路径，
  精确断言 `Generated sitemap contains no public URLs`，旧 current 不变且锁释放；
  既有空 routeLocales / 无子文件回归保留，没有用注入 generate 异常替代新门禁。

### 两项建议与影响登记

- outbox 的 `seedEligibleArticle` 增加默认 en 的 locale 参数，删除 es 用例的重复 seed，
  使用相同 helper 配对验证真实白名单下 en 入队、es 被拒；保留原负向断言。
- 仅修正 Codex 领土内 IndexNow eligibility、promo 发布测试、sitemap 多语言测试和
  locale route guard 测试的陈旧注释/用例理由，不改变生产执行语句或既有路由断言。
- **容量观察**：D-7 放行 en 后，触达 hreflang loader 的小说页/章节页请求不再空集短路，
  新增一次 `article.findMany`。外层 `loadHreflangSiblings` 已使用 React `cache`，按 novelId
  复用同次渲染中的调用；不能把每个调用位置都累加为独立查询。本轮不优化查询/缓存，
  未作压测，不据此声称并发容量或延迟已验收；后续容量评估需纳入详情页总查询数。
- Sitemap 已有正式 worker → refresh → generator 调用链，当前运行双闸关闭；
  不是“源码无生产调用点”。本轮不触发业务拓扑中的生成任务，不开放 Sitemap / IndexNow / claimPromo。
- language=5 继续 unknown，不恢复旧诊断产物、不新增探针、不扩上游语种登记。
- 验证按 Node 20 执行；Node project 的 15s 已获 Claude accept，本单仅通过 CLI 指定，
  UI project 维持默认；`vitest.config.ts` 的正式修改仍由后续 X8 合入，不重复改配置。
- 本单不使用 token、不清理 Docker、不重建运行镜像、不发布内容、不 push/tag/部署生产。
  金丝雀分支 `41538ba` 的真实 PG / 凭证阻塞保留，不能将 U6 合入记为金丝雀验收完成。

### 合并前验证（本次实跑）

- Node 20.20.2 / Prisma 6.19.2：npm ci、generate/validate、typecheck、build、静态字典与
  项目隔离 PASS；lint 0 error / 3 条既存 warning。Node 使用 CLI `--testTimeout=15000`，UI 默认不变。
- 定向回归 10 files / 100 tests PASS；完整 Node 123 files passed / 10 skipped、1137 tests passed /
  95 skipped；UI 85 files / 1369 tests PASS。合计 208 files passed / 10 skipped、2506 tests passed /
  0 failed / 95 skipped。数据库套件未启用，本轮不冒称真实 PG 验收通过。
- 首次默认 npm ci 在最后可见的 registry 元数据读取阶段长时间未结束，约七分钟后主动终止
  （exit 143）；随后使用同一锁文件，以 `--prefer-offline --fetch-timeout=30000 --fetch-retries=1`
  重跑成功（10s，491 added / 492 audited）。审计仍为已登记的 8 high；未跳过 audit、未改锁文件。
- 核对 `src/lib/indexnow/eligibility.ts` 去除块注释后的文本逐字一致；修复未改 Claude 实现路径，
  schema/grants、依赖与 Vitest 配置均未改。新增 3 个测试场景，未删除或新增 skip。

### 合入与合并后复跑

- 修复提交 `4f76cdb`，main merge commit `457309d`（父提交 `00867ce` / `4f76cdb`）；
  U5、固定 U6 `30842b1`、修复提交的祖先检查 PASS，merge 树与修复分支树一致。
- 合并后 npm ci、Prisma generate/validate、typecheck、lint、完整 Node/UI、build、静态字典与
  隔离检查均已实际复跑通过；计数与上述分支验证一致：2506 passed / 0 failed / 95 conditional skipped。
  重点回归再次 100/100；数据库套件跳过不计为真实 PG 通过。
- 本次 U6 backend 合并的固定输入未扩大到当时源分支新增的 U6b `ce3cada`；
  U6b 随后获 Owner 单独授权并合入，见上方追加记录。金丝雀分支保持 `41538ba`。
  运行镜像未重建，D-7 当前已在 main 代码生效，真实拓扑后续必须重建并按 evaluator 实测。
- 详见 [U6 backend 验收回执](../operations/U6_BACKEND_ACCEPTANCE_2026-08-27.md)。

## 2026-08-27 · U5 认证 UX 收尾 + 基准图待办

### 本轮做了什么

- R1 follow-up（X8 项 13）：`confirmSetupAction` 成功后不再立刻 `revoke` / 清 cookie。
  `confirmTwoFactorSetup` 仍立刻 bump `sessionVersion`，bootstrap 会话过不了
  `requireAdminSession`，后台 API 不会保持已授权。显式作废 + 清 cookie + `/login`
  挪到「我已保存，继续」触发的 `finishSetupAction`。`/two-factor/setup` 在 cookie
  仍在、context 已 stale 时继续渲染 `SetupFlow`，避免 RSC 刷新把一次性恢复码视图卸掉。
  恢复码只在本次 action 结果与客户端内存里，不进 URL / cookie / localStorage / 日志。
- R3（X12 复核）：`/two-factor/challenge` 与 `/two-factor/setup`（idle/started）补次要
  「退出登录」，走既有 `logoutAction`。恢复码 `done` 步不渲染登出，避免未确认保存就被清页。
- U4-TODO-01 闭环：`/dev-preview/status/{error,not-found,global-error}` 静态展示页，
  与真实 `error.tsx` / `not-found.tsx` / `global-error.tsx` 共用 `PublicErrorStatus` /
  `PublicNotFoundStatus`。补 `not-found-desktop.png` / `error-desktop.png`，清单 13 → 15。
  global-error 只展示面板、不单独截图。kill switch 仍由 `dev-preview/layout.tsx` 管辖。

### 明确没做的

- 未改 `src/lib/auth/` 的 `confirmTwoFactorSetup` / session 端口，未给当前会话补
  `sessionVersion` 回写；未 push、未部署。

## 2026-08-27 · 金丝雀预备轮（进行中）

- 从 `feature/x8@d37506c` 建立 `feature/canary-preflight`；`5a6addf` 仅将
  `getchapterinfo.data.bookId` 改为既有 `requiredIdentifier`，输出仍为 string。
  四形态与 D-1/preview 回归 53/53；生产消费点只使用 chapterList，无 bookId 类型假设需要放宽。
- **共享路径 custodian 确认**：Owner 本轮交接明确传达，Claude 已审核并 accept
  `c02b4d7` 对 `vitest.config.ts` Node project 的 `testTimeout=15000`；UI project 不变。
  合并 X8 时按该确认登记，不据此扩大其他共享路径权限。
- Owner 确认增加正式定向领单能力：可选 task/item 限定只收窄 pending 查询；默认 FIFO
  不变，不修改 executionToken、leaseEpoch、heartbeat、recoverExpiredItem 或 fenced finalize。
  `preview-one` 保留双闸、能力位和 allowlist，并输出 taskId/itemId/触发方及提交结果。
- 首次真实预览只消费 1 个 item，既有另外 15 项不动；预算优先用于第 2–11 页扩页。
  候选书随后按需定向物化，不通过清空 FIFO 队列触达候选。
- **独立发现 · preview TTL 不对称**：preview_refresh 没有 catalog_scan/claim 的六小时
  task TTL，pending 不会因等待自动过期。生产中存在陈旧任务延后使用活动凭证执行的风险，
  需要独立排期；本轮不新增 TTL、不把普通 pending 错报为 task_expired。
- **后续**：将“重跑此书预览”接入 C5 任务中心正式 UI；X11 与 R1/R2 测试闸仍留下一轮。
  本轮不更改 D-7、不开放 claimPromo/Sitemap/IndexNow、不 push/tag/部署生产。
- 真实验收与最终门禁另记 operations 报告；未完成前不得把当前实现或单元测试当成金丝雀 PASS。
- 合并前静态验证：Node 20.20.2 下 npm ci、Prisma 6.19.2 generate/validate、typecheck、
  build、静态字典检查 PASS；lint 0 error / 3 条既存 warning；完整 Vitest 209 files passed /
  10 skipped，2507 tests passed / 111 skipped。npm ci 保留已登记的 8 high，不自动升级依赖。
- PostgreSQL 定向回归在创建隔离测试卷时遇到 Docker `no space left on device`，测试尚未开始，
  失败运行的临时资源清理 PASS。等待 Owner 确认仅清理未使用构建缓存；不删除镜像、容器或业务卷。
  本地凭证仍为 1 superseded / 0 active，等待 Owner 在正式 UI 导入手测 200 的新 token。
  16 个 preview item 仍 pending / attempt_count 总和 0；尚未执行上游读取或合并 main。
- 定向实现提交 `146d35d`；逐页覆盖、五段阻断与门禁实数见
  [金丝雀进度回执](../operations/CANARY_PREFLIGHT_2026-08-27.md)，该回执不代表最终验收通过。

## 2026-08-26 · X12 Admin API 会话级 2FA 收口

### 本轮做了什么

- 在所有已登记的 admin Route Handler 与 Admin Server Action 上增加统一会话级门槛：未注册
  2FA 返回 `admin_two_factor_setup_required`，已注册但当前会话未完成挑战返回
  `admin_two_factor_required`；两者均与 capability 的 `requiresTwoFactor` 轴正交；
- 页面访问仍由既有 page guard 引导 setup/challenge，未登记入口仍优先 default-deny 404，缺失或失效
  会话仍返回 401；
- 补充 GET `/api/admin/novels` 的回归覆盖、读写 Route/Action、挑战后放行及错误信封/前端文案回归覆盖；
- X12 从最终候选已合入后的本地 `main@2595e81` 独立分支交付，不改 schema、migration、数据库
  grants、Docker/日志或部署入口；
- 登记：X12 本轮直接修改了 4 个 Claude 领土文件（`registry.ts` 注释、`error-copy.ts`、
  `tests/ui/admin-error-envelope.test.ts`、`tests/ui/admin-secret-boundary.test.tsx`），
  Claude custodian 已复核并 accept，此处留痕以防"跨界随手改"沉淀成惯例。

### 机器排障边界

- 本阶段不创建或复用任何机器 API 身份；SSH、容器日志与 `analyst_ro` 只读数据库链不经过 admin
  session guard，保持原路径；
- 未来若需要机器 API 身份，必须同时满足独立、短时、可审计、默认只读四项属性，并另经 Owner 审批；
- X8 部署输入仍未齐备，本轮不声称生产 SSH/TLS 通达性，不 push、不部署。

## 2026-08-26 · X7 上线前治理收口与 S16

### 本轮做了什么

- 审核并接受 `proposal/p0-s16-typecheck` @ `240bad6`：清除 Lane C 的 21 个 typecheck 基线错误，
  并在 CI 中新增独立全仓 `npm run typecheck`；
- 补齐 `src/lib/indexnow/` / `preview/` / `site/` 唯一 Owner，将违反根目录纪律的
  `src/lib/indexnow-backfill-manifest.ts` 无行为变化地收敛到 `src/lib/indexnow/backfill-manifest.ts`；
- 原样归档 C2 2026-08-21/26 两份只读诊断，8/26 为权威业务结论，8/21 只保留历史链；
- 补登 `ce7f0f1` 的 worker grants，纠正 P1 Gate/P2-01/claim flag 的陈旧状态文字；
- 建立 8 high / 0 critical 的 npm audit 处置台账，禁止 `npm audit fix --force`，
  登记 Next custodian PR、Prisma/nanoid 限期延期和生产镜像裁剪跟进；
- 将 flag + worker allowlist “同次变更/同次回滚”写入发布检查单，并将 X11 登记为
  IndexNow delivery 开闸步骤 8–9 的硬前置；misfire 显式选 `skip`，不留未定义策略。

### 明确没做的

- 本轮不实现 X11 schedule，不开任何 feature/write flag，不修改生产 allowlist；
- 不修改 package/lockfile，Next/eslint-config-next `16.3.3` 升级由 Claude custodian 独立交付；
- 不夹带 S14 `src/lib/site/chrome.ts` locale 修复，本轮只登记 `src/lib/site/` 归 Claude。

## 2026-08-26 · U4 前台防线包

### 本轮做了什么

- B1 公开树错误边界：新增 `src/app/error.tsx`、`src/app/global-error.tsx`、`src/app/not-found.tsx`，
  共用新抽出的 `PublicStatusPanel`（与 `UnavailableScreen` 同一套视觉语言）；两个错误边界各自
  `console.error`——`global-error` 不能依赖 `error.tsx` 落日志，因为布局失败根本到不了那层边界；
- B2 favicon：`src/app/icon.tsx` 用 `next/og` 代码生成，图形复刻 `BrandMark` 的几何占位；
- B3 dev-preview kill switch：`DEV_PREVIEW_ENABLED !== "true"` 时 `notFound()`，并从 preview 页
  去掉内部文档路径；
- B15 JSON-LD：`<` 转义为 `\u003c`，堵住 `</script>` 逃逸；
- N5 后台时区：`src/features/admin-ui/datetime.ts` 显式 `timeZone: Asia/Shanghai`，时区由
  `AdminTimeZoneNote` 每页声明一次，值本身不带后缀；
- B14 `lang`：根 `<html>` 保持 `lang="en"`，`(admin)` / `(admin-auth)` 包裹层标 `lang="zh-CN"`，
  并由 `AdminDocumentLang` 同步 `document.documentElement.lang`。

### 视觉偏离登记（P1-10）

- **§10 状态页形态例外**：`PublicStatusPanel` 的 `bare` 模式不渲染页头页脚，偏离「页头 → 状态说明块
  → 返回入口 → 页脚」。root 404 / error 没有 chrome 数据可喂页脚，且品牌槽位当前仍是
  `BRAND_PLACEHOLDER` 文本，不能出现在公开错误页。`UnavailableScreen` 仍走 `SiteShell`，不受影响。
- **§13 品牌标记同步义务**：`src/app/icon.tsx` 与 `src/components/BrandMark.tsx` 是同一个几何占位的
  两份实现（Satori 不支持 SVG 与 CSS 变量，favicon 只能用 div 重画）。🔴 正式 Logo 到位时两者必须
  一起替换；favicon 不得引入第二套品牌识别。

### 明确没做的（本轮范围外）

- 错误页没有使用 `--novel-danger`：错误态与下架态的区分靠「重试」这个纸色主动作，不靠色彩。

### 待办登记 · U4-TODO-01 · root 404 / error 缺基准图

- **状态**：已闭环（U5，2026-08-27）。`/dev-preview/status/not-found` 与
  `/dev-preview/status/error` 承载路由已建，`not-found-desktop.png` /
  `error-desktop.png` 已入库，清单 13 → 15。`DEV_PREVIEW_ENABLED` 关闭态仍由
  `dev-preview/layout.tsx` 整树 `notFound()`。

## 2026-08-06 · P1-15 收口文档与 P2 交接输入包

### 事实基线

- P1 最终本地 `main`：`fb8cddbdf7c8ff6b566169eade4a89258e7db668`；
- P1-04～P1-13 的交付提交均已进入本地 `main`；
- P1-13 PostgreSQL 16.14 最终门禁：PG 71/71、Backend 185/185、UI 469/469、Full 725/725；
- P1-14 对 `fb8cddb` 的最终聚焦只读审计：`P1_14_FINAL_AUDIT_PASS`、
  `REQUIRED_FIXES=NONE`、9 项 `NON_BLOCKING_NOTES`；
- CPS 本轮只读核验：clean@`d77c3b968285698529cf97c7f0f97b286d7a2a9c`。

### 本轮做了什么

- 新增 `docs/governance/P1_CLOSEOUT_REPORT.md`：登记 P1-04～P1-14 的本地完成状态、进入 main
  的 commit 证据、P1-12/P1-13/P1-14 结果、三条硬前置与待决项状态；
- 新增 `docs/governance/P1_RISK_AND_DEBT_REGISTER.md`：逐条登记 P1-14 的 9 项
  `NON_BLOCKING_NOTES`，不把任何 note 改写为 P1 required fix；
- 新增 `docs/governance/P2_HANDOFF_INPUT.md`：整理 P1 可复用基础、不得重做的冻结边界、
  多语/URL/SEO/上游 probe 前置、运维债务和 P2 首批建议工作包；
- 更新版本台账与本开发日志；
- D-2/D-7/D-8/W6/W9/R3 仍按正式文档登记为 OPEN；D-12 以详情页嵌入真实试读章节、
  不建独立目录路由的代码与测试证据登记为 RESOLVED。

### 特别前置

- 首次正式远端 CI 配置前，必须显式运行 `scripts/p1-13-postgres-verification.sh` 或等价
  PostgreSQL 16 门禁；默认 `npm test` 不代表 PG 71/71；
- 实际启用 365 天 `operation_audit` 清理任务前，必须设计受控特权清理路径；
- locale upstream registry 与 publish whitelist 当前均为空，D-7 和上游枚举证据齐备前继续
  fail-closed。

### 状态与下一门

```text
P1_04_TO_P1_14=COMPLETE
P1_14=P1_14_FINAL_AUDIT_PASS
P1_14_REQUIRED_FIXES=NONE
P1_15=WAITING_FOR_GPT_NOTION_AND_OWNER_GATE
REMOTE_SYNC=NOT_ATTEMPTED_LOCAL_ONLY
RELEASED=NO
DEPLOYED=NO
NEXT_GATE=GPT_NOTION_UPDATE_THEN_OWNER_RELEASE
```

P1-15 的本地文档提交不构成 Owner 放行，不得据此登记为已发布、已部署或 P2 已开工。

## 2026-08-05 · P1-11 阅读器功能

### 本轮做了什么

- 章节页改为动态路由 `/dev-preview/chapter/[chapterNumber]`，删掉原先两个各自写死的静态章节页；dev-preview 地址集中到 `src/features/public-ui/fixtures/preview-paths.ts` 一个 helper，页面与假数据都从那里取；
- 阅读偏好落 `localStorage` 并跨会话保持：新增 `chapter/reader-storage.ts`（永不抛异常、读回一律过收敛层、SSR 安全）与 `chapter/ReaderSettingsProvider.tsx`（挂在 `chapter/layout.tsx`，切章不重挂，设置因此跨章存活）；
- `ChapterScreen` 改为「有 Provider 就受控，没有就自持」双模，P1-10 的 24 个既有用例一行未改继续通过；
- 阅读位置按 `novel + chapter` 粒度记忆与恢复，存段落锚点 `{paragraphIndex, ratio}` 而非像素，换字号/行高/页宽后仍对得上；`ChapterNovelRef` 相应新增 `id`（永不渲染，只作存储键）；
- 章节导航换客户端路由并带 `scroll={false}`——App Router 的滚动重置在章节页祖先的 commit 回调里执行，不关掉会盖掉位置恢复；随之由阅读器负责「没存过位置的章节显式滚到顶」；
- 首帧不闪：`chapter/layout.tsx` 加阻塞式内联脚本把偏好（主题 + 排版三项）在补水前写到 `<html>`，`globals.css` 加 `--reader-pref-*` 兜底层与两条主题回放规则，阅读区在补水前不写内联排版变量；
- 顺带修正 P1-10 的 `clampIndex`：非整数原本回落到中间档（字号 20px）而非默认档（18px），已改为回默认档；
- 测试净增 40 条（216 → 256），新增 `reader-persistence` / `reader-position` / `chapter-navigation` / `reader-no-flash` 四个文件；`setup-cleanup.ts` 补 localStorage 清理、`<html>` 属性清理与 `window.scrollTo` 实现；
- 三张章节视觉基线重出（其中桌面版与移动版与 P1-10 逐字节相同，新增段落都在首屏之下）；
- 浏览器实测九项验收，含「切章前打的 `window` 标记切章后仍存活、navigation 条目恒为 1」与「滚到 900 刷新后回到 900 误差 0px」。

### 明确没做的（本轮范围外）

- 未建正式章节路由，未设 self-canonical，未进 sitemap / IndexNow，未写入正式 SEO URL 契约（`src/lib/seo/` 仍为空）；
- **未借本轮冻结 D-8**（前台 URL 是否带语种段）；
- 未做跨标签页设置同步；未做切章后的焦点转移（与 P1-10 整页跳转行为相当，非回归）；
- 无数据库改动，未新增任何 npm 依赖，未修改 Codex 独占目录。

详见 `docs/p1/P1_11_READER_REPORT.md`。

## 2026-08-03 · P1-05B 初始 PostgreSQL Migration

### 本轮做了什么

- 使用已固定的 Prisma CLI/Client 6.19.2，从 37-model Schema 生成并审查 `20260803090000_p1_initial_schema`；
- 在同一 Migration 中补齐 66 个状态/数值/跨字段 CHECK、active scope/identity 部分唯一索引、三类 Item 的 pending/recovery 独立索引，以及公开码不可变和 operation audit append-only trigger；
- Article → PromoLink 复合 FK 使用 PostgreSQL 默认 MATCH SIMPLE，并通过 `pg_constraint.confmatchtype='s'` 实测；
- 将 825 条数据库字典记录激活，记录 `managed_by`、`physical_name`、Migration ID 和 evidence；
- 新增 Schema/字典/pg_catalog 双向 drift 检查，以及一次性 PostgreSQL 16 Docker 验证脚本；
- PostgreSQL 16.14 空库部署、重复部署、双向 drift、16 个负向场景、5 类正向场景和六条索引执行计划全部通过；完整测试 12/12 PASS；
- 所有 disposable 容器与 volume 已清理，CPS 参考仓库保持 clean@`d77c3b9`。

### 明确没做的（本轮范围外）

- 未创建数据库角色、GRANT/REVOKE、备份或 PITR；
- 未实现 Worker、Scheduler、Auth、Credential、Adapter；
- 未创建正式数据库或 Compose，未连接生产、预生产或 CPS 数据库；
- 未修改 `package.json`、lockfile、`src/app/**`、`src/components/**` 或 `src/contracts/**`。

## 2026-08-02 · P1-04 工程骨架

### 本轮做了什么

- 建立 Codex 独占写入目录的占位结构：`prisma/`、`src/server/`、`src/lib/db/`、`src/lib/auth/`、`src/lib/credentials/`、`src/lib/tasks/`、`src/lib/adapters/`、`worker/`、`scheduler/`、`infra/`、`scripts/`、`tests/backend/`、`tests/integration/`，每个目录含 `README.md`（Owner、用途、本轮范围、填充任务、特别纪律）与 `.gitkeep`；
- 建立 Claude 独占写入目录的占位结构：`src/components/`、`src/design/`、`src/features/admin-ui/`、`src/features/public-ui/`，同样含 `README.md` + `.gitkeep`；
- 建立共享路径 `src/contracts/`（Claude 为 merge custodian）与 `src/domain/`（Codex 为 merge custodian）的占位说明，未写任何类型定义；
- 建立 `docs/governance/` 下四份治理文档：`port-registry.md`（空表头）、`database-governance.md`（骨架）、`version-registry.md`（首条记录）、`development-log.md`（本文件）；
- 建立仓库根 `CLAUDE.md` 作为架构事实唯一权威源。

### 明确没做的（本轮范围外）

- 无 Prisma Schema / migration（留给 P1-05）；
- 无 Worker / Scheduler 实现（留给 P1-07）；
- 无 Adapter 实现（留给 P1-07 前后，具体任务编号待 Notion 台账明确）；
- 无 Auth / Credential 实现（留给 P1-08）；
- 无数据库连接、角色、备份方案（留给 P1-05 / P1-06）；
- 无 Docker Compose 配置（留给 P1-12）；
- 无 CI workflow（本轮不创建 `.github/` 任何内容）；
- `src/contracts/` 内无任何业务 DTO / 类型定义，仅有目录说明。
