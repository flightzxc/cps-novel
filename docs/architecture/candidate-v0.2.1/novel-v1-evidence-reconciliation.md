# 海外阅读 v1 · 证据收敛表（candidate-v0.2.1）

> 文档性质：**架构候选（candidate）**，非 Owner 已确认。
> v0.1 生成：2026-08-02；v0.2 修订：2026-08-02（Owner 裁决回灌 + CPS 同构性复核）；**v0.2.1 收口：2026-08-02（目录定义 + D-10/D-11 关闭 + 旧口径清理 + 扫描互斥修正）**
>
> **v0.2.1 变更提要**（不重新设计，只收口）：① "完整试读目录"定义收窄为"展示 `chapterList[]` 当前实际返回的全部章节"，不宣称拥有全书目录、不按 `allEpis` 造占位；② **D-10 关闭**——改为"成功响应即权威集合、旧章未返回立即 stale、正文保留、重新返回自动恢复"，删除 K 次阈值与人工确认必选；③ **D-11 关闭**——`CPS_PARITY_WITH_PUBLIC_CODE_SEPARATION`；④ 清理 hreflang 与 W2 等残留旧口径；⑤ CatalogScanTask 互斥改为账户×应用×projectType 单 active
> CPS 代码基线：`d77c3b968285698529cf97c7f0f97b286d7a2a9c`（工作区 `cps-admin-v811-search-ux`，分支 `feature/v8.1.1-search-ux-patch`，`git status --porcelain` 为空，`package.json` version `8.1.1`）
> 本轮未创建正式仓库、未写 Prisma、未跑 Migration、未连接任何数据库、未调用任何渠道接口、未修改 CPS 工作区。
>
> **v0.2 阅读须知**：本文件在 v0.1 基础上增量修订。凡标 `⛔v0.2-被替代` 的段落保留原文仅供追溯，现行口径见 §8「v0.2 Owner 裁决回灌」与 `novel-v1-cps-parity-review.md`。证据等级口径一次性收敛为三级为主：`OWNER_CONFIRMED / OWNER_DECIDED`（Owner 裁决）、`DOC_CONFIRMED`（书面/正式材料）、`PRODUCTION_READ_PROVEN`（生产只读实证）；`CODE_CONFIRMED` / `SANDBOX_PROVEN` 仅在引用 CPS 代码与原型证据时继续使用，不再展开为架构讨论。

---

## 0. 这份文档在做什么

在动笔画架构之前，必须先回答一个问题：**我手上这些"已确认的事实"，现在还成立吗？**

海外阅读项目的资料来源有四层——Owner 口头裁决、Notion 立项书、CPS 仓库里的只读调研报告、以及此前基于旧基线做的继承审计。这四层是在不同时间点写下的，彼此之间已经出现了实质冲突：有的地方是新证据推翻了旧假设（这是好事），有的地方是旧文档的措辞比证据本身更笃定（这是风险）。

这一节把每一条关键裁决摊开，逐条标注它当前的证据强度，并对冲突给出明确处理。**没有一条被默默调和。** 凡是需要 Owner 拍板的，都列进第 6 节，并同步进 `novel-v1-open-decisions.md`。

---

## 1. 基线核实

### 1.1 只读核实执行记录

| 命令 | 结果 |
| --- | --- |
| `git worktree list` | 29 个工作区（含 2 个 agent 临时工作区、1 个 prunable） |
| `git rev-parse HEAD`（选定工作区） | `d77c3b968285698529cf97c7f0f97b286d7a2a9c` |
| `git status --porcelain` | 空 |
| `git log -1` | `2026-08-02` `docs(release): register v8.1.1 production rollout` |
| `git tag --contains HEAD` | 空（HEAD 比 tag `v8.1.1` 多一个纯文档提交） |
| `git branch --show-current` | `feature/v8.1.1-search-ux-patch` |

未执行 `checkout` / `worktree add` / `stash` / `commit`，未跑 `npm` / `prisma` / `build`，未连数据库，未读密文。

### 1.2 为什么选这个基线

| 候选工作区 | HEAD | 版本 | 干净 | 结论 |
| --- | --- | --- | :---: | --- |
| `cps-admin-v811-search-ux` | `d77c3b9` | 8.1.1 | ✅ | **选定** |
| `cps-admin-v810-search` | `27a008a` | 8.1.0 | ❌（3 项） | 已被 v8.1.1 包含 |
| `cps-admin-v7100-release-prep` | `d4e4bf9` | 8.0.1 | ✅ | 旧审计基线，非 HEAD 祖先 |
| `cps-admin`（主工作区） | `7350185` | — | ❌（30+ 项） | 停在 2026-06-05 的 Phase 7 分支，不代表现状 |

选定理由：`d77c3b9` 是唯一同时满足「最新、树干净、含当前生产代码」的工作区。生产锚点 `v8.1.1` / `84a3fa1` 是它的直接父提交，`d77c3b9` 只多一条版本台账登记（`docs/governance/version-registry.md`）。`27a008a`（v8.1.0 生产）、`9a03670`（v8.0.1 生产）、`8361d2c`、`cdfb75e`、`7350185` 全部是它的祖先。

`BASELINE_AMBIGUOUS` **不触发**：基线唯一可确定。

### 1.3 与旧审计基线的差异

此前 `docs/audit/novel-p0-*.md` 系列使用基线 `d4e4bf9`（更早声明使用 `cdfb75e`）。逐路径对象哈希比对（`git rev-parse <commit>:<path>`）：

| 路径 | `d4e4bf9` | `d77c3b9` | 结论 |
| --- | --- | --- | --- |
| `prisma/schema.prisma` | `20bf03ccd69e` | 同 | IDENTICAL |
| `src/lib/adapters/`（tree） | `11cf6b97d716` | 同 | IDENTICAL |
| `worker/`（tree） | `5c03579b87a2` | 同 | IDENTICAL |
| `src/lib/channel-account/`（tree） | `f5cd57c5d0fb` | 同 | IDENTICAL |
| `src/lib/changdu-promo-claim.ts` | `29ae18dbd304` | 同 | IDENTICAL |
| `src/lib/channel-sync-task.ts` | `66343217f145` | 同 | IDENTICAL |
| `src/lib/changdu-promo-claim-enqueue.ts` | `28a934b5b860` | 同 | IDENTICAL |
| `src/lib/changdu-promo-claim-eligibility.ts` | `fed6f80cfeeb` | 同 | IDENTICAL |
| `src/lib/changdu-promo-claim-limits.ts` | `24cd565668c3` | 同 | IDENTICAL |
| `src/lib/admin-capabilities.ts` | `2323a8b2d02d` | 同 | IDENTICAL |
| `src/lib/template-engine.ts` | `74f4c47ccc6f` | 同 | IDENTICAL |
| `src/lib/import-service.ts` | `db983df8fdec` | 同 | IDENTICAL |
| `src/lib/cps-tracking.ts` | `2e2c54ec11ad` | 同 | IDENTICAL |
| `src/lib/indexnow.ts` | `8eddd001413e` | 同 | IDENTICAL |
| `src/lib/sitemap.ts` | `5d0ed475f265` | 同 | IDENTICAL |
| `src/proxy.ts` | `320ead6dc5bb` | 同 | IDENTICAL |
| `src/instrumentation.ts` | `106ebbd004f7` | 同 | IDENTICAL |
| **`src/lib/feature-flags.ts`** | `a3f24a6428e5` | **`276459cbc943`** | **CHANGED** |

唯一差异，`git diff d4e4bf9 d77c3b9 -- src/lib/feature-flags.ts`：

```diff
+export function isSiteSearchEnabled(): boolean {
+  return process.env.FEATURE_SITE_SEARCH === "true";
+}
```

**影响判定**：新增一个 flag 读取函数，模式与既有 15 个 flag 完全一致（一 flag 一函数、读 env、默认关）。旧审计对该模块的裁决（`M3 Feature Flag`：1 文件、零依赖、COPY 结构改名字）不变，只是 flag 数从 16 变 17。

**结论：此前继承审计（`docs/audit/novel-p0-beidou-changdu-inheritance-matrix.md`、`novel-p0-reuse-dependency-closure.md`、`novel-p0-architecture-field-dictionary.md`）引用的全部 `文件:行号` 在 `d77c3b9` 下继续成立，可直接复用，无需重做。**

代码抽样复核（在 `d77c3b9` 下实读，非依赖旧报告）：

- `src/lib/adapters/channel.ts:28-34` — `ChannelAdapter` 确实只有 `listDramas` / `normalizeRawDrama` 两个方法。
- `src/lib/adapters/changdu-getcode.ts:7` — `CHANGDU_PROMO_PROJECT_TYPE = 2` 确实是仓库级硬编码常量。
- `worker/index.ts:106-120` — 领取确实是 `findFirst` → `update` 两步，非原子。
- `src/lib/changdu-promo-claim-enqueue.ts:202-206` — 确实用 `UPDATE batch_tasks SET updated_at = updated_at WHERE id = -1` 抢 SQLite writer lock，注释直书用途。
- `src/lib/changdu-promo-claim.ts:933-946` → `:948` — 写前意图审计（`decision=claim_attempted`）确实在 `claimPromoCode()` 调用之前，且不在同一个未提交事务里。

---

## 2. 证据分级口径

**采用立项书 §十一.1 的七级统一口径**（本方案原自定的等级已废弃）：

