# 海外阅读 P1 · CPS 复刻矩阵

> 判定原则：**默认 `CPS_PARITY`。选 `ORIGINAL_REQUIRED` 必须举证。**
> CPS 只读参照：`d77c3b968285698529cf97c7f0f97b286d7a2a9c`（v8.1.1）
> 全部 `文件:行号` 为本轮实读所得，未凭记忆。

## 判定级别

| 级别 | 含义 |
| --- | --- |
| `CPS_PARITY` | 形态与语义都照搬 |
| `CPS_PARITY_ADAPTED` | 形态照搬，数据/命名/协议换小说语义 |
| `ORIGINAL_REQUIRED` | CPS 无对应物，或 CPS 现状本身是反例——**必须说明原因** |
| `DROP` | CPS 有但明确不搬 |

---

## 1. 后台菜单

CPS 菜单真身：`src/components/layout/sidebar.tsx:39-72`（`NAV_ITEMS`，17 个顶级项 + 数据看板 8 个子项）。

| CPS 菜单项 | CPS 路径 | 海外阅读 | 判定 | 说明 |
| --- | --- | --- | --- | --- |
| 仪表盘 | `/dashboard` | 仪表盘 | `CPS_PARITY` | 结构照搬，指标换小说口径 |
| 剧集管理 | `/dramas` | **书目管理** `/novels` | `CPS_PARITY_ADAPTED` | 列表/详情/编辑三页结构照搬 |
| 批量导入 | `/import` | — | **`DROP`** | 表格通道整体废弃（立项书 §4.2）；`import` 页面与 npm script 都不建 |
| 数据同步 | `/sync` | **目录同步** `/catalog-sync` | `CPS_PARITY_ADAPTED` | 换 `CatalogScanTask` 页区间语义 |
| 推广链接 | `/promo-links` | 推广链接 `/promo-links` | `CPS_PARITY_ADAPTED` | 新增公开短码列 |
| 畅读链接 | `/changdu-links` | — | `CPS_PARITY_ADAPTED` | 与上一项合并为单一推广链接页 + **渠道筛选维度**（V1 只有畅读一个 active 渠道；北斗二期接入时复用同一页，不再新增页面） |
| 首页轮播 | `/home-carousel` | 首页轮播 | `CPS_PARITY` | Owner 已裁决复用五表形态 |
| 模板管理 | `/templates` | 模板管理 | `CPS_PARITY_ADAPTED` | 变量白名单换小说字段 |
| 文章管理 | `/articles` | 文章管理 | `CPS_PARITY_ADAPTED` | 去掉换租客（batch-drama-switch） |
| 分类管理 | `/categories` | 分类管理 | `CPS_PARITY` | Post-V1 才接标签映射，V1 建页面壳 |
| 分类规则 | `/category-rules` | — | **`DROP`**（V1） | 简介自动分类是 Post-V1 兜底路径 |
| 标签管理 | `/tags` | 标签管理 | `CPS_PARITY_ADAPTED` | V1 只读展示原始来源标签 |
| 任务中心 | `/tasks` | 任务中心 | `CPS_PARITY` | 两级任务 + item 详情，形态照搬 |
| 数据看板（8 子项） | `/settlement/*` | **收益（占位）** | `CPS_PARITY_ADAPTED` | V1 只留占位页；子项待 P4/R3 |
| 站点设置 | `/settings` | 站点设置 | `CPS_PARITY` | 含 Sitemap 卡片 |
| 渠道账户 | `/channel-accounts` | 渠道账户 | `CPS_PARITY` | 能力位门控形态照搬 |
| API 配置 | `/settings/api-config` | API 配置 | `CPS_PARITY_ADAPTED` | 去飞书、去北斗；只留小说渠道 |
| 账号安全 | `/settings/security` | 账号安全 | `CPS_PARITY` | 2FA + 恢复码原样 |
| — | — | **试读管理** `/previews` | **`ORIGINAL_REQUIRED`** | **原因**：CPS 无章节实体（只有 `Drama.episodeCount` 标量，`schema.prisma:28-29`），`DramaPreviewAsset` 是视频语义且行数被 `freeEpisodeCount` 卡死，形状不可平移。章节管理是 greenfield |

