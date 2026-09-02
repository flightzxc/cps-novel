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
