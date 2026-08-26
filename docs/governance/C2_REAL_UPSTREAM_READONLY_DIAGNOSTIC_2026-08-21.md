# C2 真上游只读诊断报告（2026-08-21）

## 结论

本次诊断在第一条真实只读请求 `POST /api/v1/res/getlistpc` 收到 HTTP 401 后按协议硬停止。实际请求数为 **1/2**；`getchapterinfo` **未调用**，无重试，未调用 `getbydataid` 或任何写接口。由于未取得目录响应，三个业务问题均无可用样本，禁止据此推断 D-1、推广路线或语言注册表。

| 项目 | 结果 |
|---|---|
| 执行基线 | `feature/v0.2.0-acceptance` @ `d103cf2` |
| parser 版本 | 修复后版本：`chapterID` 使用 `requiredIdentifier`，安全数字可转字符串 |
| `getlistpc` 正式 parser 结果 | `upstream_http_error`；HTTP 401；`retryable=false` |
| `getchapterinfo` 正式 parser 结果 | `NOT_RUN` |
| 实际真实请求 | `getlistpc=1`；`getchapterinfo=0`；合计 `1/2` |
| 硬停止原因 | 上游拒绝凭证（HTTP 401） |
| 上游副作用 | 无；只发出一条授权范围内的只读请求 |

## 三个问题的答案

1. **`chapterID` 形态：未取得证据。** `getchapterinfo` 未调用，因此数字、null、空串、缺失的实际分布均未知。**D-1 技术判断：本次无法判断已合入修法是否在真上游闭环。**
2. **推广四字段：未取得证据。** `getlistpc` 在 HTTP 层被拒绝，`kocCode`、`publicUrl`、`homeLink`、`onlineUrl` 的存在性、类型、null/空串及组合占比均未知；`onlineUrl` 无非 null 样本可标注。**§3.9 技术判断：本次无法在“同步侧脱敏前提取”与“`claimPromo` 端点取证”之间裁定。**
3. **语言枚举：未取得证据。** 没有可报告的 JSON Path、类型分布、null/空串统计或标量枚举值；`UPSTREAM_LANGUAGE_REGISTRY` 不应基于本次执行填写。

## 安全与自测

- 发网前合成自测全部通过：章节五形态分桶（数字/null/空串/缺失/字符串）、推广组合聚合、语言枚举提取、正式 adapter + 正式构造器两请求流程、第三请求拦截、假 JWT 检出、干净目录扫描。
- transport 包装器固定域名、路径、POST 方法、顺序、请求体与 `redirect=error`；正式 adapter 使用 `maxAttempts=1`。
- 凭证文件为仓库外 owner-only 普通文件；正式本地 JWT 校验为 `active` 后立即删除源文件。HTTP 401 后内存引用和相关环境变量在 `finally` 清除。
- Lane B 扫描器发网前扫描与失败后扫描均为 **PASS（0 findings）**；未持久化上游响应、字段值、书名、推广码、链接或凭证。
- 一次性 harness 与临时目录在本报告落盘并完成末次扫描后删除；产品代码、公共 API、类型和数据库均未改动。

## 后续解锁条件

Owner 提供一枚能被上游接受的未过期凭证后，必须按相同隔离方案重新执行；本次已消耗的失败请求不应被描述为三个问题的证据。