| 等级 | 含义 | 本文档中的典型来源 |
| --- | --- | --- |
| `HYPOTHESIS` | 经验推测或待验证候选 | 口头反馈、命名观察 |
| `CODE_CONFIRMED` | 由 CPS 静态代码证明 | 带 `文件:行号` 的复核结论 |
| `DOC_CONFIRMED` | 渠道正式文档或**书面**回复证明 | 立项书裁决、Owner 书面声明（如正文展示授权） |
| `SANDBOX_PROVEN` | 沙箱真实请求证明 | 已冻结的 PG 原型实验结果 |
| `PRODUCTION_READ_PROVEN` | 生产凭证**只读**请求证明 | 四个书目接口 + 收益接口 |
| `CANARY_WRITE_PROVEN` | 经 Owner 批准的**单条写入**证明 | 尚无（W9 当前为"暂不"） |
| `DEPRECATED` | 已失效或被推翻 | 前 100 章口径、表格导入通道 |

补充两个非证据等级的状态标记（用于裁决而非事实）：`OWNER_DECIDED`（Owner 明确裁决，不降级为假设）、`OPEN`（未知且已列入待决）。

🔴 立项书硬规则：**口头"存在/可以"不构成验证，不得从 `HYPOTHESIS` 直接标为"已确认"。**

---

## 3. 证据收敛表

### 3.1 品类、主体与账户

| 条目 | 当前裁决 | 证据来源 | 是否仍有效 | 冲突或过时内容 | 处理 |
| --- | --- | --- | :---: | --- | --- |
| 小说流 `projectType=1` | 采纳 | `reports/P0_BROWSER_INTERFACE_PROBE.md:35,48`（`PRODUCTION_READ_PROVEN`） | ✅ | 本地字典 `novel-p0-architecture-field-dictionary.md:25` 把 `P0-X1`（projectType 非 2 取值含义）标为 `BLOCKED / NEEDS_PROBE` | **该阻塞项已解除**。台账 `P0-X1` 应从 `BLOCKED` 改 `RESOLVED`，证据升级为 `PRODUCTION_READ_PROVEN` |
| `projectType` 不得硬编码 | 采纳 | `src/lib/adapters/changdu-getcode.ts:7` 常量 `= 2` 全仓硬钉（`CODE_CONFIRMED`） | ✅ | — | 新项目 `projectType` 必须来自 `ChannelApp` 配置或 Adapter 能力声明，不得写成模块级常量 |
| 已验证主体 = MoboReader | 采纳 | `P0_BROWSER_INTERFACE_PROBE.md:36`（`agencyId=[REDACTED]`, `agencyName=MoboReader`） | ✅ | — | 建 `SourceApp(code=moboreader)`，`ChannelApp.external_app_id` 承载 `agencyId`（沿用 CPS 形态，`prisma/schema.prisma:222-246`） |
| MoboReader / MoboReels 是否需两个 ChannelAccount | **技术上不需要** | `reports/P0_REVENUE_PROBE_AND_BACKFILL.md:146-160`：`ACCOUNT_SHARED_REVENUE_SEPARABLE`，同一凭证成功查询两类业务，请求层按 `projectType` 分流 | ✅ | `reports/P0_SECOND_BROWSER_PROBE.md:126,137-138` 判定 `ACCOUNT_RELATION_UNPROVEN`、"是否需要两个 ChannelAccount = 未决"；**任务简报 §3.6 沿用了这个旧结论** | **旧结论已被同仓更新报告推翻**（第二轮 02:01，收益轮 04:10，同日）。采纳新结论：V1 建**一个** `ChannelAccount`，`projectType` 作为请求维度参数化。但见 §3.4 的保留条件 |

### 3.2 已确认的生产只读接口

| 接口 | 状态 | 证据 | 处理 |
| --- | --- | --- | --- |
| `POST /api/v1/res/getlistpc` | `PRODUCTION_READ_PROVEN` | `P0_BROWSER_INTERFACE_PROBE.md:45-55` | Adapter `listBooks` 直接落地 |
| `POST /api/v1/material/getbydataid` | `PRODUCTION_READ_PROVEN` | 同上 `:61-62` | Adapter `fetchBookMaterial` |
| `POST /api/v1/res/getvideoinfo` | `PRODUCTION_READ_PROVEN` | 同上 `:63-65` | Adapter `fetchBookResources`（沿用上游命名，语义是"资源信息"不是"视频"） |
| `POST /api/v1/res/getchapterinfo` | `PRODUCTION_READ_PROVEN` | 同上 `:72-79` | Adapter `fetchPreviewChapters` |
| `POST /api/Report/GetReport` | `PRODUCTION_READ_PROVEN` | `P0_REVENUE_PROBE_AND_BACKFILL.md:33-108` | Adapter `fetchRevenue`，但**返回语义不完整**，见 §3.4 |
| `/api/Report/GetReportMaxTime` | `ADDITIONAL_CONTRACT_CAPTURE_REQUIRED` | 同上 `:112-118` | 只登记存在，不设计调用 |
| `getcode`（推广生成） | `OPEN` | `P0_SECOND_BROWSER_PROBE.md:111`：自然打开推广页签**未观察到** `getcode` | 见 §3.5 |

**`getlistpc` 请求体的一个关键事实**：已观察到的请求字段只有 `name` / `orderType` / `pageIndex` / `pageSize` / `projectType`（`P0_BROWSER_INTERFACE_PROBE.md:47-48`）。**没有 `language`，也没有 `agencyId`。** 语言和 agency 是**返回行上的属性**，不是**请求上的筛选条件**。这条对同步流程设计影响极大，见 §3.6。

### 3.3 试读规则

| 条目 | 当前裁决 | 证据 | 是否仍有效 | 冲突 | 处理 |
| --- | --- | --- | :---: | --- | --- |
| 试读物化策略 | `preview.materializationPolicy = UPSTREAM_RETURNED_PREVIEW` | `P0_REVENUE_PROBE_AND_BACKFILL.md:179`（`OWNER_DECIDED`）；样本证据 `P0_SECOND_BROWSER_PROBE.md:33-37` | ✅ | **旧 W4 建议"前 100 章"已被完全取代** | 旧 W4 措辞作废。只物化 `chapterList[]` 实际返回的元素 |
| 不得用 `payEpisFrom - 1` 推算返回章数 | 采纳 | 三样本 `payEpisFrom` = 8 / 6 / 6，`payEpisFrom-1` = 7 / 5 / 5，实际 `chapterList.length` 均为 **3** | ✅ | — | `payEpisFrom` 独立存为**收费边界**字段，与"已物化章节数"完全解耦 |
| 不得把 3 写死 | 采纳 | 同上（3 个样本 × 2 语种，样本量小） | ✅ | — | 数据模型按数组长度处理；不设 `PREVIEW_CHAPTER_COUNT = 3` 常量；不主动请求"更多免费章节" |
| 正文形态 | 内嵌纯文本 | `P0_BROWSER_INTERFACE_PROBE.md:85,91`：`chapterContent` 直接内嵌，无 HTML / 段落数组 / 图片 / 水印 / 截断标记 | ✅ | 旧继承审计 `§8` 曾把 `fetchPreviewContent` 的返回形态列为"正文文本 / 签名 URL / 片段 —— 形态未知" | **该未知已闭合**：纯文本。签名 URL 分支不需要设计 |
| 正文长度量级 | 3,997–11,858 字符/章 | `P0_SECOND_BROWSER_PROBE.md:43-51`（9 个样本的字符数与 SHA-256 前缀） | ✅ | — | 正文列用 `text`；必须设长度上限与截断告警，不设"无上限接受" |
| 正文站内展示授权 | `preview.displayAuthorization = OWNER_CONFIRMED` | `P0_REVENUE_PROBE_AND_BACKFILL.md:180`（`OWNER_DECIDED`） | ✅ | `P0_SECOND_BROWSER_PROBE.md:169-171` 明确：Owner 确认 ≠ 渠道官方文档证据 | **v0.2 起索引与完整展示亦由 Owner 裁决放行**（§8.3）；缓存降为一般运维项。**D-3 已关闭**。仍建议补登分销协议编号与有效期，把展示授权升为 `DOC_CONFIRMED` |

### 3.4 收益（本轮最大的一处冲突）

| 条目 | 任务简报 §3.6 的表述 | 仓库最新证据 | 处理 |
| --- | --- | --- | --- |
| 收益 Endpoint | OPEN | `POST https://kocserver-cn.cdreader.com/api/Report/GetReport`，HTTP 200（`P0_REVENUE_PROBE_AND_BACKFILL.md:33-39`） | **简报过时**。采纳实证 |
| Method | OPEN | `POST`，JSON Body，无 Query 参数 | **简报过时**。采纳实证 |
| `projectType` | OPEN | 请求体含 `projectType`：网文 `1`、短剧 `2`（`:51,153-154`） | **简报过时**。采纳实证 |
| `agencyId` | OPEN | 请求与响应**均无该字段**（`:124,156`） | 已证"不存在"，比"未知"更强。**结算主体不能按 agency 建模** |
| `seriesId` / `promoCode` 维度 | OPEN | **仍 OPEN**：`BOOK_OR_PROMO_FILTER_SAMPLE_UNAVAILABLE`（`:137-141`），R3 书籍/推广码下拉未能稳定读取 | **保持 OPEN**。这是归因层的关键缺口 |
| MoboReader/MoboReels 关系 | OPEN | `ACCOUNT_SHARED_REVENUE_SEPARABLE`（`:146`） | **简报过时**。采纳实证 |
| 是否共用 ChannelAccount / Credential | OPEN | 技术合同不要求两套（`:158-159`） | **简报过时**。采纳实证，但保留法律结算主体未证的声明（`:162`） |
| 最终 Revenue Schema | OPEN | **仍 OPEN** | **保持 OPEN**。见下 |

