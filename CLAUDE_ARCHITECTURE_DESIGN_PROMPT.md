# Claude 任务：设计 CPS-海外阅读 v1 总体架构与施工方案

> 本文件是给 Claude Code 的正式交接提示词。当前阶段只做架构设计与施工规划，**禁止创建正式项目代码、Prisma Schema、Migration、Docker Compose、数据库、Worker、Adapter 或页面实现**。

## 一、任务目标

结合以下三类证据，设计「CPS-海外阅读 v1」总体技术架构与分阶段施工方案：

1. 当前 CPS 仓库中已经生产验证过的北斗/畅读架构与事故防线；
2. 本仓库中已经完成的海外小说渠道生产只读接口调研；
3. Owner 已确认的业务规则与范围边界。

最终产出供 Owner 审核，审核通过后才拆给 Cursor/Codex 实施。

允许的最终结果：

```text
ARCHITECTURE_CANDIDATE_READY
ARCHITECTURE_CANDIDATE_PARTIAL
BASELINE_AMBIGUOUS
SOURCE_GAP_BLOCKED
```

---

## 二、先读取的资料

### 1. 本仓库资料

优先阅读根目录内以下文件：

- `# 海外小说 CPS P0 收益接口生产只读调研与阶段成果回灌`
- `# 海外小说 CPS P0 第二轮生产只读调研`
- `【台账】Novel v1 调研与待确认事项（按执行人分派）`

其中最新收益报告优先级最高；若旧台账与最新生产只读证据冲突，以最新报告为准。

### 2. CPS 本地审计资料

在 CPS 项目目录中搜索并读取：

- `novel-p0-beidou-changdu-inheritance-matrix.md`
- `novel-p0-reuse-dependency-closure.md`
- `novel-p0-architecture-field-dictionary.md`
- `P0_BROWSER_INTERFACE_PROBE.md`
- `P0_SECOND_BROWSER_PROBE.md`

找不到时列为 `SOURCE_GAP`，不要凭记忆补写。

### 3. CPS 代码基线

只读核实当前最新、干净、可代表 CPS 现状的 release/worktree：

```text
git worktree list
git status --porcelain
git rev-parse HEAD
git log -1
git tag --contains HEAD
```

约束：

- 不 checkout；
- 不建 worktree；
- 不改代码；
- 不 build；
- 不执行 Prisma；
- 不连接生产数据库；
- 不读取密文；
- 若无法唯一确定基线，输出 `BASELINE_AMBIGUOUS`。

---

## 三、已确认的渠道事实

### 1. 小说品类与主体

```text
projectType=1  → 网文/小说
projectType=2  → 短剧
```

已验证小说主体：`MoboReader`。

所有项目类型必须参数化，禁止在 Adapter 或业务层继续硬编码。

### 2. 已确认生产只读接口

#### 小说书目列表

```text
POST /api/v1/res/getlistpc
```

核心字段：

- agencyId / agencyName
- projectType
- seriesId / seriesName
- description / coverUrl
- language / languageName
- allEpis / payEpisFrom
- seriesTypeList / recommendList
- splitRatio / ttoSplitRatio
- kocCode / publicUrl / homeLink / onlineUrl
- promoCreateTime / createTime

#### 素材信息

```text
POST /api/v1/material/getbydataid
```

已确认素材身份、系列信息、素材状态、预览资源与时间字段。

#### 资源信息

```text
POST /api/v1/res/getvideoinfo
```

已确认：

- allEpis
- payEpisFrom
- assetList
- diskPath
- ttoSplitRatio
- rule

#### 试读章节

```text
POST /api/v1/res/getchapterinfo
```

已确认：

- bookId
- currentLanguage
- chapterList[]
- i
- chapterID
- chapterName
- chapterShowName
- chapterContent

正文为内嵌纯文本。

### 3. 试读规则

三本小说、英语与法语样本都返回章节 1–3；其 `payEpisFrom` 分别为 8、6、6，因此：

```text
preview.materializationPolicy = UPSTREAM_RETURNED_PREVIEW
```

必须遵守：

- 只物化 `chapterList[]` 实际返回的章节；
- `payEpisFrom` 单独保存为收费边界；
- 不根据 `payEpisFrom - 1` 主动请求更多章节；
- 代码按实际数组长度处理，不把 3 永久写死；
- 当前证据只覆盖英语、法语样本，不推广为所有渠道永久恒为 3。