**菜单实现形态**：`NAV_ITEMS` 常量 + `feature` 字段做子项开关 + 折叠状态 + 自动展开活跃组（`sidebar.tsx:31-37,89-98,133-137`）——**整套照搬**。

---

## 2. 权限与鉴权

CPS 真身：`src/lib/admin-capabilities.ts`（81 行，零本地依赖）、`src/proxy.ts:21-37`（`PROTECTED_PREFIXES`）。

| 机制 | CPS 现状 | 判定 | 海外阅读 |
| --- | --- | --- | --- |
| 能力位模型 | 三个能力：`credential:manage` / `article:rebind-drama` / `article:batch-rebind-drama`；`CAPABILITY_ENV` 表映射到 `*_ROLES` / `*_USER_IDS` env；默认角色 `super_admin` | `CPS_PARITY` | 结构整体照搬；能力名重列 |
| 能力判定 | `hasAdminCapability` 读 env 白名单，角色或 userId 命中即通过 | `CPS_PARITY` | 原样 |
| 强制校验 | `requireAdminCapability` 抛 `AdminForbiddenError` | `CPS_PARITY` | 原样 |
| 路由保护 | `PROTECTED_PREFIXES` 16 项前缀清单（`proxy.ts:21-37`） | `CPS_PARITY_ADAPTED` | 清单换小说路由；**新路由必须显式登记否则 404** |
| 默认拒绝 | ⚠️ CPS 是"API 路由不经 proxy、靠每个 route 自觉调 `requireAdminSession()`" | **`ORIGINAL_REQUIRED`** | **原因：CPS 现状是已知缺陷**（立项书 §9.4 明列为"三条不要继承"之一）。海外阅读改**默认拒绝**：未显式登记的 admin 路由不可访问 |
| proxy 层查库 | ⚠️ CPS `proxy.ts:80-136` 每次公开详情页请求打 1–2 次库 | **`DROP`** | **原因：已知负担**。改由页面层 `notFound()` / `gone()` |
| 会话超时 | JWT idle 2h + `updateAge` 15min + 24h 绝对超时，过期 fail closed | `CPS_PARITY` | 原样（CPS v6.1.0 已生产验证） |
| 2FA | TOTP + 恢复码 + Turnstile，14 文件闭包 1,920 行、仅触达 4 个 model | `CPS_PARITY` | **最干净的可搬资产**，整体搬 |

**海外阅读的能力位清单（初版）**：`credential:manage`（凭证写入）、`promo:claim`（推广生成，P3 才启用）、`content:takedown`（版权撤回）、`revenue:view`（收益查看，P4）。

---

## 3. 页面结构与字段

| CPS 页面形态 | 证据 | 判定 | 海外阅读 |
| --- | --- | --- | --- |
| 列表页：表头 + 复选框 + 筛选 + 分页 + 行操作 | `dramas-list-client.tsx:200-223`（10 列：复选/剧集/平台/题材/分类/分类状态/集数/状态/上次推广抓取/创建时间/操作） | `CPS_PARITY_ADAPTED` | 书目列表列：复选/书名/来源应用/语种/题材标签/**分成比例**/章数/收费起始章/状态/上次同步/创建时间/操作 |
| 详情编辑页 | `dramas/[id]/edit/page.tsx` | `CPS_PARITY_ADAPTED` | 小说详情编辑 |
| 新建页 | `dramas/new/page.tsx` | `CPS_PARITY` | 人工录入通道（应急补录） |
| 批量向导：三步式 | `batch-wizard.tsx:182,665,699`（`step` 1→2→3：筛选 → 预览 → 结果） | `CPS_PARITY` | **三步式整体照搬**，是已验证的批量交互 |
| 任务列表 6 列 | `tasks/page.tsx:54-71` | `CPS_PARITY` | 原样 |
| 任务详情页 | `tasks/[id]/page.tsx` | `CPS_PARITY` | 两级任务 + item 明细 |
| 自动刷新 | `task-auto-refresh.tsx` | `CPS_PARITY` | 原样 |
| 任务控制按钮 | `task-control-buttons.tsx` | `CPS_PARITY` | 原样 |
| 复制值按钮 | `copy-value-button.tsx` | `CPS_PARITY` | 原样（推广码复制场景） |
| 重试失败推广 | `retry-failed-promo-button.tsx` | `CPS_PARITY_ADAPTED` | 原样，换小说语义 |

