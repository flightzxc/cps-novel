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
4. readback 页面未包含目标 `seriesId`、readback 失败或 claim/readback code 不一致时，
   进入 manual review；不得重 POST。

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