### 4. 元数据缺失

在已知接口中未发现可信的：

- author / writer / creator
- country / region / origin
- completion / serialization status

`isRelease`、`localType` 等不得强制解释。

V1 明确不做：

- 作者搜索、作者页、作者 SEO 页；
- 国家筛选；
- 完结榜、连载榜。

### 5. 已有推广资源

已验证可读取：

- kocCode
- publicUrl
- homeLink
- onlineUrl
- promoCreateTime
- materialStatus
- statusText

页面存在“生成推广资源”按钮，Owner 确认点击后会生成；但以下未验证：

- 生成 Endpoint；
- Method / Body；
- 幂等；
- readback；
- 是否与短剧 `getcode` 完全相同。

架构必须拆分：

```text
readExistingPromo      已确认
claimPromo             未冻结
readPromoAfterClaim    未冻结
```

不得自行补写未实测协议。

---

## 四、最新收益接口证据

### 1. 主接口

```text
POST https://kocserver-cn.cdreader.com/api/Report/GetReport
```

请求 Body：

- beginTime: string
- endTime: string
- dates: array<string>
- dimensions: array<string>
- pageIndex: number
- pageSize: number
- projectType: number

同一登录会话、同一凭证、同一接口：

- `projectType=1` 查询网文；
- `projectType=2` 查询短剧。

当前技术裁决：

```text
ACCOUNT_SHARED_REVENUE_SEPARABLE
```

含义：一个技术账户/凭证可以按 `projectType` 稳定拆分小说和短剧收益；这不等于已经证明法律结算主体完全相同。

### 2. 响应结构

```text
$.data.headers[]
$.data.list[]
$.code
$.message
$.status
```

核心指标映射：

| 业务含义 | API 字段 |
| --- | --- |
| 日期 | dimensionKey |
| 激活用户 | realDevNum |
| 新用户 | newRealDevNum |
| 新用户比例 | realDevNumRate |
| 分成收入（USD） | realIncome |
| 分销收入 | realDistribIncome |
| 是否汇总 | isTotal |

响应还存在大量 income / amount / profit / RMB / new / active 字段。

设计原则：

- 只将核心高频指标展开为正式列；
- 其他字段保留于 `rawPayload jsonb`；
- 原始字段名与站内标准业务字段分离。

### 3. 汇总行刚性要求

```text
isTotal=0 → 明细
isTotal=1 → 总计
```

必须保证：

1. 汇总行与明细行分别保存或明确标记；
2. 聚合时不得把 `isTotal=1` 再次加入明细求和；
3. 汇总行可用于对账；
4. 必须有“收入不重复计数”验收测试。

### 4. 当前未证明的收益维度

广泛查询中未出现：

- agencyId / agencyName
- seriesId / bookId
- seriesName
- promoCode
- materialId
- product/app/platform
- team member
- settlement status
- 独立 currency 字段

因此：

- 当前 `GetReport` 只能冻结日期 + projectType 汇总链路；
- 不得把它设计成书籍或推广码级归因接口；
- 书籍/推广码筛选合同继续标记 `PENDING_R3`。

### 5. 辅助接口

```text
/api/Report/GetReportMaxTime
```

只确认自然触发与 HTTP 200，Method、Body、Response 未完整展开，不得编造。

---

## 五、Owner 已确认业务规则

### 1. 书目同步范围

```text
sourceAgency = MoboReader
projectType = 1
languages = ALL
sourceTags = ALL
minimumSplitRatio = 50
ingestionMode = MANUAL_BATCH
globalCumulativeHardLimit = NONE
existingPromoRequired = false
perTaskSafetyLimit = REQUIRED
```

解释：

- 全语种进入来源数据层；
- 不按来源标签预先排除；
- 只同步 `splitRatio >= 50%`；
- 有无推广资源均可进入内容库；
- 运营人工发起批次；
- 项目累计总量不限；
- 单次任务必须有分页、item、最大页数、最大 item 数、dry-run、进度检查点和恢复能力。

### 2. 正文授权

```text
preview.displayAuthorization = OWNER_CONFIRMED
```

免费试读正文允许站内展示。

仍需方案明确：

- 长期缓存；
- SEO 索引；
- 完整展示或截断；
- 更新与撤回策略。

### 3. 标签

渠道已提供：

