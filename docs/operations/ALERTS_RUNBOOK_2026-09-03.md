# RC-7 最小告警链 runbook · 2026-09-03

## 0. 这是什么 / 不是什么

本单把 CPS 短剧（cps-admin，只读参考，v8.3.6 / peeled commit
`16f2e4cfca51f46af0dede899ecf6242a770bbd0`）已实证的"关键词告警"判据与
fail-closed 语义搬到 cps-novel 的 X8 本地 production-like 环境
（`infra/production-like/`），覆盖三条最小告警：

1. `/api/health` 非 200，或 200 但缺 `"ok":true` 关键词。
2. worker 过期处理锁（`docs/operations/LAUNCH_DAY_HEALTH_CHECKS.md` §2 SQL）+
   worker 容器健康状态。
3. 备份成功标记 `x8-backup-last-success` 超过 26 小时未更新。

新增文件全部在 `infra/production-like/alerts/`，本文件是唯一新增的文档。**没有
改动任何既有文件**——`docker-compose.yml`、`backup-timer.sh`、`.env.example`、
`docs/governance/*` 一律未动；下方"接线建议"只是文本片段,由复核者决定是否、
何时落地。

**合规登记（复核轮已补齐）**：仓库 `CLAUDE.md` §2 第 5 条要求"从 CPS 搬运代码
一律复制+改造，并登记 `docs/governance/port-registry.md`"。施工单硬约束禁止改动
`docs/governance/*`，故建单时未登记；**复核轮已在 `port-registry.md` 补上 RC-7
条目**（`baseline_commit` 沿用 RC-1 同一个 v8.3.6 peeled commit
`16f2e4cfca51f46af0dede899ecf6242a770bbd0`），`port_kind` 记为
`COPY_SEMANTICS_ONLY`——判据逐条照搬，载体由 UptimeRobot Keyword 监控改为
脚本 + 占位推送（见 §1.1）。

## 1. 三条判据的 CPS 出处与逐项对应

CPS 短剧本身**没有**一个可以直接复制的"推送脚本"——查过
`git -C <cps-admin> ls-tree -r v8.3.6` 和多轮关键词 grep（`webhook`、`飞书`、
`pushplus`、`uptimerobot` 等），CPS repo 里没有任何 curl-webhook 类推送实现。
CPS 真正的机制是：**HTTP 端点吐出带成功关键词的紧凑 JSON，外部 UptimeRobot
免费版的 Keyword 类型监控做判定和推送**（不是 HTTP 状态码监控）。这段结论直接
来自只读 grep 命中的三处：

| 出处 | 内容 |
| --- | --- |
| `DEVLOG.md:60-78`（v8.3.6 树） | 2026-08 备份连续两晚静默失败事故复盘："外部监控（UptimeRobot）免费版没有 Cron/Heartbeat 类型（付费功能），所以备份结果必须用 HTTP 暴露出来让 Keyword 监控能看见"；"这从来不是检测问题，是没有信号到人"。 |
| `src/app/api/health/backup/route.ts`（v8.3.6 树，头注释） | "这条对外部监控的配置方式有硬性要求：必须用 **Keyword 类型**（判据＝响应体里找不到 `"backupStatus":"ok"` 就报警）...如果有人把监控改成纯 HTTP 状态码类型，`unconfigured` 的 200 会被判为健康，这个端点就退化成又一个'会骗人的监控点'——正是 2026-08-19 事故里 `/api/health` 扮演的角色（它不碰数据库，全站死透 103 分钟期间一路返回 200）"。 |
| `src/lib/health-backup-status.ts`（v8.3.6 树，头注释） | 四态判定表（`ok`/`failed`/`stale`/`unconfigured`）；`DEFAULT_STALE_THRESHOLD_HOURS = 26`，注释："日备每天一次；26 小时 = 24 小时周期 + 2 小时余量，容忍备份窗口本身的抖动...但仍然能在漏跑一整天之内报警"。 |
| `tests/health-backup-route.test.ts:63-65`（v8.3.6 树） | "Keyword-monitor contract: UptimeRobot's Keyword monitor does a raw substring match against the response body, so the exact compact-JSON rendering matters." |

因为 X8 本地栈只监听 `127.0.0.1`，任何外部 SaaS 都够不到它，所以本单**没有**
照搬"外部 UptimeRobot"这个具体载体，而是照搬它背后的**判据契约**（关键词优先
于状态码、探测本身失败也算不健康、26 小时阈值），并在 `alert-lib.sh` 里加了
一个通用出站 webhook 推送，让 Owner 把 `ALERT_PUSH_ENDPOINT`/`ALERT_PUSH_TOKEN`
指到短剧现有告警落地的同一个下游通道（Owner 决定复用现有通道，而不是新建）。

