# 海外阅读 v1 · 总体技术架构 v0.1（候选）

> 文档性质：**架构候选**，待 Owner 审核。非 Owner 已确认。
> CPS 代码基线：`d77c3b968285698529cf97c7f0f97b286d7a2a9c`（v8.1.1，树干净）
> 配套文档：`novel-v1-evidence-reconciliation.md`（证据）、`novel-v1-logical-data-model-v0.1.md`（数据模型）、`novel-v1-adapter-and-workflow-v0.1.md`（契约与流程）、`novel-v1-implementation-plan-v0.1.md`（阶段计划）、`novel-v1-open-decisions.md`（待决）

---

## 1. 这个系统要做什么

海外阅读是一个**内容分发站**：它从上游书城（当前是 MoboReader）把小说目录同步进来，为每本书生成一个可被搜索引擎收录的落地页，页面上放该书的免费试读章节和一个带推广码的跳转按钮。读者点按钮去上游 App 阅读付费章节，我们按分成比例拿收益。

拆成四句话：

1. **进货**——运营发起一个批次，系统从上游拉一段目录回来，存成"来源条目"。
2. **上架**——把来源条目转成站内的权威内容实体，生成多语种落地页，推给搜索引擎。
3. **挂链**——把上游的推广资源（推广码 + 落地 URL）绑到内容上，前台的跳转按钮才有目标。
4. **对账**——回拉收益，归因到书和推广码。

V1 交付前三步。**第四步只留占位，不建表**——因为收益的归因维度还没探明（详见证据文档 §3.4）。

这四步在 CPS 短剧站已经跑了一整年，踩过的坑都记在 `docs/audit/novel-p0-beidou-changdu-inheritance-matrix.md` 里。海外阅读的技术选型主线只有一句：**继承畅读演进后的形态，把 SQLite 换成 PostgreSQL，除此之外不重新发明流程。**

---

## 2. 系统上下文与模块边界

### 2.1 文字架构图

```
                            ┌─────────────────────────────────────┐
                            │      上游渠道（畅读 / MoboReader）     │
                            │  kocserver-cn.cdreader.com          │
                            │  · getlistpc        目录列表  ✅已证 │
                            │  · getbydataid      素材信息  ✅已证 │
                            │  · getvideoinfo     资源信息  ✅已证 │
                            │  · getchapterinfo   试读章节  ✅已证 │
                            │  · Report/GetReport 收益汇总  ✅已证 │
                            │  · 生成推广资源      ❓合同未证       │
                            └───────────────┬─────────────────────┘
                                            │ HTTPS，只出不进
                                            │ 单一出口：Channel Adapter
     ┌──────────────────────────────────────┴──────────────────────────────────┐
     │                                                                          │
     │   ┌────────────────────────────────────────────────────────────────┐    │
     │   │  Channel Adapter 层（唯一允许发起渠道请求的地方）                 │    │
     │   │  · 能力注册表：每个能力显式登记 enabled / disabled + 证据等级      │    │
     │   │  · 只读能力与有副作用能力在类型上可区分                            │    │
     │   │  · QPS 上限 / 超时 / host 白名单 / 错误分类 / 文案清洗            │    │
     │   └───────┬────────────────────────────────────┬───────────────────┘    │
     │           │                                    │                         │
     │  ┌────────┴────────┐                  ┌────────┴─────────┐              │
     │  │  Worker 容器     │                  │  Web 容器         │              │
     │  │  · 原子领取任务   │                  │  ┌─────────────┐  │              │
     │  │  · 分轮续跑      │                  │  │ Public Web  │  │              │
     │  │  · item 级隔离   │                  │  │ 前台 SSR     │  │              │
     │  │  · 租约与恢复    │                  │  └─────────────┘  │              │
     │  │  · allowlist    │                  │  ┌─────────────┐  │              │
     │  └────────┬────────┘                  │  │ Admin CMS   │  │              │
     │           │                            │  │ 后台        │  │              │
     │  ┌────────┴────────┐                  │  └─────────────┘  │              │
     │  │ Scheduler 容器   │                  │  ┌─────────────┐  │              │
     │  │ · cron 单例选举  │                  │  │Internal API │  │              │
     │  │ · 只入队不干活   │                  │  │Server Action│  │              │
     │  └────────┬────────┘                  │  └──────┬──────┘  │              │
     │           │                            └─────────┼─────────┘              │
     │           │        ┌───────────────────────────┬─┘                        │
     │           └────────┤                           │                          │
     │                    ▼                           ▼                          │
     │        ┌────────────────────────┐   ┌──────────────────────┐             │
     │        │     PostgreSQL 主库     │   │   Object Storage      │             │
     │        │  · 业务表               │   │  · 封面                │             │
     │        │  · 任务与 item          │   │  · 运营上传物          │             │
     │        │  · 审计（同库同事务）    │   │  · sitemap 静态产物    │             │
     │        │  · 凭证（加密列）        │   └──────────────────────┘             │
     │        │  · IndexNow outbox      │                                        │
     │        │  · 埋点事件             │                                        │
     │        └────────────────────────┘                                        │
     │                                                                           │
     │  海外阅读边界（独立仓库、独立数据库、独立部署，与 CPS 零共享）                │
     └───────────────────────────────────────────────────────────────────────────┘
                    │                                    │
                    ▼                                    ▼
        ┌────────────────────┐              ┌──────────────────────┐
        │  搜索引擎            │              │  读者浏览器            │
        │  · Sitemap 抓取     │              │  · 落地页 SSR         │
        │  · IndexNow 推送    │              │  · /go/:code 跳转     │
        └────────────────────┘              │  · 埋点上报           │
                                             └──────────────────────┘
```

