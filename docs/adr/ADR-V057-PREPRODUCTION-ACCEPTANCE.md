# ADR：v0.5.7 预生产 F.1 验收分层口径

- 状态：已接受；Owner 转交主控 Opus 2026-10-02（Asia/Tokyo）裁决。
- 决策来源：本次发布聊天中 Owner 明确“F 节裁决：通过，继续执行 G 节”；不虚构独立复核 trailer。
- 适用版本：Final `bbb06253828d9fd338f0ece1749c2020d8ec4679`，仅 haiyue-vps 密码保护预生产。

## 背景

原提示词 F.1 要求经公开 HTTPS 入口验证空 body 404；实际既有 nginx 在应用之前拦截后台路径。编码斜杠、反斜杠返回 nginx 的 404 / 162 字节，非法编码返回 nginx 的 400 / 166 字节；同三条请求直连 web 容器均 404 / 0 字节。Codex 按旧口径停止，保留了入口和应用的实际证据，未改 nginx。

## 裁决

1. 经公开入口时，外层 nginx 先拦截这三类路径，请求没有到应用；404 / 162、404 / 162、400 / 166 是既有防护的预期行为。原提示词把“空 body 404”写成公开入口要求，是主控写错。
2. B-24 的修复以同一公开 Host 直连 web 容器的结果为准：三条请求均为空 body 404，且不跳转 /login，证明 proxy 拒绝生效。修复前同类请求会跳转 /login 或报 500（主控提供的对照结论）。
3. 修改发布记录 F.1 的验收口径，保留 nginx 实际响应；F.2 正常公开页和 F.3 后台登录仍须实际通过。该裁决不授权修改 nginx、证书、DNS、NAS、应用代码或业务开关。
4. G 节仍严格只读：15 个语种影响报告、首命中句式的三本样本及有变化语种的全部 source=auto 前快照。做完停止；重新定类任务、apply、快照恢复均需另行明确授权。

## 验证与边界

Codex 按上述口径重新实测 F.1，两层实际响应与裁决一致。F.2 首页、sitemap、sitemap 内小说和章节、两个图标均 200；F.3 未登录页面包含 Next 流式 meta refresh 与 NEXT_REDIRECT，指向 /login?next=%2Fnovels；正常登录、2FA、后台小说页和退出通过。

自写包装器原来只识别 HTTP Location，漏识别流式 HTML 跳转；检查实际 body 后修正并重跑通过，不改变“未登录跳转登录”的要求。既有 nginx 和部署 Final 均不变；原暂停记录保留，当前验收口径以本 ADR 为准。G 的实际结果及第三阶段状态见 [发布记录](../governance/releases/v0.5.7-preproduction.md)。

## 2026-10-02：bp-008 范围与第三阶段授权

Owner 已审阅 G 样本，明确保留 bp-008 “Excerpt from”：这类简介是书中任意片段（多为序言/致谢），不是故事简介；命中 20 本基本为非虚构老书，小说题材标签会造成误导。清单与三个 authority 不变；只授权 en，其它 14 个语种不跑，指定 apply request-id `b23-reclassify-20261002-en`。

执行前线上只读核验全部通过，但原 CLI 的 dry-run 也创建持久化任务；mode 纳入 requestFingerprint，requestToken 只由 request-id 构成。因此原提示词要求同参数先 dry-run 再 apply，会在 apply 触发 IDEMPOTENCY_CONFLICT。按“提示词与脚本矛盾时停止”在建任务前停止；已向 Owner 提出 dry-run 用 `b23-reclassify-20261002-en-dry-run`、apply 保持原 ID 的方案，等待该参数差异裁决。没有创建任何第三阶段任务、没有改写标签；不能把授权记为已经执行。
