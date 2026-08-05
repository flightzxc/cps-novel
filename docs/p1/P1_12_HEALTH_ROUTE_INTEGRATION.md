# P1-12 · Health Route 与前后端契约接入交付报告

> 主责：Claude（`src/app/**` 侧）　|　Reviewer：Codex（运行时侧）
> 分支：`feature/v0.1.0-p1-12-integration`
> 基线：`bee6a32cb855477202e107c04a09258a85877801`（Codex 运行时分支 HEAD）
> 上一段基线：`4e0a4b9c97d21c127c23475bb0cf99ea7c706397`（P1-11 结束点）
> 状态：本地提交，未 push、未合入 `main`、未部署、未触碰任何生产数据库

---

## 1. 本轮交付了什么

Codex 已在 `feature/v0.1.0-p1-12-runtime` 上冻结了四容器编排、不可变构建元数据烘焙、
Scheduler 凭证密钥隔离，以及健康检查的**领域类型与服务实现**。但那一段没有 HTTP 出口——
`docker-compose.yml` 的 web healthcheck 打的是
`wget http://127.0.0.1:3000/api/health`，而这个路径此前并不存在。

本轮只补这一件事：把冻结的服务接到 Next Route Handler 上。

| # | 交付物 | 落点 |
| --- | --- | --- |
| ① | `GET /api/health` Route Handler | `src/app/api/health/route.ts`（新增，40 行） |
| ② | Route 契约测试（11 条） | `tests/ui/health-route-contract.test.ts`（新增） |
| ③ | 本报告 | `docs/p1/P1_12_HEALTH_ROUTE_INTEGRATION.md` |

**没有交付的**（有意）：没有新增契约文件、没有改任何 Codex 目录、没有改构建/依赖配置。
本分支相对 `bee6a32` 的 tracked diff 为 0 行修改 + 3 个新增文件。

---

## 2. Route Handler 只做两件事

```
getHealthReport(prisma) → HealthReport → { HTTP status, Cache-Control }
```

`HealthReport` 的全部语义（版本 / commit / builtAt / flag 快照 / DB 连通 / 元数据一致性）
都在 Codex 的 `src/server/health/service.ts` 里决定。Handler 不重算、不改写、不包装：

| Handler 拥有的决策 | 取值 |
| --- | --- |
| HTTP 状态 | `report.ok ? 200 : 503` |
| 缓存头 | 恒为 `Cache-Control: no-store` |

`report.ok` 的定义是「`reasons` 为空」，因此**元数据缺失、元数据格式错误、
env 版本/commit 声明缺失、env 与烘焙身份不一致、DB 超时、DB 不可达**这六类失败
全部落到同一个 503，无需 Handler 自行分类——这是刻意的，分类一旦复制到 Handler
就会和服务端漂移。

### 2.1 响应体逐字段就是 `HealthReport`

不包 `data` / `result` / `success` / `message`，不改名，不增删字段。
实测（下文 §5.2）响应体顶层键恰为：

```
ok, status, build, featureFlags, metadataConsistency, database, reasons
```

### 2.2 为什么没有 try / catch 兜底

任务卡允许保留一道 unexpected exception 防线。**本轮选择不加**，理由是服务侧已经
把「预期失败」全部内化：

- 元数据读取整段包在 `try / catch` 里，`ENOENT` 与解析失败分别映射成
  `build_metadata_missing` / `build_metadata_malformed`；
- DB 探针写作 `Promise.resolve().then(() => database.$queryRaw(...))`，
  **同步抛出也会变成 rejection**，再被 `.then(onOk, onErr)` 收成 `unreachable`；
  超时由 `Promise.race` 兜住，收成 `timeout`。

也就是说 `getHealthReport` 对调用方是 never-throws 的。若在 Handler 里补一层
`catch`，它能捕获的只剩「模块加载失败 / Prisma 引擎缺失」这类连 Route 都进不去的情况，
而那种情况下**无法构造出一个诚实的 `HealthReport`**——`HealthReasonCode` 里没有
「路由自身崩了」这一项，硬套 `database_unreachable` 是撒谎，另造一个非 `HealthReport`
的错误体则是引入第二套响应合同。任务卡 §4 对这种情形的指示是优先依赖 never-throws
合同并在报告中说明，本节即为该说明。

> 若后续 Codex 认为需要这道防线，正确做法是在 `HEALTH_REASON_CODES` 里加一个
> `route_unexpected_error`（服务侧改动，Codex 所有），而不是在 Handler 里造壳。

---

## 3. 数据库客户端：复用，不新建

Handler 从 `../admin/_lib/deps` 取共享 `prisma`。

