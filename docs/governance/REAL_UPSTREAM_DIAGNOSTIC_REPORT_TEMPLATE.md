# 真实上游诊断 / 验收报告模板

> 适用于每轮真实上游诊断、验收与金丝雀。不得记录 JWT、Cookie、Authorization、密钥、完整凭证指纹、原始响应或推广码/链接值。

## 结论

- RESULT：`PASS | FAIL | PARTIAL | BLOCKED`
- 结论边界：仅陈述本轮已实际请求的坐标与样本；未请求页不得写成零命中。
- 上游副作用：`NONE`；如非 NONE，必须另有 Owner 授权与副作用协议。

## 账号身份（必填）

| 字段 | 值 |
|---|---|
| 身份来源 | `JWT subject/account claim | ChannelAccount.businessId` |
| JWT subject/account claim 名 | `sub | UserId | AccountId | 其他` |
| JWT subject/account claim 值 | `<仅标识，不记录 JWT 或密钥材料>` |
| 小说站 ChannelAccount businessId | `<仅标识>` |
| 独立身份比对 | `PASS | FAIL | NOT_AVAILABLE` |
| scope 证据 | `<实际被 projectType 对应只读端点接受的请求；不得把本地 exp 校验冒充 scope>` |

## 请求坐标（每次请求必填）

| # | Endpoint | Method | page | pageSize | projectType | 其他非敏感坐标 | maxAttempts | 实际 attempts | HTTP/parser |
|---:|---|---|---:|---:|---:|---|---:|---:|---|
| 1 | `<path>` | `<GET/POST>` | `<值或 N/A>` | `<值或 N/A>` | `<值>` | `<agencyId/language/seriesId 仅在授权允许时记录标识>` | `<值>` | `<值>` | `<结果>` |

必须同时记录整轮请求预算、已消费请求数、是否发生重试、是否跟随跳转、429/Retry-After 与硬停止原因。

## 脱敏业务统计

- 返回条数 / 去重条数：`<count>`
- promo 完整 / partial / deferred / missing：`<count>`
- promo 命中率：`<完整命中数 / 合法分母>`
- parser 形态问题：只记 JSON Path、类型和空值形态，不记原值。

## 验收结果

按本轮授权列出真实执行的业务段；未执行必须写 `NOT_RUN` 和前置阻断，不得写 `N/A` 掩盖失败。

## 安全收尾

- 凭证源文件、内存引用与环境变量处理结果。
- 能力位、feature/write 双闸与 worker allowlist 最终状态。
- 敏感模式扫描结果；扫描只输出计数，不输出命中值。
- 待 Owner 后续确认项；非阻塞事项不得被冒充本轮已验证结论。