### 2.2 模块职责与边界

| 模块 | 职责 | 明确不做 |
| --- | --- | --- |
| **Public Web** | 前台 SSR：首页、小说详情、试读章节、语言/题材聚合、`/go/:code`、下架页、sitemap 路由、SEO 元数据 | 不查渠道、不写业务表（除埋点）、不在中间件层查库 |
| **Admin CMS** | 后台：渠道账户、书目同步、书目与详情、试读管理、已有推广资源、Article 模板、发布、任务中心、审计、IndexNow、收益占位 | 不直接调渠道接口（一律经 Adapter）、不绕过双闸 |
| **Internal API / Server Actions** | 后台与前台的服务端入口，鉴权、能力位校验、入队工厂 | 不承载长任务（一律入队交 Worker） |
| **Worker** | 唯一执行渠道同步、试读物化、推广读取/领取、IndexNow 投递、sitemap 刷新的进程 | 不自建任务（除 stale 恢复）、不消费未在 allowlist 的类型 |
| **Scheduler** | cron 单例，只负责"到点了建一条任务" | **绝不执行业务逻辑**。防止调度与执行耦合 |
| **PostgreSQL** | 唯一状态真源。业务表 + 任务表 + 审计表 + 凭证表 + outbox + 埋点 | 不做全文检索引擎、不做队列中间件之外的事 |
| **Object Storage** | 封面、运营上传物、sitemap 静态产物 | 不存正文、不存凭证 |
| **Channel Adapter** | 渠道协议的唯一实现处，能力注册表 | 不含业务状态机、不写业务表 |
| **IndexNow / Sitemap** | outbox 落库 → Worker 投递；sitemap 静态产物生成与只读服务 | 不在请求路径上同步推送 |
| **Tracking** | `/go/:code` 点击与页面事件 | V1 不做实时归因计算 |
| **Revenue（占位）** | 仅保留架构位置与 Adapter 能力登记 | **V1 不建表、不写代码** |
| **Credentials & Audit** | 加密凭证单轨 + 变更日志 + 操作审计（同库同事务） | 不做独立审计库、不落明文 |

### 2.3 三条边界纪律

**一、渠道请求只有一个出口。** 任何业务代码都不许 `fetch` 渠道 host。CPS 的教训是 `DISPLAY_NAME_TO_APP_ID` 这一个常量，把整条北斗 HTTP 栈拖进了 sitemap 的依赖闭包（`novel-p0-reuse-dependency-closure.md:198-219`）。海外阅读的 Adapter 必须是**叶子模块**：业务依赖它，它不依赖业务。

**二、cron 绝不在 Web 进程里。** CPS 现在 4 个 cron 全在 Next 进程内靠 `globalThis.__cronRegistered` 去重（`src/instrumentation.ts:18,76,123,142`），多副本必然重复执行。这是继承矩阵标记为**高风险**的项。海外阅读第一天就用独立 Scheduler 容器 + 数据库唯一键作为正确性边界（原型 `SANDBOX_PROVEN`）。

**三、审计与业务写在同一个事务里。** 不建独立审计库。理由不是省事，是**正确性**：写前意图审计如果和业务分库，就无法保证"审计已提交"这个前提，反重复领取闩会失效。

---

## 3. 模块与 CPS 复用矩阵

**总纲：按符号切割，不按文件闭包整包复制。**

这不是风格偏好。依赖闭包审计的结论是：M10 sitemap 的 27 文件闭包里有 3 个北斗 HTTP 文件，只因 `src/lib/sitemap.ts:12` 引了一个常量；M11 import 的 40 文件 / 8,819 行闭包里，`nodejieba` 和 `sharp` 两个原生依赖各由一个符号拖入（`novel-p0-reuse-dependency-closure.md:243-254`）。整包复制的代价不是多几个文件，是**把 PG 阻塞点和原生编译依赖一起搬进新项目**。

