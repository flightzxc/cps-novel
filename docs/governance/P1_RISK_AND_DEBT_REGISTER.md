# P1 风险与遗留债务登记

> 来源：P1-14 最终聚焦只读审计
> 审计对象：`main@fb8cddbdf7c8ff6b566169eade4a89258e7db668`
> 审计结论：`P1_14_FINAL_AUDIT_PASS`
> Required fixes：`NONE`
> 登记原则：以下 9 项全部是 `NON_BLOCKING_NOTE`，不得改写为 P1 required fix

## 1. 使用规则

- “建议 Owner”是处理责任建议，不是已完成的人员指派；
- “P2 优先级”只表达进入 P2 后的处理先后，不创建正式任务编号；
- 触发点到来前可以保留现状；触发点到来时必须显式处理或由 Owner 书面接受风险；
- 本台账不授权修改代码、Schema、测试、脚本、CI、基础设施或 CPS。

## 2. 总表

| ID | 摘要 | P2 优先级 | 最晚触发点 | 建议 Owner |
| --- | --- | --- | --- | --- |
| P1-NB-01 | `two_factor_expired` 同时表示过期与已消费 | 高 | 2FA 挑战页落地前 | Auth/Credential 后端 Owner + 前端契约 Owner |
| P1-NB-02 | 未知错误被兜底成 403 capability denied | 中 | 正式运维告警/错误观测接入前 | API/错误信封 Owner |
| P1-NB-03 | locale 测试 suite 标题已过期 | 低 | 下一次修改 locale 测试或测试报告时 | 测试 Owner |
| P1-NB-04 | Web 对 catalog scan item 的 SELECT 暴露面偏宽 | 中 | 正式内容/任务后台开放前 | 数据库权限 Owner |
| P1-NB-05 | operation audit append-only 与保留期清理冲突 | 高 | 启用 365 天清理任务前 | 数据库运维/安全 Owner |
| P1-NB-06 | 默认测试命令会跳过 PostgreSQL 门禁 | 高 | 首次正式远端 CI 配置前 | CI/发布 Owner |
| P1-NB-07 | static drift 不解析 migration SQL | 中 | 依赖无数据库 static drift 作为发布证据前 | 数据库测试 Owner |
| P1-NB-08 | Worker/Scheduler healthcheck 只验证进程存活 | 中 | 上线生产监控/SLO 前 | Runtime/运维 Owner |
| P1-NB-09 | Admin 侧栏版本号存在 dev fallback | 中 | 首次发布候选构建前 | Admin UI + 构建发布 Owner |

## 3. 逐项登记

### P1-NB-01 · `two_factor_expired` 一码两义

- **现状**：`src/lib/auth/two-factor.ts` 的 challenge 过期与 challenge 已消费两条拒绝路径使用同一
  `two_factor_expired` 错误码；错误信封已经有受白名单约束的 `details.reason` 机制，但尚未区分。
- **风险**：前端提示、支持排障与指标不能区分“自然过期”和“已被消费/重放”。
- **为什么不阻断 P1**：两条路径都正确拒绝访问，无权限绕过、无 secret 泄露；P1 尚未交付正式
  2FA challenge UI。
- **触发处理时间点**：正式 2FA challenge 页面落地前。
- **建议 Owner**：Auth/Credential 后端 Owner 负责稳定 reason；前端契约 Owner 消费并展示。
- **P2 优先级**：**高**。

### P1-NB-02 · 未知错误兜底为 403 capability denied

- **现状**：`src/app/api/admin/_lib/respond.ts` 的未知错误 fallback 映射为 HTTP 403
  `admin_capability_denied`。
- **风险**：真正的 500 类内部故障会伪装成权限错误，告警分类、日志检索和现场排障可能追错方向。
- **为什么不阻断 P1**：当前行为 fail-closed，未泄露内部错误或 secret，也不会扩大权限。
- **触发处理时间点**：正式错误观测、告警分流或内容后台 mutation 上线前。
- **建议 Owner**：Admin API/错误信封 Owner。
- **P2 优先级**：**中**。

### P1-NB-03 · locale 测试标题过期

- **现状**：`tests/backend/p1-13-locale-single-source.test.ts` 的 describe 标题仍含
  `WAITING_FOR_CLAUDE_IN_FINAL_INTEGRATION`；在当前树中门禁条件为真，两个测试实际已运行并 PASS。
- **风险**：测试报告阅读者可能误判 locale 实现仍缺失或测试仍被跳过。
- **为什么不阻断 P1**：只影响标签；门禁求值、断言与执行结果正确，P1-13 locale-related skipped=0。
- **触发处理时间点**：下次合法修改 locale 测试或整理测试报告时。
- **建议 Owner**：测试 Owner。
- **P2 优先级**：**低**。

### P1-NB-04 · Web 对 catalog scan item 的 SELECT 暴露面偏宽

- **现状**：`infra/postgres/grants.sql` 对 `catalog_scan_task_item` 给 `web_app` 表级 SELECT，因而可读
  `execution_token`、`locked_by` 等 Worker 租约列；其他敏感区域主要采用列级授权。
