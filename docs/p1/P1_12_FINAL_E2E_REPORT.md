# P1-12 最终四容器 HTTP E2E 与本地合入门禁报告

> 分支：`feature/v0.1.0-p1-12-integration`  
> 被审 HEAD：`dbede54cac2a8bf1b367cfca9dbb0e5d4060ba72`  
> Runtime HEAD：`bee6a32cb855477202e107c04a09258a85877801`  
> Main ref：`4e0a4b9c97d21c127c23475bb0cf99ea7c706397`  
> 日期：2026-08-05（Asia/Tokyo）  
> 结论：`P1_12_FINAL_E2E_PASS`

本轮只使用本地 Docker Desktop 的隔离网络与一次性 PostgreSQL volume；未连接生产数据库，
未部署，未 push。最终保留精确应用镜像供复核，四容器、测试网络和测试数据卷均已删除。

## 1. 增量事实核查

- integration worktree 初始 clean，HEAD 精确为 `dbede54cac2a8bf1b367cfca9dbb0e5d4060ba72`；
- `main` ref 精确为 `4e0a4b9c97d21c127c23475bb0cf99ea7c706397`；
- runtime worktree clean，`feature/v0.1.0-p1-12-runtime` 仍指向
  `bee6a32cb855477202e107c04a09258a85877801`；
- `bee6a32..dbede54` 仅新增：
  - `src/app/api/health/route.ts`
  - `tests/ui/health-route-contract.test.ts`
  - `docs/p1/P1_12_HEALTH_ROUTE_INTEGRATION.md`
- Claude 未修改 Codex-owned runtime 文件；`package.json` 和 `package-lock.json` 无增量；
- 指定 CPS 只读 worktree `cps-admin-v811-search-ux` clean，HEAD 为
  `d77c3b968285698529cf97c7f0f97b286d7a2a9c`，
  `SOP_ACK=54c3e49433ca05f5129afe1bda74d4e39b88cba175b1cd6a18ebb26c4f3704fd`。

主仓库的主检出当前在另一条 `feature/v0.1.0-p1-schema` 分支，并含一个既存未跟踪文档；
它不是 `main` checkout，本轮未触碰。上述 main 结论指向精确的 `refs/heads/main`。

## 2. Route 与导入链复核

`src/app/api/health/route.ts` 只导出 `GET`，固定 `runtime="nodejs"`、
`dynamic="force-dynamic"`，直接返回原始 `HealthReport`，以 `report.ok` 映射 200/503，
并固定 `Cache-Control: no-store`。Handler 无认证、无 Admin registry 接入、无 env 身份重算、
无数据库写入，也不创建第二个 PrismaClient。

导入链 `health/route.ts -> admin/_lib/deps.ts` 的模块加载结果：

- 只创建并导出进程级共享 `PrismaClient`；
- Admin identity/session store 只在 `guardDependencies()` 被调用时实例化；Health Route 不调用；
- registry 为冻结的静态对象；
- 不读取 Admin session、TOTP、recovery、credential fingerprint 或解密密钥；
- 不初始化上游 Credential 服务，不执行查询或写入，无无关模块加载副作用。

结论：`ROUTE_IMPORT_SIDE_EFFECTS=NONE`，`ADMIN_SECRET_DEPENDENCY=NONE`。

## 3. 不可变镜像

| 项 | 实测值 |
| --- | --- |
| Image | `cps-novel:0.1.0-dbede54` |
| Image ID | `sha256:7a51757c13d6bd8f310be5169e2592ab194c9aaba1561d6fb02183062d80149e` |
| Architecture | `amd64`（arm64 主机使用冻结的 `linux/amd64` 仿真构建） |
| Runtime user | `nextjs`，Compose 固定 `1001:1001` |
| Baked metadata | `version=0.1.0`；`commit=dbede54cac2a8bf1b367cfca9dbb0e5d4060ba72`；`builtAt=2026-08-05T08:22:12Z` |
| Metadata mode | `/app/.build-metadata.json` 为 `0444` |
| OCI labels | version、revision、created 与 baked metadata 完全一致 |

另以错误 `APP_VERSION`/`GIT_COMMIT` 运行无网络的一次性容器读取 metadata，文件值仍为上述
baked identity，证明运行时 env 不能覆盖镜像身份。没有创建或使用 `latest` 标签。

## 4. 正常四容器状态

启动走仓库正式路径：
`P1_12_COMPOSE_PROJECT=cps-novel-p1-12-final-e2e P1_12_WEB_PORT=31212 bash scripts/p1-12-compose-up.sh`。

| 容器 | Image ID | 状态（正常态） | Restart | 长期运行身份 | DB role | Published port |
| --- | --- | --- | ---: | --- | --- | --- |
| `cps-novel-p1-12-final-e2e-postgres-1` | `sha256:eb9fe6b58155…` | running / healthy | 0 | PID 1 UID 999 | postgres server | 无 |
| `cps-novel-p1-12-final-e2e-web-1` | `sha256:7a51757c13d6…` | running / healthy | 0 | 1001:1001 | `web_app` | `127.0.0.1:31212->3000` |
| `cps-novel-p1-12-final-e2e-worker-1` | `sha256:7a51757c13d6…` | running / healthy | 0 | 1001:1001 | `worker_app` | 无 |
| `cps-novel-p1-12-final-e2e-scheduler-1` | `sha256:7a51757c13d6…` | running / healthy | 0 | 1001:1001 | `scheduler_app` | 无 |

