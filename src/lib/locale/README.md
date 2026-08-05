# src/lib/locale/

**Owner: Claude（独占写入）**

## 用途

上游语种码 → 站点 locale 的映射，以及发布语种白名单的查询入口。

## 唯一真源

```
src/lib/locale/locale-canonical.ts
```

🔴 **全项目唯一的语种映射实现。** 禁止在任何其他位置出现第二处语种映射硬编码——CPS 因语种映射散落四处，付过两次全库 normalize 的代价。后续应有 lint 规则卡住新增映射表。

## 当前状态

`locale-canonical.ts` 已落地（P1-13），导出冻结契约的三个 API。**两张数据表刻意为空**：

| 表 | 状态 | 解除条件 |
| --- | --- | --- |
| 上游语种登记表 | 空 | 上游 `language` 数值码的枚举来自接口探测证据（`P0_BROWSER_INTERFACE_PROBE.md` / `P0_SECOND_BROWSER_PROBE.md`），这两份证据不在本仓库内；`§U-3` 另记有「法语数值枚举未安全取得」。没有证据就登记数值码，等于凭空发明上游契约 |
| 发布白名单 | 空 | **D-7 仍是 OPEN**。且冻结准入条件是五项齐备：messages 无 fallback · 后台模板语种枚举已登记 · 模板已跑通真实渲染 · SEO 元数据齐全 · sitemap 分片已验证。P1 一项都不具备，所以连 `en` 也不进 |

因此今天 `resolveSiteLocale` 对任何输入都返回 `unknown`，`isPublishableLocale` 恒为 `false`，`listPublishableLocales()` 恒为 `[]`——这正是契约要求的 fail-closed 状态，不是未完成的占位。证据与 D-7 落地后，**只需要改这一个文件**。

`SiteLocale` 目前只有 `en`：它是本仓库里唯一有依据的站点语种（根布局 `<html lang="en">`），也是 D-7 建议的起步语种。新增任何 locale 必须先有 Owner 决策。

## 硬前置

`locale-canonical.ts` 是 P1 的**硬前置 2**：必须在写入任何多语言数据之前建好，早于 P1-05 之后的任何内容写入链路。

## 特别纪律

- 映射失败返回 `unknown`，**不得猜测、不得用上游原值当 locale**；
- `unknown` 的后果：来源条目可建，**canonical 内容实体不建**，进人工队列；
- 「映射成功」≠「可发布」——发布白名单是独立的一道，fail-closed；
- 对外接口形状见 `src/contracts/`：`resolveSiteLocale` / `isPublishableLocale` / `listPublishableLocales`。