**字段级复刻**：来源条目、推广链接、任务、审计四组表的字段清单已在 candidate-v0.2.1 逻辑数据模型逐字段定稿，本矩阵不重复。**唯一新增**：`PromoLink.public_redirect_code`（见 §6）。

---

## 4. Feature Flag

CPS 真身：`src/lib/feature-flags.ts`（17 个 flag，一 flag 一函数、读 env、默认关）。

| 机制 | 判定 | 说明 |
| --- | --- | --- |
| "一 flag 一函数、`=== "true"` 显式判定、默认关" | `CPS_PARITY` | **模式整体照搬**，全部 flag 名重写 |
| 双闸（`FEATURE_X` + `X_ALLOW_WRITE`） | `CPS_PARITY` | CPS 最成熟的工程资产，第一天就上 |
| 反向 flag（`isManualPromoEditLocked` 用 `!== "false"` 默认开） | `CPS_PARITY` | 安全默认开的锁定类 flag 用这个形态 |
| Dashboard 与 API sync 分离双开关 | `CPS_PARITY` | CPS `v7.10.0` INT-2 的做法：看板显示与手动同步各一个 flag |
| 菜单可见性由 flag 驱动 | `CPS_PARITY` | `sidebar.tsx:76-79,169-170` |

**海外阅读 P1 需要的 flag（初版）**：`FEATURE_NOVEL_CATALOG_SCAN` + `NOVEL_CATALOG_SCAN_ALLOW_WRITE`、`FEATURE_NOVEL_PREVIEW_MATERIALIZE` + `..._ALLOW_WRITE`、`FEATURE_PROMO_READ` + `..._ALLOW_WRITE`、`FEATURE_PROMO_CLAIM`（P3，默认关）、`FEATURE_INDEXNOW_OUTBOX`、`FEATURE_SITEMAP_AUTO_REFRESH`、`FEATURE_CHANNEL_SYNC_WORKER`、`FEATURE_TRACKING`。

---

## 5. 任务体系

CPS 真身：`worker/index.ts:41-61`（超时表）、`:65-84`（`HANDLERS` 18 个 taskType）。

