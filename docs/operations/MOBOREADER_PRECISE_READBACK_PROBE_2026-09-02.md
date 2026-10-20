# MoboReader 精确 Promo readback 只读合同探针

## 1. 结论

```text
PRECISE_READBACK_ENDPOINT = getlistpc_name_filter
```

对已存在 `fetched/claimed` PromoLink 的 Book B 执行 4 次生产上游只读请求后：

- `getvideoinfo` 的成功 HTTP 响应没有可检查的 `data` record，六个 promo 相关键均为
  `KEY_ABSENT`。
- `getbydataid` 返回空 `data.list`，六个 promo 相关键均为 `KEY_ABSENT`。
- `getlistpc + Book B 完整标题` 的服务端结果收敛为 1 行，`data.totalCount=1`；唯一行的
  `seriesId/agencyId/projectType/language` 均与目标匹配，且存在 promo 键。
- 因此本轮没有证明逐作品 `getvideoinfo` 或 `getbydataid` promo readback；证明了
  `getlistpc.name` 可在本样本上服务端过滤并唯一命中。后续冻结合同仍必须对返回行做
  `seriesId + agencyId + projectType + language` 严格身份校验，不能只信标题。
- P-5 证明 Book B 的严格前缀仍命中；P-6 的短常见词 `the` 命中
  `totalCount=21035`，返回的首 200 行中有 123 行仅在标题中部包含该词。
  因此 `name` 的行为是宽泛子串匹配，不是精确匹配。
- 本地 `NovelSourceItem` 无同标题或同 `seriesId` 且
  `sourceLanguageCode` 不同的行；P-7 未发上游请求，登记为
  `CONTRACT_EVIDENCE_GAP`，不用单语种样本推断多语种行为。
- P-8 的低基数子串在 `pageSize=15` 下返回 `2/2`，P-9 同词改为
  `pageSize=100` 后仍返回 `2/2`；两次 `totalCount` 稳定，完整性判断均由
  `list.length === totalCount` 成立，不以请求的 `pageSize` 代替证明。
- P-10 无条件执行：短常见词 `the`、`pageSize=100` 返回 `100/21048`，证明服务端
  实际兑现 100 行，同时在真实响应上触发 `list.length !== totalCount` 的截断守卫。
  生产 `MAX_CANDIDATES` 因而冻结为本次同构路径已验证的 100；这不是对服务端绝对硬顶
  的主张，而是生产一次读取允许承重的已验证上限。

本补丁已冻结并落地“`name` 定位完整候选集、四维身份选定唯一目标”的 fail-closed
守卫与测试；D-1 业务施工仍未开始。

## 2. 基线、运行真身与身份

| 项目 | 结果 |
|---|---|
| 海阅审计基线 | `e9ee680`，工作树在探针前干净 |
| 实际运行镜像 revision | `80c12d8`，为 `e9ee680` 的直接父提交 |
| 相关代码差异 | `moboreader.ts`、credential crypto/解析链在两 revision 间无差异 |
| DB role | `worker_app` |
| ChannelAccount id | `45e89c67-b160-4ae6-95e3-c85f98b5a010` |
| ChannelAccount 槽位 | `2` |
| active credential 槽位 | 唯一 active credential |
| JWT identity 对 ChannelAccount business identity | `MATCH` |
| `FEATURE_PROMO_LINK_CLAIM` | `false` |
| `PROMO_LINK_CLAIM_ALLOW_WRITE` | `false` |
| `claimPromo` capability | `registered_disabled` |

Credential 由正式 ChannelAccount lifecycle resolver 选择，经 worker 正式解密与本地 JWT
校验链读取。报告和命令输出均未记录 JWT、凭证密文、Authorization 值或 fingerprint。

## 3. 三态口径

```text
KEY_ABSENT           键不存在
KEY_PRESENT_REDACTED 键存在且非空；原值不记录
KEY_PRESENT_EMPTY    键存在，但为 null/空值
```

探针仅在内存中把原始响应立即投影为字段名、身份匹配结果和上述三态；未输出、落盘或保留
任何 promo 字段值，也未记录完整目标 URL。

## 4. 请求账本

