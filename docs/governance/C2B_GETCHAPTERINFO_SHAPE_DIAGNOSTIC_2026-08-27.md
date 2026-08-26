# C2b `getchapterinfo` 脱敏形态诊断（2026-08-27）

## 结论

正式 `parsePreviewChaptersResponse` 的 `malformed_payload` 已定位到唯一失败点：`$.data.bookId` 在本次真实响应中是有限 `number`，parser 仍要求非空 `string`。

建议的最窄修法是把：

```ts
bookId: requiredString(data.bookId),
```

改为：

```ts
bookId: requiredIdentifier("bookId", data.bookId),
```

这与 D-1 对 `chapterID` 的既定处理一致，输出仍规范化为 `string`。本诊断不修改 parser，也不放宽 `chapterID`、`i`、`chapterContent` 或其他冻结字段。

## 调用与隔离纪律

- Owner 授权调用：`getchapterinfo` 严格 `1/1`。
- 固定 origin/path、`POST`、`redirect=error`、15 秒超时、`maxAttempts=1`、无重试。
- HTTP 终态：200；正式 parser：`malformed_payload`。
- 正式 parser 与形态诊断读取同一个内存响应；未把原始响应写盘。
- 请求坐标形态：`agencyId:number`、`seriesId:string`、`projectType:number`、`language:number`；未记录其值。
- Lane B 对诊断产物执行模式扫描，并以 Owner token、请求标识和响应中长度不少于 8 的全部字符串为 exact forbidden values；结果零命中。
- 诊断产物不含标题、正文、标量值、token、请求标识或原始响应。

## 全字段 schema summary

`typeof` 为 JavaScript `typeof`；数组因此计入 `object`。`parent` 是该 JSON Path 的直接父实例数；`present/missing` 按这些父实例计算。数组长度列为“长度:数组实例数”。

| JSON Path | parent | present | missing | null | 空白串 | typeof 分布 | 数组长度分布 |
|---|---:|---:|---:|---:|---:|---|---|
| `$` | 1 | 1 | 0 | 0 | 0 | object:1 | — |
| `$.code` | 1 | 1 | 0 | 0 | 0 | number:1 | — |
| `$.data` | 1 | 1 | 0 | 0 | 0 | object:1 | — |
| `$.data.bookId` | 1 | 1 | 0 | 0 | 0 | number:1 | — |
| `$.data.chapterList` | 1 | 1 | 0 | 0 | 0 | object:1 | 3:1 |
| `$.data.chapterList[*]` | 1 | 3 | 0 | 0 | 0 | object:3 | — |
| `$.data.chapterList[*].chapterContent` | 3 | 3 | 0 | 0 | 0 | string:3 | — |
| `$.data.chapterList[*].chapterID` | 3 | 3 | 0 | 0 | 0 | number:3 | — |
| `$.data.chapterList[*].chapterName` | 3 | 3 | 0 | 0 | 0 | string:3 | — |
| `$.data.chapterList[*].chapterShowName` | 3 | 3 | 0 | 0 | 0 | string:3 | — |
| `$.data.chapterList[*].i` | 3 | 3 | 0 | 0 | 0 | number:3 | — |
| `$.data.currentLanguage` | 1 | 1 | 0 | 0 | 0 | number:1 | — |
| `$.message` | 1 | 1 | 0 | 0 | 0 | string:1 | — |
| `$.status` | 1 | 1 | 0 | 0 | 0 | boolean:1 | — |

## 冻结 parser 逐点核验

| 校验点 | 结果 | 失败实例 |
|---|---|---:|
| envelope 为 object | PASS | 0 |
| `data` 为 object | PASS | 0 |
| `chapterList` 为 array | PASS | 0 |
| 每个章节 row 为 object | PASS | 0 |
| `i` 为 safe integer 且 `>= 1` | PASS | 0 |
| `chapterID` 为非空 string 或有限 number | PASS | 0 |
| `chapterName` / `chapterShowName` 走 optionalString | PASS | 0 |
| `chapterContent` 为非空 string | PASS | 0 |
| 复合身份 `(i, chapterID)` 无重复 | PASS | 0 |
| `bookId` 为非空 string | **FAIL** | 1 |
| `currentLanguage` 经 number→string 规范化后为非空 string | PASS | 0 |

本次响应中复合 `(i, chapterID)` 重复计数为 0。`chapterID` 的 number 形态证明 D-1 仍是必要且足够的窄兼容；残余失败与它无关。
