# src/lib/redirect/

**Owner: Codex（独占写入）**

## 用途

公开跳转码（`public_redirect_code`）的生成与解析。`/go/{public_redirect_code}` 的数据来源。

## 唯一真源

```
src/lib/redirect/public-redirect-code.ts
```

🔴 **全项目唯一的公开短码生成入口。** 禁止任何 Adapter、业务模块或前台自行生成短码。

## 本轮范围

🔴 本轮（P1-04）只建目录，不写实现。当前目录仅含本 README 与 `.gitkeep` 占位。

## 填充任务

由 **P1-08（Auth、Credential、后台 API 和能力位）** 一并落地；`/go` 路由本身在 P2 的推广读取闭环中接线。

## 特别纪律

🔴 **两码必须分离，且公开码永不复用。**

- `upstream_code`（渠道真实推广码）只存内部，**绝不进公开 URL、绝不进埋点表**；
- `public_redirect_code` 是前台唯一暴露的码；
- **全局唯一**：数据库 `UNIQUE` 约束；
- **永不复用**：已分配过的码永不回收再分配，即使原 PromoLink 被软删除或撤回。因此它的唯一索引**不得**是排除软删的部分索引——这与其他表「部分唯一索引排除软删」的通用做法相反，是本字段的特例；
- **不可变**：创建后不重新生成。重跑同步、换执行体、换代理、上游真实码变化，公开码与公开 URL 均不变；
- 同一 PromoLink 只能有一个 active 公开码；
- 生成算法改造自 CPS 已验证的短码模式（字母表 + 强制含数字 + 冲突重试 + DB 唯一约束兜底），搬运时须登记 `docs/governance/port-registry.md`。

理由：公开短码一旦被外部链接、被搜索引擎收录、被埋点记录，复用会导致历史流量被错误归因到新内容。