### 1.1 「复用短剧通道」在生产上怎么落（复核补充）

短剧那条链是**拉取式**的：UptimeRobot 定时 GET 端点、在响应体找关键词，通知由它自己发；
CPS 仓里**没有 webhook 接收端**，所以 `ALERT_PUSH_ENDPOINT` 并没有一个「短剧现有下游 URL」
可指——上一段措辞易被读成有，特此更正。生产上复用同一条通道的正确落法是照搬载体：给海阅
公开关键词端点、在同一个 UptimeRobot 账号建 Keyword 监控、复用已配好的通知联系人。
`/api/health` 已具备该形状（`ok` 为首字段，紧凑序列化出 `"ok":true`，失败 503）；
backup / worker 两条**当前没有对应端点**，由 RC-7b 另做，不在本单。
本脚本链因此**不是**那条生产通道的替代品，而是补充：X8 只监听 `127.0.0.1`，外部 SaaS
够不到，故用本地脚本 + 宿主 cron 覆盖同一套判据。两者可并存，判据一致、载体不同。

### 1.2 生产接线（RC-7b 已交付，端点不再缺）

上一段说的「backup / worker 两条当前没有对应端点」已由 RC-7b 补齐。UptimeRobot 建三条
**Keyword** 监控（判据＝响应体里找不到关键词就告警，不要用纯状态码类型）：
`/api/health` → `"ok":true`；`/api/health/backup` → `"backupStatus":"ok"`；
`/api/health/worker` → `"workerStatus":"ok"`。

生产域名 = `https://pulsenovels.com`（冻结，2026-09-03 Owner；见
`docs/operations/PRODUCTION_DOMAIN_2026-09-03.md`）。三条监控的完整 URL：

- `https://pulsenovels.com/api/health`
- `https://pulsenovels.com/api/health/backup`
- `https://pulsenovels.com/api/health/worker`

⚠️ backup 端点由 **web 容器**执行，必须让 web 读得到备份产物目录或状态文件：
`BACKUP_OUTPUT_DIR` 要与 backup 容器的 `X8_BACKUP_OUTPUT_DIR` 指向**同一个挂载**
（现状 `/backups` 只挂进了 `backup-timer`，web 没有），否则该端点恒为 `unconfigured`。

| # | cps-novel 检查脚本 | 判据 | CPS 出处（只读，v8.3.6） | 阈值/来源 |
| --- | --- | --- | --- | --- |
| ① | `check-health.sh` | HTTP 200 且响应体含 `"ok":true` | `src/app/api/health/backup/route.ts` 头注释 + `tests/health-backup-route.test.ts:63-65`（Keyword 而非状态码） | 无（存在性判据） |
| ② | `check-worker-locks.sh` | ①SQL 行数>0 或 psql 探测失败 ②worker 容器 `docker inspect` Health.Status ≠ `healthy` | SQL 逐字来自本仓 `docs/operations/LAUNCH_DAY_HEALTH_CHECKS.md` §2（与 `infra/production-like/launch-day-health-checks.sql` GROUP_2 一致）；"探测失败也报警"的 fail-closed 语义照搬 `health-backup-status.ts` 的"看不懂/看不到=不可信"判定表 | 无（存在性判据） |
| ③ | `check-backup-freshness.sh` | 备份成功标记 mtime 超过阈值,或标记不可读 | `src/lib/health-backup-status.ts` `DEFAULT_STALE_THRESHOLD_HOURS = 26` | `93600` 秒 = 26 小时,逐字沿用 CPS 默认值 |

## 2. 交付文件清单

```
infra/production-like/alerts/alert-lib.sh              共享推送/去抖/fail-closed 库
infra/production-like/alerts/check-health.sh            告警①
infra/production-like/alerts/check-worker-locks.sh       告警②（两个子检查）
infra/production-like/alerts/check-backup-freshness.sh   告警③
infra/production-like/alerts/run-all.sh                  串行跑①②③，互不影响
infra/production-like/alerts/drill.sh                     演练脚本（keyword-flip 法）
docs/operations/ALERTS_RUNBOOK_2026-09-03.md              本文件
```

