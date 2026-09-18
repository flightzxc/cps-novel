# X8-BACKUP-PGPASS-RECONCILE-2026-09-18

修复 X8 `backup_role` pgpass 生成，使 `pg_basebackup` 的物理复制连接能找到密码。只改
`scripts/lib/x8-production-like-env.sh` 与测试；`wal-retention.sh` / `wal-gc-x8.sh` /
`backup-timer.sh` / compose / `pg_hba.conf` / PG 配置 / LaunchAgent 均未改动。

## 1. 缺陷现象

backup-timer 的逻辑备份（`pg_dump -d cps_novel`）一直 PASS，但物理基础备份
（`pg_basebackup`）报错：

```text
fe_sendauth: no password supplied
```

服务端没有问题：`backup_role` 已有 `REPLICATION` 属性，`pg_hba.conf` 已有
`host replication backup_role 172.18.0.0/16 scram-sha-256`，探测早已通过。

## 2. 根因

libpq 的 `.pgpass` 匹配规则里，一条物理复制连接（`pg_basebackup`
`--replication` / `replication=true`）的 "database" 字段不是调用者传入的任何数据库
名，而是**字面字符串 `replication`**。

修复前，`X8_BACKUP_PGPASS_FILE`（`scripts/lib/x8-production-like-env.sh` 旧代码，见下）
只在文件不存在时写一行：

```text
postgres:5432:cps_novel:backup_role:<pw>
```

这一行只匹配 `pg_dump -d cps_novel` 那种逻辑连接。`pg_basebackup` 发起的物理复制连接
去匹配 pgpass 时，找不到 database 字段为 `replication` 的任何一行，libpq 直接判定
"没有可用密码"，认证甚至没有真正发出密码就失败了 —— 这和服务端配置无关。

## 3. 修法

`scripts/lib/x8-production-like-env.sh` 新增 `x8_reconcile_backup_pgpass()`，取代原来
"文件不存在才创建"的一次性逻辑，改为**每次 `prepare_x8_environment()` 都执行的幂等
reconcile**：

- 目标内容固定为两行，且 reconcile 每次写出时**规范行永远排在最前**：
  ```text
  postgres:5432:cps_novel:backup_role:<pw>
  postgres:5432:replication:backup_role:<pw>
  ```
  （其后才是保留下来的其它行 —— 见下一条。这是 libpq first-match-wins 之上的第二道
  结构性保险，即便未来出现某条这里没识别出来的行恰好会撞库字段，first-match-wins 也
  先撞到规范行。）
- 这个函数自己**只会写**那两条精确规范行，永不生成 `postgres:5432:*:backup_role:`
  这类通配写法。但 2026-09-18 Opus 复核（P1-2）之前，reconcile 的删除规则只精确匹配
  这两条规范行本身，遗漏了一类真实风险：文件里**已经存在**的一条更宽的历史/手改行
  （例如 `postgres:5432:*:backup_role:<旧密码>`、`*:*:*:backup_role:<旧密码>`）如果
  恰好排在规范行前面，libpq 的 first-match-wins 会一直命中那条更宽、密码已过期的
  旧行，规范行形同虚设 —— 症状和"reconcile 什么都没做"完全一样，难以从日志分辨。
  P1-2 收紧为：**先删除**文件中所有前四个 `:` 字段满足
  `host∈{postgres,*}、port∈{5432,*}、db∈{cps_novel,replication,*}、user=backup_role`
  的行（共 12 种精确组合，只有第 5 段密码值允许任意），**再**把两条规范行写在最前。
  这 12 种里被删掉、但**不是**两条精确规范行本身的行，才计入"影子规则"，向 stderr
  打印一行 `X8_BACKUP_PGPASS_WARN=removed_shadowing_rules count=<n>`（从不打印内容/
  密码）；两条规范行本身的例行重写（场景 B/D/E 的正常升级/轮换）不计数、不告警。
