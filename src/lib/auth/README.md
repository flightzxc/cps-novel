# src/lib/auth/

**Owner: Codex（独占写入）**

## 用途

后台身份认证：会话管理、2FA、能力位（capability）框架、登录态校验辅助函数。

## 当前实现状态

P1-08A 已提供可运行的纯 Auth 核心：Session 生命周期、TOTP、恢复码、2FA challenge、
登录失败记录、Capability 和可注入存储端口。生产 PostgreSQL 持久化仍需通过
`docs/p1/P1_08_SCHEMA_DEPENDENCY_CHANGE_REQUEST.md` 审批后接入。

测试内存适配器只存在于 `tests/backend/auth/`，明确为
`TEST_ONLY / NOT_PRODUCTION_PERSISTENCE`。

## 特别纪律

- 未登记为公开的 Admin 路由/API/Action 一律默认拒绝（403/404），新增入口必须显式登记保护清单；
- 会话超时、2FA 校验逻辑不得下放到前端页面自行判断，统一由本层提供的服务端校验函数把关；
- `jwt_missing` 与 `jwt_expired` 需二分处理，不得合并成单一错误态。
