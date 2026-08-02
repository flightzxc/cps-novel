# src/lib/slug/

**Owner: Claude（独占写入）**

## 用途

slug 生成与归一、slug 别名（alias）与 301/308 跳转、公开页面身份短码（`public_page_id`）。

⚠️ **与 `src/lib/redirect/` 是两件事**：这里是**页面身份**（URL 里的内容标识），`redirect/` 是**推广跳转码**（`/go/{code}`）。CPS 把这两者分开，海外阅读继承这条边界，**不得混用**。

## 本轮范围

🔴 本轮（P1-04）只建目录，不写实现。当前目录仅含本 README 与 `.gitkeep` 占位。

## 填充任务

由 **P1-10 / P2 内容与页面链路** 落地。

## 特别纪律

- slug 冲突时 **suffix-or-throw，绝不静默覆盖**；
- 短码生成沿用 CPS 已验证算法（字母表 + **强制含数字** + 冲突重试 + DB 唯一约束兜底），搬运须登记 `docs/governance/port-registry.md`；
- 改书名不断链——旧 slug 通过 alias 表 308 到新 slug；
- 所有 URL 构造必须走统一的构造函数（见 `src/contracts/`），sitemap、IndexNow、CTA、后台预览链接、结构化数据全部一致。
