# MoboReader 小说 Promo Claim 合同冻结（Book A）

## 1. 结论

`CANARY_WRITE_PROVEN`：小说 `projectType=1` 真实页面复用
`POST https://kocserver-cn.cdreader.com/api/v1/res/getcode` 生成推广资源。
网页在 mutation 成功后使用 `POST /api/v1/res/getlistpc` 做列表 readback，
本次没有调用 `getvideoinfo`。

上游重复 `getcode` 的幂等语义仍为 `UNVERIFIED`。因此实现固定为：
`getcode` 最多一次；timeout/reset/abort/响应歧义后只允许 readback，禁止自动再次 POST。

## 2. 身份与 Book 隔离

- 账号登录标识：`chenweifeng2020@qq.com`
- JWT `UserId` / 本地 `ChannelAccount.businessId`：`88fcfefdfac246d48408c72b749f5272`
- JWT 密钥材料：未记录
- Book A：`While My Husband Cheated, I Married His Powerful Brother`
- Book A `seriesId`：`124235322`
- Book A 纪律：永久不得用于 `ONE_BOOK_PROMO_CLAIM_SMOKE`
- Book B：另选，必须与 Book A 的 `seriesId` 不同；本报告未触碰 Book B

## 3. T0 与唯一 mutation

- 取证时间：2026-08-31 22:07:06–22:07:07（Asia/Tokyo）
- T0 页面状态：Book A 显示“生成推广资源”，没有现成 promo
- mutation 次数：`1`
- retry 次数：`0`
- endpoint：`/api/v1/res/getcode`
- method：`POST`
- HTTP：`200 OK`
- redirect：未发生
- 请求体：

```json
{
  "agencyId": 3366,
  "seriesId": "124235322",
  "projectType": 1,
  "language": 3
}
```

- 凭证头：`Authorization: Bearer <not recorded>`
- 页面上下文头：`AreaInterface: cn`、`Browserlang: cn`
- 响应 envelope：`status=true`、`code=200`、`message=操作成功`
- 响应 data 字段：`kocCode`、`publicUrl`、`homeLink`、`promotionalText`、
  `onlyTikTok`、`showDeepLink`、`deepLink`、`isVip`、`needShowVip`、`onlineUrl`
- promo：`[redacted_code:length=6]`
- URL host：`eng.moboreader.com`
- 页面终态：Book A 显示小说链接、App 链接、口令及生成时间

## 4. Readback 合同与请求坐标

> 本节保留 2026-08-31 页面观察的历史坐标。生产 exact-target 实现不得使用
> 空 `name`；已由本文 §9 和
> `MOBOREADER_PRECISE_READBACK_PROBE_2026-09-02.md` §11–§12 取代。

- endpoint：`/api/v1/res/getlistpc`
- method：`POST`
- HTTP：`200 OK`
- 请求坐标：`page=1 / pageSize=10 / projectType=1`
- 完整请求体：

```json
{
  "name": "",
  "orderType": 1,
  "pageIndex": 1,
  "projectType": 1,
  "pageSize": 10
}
```

readback 返回的 Book A 行包含相同 `kocCode`、`publicUrl`、`homeLink` 与
`promoCreateTime`，因此本次 mutation 结果已由独立读路径确认。

## 5. 安全实现约束

1. 正常路径：pre-read → durable intent → fenced ownership check → 单次
   `getcode` → readback → fenced transaction 原子写入 PromoLink、Article binding
   与 `SideEffectIntent.confirmed`。
2. `prepared`、`claim_retry_blocked` 及旧版本遗留的
   `confirmed-but-no-PromoLink` 一律只走 readback；不得再次调用 `getcode`。
   `manual_review_required` 对通用 worker 是终态：不再调用上游，也不得自动改回
   `confirmed`，只能进入 X9 专用裁决边界。
3. lease/fence loss 必须进入外部调用的 `AbortSignal`。本地 abort 不证明上游未收到
   mutation，结果仍按 ambiguous → readback/manual review 处理。
4. exact-target readback 未取得完整候选集中的唯一四维匹配行、readback 失败或
   claim/readback code 不一致时，进入 fail-closed/manual-review 分支；不得重 POST。

## 6. 审计元数据

- CPS SOP ACK：`c4bd2ffefd7539e3f98ac8994f5bec291c9f7e05293f64d5987d6a8da97b821a`
- 真实上游 mutation：1 次（Book A `getcode`）
- 真实上游 readback：1 次（`getlistpc`）
- claim/getcode 之外的生产写动作：0
- raw token、JWT、完整 Authorization header、HAR：未写入仓库

## 7. 安全修复复核

- lease/fence loss 会中止 handler 的外部调用 signal；mutation 发出后的 abort 仍按
  ambiguous 处理。
- PromoLink、Article binding 与 `SideEffectIntent.confirmed` 现在由同一个 fenced
  transaction 提交，不再存在 confirmed 先于业务写入的 crash window。
- `prepared` / `claim_retry_blocked` 的后续执行只允许 readback；claim handler 注册
  的 `maxAttempts=1`，上游 getcode 无自动 retry。
- TypeScript 类型检查通过。
- 完整 hermetic backend：`126 files / 1175 tests` 通过；新增 manual-review 隔离测试后，
  promo/worker/X9 定向集：`9 files / 90 tests` 通过。

## 8. Book B Smoke 状态