| Probe | Endpoint | 坐标 | attempts | HTTP | 结果 |
|---|---|---|---:|---:|---|
| P-1 | `/api/v1/res/getvideoinfo` | `agencyId=3366, seriesId=118274322, projectType=1, language=3` | 1 | 200 | 响应顶层键：`code/data/message/status`；无 `data` record |
| P-2 | `/api/v1/material/getbydataid` | `agencyId=3366, dataId=118274322, projectType=1, language=3, materialType=1` | 1 | 200 | `data` 键：`list/quotaInfo/totalCount`；`list` 0 行 |
| P-3 | `/api/v1/res/getlistpc` | `name=<Book B 完整标题>, orderType=1, pageIndex=1, pageSize=10, projectType=1` | 1 | 200 | 1 行、目标唯一命中、`totalCount=1` |
| P-4 | `/api/v1/res/getlistpc` | `name="", orderType=1, pageIndex=2, pageSize=10, projectType=1` | 1 | 200 | 10 行、`totalCount=97096`、Book B 不在该页 |

```text
READ_REQUESTS = 4/4
MUTATION_REQUESTS = 0
GETCODE_REQUESTS = 0
RETRIES = 0
MAX_ATTEMPTS = 1
REDIRECT = error
```

Transport 守卫只允许上述四个实际路径/坐标。另做了一次本地 fail-closed 自测：
`/api/v1/res/getcode` 在真实 `fetch` 前抛 `getcode_forbidden`；该自测没有产生上游请求。

P-2/P-3/P-4 直接使用生产 `createMoboreaderReadAdapter(maxAttempts=1)`。基线没有暴露
`getvideoinfo` 方法，P-1 因而复用同一 adapter 的生产 POST/auth/timeout/redirect 请求构造，
并在一次性内存 routing guard 中仅把已校验的 `getchapterinfo` 逻辑路径改写为 allowlist 内
的 `getvideoinfo` 实际路径；请求体仍由 adapter 生成。实际网络未调用 `getchapterinfo`，
也没有使用 curl、浏览器或另造 HTTP 客户端。

## 5. Promo 键三态

### P-1 `getvideoinfo`

| 键 | 三态 |
|---|---|
| `kocCode` | `KEY_ABSENT` |
| `publicUrl` | `KEY_ABSENT` |
| `homeLink` | `KEY_ABSENT` |
| `onlineUrl` | `KEY_ABSENT` |
| `promoUrl` | `KEY_ABSENT` |
| `promoCode` | `KEY_ABSENT` |

响应没有 `data` record，因此也没有可用于严格 readback 的
`agencyId/seriesId/projectType/language` identity echo。

### P-2 `getbydataid`

| 键 | 三态 |
|---|---|
| `kocCode` | `KEY_ABSENT` |
| `publicUrl` | `KEY_ABSENT` |
| `homeLink` | `KEY_ABSENT` |
| `onlineUrl` | `KEY_ABSENT` |
| `promoUrl` | `KEY_ABSENT` |
| `promoCode` | `KEY_ABSENT` |

`data.list` 为空，没有目标 record 或 identity echo。

### P-3 `getlistpc + name`

| 键 | 三态 |
|---|---|
| `kocCode` | `KEY_PRESENT_REDACTED` |
| `publicUrl` | `KEY_PRESENT_REDACTED` |
| `homeLink` | `KEY_PRESENT_REDACTED` |
| `onlineUrl` | `KEY_PRESENT_EMPTY` |
| `promoUrl` | `KEY_ABSENT` |
| `promoCode` | `KEY_ABSENT` |

唯一返回行包含 identity 键 `agencyId/seriesId/projectType/language`，四项均为 `MATCH`。

## 6. `name` 过滤与分页

```text
GETLISTPC_NAME_SERVER_FILTER = PROVEN_FOR_BOOK_B
GETLISTPC_NAME_UNIQUE_TARGET = YES
GETLISTPC_PAGE_2_AVAILABLE = YES
PAGE_1_VS_PAGE_2_STABLE_NONOVERLAP = NOT_PROVEN_BY_THIS_BUDGET
```