- **风险**：后台或 Web 查询面被误用时可看到不必要的执行租约元数据，违反最小可见面偏好。
- **为什么不阻断 P1**：`web_app` 没有对应写路径，无法改变 token/epoch 或绕过 fencing；P1-14
  已独立确认任务并发和 credential isolation 成立。
- **触发处理时间点**：正式任务中心/目录同步后台开放给真实管理员前。
- **建议 Owner**：数据库权限 Owner 与 Admin 查询 Owner 联合确认所需列清单。
- **P2 优先级**：**中**。

### P1-NB-05 · `operation_audit` 保留期清理路径缺失

- **现状**：`operation_audit_append_only` trigger 拒绝普通 UPDATE/DELETE；当前
  `database-governance.md` 与数据库字典把核心业务审计登记为长期保留/无自动清理。P1-14 note
  进一步指出：如果后续实际采用 365 天清理策略，当前尚无允许合规 DELETE 的特权路径。
- **风险**：直接启用清理任务会失败；若临时绕过 trigger，可能缺少授权、范围、审计与可恢复控制。
- **为什么不阻断 P1**：P1 没有启用 365 天清理任务；append-only 当前反而强化审计完整性。
- **触发处理时间点**：**在实际启用 365 天清理任务前，必须先设计并验收受控的特权清理路径**。
- **建议 Owner**：数据库运维 Owner + 安全/合规 Owner。
- **P2 优先级**：**高**。
- **强制前置**：方案必须限定执行身份、时间/批次范围、审批与审计记录、失败回滚/重试；可评估受控
  SECURITY DEFINER 函数或维护窗口内的 trigger 管理，但不得把普通应用角色升级为可 DELETE。

### P1-NB-06 · PostgreSQL 集成测试默认门控

- **现状**：默认 `npm test` 在缺少 `P1_05B_DATABASE_TEST` 等环境门禁时跳过 PostgreSQL 集成套件；
  P1-13 的真实 71/71 是通过专用 PostgreSQL 16.14 harness 显式执行的。
- **风险**：若远端 CI 只运行默认测试，数据库约束、权限、并发、fencing 与恢复网可能静默消失。
- **为什么不阻断 P1**：P1-13 已在真实 PostgreSQL 16.14 上显式执行并通过 71/71，P1 尚未建立
  正式远端 CI。
- **触发处理时间点**：**首次正式远端 CI 配置前**。
- **建议 Owner**：CI/发布 Owner + PostgreSQL 测试 Owner。
- **P2 优先级**：**高**。
- **强制前置**：首次正式远端 CI 必须显式运行
  `scripts/p1-13-postgres-verification.sh`，或提供等价的 PostgreSQL 16 门禁；不得仅以默认
  `npm test` 代表 PG 验收。

### P1-NB-07 · static drift 不解析 migration SQL

- **现状**：`scripts/check-database-dictionary-drift.mjs --static` 在无数据库模式不解析 migration SQL 文本；
  P1-14 记录的 66 个 CHECK、126 个索引与 2 个 trigger 不在该 static 模式的实际校验范围。
- **风险**：离线/轻量 CI 若只依赖 static drift，可能把 migration-only 对象遗漏当成“全量无 drift”。
- **为什么不阻断 P1**：P1-05B 与 P1-13 已使用真实 PostgreSQL 做 schema/migration/pg_catalog 核验；
  该缺口不否定已经取得的真实数据库证据。
- **触发处理时间点**：准备把无数据库 static drift 升格为正式发布证据前。
- **建议 Owner**：数据库测试/工具 Owner。
- **P2 优先级**：**中**。

### P1-NB-08 · Worker/Scheduler healthcheck 只检查进程存活

- **现状**：`docker-compose.yml` 中 Worker 与 Scheduler healthcheck 读取 `/proc/1/cmdline`，证明进程存在，但不证明事件循环、
  数据库心跳或任务推进仍健康。
- **风险**：进程卡死但未退出时可能保持 healthy，延迟故障发现与自动恢复。
- **为什么不阻断 P1**：P1-12 已验证四容器启动、DB 故障/恢复与 Web Health；当前规模下进程存活检查
  是可接受的初始门禁，且不影响任务数据库 fencing 正确性。
- **触发处理时间点**：建立生产监控、SLO、告警与自动重启策略前。
- **建议 Owner**：Runtime/运维 Owner。
- **P2 优先级**：**中**。

### P1-NB-09 · Admin 侧栏版本显示存在 dev fallback

- **现状**：`src/app/(admin)/_components/admin-shell.tsx` 的 `BUILD_VERSION` 缺失时回退到
  `v0.3.0-dev`（随 v0.3.0 版本身份统一同步更新，2026-09-23）；该值只用于侧栏展示，构建身份
  权威仍是镜像内只读 `.build-metadata.json`。
