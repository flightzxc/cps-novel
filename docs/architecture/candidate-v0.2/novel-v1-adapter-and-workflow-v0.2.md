# 海外阅读 v1 · Adapter 契约与工作流 v0.2（候选）

> 文档性质：**架构候选**，待 Owner 审核。
> **本文档设计接口形状与流程语义，不实现代码。** 未调用任何渠道接口，未写任何 Adapter。
> v0.2 修订：2026-08-02。主要变更：目录同步取消分成准入过滤并引入 CatalogScanTask；单批完整性口径拆分；试读刷新删除 payEpisFrom 自动下架、补缺失章节处置推荐；发布改机器门禁 + 异常队列；已有推广/公开短码/`go`/埋点移入 P2 主链；`/go` 改公开短码；dry-run 定义统一；active 互斥作用域化。逐项见 `CHANGELOG-v0.1-to-v0.2.md`。
> CPS 代码基线：`d77c3b968285698529cf97c7f0f97b286d7a2a9c`

---

## 1. Adapter 要解决什么问题

CPS 的 `ChannelAdapter` 只有两个方法、34 行（`src/lib/adapters/channel.ts:28-34`）：`listDramas` 和 `normalizeRawDrama`。其余渠道能力——领链、回读、收益——散落在业务层，各自直接拼请求。

后果有三个，都在生产上出现过：

1. **危险调用没有类型标记。** `claimPromo` 是不可逆的上游副作用，但它和只读的 `fetchPromoInfo` 在类型上长得一样。每个调用点都得自己记得"这个是危险的"，忘了就漏审计。
2. **品类判别位被硬钉。** `CHANGDU_PROMO_PROJECT_TYPE = 2` 写在 `src/lib/adapters/changdu-getcode.ts:7`，全仓引用。要接小说（`projectType=1`）就得改常量或复制一份。
3. **能力有无没有登记处。** 一个渠道支持什么、不支持什么、证据到哪一步，只能靠读代码推断。

海外阅读的 Adapter 契约要同时修掉这三个。

---

## 2. 契约设计

### 2.1 三条设计约束

**约束一：有副作用的能力必须与只读能力在类型上可区分。**

不是靠命名规范，是靠类型系统。只读能力返回 `ReadResult<T>`，副作用能力返回 `SideEffectResult<T>` 且**在类型上要求传入一个已提交的意图审计凭据**。忘记写审计 → 编译不过。这把 CPS 的"靠人记得"升级成"编译器强制"。

**约束二：所有品类与账户判别位参数化。**

`projectType`、`agencyId`、`language` 全部从 `ChannelApp` / `ChannelAccount` 配置解析，不出现模块级常量。Adapter 方法签名里它们是入参，不是隐含状态。

**约束三：能力注册表是一等公民。**

每个 `(渠道, 能力)` 组合在注册表里有一行，记录启用状态、证据等级、以及禁用原因。后台 UI 直接读它决定按钮是否可点。这个模式 CPS 在 v7.9 已有先例（能力注册 + 显式 `disabled` 登记 + fixture dry-run），继承。

### 2.2 能力表

| 能力 | 只读 / 副作用 | Endpoint | 证据等级 | V1 状态 |
| --- | :---: | --- | --- | --- |
| `listBooks` | READ_ONLY | `POST /api/v1/res/getlistpc` | `PRODUCTION_READ_PROVEN` | ✅ enabled |
| `normalizeBook` | 纯函数 | — | — | ✅ enabled |
| `fetchBookMaterial` | READ_ONLY | `POST /api/v1/material/getbydataid` | `PRODUCTION_READ_PROVEN` | ✅ enabled |
| `fetchBookResources` | READ_ONLY | `POST /api/v1/res/getvideoinfo` | `PRODUCTION_READ_PROVEN` | ✅ enabled |
| `fetchPreviewChapters` | READ_ONLY | `POST /api/v1/res/getchapterinfo` | `PRODUCTION_READ_PROVEN` | ✅ enabled |
| `readExistingPromo` | READ_ONLY | 无独立 endpoint（`getlistpc` / `getbydataid` 的返回字段） | `PRODUCTION_READ_PROVEN` | ✅ enabled |
| `claimPromo` | **SIDE_EFFECTING** | **未证** | `BROWSER_OBSERVED`（能力存在）+ `UNPROVEN`（合同） | 🔒 **registered_disabled** |
| `readPromoAfterClaim` | READ_ONLY | 依赖 `claimPromo` 存在才有意义 | `UNPROVEN` | 🔒 **registered_disabled** |
| `fetchRevenue` | READ_ONLY | `POST /api/Report/GetReport` | `PRODUCTION_READ_PROVEN`（接口）/ `PARTIAL`（维度） | 🔒 **registered_partial**，V1 不调用 |
| `resolveCredential` | 本地，不出网 | — | `CODE_CONFIRMED`（CPS 现成） | ✅ enabled |
| `classifyError` | 纯函数 | — | `CODE_CONFIRMED`（CPS 现成） | ✅ enabled |

---

### 2.3 逐能力契约

#### `listBooks` — 目录列表

| 项 | 内容 |
| --- | --- |
| **副作用** | READ_ONLY |
| **Endpoint** | `POST https://kocserver-cn.cdreader.com/api/v1/res/getlistpc`（`PRODUCTION_READ_PROVEN`，`P0_BROWSER_INTERFACE_PROBE.md:45`） |
| **请求输入** | `name`（空串=不筛选）、`orderType`、`pageIndex`、`pageSize`、`projectType`（来自 ChannelApp 配置）<br>**已观察到的请求体只有这五个字段** |
| **返回标准化语义** | `{ status: "ok", items: RawBook[], totalCount: number }` \| `{ status: "not_configured", reason }`<br>`not_configured` 与「请求失败」必须分开——CPS 已有这个二分（`adapters/channel.ts:21-26`），继承 |
| **幂等** | 幂等只读 |
| **QPS** | 必须有上限。**上游阈值未声明**，CPS 侧北斗自定 5 QPS（`worker/handlers/batch-promo.ts:28`）是自定值不是上游合同。海外阅读初始建议 2 QPS，由 Adapter 声明而非业务层散落 |
| **重试** | 可自动重试（幂等）。指数退避，尊重 `Retry-After` |
| **审计** | 批次级即可，不需 item 级 |
| **证据等级** | `PRODUCTION_READ_PROVEN` |
| **未知项** | ① 是否支持 `language` / `agencyId` / `splitRatio` 服务端筛选（**待决 D-2**）<br>② 空页与最后一页的返回形状未自然触达（`:53`）<br>③ 429 语义与限流阈值未证 |

**已证返回字段**（`P0_BROWSER_INTERFACE_PROBE.md:55`，二轮补至 53 个字段）：包含 `id`、`agencyId`、`agencyName`、`logo`、`projectType`、`seriesId`、`seriesName`、`description`、`coverUrl`、`payEpisFrom`、`allEpis`、`language`、`languageName`、`isRelease`、`localType`、`localSubType`、`seriesTypeList`、`recommendList`、`splitRatio`、`ttoSplitRatio`、`kocCode`、`publicUrl`、`homeLink`、`onlineUrl`、`promoCreateTime`、`createTime`、`hasMultiLanguage` 等。

**`totalCount` 的用途**：作为 `expected_total` 完整性核验基准（对齐 CPS `worker/handlers/changdu-source-sync.ts:251-255`）。样本值 95,479，但**其语种与 agency 覆盖范围未证**（待决 D-4）。

#### `normalizeBook` — 归一化