P-3 返回 1 行且 `totalCount=1`，并唯一命中 Book B，足以证明本次完整标题查询由服务端
过滤，而非返回默认首页后再由客户端过滤。P-4 的空 `name` 第 2 页返回 10 行，证明该
页坐标可用；P-3 与 P-4 的 seriesId 集合重叠数为 0。

但 P-3 与 P-4 的 `name` 坐标不同，因此该零重叠不能升级成“同一空 `name` 查询下第 1
页与第 2 页稳定不重叠”的强结论。本轮预算已耗尽，未追加扫描。

## 7. 既有 P0 报告重新认定

`cps-admin/reports/P0_BROWSER_INTERFACE_PROBE.md` 的证据路径是 Owner 的 Microsoft Edge
生产会话。其 §10 明确写明响应体是在 DevTools 内存中检查；探测窗口为 2026-08-01，
而海阅 `src/lib/adapters/moboreader.ts` 首次提交于 2026-08-08。

因此，旧报告 §6 对 `getvideoinfo(projectType=1)` 的字段观察来自原始浏览器响应，不是
经过 `safeEvidenceValue` 的脱敏适配器输出，旧结论不存在“键被保留但因值为
`[redacted]` 而误判缺失”的路径。本轮在已知有 promo 的 Book B 上用三态口径复测，
`getvideoinfo` 六个 promo 键仍全部为 `KEY_ABSENT`；以本轮结果为准。

## 8. 零写入与下一步边界

- 未创建 task、未写 PromoLink、未写 NovelSourceItem、未创建或变更 SideEffectIntent。
- Book B 的 NovelSourceItem 与 PromoLink 状态/更新时间在探针前后不变。
- 双闸与 `claimPromo=registered_disabled` 在探针结束时保持关闭。
- 不再追加分页扫描；本轮在 `getlistpc_name_filter` 已取得可接受的次优精确定位证据。
- exact-target readback contract 已按下节冻结；本报告不包含 D-1 业务施工。

## 9. P-5/P-6/P-7 扩展探测

执行入口：`scripts/p0-2-precise-readback-extension-probe.ts`。正式 read adapter
固定 `maxAttempts=1`，transport 只允许 `POST /api/v1/res/getlistpc`，其他路径在
`fetch` 前停止。双闸为 false，`claimPromo=registered_disabled`。

| Probe | `name` | 实际请求 | `totalCount` | 返回行 | 结论 |
|---|---|---:|---:|---:|---|
| P-5 | Book B 严格前缀（删除末尾单词） | 1 | 1 | 1 | Book B 仍返回；排除精确匹配 |
| P-6 | 短常见词 `the` | 1 | 21035 | 200/200 | 77 行以该词开头，123 行仅在中部包含；证明子串匹配 |
| P-7 | 本地多语种候选 | 0 | N/A | N/A | `CONTRACT_EVIDENCE_GAP`: 本地无可构造样本 |

```text
EXTENSION_READ_REQUESTS = 2/3
MUTATION_REQUESTS = 0
GETCODE_REQUESTS = 0
RETRIES = 0
MAX_ATTEMPTS = 1
P6_REQUESTED_PAGE_SIZE = 200
P6_RETURNED_COUNT = 200
P6_TOTAL_COUNT = 21035
```

P-6 请求的 200 行全部返回，未观察到低于 200 的服务端单页硬上限；
但结果集按 `pageSize=200` 截断，还有 20835 行未返回。本轮不追加分页。

## 10. P-8/P-9/P-10 候选容量探测

执行入口：`scripts/p0-3-readback-candidate-capacity-probe.ts`。三次请求均使用正式 read
adapter、`maxAttempts=1`；transport 仅允许按固定顺序调用
`POST /api/v1/res/getlistpc`，双写闸保持关闭。

| Probe | `name` | `pageSize` | `totalCount` | 返回行 | `list.length === totalCount` | 结论 |
|---|---|---:|---:|---:|---|---|
| P-8 | 低基数子串 `dragonless` | 15 | 2 | 2 | true | 落在预期 5–15 之外但仍是有效证据；完整候选集可一次取得 |
| P-9 | 与 P-8 相同 | 100 | 2 | 2 | true | 低基数结果不能单独证明服务端兑现 100；与 P-8 的 `totalCount` 稳定 |
| P-10 | 短常见词 `the` | 100 | 21048 | 100 | false | 服务端兑现 100；真实触发候选集截断检测 |

