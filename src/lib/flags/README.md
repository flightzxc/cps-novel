# src/lib/flags/

**Owner: Codex（独占写入）**

## 用途

Feature Flag 与写入闸（Allow Write）的读取入口。

## 唯一真源

```
src/lib/flags/feature-flags.ts
```

## 本轮范围

🔴 本轮（P1-04）只建目录，不写实现。当前目录仅含本 README 与 `.gitkeep` 占位。

## 填充任务

由 **P1-06（Feature Flag + Allow Write 双闸基础设施，Notion 编号以台账为准）** 落地；后续各能力按需追加 flag。

## 特别纪律

- 形态照搬 CPS 已验证做法：**一 flag 一函数、读 env、`=== "true"` 显式判定、默认关**；
- 🔴 **双闸**：任何有写入的能力必须同时具备 `FEATURE_X` 与 `X_ALLOW_WRITE` 两把钥匙——「功能开了也不写库」；
- 安全默认开的锁定类 flag 用反向形态（`!== "false"`）；
- 前台通过 flag 函数读取，**不直接读 `process.env`**；
- 新增 flag 必须在 `docs/governance/` 登记：名称、默认值、影响面、谁读。