`ONE_BOOK_PROMO_CLAIM_SMOKE_PASSED`（2026-09-01）。Book B
`seriesId=118274322`，与 Book A 不同；真实上游预算固定并实际消费为
`getlistpc 2 + getcode 1`，mutation attempt `1`、retry `0`。领取后 readback 确认
PromoLink 为 `fetched/claimed`，第二任务通过本地 short-circuit 完成且没有新增上游
请求。详情见 `docs/operations/ONE_BOOK_PROMO_CLAIM_SMOKE_2026-09-01.md`。

`BOOK_A_RESERVED_FROM_SMOKE=true`

## 9. Exact-target readback 补丁（2026-09-02）

P-5/P-6 已证明 `getlistpc.name` 是宽泛子串匹配。实现合同因此写死：

- `title = MUTABLE LOCATOR, NOT AUTHORITY`：`name` 取当前
  `NovelSourceItem.title`，只定位候选；确认只看
  `{agencyId, seriesId, language, projectType}`；
- P-10 以大结果查询和 `pageSize=100` 实际收到 100 行，生产
  `MAX_CANDIDATES=100`；每次读取必须断言
  `Array.isArray(list) && list.length === totalCount && totalCount <= MAX_CANDIDATES`；
- 完整候选集中恰好一行四维全匹配才接受；0 匹配是 `target_missing`，多匹配是
  `identity_not_unique`；任一候选缺任一身份字段都是 `identity_field_missing` 并 fail closed；
- `totalCount=0` 不是 promo 未生成。公共精确读取器重读一次当前目录标题并只重试一次；
  仍为 0 是 `locator_stale` 并转人工；
- 所有候选集不完整、字段缺失或身份非唯一分支都记录安全计数并 fail closed；禁止分页
  回退，禁止以 `name` 命中或标题相等作为身份证据。

P-7 多语种行为保持 `CONTRACT_EVIDENCE_GAP`。`expected.language` 始终来自 claim 请求；
响应若缺 `language` 会使全量读取 fail closed，最坏结果是全部领不到、不会错领。排查该
现象应先检查上游响应身份字段。完整 P-8/P-9/P-10 证据、结果型与标题新鲜度规则见精确
readback 探针报告 §10–§12。

## 10. Step 4：bounded read-only retry 与 readback-only recovery（2026-09-02）

生产读取显式分为两层，并由 pre-read、post-claim 与 recovery 共用：

1. **瞬时/可见性层（一个 title 坐标内）**：每次 adapter 调用只发一次
   `getlistpc`。只读 408/429/5xx、timeout/network 按
   `PROMO_LINK_CLAIM_LIMITS.readback` 有界重试；post-claim/recovery 的 promo 尚不可见，
   以及 post-claim 读到旧 code，也在同一只读预算内重试。pre-read 的 `missing` 是允许
   claim 继续的业务事实，不作为瞬时失败重试。
   这里的 post-claim 可见性延迟严格限定在**同一 ChannelAccount、同一凭证上下文**：
   mutation 后该账号的 `getlistpc` 可能暂时尚未显出新 code，因而只读重试。历史上“同一本
   书由不同账号领取会得到不同 code”是账号隔离语义，不是可见性延迟；不得跨账号比较、
   接受或据此放宽 code 确认。
2. **标题漂移语义层**：`totalCount=0/title_no_match` 才会从
   `NovelSourceItem.title` 刷新 locator，并以新 title **只重试一个坐标**。该坐标仍套用
   上述有界只读策略；第二次仍为 0 则返回 `locator_stale`。语义重试不消耗、不触发
   `getcode`。

运行时参数为 `PROMO_LINK_CLAIM_READBACK_ATTEMPTS` 与
`PROMO_LINK_CLAIM_READBACK_INTERVAL_MS`：CPS v8.3.6 parity 的发布缺省为 3 次/2000ms；attempts
双向 clamp 到 1–5，interval 双向 clamp 到 0–30000ms，非整数配置 fail closed。
Worker task 注册仍为 `maxAttempts=1`，因此这不是 mutation task retry；`getcode` 在任一路径
始终最多发一次。

结构性结果（候选集不完整、身份字段缺失、四维 0/多匹配、malformed/non-retryable
响应）不因重复读取而变安全，故立即 fail closed。对可重试的只读错误、post-mutation
promo 不可见或 code 尚未收敛，只有耗尽相应坐标的只读预算后才允许进入
`manual_review_required`。已有 manual terminal 保持零上游 I/O；prepared/
claim_retry_blocked/legacy-confirmed 只允许 readback recovery，永不再发 `getcode`。

SideEffectIntent 的 prepared/blocked/manual 状态机、mutation 前 heartbeat 与
AbortSignal、fenced finalize，以及 PromoLink + Article binding + intent confirmed 的同一
fenced transaction 均保持不变。

Step 4 hermetic 验收：TypeScript 与定向 ESLint 通过；Claim/worker/runtime 定向集
`9 files / 120 tests` 通过。故障注入覆盖只读 408/429/503、deadline、post-claim
可见性耗尽、旧 code 后收敛、标题漂移后 503、ambiguous getcode 后仅 readback 恢复、
prepared intent 恢复预算耗尽，以及 retry wait 中 lease signal abort。所有相关断言均保持
`getcode <= 1`；本轮未执行 S-1 或 Book C。