```text
CANDIDATE_CAPACITY_READ_REQUESTS = 3/3
MUTATION_REQUESTS = 0
GETCODE_REQUESTS = 0
RETRIES = 0
MAX_ATTEMPTS = 1
MAX_CANDIDATES = 100
```

P-10 是本轮 `MAX_CANDIDATES` 的确定依据：只有它的 `totalCount` 明显大于 100，才能
证明一次响应确实交付了所请求的 100 行。P-8/P-9 的 2 行结果不能承担这一结论。
P-10 同时证明生产必须逐次检查完整性；若生产标题定位产生超过 100 个候选，该次读取
必须 fail closed 并转人工，禁止翻页拼接。

## 11. 冻结的 exact-target readback 合同

> **`name` 负责定位，四维身份负责确认。**

1. `title = MUTABLE LOCATOR, NOT AUTHORITY`。`name` 固定取当前目录行
   `NovelSourceItem.title`，只用于收窄候选；响应标题永远不参与确认。
2. 请求只取 `pageIndex=1`、`pageSize=MAX_CANDIDATES=100`。每次调用都必须执行：

   ```text
   complete <=> Array.isArray(list)
                && list.length === totalCount
                && totalCount <= MAX_CANDIDATES
   ```

   不完整即 `ambiguous/candidate_set_incomplete`，记录 `totalCount/returnedCount` 后
   fail closed。禁止信任服务端会兑现 `pageSize`，禁止翻页拼接。
3. 只有完整候选集才可进入身份选择。每一行必须具有非空、合法的
   `agencyId / seriesId / language / projectType`；任一行缺任一字段即
   `ambiguous/identity_field_missing`，整次 fail closed。
4. 四维全匹配行恰好 1 条才接受。匹配 0 条是
   `target_missing/identity_no_match`，表示完整候选集中目标缺失；匹配多于 1 条是
   `ambiguous/identity_not_unique`，表示四维唯一性异常并进入人工。
5. 已选定的唯一目标行 `kocCode` 为空才是 `missing`（promo 尚未生成）。它不得与
   `totalCount=0`、`target_missing` 或候选集不完整混同。
6. P-7 保持 `CONTRACT_EVIDENCE_GAP`。`expected.language` 来自 claim 请求且必有值；
   如果响应行缺少 `language`，第 3 条会让整次 fail closed。**若上游对所有行移除
   `language`，结果将是所有 claim 均 fail closed、全部领不到，而不是错领。** 排查时应先
   检查上游响应身份字段，而不是先怀疑 claim mutation。

## 12. 标题改名恢复路径

- pre-read、post-claim readback 与 prior-intent readback-only recovery 共用同一个读取器。
- 任一次首次读取 `totalCount=0` 时，读取器从 DB 重新读取该行当前
  `NovelSourceItem.title`，只替换 mutable `name`，四维 expected identity 保持不变，随后
  **只重试一次**。
- 重试仍为 0 时返回 `target_not_located/locator_stale` 并转人工；不得把它解释为 promo
  尚未生成。刷新后的完整候选集中无四维匹配则返回
  `target_missing/identity_no_match`，与 `locator_stale` 分开计量。
- 标题为空或目录行已不可用时在 mutation 前 fail closed；mutation 已可能发出或存在
  prior intent 时，任何未确认结果都沿既有 manual-review 路径处理，绝不再次调用
  `getcode`。

实现对应 `src/lib/adapters/promo-link-claim.ts` 与
`worker/handlers/promo-link-claim.ts`；定向测试覆盖完整多行候选中唯一四维命中、0 命中、
多命中、四个字段逐项缺失（含 `language`）、截断/非数组响应、标题单次刷新、刷新后仍为
0，以及不回退到第 2 页。

## 13. 2026-09-11 修订（Owner 解冻）