**裁决：收益的"接口是否存在"已闭合，"归因维度"未闭合。**

具体说：我们现在知道怎么把一个日期区间的**账户级汇总收益**拉回来（`dimensions:["1"]` 按日期维度、`pageIndex/pageSize`、`isTotal` 汇总行、40+ 个金额字段名）。我们**不知道**怎么把收益归因到**某一本书**或**某一个推广码**——而这恰恰是 CPS 归因层（`ChannelRevenueAttributionSnapshot`）存在的全部理由。

因此：

- 阶段 P4 保持 `PENDING_I8` 状态不变，理由从"接口未知"缩小为"归因维度未知"。
- **不冻结** `RevenueAttributionSnapshot` / `RevenueDailyStat` 的字段。
- 可以**先冻结** `RevenueRawSnapshot` 的最小形态（账户 + `projectType` + 日期区间 + 原始 jsonb + 去重键），因为这部分合同已证。但 V1 不建表——见 `novel-v1-implementation-plan-v0.1.md` 的 P4 说明。
- 已证的 40+ 金额字段名与 `rmb*` 双币种字段进接口字段字典，但**不做 currency 维度建模**（`:135` 明确不强制映射）。

### 3.5 推广资源

| 条目 | 当前裁决 | 证据 | 处理 |
| --- | --- | --- | --- |
| 读取已有推广资源 | `promotion.existingResourceRead = PRODUCTION_READ_PROVEN` | `P0_SECOND_BROWSER_PROBE.md:107-110`：`getlistpc` 返回 `kocCode` / `publicUrl` / `homeLink` / `onlineUrl` / `promoCreateTime`；`getbydataid` 返回 `statusText` / `materialStatus` / `materialType` / `materialName` | Adapter `readExistingPromo` 可直接定稿。**注意它不是独立接口，是列表接口的返回字段** |
| 生成推广资源的能力存在 | `BROWSER_OBSERVED + OWNER_CONFIRMED` | `P0_REVENUE_PROBE_AND_BACKFILL.md:192`；页面有「生成推广资源」按钮 | 能力存在这件事可以进设计 |
| 生成推广资源的 API 合同 | `promotion.generateApiContract = UNPROVEN` | 同上 `:193`；`P0_SECOND_BROWSER_PROBE.md:111`：打开推广页签**未观察到 `getcode`**，"不能得出接口不存在或一定不共用" | **不得凭 CPS 短剧经验补写。** 三个能力必须在契约层拆开：`readExistingPromo`（已冻结）/ `claimPromo`（未冻结）/ `readPromoAfterClaim`（未冻结） |
| 小说是否复用短剧 `getcode` | `OPEN` | 本地字典 `P0-X2` 标 `BLOCKED / NEEDS_PROBE` | 保持 OPEN。台账 `P0-X2` 状态不变 |

**架构后果**：`claimPromo` 在 V1 必须以「已登记但未启用的能力」形态存在，而不是「留个 TODO 的空函数」。CPS 在 v7.9 已经有这个模式的先例——能力注册表 + 显式 `disabled` 登记 + fixture dry-run。详见 `novel-v1-adapter-and-workflow-v0.1.md` §2.3。

### 3.6 目录规模与语种

| 条目 | 任务简报的表述 | 证据 | 处理 |
| --- | --- | --- | --- |
| 目录总量 | "约 9.5 万只是当前**单语种**目录快照" | `P0_BROWSER_INTERFACE_PROBE.md:50`：`data.totalCount = 95,479`，`pageSize=10`。请求体为 `name=""`, `orderType=1`, `pageIndex=2`, `pageSize=10`, `projectType=1`<br>立项书 §C.1 明确：`totalCount` = 95,479（**全语种合计**，非英语单语种） | **任务简报的"单语种"是错的**，立项书已给出正确口径：**全语种合计**。这与请求体无 `language` 参数一致（无筛选 = 全量）。采纳立项书口径。<br>立项书另注：MoboReader ~92,000 本、PlotNovel ~2,700+ 本为同主体第二个 app，两者相加与 95,479 量级吻合 |
| 语种如何枚举 | "全语种来源同步" | `language` / `languageName` / `hasMultiLanguage` 是**返回行的属性**，不是请求筛选项 | **新增 OPEN 项**：`getlistpc` 是否支持按语种筛选未知。若不支持，"全语种同步" = 遍历整个目录后按行属性分流，而不是"按语种分批拉取" |
| `splitRatio >= 50` 过滤 | ⛔v0.2-被替代 | `splitRatio` 是返回字段，未证明是请求筛选项 | **v0.2 裁决（OWNER_CONFIRMED）：该过滤不再是全局准入门槛。** 默认行为 `ACCEPT_CHANNEL_CONTENT`——所有正常返回的渠道内容保存来源实体并允许建站内实体；`splitRatio` 只作为渠道业务属性保存，可用于运营筛选/排序/分析。若保留渠道级筛选配置，默认不启用、不影响来源镜像落库、不作为 Novel 创建硬前置。原"拉回后过滤"的技术判断仍成立（无服务端筛选参数），但过滤对象从"准入"降为"可选运营视图"。见 §8.1 |
| 一本书 vs 一条记录 | — | 未证明 `getlistpc` 的一行代表"一本书"还是"一本书的一个语种版本" | **新增 OPEN 项 D-1**，直接影响 `Novel` ↔ `NovelSourceItem` 基数（任务问题 9.4） |

**裁决：95,479 是"当前账户在 projectType=1 下可见的条目总数"，不是"V1 要发布的书数"，也不能断言是"单语种"。** 它的唯一确定用途是完整性核验的 `expected_total` 候选（对齐 CPS `worker/handlers/changdu-source-sync.ts:251-255`）。

### 3.7 元数据缺失

| 条目 | 当前裁决 | 证据 | 处理 |
| --- | --- | --- | --- |
| 作者字段 | `UPSTREAM_FIELD_NOT_FOUND` | `P0_SECOND_BROWSER_PROBE.md:70`：`author` / `writer` / `penName` / `creator` 全无 | V1 不做作者搜索 / 作者页 / 作者 SEO 页（`OWNER_DECIDED`，`P0_REVENUE_PROBE_AND_BACKFILL.md:182-183`） |
| 国家 / 地区 | `UPSTREAM_FIELD_NOT_FOUND` | 同上 `:71` | V1 不做国家筛选。**且不得用 `language` 或 `localType` 顶替**（`:100`） |
| 完结 / 连载 | `UPSTREAM_FIELD_NOT_FOUND` | 同上 `:72` | V1 不做完结榜 / 连载榜 |
| `isRelease` / `localType` / `localSubType` | `FIELD_PRESENT_SEMANTICS_UNCONFIRMED` | 同上 `:76-82` | **存原值，不解释**。落 `raw_payload`，不建派生列，不进模板白名单 |
| `seriesTypeList` / `recommendList` | `FIELD_PRESENT_SEMANTICS_UNCONFIRMED` | 同上 | 存原值进 `SourceLabel`；`seriesTypeList` 作题材候选，`recommendList` **不得**直接成为永久 SEO 分类 |

**架构后果（回答任务问题 9.9）**：模板不是"引用了空字段就渲染空白"，而是**这些字段根本不进模板变量白名单**。CPS 的 `template-engine.ts:39-74` 已有 `TemplateVarEmptyError` + `{if}...{endif}` 双机制，海外阅读继承时把 `WILDCARD_FIELDS`（`:14-33`，当前 18 项全是剧集字段）重写为小说字段，**作者/国家/完结三项直接不登记**。渲染期缺值 fail-closed，不 fail-open 成空字符串。

### 3.8 CPS 继承经验

| 条目 | 当前裁决 | 证据 | 是否仍有效 | 处理 |
| --- | --- | --- | :---: | --- |
| 22 条 `COPY_AS_IS` 机制 | 全部继承 | `novel-p0-beidou-changdu-inheritance-matrix.md:200-227` | ✅ 全部路径对象哈希未变 | 逐条进架构文档，不得简化 |
| 10 条 `PG_REIMPLEMENT` | 全部执行 | 同上 `:231-247` | ✅ | 只允许改"怎么拿到任务、怎么加锁" |
| 12 条 `DROP` | 全部不搬 | 同上 `:250-266` | ✅ | 含飞书、`site_settings` 明文凭证、env 凭证兜底、`DramaSourceMapping`、SQLite hack |
| 闭包泄漏按符号切 | 采纳 | `novel-p0-reuse-dependency-closure.md:198-219,243-254` | ✅ | M10 由 1 个常量泄漏、M11 由 4 个符号泄漏 |
| 写前意图审计 | 最高优先级 `COPY_AS_IS` | `src/lib/changdu-promo-claim.ts:933-946` → `:948`（本轮实读复核） | ✅ | 必须先提交再调上游，不得包在未提交事务里 |

### 3.9 PostgreSQL 原型（沙箱证据）

`/Users/chenweifeng/Documents/产品原型及文档/cps海阅/novel-p0-pg-prototype/`