**为什么是这个模块**：`P1_MODULE_OWNERSHIP.md` §1 的 2026-08-04 修订把
`src/app/api/**` 划给 Claude，并明确「P1-09 的后台服务接线放在 `src/app/api/admin/_lib/`」，
`src/lib/db/**` 至今只有 README 占位（Codex 所有，未实现）。因此进程内唯一的共享
`PrismaClient` 就在 `deps.ts:20`。`src/app/(admin)/channel-accounts/page.tsx:9` 已有
跨目录引用它的先例（`../../api/admin/_lib/deps`），本轮沿用同一写法。

**类型兼容性**：服务声明 `HealthDatabaseClient = Pick<PrismaClient, "$queryRaw">`，
`deps.prisma` 声明为 `PrismaClient`，结构化子类型直接可赋值，**无需任何适配层、无需
在 `src/app` 内自建 client**。`npm run typecheck` 零报错即为该结论的机器证据。

**为什么不新建**：健康探针若自开连接池，报告的就是应用从不使用的那条连接，
探针会在应用连接耗尽时依然返回绿灯。测试 `probes through the shared client instead of
building its own` 用对象身份断言（`harness.databaseArgument === prisma`）把这条钉死。

---

## 4. 安全边界

| 项 | 结论 | 依据 |
| --- | --- | --- |
| 是否需要登录 | **否** | 容器内 healthcheck 无 session、无 cookie jar |
| 是否进 Admin registry | **否，且结构上不可能** | `resolveAdminRoute` 先判 `segmentMatch(normalized, "/api/admin")`，非该前缀一律返回 `null`；`AdminRouteRegistration.path` 的类型是模板字面量 `` `/api/admin/${string}` ``，`/api/health` 连编译期都注册不进去 |
| 是否读 secret | **否** | Handler 源码不含 `process.env` 与任何密钥名；`featureFlags` 由服务侧 `HEALTH_FEATURE_FLAG_ALLOWLIST`（当前为空数组）决定，任意 env key 永不反射 |
| 是否从 env 重算身份 | **否** | `build.*` 只来自烘焙文件；env 仅作为 `metadataConsistency.runtimeClaims` 里的 claim 被比对 |
| 是否回显驱动信息 | **否** | 测试注入 `connect ECONNREFUSED 10.0.0.5:5432 password=hunter2`，断言响应体不含 `ECONNREFUSED` 也不含 `hunter2`——错误文本止步于服务层 |
| 是否写库 | **否** | 唯一 DB 交互是服务层的只读 `SELECT 1 AS ok` |
| 是否暴露其他方法 | **否** | 只导出 `GET`；实测 `POST` 返回 405 |

一个可预期的公开面：未登录访问可读到 `version` / `commit` / `builtAt`。这是
`P1_ARCHITECTURE_EXECUTION_PACKAGE.md:218` 定义的健康检查内容本身（对标 CPS `v7.9.5`
事故治理），不是本轮新增的泄漏面。若 P2 要求收敛，收敛点应在 compose 的端口发布策略
（当前 web 只发布到 `127.0.0.1`）或反代层，而不是往 Handler 里塞鉴权——塞了容器内
healthcheck 就废了。

---

## 5. 验证

### 5.1 命令

| 命令 | 结果 |
| --- | --- |
| `npm run build` | ✅ 通过 |
| `npm run typecheck` | ✅ 通过 |
| `npm run lint` | ✅ 通过（exit 0，零输出） |
| `npm run test:ui` | ✅ 20 files / 348 tests 全绿 |
| `npm test` | ✅ 45 files 通过、5 files 跳过（Postgres integration，本机无库）；534 passed / 55 skipped |

`next build` 的路由清单把 `/api/health` 标为 `ƒ (Dynamic) server-rendered on demand`，
**不在 `○ (Static)` 也不在 `● (SSG)` 之列**——静态生成被排除是编译产物证据，不是靠读源码推断。

### 5.2 真实 HTTP 实测（本机，隔离端口，指向死 DB）

用 `DATABASE_URL=postgresql://…@127.0.0.1:5433/nonexistent`（该端口无监听）在 3117 端口起
`next start`，未接触任何生产库：

```
HTTP/1.1 503 Service Unavailable
cache-control: no-store
content-type: application/json

{"ok":false,"status":"unhealthy","build":{"version":null,"commit":null,"builtAt":null},
 "featureFlags":{},"metadataConsistency":{"status":"failed","runtimeClaims":
 {"version":"0.1.0","commit":"bee6a32…"}},"database":{"status":"failed",
 "reason":"unreachable","durationMs":0},"reasons":["build_metadata_missing","database_unreachable"]}
```