本节修订第 11 节第 2 条的完整性判据（`complete <=> list.length === totalCount && totalCount
<= MAX_CANDIDATES`）。第 11 节其余各条（1/3/4/5/6）与第 12 节标题改名恢复路径**一字不
动**，仍是现行合同。

### 13.1 P-7 缺口如何被填上

第 9 节 P-7（本地多语种候选）当时登记为 `CONTRACT_EVIDENCE_GAP`：探针执行时本地没有
可构造的多语种候选样本，未对非英语标题发过一次 `getlistpc`。这个缺口在两步之后被真实
填上，而非靠推断关闭：

1. **X8 轮 2b（2026-09-11，build `f696519`，真实 apply claim）**：对 ar/de/es 三个
   非英语 `NovelSourceItem`（`novel_source_item.id` 分别为
   `3f479661-7681-4a40-9e40-008b69f3c2aa`、`3d722327-949d-447a-b7a3-28c93659496d`、
   `50a2e21b-3ada-4127-a39b-b0de8a221d18`）各执行 1 次真实 `createPromoLinkClaimTask`，
   三语种 100% 同形失败于 readback 阶段：`claim_readback_ambiguous /
   candidate_set_incomplete`（`totalCount=1` 但 `list.length` 分别为 `11/14/12`）。
   `promo_link` 表三语种均 0 行——claim 从未推进到 `getcode`，本轮只是**发现**了 P-7 的
   真实形状，没有以任何方式绕过第 11 节的双闸或 mutation 冻结。
2. **只读探针（同日，对象 HEAD `c9bf7e2`）**：对轮 2b 同三本各追加 1 次只读
   `getlistpc`（`createPromoLinkClaimAdapter().readPromoAfterClaim`，`worker_app` 角色，
   全程未调 `.claimPromo()`/`getcode`，零 DB 写），坐标与生产
   `readPromoAfterClaim`（`promo-link-claim.ts:40-44/353-357`）完全一致；另各加 1 次
   `name=seriesId` 变体。

   | locale | totalCount | list.length | 四维命中行数 | 命中行标题=目标 |
   |---|---:|---:|---:|---|
   | ar | 1 | 11 | 1 | 是 |
   | de | 1 | 14 | 1 | 是 |
   | es | 1 | 12 | 1 | 是 |

   三本 `distinctReturnedAgencyIds=1`（全簇同一 agency）、
   `distinctReturnedSeriesIds=returnedCount`（每行不同 `seriesId`=不同语种版本）；
   `agencyId+seriesId+language+projectType` 四维联合在全部 6 次请求（含 `name=seriesId`
   变体）都恰好选中 1 行，且该行标题前 20 字符与本地目标一致。`name=seriesId` 变体与
   `name=title` 返回**完全相同**的行集合——判 `NOT_SUPPORTED`：`getlistpc.name` 不支持按
   id 精确检索，不能作为按 id 定位的替代坐标。

   结论：`getlistpc` 的 `totalCount` 按**书**计一次（该 agency 下同一部作品只算 1），但
   `list` 按**书 × 语种版本**展开（该 `seriesId` family 下每个已上线语言各一行）——三本
   returnedCount(11/14/12) 均对应该 agency 名下已发行的语言版本数，不是异常膨胀，也不是
   分页截断的证据；三次请求 `returnedCount` 均 `< 100 = pageSize`，未被截断。第 11 节旧
   判据要求 `list.length === totalCount`，把这个正常形状误判为
   `candidate_set_incomplete`，导致三语种 claim 100% 假性失败。

### 13.2 守卫改法

`src/lib/adapters/promo-link-claim.ts` 第 186–196 行（`parseReadbackResponse` 内部）：

- 改前：`complete <=> Array.isArray(list) && list.length === totalCount && totalCount <=
  MOBOREADER_PROMO_MAX_CANDIDATES`。
- 改后：`complete <=> Array.isArray(list) && list.length < MOBOREADER_PROMO_MAX_CANDIDATES`
  （严格小于 pageSize=100，即"结构性未截断"）。`list.length >= pageSize` 仍判
  `ambiguous/candidate_set_incomplete`（无法排除截断，禁止翻页拼接，与第 11 节第 2 条后半
  一致）。