- 不删除、也不改写这 12 种精确组合**之外**的任何行（大小写不同、host/port/db 拼写
  不同、缺字段、前导空白等"近似行"）—— libpq 的 pgpass 匹配是逐字节精确比较，这类
  近似行本来就不可能撞库遮蔽规范行，删它没有事实依据，纯属臆测。这类行与其它无关的
  host/role pgpass 记录一样，原样保留、相对顺序不变；reconcile 从不整文件重建。
- 目标内容与现有文件字节完全一致时**不写**（打印 `X8_BACKUP_PGPASS=UNCHANGED`，inode
  不变）；需要变更时才通过 `mktemp`（同目录）+ `chmod 600` + `mv -f` 原子替换，任何一步
  失败都不留半文件、不留 `*.tmp*` 残留、原文件字节不变。
- 文件已存在但当前进程**读不到**（外部用户拥有、0 权限等）时直接拒绝：打印 `ERROR:
  ... not readable` 并返回 65，不做任何写入。把"读不到"当成"文件不存在"去覆盖，会在
  连内容都没看到的情况下销毁掉可能正是需要人工介入的东西（操作员的无关记录、或者正是
  上面 P1-2 要抓的那类陈旧影子规则）。
- 密码只经变量流转，不出现在命令行参数或任何输出；函数内部对 `xtrace` 做防御性
  开关，调用方即使开着 `set -x` 也不会把密码打到 trace 行。

新函数、测试与三次变异验证细节见提交记录；本文档不重复贴代码。

## 4. 迁移场景 A–F（reconcile 幂等性覆盖）

| 场景 | 输入 | reconcile 结果 |
| --- | --- | --- |
| A | 文件不存在 | 恰好写两行，顺序 cps_novel → replication |
| B | 旧版单行文件（只有 cps_novel 一行） | 升级为两行，不重复，不告警 |
| C | 已是两行的正确文件，重跑 | 内容不变、打印 `UNCHANGED`、inode 不变 |
| D | 密码轮换（`backup_role.password` 内容变化后重跑） | 两行都换成新密码，旧密码字符串从文件中彻底消失 |
| E | 重复/陈旧行（cps_novel 出现两次 + 一条旧密码的 replication 行） | 收敛为每条规则各恰一行，取当前密码，不告警 |
| F | 影子通配行（如 `postgres:5432:*:backup_role:`、`*:*:*:backup_role:`）与无关行/近似行混杂 | 通配行全部删除并计数告警；无关行、近似行（如大小写不同的 `POSTGRES:5432:cps_novel:backup_role:...`）原样保留；两条规范行写在文件最前 |

场景 F 是 P1-2（2026-09-18 Opus 复核）新增，测试见
`tests/backend/runtime/x8-backup-pgpass-reconcile.test.ts` 的
"P1-2 shadowing-wildcard rule removal" describe 块；P2-1（不可读文件拒绝写入）与
P2-4（无尾换行兜底）另有各自的 describe 块，不并入 A–F 表格。

## 5. 部署说明

按顺序执行，**不得跳步**。

### ① 合并后先跑一次 X8 环境准备，让宿主 pgpass 更新

`x8_reconcile_backup_pgpass()` 挂在 `prepare_x8_environment()` 里 —— **注意不是**
`prepare_x8_gate_environment()`。这两个函数名字很像但完全不同：`status`/`gate` 这一族
子命令（`status_x8()`、`gate_catalog()` 等）走的都是后者，后者只检查
`$X8_BACKUP_PGPASS_FILE` 是否存在，**从不调用 reconcile**，跑
`scripts/x8-production-like.sh status` 不会触发本次修复的任何代码路径（这是本文档
早先版本的一处错误，已改正）。真正会触发 `prepare_x8_environment()`、从而跑一次
reconcile 的最小入口是以下两种之一：