| 机制 | CPS 现状 | 判定 | 海外阅读 |
| --- | --- | --- | --- |
| `HANDLERS` 常量注册表 | 18 个 taskType，未注册类型 → `markTaskFailed` 而非静默 | `CPS_PARITY` | 原样，类型换小说 |
| 按类型超时表 | 30 分钟 ~ 12 小时分档 | `CPS_PARITY` | 原样，值按小说任务重估 |
| 两级任务（batch + 领域） | `batch_tasks` + `channel_sync_task`/`_item` | `CPS_PARITY` | 原样；**另加 `CatalogScanTask`** 第三条线 |
| 分轮续跑 | 领域态 `processing` → batch 态 `pending` 桥接 | `CPS_PARITY_ADAPTED` | 保留**分轮语义**；PG 下用显式租约表达，不用状态回退 |
| 任务领取 | ⚠️ `findFirst` → `update` 两步，**非原子** | **`ORIGINAL_REQUIRED`** | **原因：CPS 实现是 SQLite 单 worker 前提下的产物**，多 worker 必然重复领取。改 `SELECT … FOR UPDATE SKIP LOCKED` + 同事务 update/audit |
| active task 互斥 | ⚠️ 抢 SQLite 写锁 `UPDATE … WHERE id=-1`（`changdu-promo-claim-enqueue.ts:202-206`） | **`ORIGINAL_REQUIRED`** | **原因：PG 下影响 0 行、不加锁、不报错——保护静默消失**（极高风险）。改部分唯一索引；**目录扫描用账户×应用×projectType 单 active** |
| item lease | 隐式（status + startedAt） | **`ORIGINAL_REQUIRED`** | **原因：隐式租约在多 worker 下无法判定归属**。改显式 `locked_by` / `locked_until` / 心跳 |
| attempt 计数时机 | **领取时** +1（`channel-sync-task.ts:751-760`） | `CPS_PARITY` | 🔴 关键细节：崩溃也计次，毒药 item 必然收敛 |
| item 级 stale 恢复 | 30 分钟；attempt<3 → 重置 pending，≥3 → failed | `CPS_PARITY` | 原样 |
| 状态由 item 计数派生 | `channel-sync-task.ts:566-584` | `CPS_PARITY` | 🔴 禁止内存累加器 |
| 每 10 item 检查点 | `:827-835` | `CPS_PARITY` | 原样 |
| allowlist ∩ HANDLERS | `worker/guardrails.ts:28-34`；allowlist 为空即不消费 | `CPS_PARITY` | 🔴 双重 fail-closed 原样 |
| 崩溃恢复 | 超时 → `process.exit(1)` → PM2 拉起 | `CPS_PARITY_ADAPTED` | 容器编排层替代 PM2 |
| Cron | ⚠️ 4 个 cron 在 Next 进程内靠 `globalThis` 去重（`instrumentation.ts:18,76,123,142`） | **`ORIGINAL_REQUIRED`** | **原因：多副本必然重复执行**（继承矩阵标高风险）。改独立 Scheduler 容器 + `(schedule_key, scheduled_bucket)` 唯一键 |

---

## 6. 推广链接与 `/go`

| 机制 | CPS 现状 | 判定 | 海外阅读 |
| --- | --- | --- | --- |
| 推广资产独立成表 | `drama_promo_link`（`schema.prisma:292-326`），canonical 只是可选投影 | `CPS_PARITY` | 原样 |
| 幂等键含账号维度 | `(channelAppId, sourceKey, sourceLanguageCode, channelAccountId)` | `CPS_PARITY` | 原样 |
| canonical 只补空不覆盖 | 第三把钥匙控制 | `CPS_PARITY` | 原样 |
| pre-read → claim → readback → writeback | `changdu-promo-claim.ts` 全链 | `CPS_PARITY` | 🔴 四段不得合并 |
| 写前意图审计 | `:933-946` → `:948`，先提交再调上游 | `CPS_PARITY` | 🔴 最高优先级，不得简化 |
| 反重复领取闩 | `:500-522,855-884` | `CPS_PARITY` | 🔴 结果未知禁止自动重试 |
| 审计脱敏 | `[redacted_code:length=N]` + hostname（`:371-384,568-570`） | `CPS_PARITY` | 🔴 安全刚性 |
| **`/go/:code` 的 code 语义** | ⚠️ **直接用渠道真实推广码**：路由按 `dramas.promo_code` 查（`go/[code]/route.ts:94-98`），前端把真实码编进 URL（`drama-cta.ts:48-55`），且 `Drama.promoCode` **无唯一约束**（`schema.prisma:32`） | **`ORIGINAL_REQUIRED`** | **原因：CPS 现状本身是反例**。Owner 已裁决拆两码：`upstream_code`（内部）/ `public_redirect_code`（公开唯一暴露） |
| 短码**生成机制** | `article-public-page-id.ts:32-44`：字母表 + **强制含数字** + 冲突重试 + DB 唯一约束；全仓唯一短码生成处 | `CPS_PARITY_ADAPTED` | **改造复用**，不发明新算法。防"多模型重复发明短码"靠：唯一入口 + DB 唯一 + 不可变 |
| Page Identity 与跳转码 | 未混用（`public_page_short_id` 从不进 `/go`） | `CPS_PARITY` | 继承这条边界 |
| 跳转 URL 协议校验 | `normalizeRedirectUrl`（`route.ts:160-168`）只放行 http/https | `CPS_PARITY_ADAPTED` | 原样 + **加 host 白名单** |
| 埋点写入 | ⚠️ 每事件一次 `create`（`cps-tracking.ts:147`）；生产已整体关停（`docker-compose.yml:78-80`） | **`ORIGINAL_REQUIRED`** | **原因：这是 SQLite 单写者压力的直接证据**——功能不是没做，是做完被迫关掉。PG 下改批量写 + 独立 flush |
| IP/UA 盐哈希 | `hashSensitive`（`:284`），不存原值 | `CPS_PARITY` | 原样 |