| 项 | 内容 |
| --- | --- |
| **副作用** | 纯函数，**无 IO** |
| **输入** | 一行 `RawBook` |
| **输出** | `NormalizedBook`：`externalBookId`、`sourceLanguageCode`、`title`、`description`、`coverUrl`、`totalChapterCount`、`paidFromChapter`、`splitRatio`、`externalAgencyId`、`rawPayload` |
| **幂等** | 纯函数 |
| **审计** | 否 |
| **约束** | **绝不含网络调用**。CPS 的 `adapters/beidou.ts` 自述"纯解析层"，这个原则继承 |
| **未知项** | `isRelease` / `localType` / `localSubType` 语义未证 → **只落 `rawPayload`，不产出派生字段** |

#### `fetchBookMaterial` — 素材信息

| 项 | 内容 |
| --- | --- |
| **副作用** | READ_ONLY |
| **Endpoint** | `POST /api/v1/material/getbydataid`（`PRODUCTION_READ_PROVEN`） |
| **请求输入** | `agencyId`、`dataId`、`projectType`、`language`、`materialType` |
| **返回语义** | 素材身份/类型、预览 URL、系列身份/封面/标签/推荐、`materialStatus`、`statusText`、时间字段 |
| **幂等** | 幂等只读 |
| **审计** | 批次级 |
| **未知项** | `materialStatus` 数值枚举语义未证（观察到 `statusText=可领用`，但未穷举）。**不得据此推断领取资格** |

#### `fetchBookResources` — 资源信息

| 项 | 内容 |
| --- | --- |
| **副作用** | READ_ONLY |
| **Endpoint** | `POST /api/v1/res/getvideoinfo`（**上游命名沿用，小说场景下是"资源信息"不是"视频"**） |
| **请求输入** | `agencyId`、`seriesId`、`projectType`、`language` |
| **返回语义** | `allEpis`、`payEpisFrom`、`assetList[]`、`diskPath`、`ttoSplitRatio`、`rule` |
| **幂等** | 幂等只读 |
| **未知项** | `rule` / `diskPath` / `assetList` 在小说场景的语义未证。**V1 只取 `allEpis` 与 `payEpisFrom` 做交叉核验，其余落 rawPayload** |

#### `fetchPreviewChapters` — 试读章节

| 项 | 内容 |
| --- | --- |
| **副作用** | READ_ONLY |
| **Endpoint** | `POST /api/v1/res/getchapterinfo`（`PRODUCTION_READ_PROVEN`） |
| **请求输入** | `agencyId`、`seriesId`、`projectType`、`language` |
| **返回语义** | `data.bookId`、`data.currentLanguage`、`data.chapterList[]`；每条含 `i`、`chapterID`、`chapterName`、`chapterShowName`、`chapterContent`（**内嵌纯文本**） |
| **分页** | **无。上游一次返回全部，未观察到任何 cursor 字段**（`P0_BROWSER_INTERFACE_PROBE.md:78`） |
| **幂等** | 幂等只读 |
| **审计** | **是**（内容合规）。审计只记条数、字符数、哈希，**绝不记正文** |
| **内容约束** | ① 单章长度上限（样本 3,997–11,858 字符），超限进异常队列不静默截断<br>② 单次返回条数上限（防上游异常返回巨量）<br>③ 正文不进日志、不进错误消息 |
| **未知项** | ① `chapterID` 稳定性未证<br>② 章节删除/下架、卷层级、增量同步语义未证（`:79`）<br>③ 法语的 `language` 数值枚举**未安全取得**（`P0_SECOND_BROWSER_PROBE.md:58`）——这意味着法语同步在拿到该值前不可执行 |

**物化策略**：`UPSTREAM_RETURNED_PREVIEW`。只物化 `chapterList[]` 实际返回的元素，数组长度是结果不是期望。**不设 `PREVIEW_CHAPTER_COUNT` 常量，不用 `payEpisFrom - 1` 推算，不主动请求更多章节。**

#### `readExistingPromo` — 读取已有推广资源

| 项 | 内容 |
| --- | --- |
| **副作用** | READ_ONLY |
| **Endpoint** | **无独立 endpoint**。是 `getlistpc` 与 `getbydataid` 的返回字段（`P0_SECOND_BROWSER_PROBE.md:107-110`） |
| **返回语义** | `kocCode`（非空字符串）、`publicUrl`、`homeLink`、`onlineUrl`（样本为 null）、`promoCreateTime`；素材侧 `statusText`、`materialStatus`、`materialType`、`materialName` |
| **幂等** | 幂等只读 |
| **审计** | **是**。写 `PromoClaimAudit`，`decision=already_available`，`origin=upstream_existing` |
| **脱敏** | 审计只存 `[redacted_code:length=N]` 与 hostname。样本证据：码长 6、SHA-256 前 12 位、Host `eng.moboreader.com` |
| **证据等级** | `PRODUCTION_READ_PROVEN` |
| **未知项** | `onlineUrl` 为 null 的含义未证（未生成？不适用？）；`materialStatus` 枚举未证 |

**这是 V1 唯一启用的推广能力。**

#### `claimPromo` — 生成推广资源 🔒

| 项 | 内容 |
| --- | --- |
| **副作用** | **SIDE_EFFECTING —— 消耗上游配额，不可逆** |
| **Endpoint** | **未证** |
| **Method** | **未证** |
| **Body** | **未证** |
| **幂等规则** | **未证** |
| **写前/写后 readback** | **未证** |
| **是否与短剧 `getcode` 相同** | **未证**。二轮探测自然打开推广页签**未观察到 `getcode`**；这只能得出"该样本未证明共用"，**不能得出接口不存在或一定不共用**（`P0_SECOND_BROWSER_PROBE.md:111`） |
| **证据等级** | 能力存在 = `BROWSER_OBSERVED + OWNER_CONFIRMED`；API 合同 = `UNPROVEN` |
| **V1 状态** | **registered_disabled** |

**本能力在 V1 的存在形态**：

```
能力注册表行：
  channel        = changdu
  capability     = claimPromo
  status         = registered_disabled
  reason_code    = capability_contract_unproven
  evidence_level = BROWSER_OBSERVED
  enabled_gate   = OWNER_GATE + CONTRACT_FROZEN
```

后台"生成推广资源"按钮**存在但禁用**，鼠标悬停显示原因。这比"按钮不存在"好，因为运营能看见这个能力将来会有；也比"按钮能点但报错"好，因为不会有人误以为是临时故障而反复点击。

**明令禁止**：不得根据 CPS 短剧的 `getcode` 协议补写请求合同。不得"先按短剧的写，反正到时候改"。CPS 短剧的 `projectType=2` 是硬编码常量，小说是否复用该协议**在台账里仍是 `P0-X2 BLOCKED`**。

**解冻的前置条件**（四条全满足）：
1. **W9 授权**——立项书 §十二 记录 W9（有副作用接口首测授权）当前为**"暂不"**。这是第一道，也是本方案无权代为关闭的一道；
2. Owner 陪同下的一次受控探测，自然触发一次真实生成，捕获脱敏请求合同；
3. 幂等规则明确（重复调用会不会重复消耗配额）；
4. 写前/写后 readback 路径确认。

合同冻结后的首次真实调用，证据等级为 `CANARY_WRITE_PROVEN`（立项书七级口径的第六级），**必须是单条 canary**。

#### `readPromoAfterClaim` — 领取后回读 🔒

| 项 | 内容 |
| --- | --- |
| **副作用** | READ_ONLY |
| **证据等级** | `UNPROVEN`（依赖 `claimPromo` 存在才有意义） |
| **V1 状态** | registered_disabled |
| **设计要点（解冻时生效）** | 有界重试：次数与间隔**双向钳位**。CPS 默认 1 次 / 上限 5 次，间隔默认 2s / 上限 30s（`src/lib/changdu-promo-claim.ts:271-299,305-325`）。上游写入延迟量级未知，参数需实测后定 |

#### `fetchRevenue` — 收益回拉 🔒