所有脚本 `set -euo pipefail`；`run-all.sh`/`drill.sh` 顶部写的是 `set -uo pipefail`，
**但复核实测 errexit 实际仍是开的**——`source alert-lib.sh` 会把 `-e` 重新打开，
且每个 `check-*.sh` 退出自己的 `set +e; ...; set -e` 探测块时也会把 `-e` 还原。
所以"某个检查失败后继续跑剩下的检查"这条契约，是靠每个调用点的 `|| ...` 兜住的，
不是靠没有 `-e`；改这两个脚本时必须保持每个检查调用都带 `||` 守卫。为兼容本机
`/bin/bash` 3.2（macOS 默认版本，无 `declare -A`）与目标容器/生产 Linux 主机
的 bash，全部脚本只用索引数组、`${var:-}`/`${var:=}`、`[[ =~ ]]`，不用关联
数组或 4.x 专属语法。

## 3. env 占位清单（Owner 部署时填入）

推送通道（不落地任何真实值，纯占位）：

| 变量 | 用途 | 默认值 |
| --- | --- | --- |
| `ALERT_PUSH_ENDPOINT` | 出站 webhook URL；Owner 决定复用短剧现有告警落地的同一个下游通道 | 未设置时不真正推送，只记日志 |
| `ALERT_PUSH_TOKEN` | 若下游通道需要 `Authorization: Bearer <token>` | 未设置时不带该 header |
| `ALERT_PUSH_TIMEOUT_SECONDS` | 单次推送超时 | `10` |

判据相关：

| 变量 | 用途 | 默认值 |
| --- | --- | --- |
| `HEALTH_URL` | `/api/health` 探测地址 | `http://127.0.0.1:3000/api/health` |
| `HEALTH_CURL_TIMEOUT_SECONDS` | curl 超时 | `10` |
| `ALERT_DATABASE_URL` | **只读** `analyst_ro` 角色连接串；见下方"角色纪律" | 无默认值，未设置时该检查本身触发 fail-closed 告警 |
| `ALERT_COMPOSE_PROJECT` | compose project 名，用于推导容器名 | `cps-novel-x8-local`（与 `scripts/x8-production-like.sh` 的 `P1_12_COMPOSE_PROJECT` 一致） |
| `ALERT_WORKER_CONTAINER_NAME` | worker 容器名 | `${ALERT_COMPOSE_PROJECT}-worker-1` |
| `ALERT_PSQL_TIMEOUT_SECONDS` | psql 连接超时（`PGCONNECT_TIMEOUT`） | `15` |
| `ALERT_BACKUP_MARKER_PATH` | 备份成功标记在容器内的路径 | `/tmp/x8-backup-last-success`（`backup-timer.sh` 的 `touch` 目标） |
| `ALERT_BACKUP_CONTAINER_NAME` | backup-timer 容器名 | `${ALERT_COMPOSE_PROJECT}-backup-timer-1` |
| `ALERT_BACKUP_MARKER_HOST_PATH` | 可选：若未来把标记 bind-mount 到宿主机，设此变量直接读宿主路径，跳过 `docker exec` | 未设置（默认走容器内路径） |
| `ALERT_BACKUP_MAX_AGE_SECONDS` | 备份陈旧阈值 | `93600`（26h，见上表来源） |

去抖/状态：

| 变量 | 用途 | 默认值 |
| --- | --- | --- |
| `ALERT_STATE_DIR` | 去抖状态与告警计数器文件目录 | `/tmp/cps-novel-alerts` |
| `ALERT_DEBOUNCE_SECONDS` | 同一告警键多久内不重复推送 | `900`（15 分钟） |
| `DRY_RUN` | `1` 时只打印不真推送；`drill.sh` 强制为 `1` | `0` |

### 角色纪律（照搬 `LAUNCH_DAY_HEALTH_CHECKS.md` 的红线）

`ALERT_DATABASE_URL` 必须用 `analyst_ro` 角色，绝不能用 `migration_owner` 或
任何写角色。`scripts/x8-production-like.sh:276` 的 `run_health_sql()` 实测过
`analyst_ro` 在角色层就带 `default_transaction_read_only = on`，所以本单的
`check-worker-locks.sh` 不需要再手工包一层 `BEGIN READ ONLY`。

## 4. 接线建议（未落地，供复核者裁决）

给两条可选片段，二选一即可；不建议同时接两条（避免同一告警重复触发两次
debounce 窗口）。

### 方案 A：compose 里加一个 `alerts` 服务（推荐）

理由：与现有 `backup-timer`/`nginx` 服务同构，容器网络内可直接用服务名访问
`web:3000`（不必依赖宿主机 `127.0.0.1` 端口映射），且能直接 `docker exec` 到
`backup-timer`/`worker`（同一个 compose network 内可以直接用容器名，不需要
`ALERT_COMPOSE_PROJECT` 推导）。落地前需要额外挂 docker socket 才能做
`docker inspect`，这是需要复核者评估的安全面（只读 socket 挂载即可，但仍是
容器逃逸风险的常见路径，短剧生产环境是否已有类似先例需要复核者核实）。