| 条目 | 状态 | 证据 | 处理 |
| --- | --- | --- | --- |
| 原型本身 | `P0_PROTOTYPE_FROZEN` / **DISPOSABLE** | `reports/P0_RESULT.md:1-9`：明令"禁止合并、部署或作为正式基线"，Schema / Migration / Worker / 部署配置**不得迁入正式项目** | **代码不继承。** 本方案不引用它的 Schema 作为设计依据 |
| 原子领取 `duplicate_claim_count=0` | `SANDBOX_PROVEN` | `reports/P0_WORKER_ATOMIC_CLAIM.md`：A/B 两策略 × 2/5/10 进程 × S/M/L，18 轮全部 0 重复；S 6,000 / M 60,000 / L 600,000 次领取 | **证据可用**。推荐策略 A（`SELECT … FOR UPDATE SKIP LOCKED` + 同事务 update/audit），理由是锁与更新在同一事务内更易审查；B 无稳定 >10% 优势 |
| Cron 单例 | `SANDBOX_PROVEN` | `reports/P0_CRON_SINGLETON.md`：10 个独立 scheduler 只产生 1 条 `cron_run` + 1 个任务 | **证据可用**。推荐独立 scheduler 容器 + `(schedule_key, scheduled_bucket)` 唯一键作为正确性边界 |
| 游标分页契约 | `SANDBOX_PROVEN` | `reports/P0_CURSOR_PAGINATION.md`：HMAC 签名、版本化、绑定筛选条件；5/5 测试通过 | **证据可用但 V1 不需要对外暴露**，见 §4 冲突 5 |
| 索引计划 | `SANDBOX_PROVEN` | `reports/P0_INDEX_PLAN.md`：L 轮首次尝试因 OR 谓词绕过 pending 偏索引，在 1,694/100,000 处停滞；拆分 pending 与过期租约路径后恢复线性 | **这条踩坑很值钱**：任务领取的 SQL 不得用 `OR` 合并"待领"和"租约过期"两条路径，必须拆成两条各自可走偏索引的查询 |
| 容量数字（S/M/L） | `PROVISIONAL_PENDING_W5` | `reports/P0_CAPACITY_ASSUMPTIONS.md` | **不得当产品容量预测**。只是负载参数 |

---

## 4. 必须主动处理的冲突（逐条裁决）

### 冲突 1 · 旧 W4「前 100 章」 vs `UPSTREAM_RETURNED_PREVIEW`

**裁决：旧 W4 作废。** 依据 Owner 裁决 `preview.materializationPolicy = UPSTREAM_RETURNED_PREVIEW`（`P0_REVENUE_PROBE_AND_BACKFILL.md:179`）与三样本证据。数据模型按 `chapterList[]` 实际长度处理，不设章数常量，不主动多请求。

**残留风险**：三个样本全返回 3 章，但这是"上游固定返回 3 章"还是"这三本恰好都是 3 章"，样本量不足以区分。设计上两者都被 `UPSTREAM_RETURNED_PREVIEW` 覆盖，**但完整性核验不能用"应该有 3 章"作为期望值**——只能核验"请求成功且数组非空"。

### 冲突 2 · 全语种来源同步 vs V1 不做完整前台 i18n

**裁决：不冲突，但必须显式分层。** 数据层全语种进（Owner: `catalog.languages = ALL`），发布层按语种白名单 fail-closed。

这不是折中，是 CPS 已经付过学费的形态：`v6.0.4` 的事故正是"只注册了前台 locale，漏了后台模板/文章创建枚举"（`docs/governance/version-registry.md`）。所以海外阅读第一天就要求：**一个语种要能公开，必须同时具备前台 messages、模板语种登记、模板真实渲染跑通、SEO 元数据、sitemap 分片**——五项齐全才进白名单，缺一即不发布，且**默认不在白名单**。（v0.2.1：原第五项含的 "hreflang 兄弟" 已随"V1 不生成跨 Novel hreflang"删除。）

方案对比与推荐见 `novel-v1-system-architecture-v0.1.md` §4。

### 冲突 3 · 「章节可能几千章全部同步」 vs 只物化上游返回的试读章

**裁决：旧表述作废。** V1 **不存在**全书章节同步链路。`allEpis`（总章数，样本 186/255/468/291）只作为**标量元数据**存在 `Novel` 上，不展开成行。

这条同时废掉了旧继承审计 `§8` 里 `listChapters` 那条"必须强制分页、禁止返回全部"的约束——不是因为约束错了，而是因为 **V1 没有 `listChapters` 这个能力**。上游 `getchapterinfo` 一次返回全部（3 条）且无分页字段（`P0_BROWSER_INTERFACE_PROBE.md:78`）。

**保留**：`allEpis` 与 `payEpisFrom` 存下来，未来若开放全书章节，它们是重建期望值的依据。

### 冲突 4 · 「不得把 3 写死」 vs 完整性核验需要期望值

**裁决：两级期望值，互不混用。**

- **目录同步**层：`expected_total` = `getlistpc` 的 `data.totalCount`（已证字段），沿用 CPS `changdu-source-sync.ts:251-255` 的核验语义——抓取数 < 期望数 → `partial_failed`，不谎报 `completed`。
- **试读物化**层：**没有数值期望值**。核验口径只有「HTTP 200 且 `chapterList` 非空且每条 `chapterContent` 非空」。数组长度 N 是结果，不是期望。

### 冲突 5 · 章节游标分页在 V1 是否对外暴露

**裁决：V1 不对外暴露游标 API。底层保留稳定排序与有界查询。**

理由：单本书 3 条试读章，任何分页 API 都是纯负担。原型虽已 `SANDBOX_PROVEN` 了一套 HMAC 签名游标契约（`P0_CURSOR_PAGINATION.md`），但那是为"未来可能的全书章节"准备的，**V1 引入它属于 Day 0 过度设计**。

保留的部分：
- 章节行的排序键 `(novel_id, canonical_chapter_number)` 唯一且稳定——这是未来加游标的前提，成本为零。
- 所有章节查询走 `take` 上限有界，不写无界 `findMany`。
- 游标契约文档归档，标注 `DEFERRED_TO_PHASE_2`。

（这条回答任务问题 9.3。）

### 冲突 6 · 收益与推广生成不得被 CPS 经验自动补全

**裁决：见 §3.4 与 §3.5。** 简报 §3.6 已被同仓更新报告部分推翻，本方案采纳新证据；但归因维度、`GetReportMaxTime`、`claimPromo` 三处仍 OPEN，**不写请求合同、不建对应表**。

CPS 的 `changdu-revenue` 四段式（`raw → attribution → daily_stat → overview`）作为**分层思想**继承，作为**表结构**不继承。

### 冲突 7 · 9.5 万 ≠ V1 发布量

**裁决：见 §3.6。** 补充：任务简报把它称为"单语种快照"，这个限定词没有证据。本方案统一表述为"**当前账户在 `projectType=1` 下的可见条目总数，语种与 agency 覆盖范围未证**"。

### 冲突 8 · 「项目累计不限」 vs 「单批必须有安全上限」

**裁决：不冲突，是两个不同层级的量，必须在代码里也分开。**

| 层级 | 上限 | CPS 对照 |
| --- | --- | --- |
| 项目累计书量 | **无硬上限**（`catalog.totalCatalogHardLimit = NONE`） | — |
| 单个同步任务的分页上限 | **必须有**，命中即 `partial_failed` | `CHANGDU_SOURCE_SYNC_SAFETY_MAX_PAGES` 默认 2000（`changdu-source-sync.ts:26,241,722-724`） |
| 单个任务的 item 上限 | **必须有** | 单批 1000（`changdu-promo-claim-limits.ts:2`） |
| 单轮处理的 item 数 | **必须有** | 默认 10、上限 20（`channel-sync-task.ts:30-31`） |
| 单条 canary | **必须有** | `limit` 强制为 1（`changdu-promo-claim.ts:587`） |

"累计不限"是**产品口径**；"单批有限"是**工程闸门**。混用会导致有人为了"不限"去掉安全闸——这正是 `safety_limit` 命中要降级为 `partial_failed` 而不是 `completed` 的原因（不谎报成功）。

### 冲突 9 · 历史台账不是任务状态唯一真源

**裁决：接受。** Notion 历史调研页（`Novel-v1-771695…`）为历史快照。本方案的状态真源优先级：

1. CPS 仓库内的 `reports/P0_*.md`（时间最新者优先）
2. `docs/audit/novel-p0-*.md` 本地自持字典
3. Owner 当轮口头裁决
4. Notion 四个正式数据库
5. Notion 立项书正文
6. Notion 历史调研页（**仅供追溯**）

本轮无 Notion 读写能力（见 §5），所以 4–6 项**未被本轮核实**，全部标注为"简报转述"。

### 冲突 10 · 三份 P0 报告内部的时序冲突

同一天生成的三份报告在收益结论上不一致：

| 报告 | 文件时间 | 收益结论 |
| --- | --- | --- |
| `P0_SECOND_BROWSER_PROBE.md` | 2026-08-02 02:01 | `ACCOUNT_RELATION_UNPROVEN` |
| `P0_REVENUE_PROBE_AND_BACKFILL.md` | 2026-08-02 04:10 | `ACCOUNT_SHARED_REVENUE_SEPARABLE` |
| `P0_BROWSER_INTERFACE_PROBE.md` | 2026-08-02 04:11 | 未涉及（第 3 行已加指针指向收益报告） |

**裁决：以收益报告为准。** 理由：它是同一探测线的后续轮次，明确捕获了此前未捕获的 XHR，且第一轮报告已主动加了转向指针（`P0_BROWSER_INTERFACE_PROBE.md:3`）。第二轮报告的 §6 应标注"已被 `P0_REVENUE_PROBE_AND_BACKFILL.md` §5 取代"。

**这条同时说明：任务简报 §3.6 的全 OPEN 表述，写作时点早于收益探测。** 不是简报错了，是证据前进了。

---

## 5. Notion 状态

本会话**没有** Notion MCP（`ToolSearch` 查询 `notion` 无匹配的延迟工具）。

**但 Owner 在本轮中途以 GitHub Markdown 形式提供了两份权威原文**，已实际读取：

