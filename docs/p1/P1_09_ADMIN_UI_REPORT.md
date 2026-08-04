# P1-09 · Admin UI 权限/API 边界与 CPS 渠道账户 parity 复核

**任务模式：`CODEX_P1_09_API_PERMISSION_REVIEW`**

**主责：Claude ｜ 权限/API Reviewer：Codex**

**目标分支：`feature/v0.1.0-p1-09-admin-ui`**

**复核 HEAD：`ddf475ec9066ee05e8e582262f9e50548b0744d6`**

**基线 main：`93537a054566405ca3b653038e383e112072b023`**

**CPS 只读参照：`feature/v8.1.1-search-ux-patch` @ `d77c3b968285698529cf97c7f0f97b286d7a2a9c`**

**CPS `SOP_ACK=54c3e49433ca05f5129afe1bda74d4e39b88cba175b1cd6a18ebb26c4f3704fd`**

---

## 1. 复核范围与安全声明

- CPS 仅执行 R0 代码/测试/文档读取和 `git status` 检查；没有修改 CPS。
- 未部署、未重启、未运行 Docker/Prisma、未改数据库、未启动 Worker/Scheduler/同步/批处理任务。
- 本轮不重做 UI，不改设计系统，不新增依赖，不新增字段、按钮、状态或 mutation REST API。

### 1.1 CPS 实际证据（不以 parity spec 或旧报告代替）

| 证据层 | CPS 实际文件 | 本次查看内容 |
| --- | --- | --- |
| 页面 | `src/app/(admin)/channel-accounts/page.tsx` | 页面标题、表格列、账户/JWT 状态、能力可见性、空状态 |
| 交互 | `src/app/(admin)/channel-accounts/channel-account-forms.tsx` | create/update/validate/disable/enable/supersede、reason、pending/success/failure、`window.confirm` |
| Server Action | `src/app/(admin)/channel-accounts/actions.ts` | session + `credential:manage`、六项写操作、结果文案 |
| Service | `src/lib/channel-account/service.ts` | 事务、reason 规则、credential 状态、指纹脱敏、审计日志 |
| Capability | `src/lib/admin-capabilities.ts` | `credential:manage` 角色/用户 allowlist |
| 测试 | `tests/channel-account-actions.test.ts`、`tests/channel-account-credentials.test.ts`、`tests/channel-account-supersede-credential.test.ts`、`tests/admin-server-actions-auth.test.ts` | 权限拒绝、状态、reason、加密/指纹、supersede 边界、Action 认证顺序 |

---

## 2. Mutation transport 与 registry 结论

Owner 决策已落地：

```text
READ_TRANSPORT=GET_ROUTE_HANDLER
WRITE_TRANSPORT=SERVER_ACTION
```

### 2.1 真实入口

| 类型 | 数量 | 入口 |
| --- | ---: | --- |
| GET Route Handler | 3 | `/api/admin/channel-accounts`、`/api/admin/credentials/metadata`、`/api/admin/credential-tasks/status` |
| Server Action | 6 | create、disable、enable、replace、validate、supersede |
| POST Route Handler | 0 | 未开放 |
| orphan POST registry | 0 | 已删除 5 条无 Handler 登记；replace 也不再同时登记 Route |

`addOrReplaceCredential` 仅接受 `admin.credential.replace`。已删除
`admin.api.credential.replace` 兼容，service 不再接受两套命名空间。

### 2.2 Registry 自动一致性

`tests/backend/auth/admin-registry-parity.test.ts` 双向检查：

1. 每个 registry GET 都存在实际 `route.ts` GET export；
2. 每个实际 Admin GET Handler 都已登记；
3. 六个敏感 Action 全部存在且登记为 mutation；
4. 所有敏感 Action 都绑定 `credential:manage`；
5. 六个 POST mutation path 全部未登记，保持 404/default-deny；
6. credential service 中不存在 `admin.api.*` mutation entryId。

---

## 3. 六项 mutation 权限链

| 操作 | Action ID | Session | capability | 2FA | origin | requestId | service 二次校验 | reason |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| create account | `admin.channel_account.create` | PASS | PASS | PASS | PASS | UUID | PASS | 不要求 |
| disable account | `admin.channel_account.disable` | PASS | PASS | PASS | PASS | UUID | PASS | 必填 |
| enable account | `admin.channel_account.enable` | PASS | PASS | PASS | PASS | UUID | PASS | 必填（小说强化） |
| add/replace credential | `admin.credential.replace` | PASS | PASS | PASS | PASS | UUID | PASS | 必填，禁止夹带 JWT |
| validate credential | `admin.credential.validate` | PASS | PASS | PASS | PASS | UUID | PASS | 不要求 |
| supersede credential | `admin.credential.supersede` | PASS | PASS | PASS | PASS | UUID | PASS | 必填 |