三点被这一次实测确认：503 状态、`no-store` 头、响应体未被包装。
`build_metadata_missing` 是**预期**的——`/app/.build-metadata.json` 只在镜像里存在，
容器外必然缺失。healthy 200 路径由单测覆盖（注入临时烘焙文件），真实容器内的 200
留给 Codex 的四容器 E2E。

`POST /api/health` 实测 405，确认只暴露 `GET`。

### 5.3 边界确认

- Codex 所有文件（`Dockerfile` / `docker-compose.yml` / `infra/**` / `scripts/**` /
  `src/server/**` / `src/domain/**` / `prisma/**` / `worker/**` / `scheduler/**`）
  增量 **0**：`git diff --name-status bee6a32` 输出为空；
- `package.json` / `package-lock.json` / `tsconfig*` / `next.config.ts` / `eslint.config.mjs` /
  `vitest.config.ts` 均未改；
- 运行时分支 `feature/v0.1.0-p1-12-runtime` 工作区仍干净，HEAD 仍为 `bee6a32`；
- CPS 参照工作区 `cps-admin-v811-search-ux` 工作区干净，HEAD 仍为 `d77c3b9`。

---

## 6. 两处需要 Codex 确认的口径

### 6.1 没有新增 `src/contracts/health.ts`

任务卡允许在「现有项目架构明确要求对外契约入口时」加一层薄类型导出。本轮判断为
**不需要**，理由三条：

1. `HealthReport` 已在 `src/domain/health.ts`——零 import 的叶子模块，
   与 `src/contracts/README.md` 已放行值引用的 `@/domain/database-statuses` 同类；
2. `src/contracts/**` 的定位是「跨所有权边界、**双方实现相互依赖**」的类型。
   本轮 `/api/health` 没有浏览器消费者：唯一消费者是 compose 里的 `wget`；
3. `src/contracts/README.md` 硬纪律第 2 条要求契约对应已实施后端形状且有依据。
   为一个尚不存在的前端消费者预建入口，正是该纪律要防的事。

Handler 用 `import type { HealthReport } from "@/domain/health"` 直接标注返回形状，
编译期真源唯一，**零字段复制**。若 P2 出现前端健康面板，届时再在 `src/contracts/health.ts`
加 `export type { HealthReport } from "@/domain/health"` 这一行别名即可，仍不复制字段。

### 6.2 Route 测试放在 `tests/ui/` 而不是 `src/app/api/health/route.test.ts`

任务卡举例的落点是 `src/app/api/health/route.test.ts`。**实际落在
`tests/ui/health-route-contract.test.ts`**，因为 `vitest.config.ts` 的两个 project
include 分别只有 `tests/ui/**` 与 `tests/backend|integration/**`——放在 `src/` 下的测试
不会被任何 project 收集，会变成一个永不执行的死文件。

三条路都试过了：改 `vitest.config.ts` 属本轮禁改范围；写进 `tests/backend/**` 是 Codex 目录，
明令禁止；剩下 `tests/ui/**`（任务卡 §7 允许，条件是「已有测试纪律确实要求」）。
`vitest.config.ts` 的注释把 `tests/ui` 定义为「Claude 独占」，且该目录已有
`admin-secret-boundary` / `admin-nav-parity` / `no-hardcoded-colors` 等**非 DOM 的静态边界测试**
先例，语义相容。

测试用真实的 `createHealthService`（仅重定向元数据路径与 env 来源）驱动路由，
不是手写假 report——因此这 11 条断言和 Codex 的
`tests/backend/health/p1-12-health-service.test.ts` 说的是同一个 report。

覆盖：healthy→200、env 与烘焙身份不一致→503、元数据缺失→503、DB 探针失败→503、
响应体未包装未改名、两种状态下均为 `no-store`、`runtime === "nodejs"`、
`dynamic === "force-dynamic"`、共享 client 身份、无 session 且不在 admin registry、
源码不含 `process.env` 与密钥名、只暴露 `GET`。

---

## 7. 下一道门

`RESULT=P1_12_HEALTH_ROUTE_READY_FOR_CODEX_E2E`

留给 Codex 的四容器 HTTP E2E：

1. 容器内 `/api/health` 返回 **200**（本机无法验证，因为烘焙文件只在镜像里）；
2. web healthcheck 由 starting 转 healthy，四容器全绿；
3. 故意用错的 `APP_VERSION` / `GIT_COMMIT` 启动 web，确认 `/api/health` 检出
   `runtime_version_mismatch` / `runtime_commit_mismatch` 并返回 503，
   且 compose healthcheck 因 `wget` 非零退出而判 unhealthy——这条正是验收标准 ⑤；
4. 停掉 postgres，确认 `/api/health` 转 503 且理由为 `database_unreachable` 或 `database_timeout`。