| 来源 | 获取方式 | 行数 | 读取状态 |
| --- | --- | ---: | --- |
| 立项书 v0.4「调研收口 + 施工规划 v0.1」 | `github.com/flightzxc/cps-novel` @ `03795a4` | 811 | ✅ 已读 |
| 【台账】Novel v1 调研与待确认事项（按执行人分派） | 同上 | 253 | ✅ 已读 |
| P0 第二轮生产只读调研 | 同上（与 CPS 仓库内副本一致） | — | ✅ 已读（仓库内） |
| P0 收益接口调研与回灌 | 同上（与仓库内副本一致） | — | ✅ 已读（仓库内） |
| 四个正式数据库（任务台账 / 接口台账 / 字段字典 / 架构字典） | — | — | ❌ **仍未读** |
| 历史调研页 | — | — | ❌ 未读（已降为历史快照，无需读） |

因此：

- **立项书与台账的裁决已纳入本方案**，逐条对账见 §7。
- **四个正式数据库仍未读。** 立项书 §十明确「四个数据库才是可查询的事实库，任何两者冲突时以数据库为准」——所以本方案与数据库之间**仍可能存在未发现的冲突**，需 Owner 在评审时核对。
- **未向任何 Notion 页面或数据库写入，也不声称写入。**
- 结果标记：`NOTION_WRITEBACK_BLOCKED`
- 已生成幂等 outbox（同目录 `notion-architecture-candidate-upserts.jsonl` / `notion-task-candidate-updates.jsonl`），供后续真实回灌使用。

**仍需 Owner 提供的**：「架构与数据模型字典」现有 16+ 条条目原文——用于判断本方案新增裁决是否与既有条目重复或冲突。这是目前唯一还会影响裁决正确性的缺口。

---

## 6. 本轮新增的 Owner 待决项

完整清单与背景见 `novel-v1-open-decisions.md`。此处只列本证据收敛过程中**新暴露**的：

| ID | 问题 | 为何现在必须问 | 状态 |
| --- | --- | --- | --- |
| **D-1** | `getlistpc` 的一行代表"一本书"还是"一本书的一个语种版本"？ | 决定 `Novel` ↔ `NovelSourceItem` 是 1:1 还是 1:N | **v0.2 关闭（OWNER_DECIDED）**：一个来源语种版本 → 一个独立 Novel → 独立公开页面体系；V1 不跨语种合并、不要求人工建翻译关系、不生成跨 Novel hreflang、不因标题/简介相似推断同一作品。`NovelWork / TranslationGroup` 进 Post-V1。CPS 复核确认无跨源语种关联机制（`CPS_PARITY_CONFIRMED`，见 parity 报告 §1） |
| **D-2** | `getlistpc` 是否支持按 `agencyId` / app / `language` / `splitRatio` 服务端筛选？ | 立项书 §C.1 已把它列为"新增待验证点"，并给出后果：若不支持，SourceApp 维度只能在**写入时按行内 `agencyId` 切分**。本方案进一步指出：`splitRatio >= 50` 也只能拉回后过滤，因此分批只能按页码区间 | OPEN（立项书已登记） |
| **D-3** | 试读正文的**缓存**、**搜索引擎索引**、**完整/截断展示**书面细则 | 立项书 §C.4 与 Gate C 尾巴 | **v0.2 大部关闭（OWNER_DECIDED）**：索引 = 允许（详情/目录/全部试读章节页进 SEO）；展示 = 完整正文（非截断）。仅剩缓存细则作为一般运维项，不再是 Gate |
| ~~D-4~~ | ~~95,479 是否覆盖全语种~~ | — | **已闭合**：立项书 §C.1 = 全语种合计 |
| **D-5** | `GetReportMaxTime` 是否需要在 V1 探测？ | 可能是"数据可用水位线"，影响收益回拉的日期边界 | OPEN（`ADDITIONAL_CONTRACT_CAPTURE_REQUIRED`） |
| **D-6** | 收益的书籍/推广码归因维度何时补探？ | Owner 已定名为 **R3**，标记 `PENDING_R3`。它是归因层解冻的唯一前置 | OPEN（`PENDING_R3`） |
| **D-7** | 首发公开语种白名单 | 数据层全语种已定；发布层白名单未定。见 §7.4 冲突 | **新增，需 Owner 决** |
| **D-8** | 前台 URL 是否第一天就带 locale 段 | 立项书写 `/novel/{public_page_id}`（无 locale），但同时要求全语种入库。加语种时改 URL 不可逆 | **新增，需 Owner 决** |
| **D-9** | 作者 / 完结列：立项书要求"建可空预留列"，本方案原建议"不建列" | 见 §7.5 冲突裁决 | **已按立项书采纳，附加防护** |

---

## 7. 与立项书 v0.4 / 台账的逐条对账（Owner 中途提供原文后追加）

本节是本文档最重要的一次修订。此前各节只能依据任务简报转述和 CPS 仓库内的探测报告；读到立项书原文后，有 9 处需要修正或补齐。**其中 3 处是本方案原判断被立项书推翻，我按立项书改了。**

### 7.1 立项书证实了本方案的判断（无需改动）

| 项 | 本方案 | 立项书 |
| --- | --- | --- |
| 试读物化 = `UPSTREAM_RETURNED_PREVIEW`，推翻"前 100 章" | 冲突 1 | §C.3 + 变更日志 v0.4 ④「**推翻前 100 章**」 |
| 项目累计不限 ≠ 单次任务无限 | 冲突 8 | §C.2 红框「不得混淆的两个口径」，并列出**九项安全件缺一不得上线** |
| 作者/国家/完结 `OUT_OF_SCOPE_V1`，且不得用 `isRelease`/`localType` 顶替 | §3.7 | §C.5 完全一致 |
| `recommendList` 不得直接成为永久 SEO 分类 | §2.7 标签纪律 | §C.7 硬要求第 3 条，理由相同（榜单波动会洗掉聚合页） |
| 继承畅读不继承北斗；写前意图审计 + 反重复闩不可简化 | 全文 | §C.8 收口九条完全一致 |
| 按符号切割不按文件闭包 | §3 复用矩阵 | §C.8 第 8 条 |
| 凭证单轨 | §2.10 | §C.8 第 7 条 |
| 站内搜索 = 二期 | §5.4 | §七 B Q3（W7） |
| 审计表入主库同事务，不建独立审计库；分析库后置 | §5.1 | §3.5 结论三（2026-08-01 已修正口径） |
| 分析同步不要用 `pg_dump` 假装实时，要用流复制 | §5.4 | §七 B Q7 修正 |
| Adapter 中目录与正文合一为一个能力 | 契约文档 `fetchPreviewChapters` | §14.3 P3-10「`listChapters` 与 `fetchPreviewContent` **合并为一个能力**」 |

### 7.2 立项书提供的新事实（本方案已据此补齐）

| # | 新事实 | 出处 | 本方案的处理 |
| ---: | --- | --- | --- |
| 1 | `totalCount` 95,479 = **全语种合计** | §C.1 | §3.6 已改；D-4 关闭 |
| 2 | MoboReader ≈92,000 本；**PlotNovel ≈2,700+ 本是同主体第二个 app**；**MoboReels 属短剧线，与本项目无内容关系** | §C.1 | 渠道注册表需预留第二个 `SourceApp`（PlotNovel）。台账 §四 D1 答"一期上畅读名下 **moboreels** 完整的渠道"**已被立项书 v0.4 推翻**（MoboReels 是短剧），按 MoboReader 执行 |
| 3 | `projectType=2` 硬钉**共 5 处** | §C.1 | 本轮已在 `d77c3b9` 逐处复核，结果见 §7.6 |
| 4 | 试读容量重算：实测单章 2.2–11.9 KB，3 章/本，9.5 万本 ≈ **0.7–2 GB** | §C.3 | 采纳。结论：对象存储、冷热分层**均不需要**，正文直接进 PG（TOAST 压缩） |
| 5 | ⛔v0.2-被替代：~~`payEpisFrom` 上调时已展示章节自动下架~~ | §C.4 | **Owner v0.2 裁决删除该推断**：试读集合完全以 `getchapterinfo.chapterList[]` 实际返回为准，`payEpisFrom` 只作为收费边界元数据保存，**不因其数值变化自动删除正文**。除非后续获得渠道正式合同证明该语义。缺失章节的处置见 parity 报告 §5 的推荐（连续缺失→stale→人工，不硬删） |
| 6 | ⛔v0.2-被替代：~~仅第 1 章可索引，第 2 章起 noindex，canonical 回详情页~~ | §3.4.4 | **Owner v0.2 裁决（OWNER_DECIDED）**：详情页 + 完整试读目录 + 上游返回的全部试读章节页**全部进入 SEO**；每页 self-canonical、可进 sitemap 与 IndexNow；章节页链回详情、带上下章导航与 CTA、title/description 去重。"前三章"只是样本观察值，实现按上游实际返回 N 章生成 N 页，另设异常安全上限。见 §8.3 |
| 7 | CPS 无 A/B/C 页面分类，实际只有 4 条独立机制（`Article.seoVisibility` = `public`/`seo_only`、分页 ≥2 noindex、`unavailable-pages.ts`、`Drama.rightsStatus` 410/404） | §3.4.4 | 采纳。海外阅读的可索引判定必须是**代码级枚举 + 单一真源**，不是模板里的 `if` |
| 8 | D3 = **复用 CPS `home_carousel_*` 5 张表** | 台账 §四 D3 + 立项书状态摘要 | **本方案原先完全没提首页轮播**。已补进复用矩阵与前台清单 |
| 9 | 42 处 `AS camelCase` 别名在 PG 下被静默折叠成小写；`home-carousel-config.ts:101` 会让轮播**静默回落默认配置** | §9.2 | 采纳为 R10。本轮独立计数见 §7.6 |
| 10 | `cache-tags.ts` 全文 19 行、只有 2 个 tag，是最弱一环，**建议重新设计而非照搬** | §9.1 | 已在 `d77c3b9` 复核：确为 19 行。采纳"重新设计" |
| 11 | `requireAdminSession` 应改**默认拒绝**；不要继承"API 路由不经 proxy、靠每个 route 自觉调"的形态 | §9.4 | 已补进 P1 任务 |
| 12 | 不可变构建元数据烘焙 + `CPS_APP_IMAGE` fail-closed | §9.4 | 已在架构文档 §5.3 |
| 13 | 表格通道（CSV/XLSX）**整体废弃**：不建 `import` 后台页面与 npm script，`nodejieba`/`sharp`/`xlsx` 不进依赖树 | §4.2 + §14.2 P2-12 | **本方案原先仍把导入列为 P2 可选任务**，口径偏宽。已收紧为"只保留 30 行零依赖 parser 作一次性运维脚本" |
| 14 | 七级证据等级是全项目统一口径 | §十一.1 | **本方案原先自定了一套**。已在 §2 改为对齐立项书 |
| 15 | Gate A/B/C/D 四级门禁 + 当前状态 | §二(D) + §七 A | 本方案的 P1–P4 已映射到四级 Gate，见施工计划附录 |
| 16 | 冲突处理必须用"被替代机制"：旧记录标「被替代」+ 建新记录 + 双向关联，**不得删除** | §十一.2 | 本文档与 outbox 全部按此机制组织 |
| 17 | 技术栈：**PostgreSQL 16**、Next.js App Router、Prisma、Auth.js v5 + Turnstile、Docker Compose + Nginx | §3.1 | 采纳。注：已冻结的 PG 原型跑的是 18.4，**版本选型以立项书的 16 为准**（或由 Owner 重新确认） |
| 18 | Day 0 **单 VPS 实例**（PG 与应用同机不同容器、走网络）；两台是扩展选项不是 Gate B 前置 | §七 B Q6 | 采纳，已写入架构文档 §5 |