---

## 7. 凭证管理

CPS 真身：`channel-accounts/actions.ts`（6 个业务操作 + 6 个 form 包装）、`channel-account/credential-crypto.ts`、`jwt.ts`、`service.ts:181-262`。

| 机制 | CPS 现状 | 判定 | 海外阅读 |
| --- | --- | --- | --- |
| 页面操作集合 | `create` / `updateJwt` / `validateJwt` / `disable` / `enable` / `supersedeCredential` | `CPS_PARITY` | **六个操作整体照搬** |
| Server Action 双层 | 业务函数 + `*FromForm` 包装（`actions.ts:211-278`） | `CPS_PARITY` | 原样，是干净的表单边界 |
| 能力位门控 | 每个写操作首行 `requireAdminCapability(session, 'credential:manage')`（`:54`） | `CPS_PARITY` | 🔴 原样 |
| AES 加密 | `credential-crypto.ts`，密钥 base64 解码须 32 字节 | `CPS_PARITY` | 零渠道耦合，纯资产 |
| JWT 本地校验 | `validateJwtLocally`，**不调渠道接口** | `CPS_PARITY` | 原样 |
| 三重校验 | 存在 → `expiresAt` → 载荷本地解析 | `CPS_PARITY` | 原样；`missing` / `expired` 必须二分 |
| 换证事务 | 旧证 `superseded` + 新证 active + ChangeLog，同一事务 | `CPS_PARITY` | 原样 |
| 指纹 DB 级互斥 | 独立唯一表把应用层 TOCTOU 升级为原子约束（`schema.prisma:1236-1258`） | `CPS_PARITY` | 🔴 **模式照搬**（表本身属 `ChangduTotalRevenue*`，只取模式） |
| 三轨凭证 + `conflict` 态 | `beidou-config.ts:7-18` | **`DROP`** | **原因：三轨并存直接催生 conflict 复杂度**。只允许单轨 |
| `site_settings` 明文列 | `schema.prisma:1541-1551` | **`DROP`** | **原因：明文存储**，与加密单轨冲突 |
| env 凭证兜底 | `beidou-config.ts:10` | **`DROP`** | 同上 |

---

## 8. 审计