一次性 migration-owner 容器只执行了一次 `prisma migrate deploy`，找到并应用 3 个迁移；
随后执行现有 `grants.sql`。长期运行应用进程均未使用 migration owner。Compose 解析结果只有
postgres/web/worker/scheduler 四服务；无 SQLite、无 `env_file`、无 latest fallback，四服务均为
`json-file` 10m × 3，Postgres 无宿主机端口，Web 仅 loopback，Worker/Scheduler 无业务端口。

P1-12 closeout 已删除 runtime 阶段遗留的 Health 阻断提示；该变更只移除状态噪音，
不改变脚本控制流。真实 Web healthcheck 和 HTTP 均已在本报告验证为 healthy/200。

## 5. Health HTTP E2E

### 5.1 正常态

连续两次 `GET http://127.0.0.1:31212/api/health` 均为：

- HTTP 200，`cache-control: no-store`，`content-type: application/json`；
- 顶层直接为 `ok/status/build/featureFlags/metadataConsistency/database/reasons`，无包装；
- `ok=true`、`status=healthy`；
- baked identity 两次完全相同，`builtAt` 不变化；
- metadata consistency passed，database passed，reasons 为空，`featureFlags={}`；
- Web 的 `pg_stat_activity` 连接数请求前后均为 1；PrismaClient/pool 警告数为 0；
- 响应和日志均不含 DSN、password、token、JWT、credential key、stack 或 Prisma 原始错误。

### 5.2 runtime identity 错配

使用同一 Image ID，仅把 Web claims 设为 `APP_VERSION=99.99.99-mismatch` 和 40 位错误 commit：

- Web 进程正常启动，HTTP 503，Docker healthcheck 最终 `unhealthy`；
- `build.version=0.1.0`、`build.commit=dbede54…`、`builtAt` 保持 baked 值；
- runtime claims 显示错误声明；
- reasons 精确且有序：`runtime_version_mismatch`、`runtime_commit_mismatch`；
- 恢复正确 claims 后不重建镜像即恢复 HTTP 200 / Docker healthy。

### 5.3 数据库故障与恢复

停止 Postgres 但保留 volume 后：

- HTTP 503，完整响应耗时 0.017124s；
- `database.status=failed`、`database.reason=unreachable`；
- reasons 为 `database_unreachable`；
- 响应无 DSN、地址、密码、Prisma stack，Web healthcheck 最终 `unhealthy`。

重启同一 Postgres 容器后：

- Postgres 恢复 healthy，Web 不重建镜像即自动恢复 HTTP 200 / healthy；
- Worker 在停库窗口由 `restart: unless-stopped` 自动重启 10 次，数据库恢复后稳定回到
  running / healthy；Scheduler 始终由进程 healthcheck 保持 running / healthy；
- Postgres volume 中已完成迁移数恢复前后均为 3，六个角色完整；未重复迁移或改写 schema。

## 6. 进程密钥隔离与 Feature flags

真实容器只检查变量名、不打印值：

- Scheduler 敏感变量名：`NONE`；
- Worker：存在 `CHANNEL_CREDENTIAL_ENCRYPTION_KEY_V1`、
  `CHANNEL_CREDENTIAL_FINGERPRINT_KEY` 和冻结的 `WORKER_TASK_ALLOWLIST`，无 TOTP key；
- Web：存在 P1-08 已批准的 TOTP、Credential encryption V1 与 fingerprint key；
- 全部容器日志与本轮生成 secret 值逐项比对：0 matches；
- Compose 无 `env_file`，Scheduler 不会间接获得密钥。

仓库中未发现已实施的 `FEATURE_*` runtime 消费者；
`HEALTH_FEATURE_FLAG_ALLOWLIST=[]` 与公开 `featureFlags={}` 是有意的 fail-closed 设计，
没有 dump `process.env`，无需补充虚构 flag。

## 7. 完整门禁与清理

| 门禁 | 结果 |
| --- | --- |
| `docker compose config` | PASS |
| 精确 amd64 Docker build | PASS |
| `npm run build` | PASS；`/api/health` 为 dynamic route |
| `npm run typecheck` | PASS |
| `npm run lint` | PASS |
| `npm run test:backend` | 24 files / 176 passed / 0 failed |
| `npm run test:ui` | 20 files / 348 passed / 0 failed |
| `npm test` | 45 files passed、5 skipped；534 passed、55 skipped、0 failed |

清理使用 Compose 正式路径 `down --volumes --remove-orphans`，project name 固定为
`cps-novel-p1-12-final-e2e`：

- 本轮容器残留：0；
- 本轮网络残留：0；
- 本轮 volume 残留：0；
- migration 临时 env 文件残留：0；
- 保留本地不可变镜像 `cps-novel:0.1.0-dbede54`；
- 未影响其他项目容器、网络、卷或生产资源。

## 8. 结论

`RESULT=P1_12_FINAL_E2E_PASS`

`REQUIRED_FIXES=NONE`

`NEXT_GATE=P1_12_LOCAL_MAIN_MERGE`