| 模块 | CPS 来源 | COPY | ADAPT | PG_REIMPL | DROP | 新建 | 原因 |
| --- | --- | :---: | :---: | :---: | :---: | :---: | --- |
| **鉴权 / 会话 / 2FA / 登录风控** | `src/lib/auth.ts` `admin-session.ts` `two-factor-*.ts` `totp*.ts` `recovery-codes.ts` `turnstile.ts` | ✅ 11 个根文件 | `db.ts`（去 CPS 专属 delegate 探测 `:43-59`）、`datasource-url.ts:5`（去 `file:` 回落改 fail-fast） | — | `sqlite-busy-timeout.ts`（PG 下整体无意义） | — | 闭包 14 文件 / 1,920 行，只触达 4 个 model，零渠道耦合。**最干净的可搬资产** |
| **admin capabilities（能力位）** | `src/lib/admin-capabilities.ts` | ✅ 全文件 | 能力名与 env key 重列 | — | — | — | 单文件 81 行、零本地依赖。`credential:manage` 门控凭证写入这条必须继承 |
| **Feature Flag** | `src/lib/feature-flags.ts` | ✅ 结构与"一 flag 一函数、默认关"模式 | 全部 flag 名重写 | — | — | — | 单文件、零依赖。当前 17 个 flag（v8.1.1 新增 `isSiteSearchEnabled`） |
| **凭证加密 + JWT 本地校验** | `channel-account/credential-crypto.ts` `jwt.ts` | ✅ 两个文件（零渠道耦合，纯资产） | `service.ts`（剥离 changdu 分支，**加入指纹互斥表逻辑**） | — | 三轨解析、`conflict` 态、env 兜底、`site_settings` 明文列 | — | `validateJwtLocally` 不调上游即可判过期。**凭证只走单轨** |
| **Channel / SourceApp / ChannelApp 注册** | `channel-registry.ts` `source-app-registry.ts` `channel-language.ts` `channel-request-params.ts` | 表结构 + 三元唯一键设计 | 4 个 `.ts` 的**全部数据内容**（渠道码、书城码、语种映射） | — | `constants.ts` 整体（混杂多渠道显示标签） | `locale-canonical.ts`（**单一语种真源**） | `@@unique([channelId, sourceAppId, externalAppId])` 设计良好。但 CPS 有"四处独立语种映射"的历史债，海外阅读第一天就建单一真源 |
| **Channel Adapter** | `src/lib/adapters/channel.ts`（仅 2 方法 34 行）`changdu*.ts` | 错误分类 18 值的**粒度**、`sanitize` 文案清洗、`responseShape` 快照思路 | — | — | `adapters/changdu.ts` 实现、`adapters/beidou.ts`、`adapters/feishu.ts` | **10 能力契约 + 能力注册表**（见契约文档） | CPS 的 Adapter 太窄（只有 `listDramas` / `normalizeRawDrama`），且 `projectType=2` 在 `changdu-getcode.ts:7` 硬钉。必须显著加宽并参数化 |
| **template engine** | `src/lib/template-engine.ts` | ✅ 引擎本体：`{field}` 替换、`{if}…{endif}`、白名单、`TemplateVarEmptyError`（`:39-74`） | `WILDCARD_FIELDS`（`:14-33` 18 项全是剧集字段）全表重写为小说字段 | — | `genre.ts`（按小说题材重写） | — | **缺值 fail-closed 这条正是回答"没有作者字段怎么办"的机制**：不登记 = 模板里根本写不出来 |
| **slug alias + 页面身份** | `slug-alias.ts` `slug-utils.ts` `article-public-page-id.ts` `drama-article-path.ts` | ✅ `slug-alias.ts`（零业务耦合）；短码生成算法（`article-public-page-id.ts:32-43`，**短码强制含数字**这条保留） | `slug-utils.ts` 黑名单重列；路径规则改名 | — | — | — | `pinyin-pro` 依赖需评估（小说标题 CJK 场景与短剧一致） |
| **Sitemap** | `sitemap.ts` `static-sitemap-generator.ts` `static-sitemap-cache.ts` `sitemap-refresh-*.ts` | ✅ `static-sitemap-cache.ts` 的路径穿越防护（`:35-41`）；`sitemap-refresh-enqueue.ts`；`supported-site-locales.ts` | `sitemap.ts` 三处原生 SQL PG 化 + 小说语义 | 原生 SQL：`:584-600` CTE 中 `tr.enabled = 1`（布尔当整数）、`AS pageCount`（camelCase 别名）在 PG 下必改 | `article-v2-service.ts` `adapters/beidou.ts` `beidou-list-api.ts` `beidou-http.ts` | 静态产物落 Object Storage 而非本地磁盘 | **必须先切断 `sitemap.ts:12` 的 `DISPLAY_NAME_TO_APP_ID` 泄漏**，闭包从 27 文件 / 5,249 行降到约 21 文件 / 3,700 行 |
| **IndexNow** | `indexnow-outbox-contract.ts` `indexnow-outbox.ts` `indexnow.ts` `indexnow-delivery-service.ts` + handler | ✅ `indexnow-outbox-contract.ts`（纯契约零耦合）；`batch-task-stale-recovery.ts`（34 行通用 stale 恢复，纯资产） | `indexnow.ts` `indexnow-outbox.ts`（含 `dramaId` 与 article 语义） | — | `constants.ts` 整体 | 结构化日志替代 `worker/utils.ts` 的 logger | outbox 模式（落库 → Worker 投递）本身是正确形态，10 个测试覆盖 |
| **import parser（CSV/XLSX）** | `import-service.ts` `worker/handlers/batch-import.ts` | ✅ **只保留 `import-service.ts:28-58,60` 的 `parseCsvLine` / `parseCsv`（30 行零依赖纯函数），作一次性运维脚本，带 `dryRun`** | — | — | ✅ **整条表格通道废弃**：不建 `import` 后台页面、不建 npm script、`nodejieba`/`sharp`/`xlsx` **不进依赖树**；`article-generation.ts` `article-post-publish-jobs.ts` `post-drama-sync-jobs.ts` `changdu-preview-*` `reviews/review-generation.ts` `cover-processor.ts` `tag-classifier.ts` `synonym-dict.ts` 一律不搬 | — | 立项书 §4.2（2026-08-01 决策）+ §14.2 P2-12。40 文件 / 8,819 行闭包里核心价值只有 30 行，**四条泄漏各由一个符号引起** |
| **tracking / `/go/:code`** | `cps-tracking.ts` `tracking.ts` | ✅ 事件表结构（6 个索引设计良好）；`hashSensitive` 盐哈希（`:284`，IP/UA 不存原值） | 汇总表去 `beidou_*` 列；**写入策略重设计**（当前每事件一次 `create`，PG 下应批量写 + 独立 flush） | — | `settlementOrder` 回填分支 | — | CPS 生产已整体关停埋点写入（`docker-compose.yml:78-80`），**这是 SQLite 单写者压力的直接证据，PG 下可解封** |
| **attribution / revenue** | `changdu-revenue/*`（15 文件 / 3,909 行） | 四段式管线**语义**；`candidateCount` + `candidateSnapshotJson` 存当时候选集的思路 | — | — | `client.ts` `sync.ts` `dashboard.ts` 实现；`adapters/changdu.ts` | **V1 不新建任何表** | 归因维度未证（证据文档 §3.4）。**继承思想，不继承表** |
| **任务与 Worker** | `worker/index.ts` `channel-sync-task.ts` `batch-task-stale-recovery.ts` + 桥接 handler | ✅ 两级任务、分轮续跑、item 隔离、attempt 领取时计数、每 10 item 检查点、派生状态、allowlist ∩ handlers、TTL、超时表 | 桥接形态可简化（PG 下不必用 batch 态回退表达续跑） | ✅ **原子领取**、**active task 互斥**、**item 显式租约**、`withDbRetry` 按 PG 错误码重写、并发上限重估 | SQLite writer-lock hack（`changdu-promo-claim-enqueue.ts:202-206`）、无守卫 `PRAGMA busy_timeout`（`channel-sync-task.ts:302,386`）、北斗 `batch_promo` 单级模型 | — | **只允许改"怎么拿到任务、怎么加锁"，不允许改"拿到之后做什么"** |
| **写入安全闸** | `changdu-promo-claim.ts:590-619,684` `changdu-promo-claim-limits.ts` | ✅ 全部：Feature Flag → Allow Write → 批量上限 → 任务 TTL → canonical 第五把钥匙；dry-run；单条 canary；拒绝"按筛选全量" | 剧场白名单换书城清单 | — | — | — | **四道闸不得并成一道。每道对应不同的人、不同的授权时刻** |
| **领链状态机** | `changdu-promo-claim.ts` 全文 | ✅ pre-read → claim → readback → writeback 四段；**写前意图审计**；**反重复领取闩**；空数据隔离转人工；有界重试双向钳位；审计脱敏；幂等键含账号维度 | 协议换（getcode → 未知） | — | — | `claimPromo` 以"已登记未启用"能力形态存在 | **本次审计发现的最高价值机制，不得简化** |
| **cron** | `src/instrumentation.ts:13-15,18,76,123,142` | — | — | ✅ 移出 Web 进程，独立 Scheduler + `(schedule_key, scheduled_bucket)` 唯一键 | `globalThis.__cronRegistered` 去重 | — | 多副本下必然重复执行，继承矩阵标记**高风险** |
| **proxy / 路由保护** | `src/proxy.ts` | 保护前缀清单的**形态** | — | — | **禁止在 proxy/middleware 层查库**（`proxy.ts:80-136` 是已知负担） | 新路由必须显式登记进保护前缀 | CPS 用 Next16 `proxy.ts` 而非 `middleware.ts`；新后台路由漏登记会 404 |
| **飞书通道** | `adapters/feishu.ts` `site_settings.feishu_*` | — | — | — | ✅ **整条不搬** | — | 官方已冻结 |
| **首页轮播** | `home_carousel_manual_slot` / `auto_batch` / `auto_candidate` / `serving` / `change_log`（`prisma/schema.prisma:740-843`）+ `home-carousel-config.ts` | 五表结构与"人工位 + 自动打分 + 合并"三段语义 | 打分维度换小说口径；locale 白名单 fail-closed 继承 | ⚠️ **`home-carousel-config.ts:101` 有 `AS camelCase` 别名**，PG 下静默折叠会让轮播**回落默认配置且不报错**。搬运时必须改 Prisma 查询 | — | — | **Owner 已裁决复用**（台账 D3）。CPS v7.7 的衰减分/新剧位/locale 白名单经验一并继承 |
| **ISR / 缓存标签** | `src/lib/cache-tags.ts`（**全文 19 行、只有 2 个 tag**） | — | — | — | ✅ **不照搬** | 重新设计缓存失效模型 | 立项书 §9.1 列为"最弱一环"，主要靠散落各处的 `revalidatePath`。本轮已复核确为 19 行 |
| **历史包袱表** | `DramaSourceMapping` `DramaDedupLog` `ArticleDramaSwitch*` `Beidou*` `Settlement*` `ChangduTotalRevenue*` | 只保留 `ChangduTotalRevenue*` 里的**指纹互斥表模式** | — | — | ✅ 其余整体不搬 | — | 全是 CPS 特有历史问题的解药，新项目无此病 |