- `totalCount` 不再是完整性的硬条件，但在每条分支上仍被记录（`totalCount`/
  `returnedCount` 字段，即本节的 `declaredTotalCount`/`returnedCount` 概念）供审计——这两
  个字段本就是 `ReadPromoAfterClaimResult` 既有结构的一部分，未新增/未改名，只是
  `totalCount` 从"門檻"降级为"仅记录"。
- 第 11 节第 3/4 条（完整候选集内的四维身份字段完整性校验与恰好 1 条匹配）与
  `target_missing`/`identity_not_unique` 语义**一字不动**：候选集合"完整"后仍必须四维
  精确匹配收敛到唯一 1 行才 `found`；0 命中仍 `target_missing/identity_no_match`；
  ≥2 命中仍 `ambiguous/identity_not_unique`。翻页拼接、放宽四维校验、跳过身份字段完整性
  检查均不在本次修订范围内，且被红线明确禁止。

### 13.3 与 CPS `getvideoinfo` 点查机制的差异（合理偏离）

CPS（`changdu-getvideoinfo.ts`，参照基线 `3a76877`）对短剧（`projectType=2`）用
`getvideoinfo` 做直接点查：`fetchOnce`（364–391 行）以
`{agencyId, seriesId, projectType: CHANGDU_VIDEOINFO_PROJECT_TYPE(=2), language}`
（386–389 行）一次 POST 命中单一目标行，不经过候选列表、不需要四维筛选——上游对
`projectType=2` 的 `getvideoinfo` 承载完整 promo record。

海阅（`projectType=1`）不具备这条路径：第 5 节 P-1 探针已证明，同一 `getvideoinfo`
端点对 `projectType=1` 的成功 HTTP 响应没有可检查的 `data` record，六个 promo 相关键
（`kocCode`/`publicUrl`/`homeLink`/`onlineUrl`/`promoUrl`/`promoCode`）全部
`KEY_ABSENT`（§5 P-1）——即该上游端点不为 `projectType=1` 承载 promo 数据，点查机制在
小说线不可用。海阅只能退回 `getlistpc` 候选列表 + 四维精确匹配的读回路径，且必须处理
候选集合"书 × 语种版本"展开这一 `projectType=2`（单语种短剧）不会遇到的形状。这是上游
API 本身对两个 `projectType` 的能力差异，不是本仓选择绕开 CPS 既有机制；已在
`docs/governance/port-registry.md` 登记 N-14，判 `JUSTIFIED_DEVIATION`。

## 14. 2026-10-20 修订（Owner 批准）：改用 getvideoinfo 精确回读

### 14.1 为什么改

领推广码前后，系统要先在上游确认目标书、看有没有码。旧做法是按书名调 `getlistpc` 搜索，只读第 1 页
（100 行）。书名短或常见（例如 "MINE"、"Love"）时，上游模糊匹配会返回几百到几千行，第 1 页装不下，
被判为 `candidate_set_incomplete`，这些书就一直领不到码（生产上约 53 本）。书名只是"可变的定位线索"，
却成了领码能否继续的关键路径，这个设计本身就有问题。

CPS 短剧（同一个畅读上游）的做法是调 `POST /api/v1/res/getvideoinfo`，按编号精确查一本，不依赖书名，
也没有候选集合。§13.3 当时判断小说线（`projectType=1`）用不了这条路径，依据是 09-02 的 P-1 探针
（六个 promo 键全部 `KEY_ABSENT`）。今天的复测推翻了这个前提。

### 14.2 复测证据

2026-10-20，Owner 批准了一次生产只读复测：共 3 次只读请求，**0 次 getcode**（没有任何写操作）。
原始记录在仓库外：`产品原型及文档/cps海阅/证据_getvideoinfo小说复测_2026-10-20/`（这里只引用路径，不复制内容）。

- 对 MoboReader 一本已有码的小说书，`getvideoinfo` 返回 `data` 对象；`agencyId / seriesId /
  language / projectType` 四项身份回显与请求逐项一致；返回的码和网址与本地已领到的记录一致。