| 项 | 内容 |
| --- | --- |
| **副作用** | READ_ONLY |
| **Endpoint** | `POST https://kocserver-cn.cdreader.com/api/Report/GetReport`（`PRODUCTION_READ_PROVEN`） |
| **请求输入（已证）** | `beginTime`、`endTime`、`dates[]`、`dimensions[]`、`pageIndex`、`pageSize`、`projectType`（网文=1 / 短剧=2）。**无 Query 参数，全部走 JSON Body** |
| **返回语义（已证）** | `data.headers[]`（`label` / `value` / `isOtherColor`）、`data.list[]`、`code` / `message` / `status`；汇总行由 `isTotal=1` 标识 |
| **已证指标映射** | 日期→`dimensionKey`、激活用户→`realDevNum`、新用户→`newRealDevNum`、新用户比例→`realDevNumRate`、分成收入→`realIncome` |
| **已证不存在的字段** | `agencyId`、`agencyName`、`seriesId` / `bookId`、`seriesName`、`promoCode`、`materialId`、product/app/platform、team member、settlement status、独立 `currency` |
| **幂等** | 幂等只读。需 `dedupeKey` |
| **审计** | 批次级 + 异常级 |
| **证据等级** | 接口 `PRODUCTION_READ_PROVEN`；**归因维度 `PARTIAL`** |
| **V1 状态** | registered_partial，**不调用** |
| **未知项** | ① 书籍/推广码能否作为查询维度（`BOOK_OR_PROMO_FILTER_SAMPLE_UNAVAILABLE`）<br>② `GetReportMaxTime` 完整合同（`ADDITIONAL_CONTRACT_CAPTURE_REQUIRED`）<br>③ 分页语义（请求带 `pageIndex/pageSize=999`，响应未见 `totalCount`）<br>④ `rmb*` 系列字段与 `realIncome` 的币种关系 |

**为什么已证接口仍不在 V1 调用**：能拉回账户级日汇总，但无法归因到书或推广码。而"这本书赚了多少"正是产品要的。拉一堆无法归因的汇总数存起来，只会产生一张将来要迁移的表。

#### `resolveCredential` — 凭证解析

| 项 | 内容 |
| --- | --- |
| **副作用** | 本地，**不出网** |
| **输出** | `{ ok: true, secret }` \| `{ ok: false, reason: "credential_missing" \| "credential_expired" }` |
| **三重校验** | 存在 → `expiresAt` 未过 → 载荷本地解析校验（CPS `src/lib/changdu-promo-claim.ts:477-498`） |
| **约束** | **不得调渠道接口验证凭证。** 省一次上游调用且更快 |
| **`missing` vs `expired` 必须二分** | 运维动作不同：一个是没配，一个是要换 |
| **未知项** | 凭证形态是否长期是 bearer JWT。探测观察到 `Authorization` / `Areainterface` / `Browserlang` 三个头（`P0_BROWSER_INTERFACE_PROBE.md:29`），**后两个的作用未证**——这意味着 Adapter 的请求头构造可能需要额外配置项 |

#### `classifyError` — 错误分类

| 项 | 内容 |
| --- | --- |
| **副作用** | 纯函数 |
| **输出** | `{ failureCategory, retryable, retryAfterMs? }` |
| **设计要点** | **两个维度正交**：`failureCategory` 用于审计（要细），`retryable` 用于调度（要简）。CPS 北斗侧只有 `retryable` 布尔、畅读侧只有 18 值分类，两者分裂——海外阅读合一 |
| **分类粒度** | 继承畅读的 18 值粒度，按小说语义重列。**关键：区分"正常前置态"与"错误"**——CPS 的 `promo_code_not_generated` 是 claim 的入口条件，不是失败 |
| **未知项** | 上游 429 / 限流的具体形态未证（两轮探测 429 均为 0） |

---

### 2.4 能力注册表

| 列 | 含义 |
| --- | --- |
| `channel_code` | 渠道 |
| `capability` | 能力名 |
| `status` | `enabled` / `registered_disabled` / `registered_partial` |
| `side_effecting` | 布尔。**决定是否强制要求意图审计** |
| `evidence_level` | 证据等级 |
| `reason_code` | 禁用原因（机器可读） |
| `enabled_gate` | 启用需要的门（`OWNER_GATE` / `CONTRACT_FROZEN` / `FEATURE_FLAG`） |
| `qps_limit` | 该能力的 QPS 上限 |
| `timeout_ms` | 超时 |

后台 UI 直接读这张表决定按钮状态。**不在 UI 代码里 `if (channel === 'changdu')` 硬判断。**

---

## 3. 工作流

每条流程给出：触发、状态、幂等、安全闸、失败态、人工介入、审计、验收。

### 3.1 人工批次书目同步（v0.2：以 `CatalogScanTask` 承载）

**这是 V1 最核心的流程，也是最容易出事的一条。**

**v0.2 结构修正**：v0.1 让 `ChannelSyncTaskItem` 承载首次目录同步是一个漏洞——首扫时 `NovelSourceItem` 尚不存在，item 无物可绑。目录扫描改由 **`CatalogScanTask` / `CatalogScanTaskItem`** 承载，item 绑定 **page index / page range + request fingerprint**；扫描 upsert 出 SourceItem 之后，后续定向作业（试读物化、推广读取、刷新）才由 `ChannelSyncTaskItem` 按 `source_item_id` 组织。

| 项 | 内容 |
| --- | --- |
| **触发** | 后台运营点击，**必须显式填参数**。无 cron、无自动触发 |
| **入队** | 走单一带校验的工厂函数（继承畅读形态，CPS `src/lib/channel-sync-task.ts:351`）。**不允许各处散着建任务** |
| **状态** | 任务：`pending` → `processing` → `completed` / `completed_with_errors` / `failed`<br>item（= 页/页区间）：`pending` → `processing` → `success` / `failed` |
| **幂等** | active 互斥按**作用域**（v0.2）：`(task_type, channel_account_id, channel_app_id, operation_scope_hash)` 部分唯一——同账户同应用同页区间只许一个 active，不同账户/应用/不重叠区间可并行；item 级 `(task_id, page_index)` 唯一 |

**立项书 §C.2 的九项安全件（缺一不得上线）**：最大分页数 · 最大 item 数 · `dry-run` · Feature Flag · Allow Write · 进度检查点 · 可恢复状态 · 人工触发来源 · 审计记录。下表的六道闸覆盖前五项，其余四项在本节的状态/幂等/失败态/审计各行。

**安全闸（六道，缺一不可）**：

| # | 闸 | 说明 |
| ---: | --- | --- |
| 1 | Feature Flag | `FEATURE_NOVEL_CATALOG_SYNC`，默认关 |
| 2 | Allow Write | `NOVEL_CATALOG_SYNC_ALLOW_WRITE`，默认关。**功能开了也不写库** |
| 3 | 分页安全上限 | 默认值参照 CPS 的 2000 页。**命中即 `partial_failed`，不报 `completed`** |
| 4 | 单任务 item 上限 | 参照 CPS 的 1000 |
| 5 | 任务 TTL | 超时的陈旧任务不再执行。CPS 用 6 小时（`changdu-promo-claim-limits.ts:3`）。**防止陈旧任务被唤醒后打上游** |
| 6 | dry-run 缺省 | `apply` 缺省 false。**dry-run 定义（v0.2 统一）：零上游副作用 + 零正式业务资产写入；允许写 Task / Audit / ProbeResult**——判定结果要落任务与审计，否则 dry-run 没有验证价值 |

**分批策略（回答任务问题 9.1：9.5 万级目录怎么人工分批而不误触全量）**

这里有个必须正视的事实：`getlistpc` **没有已证的服务端筛选参数**（待决 D-2）。请求体只有 `name` / `orderType` / `pageIndex` / `pageSize` / `projectType`。任何按属性的圈选都**只能在拉回来之后做**。

因此分批的维度只能是**页码区间**：

