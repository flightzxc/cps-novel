# src/lib/locale/

**Owner: Claude（独占写入）**

## 用途

上游语种码 → 站点 locale 的映射，以及发布语种白名单的查询入口。

## 唯一真源

```
src/lib/locale/locale-canonical.ts
```

🔴 **全项目唯一的语种映射实现。** 禁止在任何其他位置出现第二处语种映射硬编码——CPS 因语种映射散落四处，付过两次全库 normalize 的代价。后续应有 lint 规则卡住新增映射表。

## 本轮范围

🔴 本轮（P1-04）只建目录，不写实现。当前目录仅含本 README 与 `.gitkeep` 占位。

## 填充任务

`locale-canonical.ts` 是 P1 的**硬前置 2**：必须在写入任何多语言数据之前建好，早于 P1-05 之后的任何内容写入链路。

## 特别纪律

- 映射失败返回 `unknown`，**不得猜测、不得用上游原值当 locale**；
- `unknown` 的后果：来源条目可建，**canonical 内容实体不建**，进人工队列；
- 「映射成功」≠「可发布」——发布白名单是独立的一道，fail-closed；
- 对外接口形状见 `src/contracts/`：`resolveSiteLocale` / `isPublishableLocale` / `listPublishableLocales`。