- MINE（过去因书名过短而卡住的书）：上游其实已经有码，可以直接读到。
- PlotNovel 口令码剧场的书：有 `kocCode`，但 `publicUrl / homeLink / onlineUrl` 都是空。
  口令码剧场本来就不发网址，所以"没有网址"不是异常。
- 09-02 的 P-1 现象（成功响应但没有 `data` record）这次没有复现。推测与当时借用目录适配器的
  请求构造有关，**原因未确定**。因此请求形状被锁死为今天复测通过的形状（见 14.3），不允许
  随意增删字段或请求头。

### 14.3 新合同

请求：`POST /api/v1/res/getvideoinfo`，请求头只带 `authorization: Bearer <token>` 与
`content-type: application/json`（不带 `areainterface` / `browserlang`），请求体键恰好 4 个：
`{ agencyId: number, seriesId: string, projectType: number, language: number }`。
`agencyId`、`language` 取自书目行 `rawPayload`，转成安全整数；`seriesId` 转成字符串；`projectType`
取渠道应用（`channel_app.project_type`）。任何一项无法转换，在发出任何请求之前以
`claim_source_fields_missing` 失败。`getcode` 的请求体、请求头、错误分类完全不变。

判定规则：

1. 外层不是 `status === true && code === 200`，或 `data` 不是普通对象：抛
   `malformed_payload`（非歧义、不可重试），与以前回读解析失败的分类一致。
2. `data` 里的四项身份必须全部存在且非空，并与请求逐项相等（按字符串比较）：
   任一项缺失 → `ambiguous / identity_field_missing`；任一项不一致 → `ambiguous / identity_mismatch`。
3. 口令码 `kocCode` 去空白后非空 → `found`（`webUrl = publicUrl ?? homeLink`，`appUrl = homeLink`）。
   **不要求有网址**——这是与 CPS 的一处刻意差异（CPS 要求必须有 `publicUrl`），否则 PlotNovel
   这类只有码的书会永远读不到。
4. `kocCode` 为空或缺失 → `missing`（码还没生成）。

领码前确认（pre-read）、领码后核对（post-claim confirmation）、异常恢复（readback-only recovery）三处
共用这一套读法。有限重试策略（可重试读错误；领码后 `missing` 或码不一致时重试）保持不变；
`getcode` 仍然绝不重复调用，领码后码必须与 `getcode` 返回一致，不一致仍进人工复核。

限速：`getvideoinfo` 作为"未跟踪（untracked）端点"走现有限速门——按端点限速关闭时用共享间隔
`MOBOREADER_UPSTREAM_MIN_REQUEST_INTERVAL_MS`；开启时用 `defaultIntervalMs` 加主机间隔。没有新增环境变量。

### 14.4 删除了什么（不留兼容层，也不保留 getlistpc 回退）

- 请求里的 `name`、`MOBOREADER_PROMO_MAX_CANDIDATES`、`MOBOREADER_PROMO_READBACK_COORDINATE`。
- 候选集完整性判定与 `candidate_set_incomplete`、`identity_not_unique`；`target_not_located`、
  `target_missing` 两个结果状态；回读结果里的 `totalCount / returnedCount`。
- handler 里"标题为 0 行 → 重读 DB 标题 → 再试一次 → `locator_stale`"的流程，以及 claim 前
  "标题为空就失败"（`claim_readback_title_unavailable`）的检查。
- 失败证据里的 `readbackTotalCount / readbackReturnedCount`。历史失败行里旧错误码
  （`claim_readback_title_unavailable / locator_stale / target_not_located / target_missing`）仍保留
  后台中文展示文案，仅供显示历史数据，新代码不再产生。

### 14.5 与旧节的关系

§11 第 1、2 条（标题作为定位线索、`getlistpc` 取第 1 页 100 行并做完整性判断）与 §12（标题改名恢复路径）
由本节取代。§11 第 3–6 条的"四维唯一身份"精神保留，改写为"回显四维必须全部一致"：
四项缺一不可、逐项相等，缺失或不一致都 fail closed 为 `ambiguous`，绝不放宽。
§13 的"候选集合完整性"修订随 `getlistpc` 回读一并失去适用对象。旧各节正文一字不改，保留为历史记录。