### 7.3 三处本方案被立项书推翻（已改）

**推翻 1 · 作者与完结列：建还是不建**

- 本方案原判：**不建**。理由是空列会诱导模板引用、诱导前台展示、诱导有人拿别的字段顶替。
- 立项书 §C.5 §七B Q3：**建，且必须是独立可空列，不得塞进 jsonb**。理由是二期要做书名/作者搜索，塞进 jsonb 会阻断加索引。
- **裁决：按立项书改。** 我的风险判断没有错，但立项书的理由更硬——jsonb 里的字段加不了索引，二期搜索会被卡死；而我担心的"误用"可以用另一个机制堵住。

  最终形态：列存在（`author` / `completion_status` 可空），但**不进模板变量白名单**（模板里写 `{author}` 保存时即报错）、**不建索引页**、**不进 sitemap**、**前台不展示**。这样两条约束同时成立。

**推翻 2 · 收益是否在 V1 建模**

- 本方案原判：**不建表、不设计**，只留架构位置。
- Owner 本轮明确指令：**"P4 可以设计主链，但书级归因继续标记 `PENDING_R3`"**，并给出了四张表的字段草案。
- **裁决：按 Owner 改。** 逻辑模型照 Owner 给的四表设计（`RevenueSyncBatch` / `RevenueRawSnapshot` / `RevenueDailyStat` / `RevenueAttributionSnapshot`），归因键留空标 `PENDING_R3`。**仍不写 Prisma、不建表。**

**推翻 3 · 前台 URL 形状**

- 本方案原写：`/{locale}/novel/{slug}`。
- 立项书 §3.4.3 写：详情页 `/novel/{public_page_id}`、试读页 `/novel/{public_page_id}/chapter/{n}`，**无 locale 段**；且 §1.4 把"多语言 i18n 前台"列为 Out of Scope。
- **这两者与 §C.2「全语种同步」构成立项书内部的一处张力**，立项书自己没有解开。
- **裁决：不自行拍板，升为 Owner 待决 D-8**，并给出明确建议：**URL 形状必须第一天就为 locale 预留**（默认语种无前缀 + 其余带前缀，或全部带前缀）。理由：加语种时改 URL 是不可逆动作——旧 URL 已被搜索引擎收录和外链引用，只能靠 308 长期兼容，成本远高于第一天多写一段路径。

### 7.4 立项书内部的一处张力（需 Owner 裁决）

| 立项书处 | 表述 |
| --- | --- |
| §C.2 | 语种 = **全部语种**（渠道侧上限 18 种） |
| §1.4 | **多语言 i18n 前台** — 参照 CPS 三期教训：体量未到不做多国家站群 → Out of Scope |
| §3.4.3 | URL 无 locale 段 |

三条同时成立时的含义是：**全语种数据入库，但前台只有一个语种的站**。那么英语之外的 9 万余条数据在 V1 是纯库存，前台零曝光。

这不一定是错的（先囤后发是合理策略），但必须是**明确选择**而不是文档缝隙。本方案的推荐（架构文档 §4 方案 A）正是这个形态的规范化版本：**数据层全语种、发布层白名单 fail-closed、首发白名单由 Owner 定**。

对应待决 **D-7**（首发白名单）与 **D-8**（URL 是否预留 locale 段）。

### 7.5 台账里被后续裁决取代的答案（保留原文，标记被替代）

按立项书 §十一.2 的"被替代机制"，以下台账答案**不删除，标记为被替代**：

| 台账项 | 原答案 | 被谁取代 | 当前口径 |
| --- | --- | --- | --- |
| W4 试读额度 | "可以取前 100 章" | 立项书 v0.4 §C.3 | `UPSTREAM_RETURNED_PREVIEW`，只物化上游实际返回 |
| §四 D1 一期范围 | "一期上畅读名下 **moboreels** 完整的渠道" | 立项书 v0.4 §C.1 + §C.2 | 来源主体 = **MoboReader**；MoboReels 是短剧线，与本项目无内容关系 |
| W1 projectType 非 2 取值 | "存在"（口头，`HYPOTHESIS`） | `P0_BROWSER_INTERFACE_PROBE.md:35,48` | `projectType=1` = 小说，`PRODUCTION_READ_PROVEN` |
| W2 是否返回可展示正文 | "可以"（口头，`HYPOTHESIS`） | `P0_BROWSER_INTERFACE_PROBE.md:85` + Owner 确认 | **技术侧 `PRODUCTION_READ_PROVEN`；展示授权 `OWNER_CONFIRMED`**（v0.2.1 统一口径：Owner 裁决用 `OWNER_CONFIRMED`，不再标 `DOC_CONFIRMED`——后者留给渠道书面材料。建议仍补登分销协议编号与有效期，届时可另立一条 `DOC_CONFIRMED`） |
| W5 是否需独立子账号 | "建议放一起，似乎没有配额的说法，收入也可以通过网文和小说的标签接口区分" | `P0_REVENUE_PROBE_AND_BACKFILL.md:152-160` | **Owner 当初的直觉被证实**：同一凭证可查两类业务，靠 `projectType` 分流 |
| 立项书 §二(D) | `MoboReader_vs_MoboReels = ACCOUNT_RELATION_UNPROVEN`；五项待 I8 冻结 | `P0_REVENUE_PROBE_AND_BACKFILL.md`（2026-08-02 04:10，晚于立项书） | `ACCOUNT_SHARED_REVENUE_SEPARABLE`。**五项冻结缩为四项**——`ChannelAccount` 作用域可定（一个账户 + 多个 `RevenueSyncScope(projectType)`），其余四项（Revenue Schema 细节 / 归因键 / 同步 Adapter / P4 看板）中，归因键仍 `PENDING_R3` |
| 立项书 §六 R7 | "与 CPS 共用渠道账号导致配额互相影响"，不得销 | 同上 | **技术侧可销**（同凭证跨品类查询已证）；**法律结算主体侧不可销**。R7 拆成 R7a（技术，已闭）/ R7b（主体，仍开） |

### 7.6 立项书引用的 CPS 位置，本轮在 `d77c3b9` 的复核结果

立项书写于基线 `cdfb75e` / `d4e4bf9`。本轮逐条复核（相关文件对象哈希与旧基线一致，见 §1.3）：