---

## 4. 多语言方案

### 4.1 问题

Owner 已裁决 `catalog.languages = ALL`——所有语种都可以进来源目录。但"进数据层"和"公开发布"是两件事。V1 要不要把所有语种一次全公开？

### 4.2 两档方案

#### 方案 A · 数据层全语种，发布层按门槛白名单

数据层无差别接收所有语种的来源条目和 canonical 实体。一个语种要**公开发布**，必须先通过发布门槛：

1. 前台 messages 完整（无 fallback 到英文的可见文案）；
2. 后台模板语种枚举已登记（CPS `v6.0.4` 事故的直接教训）；
3. 该语种的文章模板已创建并跑通一次真实渲染；
4. SEO 元数据（title / description / OG locale / breadcrumb）齐全；
5. sitemap 分片与 hreflang 兄弟链路已验证。

五项齐全才进白名单，**白名单 fail-closed：未登记的语种，前台路由直接 404，sitemap 不收录，IndexNow 不推送。**

#### 方案 B · 全语种同步后立即全部公开

同步完就发布，语言包缺失处 fallback 到英文。

### 4.3 逐维对比

| 维度 | 方案 A | 方案 B |
| --- | --- | --- |
| **URL** | `/{locale}/novel/{slug}`，locale 必在白名单 | 同结构，但 locale 数量不受控 |
| **locale 归一** | 单一真源 `locale-canonical.ts`，上游语种码 → 站点 locale 显式映射；映射不到落 `unknown` 且**不发布** | 同样需要映射，但映射不到时被迫猜测或用上游原值当 locale |
| **slug** | 每 locale 独立 slug 空间，冲突时 suffix-or-throw，不静默覆盖 | 同左，但语种多时冲突面更大且无人工介入窗口 |
| **canonical** | **每个语种自己的 URL 是自己的 canonical**。绝不跨语种共用 | 同样必须如此，否则整站 canonical 塌缩 |
| **hreflang** | 只在白名单语种之间互指，集合封闭且可验证 | 兄弟集合随同步波动，容易出现指向 404 的 hreflang |
| **UI 文案** | 白名单语种保证无 fallback 可见 | 大量页面出现中英混排 / 英文兜底 |
| **Sitemap** | 分片数 = 白名单语种数，可控 | 分片数随上游语种数波动，产物体积不可预测 |
| **IndexNow** | 只推白名单，配额可控 | 推送量不可控，且可能推出低质页面 |
| **模板质量** | 每语种有专属模板且验收过 | 共用模板 + 机器直译，SEO 质量无法保证 |
| **内容混语风险** | 低。书名/简介来自上游该语种版本，UI 来自该语种 messages | **高**。上游某语种版本的简介可能是英文，配上该语种 UI 形成混语页 |
| **运维成本** | 每开一个语种一次显式验收，成本线性且可排期 | 首次上线成本低，**但一旦搜索引擎收录了低质页，修复成本远高于预防** |
| **回滚** | 从白名单摘掉一个语种即可，页面转 410/404 + sitemap 移除 | 已收录页面无法快速撤回 |