```
运营发起一个批次，必须填：
  · pageIndex 起始与结束（显式区间，如 1–50）
  · pageSize（有上限，参照 CPS 的 100）
  · mode = dry_run | apply
  · 可选：canary = true（强制只处理第 1 页第 1 条）

系统拒绝的输入：
  ✗ 不填区间（"同步全部"）
  ✗ 区间跨度超过单任务安全上限
  ✗ 同账户同应用存在作用域重叠的 active 任务（v0.2：不再全局按类型互斥）
```

**"拒绝按筛选全量、只接受显式区间"这条直接继承 CPS**——那里的对应物是"只支持显式勾选剧目，不支持当前筛选全量领取"（`src/lib/changdu-promo-claim-limits.ts:5-14`），中文错误文案明显是事故后加的。

放量节奏：`canary`（1 条）→ 小区间 dry-run（如 1–5 页）→ 同区间 apply → 逐步扩大区间。**每一步之间有人看结果**。

**写入规则（v0.2 · `ACCEPT_CHANNEL_CONTENT`，Owner 裁决取代 v0.1 准入过滤）**：

- **所有正常返回的行 → upsert `NovelSourceItem`**。⛔ v0.1 的"`splitRatio < 50` → skipped 不建 SourceItem"作废——分成比例是渠道业务属性，不是平台准入门槛，原样入库供运营筛选/排序/分析；
- `projectType == 1` → 交叉核验（返回行的品类必须与本渠道应用配置一致，不一致 → item 失败并记录，这是**数据一致性检查**不是商务过滤）；
- `agencyId` 未登记进 `ChannelApp` → item 失败，原因 `unregistered_agency`（**身份不清不落库**，与分成无关）；
- 若未来某渠道确需商务筛选：做成**渠道级可选配置，默认不启用**，且只影响"是否建 Novel/发布"这类下游动作，**永不影响来源镜像落库**。

**完整性核验（v0.2 口径拆分）**：

| 量 | 定义 | 用途 |
| --- | --- | --- |
| `batch_expected_count` | 本批页区间的应得条数（由各页实际返回行数与末页判定累计） | **单批完整性判据**：`batch_actual_count < batch_expected_count` → `partial_failed` |
| `batch_actual_count` | 本批实际落库/处理条数 | 同上 |
| `catalog_observed_total` | 本次观察到的 `data.totalCount` 水位 | **只作**渠道目录水位记录与"全量扫描进度"参考；⛔ **不再用本批抓取量对比全局 totalCount**（v0.1 的口径在分批场景必然误报） |

**不谎报 `completed`** 的原则不变：命中安全上限、单批不完整，一律 `partial_failed`。

| 项 | 内容 |
| --- | --- |
| **失败态** | item（页）级隔离，异常只毙该页；attempt 在**领取时** +1；30 分钟未完成且 attempt<3 → 重置 `pending`，attempt≥3 → `failed(stale_processing)` |
| **人工介入** | `partial_failed` 可人工重试失败页 |
| **审计** | 批次级：参数、区间、`batch_expected/actual_count`、`catalog_observed_total`、停止原因、耗时 |
| **验收** | ① dry-run 零上游副作用、零正式业务资产写入（Task/Audit 允许）；② 只开 Flag 不开 Allow Write → 明确失败且零业务写入；③ 命中安全上限 → `partial_failed`；④ `batch_actual < batch_expected` → `partial_failed`；⑤ 杀进程重启后未完成 item 恢复且 attempt 已 +1；⑥ **低分成行照常入库**（`ACCEPT_CHANNEL_CONTENT` 生效证明）；⑦ 两个不同账户的不重叠区间任务可同时 active |

### 3.2 来源条目归一化与 canonical 建立

| 项 | 内容 |
| --- | --- |
| **触发** | 同步任务内的 item 处理阶段 |
| **状态** | `NovelSourceItem.status`: `pending` → `linked` |
| **幂等** | 按 `(channel_app_id, external_book_id, source_language_code)` upsert |

**归一化步骤**：

1. `normalizeBook`（纯函数）产出标准化字段；
2. upsert `NovelSourceItem`，`raw_payload` 存整行；
3. locale 映射：上游 `language` 数值 → 站点 locale，**走单一语种真源**。映射不到 → `unknown`，SourceItem 建但**不建 Novel**，落人工队列；
4. 建 `Novel`：**V1 每条 SourceItem 建自己的 Novel，不跨语种自动合并**（见数据模型 §1.2）；
5. slug 生成：冲突 **suffix-or-throw，绝不静默覆盖**；
6. canonical 字段写入：**只补空，不覆盖已有人工值**。

| 项 | 内容 |
| --- | --- |
| **安全闸** | locale 映射失败 fail-closed；slug 冲突 throw 不覆盖 |
| **失败态** | 单条失败不影响批次其余项 |
| **人工介入** | `unknown` locale 队列；slug 冲突队列 |
| **审计** | 每次 canonical 写入记录：哪些字段补空、哪些字段因已有值被跳过 |
| **验收** | ① 人工改过的 `title` 再同步一次不被覆盖；② 同 slug 冲突时抛错而非覆盖；③ 未映射 locale 不产生可发布实体 |

### 3.3 试读章节物化

| 项 | 内容 |
| --- | --- |
| **触发** | ① 同步任务的后置阶段；② 后台单本手动触发；③ 刷新任务 |
| **状态** | `NovelChapterSourceItem`: `pending` → `materialized` / `failed` |
| **幂等** | 按 `(source_item_id, external_chapter_id)` upsert；正文按 `content_hash` 判断是否需要重写 |

**流程**：

```
调 fetchPreviewChapters
   ↓
返回校验：HTTP 200 且 chapterList 非空
   ↓  否 → failed，记 errorKind，不重试（可能是该书无试读）
逐条处理（i 升序）
   ↓
   · 长度上限检查 → 超限进异常队列，不静默截断
   · 计算 char_count 与 content_hash
   · upsert NovelChapterSourceItem
   · upsert NovelChapter（canonical_chapter_number 由 i 归一）
   · content_hash 变化 → upsert NovelChapterContent
   ↓
更新 NovelPreviewPolicy.materialized_chapter_count（结果记录）
```

| 项 | 内容 |
| --- | --- |
| **安全闸** | 单章长度上限；单次条数上限（`max_materialized_chapters`，防上游异常返回巨量正文）；正文不进日志/错误消息/审计 |
| **失败态** | 空 `chapterList` 不算致命失败，记 `no_preview_available` |
| **人工介入** | 超长正文异常队列（v0.2：这是异常处理，不是逐条审核） |
| **审计** | 只记条数、字符数、哈希前缀、耗时。**绝不记正文** |
| **验收** | ① 物化条数 == 上游返回条数；② 重复运行不产生重复行且不重写未变正文；③ 审计与日志中零正文；④ 超长正文进队列而非被截断 |

**核验口径的关键**：**没有数值期望值**。不能写"应该有 3 章"。核验只有"请求成功 + 数组非空 + 每条正文非空"。

**刷新语义（v0.2 · Owner 裁决 §8.4）**——`chapterList[]` 是试读集合的唯一真源：

```
同一章仍返回：
  hash 未变 → 不重写；consecutive_miss_count 清零
  hash 变化 → 更新正文（有实质变化才推 IndexNow）
新返回章节 → 新增物化 + 新增可索引章节页
某章本次未返回 → consecutive_miss_count += 1，记 last_seen_at
  ⛔ 不得只凭一次缺失立即硬删除或下架
```

**缺失章节的处置（推荐，`CANDIDATE`，本轮不冻结）**：四个候选策略的完整比较见 `novel-v1-cps-parity-review.md` §5。推荐 **②+③ 组合**：连续 K 次（建议 K=3，可配）缺失 → `NovelChapter.status = stale`（停止前台展示、退出 sitemap、进人工队列），**任何情况下不自动硬删 `NovelChapterContent`**（硬删只属于人工发起的版权撤回流程）。这与 CPS 预览刷新的既有形态同构——纯 upsert 状态标记、全文件无删除路径（`preview-sync.ts:379-409`），状态枚举甚至已预留 `stale`（`:30`）但从未写入。策略 ④（等上游明确下架状态）不可行：`getchapterinfo` 无删除/下架字段（探测已证）。