| CPS 审计表 | 证据 | 判定 | 海外阅读 |
| --- | --- | --- | --- |
| `channel_account_change_log` | `schema.prisma:170-185` | `CPS_PARITY` | 原样 |
| `changdu_promo_claim_audit` | `:351-387`，四段独立 status 列 | `CPS_PARITY` | 🔴 四段留痕不得合并 |
| `changdu_drama_promotion_audit` | `:328-348` | `CPS_PARITY_ADAPTED` | 合并进推广审计 |
| `home_carousel_change_log` | `:831-843` | `CPS_PARITY` | 随轮播一起搬 |
| `login_attempts` | `:1680-1687` | `CPS_PARITY` | 登录风控原样 |
| `legacy_credential_change_log` | `:188-199` | **`DROP`** | **原因：CPS 历史迁移专用** |
| `article_drama_switch_log` | `:614-631` | **`DROP`** | **原因：换租客是 CPS 特有历史包袱**，新项目无此问题 |
| `drama_dedup_log` | `:1972-1986` | **`DROP`** | 旧来源身份配套 |
| 审计与业务同库同事务 | 立项书 §3.5 结论三 | `CPS_PARITY` | 🔴 **不建独立审计库**——否则写前意图审计的"已提交"前提不成立 |
| 脱敏刚性 | `changdu-promo-claim.ts:371-384` | `CPS_PARITY` | 🔴 审计表必须能安全外流 |
| 错误文案清洗 | `sanitizeChangduPromoInfoMessage`（`:350-354`） | `CPS_PARITY` | 防上游把凭证片段回显进日志 |
| 响应形状快照 | `responseShapeJson`（`:571`）存结构非内容 | `CPS_PARITY` | 便于排查上游合同变更 |

---

## 9. 批量发布

| 机制 | CPS 现状 | 判定 | 海外阅读 |
| --- | --- | --- | --- |
| Article 状态机 | `draft / pending / published / offline` **四态，无审核态**（`constants.ts:6-11`） | `CPS_PARITY` | 🔴 原样——**不加人工审核态** |
| 生成即发布 | `resolveAutoArticlePublication`：`now` → published，`scheduled` → pending（`article-generation.ts:63-90`） | `CPS_PARITY` | 原样 |
| 机器门禁 ①分类缺失 | 自动降级 draft，不打断批次（`:68-74`） | `CPS_PARITY` | 原样 |
| 机器门禁 ②推广链接空 | 硬拒绝，渠道无关（`article-actions.ts:563-567`，注释直书 "Hard gate"） | `CPS_PARITY` | 原样 + **加公开码已分配** |
| 机器门禁 ③locale 不匹配 | 拒绝（`:569-576`） | `CPS_PARITY` | 原样 |
| 批量向导默认值 | `publishType` 默认 `draft`，可显式选 `now`（`batch-wizard.tsx:212`） | `CPS_PARITY` | **默认保守、显式放开**，是好形态 |
| 发布后自动化 | 自动入队 review 生成 / preview catalog / IndexNow（`batch-generate.ts:117-170`） | `CPS_PARITY_ADAPTED` | 换小说后置任务；**去掉 review 生成**（V1 无评论） |
| 模板引擎 | `{field}` 替换 + `{if}…{endif}` + 白名单 + `TemplateVarEmptyError`（`template-engine.ts:39-74`） | `CPS_PARITY_ADAPTED` | 引擎本体照搬；`WILDCARD_FIELDS` 全表重写；**作者/国家/完结不登记进白名单** |

---

## 10. Sitemap

| 机制 | CPS 现状 | 判定 | 海外阅读 |
| --- | --- | --- | --- |
| 静态产物 + 只读服务 | 请求路径不触发生成 | `CPS_PARITY` | 原样 |
| 手动刷新卡片 | `settings/sitemap-card.tsx` + `sitemap-actions.ts`（`getSitemapRefreshState` / `refreshSitemap`） | `CPS_PARITY` | 原样 |
| 文件锁防并发 | CPS v7.2.3 的做法 | `CPS_PARITY_ADAPTED` | PG 下用 advisory lock 或任务互斥 |
| 失败保留 last known good | v7.2.3 | `CPS_PARITY` | 🔴 原样 |
| 路径穿越防护 | `static-sitemap-cache.ts:35-41` | `CPS_PARITY` | 🔴 原样 |
| 产物落本地磁盘 | `static-sitemap-cache.ts:11-17` 等 | **`ORIGINAL_REQUIRED`** | **原因：多副本下本地磁盘产物不一致**。改落对象存储 |
| 原生 SQL | `sitemap.ts:584-600`（CTE + `tr.enabled = 1` 布尔当整数 + `AS pageCount` camelCase 别名） | **`ORIGINAL_REQUIRED`** | **原因：三处在 PG 下都会出问题**，别名折叠是静默故障。改 Prisma 查询 |
| 闭包泄漏 | `sitemap.ts:12` 引 `DISPLAY_NAME_TO_APP_ID` 拖入整条北斗 HTTP 栈（3 文件 599 行） | `CPS_PARITY_ADAPTED` | **搬前先切断**，闭包 27 → ≈21 文件 |
| 分片按 locale | 已验证 | `CPS_PARITY` | 分片数 = 白名单语种数 |