- seriesTypeList
- recommendList
- language / languageName
- hasMultiLanguage
- agency / platform

Day 0 必须保存原始来源标签；Phase 2 再建设：

```text
SourceLabel
CanonicalTag
SourceLabelMapping
```

原则：

- `seriesTypeList` 是题材/受众候选；
- `recommendList` 是动态运营标签，不直接成为永久 SEO 分类；
- 未识别标签只保存，不自动公开；
- 简介自动分类仅作为来源标签缺失时的兜底；
- locale 必须有单一真源。

---

## 六、必须继承的 CPS 经验

以畅读演进后的实现为主，北斗补充 QPS 与 retryable 经验。

### 1. 必须保留

- task / item 两级任务；
- item 状态、attempt、stale recovery；
- Feature Flag + Allow Write 双闸；
- worker allowlist；
- dry-run；
- 单条 canary；
- 单批安全上限；
- expected total 完整性核验；
- pre-read → claim → readback → writeback；
- claim 写前意图审计；
- 结果未知时禁止自动重复 claim；
- manual review；
- idempotency key；
- canonical 只补空，不覆盖人工值；
- 审计脱敏；
- Credential 单轨；
- 数据库级凭证指纹互斥；
- 来源实体与 canonical 实体分离；
- revenue raw → attribution → daily stat 分层思想。

### 2. 写前意图审计

有副作用的上游调用必须：

```text
先写并提交 claim_attempted
→ 确保其他事务可读取
→ 再调用上游
```

不能把审计 insert 和上游调用包在同一个尚未提交的事务中。

### 3. 仅允许 PostgreSQL 化的部分

- Worker 原子领取；
- active task 互斥；
- item lease；
- 删除 PRAGMA；
- 替换 SQLite writer-lock hack；
- Cron 唯一执行；
- PostgreSQL 错误码重试；
- jsonb；
- CHECK 约束；
- 测试数据库方案；
- Web / Worker / Scheduler 分容器。

禁止借 PostgreSQL 升级重写业务状态机。

### 4. 不搬

- 北斗单级任务旧形态；
- 飞书遗留通道；
- site_settings 明文凭证；
- env 凭证业务兜底；
- 多轨 credential conflict；
- DramaSourceMapping 旧表；
- 短剧试看视频链路；
- 换租客历史包袱；
- CPS 专用旧结算表；
- SQLite 文件快照备份方案。

### 5. 搬运方法

```text
按符号切割，不按文件闭包整包复制
```

不得因为一个 import 将整条北斗 HTTP、畅读预览、nodejieba 或 sharp 链路一起搬入。

---

## 七、必须先做的证据收敛

先输出表格：

| 条目 | 当前裁决 | 证据来源 | 是否仍有效 | 冲突/过时内容 | 处理 |
| --- | --- | --- | --- | --- | --- |

至少处理：

1. 旧“前 100 章”已被 `UPSTREAM_RETURNED_PREVIEW` 替代；
2. 全语种进入数据层与 V1 前台多语言发布策略的关系；
3. “章节数可能数千”与站内只物化上游返回试读包的关系；
4. V1 是否需要复杂 Chapter cursor API，还是稳定排序 + bounded query 即可；
5. 推广生成协议仍未验证；
6. 收益书籍/推广码归因仍未验证；
7. 约 9.5 万只是当前单语种目录快照，不等于一次全量公开发布；
8. 项目累计不限与单批必须设限不得混淆；
9. 历史台账不是状态唯一真源。

不要默默调和冲突；逐项明确裁决或 Owner 待决。

---

## 八、需要设计的总体架构

### 1. 系统边界

至少包括：

- Public Web
- Admin CMS
- Internal API / Server Actions
- Worker
- Scheduler
- PostgreSQL
- Object Storage
- Channel Adapter
- Sitemap / IndexNow
- Tracking
- Revenue
- Credentials / Audit

输出文字架构图与模块边界。

### 2. CPS 复用矩阵

按模块输出：

| 模块 | CPS 来源 | COPY | ADAPT | PG_REIMPLEMENT | DROP | 新建 | 理由 |
| --- | --- | --- | --- | --- | --- | --- | --- |

覆盖：

- auth / 2FA
- capabilities
- Feature Flag
- credential crypto
- Channel / SourceApp / ChannelApp
- template engine
- slug alias / page ID
- sitemap
- IndexNow
- CSV parser
- tracking
- revenue pipeline