- **风险**：正式构建若忘记注入 `NEXT_PUBLIC_BUILD_VERSION`，管理员看到的版本号与真实镜像不一致，
  影响支持沟通和截图证据。
- **为什么不阻断 P1**：不会改变 Health、镜像 label 或 baked metadata 的权威身份，也不影响功能/安全。
- **触发处理时间点**：首次发布候选构建与发布 runbook 验收前。
- **建议 Owner**：Admin UI Owner + 构建发布 Owner。
- **P2 优先级**：**中**。

## 4. P1 关闭口径

```text
P1_14_RESULT=P1_14_FINAL_AUDIT_PASS
P1_14_REQUIRED_FIXES=NONE
NON_BLOCKING_NOTES=9
P1_BLOCKERS_CREATED_BY_THIS_REGISTER=0
```

本台账的存在不延长 P1，也不授权在 P1-15 内修复任何 note。

---

## 5. Phase 2C UAT 前 follow-up（非 P1 范畴，来源 PR #10）

> 来源：PR [#10](https://github.com/flightzxc/cps-novel/pull/10)（已 MERGED，merge commit
> `2d1f3bbcc7bc9f03587544e6e4c2805a1f8f02f7`）合并前对 Codex 评审线程的独立核验。
> 登记时间：2026-09-20。
>
> 🔴 **本节不属于 P1-14 审计范围**，不改变上面 §4 的任何计数：
> `NON_BLOCKING_NOTES` 仍是 9，`P1_BLOCKERS_CREATED_BY_THIS_REGISTER` 仍是 0。
> 之所以放进本文件，是因为它是本仓唯一在用的债务台账；合并后的 PR 评论既不在仓库里、
> 也不在任何台账中，`git log` 与交付报告都检索不到，留在那里等于没记。
>
> 🔴 **只登记，不授权修改。** 两项都是 Phase 2C UAT 前的 follow-up，需要各自独立的
> 工单处理；不得在与本节无关的工单里顺手改动（本节由 2026-09-20 的
> GHCR Bootstrap 工单登记，该工单明确禁止修改这两项本身）。

| ID | 摘要 | 优先级 | 最晚触发点 | 建议 Owner |
| --- | --- | --- | --- | --- |
| P2C-FU-01 | Hero 环形轮播回绕跨多个空槽位动画 | 高（用户可见） | Phase 2C UAT 前 | 前台 UI Owner |
| P2C-FU-02 | 移动端隐藏 metadata 的无障碍语义注释被证伪 | 中 | Phase 2C UAT 前 | 前台 UI Owner + 无障碍口径 Owner |

### P2C-FU-01 · Hero 环形轮播末张 → 首张跨槽位动画

**现象（已实证，非推断）。** 1440 视口、主推 5 本，从 index 4 切到 index 0：

```text
trackIndex   9 → 5
transition   500ms（未禁用）
实际位移     ≈ 4.23 个槽位
中途采样     transform matrixX ≈ -8205
```

`FeaturedHero` 只渲染 `near = |slot - trackIndex| <= 1` 的项，其余是等宽空 spacer。
因此这 500ms 里用户看到的是一串**空位倒着飞过**，而不是切到相邻的那一本。
反向回绕（index 0 → 4）同理。

**预期行为。** 先动画到**相邻副本**边界 → 过渡结束 → **无动画** snap 回中间那份
canonical copy。这是环形轮播的标准做法，当前实现缺的是后两步。

**为什么当时没被挡下。** 数量边界（1 / 2 / ≥3）有用例覆盖，`useLoop` 的取值也有用例，
但**没有任何用例断言回绕时的位移只跨一个槽位**——用例测的是"渲染了什么"，不是
"怎么动过去的"。补修时应同时补这条断言，否则下次重构照样漏。

**不在本轮范围。** 2026-09-20 的 GHCR Bootstrap 工单明确禁止修改该项。

### P2C-FU-02 · 移动端隐藏 metadata 的无障碍语义

**现象（已实证）。** 390px 视口下，`BookCard` 紧凑档的简介 / 语种 / 标签外层：

```text
display        none
bounding box   0 × 0
标签链接       在 DOM 里，但同样被移出无障碍树
```

`display: none` 会把整棵子树移出无障碍树，读屏取不到。

**被证伪的注释。** `BookCard.tsx` 与 `FeaturedHero.tsx` 当前写着

> 「留在 DOM 里：读屏和爬虫拿到的内容不因视口宽度而缩水」

**爬虫那半成立**（内容确实在 HTML 响应里），**读屏那半是错的**。两种语义不能混为一谈，
注释按现状会把后来的人引向错误结论。

**待 Owner 决策（本台账不做该决策）。** 两条路：

1. **仅更正注释** —— 承认窄屏刻意不向读屏暴露这些次要 metadata，是有意的信息密度取舍；
2. **改为 `sr-only` 等视觉隐藏方案** —— 保留给读屏，视觉上仍不占位。

第 2 条不是纯粹的"更正"，它改变移动端读屏用户实际听到的内容，属产品决策。

**不在本轮范围。** 同上。