⛔ **v0.2 删除**：v0.1 的"`payEpisFrom` 下调 → 自动撤回章节"路径。`payEpisFrom` 只是收费边界元数据；上游若真收回试读资格，表现必然是该章从 `chapterList[]` 消失，自然落入上面的缺失处置流程。

### 3.4 原始标签保存

| 项 | 内容 |
| --- | --- |
| **触发** | 归一化阶段同事务 |
| **幂等** | 按 `(channel_app_id, label_kind, external_label_value)` upsert |
| **安全闸** | 标签值长度上限；单书标签数上限 |
| **审计** | 批次级计数 |
| **验收** | `seriesTypeList` / `recommendList` / `language` / `agency` 四类均有落库；**未映射标签零前台曝光** |

V1 **只存不用**。这是刻意的：Owner 已裁决 `taxonomy.rawSourceLabels = REQUIRED`、`phase2CanonicalMapping = PLANNED`。第一天不存，Post-V1 就永远缺历史数据。

### 3.5 内容质量机器校验与异常队列（v0.2 · 取代 v0.1 的"内容审核"）

⛔ v0.1 在此处设计了 `pending_review → approved / rejected` 的**逐条人工审核**流程。CPS 复核证明这超出了 CPS 实践（Article 四态无审核态，`constants.ts:6-11`；批量直发 + 机器门禁，见 parity 报告 §2），Owner 亦明确不为每本书每章正文增加人工审核流程。**撤销**，改为：

```text
正常条目 → 机器校验通过 → 可批量生成 → 可批量发布
异常条目 → 人工处理队列（处置后重新走机器校验）
```

| 项 | 内容 |
| --- | --- |
| **触发** | 物化/归一化完成后自动跑机器校验；异常自动入队 |
| **机器校验清单** | locale 无法映射；标题或简介为空；正文为空或超限；章节结构异常（序号断裂/重复）；推广链接缺失或非法；模板渲染失败；URL/slug 冲突；上游字段类型变化；内容安全规则命中 |
| **CPS 对照** | 同构：分类缺失 → 自动降级 draft（`article-generation.ts:68-74`）；promo 空 → 拒绝（`article-actions.ts:563-567`）；locale 不匹配 → 拒绝（`:569-576`）——全是机器门禁，无人工卡点 |
| **人工介入** | **只处理异常队列**：运营看到的是"哪些书为什么没能发"，不是"逐本点通过" |
| **审计** | 校验结果、异常原因、处置人与处置动作 |
| **验收** | ① 无异常的批次全程零人工触点即可发布；② 每类异常都能在队列中看到明确原因码；③ 异常处置后可重入流程 |

### 3.6 SEO 文章生成

| 项 | 内容 |
| --- | --- |
| **触发** | 后台单条或批量，走 `GenericTask` |
| **状态** | `Article.status`: `draft` |
| **幂等** | `(novel_id, locale)` 唯一 |

**模板变量白名单（回答任务问题 9.9）**：

模板引擎继承 CPS 的 `{field}` 替换 + `{if}…{endif}` 条件渲染 + 白名单 + `TemplateVarEmptyError`（`src/lib/template-engine.ts:39-74`）。关键是把 `WILDCARD_FIELDS`（当前 18 项全是剧集字段）重写为小说字段，并且：

**作者、国家、完结状态三项根本不登记进白名单。**

后果是：模板作者**写不出** `{author}`——引擎会因为它不在白名单而拒绝保存模板。这比"渲染成空字符串"强得多，因为空字符串会一路流到线上页面变成"作者：" 这样的残缺文案。

**缺值处理**：白名单内的字段若渲染时为空 → `TemplateVarEmptyError`，**fail-closed**，该条生成失败进队列，不产出半成品页面。

| 项 | 内容 |
| --- | --- |
| **安全闸** | Feature Flag；批量上限；有未处置异常的条目不可生成（v0.2：机器校验取代人工审核） |
| **失败态** | 单条失败不影响批次 |
| **人工介入** | 渲染失败队列 |
| **审计** | 模板 ID、变量快照（脱敏）、渲染结果长度 |
| **验收** | ① 模板中写 `{author}` 保存时即报错；② 白名单字段缺值 → 生成失败而非空白页；③ 批量中单条失败不影响其余 |

### 3.7 发布

| 项 | 内容 |
| --- | --- |
| **触发** | 后台单条或批量 |
| **状态** | `draft` → `published` |
| **幂等** | 重复发布不产生副作用 |

**发布门禁（v0.2 · 全部为机器门禁，全部通过才放行）**：

| # | 检查 |
| ---: | --- |
| 1 | locale 在**发布白名单**内（未登记 → 拒绝） |
| 2 | **机器校验无未处置异常**（§3.5 的清单；取代 v0.1 的"内容审核已通过"） |
| 3 | `PromoLink` 存在、`status=fetched` 且 **`public_redirect_code` 已分配**（**没有推广链接的页面不发布**——CPS 有明确先例：空 `promo_url` 的页面会产生 404 跳转；v0.2 起该能力在 P2 主链内，不再有跨阶段循环依赖） |
| 4 | slug 无冲突 |
| 5 | canonical URL 唯一（每语种版本 self-canonical；试读章节页 self-canonical） |
| ~~6~~ | ⛔ v0.2 删除：~~hreflang 兄弟集合检查~~——V1 无跨 Novel hreflang，无兄弟集合可查 |

| 项 | 内容 |
| --- | --- |
| **安全闸** | 五道机器门禁；批量上限 |
| **失败态** | 门禁不过 → 明确拒绝并说明是哪一道 |
| **人工介入** | 门禁失败队列（异常处理，非逐条审核） |
| **审计** | 发布人、时间、门禁结果、URL |
| **验收** | ① 白名单外 locale 无法发布；② 空推广链接/无公开码无法发布；③ 有未处置异常的条目无法发布；④ 无异常批次全程零人工触点 |

### 3.8 Sitemap 与 IndexNow

| 项 | 内容 |
| --- | --- |
| **触发** | 发布/下架时写 outbox；sitemap 刷新由 Scheduler 定时入队 |
| **状态** | outbox: `pending` → `delivering` → `delivered` / `failed` / `skipped` |
| **幂等** | `(url, revision)` 唯一 |
| **安全闸** | ① Feature Flag；② **页面级可索引判定**（见下，单一真源枚举）；③ `NovelPreviewPolicy.index_authorized`（v0.2：默认 true，单本例外处置开关）；④ 投递失败有界重试 |

**页面级可索引判定（v0.2 · Owner 裁决取代"仅第 1 章可索引"；仍必须是代码级枚举 + 单一真源）**：

| 页面类 | 可索引 | canonical |
| --- | :---: | --- |
| 书详情页 | ✅ | **self-canonical** |
| 题材 / 榜单聚合页 | ✅ | self-canonical |
| **全部实际物化的试读章节页** | ✅ | **self-canonical**（⛔ 不再指向详情页） |
| `stale` / `withdrawn` / `takedown` 状态的任何页 | ❌ | 退出 sitemap + 推送移除 |

章节页要求：链回详情、上一章/下一章导航、CTA、`isPartOf` 结构化标记、title/description 按"书 + 章"模式去重。上游返回 N 章 → N 个可索引页（受 `max_materialized_chapters` 异常上限约束）。**sitemap 不得包含作者/国家/完结类页面**（V1 根本不存在这类页面）。

单一真源枚举仍然必要——"全部可索引"不等于不需要判定：`stale`/下架/撤回随时会把单页翻转为不可索引，判定逻辑只能有一处。