---

## 11. IndexNow

CPS 真身：`indexnow-outbox-contract.ts`（纯契约零耦合）、`indexnow-outbox.ts`、`indexnow-delivery-service.ts`、`worker/handlers/indexnow-delivery.ts`，10 个测试覆盖。

| 机制 | CPS 现状 | 判定 | 海外阅读 |
| --- | --- | --- | --- |
| outbox 模式 | 业务事务只写 outbox 行，投递由 worker 异步做 | `CPS_PARITY` | 🔴 原样——搜索引擎挂了不拖垮发布 |
| 投递状态机 | `pending/processing/accepted/retry_wait/permanent_failed/dead_letter/cancelled`（`contract.ts:39-48`） | `CPS_PARITY` | **七态整体照搬** |
| 延迟推送原因 | `await_review_schedule` / `await_review`（`:7-10`） | `CPS_PARITY_ADAPTED` | V1 无评论生成，延迟原因换"待发布调度" |
| 等待上限有界 | `resolveIndexNowReviewMaxWaitMs` / `resolveIndexNowScheduleMaxWaitMs`，`Math.min(parsed, maximum)` 双向钳位（`:24-37`） | `CPS_PARITY` | 🔴 有界参数钳位原样 |
| sitemap 陈旧判定 | `INDEXNOW_SITEMAP_STALE_MS = 35min`（`:3`） | `CPS_PARITY` | 原样 |
| 幂等键 | `(url, revision)` | `CPS_PARITY` | 🔴 **不含 revision 之外的易变字段** |
| 通用 stale 恢复 | `batch-task-stale-recovery.ts`（34 行纯资产） | `CPS_PARITY` | 原样 |
| 后台重推 | 手动重推入口 | `CPS_PARITY` | 原样 |

---

## 12. `ORIGINAL_REQUIRED` 汇总（共 9 项，全部举证）

| # | 项 | 原因分类 | 一句话理由 |
| ---: | --- | --- | --- |
| 1 | 试读管理页 / 章节实体 | **CPS 无对应物** | CPS 只有 `episodeCount` 标量；`DramaPreviewAsset` 是视频语义且行数被卡死，形状不可平移 |
| 2 | 后台鉴权默认拒绝 | **CPS 现状是缺陷** | 立项书 §9.4 明列"不要继承"：靠每个 route 自觉调 |
| 3 | proxy 层不查库 | **CPS 现状是负担** | `proxy.ts:80-136` 每次公开详情页打 1–2 次库 |
| 4 | Worker 原子领取 | **SQLite 前提失效** | `findFirst`→`update` 两步，多 worker 必然重复领取 |
| 5 | active task 互斥 | **PG 下静默失效** | 抢 SQLite 写锁在 PG 下影响 0 行、不加锁、不报错 |
| 6 | item 显式租约 | **隐式租约不可判定归属** | status + startedAt 在多 worker 下无法确定谁持有 |
| 7 | Cron 唯一执行 | **多副本重复执行** | `globalThis` 去重，web 扩 N 副本就跑 N 次 |
| 8 | `/go` 公开短码 | **CPS 现状是反例** | 真实码进公开 URL 且无唯一约束；Owner 裁决拆两码 |
| 9 | 埋点批量写 / sitemap 产物落对象存储 / sitemap 原生 SQL | **SQLite 或单机产物** | 埋点因单写者压力被迫关停；本地磁盘产物多副本不一致；`AS camelCase` 在 PG 静默折叠 |