### 4.4 推荐：方案 A

理由三条：

**一、CPS 已经用事故证明过。** `v6.0.4` 的记录是："`TEMPLATE_LOCALE_OPTIONS` 补充 `cs`……防止后续公开语种只注册前台 locale 而遗漏后台模板/文章创建枚举"（`docs/governance/version-registry.md`）。这就是方案 B 的失败形态：语种"开了"，但链路上某一环没跟上。方案 A 把这一环变成准入条件而不是事后补丁。

**二、SEO 的错误是不对称的。** 少发布一个语种，损失是线性的流量机会；发布一批低质量混语页，损失是站点整体质量评分——而这是全站性的、恢复期以月计。

**三、成本其实差不多。** 方案 A 不是"少做"，是"排队做"。数据层照样全语种同步，运营看得到全量，只是发布按语种排期。真正的额外成本只有一张白名单表和一个准入检查清单。

**硬约束（不可协商）**：无论选哪个方案，**不同语言绝不共用同一个 canonical URL**。每个 `(小说, locale)` 有且只有一个 canonical URL，指向它自己。跨语种关系用 hreflang 表达，不用 canonical。

**V1 建议的初始白名单**：`en` 一个语种起步（已证样本为英语），第二个候选 `fr`（已有法语样本证据，但**法语的 `language` 数值枚举本轮未安全取得**，拿到前不可执行法语同步）。其余语种数据入库、后台可见、前台不发布。具体首发集合由 Owner 决定（待决项 D-7）。

