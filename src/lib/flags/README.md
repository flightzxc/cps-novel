# src/lib/flags/

**Owner: Codex（独占写入）**

## 用途

Feature Flag 与写入闸（Allow Write）的读取入口。

## 唯一真源

```
src/lib/flags/feature-flags.ts
```

## 当前实现

P2-05 已登记 `FEATURE_NOVEL_CATALOG_SYNC` 与
`NOVEL_CATALOG_SYNC_ALLOW_WRITE`；P2-10 已登记默认关闭的
`FEATURE_SITEMAP_AUTO_REFRESH`。治理登记见
`docs/governance/feature-flag-registry.md`。

## 特别纪律

- 形态照搬 CPS 已验证做法：**一 flag 一函数、读 env、`=== "true"` 显式判定、默认关**；
- 🔴 **业务写入双闸**：修改 Novel/Article/PromoLink 等业务数据的能力必须同时具备 `FEATURE_X` 与 `X_ALLOW_WRITE` 两把钥匙——「功能开了也不写业务库」；只写 GenericTask 控制面与原子静态产物的任务可使用单一默认关闭 flag，但必须在治理登记中说明例外边界；
- 安全默认开的锁定类 flag 用反向形态（`!== "false"`）；
- 前台通过 flag 函数读取，**不直接读 `process.env`**；
- 新增 flag 必须在 `docs/governance/` 登记：名称、默认值、影响面、谁读。