页面隐藏/禁用操作仅是表现层，不作为最终授权。Action guard 签发不可伪造的
`AdminServiceAuthorization`，service 再读当前 session，精确比较 entryId/requestId，重新校验
`credential:manage` 和 2FA。

Client Component 静态门禁确认：

- 不 import `src/server/**`、Credential service、Prisma/Store；
- 不接收 `AdminAuthContext`、tokenHash、sessionVersion；
- add/replace 中的 JWT 只存活于该次请求，不写 task/audit/log；
- 页面/Action 不读 `encrypted_secret`，浏览器仅获得 `fingerprintPrefix`。

---

## 4. Credential task not found 稳定边界

`getCredentialTaskResult` 不再抛裸 `Error("credential_missing")`。以下三种情况统一抛
`CredentialTaskNotFoundError`，并投影稳定 code `credential_task_not_found`：

- task 不存在；
- task type 不属于 Credential 允许范围；
- legacy `credential.replace.v1` task 不允许从该查询路径读取。

外部结果固定为：

```json
{
  "ok": false,
  "status": 404,
  "code": "credential_task_not_found"
}
```

不返回 message、stack、数据库主键细节、内部 task type 或其他管理员任务信息。前端对该 code
有独立分支，清除旧 task panel 并显示「任务不存在或不可查询」，不解析服务端文本。

正常状态投影保持：`pending → queued`、`processing → running`、`completed → completed`、
`failed → failed`；冻结架构中的 `completed_with_errors/disabled/unknown` 无回归。

---

## 5. `ADMIN_CANONICAL_ORIGIN`

- 所有环境只信任显式 `ADMIN_CANONICAL_ORIGIN`；不从 request Host 或 localhost 自动推导。
- 缺失时返回空 canonical value，由 `requireSameOrigin` 稳定拒绝。
- 非法 URL、缺失、不同 origin 均返回 `admin_origin_denied` / 403；精确同 origin 通过。
- 该值不使用 `NEXT_PUBLIC_` 前缀，不投影到浏览器。

### P1-12 配置交接

P1-12 本地 Compose、测试环境与任何后续部署配置必须显式注入：

```text
ADMIN_CANONICAL_ORIGIN=<Admin Web 的唯一 canonical origin，例如 https://admin.example.com>
```

不得使用 Host 回退，不得在生产默认 localhost，不得暴露给客户端。本轮未建立新的
production configuration framework，由 P1-12 完成 Compose/CI 注入与健康检查。

---

## 6. CPS 渠道账户垂直切片 parity matrix

| 项目 | CPS 实现 | 小说实现 | 结论 |
| --- | --- | --- | --- |
| 页面字段 | 标题/说明；create 为渠道、业务ID、账户名；JWT 与 reason 在操作区 | 同一组运营字段，仅用 AdminShell/ConfirmDialog 承载 | **PARITY** |
| 表格列与顺序 | 渠道 → 业务ID → 账户名 → 状态 → JWT → 过期时间 → 最近验证 → 操作 | 渠道 → 业务ID → 账户名 → 账户状态 → 凭证 → 过期时间 → 最近验证 → 操作 | **PARITY** |
| account 状态 | `active/disabled`，页面显示原值 | 同样只有 `active/disabled`，以「启用/停用」 badge 显示 | **PARITY** |
| credential 状态 | 结合 credential 和 `jwtStatus` 派生 `missing/invalid/expired/expiring_soon/valid/unknown` | 依小说冻结架构直接展示 `active/superseded/expired/invalid`，无凭证时显示未配置 | **EXPLICIT_DIVERGENCE** — 小说冻结的单轨 credential 状态，不复制 CPS 的第二维 `jwtStatus` |
| 操作归属层级 | disable/enable 属于 account；update/validate/supersede 属于 credential | 完全同层级，account disable 不改 credential 状态 | **PARITY** |
| 操作文案 | 新增账号、更新、验证、禁用、启用、作废凭证 | 新增渠道账号、更新 JWT、验证、停用账户、启用账户、作废凭证；业务含义一致 | **PARITY** |
| reason 必填规则 | update/disable/supersede 必填；enable 可选；create/validate 无 reason | replace/disable/enable/supersede 必填；create/validate 无 reason | **EXPLICIT_DIVERGENCE** — enable 提升为必填，属于更强审计边界 |
| 二次确认 | supersede 使用 `window.confirm`；disable 内联 reason 后直接提交 | supersede 与 disable 都进 ConfirmDialog，必填 reason 后才可确认 | **EXPLICIT_DIVERGENCE** — disable 增加可访问二次确认，属于更强安全边界 |
| 成功反馈 | `useActionState` 在各表单展示成功文案 | 页顶稳定 success notice；validate/supersede 辅以异步 task panel | **PARITY** （Worker 操作增加任务状态） |
| 错误反馈 | Action 可将 service `Error.message` 显示给页面 | 只按稳定 ErrorEnvelope code 映射前端文案，不读 message/stack | **EXPLICIT_DIVERGENCE** — 更强安全边界，防止驱动/服务内部信息暴露 |
| 空状态 | 表格内「暂无渠道账户」，colspan 按操作列调整 | 相同文案与 colspan 规则 | **PARITY** |
| capability 可见性 | `hasAdminCapability` 布尔值；无权时隐藏 create/操作列并显示只读 | `granted/denied/two_factor_required` 三态；无权时隐藏写入操作并明示缺失原因 | **EXPLICIT_DIVERGENCE** — 继承小说冻结 2FA 与 default-deny guard |
| mutation transport | create/disable/enable/update/validate/supersede 全部是 Server Action | 六项 mutation 全部 Server Action；GET Route Handler 仅用于读 | **PARITY** |
| 敏感字段隐藏 | 不回显 JWT；service 对完整 HMAC 指纹做 masked 投影 | Web DB role 无 `encrypted_secret/secret_fingerprint` 列权限；只返回库内 `fingerprintPrefix` | **EXPLICIT_DIVERGENCE** — PostgreSQL 列权限 + 更强最小暴露边界 |