```yaml
# 建议片段，未落地。加入 infra/production-like/docker-compose.yml 前需要
# custodian（按 CLAUDE.md §3.3，Dockerfile/compose/CI/infra/ 的合并人是
# Codex）评审，尤其是 docker.sock 只读挂载的安全影响。
  alerts:
    image: ${X8_NGINX_IMAGE:-nginx:1.28.0-alpine}  # 占位基础镜像；真正落地时应换成
                                                     # 已含 bash/curl/psql client 的镜像，
                                                     # 例如复用 app 镜像本身。
    restart: unless-stopped
    entrypoint: ["/bin/sh", "-c"]
    command:
      - |
        while true; do
          bash /opt/cps-novel-x8/alerts/run-all.sh || true
          sleep "${ALERT_POLL_INTERVAL_SECONDS:-300}"
        done
    environment:
      HEALTH_URL: http://web:3000/api/health
      ALERT_DATABASE_URL: ${ALERT_DATABASE_URL:?ALERT_DATABASE_URL is required}
      ALERT_WORKER_CONTAINER_NAME: ${P1_12_COMPOSE_PROJECT}-worker-1
      ALERT_BACKUP_CONTAINER_NAME: ${P1_12_COMPOSE_PROJECT}-backup-timer-1
      ALERT_PUSH_ENDPOINT: ${ALERT_PUSH_ENDPOINT:-}
      ALERT_PUSH_TOKEN: ${ALERT_PUSH_TOKEN:-}
    volumes:
      - ./infra/production-like/alerts:/opt/cps-novel-x8/alerts:ro
      - /var/run/docker.sock:/var/run/docker.sock:ro   # 只读挂载；仍需复核者评审
    networks:
      - runtime
```

### 方案 B：宿主 cron（更简单，但依赖宿主机装了 psql/docker CLI）

```cron
# 建议片段，未落地；crontab -e 需 Owner 授权后手工加入，不由本单代为写入。
*/5 * * * * ALERT_DATABASE_URL='postgresql://analyst_ro:***@127.0.0.1:5432/cps_novel' \
  ALERT_PUSH_ENDPOINT='***' ALERT_PUSH_TOKEN='***' \
  /bin/bash /path/to/infra/production-like/alerts/run-all.sh >> /var/log/cps-novel-alerts.log 2>&1
```

方案 B 更快接线（不改 compose、不用挂 docker socket 到新容器——宿主机本来就
能跑 `docker inspect`/`docker exec`），但要求宿主机常驻装了 `psql` 客户端；
本机核实过 `psql`/`shellcheck` 都不在当前开发机上（见下方门禁记录），生产/
预发宿主机是否已装未核实，接线前需要确认。

**两条都不落地**：本单硬约束禁止改 `docker-compose.yml` 或写宿主 crontab，
以上均为文本建议，落地时机与形式由复核者决定。

## 5. 演练（drill）

```bash
DRY_RUN=1 bash infra/production-like/alerts/drill.sh
```

`drill.sh` 照搬用户记忆里记录的 CPS "关键词翻转演练法"（不碰生产，翻转监控
期望看到的东西、确认告警触发），做成完全本地、自包含的版本：

- 关键词翻转本身：直接对两段写死的 JSON 字符串（含 `"ok":true` / 不含）调用
  `is_health_body_ok`，不发起任何网络请求。
- 另外 5 个场景把每个真实检查函数指向"本机一定连不上/一定不存在"的目标——
  未监听的本地端口 `127.0.0.1:1`、不存在的 docker 容器名、脚本自建自删的临时
  文件——断言 `alert_fire` 被调用（通过 `alert-lib.sh` 的文件计数器
  `alert_fire_total()`，不解析日志文本）。`docker inspect` 是只读命令，不会
  改变任何容器状态。
- 全程 `DRY_RUN=1` 强制生效（脚本顶部拒绝 `DRY_RUN` 被设成非 `1` 的调用），
  且用独立的 `ALERT_STATE_DIR`（`mktemp -d`），跑完自动清理，不碰真实去抖
  状态目录 `/tmp/cps-novel-alerts`。

演练 8 项全部 PASS（详见下方门禁记录）。

### 定期演练建议

建议每次改动 `alerts/` 目录后、或每次 `infra/production-like/` 升级 Postgres/
compose 版本后，重跑一次 `drill.sh` 作为回归；不需要接入 cron（演练不是常驻
监控本身）。