### 4.5 与立项书的一处张力，以及 URL 形状建议

立项书三处表述同时成立时会产生一个缝隙：

| 立项书处 | 表述 |
| --- | --- |
| §C.2 | 语种 = **全部语种**（渠道侧上限 18 种） |
| §1.4 | **多语言 i18n 前台** → Out of Scope（"体量未到不做多国家站群"） |
| §3.4.3 | 详情页 `/novel/{public_page_id}`、试读页 `/novel/{public_page_id}/chapter/{n}`，**无 locale 段** |

含义是：全语种入库，但前台只有一个语种的站。这不一定是错的——先囤后发是合理策略——但它应该是明确选择，而不是文档缝隙。方案 A 正是这个形态的规范化版本。

**关于 URL，本方案的建议（升为待决 D-8，不自行拍板）**：

**URL 形状必须第一天就为 locale 预留**，二选一：
- 默认语种无前缀 + 其余语种带前缀：`/novel/{id}` 与 `/{locale}/novel/{id}`；
- 或全部带前缀：`/{locale}/novel/{id}`。

理由是不可逆性：URL 一旦被搜索引擎收录、被外链引用，改动只能靠 308 长期兼容，成本远高于第一天多写一段路径。CPS 已经为 slug/页面身份的历史形态付过一次迁移代价（Page Identity V2 的双解析长期并存）。

**无论选哪种，`public_page_id` 短码体系保留**——它解决的是"改书名不断链"，与 locale 段正交。

---

## 5. 数据库与部署

### 5.0 技术栈（立项书 §3.1 已定）

| 层 | 选型 | 相对 CPS |
| --- | --- | --- |
| 框架 | Next.js（App Router）+ React + TypeScript | 不变 |
| ORM | Prisma（provider 改 `postgresql`） | 不变 |
| 数据库 | **PostgreSQL 16** | 变更 |
| 任务队列 | 独立 Worker 进程 / 容器 | 从"PM2 同容器"升级 |
| 认证 | Auth.js v5 + Turnstile（仅后台） | 不变 |
| 部署 | Docker Compose + Nginx + Certbot | 新增 postgres service + 备份策略重写 |
| 前台渲染 | ISR + sitemap + 稳定页面资产 ID | 复用 `public_page_id` 思路，**但缓存标签模型重新设计** |

⚠️ 一处需 Owner 确认的小分歧：立项书写 **PostgreSQL 16**，已冻结的 PG 原型跑的是 **18.4**。本方案以立项书的 16 为准；若要改用更新的大版本，请显式确认（影响点主要是 `MERGE`、逻辑复制等新特性可用性，本方案未依赖任何 16 之后的特性）。

**容量口径（立项书 §C.3 重算，取代旧的百章口径）**：实测单章 2.2–11.9 KB，取 3 章/本，9.5 万本 ≈ **0.7–2 GB** 正文，PG + TOAST 压缩后更低。**结论：对象存储正文、冷热分层均不需要。** 正文直接进 PG。

### 5.1 Day 0 形态

```
┌──────────────────────────────────────────────────────────┐
│  单台主机（或单个 VPS），Docker Compose                     │
│                                                           │
│   ┌────────────┐  ┌────────────┐  ┌──────────────┐      │
│   │ web        │  │ worker     │  │ scheduler    │      │
│   │ Next SSR   │  │ 任务执行    │  │ 只入队       │      │
│   │ 无 cron    │  │ 可多副本    │  │ 单例由 DB 保证│      │
│   └─────┬──────┘  └─────┬──────┘  └──────┬───────┘      │
│         │  web_app       │ worker_app     │ worker_app   │
│         └────────────────┴────────────────┘              │
│                          │                                │
│                 ┌────────┴─────────┐                     │
│                 │  PostgreSQL 主库  │                     │
│                 │  业务 + 任务 +    │                     │
│                 │  审计 + 凭证 +    │                     │
│                 │  outbox + 埋点    │                     │
│                 └──────────────────┘                     │
└──────────────────────────────────────────────────────────┘
                          │
                 ┌────────┴─────────┐
                 │  Object Storage   │
                 │  封面 / 上传物 /   │
                 │  sitemap 产物     │
                 └──────────────────┘
```