### 6.1 明确偏离汇总

1. Credential 状态单轨化：小说冻结架构。
2. Enable reason 必填：更强审计边界。
3. Disable 二次确认：更强安全边界。
4. 稳定 ErrorEnvelope：更强安全边界。
5. Capability + 2FA 三态：小说冻结 Auth 架构。
6. 只返回 `fingerprintPrefix`：PostgreSQL 列权限和更强最小暴露边界。

未以「重新设计更好看」作为任何偏离理由；未发现无法归因的偏离。

---

## 7. 目录所有权

`P1_MODULE_OWNERSHIP.md` 已与 `P1_IMPLEMENTATION_ASSIGNMENT.md` 一致：

- `src/app/(admin)/**`、`src/app/api/**`、`src/components/**`、`src/features/admin-ui/**`、`tests/ui/**` 归 Claude；
- `src/server/**`、`src/lib/auth/**`、`src/lib/credentials/**`、backend/integration tests 归 Codex；
- `src/contracts/**` 由 Claude merge custodian，本次仅同步 `credential_task_not_found` 最小错误契约；
- Route Handler/Action 只做薄接线，service/DB/Auth guard 仍在 Codex 边界。

本轮无需再改所有权文档。

---

## 8. 验证结果

| 门禁 | 结果 |
| --- | --- |
| `npm run build` | PASS |
| `npm run typecheck` | PASS |
| `npm run lint` | PASS |
| `npm test` | PASS — 185 passed / 55 PostgreSQL integration skipped |
| `npm run test:backend` | PASS — 154 passed |
| `npm run test:ui` | PASS — 21 passed |
| CPS before/after | clean / clean，branch 和 HEAD 未变 |

55 项 skipped 为本地未配置 PostgreSQL 时的既有集成套件。本轮无 Schema/SQL/查询语义变更，
因此不运行 PostgreSQL 全套。

---

## 9. 最终机器可读结论

```text
RESULT=P1_09_CODEX_API_PERMISSION_REVIEW_PASS
REVIEWED_BRANCH=feature/v0.1.0-p1-09-admin-ui
REVIEWED_HEAD=ddf475ec9066ee05e8e582262f9e50548b0744d6
MUTATION_TRANSPORT=SERVER_ACTION_ONLY
GET_ROUTE_HANDLERS=3
SERVER_ACTIONS=6
ORPHAN_POST_ROUTES=ZERO
REGISTRY_PARITY=PASS
AUTHN=PASS
CAPABILITY=PASS
TWO_FACTOR=PASS
ORIGIN_CHECK=FAIL_CLOSED
MUTATION_REQUEST_ID=PASS
SERVICE_AUTHORIZATION=PASS
TASK_NOT_FOUND_CODE=credential_task_not_found
TASK_NOT_FOUND_STATUS=404
SECRET_EXPOSURE=ZERO
MODULE_OWNERSHIP=PASS
BUILD=PASS
TYPECHECK=PASS
LINT=PASS
BACKEND_TESTS=PASS
UI_TESTS=PASS
CPS_STATUS=CLEAN_UNCHANGED
REQUIRED_FIXES=ZERO
NEXT_GATE=P1-12
CPS_CHANNEL_ACCOUNT_PAGE_PARITY=PARITY
CPS_TABLE_PARITY=PARITY
CPS_OPERATION_PARITY=PARITY
CPS_CONFIRMATION_PARITY=EXPLICIT_DIVERGENCE
CPS_STATUS_PARITY=EXPLICIT_DIVERGENCE
CPS_CAPABILITY_PARITY=EXPLICIT_DIVERGENCE
EXPLICIT_DIVERGENCES=6
UNJUSTIFIED_DIVERGENCES=ZERO
```