**(a) 推荐：`wal-gc --json`（只读 dry-run，不带 `--apply` 就不会删除任何 WAL）**

```bash
X8_LEVEL=uat scripts/x8-production-like.sh wal-gc --json
```

`wal_gc()` 在 exec 进容器跑 `wal-gc-x8.sh` 之前会先调用一次
`prepare_x8_environment()`，reconcile 的 `X8_BACKUP_PGPASS=...`/
`X8_BACKUP_PGPASS_WARN=...` 状态行随之打到 stderr（下面 ② 直接查文件即可核验，无需
从这条命令的输出里解析）。

**(b) 仅想触发 reconcile 本身、不想跑任何容器命令**

```bash
X8_LEVEL=uat bash -c 'source scripts/x8-production-like.sh; prepare_x8_environment'
```

`scripts/x8-production-like.sh` 文件末尾的子命令分发只在"被直接执行"
（`BASH_SOURCE[0] == $0`）时才跑；`source` 它只是定义函数，不会落进那个分发块，所以
这条命令不会因为缺参数报 usage 错误，纯粹只是把 `prepare_x8_environment` 调一遍。

### ② 核验宿主 pgpass 恰有两条 backup_role 规则，且排在最前 —— 报告必须脱敏

直接读文件，不依赖上一步用哪条命令触发的 reconcile。若尚未 `source` 过
`scripts/lib/x8-production-like-env.sh`（该库文件定义 `$X8_BACKUP_PGPASS_FILE`），
用绝对路径：

```bash
awk -F: '{print $1":"$2":"$3":"$4":<redacted>"}' \
  "/Users/chenweifeng/Documents/cps海阅/integration-night/.tmp/x8-production-like/secrets/backup.pgpass"
```

或者先 source 库文件再用变量（两者指向同一个文件）：

```bash
source scripts/lib/x8-production-like-env.sh
awk -F: '{print $1":"$2":"$3":"$4":<redacted>"}' "$X8_BACKUP_PGPASS_FILE"
```

期望输出**恰好两行，且是文件的第 1、2 行**（P1-2 之后 reconcile 把规范行写在最前，
其它保留行排在后面）：

```text
postgres:5432:cps_novel:backup_role:<redacted>
postgres:5432:replication:backup_role:<redacted>
```

如果输出行数多于两行，多出来的行本身不是问题（可能是无关的 host/role pgpass 记录，
reconcile 原样保留）；但如果前两行不是这两条规范行，或者 stderr 里出现过
`X8_BACKUP_PGPASS_WARN=removed_shadowing_rules`，要回头确认那条被删的影子规则是否
本该存在（例如是不是有人手改过这个文件）。

**禁止**把密码原文贴进任何执行记录、日志或报告。

> `X8_BACKUP_PGPASS=UNCHANGED`/`RECONCILED`、`X8_BACKUP_PGPASS_WARN=...` 这几行状态
> 输出都走 stderr，不走 stdout（函数头部注释里有完整理由）。本地 `wal-gc --json`
> 日常自动化（`infra/local-x8/wal-gc-daily-apply.sh`）用 `2>&1` 把每一步的合并输出
> 整段存进 `.tmp/x8-production-like/wal-gc-daily/<stamp>-<step>.txt` 证据文件，这几行
> 会跟着一起进去；operator/脚本对这些证据文件的解析（`parse_planned_delete`/
> `refused_line` 等）全都是对 `^WAL_RETENTION...` 做锚定行 `grep`，不是整文件当 JSON
> 解析，所以多出来的 pgpass 状态行混在同一个证据文件里不影响任何现有解析逻辑。

### ③ Recreate backup-timer 容器 —— 不能只 restart