判定与授权是**与关系**：页面级判定放行 **且** 该书 `index_authorized=true`（默认 true），才进 sitemap / IndexNow。
| **失败态** | 投递失败不影响发布，outbox 保留待重试 |
| **人工介入** | 后台可手动重推 |
| **审计** | 投递结果、HTTP 状态、耗时 |
| **验收** | ① 发布后 outbox 有行（详情页 + 全部试读章节页）；② 搜索引擎接口不可用时发布仍成功；③ 单本 `index_authorized=false` 时该书页面零推送；④ sitemap 静态产物只读服务，请求路径不触发生成；⑤ 章节转 `stale` 后 sitemap 移除且推送移除 |

**sitemap 产物落 Object Storage**，不落容器本地磁盘——CPS 当前是本地磁盘（`static-sitemap-cache.ts:11-17` 等），多副本下会不一致。**路径穿越防护（`:35-41`）必须继承。**

### 3.9 已有推广资源读取 + 公开短码分配（v0.2 · 内容上线主链）

⛔ v0.1 把本流程放在 P3，导致"发布门禁要求 PromoLink，而 PromoLink 下一阶段才有"的循环依赖。**v0.2 移入 P2 内容主链**——已有推广资源在 `getlistpc` 响应里已被生产证明，读取零额外上游请求。

| 项 | 内容 |
| --- | --- |
| **触发** | 目录扫描/同步任务后置阶段；或后台单本触发 |
| **状态** | `PromoLink.status`: `pending` → `fetched` / `failed` |
| **幂等** | `idempotency_key = (channel_app_id, external_book_id, source_language_code, channel_account_id)` upsert；**公开码分配幂等**（已有 active 码则跳过，绝不重发） |

**流程（回答任务问题 9.6）**：

```
从已保存的 SourceItem.raw_payload 读 kocCode / publicUrl / homeLink / promoCreateTime
   ↓  （不需额外请求——这些字段在目录同步时已经拿到了）
kocCode 非空？
   ├─ 是 → upsert PromoLink（origin=upstream_existing, status=fetched,
   │            upstream_code=真实码, web_url=真实 URL）
   │        ↓
   │        public_redirect_code 已存在？
   │          ├─ 是 → 不动（不可变）
   │          └─ 否 → 经唯一入口 public-redirect-code.ts 分配一次
   │        ↓
   │        写审计 decision=already_available（脱敏）
   │        可选：canonical 投影（第三把钥匙控制）
   └─ 否 → PromoLink 保持 pending，记 promo_not_generated（**这是正常前置态，不是错误**）
```

**一个重要的设计后果**：因为已有推广资源就在目录列表的返回里，**"读推广"不需要独立的上游请求**。这跟 CPS 畅读不同（那里 `fetchPromoInfo` 是独立调用）。所以 V1 的推广读取几乎零上游成本。

| 项 | 内容 |
| --- | --- |
| **安全闸** | canonical 投影需独立开关（**第三把钥匙**）；**canonical 只补空不覆盖**；公开码不可变（DB 唯一约束兜底） |
| **失败态** | `promo_not_generated` 不算失败 |
| **人工介入** | 无推广码的书进"待生成"清单，等 `claimPromo` 解冻 |
| **审计** | 脱敏：`[redacted_code:length=N]` + hostname；公开码分配记审计（它是站内资产变更） |
| **验收** | ① 审计表中零真实推广码、零完整 URL；② 已有人工推广值不被覆盖；③ 重复运行不产生重复 PromoLink；④ **重跑同步/换执行环境后 `public_redirect_code` 不变**；⑤ 上游 `kocCode` 变化后公开码与公开 URL 不变（`upstream_code` 更新，公开面稳定） |

### 3.10 推广生成（占位流程）

| 项 | 内容 |
| --- | --- |
| **触发** | **V1 不可触发**。能力注册表 `registered_disabled` |
| **UI** | 按钮存在但禁用，显示原因 |
| **解冻后的流程（设计已定，代码不写）** | 完整继承 CPS 领链状态机 |

```
四道前置闸（Flag → Allow Write → 批量上限 → 任务 TTL）
        ↓
resolve ChannelApp（失败 → invalid_channel_app）
        ↓
资格硬前置（失败 → 写审计 + 跳过，不发请求）
        ↓
PRE-READ readExistingPromo
   ├─ 已有 → already_available，直接复用，不 claim
   ├─ 其它失败 → 原样透传上游分类
   └─ 未生成 → 继续 ↓
        ↓
dry_run？→ would_claim（终止，绝不调上游）
        ↓
最近一条意图审计未被确认？→ claim_retry_blocked（转人工，禁止自动重试）
        ↓
resolveCredential 三重校验
        ↓
★ 写前意图审计：decision=claim_attempted, claim_status=attempted, readback_status=not_run
   —— 必须先提交，确保其它事务可读，再调上游
   —— 绝不把 insert 与上游调用包在同一个未提交事务里
        ↓
CLAIM（有副作用）
        ↓
READBACK（有界重试，次数与间隔双向钳位）
   ├─ 上游报成功但读不回 → claim_response_empty_data + manual_review，**不自动重试**
   └─ 其它失败 → readback_failed
        ↓
upsert PromoLink（幂等键）+ 可选 canonical 投影（第三把钥匙）
        ↓
decision=claimed
```

**这段流程的每一步都不得简化。** 明令禁止：把意图审计挪到调用之后；让 `claim_retry_blocked` 变成自动重试；把四道闸并成一道；放宽审计脱敏。

### 3.11 `/go/{public_redirect_code}` 跳转（v0.2 · 只认我方公开码）

| 项 | 内容 |
| --- | --- |
| **触发** | 读者点击 |
| **流程** | 按 **`public_redirect_code`（DB 唯一）** 查 `PromoLink` → 写埋点（异步/批量，记公开码 + `promo_link_id`）→ 302 到 `web_url` |
| **幂等** | 读操作 |
| **安全闸** | ① code 查不到 → 稳定的 404 页，不泄露内部信息；② **目标 URL 必须过 host 白名单**（防开放重定向，CPS 已有 `normalizeRedirectUrl` 协议校验先例，`route.ts:160-168`，本项目再加 host 白名单）；③ 埋点写入失败不影响跳转；④ **绝不按渠道真实码查**——这是与 CPS 现状（`route.ts:94-98` 按 `dramas.promo_code` 查）的刻意差异，Owner 裁决 |
| **失败态** | 埋点失败静默降级；跳转永不因埋点失败而失败 |
| **审计** | 埋点表本身即记录 |
| **验收** | ① 未知 code → 404；② 非白名单 host → 拒绝跳转；③ 埋点关停时跳转仍正常；④ 用渠道真实码访问 `/go/` → 404（公开面不承认真实码）；⑤ 唯一约束下并发分配公开码不产生重复 |

### 3.12 点击埋点

| 项 | 内容 |
| --- | --- |
| **触发** | `/go` 跳转、前台页面事件 |
| **写入策略** | **批量写 + 独立 flush**，不是每事件一次 `create` |
| **安全闸** | ① 总开关（可整体关停，CPS 生产就是关着的）；② 事件类型白名单；③ 速率限制；④ **IP/UA 盐哈希后存** |
| **数据保留** | 原始事件建议 90 天，日汇总长期 |
| **验收** | ① 关停开关生效后零写入；② 原始 IP/UA 不落库；③ 高频请求下不拖垮主库 |

### 3.13 收益回拉（占位流程）

