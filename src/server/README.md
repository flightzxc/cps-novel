# src/server/

**Owner: Codex（独占写入）**

## 用途

后台/公开面共用的服务端业务逻辑层：Server Action 与 API Route 背后的实际处理函数、权限校验、跨表事务编排。前端（Claude 侧）只消费这一层暴露的契约，不直接操作数据库。

## 当前实现状态

P1-08A 已在 `auth/` 建立 Admin 页面/API/Action 注册表、默认拒绝 guards、
Origin/request-id/cookie 契约和 service mutation 二次授权。因本轮禁止修改 `src/app/**`，
这些 guards 尚未接入 Next.js 页面或 Route Handler。

## 特别纪律

- **默认拒绝**：任何未显式登记进保护清单的 Admin 路由 / API / Server Action，一律 403/404；不是"忘了校验就放行"；
- 涉及凭证的操作，本层只负责**入队任务**，不得在此层直接解密或使用明文凭证——实际解密与外部调用在 Worker 执行；
- 对外暴露的类型/接口形状改动需经 `src/contracts/` 走 PR 流程（Claude 合并）。