### 3. 逻辑数据模型

只设计逻辑模型和字段职责，不写 Prisma。

至少评估：

- Novel
- NovelSourceItem
- NovelChapter
- NovelChapterSourceItem
- NovelChapterContent
- NovelPreviewPolicy
- SourceLabel
- CanonicalTag
- SourceLabelMapping
- Article / PublicPageIdentity
- Channel
- SourceApp
- ChannelApp
- ChannelAccount
- ChannelAccountCredential
- CredentialChangeLog
- RevenueSyncScope
- PromoLink
- PromoClaimAudit
- ChannelSyncTask
- ChannelSyncTaskItem
- GenericTask
- GenericTaskItem
- IndexNowOutbox
- TrackingEvent
- RevenueSyncBatch
- RevenueRawSnapshot
- RevenueDailyStat
- RevenueAttributionSnapshot（PENDING_R3）

每个实体说明：

- 责任；
- 主键；
- 唯一键；
- 外键；
- 状态；
- 必要索引；
- jsonb 边界；
- 敏感字段；
- 保留期；
- V1 / Phase 2 / P4。

必须区分：

```text
ChannelSyncTaskItem → source_item_id
GenericTaskItem → target_type + target_id
```

### 4. 收益模型

按已验证合同设计：

```text
ChannelAccount
  └─ RevenueSyncScope(projectType)
```

建议逻辑实体：

#### RevenueSyncBatch

- channelAccountId
- projectType
- beginTime / endTime
- requestFingerprint
- status
- counts
- error

#### RevenueRawSnapshot

- syncBatchId
- projectType
- dimension
- dimensionKey
- dimensionValue
- isTotal
- realDevNum
- newRealDevNum
- realDevNumRate
- realIncome
- realDistribIncome
- realProfit
- rawPayload jsonb
- dedupeKey

#### RevenueDailyStat

- projectType
- statDate
- 核心指标
- sourceBatchId

#### RevenueAttributionSnapshot

- 仅保留扩展位；
- 未取得 seriesId/promoCode 合同前，不冻结归因键。

刚性要求：

- `projectType` 必须进入唯一键和幂等键；
- 空 `data.list=[]` 是合法成功；
- `pageSize=999` 只是观察值，不得假设永久无分页；
- `isTotal=1` 不能与明细重复求和；
- 相同时间范围重复同步必须幂等。

### 5. ChannelAdapter 契约

设计接口形状但不实现：

```text
listBooks
normalizeBook
fetchBookResources
fetchPreviewChapters
readExistingPromo
claimPromo              // unresolved
readPromoAfterClaim     // unresolved
fetchRevenue
resolveCredential
classifyError
```

每个方法标记：

- READ_ONLY / SIDE_EFFECTING；
- 已验证 Endpoint；
- 输入；
- 标准化返回；
- 幂等；
- QPS；
- 重试；
- 审计；
- 证据等级；
- 未知项。

禁止为 unresolved 方法编造请求合同。

### 6. 多语言方案

比较并推荐：

#### 方案 A

数据层全语种，V1 只公开达到模板、UI 和 SEO 质量门槛的语种。

#### 方案 B

全语种同步后立即全部公开。

比较 URL、locale、slug、canonical、hreflang、UI 文案、Sitemap、IndexNow、模板质量和混语风险。

不同语言不得共用同一 canonical URL。

### 7. Worker

必须明确：

- task/item；
- 原子领取；
- lease；
- attempt；
- stale recovery；
- partial success；
- continuation；
- active task 互斥作用域；
- advisory lock / partial unique index；
- Cron 唯一执行；
- QPS；
- per-task limits；
- claim_retry_blocked；
- manual review。

只继承分轮续跑语义，不强制照搬 CPS 的字面状态映射。

### 8. 数据库与部署

Day 0：

- 一个 PostgreSQL 主库；
- 操作审计同库；
- 不建独立审计库；
- Web / Worker / Scheduler 分容器；
- Object Storage；
- migration owner；
- web role；
- worker role；
- analyst readonly；
- backup role；
- pg_dump + WAL/PITR；
- 恢复演练；
- 慢查询与连接数限制；
- 应用不使用数据库 owner。

说明何时才需要 PgBouncer、只读副本、独立分析库、ClickHouse、Elasticsearch 或分区表。