## 6. 误报处理

- **`worker_container_unhealthy` 在容器刚起来时可能误报**：`docker-compose.yml`
  里 worker 的 healthcheck 有 `start_period: 10s`、`retries: 3`，本检查没有
  重试预算，第一次探测如果恰好落在 `start_period` 窗口内可能看到非
  `healthy` 状态。处理：先看 `docker inspect` 的 `FailingStreak`，如果在
  `start_period` 之内且随后自愈，判为误报，不需要动作；如果持续不愈，才按
  真实故障处理。
- **`backup_marker_missing`（docker-exec 分支）在容器刚启动、还没跑过第一次
  备份前会短暂触发**：`backup-timer.sh` 的 `X8_BACKUP_RUN_ON_START` 默认
  `true`，正常情况下容器起来后很快会有第一次 `run_backup()`；如果长期
  `missing`，才是真事故（对应 CPS 语义里更严重的 `unconfigured` 态,详见
  `health-backup-status.ts` 头注释关于 `unconfigured` 语义收窄的说明）。
- **`worker_lock_probe_failed` 里出现 `psql: command not found`**：这不是
  数据库真的探测到问题，是运行 `check-worker-locks.sh` 的宿主/容器没装
  `psql` 客户端——即代码没有捕获到 `psql`（我们的 x8 假设 psql 是可用的，
  必须先满足）。落地前必须先确认执行环境装了 `psql`（见第 4 节两个接线方案
  各自的前提）。
- **debounce 掩盖了重复告警,但一次都没送达过**：`alert_fire` 只在推送成功
  时才写去抖状态文件（见 `alert-lib.sh` 里的注释),且 **`DRY_RUN=1` 一律不写、
  也不清除**去抖状态（复核修复：否则用默认 `ALERT_STATE_DIR` 做一次 dry-run
  冒烟，会在 `/tmp/cps-novel-alerts` 留下 `.last_sent`，把随后 15 分钟内的真实
  告警静默掉——dry-run 绝不能让真实链路变安静）。所以"送达失败"不会被误判
  成"已经报过不用再报"；如果发现某个 key 长期不报,先查
  `${ALERT_STATE_DIR}/<key>.last_sent` 是否存在、`ALERT_PUSH_ENDPOINT` 是否
  配置。

## 7. 已知局限 / 未验证项

- **本机没有 `shellcheck`**：门禁改用 `bash -n` 做语法检查（六个脚本全部
  通过）；没有安装 `shellcheck`（不在本单授权范围内做环境变更），建议复核者
  在有 `shellcheck` 的机器上补跑一次 `shellcheck infra/production-like/alerts/*.sh`。
- **本机没有 `psql`**：`check-worker-locks.sh` 的 SQL 探测分支未在真实
  PostgreSQL 上跑过；`drill.sh` 里对应场景验证的是"psql 不可用/连不上"这条
  fail-closed 路径本身（`command not found` 走的也是 exit≠0 分支），不是
  "SQL 语句本身能正确返回行数"这条路径。SQL 文本逐字来自
  `docs/operations/LAUNCH_DAY_HEALTH_CHECKS.md` §2，与
  `infra/production-like/launch-day-health-checks.sql` 的 GROUP_2 一致，语法
  层面可信，但建议复核者在真实 X8 环境跑一次 `run-all.sh`（非 DRY_RUN）验证
  行数判据。
- **`ALERT_PUSH_ENDPOINT` 未接线前，所有告警只记日志不真正送达任何人**：这是
  预期状态（Owner 决定复用短剧现有通道，具体端点/token 由 Owner 在部署时
  填入,本单不知道也不应该知道那个值）。
- ~~`docs/governance/port-registry.md` 未登记本单四条 CPS 出处~~：**复核轮已补登记**
  （RC-7 小节，`COPY_SEMANTICS_ONLY`），见第 0 节。
- **`fail_closed_run` 辅助函数**：`alert-lib.sh` 里提供,`check-backup-freshness.sh`
  的 docker-exec 分支实际调用了它；其余检查脚本用的是等价的内联
  `set +e; ...; rc=$?; set -e` 模式（先写好再决定要不要抽成公共辅助,两种写法
  在这六个脚本里都已验证过在 subshell/debounce 计数器场景下的正确性——本单
  构建期间就是靠 `drill.sh` 抓到了一处计数器在 subshell 里丢失的真实 bug
  并修复,见 `alert-lib.sh` 里 `alert_fire_total_file` 一段的注释)。