**一个 PostgreSQL 主库，操作审计同库同事务，不建独立审计库。**

### 5.2 数据库角色

| 角色 | 权限 | 用途 |
| --- | --- | --- |
| `migration_owner` | 拥有 schema，可 DDL | **只在 migration 期间使用** |
| `web_app` | 业务表 CRUD；**凭证密文列 REVOKE** | Web 容器 |
| `worker_app` | 业务表 CRUD + 任务表；凭证密文列可读 | Worker / Scheduler 容器 |
| `analyst_ro` | 只读；**凭证密文列 REVOKE** | 排查与分析 |
| `backup_role` | 备份所需最小权限 | 备份任务 |

**应用绝不使用数据库 owner 运行。** 这条在 CPS 是缺失的，海外阅读第一天补上。

### 5.3 运维基线

| 项 | Day 0 要求 |
| --- | --- |
| 备份 | `pg_dump` 定期全量 + WAL 归档（PITR） |
| 恢复演练 | **上线前必须做一次真实恢复演练**，恢复到独立实例并核对行数。没演练过的备份等于没有备份 |
| 慢查询 | `log_min_duration_statement` 开启，阈值先定 500ms |
| 连接数 | 显式设 `max_connections`，各容器连接池上限之和留 30% 余量 |
| 健康检查 | `/api/health` 暴露版本、commit、flag 快照、DB 连通性；容器 healthcheck 绑定它 |
| 部署元数据 | 镜像 tag 与 `APP_VERSION` / `GIT_COMMIT` 一致性自检（CPS `v7.9.5` 事故的教训：`.env` 残留旧版本号污染健康检查指纹） |
| 端口暴露 | **不得让容器端口绕过防火墙直接对公网开放**（CPS 有过 Docker DNAT 绕过 UFW 的敞口） |
| 后台鉴权默认值 | `requireAdminSession` **改默认拒绝**。新增任意 admin 路由，不显式登记即不可访问。不继承 CPS "API 路由不经 proxy、保护全靠每个 route 自觉调"的形态 |
| 中间件层 | **禁止在 proxy / middleware 层查库**。CPS 的 `src/proxy.ts:80-136` 每次公开详情页请求打 1–2 次库，是已知负担；改由页面层 `notFound()` / `gone()` |
| 部署形态 | Day 0 **单 VPS 实例**：PG 与应用同机不同容器、走网络不走共享文件（这已解决 SQLite 时代"不能跨容器"的根因）。第二台是扩展选项，不是生产门禁前置 |
| 原生 SQL 纪律 | 🔴 **凡搬运带原生 SQL 的模块，一律改 Prisma 查询；确需原生 SQL 时别名必须加双引号。** 本轮在 `d77c3b9` 独立计数：`src`+`scripts`+`worker` 下 `AS camelCase` 形态命中 **67 处**（立项书记为 42 处，扫描范围不同）。PG 会把未加引号的别名折叠成小写，`row.taskName` 变 `undefined` 且**不报错** |

### 5.4 什么时候才需要更复杂的东西

**Day 0 一律不上。** 触发条件如下，未触发前引入即为过度设计：

| 组件 | 触发条件 |
| --- | --- |
| **PgBouncer** | 连接数逼近 `max_connections` 的 70%，或 Web 副本数 > 3 |
| **只读副本** | 前台读 QPS 让主库 CPU 持续 > 60%，且已确认不是缺索引 |
| **独立分析库** | 分析查询开始影响线上 P95，且 `analyst_ro` 的语句超时限制已不够用 |
| **ClickHouse** | 埋点事件量级达到千万行/月，且聚合查询在 PG 上已无法优化 |
| **Elasticsearch** | 站内搜索需求超出"标题/简介 LIKE + 有界结果"能力。CPS `v8.1.0` 用 `Article` + `LIKE` + 有界 LRU 就上线了搜索，是可参照的低成本路径 |
| **分区表** | 单表行数 > 1 亿，或按时间清理成为主要运维负担（埋点表最可能先到） |

**明确列为 Day 0 过度设计（回答任务问题 9.14）**：独立审计库、Redis / 外部队列中间件、Kubernetes、多区域、事件溯源、CQRS、GraphQL 网关、微服务拆分、物化视图、Kafka、全语种一次性上线、为 3 条试读章设计的对外游标 API、双写 / 影子表迁移机制。

---

## 6. 前台与后台能力清单

### 6.1 前台（V1）