| 项 | 内容 |
| --- | --- |
| **触发** | **V1 不触发**（P4 阶段实施）。能力 `registered_partial` |
| **已知可做的** | 按 `(账户, projectType, 日期区间)` 拉账户级日汇总，明细行与汇总行分离 |
| **不能做的** | 归因到书或推广码 —— `PENDING_R3` |
| **解冻前置** | R3 书籍/推广码筛选合同（待决 D-6） |
| **同步方式** | 参照 CPS 畅读：**只能手动触发，无 cron**。Worker 只轮询任务，不自建收益任务 |
| **幂等** | `request_fingerprint` 唯一。相同时间范围的重复同步必须幂等 |
| **成功判据** | 🔴 **空 `data.list` 是合法的成功结果**，不得算接口失败（已观察到网文查询返回 `headers` 正常 + `list=[]`） |
| **分页** | 观察值 `pageIndex=1` / `pageSize=999`，响应**无 `totalCount`**。**不得假定接口永远无分页**——必须保留分页循环、保守终止判据与安全上限 |
| **汇总行处理** | `isTotal=1` 与 `isTotal=0` 分别保存或明确标记；聚合时不得把汇总行再次计入求和；汇总行用于明细对账；**解析器必须有重复计数测试** |

**为什么已证接口仍不在 V1 调用**：能拉回账户级日汇总，但无法归因到书或推广码，而"这本书赚了多少"正是产品要的。V1 拉一堆无法归因的汇总数存起来，只会产生一张将来要迁移的表。逻辑模型见数据模型文档 §2.16——**模型可以定，表不建**。

### 3.14 下架、版权撤回与内容刷新

这三条流程共用一套状态转移，但触发原因和数据处置不同。

| 场景 | 触发 | `Novel.status` / 章节状态 | 页面响应 | 正文处置 | Sitemap/IndexNow |
| --- | --- | --- | --- | --- | --- |
| **下架** | 运营决定不再推广 | `unpublished` | 稳定的下架提示页 | 保留 | 从 sitemap 移除，推送 outbox |
| **版权撤回** | 上游/权利方要求，**人工发起** | `takedown` | 410 Gone | **删除 `NovelChapterContent` 行**，保留元数据 | 同上，且优先级最高 |
| **内容刷新** | 上游更新 / 定期 | 不变 | 不变 | 按 `content_hash` 判断是否重写 | 有实质变化才推送 |
| **章节持续缺失**（v0.2，`CANDIDATE`） | 连续 K 次刷新未返回该章 | 章节 → `stale` | 该章节页停止展示 | **保留正文行**（不自动删），进人工队列 | 从 sitemap 移除该章节页 |

⛔ **v0.2 删除：v0.1 的"收费边界下调 → 自动删除正文"整条流程。**

Owner 裁决（证据文档 §8.4）：`payEpisFrom` 只是渠道收费边界元数据，其数值变化**不得触发**自动删除；试读集合的唯一真源是 `chapterList[]` 实际返回。若上游真的收回某章试读资格，该章会从 `chapterList[]` 消失，正确地落入上面"章节持续缺失"的处置（stale 停展 + 人工，不硬删）。v0.1 依据的立项书 §C.4 条目应按被替代机制标记，**除非后续获得渠道正式合同（`DOC_CONFIRMED`）证明 `payEpisFrom` 与试读资格回收的因果语义，否则不得恢复**。

**自动化路径里唯一允许删正文的场景不存在了**——硬删除只属于人工发起的版权撤回。这与 CPS 的既有形态一致：预览刷新纯 upsert 状态标记、全文件无删除路径（`preview-sync.ts:379-409`）。

| 项 | 内容 |
| --- | --- |
| **幂等** | 重复下架/撤回无副作用 |
| **安全闸** | ① 撤回是**不可逆**操作，需二次确认 + 能力位；② 批量撤回有上限；③ 撤回后**不允许**通过普通发布流程恢复 |
| **失败态** | sitemap/IndexNow 推送失败不阻塞下架本身——**下架必须立即生效** |
| **人工介入** | 撤回全程人工 |
| **审计** | 操作人、原因、时间、影响的 URL 清单 |
| **验收** | ① 撤回后正文表零行、元数据仍在；② 撤回页返回 410；③ 撤回后 sitemap 不含该 URL；④ 撤回操作全程有审计 |

---

## 4. Worker 设计

**总纲：只允许改"怎么拿到任务、怎么加锁"，不允许改"拿到之后做什么"。**

### 4.1 任务与 item 两级

保留两级模型（任务表 + item 表）。但**不照搬 CPS 的 `processing → pending` 字面状态映射**——那是 SQLite 单 worker 串行约束下表达"分轮续跑"的权宜之计（`worker/handlers/changdu-promo-claim.ts:22-26`）。

PG 下继承的是**语义**：一个长任务分多轮执行，每轮处理有限个 item，轮与轮之间任务可被其它 worker 接手。实现上用显式租约表达，不用状态回退。

### 4.2 原子领取

CPS 现状是 `findFirst` → `update` 两步（`worker/index.ts:106-120`），单 worker 下安全，多 worker 必然重复领取。

**PG 形态**：`SELECT … FOR UPDATE SKIP LOCKED` + 同事务内 update 与审计。

PG 原型对两种策略做过对照（`SANDBOX_PROVEN`，18 轮 A/B × 2/5/10 进程 × S/M/L，`duplicate_claim_count = 0`）：策略 B（CTE 支撑的 `UPDATE … RETURNING`）无稳定 >10% 优势，**推荐策略 A**，理由是锁与更新在同一事务内更易审查。

**一条必须继承的踩坑（`P0_INDEX_PLAN.md`）**：领取 SQL **不得**用 `OR` 把"待领取"和"租约过期"合成一个谓词——原型 L 轮正因此绕过 pending 偏索引，在 1,694/100,000 处停滞。**两条路径必须拆开，各走各的偏索引。**

### 4.3 租约

| 字段 | 责任 |
| --- | --- |
| `locked_by` | worker 实例标识 |
| `locked_until` | 租约到期时间 |
| `heartbeat_at` | 长任务续租 |
| `execution_token` | 所有权凭证，跨进程续跑时校验 |

租约过期由**独立索引路径**扫描回收，不与 pending 路径混用查询。

### 4.4 attempt 与 stale 恢复

- **attempt 在领取时 +1，不是失败时。** 崩溃也计次，毒药 item 必然收敛。这是 CPS 一个容易被"优化"掉的关键细节（`src/lib/channel-sync-task.ts:751-760`）。
- item 超过 stale 阈值（CPS 用 30 分钟）：attempt < 3 → 重置 `pending`；attempt ≥ 3 → `failed(stale_processing)`。
- **item 级恢复优于任务级**——区分"可再试"与"毒药"。

### 4.5 部分成功与续跑

- 任务状态**由 item 计数派生**，禁止内存累加器。崩溃后重算仍正确。
- 派生规则：remaining>0 → `processing`；failed>0 且 success=0 且 skipped=0 → `failed`；failed>0 → `completed_with_errors`；否则 `completed`。
- `completed_with_errors` 可人工重试失败项。

### 4.6 active task 互斥

CPS 用抢 SQLite 写锁实现（`src/lib/changdu-promo-claim-enqueue.ts:202-206`）。**这在 PG 下影响 0 行、不加锁、不报错——保护会静默消失。** 这是继承矩阵里标为**极高风险**的项。

**PG 形态（v0.2 作用域化）**：

```text
部分唯一索引 UNIQUE(task_type, channel_account_id, channel_app_id, operation_scope_hash)
  WHERE status IN ('pending','processing')
```

⛔ v0.1 的"全局同类型只许一个 active"过宽——会让账户 A 的 1–50 页扫描挡住账户 B 的 200–250 页。`operation_scope_hash` 是操作范围（页码区间 / projectType / 目标集合）的规范化指纹；区间重叠但 hash 不同的情况由入队工厂做应用层预检，数据库约束兜住完全相同的重复提交。数据库约束仍是正确性边界，应用层检查只是快速失败路径。

### 4.7 Cron 唯一执行

独立 Scheduler 容器。唯一性由 `(schedule_key, scheduled_bucket)` 唯一键保证（PG 原型 `SANDBOX_PROVEN`：10 个独立 scheduler 只产生 1 条 `cron_run` + 1 个任务）。

**Scheduler 绝不执行业务逻辑**，只入队。