`infra/production-like/docker-compose.yml` 把 `X8_BACKUP_PGPASS_FILE` 以**单文件 bind
mount**（`:ro`）挂到 backup-timer 容器的 `/run/x8-secrets/backup.pgpass`；容器启动时
`backup-timer.sh` 再 `cp` 一份到 `/tmp/x8-backup.pgpass`。reconcile 每次改变内容都是通过
`mktemp` + `mv -f` **原子替换**，也就是**换了一个新 inode**。已经创建好的容器，其单文件
bind mount 绑定的是创建时那个旧 inode，`docker compose restart` 只是重跑容器里的
entrypoint、不会重新解析 compose 里的挂载源，所以看不到新文件。**必须执行：**

```bash
docker compose -f infra/production-like/docker-compose.yml up -d --no-deps backup-timer
```

（`--no-deps` 避免连带重建 postgres 或其它服务；Owner 明确要求用 `recreate` 而非
`restart`，即使 `restart` 在个别 Docker/文件系统组合下可能巧合地看到新内容，也不作为
生产步骤使用。）

### ④ postgres 不需要 restart/recreate

服务端配置（`backup_role` 权限、`pg_hba.conf`）已经存在且已验证正确，本次修复只动
客户端凭据文件的内容，postgres 容器不需要任何操作。

### ⑤ recreate 后应重新走完整链路验证

backup-timer 的 `RUN_ON_START` 那一轮（或次日的定时触发）应重新完整跑通
物理基础备份 → verify → timer dry-run 三步，预期依次看到：

```text
PHYSICAL_BASE_BACKUP=CREATED_NOT_PITR_VALIDATED   # scripts/db/backup-physical-base.sh
PHYSICAL_BASE_VERIFY=PASS                          # scripts/db/verify-physical-base.sh
WAL_RETENTION=DRY_RUN planned_delete=<n>           # scripts/db/wal-retention.sh
```

`fe_sendauth: no password supplied` 不应再出现。

### ⑥ 若仍然失败 —— 继续 fail-closed，禁止绕过

若 recreate 之后物理基础备份仍然失败，按 fail-closed 原则处理：**禁止**把 pgpass 规则改
成通配（`postgres:5432:*:backup_role:`），**禁止**改用 `PGPASSWORD` 环境变量绕过
pgpass 文件。回到根因排查（服务端 `pg_hba.conf`/角色权限是否被后续变更覆盖、密码文件本身
是否为空/损坏），不得为了让备份"看起来跑通"而放宽凭据匹配的精确性。

> **本轮未改动的一处已知例外**：`scripts/x8-production-like.sh` 的 `base_backup_now()`
> （约 :1815，`printf '*:*:*:backup_role:%s\n' "$password" >"$pgpass"` 那一行）在
> **postgres 容器内部**、用 `mktemp` 现场写一份 `*:*:*:backup_role:` 通配 pgpass，走
> unix socket（`PGHOST=/var/run/postgresql`），EXIT trap 删除，只服务这一次 exec，
> 用完即焚。这和本文档通篇讨论的宿主持久 `$X8_BACKUP_PGPASS_FILE`（bind mount 进
> backup-timer 容器、每次 `prepare_x8_environment()` 都 reconcile）是两个完全独立的
> 文件、两条独立的生命周期，互不影响：它不是本次修复的对象（本次修复范围仅
> `x8_reconcile_backup_pgpass()`、其测试、本文档），继续沿用通配写法。列为后续工单：
> 把 `base_backup_now()` 容器内的临时 pgpass 也收窄为
> `postgres:5432:cps_novel:backup_role:`/`postgres:5432:replication:backup_role:`
> 两条精确规则，与宿主侧保持同一套纪律。

## 6. 参考

- 根因位置：`scripts/lib/x8-production-like-env.sh`（`x8_reconcile_backup_pgpass()`，
  `prepare_x8_environment()` 调用点）
- 消费者：`infra/production-like/docker-compose.yml`（backup-timer 服务的 volumes 段）、
  `infra/production-like/backup-timer.sh`
- 测试：`tests/backend/runtime/x8-backup-pgpass-reconcile.test.ts`