**九项中有七项的根因是同一个：CPS 的实现建立在"SQLite + 单进程"前提上。** 这正是海外阅读 Day 0 上 PG 的理由，也说明这些偏离不是品味问题而是前提变更的必然结果。

---

## 13. 北斗（第二渠道）占位

> Owner 2026-08-02 补充：**北斗接口尚未调研。北斗的表和流程可以先参考短剧来占位，包括系统后台，等二期再开启北斗。**

这条补充改变了 candidate-v0.2.1 里"北斗全链路 `DROP`"的口径——不是推翻，是**区分了两件事**：

| 事 | 口径 |
| --- | --- |
| 北斗的**协议实现**（`beidou-list-api.ts` / `beidou-http.ts` / `batch_promo` 单级任务） | 仍然 **`DROP`**——那是北斗特定协议 + 单级任务旧形态，且接口未调研 |
| 北斗的**表与流程形态** | **`CPS_PARITY_ADAPTED` 占位**——以 CPS 短剧链路为参照预留结构，二期填充 |

### 逐项占位判定

| 项 | 判定 | 说明 |
| --- | --- | --- |
| `Channel` 表登记 `beidou` | `CPS_PARITY` | 一行数据，`status = 'inactive'` |
| `SourceApp` / `ChannelApp` 绑定 | `CPS_PARITY` | 结构已渠道无关，无需为北斗改表 |
| `ChannelAccount` / 凭证 | `CPS_PARITY` | 同上；北斗账户可建但禁用 |
| 来源条目表 | `CPS_PARITY` | `NovelSourceItem` 的 `(channel_app_id, external_id, source_language_code)` 唯一键天然容纳第二渠道 |
| 任务表与流程 | `CPS_PARITY_ADAPTED` | 目录扫描 / 同步 / 推广读取三条线**形态参照 CPS 短剧**，北斗接入时复用 |
| Adapter 能力注册 | `CPS_PARITY` | 全部能力登记为 `registered_disabled`，`reason_code = channel_not_researched` |
| 后台 | `CPS_PARITY_ADAPTED` | 渠道维度可见、北斗选项禁用（见 `P1_ADMIN_PARITY_SPEC.md` §6） |
| worker allowlist | `CPS_PARITY` | 北斗任务类型注册但**不在 allowlist**，worker 不消费 |
| 前台 | — | **零感知**（共享契约 §10 渠道无关性） |

### 三条占位纪律

1. 🔴 **占位 = 结构预留 + 显式禁用，不等于可以凭 CPS 短剧协议猜写北斗请求体。** 北斗的 Endpoint / Body / 幂等规则一律 `UNPROVEN`，与 `claimPromo` 同一处置口径。
2. **不为北斗单独建菜单或表。** 渠道维度已在现有页面与表里，北斗只是多一行注册数据。
3. **二期开启前置**：北斗接口只读调研（对齐 MoboReader 的调研深度）→ 字段字典 → Adapter 契约 → 能力注册转 `enabled`。

**这个占位设计的收益**：验证了渠道无关性不是纸面口号——如果北斗接入需要动表结构或前台代码，说明第一渠道的抽象做漏了。**北斗是渠道抽象的试金石。**

---

## 14. `DROP` 汇总

批量导入页 / 分类规则页（V1）/ 三轨凭证 + `conflict` 态 / `site_settings` 明文凭证列 / env 凭证兜底 / `legacy_credential_change_log` / `article_drama_switch_log` / `drama_dedup_log` / 飞书整条链路 / `DramaSourceMapping` 旧来源身份 / 北斗 `batch_promo` 单级任务 / 试看视频链路 / SQLite 写锁 hack / 无守卫 `PRAGMA busy_timeout` / `ChangduTotalRevenue*` 五表（**指纹互斥模式除外**）/ `ArticleDramaSwitch*` 四表 / `Beidou*` 与 `Settlement*` 表 / `cache-tags.ts`（重新设计）。