### 4.8 QPS 与并发

- **QPS 上限由 Adapter 能力声明**，不散落在业务层。
- 并发度上限保留（**保护上游，不是保护数据库**）。CPS 里那段"对 SQLite 显式告警并降级"的逻辑（`worker/handlers/batch-promo.ts:59-69`）删除，上限保留。
- 上游限流阈值**未证**——两轮探测 429 均为 0，说明当前速率没触发限流，但不等于阈值已知。初始值保守。

### 4.9 allowlist 与总开关

**双重 fail-closed 全部继承**：

- `WORKER_TASK_ALLOWLIST ∩ HANDLERS 键`，非法值丢弃并告警；
- 总开关关闭 → 进程不启；
- **allowlist 为空 = 不消费任何任务**。

### 4.10 `claim_retry_blocked` 与 manual review

- 结果未知的副作用调用**永不自动重试**，只能转人工。
- `manual_review` 队列在后台可见、可处置、可批注。
- 处置动作本身要有审计。

### 4.11 数据库重试

`withDbRetry` 的重试条件**按 PG 错误码重写**：`40001`（序列化失败）、`40P01`（死锁）可重试；其余不重试。不再按 SQLite busy 判断。

---

## 5. 不可简化项汇总（回答任务问题 9.13）

这些是 CPS 用生产事故换来的。**不得因"重构更优雅"而改写。**

| # | 机制 | CPS 证据 |
| ---: | --- | --- |
| 1 | claim 写前意图审计（先提交再调上游） | `src/lib/changdu-promo-claim.ts:933-946` → `:948` |
| 2 | 反重复领取闩（结果未知不许自动重试） | `:500-522,855-884` |
| 3 | 审计脱敏（掩码码 + 仅 hostname） | `:371-384,568-570` |
| 4 | 四道写入闸 + canonical 第五把钥匙 | `:590-619,684` |
| 5 | 四段独立 status 留痕 | `prisma/schema.prisma:367-370` |
| 6 | 任务状态由 item 计数派生 | `src/lib/channel-sync-task.ts:566-584` |
| 7 | attempt 在领取时计数 | `:751-760` |
| 8 | item 级 stale 恢复（3 次上限） | `:623-665` |
| 9 | 每 10 item 落 DB 检查点 | `:827-835` |
| 10 | 有界参数双向钳位 | `changdu-promo-claim.ts:271-299` |
| 11 | 任务 TTL（陈旧任务不打上游） | `changdu-promo-claim-limits.ts:3` |
| 12 | 安全上限命中 = `partial_failed` 不是 `completed` | `changdu-source-sync.ts:241,722-724` |
| 13 | `expected_total` 完整性核验 | `changdu-source-sync.ts:251-255` |
| 14 | dry-run 走完真实判定 | `changdu-promo-claim.ts:827-853` |
| 15 | 拒绝"按筛选全量"，只接受显式输入 | `changdu-promo-claim-limits.ts:5-14` |
| 16 | 资格硬前置（不发请求就判死） | `changdu-promo-claim-eligibility.ts:128-138` |
| 17 | 凭证指纹 DB 级互斥 | `prisma/schema.prisma:1236-1258` |
| 18 | JWT 本地校验（不调上游） | `src/lib/channel-account/jwt.ts` |
| 19 | worker allowlist ∩ handlers + 双重 fail-closed | `worker/guardrails.ts:28-44` |
| 20 | canonical 只补空不覆盖 | CPS `CLAUDE.md` §6.1 |
| 21 | 上游错误文案清洗后入库 | `changdu-promo-claim.ts:350-354` |
| 22 | 来源条目与 canonical 实体分离 | `prisma/schema.prisma:279` |

---

## 6. 验收口径（工程原型级，v0.2 修订）

任何实现方在交付渠道链路时，必须能演示以下 12 条：

1. 两个 worker 副本同时轮询，**同一任务只被执行一次**；
2. 两个并发入队请求（同账户同应用同范围），**只有一个建出 active task**，另一个明确失败；**不同账户或不重叠范围的两个任务可同时 active**（v0.2 作用域化）；
3. 杀死 worker 后重启，未完成 item 在阈值后恢复为 `pending` 且 attempt 已 +1；
4. 只开 Feature Flag 不开 Allow Write，apply 模式明确失败且**零正式业务资产写入**；
5. dry-run 走完全部判定路径并落判定结果：**零上游副作用 + 零正式业务资产写入；Task / Audit / ProbeResult 写入允许**（v0.2 统一定义，废除"完全零写库"）；
6. 命中分页安全上限 → 任务 `partial_failed`，**不报 `completed`**；
7. **`batch_actual_count < batch_expected_count`（本批页区间应得数）→ `partial_failed`**（v0.2：不再对比全局 `totalCount`；`catalog_observed_total` 只作水位记录）；
8. 审计表中**查不到任何真实推广码或完整链接**，只有 `[redacted_code:length=N]` 与 hostname；
9. **低分成（`splitRatio < 50`）的行照常建 SourceItem 与 Novel**——`ACCEPT_CHANNEL_CONTENT` 生效证明（v0.2）；
10. **`public_redirect_code` 不可变**：重跑同步、并发分配、上游真实码变化，公开码与公开 URL 均不变；用渠道真实码访问 `/go/` 得 404（v0.2）；
11. **章节缺失不删数据**：模拟某章连续缺失，第 K 次后转 `stale` 停展进队列，`NovelChapterContent` 行仍在（v0.2，随缺失策略冻结后定 K）；
12. **无异常批次零人工触点**：从同步到发布全程不需要任何"逐条审核通过"操作（v0.2）。

第 4–8 条与 CPS 的既有验收口径一致（口径已按 v0.2 修正）。第 1–3 条是 PG 化新增，PG 原型已在沙箱证明可达成。第 9–12 条是 v0.2 Owner 裁决的直接验收化。

---

## 附录 · 未知项索引

| 编号 | 未知项 | 阻塞什么 | v0.2 状态 |
| --- | --- | --- | --- |
| U-1 | `getlistpc` 是否支持服务端筛选 | 分批策略（待决 D-2）。⚠️ v0.2 影响面缩小：不再有分成准入过滤，筛选参数只关系"能否按语种/agency 定向拉取" | OPEN |
| U-2 | 一行 = 一本书还是一个语种版本 | ~~Novel/SourceItem 基数~~ | **v0.2 关闭**：Owner 裁决每语种版本独立 Novel（D-1 关闭），上游行语义不再阻塞建模 |
| U-3 | 法语 `language` 数值枚举 | 法语同步不可执行 | OPEN |
| U-4 | `chapterID` 稳定性 | 章节增量同步 | OPEN |
| U-5 | 章节删除/卷层级/增量语义 | 内容刷新流程（缺失章节处置策略的 K 值与语义） | OPEN；已有推荐（parity §5），待 Owner 冻结 |
| U-6 | `claimPromo` 全部合同 | 推广生成能力（W9 门控） | OPEN |
| U-7 | 收益书籍/推广码归因维度 | 归因键（`PENDING_R3`） | OPEN |
| U-8 | `GetReportMaxTime` 合同 | 收益日期边界（待决 D-5） | OPEN |
| U-9 | 上游 429 / 限流阈值 | QPS 上限定值 | OPEN |
| U-10 | `Areainterface` / `Browserlang` 请求头作用 | Adapter 请求头构造 | OPEN |
| U-11 | `materialStatus` / `isRelease` / `localType` 枚举语义 | 无（V1 只存不用） | OPEN |
| U-12 | 空页 / 最后一页返回形状 | 分页终止条件的健壮性（`batch_expected_count` 的末页判定依赖保守规则） | OPEN |
| U-13（新） | `payEpisFrom` 变化与试读资格回收的因果语义 | 无（v0.2 已删自动下架；仅当渠道给出书面合同时才重估） | OPEN，`DOC_CONFIRMED` 前不行动 |