### 9. 业务工作流

设计：

1. 人工批次书目同步；
2. SourceItem 归一化与 canonical Novel；
3. 试读章节物化；
4. 原始标签保存；
5. 内容审核；
6. SEO 页面生成；
7. 发布；
8. Sitemap / IndexNow；
9. 已有推广资源读取；
10. 推广生成占位；
11. `/go/:code`；
12. 点击埋点；
13. 收益同步；
14. 收益日期汇总；
15. 书级归因占位；
16. 下架、版权撤回、内容刷新。

每条流程说明触发、状态、幂等、安全闸、失败态、人工介入、审计与验收。

### 10. 页面范围

#### 前台 V1

- 首页
- 小说详情
- 试读章节
- 语言/题材聚合
- `/go/:code`
- unavailable/takedown
- Sitemap
- SEO metadata

#### 后台 V1

- 渠道账户
- 书目同步
- 小说列表/详情
- 试读管理
- 已有推广资源
- 推广生成 Owner Gate 占位
- Article 模板
- 发布
- 任务
- 审计
- IndexNow
- 收益日报

明确排除：

- 作者页；
- 国家页；
- 完结/连载榜；
- C 端登录；
- 完整阅读器；
- 书级收益归因（等待 R3）。

---

## 九、分阶段施工计划

重新设计 P1–P4，不直接照抄旧计划。

每阶段包含：

- 目标；
- 输入；
- 任务；
- 依赖；
- 不做；
- 验收；
- Owner Gate；
- Claude / Codex / Cursor 分工。

建议：

### P1：架构与数据底座

完成可评审设计、正式仓库准备、数据库和 Worker 底座设计。

### P2：内容与 SEO

完成书目、试读、页面、Sitemap、IndexNow。

### P3：推广闭环

先完成已有资源读取，再受控验证生成接口。

### P4：收益与归因

完成日期 + projectType 日报主链；书级归因保持 `PENDING_R3`。

### Phase 2

来源标签标准化、搜索、映射后台等。

---

## 十、方案必须回答的问题

1. 9.5 万级目录如何人工分批同步而不误触全量？
2. 全语种进入数据层后，哪些语种可以公开？
3. 三章试读是否需要复杂 cursor API？
4. Novel 与不同语种 SourceItem 的关系？
5. 同一本书多语种如何建立 canonical identity？
6. 已有推广资源如何同步进 PromoLink？
7. 生成合同未知时后台如何设计占位？
8. 真实推广码/URL 与脱敏审计分别存哪里？
9. 没有作者、国家、完结字段，模板如何避免空字段？
10. 原始标签如何保存而不污染永久 SEO 分类？
11. 技术账户共享时 ChannelAccount / RevenueSyncScope 如何建模？
12. 日期汇总已确认但书级归因未知，如何分层？
13. `isTotal` 如何避免重复计算？
14. CPS 哪些事故防线不可简化？
15. 哪些属于 Day 0 过度设计？

---

## 十一、交付物

在 CPS 仓库之外生成：

```text
docs/architecture/novel-v1-evidence-reconciliation.md
docs/architecture/novel-v1-system-architecture-v0.1.md
docs/architecture/novel-v1-logical-data-model-v0.1.md
docs/architecture/novel-v1-adapter-and-workflow-v0.1.md
docs/architecture/novel-v1-implementation-plan-v0.1.md
docs/architecture/novel-v1-open-decisions.md
```

报告必须附：

- CPS commit；
- 来源文件；
- `文件:行号`；
- 证据等级；
- 已确认 / Owner 决定 / 假设 / OPEN 的区分。

---

## 十二、禁止事项

- 不创建正式仓库；
- 不写 Prisma；
- 不写 Migration；
- 不启动 PostgreSQL；
- 不写 Worker；
- 不写 Adapter；
- 不实现页面；
- 不运行 Build；
- 不调用渠道接口；
- 不连接生产；
- 不修改 CPS；
- 不自行补全推广生成合同；
- 不自行补全书级收益归因合同；
- 不把架构候选直接升级为 Owner 已确认。

最终回复必须列出：

- 使用的 CPS 基线；
- 读取的数据源；
- 架构核心裁决；
- 与旧方案冲突；
- Owner 仍需决定的事项；
- 未冻结部分；
- 交付文件；
- 确认未产生正式代码。