| 立项书引用 | 复核结果 |
| --- | --- |
| `adapters/changdu-getcode.ts:7` `projectType=2` | ✅ 精确命中：`export const CHANGDU_PROMO_PROJECT_TYPE = 2;` |
| `changdu-getvideoinfo.ts:10` | ✅ 精确命中：`export const CHANGDU_VIDEOINFO_PROJECT_TYPE = 2;` |
| `changdu.ts:80` | ✅ 行号命中，但**性质需澄清**：这是一段 fixture / 样例对象（`agencyId: 6833`、`agencyName: "MoboReels"`、虚构剧名），不是运行时常量。**参数化时不要漏，但它不是生产判别位** |
| `changdu-preview-capability.ts:89/112` | ✅ 行号精确命中（`projectType: 2` ×2），但**路径需更正**：实际在 `src/lib/changdu-preview-capability.ts`，不在 `src/lib/adapters/` 下 |
| `schema.prisma:366` | ✅ 命中，但**性质需澄清**：这是 `projectType Int? @map("project_type")` 一个**持久化列**，不是硬编码。它证明的是"品类判别位被落库审计"，不是"被钉死" |
| **小结** | **真正的模块级硬编码常量只有 2 个**（`getcode:7`、`getvideoinfo:10`）；另有 2 处 fixture/capability 字面量、1 处持久化列。参数化工作量比"5 处硬钉"读起来要小，但**5 处都要动** |
| `worker/index.ts:106-120` 两步非原子领取 | ✅ 精确命中 |
| `changdu-promo-claim-enqueue.ts:204-206` SQLite 写锁 hack | ✅ 精确命中（本轮实读 `:202-206`，注释直书用途） |
| `changdu-promo-claim.ts:933-946` → `:948` 写前意图审计 | ✅ 精确命中，且确认 `writeAudit` 用顶层 `db` 而非未提交的 `tx` |
| `BatchTaskItem.dramaId` 非空 `Int`（`schema.prisma:1441`） | ✅ 精确命中 |
| `cache-tags.ts` 19 行 | ✅ 精确命中 |
| `home_carousel_*` 5 张表 | ✅ 命中：`HomeCarouselManualSlot` / `AutoBatch` / `AutoCandidate` / `Serving` / `ChangeLog`（`schema.prisma:740-843`） |
| `dramas.promo_code` 无索引 | ✅ 确认：`promoCode`（`schema.prisma:32`）无 `@@index` |
| 42 处 `AS camelCase` 别名 | ⚠️ **本轮独立计数为 67 处**（`src` + `scripts` + `worker`，正则 `AS [a-z]+[A-Z]`）。差异应来自扫描范围与正则口径不同。**结论方向不变且更严重**：搬运任何带原生 SQL 的模块都必须改 Prisma 查询或给别名加双引号 |

### 7.7 本节新增的待决

见 §6 表：D-7（首发白名单）、D-8（URL 是否预留 locale 段）、D-9（作者列，已按立项书采纳）。另：W6（品牌口径）、W9（有副作用接口首测授权，当前"暂不"）、D6（工期与人力）三项仍在立项书 §十二 中开放，本方案不代为关闭。

---

## 8. v0.2 · Owner 裁决回灌（2026-08-02 第二轮）

本节是 v0.2 的核心增量。八条 Owner 裁决全部为 `OWNER_CONFIRMED / OWNER_DECIDED`，不降级为假设；其中五条需要 CPS 只读复核佐证，复核结果全文见 `novel-v1-cps-parity-review.md`（下称 parity 报告）。

### 8.1 分成比例不再是全局准入门槛

`catalog.minimumSplitRatio = 50` **作废**（旧条目标记被替代，不删除）。

Owner 的业务口径：50% 是**畅读这一家的商务约定下限**（正常情况下不会有低于它的书），不是平台内容准入规则；未来渠道可能整体低于 50%，不允许把单一渠道的商务条件硬编码成全平台门禁；CPS 短剧也从未因分成低而拒收渠道内容。

正式裁决：

```text
默认行为 = ACCEPT_CHANNEL_CONTENT
所有正常返回的渠道内容 → 保存来源实体 → 允许建立站内内容实体
splitRatio → 渠道业务属性，供运营筛选/排序/分析
```

若保留渠道级筛选配置：可选、默认不启用、不影响来源镜像落库、不作为 Novel 创建硬前置。架构须支持按渠道配置商务规则。

### 8.2 多语种版本 V1 不做作品关联

一个来源语种版本 → 一个独立 Novel → 一个独立公开页面体系。V1：不跨语种自动合并；不要求运营人工建立翻译关系；**不生成跨 Novel 的 hreflang**；不因标题相同或简介相似推断同一作品；每个语种版本独立 canonical。`NovelWork / TranslationGroup` 进 Post-V1，不进 V1 Schema 硬前置。

CPS 复核：**`CPS_PARITY_CONFIRMED`**——CPS 没有跨源语种 Drama 关联（`DramaSourceItem` 唯一键含 `sourceLanguageCode`，`schema.prisma:279`；claim 资格把"一个 Drama 被多来源共享"判为不合格态，`changdu-promo-claim-eligibility.ts:6`）。CPS 的 hreflang 是另一概念——同一 Drama 同一 slug 的**自产翻译 Article** 互指（`drama-hreflang.ts:16-32`），在"一源语种版本 = 一 Novel"模型下无对应物。

> 这同时收敛了 v0.1 的两处表述：多语言方案 A 的五项发布门槛中"hreflang 已验证"一项移除；"跨语种关系用 hreflang 表达"的硬约束改为"V1 无跨语种关系需要表达"。**独立 canonical 的硬约束不变。**

### 8.3 SEO：详情页 + 目录 + 全部试读章节页全量进入 SEO

取代 v0.1 从立项书 §3.4.4 继承的"仅第 1 章可索引"口径（旧口径标记被替代）：

- 所有**实际物化**的试读章节页均可索引，各自 **self-canonical**，可进 sitemap 与 IndexNow；
- 详情页 self-canonical；**不把章节页 canonical 指向详情页**；
- 章节页必须：链回详情页、上一章/下一章导航、完整 CTA、标记所属书籍、title/description 按书+章去重；
- "前三章"只是当前三本两语种样本的观察值——**上游实际返回 N 章 → 生成 N 个可索引章节页**，另设异常安全上限防上游异常返回巨量正文。

#### 8.3.1 「完整试读目录」的定义（v0.2.1 收口）

v0.2 的表述"详情页 + **完整试读目录** + 全部试读章节页"里，"完整目录"一词有歧义风险——它可能被读成"我们有这本书的全书章节目录"。**收窄定义：**

```text
完整试读目录 = 展示 getchapterinfo.chapterList[] 当前实际返回的全部章节
```

三条硬约束：

1. **不宣称拥有全书完整章节目录。** 页面文案、结构化数据、SEO 描述均不得表述或暗示"全书目录"；对外语义是"可试读章节"。
2. **不得根据 `allEpis` 生成无标题章节占位。** `allEpis`（样本 186/255/468/291）只是元数据标量，不得据此产出任何章节行、列表项或页面骨架。目录里出现的每一条都必须有上游实际返回的章节数据支撑。
3. **目录的完整性口径 = 与当前 `chapterList[]` 一致**，不与 `allEpis` 比对，也不因两者不等而报缺失。

**目录的承载形式待 Owner 选择**（新增待决 **D-12**）：① 独立目录路由（如 `…/novel/{id}/chapters`，自身可索引）；② 目录嵌入详情页（不新增路由）。本轮不替 Owner 选；两种形态下上面三条约束都成立。

### 8.4 试读集合完全以上游实际返回为准（v0.2.1：刷新语义已冻结，D-10 关闭）

`getchapterinfo.chapterList[]` = 当前允许物化和展示的试读集合。返回几章物化几章；不用 `payEpisFrom - 1` 推算；不因免费区间大就主动多请求；**不因 `payEpisFrom` 数值变化自动删除正文**——v0.1 依据立项书 §C.4 补写的"收费边界下调自动下架"流程**删除**（旧条目标记被替代），除非后续获得渠道正式合同证明该语义。

**刷新与缺失处置（v0.2.1 · `OWNER_DECIDED`，取代 v0.2 的"连续 K 次 + 人工确认"推荐）**：

先判**响应是否可信**，再谈集合差异——这是整条规则的关键顺序：

| 情形 | 处置 |
| --- | --- |
| 请求失败 / 响应异常 / 异常空列表 | **不改变现有可见状态**。既不 stale、不下架、不删除，也不更新正文。视为"本次没拿到有效信息" |
| 请求成功 + 结构完整 + `chapterList` 非空 | 该列表**即当前权威试读集合**，进入下面的差异处置 |
| 同章仍返回，hash 未变 | 不重写 |
| 同章仍返回，hash 变化 | 更新正文；有实质变化才推 IndexNow |
| 新章出现 | 新增物化 + 新增可索引章节页 |
| 旧章**未再出现在权威列表中** | **立即**标 `stale`、停止展示、退出 sitemap（不再等 K 次） |
| 已 `stale` 的章节后续重新返回 | **自动恢复**为 `preview`、恢复展示与收录（写审计） |
| 任何情况 | **正文保留，不自动硬删**。硬删只属人工发起的版权撤回 |

**已删除的两条 v0.2 要求**：连续 K 次缺失阈值（`consecutive_miss_count` 不再是判据）、人工确认作为恢复/下架的必选环节（人工队列改为可选运维视图）。

之所以能去掉 K 次缓冲而不牺牲稳健性：**缓冲的作用被"响应可信度前置判定"取代了**——K 次阈值原本是为了吸收上游抖动，而抖动的表现恰恰是请求失败/异常/异常空列表，这些情形现在直接不改状态。只有拿到一个**结构完整且非空**的成功响应，才允许它改写集合，此时它就是权威的，没有再等 K 次的理由。

这仍与 CPS 同构：状态标记而非删除、前台按状态过滤（`preview-sync.ts:379-409` 纯 upsert 无删除路径，`stale` 在其枚举中预留）。

### 8.5 收益与渠道账户 Day 0 支持多账户

尽管生产实证单账户可用 `projectType` 分流两类业务，Owner 要求模型从第一天支持多账户：

```text
Channel
  └─ ChannelAccount [1..N]
       ├─ one active Credential
       └─ RevenueSyncScope [1..N]（projectType）
```

唯一键：`RevenueSyncScope UNIQUE(channel_account_id, project_type)`；`RevenueDailyStat UNIQUE(revenue_sync_scope_id, stat_date)`。收益批次/原始快照/日报唯一键必须含 scope/account；相同日期相同 projectType 不同账户不得互相覆盖；金额一律 `Decimal / numeric`。法律结算主体仍不由系统自动推断。