| 页面 | 说明 |
| --- | --- |
| 首页 | 白名单 locale 各一份；**复用 CPS `home_carousel_*` 五表的"人工位 + 自动打分 + 合并"形态**（Owner 已裁决）；书籍卡片列表 + 基础聚合入口 |
| 小说详情 | 标题、封面、简介、语种、题材标签、总章数、收费起始章、试读入口、`/go` 跳转按钮。**查询不带正文** |
| 试读章节 | 上游实际返回的章节，按 `canonical_chapter_number` 升序；正文纯文本渲染；单章过长时段落分块渲染，**不做前端翻页器**；每章底部固定 CTA → `/go/:code` |
| 语言聚合 | 语种首页 |
| 题材聚合 | 仅**已映射到标准标签**的题材才有聚合页 |
| `/go/:code` | 推广跳转 + 点击埋点 |
| 下架 / 撤回页 | 内容下架后的稳定响应（不 404 到无意义页面） |
| Sitemap | 静态产物只读服务，不在请求路径生成 |
| SEO metadata | title / description / canonical / hreflang / OG / JSON-LD |

**试读页的 SEO 口径（立项书 §3.4.4 已定，本方案照用）**：

| 页面类 | 口径 |
| --- | --- |
| 书详情页、题材/榜单聚合页 | **可索引** |
| 试读**第 1 章** | **可索引**，用于承接「书名 + chapter 1 / read online」长尾词 |
| 试读**第 2 章及以后** | **noindex**，避免 thin content 与站内重复内容稀释权重 |
| 所有试读页 | canonical **指向书详情页**；章间用 `rel=prev/next` |

🔴 **可索引判定必须是代码级枚举 + 单一真源，不能是模板里的 `if`。** 立项书 §3.4.4 已指出：CPS 仓库里并不存在所谓"A/B/C 页面分类"，实际只有四条互相独立的机制（`Article.seoVisibility` 取 `public`/`seo_only`——后者是 index,follow 但不进列表页，**不是** noindex；分页 ≥2 的 noindex；`unavailable-pages.ts` 下架清单；`Drama.rightsStatus` 的 410/404 门禁）。海外阅读不能重复这种"口头约定分散实现"的形态。

**另需注意**：试读页是否进 sitemap / IndexNow，还要再过一道 `NovelPreviewPolicy.index_authorized`（默认 false）。SEO 口径说的是"允许索引的页面类"，授权开关说的是"这本书的正文是否获准被索引"。两者是与关系。

### 6.2 后台（V1）

| 能力 | 说明 |
| --- | --- |
| 渠道账户 | 账户 CRUD、凭证录入/轮换（`credential:manage` 能力位 + 指纹互斥）、JWT 状态与过期展示 |
| 书目同步 | 人工发起批次，显式参数（分页范围、安全上限、dry-run / apply、canary） |
| 书目列表 | 来源条目列表，筛选、状态、同步时间、`splitRatio` |
| 小说详情（后台） | canonical 实体编辑、来源条目关联、标签、发布状态 |
| 试读管理 | 已物化章节查看、重新拉取、内容审核标记 |
| 已有推广资源 | 读取 + 展示 + 绑定到 PromoLink（**已证能力**） |
| 推广生成 | **Owner Gate 形态**：按钮存在但由能力注册表控制为 `disabled`，展示原因 `capability_contract_unproven`（**未证能力**） |
| Article 模板 | 模板 CRUD、语种、变量白名单、渲染预览 |
| 发布 | 单条 / 批量发布，发布前门禁校验 |
| 任务中心 | 任务与 item 两级列表、状态、attempt、失败原因、人工重试、manual review 队列 |
| 审计 | 凭证变更日志、推广意图审计、发布审计；**全部脱敏展示** |
| IndexNow | outbox 状态、投递结果、手动重推 |
| 收益 | **占位页**：显示"待接口归因维度确认"，不展示假数据 |

### 6.3 V1 明确排除

作者页、国家页、完结/连载榜、C 端登录、完整阅读器（付费章节）、收益正式页面（等待归因维度确认）、站内搜索（Phase 2 候选）、评论/评分、用户收藏。

---

## 7. 与 CPS 的关系

**零共享。** 独立仓库、独立数据库、独立部署、独立域名、独立凭证。

海外阅读**不**从 CPS 迁移任何数据，**不**连接 CPS 数据库，**不**共用 CPS 的 Docker 网络或 Compose 项目。继承的只有：源码符号（按符号切）、设计模式、以及事故换来的纪律。

CPS 侧本轮零改动：`git status --porcelain` 在选定工作区始终为空。

---

## 附录 · 术语表

见 `novel-v1-evidence-reconciliation.md` 附录 A。本文档新增：

| 术语 | 含义 |
| --- | --- |
| 发布门槛 | 一个语种公开发布前必须齐备的五项条件 |
| 语种白名单 | 允许公开发布的 locale 集合，未登记即不发布 |
| 能力注册表 | Adapter 每个能力的启用状态与证据等级登记表 |
| Owner Gate | 需要 Owner 显式授权才能通过的关卡，通常是"按钮在但禁用" |
| 单一语种真源 | 上游语种码到站点 locale 的唯一映射实现，禁止多处各写一份 |