> 这修订了 v0.1 的"V1 建一个 ChannelAccount"表述：单账户仍可以是 V1 的**运行时事实**，但不再是 **Schema 假设**。

### 8.6 `/go` 使用我方公开短码

拆分 `upstream_promo_code`（渠道真实码，仅存内部推广资产）与 `public_redirect_code`（前台唯一暴露）。

CPS 复核揭示一个必须如实报告的事实：**CPS 现状恰恰没有做到这一点**——`/go/:code` 直接按 `dramas.promo_code`（渠道真实码）查找（`route.ts:94-98`），前端 CTA 把真实码编码进公开 URL（`drama-cta.ts:48-55`），且 `Drama.promoCode` 无唯一约束（`schema.prisma:32`）。因此本条是**对 CPS 的修正**而非复用；但短码**生成机制**改造复用 CPS 已验证的 `article-public-page-id.ts:32-44` 模式（字母表 + 强制含数字 + 冲突重试 + DB 唯一约束），不发明新算法。全项目唯一生成入口、唯一字段、创建后不可变、重跑/换模型/换代理不再生成、渠道码变化公开 URL 默认不变、禁止 Adapter 自行生成短码——六条全部写入架构字典。详见 parity 报告 §3。

### 8.7 推广资产与 raw payload 存储遵循 CPS（v0.2.1：D-11 关闭）

CPS 现状（`CPS_CURRENT_STORAGE_BEHAVIOR`，parity 报告 §4）：真实值受控存在于 raw 镜像、`DramaPromoLink`、canonical 投影、结算表四处；后台对登录 admin 明文展示（`changdu-links/page.tsx:168-169`）；写路径锁定（manual-promo-lock + 能力位 + 三把钥匙）；审计强制掩码。灰产事故的根因在**写路径**且已修复，不在读可见性。

**v0.2.1 · Owner 裁决（`OWNER_DECIDED`）：**

```text
CPS_PARITY_WITH_PUBLIC_CODE_SEPARATION
```

采用 CPS 方案 A（严格复用），**唯一偏离是公开 URL 使用 `public_redirect_code`，不使用 `upstream_code`**。展开即：

| 维度 | 取值 |
| --- | --- |
| raw 镜像 | 保留上游整行原文（含推广字段），不选择性删改 |
| PromoLink | 存真实 `upstream_code` / `web_url` + `public_redirect_code` |
| canonical 投影 | 第三把钥匙控制，只补空不覆盖 |
| 后台可见性 | 对登录 admin 明文展示（与 CPS 一致） |
| 写路径 | manual-promo-lock 模式 + 能力位 + 三把钥匙 |
| 审计 | 强制掩码 `[redacted_code:length=N]` + hostname（不可协商） |
| **公开面（唯一偏离）** | `/go/{public_redirect_code}`；`upstream_code` **绝不进公开 URL** |

v0.1 的"普通角色只见掩码"表述**撤回**（超出 CPS 实践且无事故依据）。方案 B（收紧读权限）不再作为待决项，仅当未来出现读侧泄露事实时另行提案。

### 8.8 发布流程模仿 CPS：机器门禁 + 批量，不设逐条人工审核

CPS 复核：**`CPS_PARITY_CONFIRMED`**——Article 四态无审核态（`constants.ts:6-11`）；`publishType=now` 批量直发（`article-generation.ts:63-90`）；质量由机器门禁承担（分类缺失降级 draft `:68-74`、promo 空拒绝 `article-actions.ts:563-567`、locale 不匹配拒绝 `:569-576`）；发布后全自动后置任务（`batch-generate.ts:117-170`）。

v0.1 的"内容审核（人工）→ 未审核不得发布"流程**撤销**，改为：

```text
正常条目 → 机器校验通过 → 可批量生成 → 可批量发布
异常条目 → 人工处理队列
```

异常清单：locale 无法映射、标题/简介为空、正文为空或超限、章节结构异常、推广链接缺失或非法、模板渲染失败、URL 冲突、上游字段类型变化、内容安全规则命中。

### 8.9 v0.2 内部结构修正（无需 Owner 仲裁，直接生效）

| # | 修正 | 内容 |
| ---: | --- | --- |
| 1 | 单批完整性 | 拆分 `catalog_observed_total`（渠道目录水位，仅供全量扫描参考）/ `batch_expected_count`（本批页区间应得数）/ `batch_actual_count`。**不再用本批抓取量对比全局 totalCount** |
| 2 | 首扫任务项 | 新增 `CatalogScanTask / CatalogScanTaskItem`（item 绑定 page index/range + request fingerprint）。SourceItem 存在后，`ChannelSyncTaskItem` 才绑定 `source_item_id` |
| 3 | P2/P3 循环依赖 | 已有推广资源提取、PromoLink upsert、`/go`、基础埋点**移入内容上线主链（P2）**；P3 只保留主动生成（W9 门控） |
| 4 | 标签关系表 | 新增 `NovelSourceItemLabel`（`novel_source_item_id` + `source_label_id` + `first_seen_at` + `last_seen_at` + `active`），废除未定义的 `NovelLabel` 引用 |
| 5 | Active Task 互斥 | 作用域从"全局同类型"改为 `(task_type, channel_account_id, channel_app_id, operation_scope_hash)`。**v0.2.1 修正**：目录扫描是例外——`CatalogScanTask` 不用 page-range hash（那会允许同一账户对同一目录并发重叠扫描），改为 **`(channel_account_id, channel_app_id, project_type)` 同时只允许一个 active catalog scan**；其余任务类型仍用 `operation_scope_hash` |
| 6 | dry-run 定义 | 统一为：**零上游副作用 + 零正式业务资产写入；允许写 Task / Audit / ProbeResult**。废除"dry-run 完全零写库" |
| 7 | 阶段命名 | `P1–P4` = V1 施工阶段；后续工作统一称 **Post-V1**，不再使用"Phase 2" |

---

## 附录 A · 术语表

| 术语 | 含义 |
| --- | --- |
| 来源条目 | 上游渠道返回的一条原始记录，保留上游主键与原文，不做业务解释 |
| canonical 实体 | 站内自有的权威内容实体，是发布、SEO、归因的落点 |
| 写前意图审计 | 调用有副作用的上游接口**之前**先落一条"我要调了"的审计行并提交 |
| 反重复领取闩 | 上一次意图审计未被回读确认时，禁止自动再发同一请求，只能转人工 |
| 双闸 | 功能开关（能不能跑）与写入开关（跑了能不能写库）两道独立 env 门 |
| dry-run | 走完全部只读判定路径、落判定结果、但绝不调用有副作用接口 |
| canary | 放量前先跑一条，`limit` 被强制为 1 |
| 派生状态 | 任务状态由 item 计数实时算出，不用内存累加器，崩溃后重算仍正确 |
| 试读物化 | 把上游实际返回的试读章节正文落库成行 |
| 白名单 fail-closed | 未显式登记的一律拒绝，而非默认放行 |

## 附录 B · 引用的标识符与位置

| 标识符 | 位置 |
| --- | --- |
| CPS 基线 commit | `d77c3b968285698529cf97c7f0f97b286d7a2a9c` |
| CPS 生产锚点 | tag `v8.1.1` / commit `84a3fa1f27ea4f7469f3b5789278c00c28f8543a` |
| CPS 工作区 | `/Users/chenweifeng/Documents/产品原型及文档/cps项目/cps-admin-v811-search-ux` |
| 浏览器探测报告（一轮） | `cps-admin/reports/P0_BROWSER_INTERFACE_PROBE.md` |
| 浏览器探测报告（二轮） | `cps-admin/reports/P0_SECOND_BROWSER_PROBE.md` |
| 收益探测报告 | `cps-admin/reports/P0_REVENUE_PROBE_AND_BACKFILL.md` |
| 继承矩阵 | `docs/audit/novel-p0-beidou-changdu-inheritance-matrix.md` |
| 依赖闭包 | `docs/audit/novel-p0-reuse-dependency-closure.md` |
| 本地字典 | `docs/audit/novel-p0-architecture-field-dictionary.md` |
| PG 原型（已冻结，不继承代码） | `cps海阅/novel-p0-pg-prototype/` |
| Notion 立项页 | `https://www.notion.so/3ab601b5fd3480a6a625f65a85557d49`（Notion 本身未读；**正文经 Owner 以 GitHub Markdown 提供，已读**） |
| 立项书 v0.4 原文 | `github.com/flightzxc/cps-novel` @ `03795a41da8b2ebdfff33a791d6a6e9535e72388` · `海外小说 CPS 分发站 — 一期立项方案 v0.4（调研收口 + 施工规划 v0.1）`（811 行，已读） |
| 台账原文 | 同上 · `【台账】Novel v1 调研与待确认事项（按执行人分派）`（253 行，已读；页首已自述降为历史快照与 Owner 答案存档） |
| Notion 历史调研页 | `https://www.notion.so/Novel-v1-77169572d3ea42d094de17fa72f2c6e8`（未读，已降为历史快照） |
| Notion 技术调研任务台账 | `https://app.notion.com/p/e52511a7661747bba50b75abdd080711`（本轮未读） |
| Notion 渠道接口台账 | `https://app.notion.com/p/fb14be8f6b0d49c8a9351398418b29da`（本轮未读） |
| Notion 接口字段数据字典 | `https://app.notion.com/p/132f98247876435a96299d0d84359ff6`（本轮未读） |
| Notion 架构与数据模型字典 | `https://app.notion.com/p/cd15312396384a418a952589c01762f7`（本轮未读） |
