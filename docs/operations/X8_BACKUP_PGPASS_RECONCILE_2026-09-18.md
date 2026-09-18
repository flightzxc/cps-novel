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

- 目标内容固定为两行，顺序固定：
  ```text
  postgres:5432:cps_novel:backup_role:<pw>
  postgres:5432:replication:backup_role:<pw>
  ```
- 只精确匹配并重写 `^postgres:5432:(cps_novel|replication):backup_role:` 这两条规则；
  不使用、也永不生成 `postgres:5432:*:backup_role:` 这类通配写法（会误吞未来任何
  `postgres:5432:<其它库>:backup_role:` 行）。
- 文件中其它任何行（无关的 host/role pgpass 记录、历史遗留内容）原样保留、位置不变；
  reconcile 从不整文件重建。
- 目标内容与现有文件字节完全一致时**不写**（打印 `X8_BACKUP_PGPASS=UNCHANGED`，inode
  不变）；需要变更时才通过 `mktemp`（同目录）+ `chmod 600` + `mv -f` 原子替换，任何一步
  失败都不留半文件、不留 `*.tmp*` 残留、原文件字节不变。
- 密码只经变量流转，不出现在命令行参数或任何输出；函数内部对 `xtrace` 做防御性
  开关，调用方即使开着 `set -x` 也不会把密码打到 trace 行。

新函数、测试与三次变异验证细节见提交记录；本文档不重复贴代码。

## 4. 迁移场景 A–E（reconcile 幂等性覆盖）

| 场景 | 输入 | reconcile 结果 |
| --- | --- | --- |
| A | 文件不存在 | 恰好写两行，顺序 cps_novel → replication |
| B | 旧版单行文件（只有 cps_novel 一行） | 升级为两行，不重复 |
| C | 已是两行的正确文件，重跑 | 内容不变、打印 `UNCHANGED`、inode 不变 |
| D | 密码轮换（`backup_role.password` 内容变化后重跑） | 两行都换成新密码，旧密码字符串从文件中彻底消失 |
| E | 重复/陈旧行（cps_novel 出现两次 + 一条旧密码的 replication 行） | 收敛为每条规则各恰一行，取当前密码 |

## 5. 部署说明

按顺序执行，**不得跳步**。

### ① 合并后先跑一次 X8 环境准备，让宿主 pgpass 更新

`x8_reconcile_backup_pgpass()` 挂在 `prepare_x8_environment()` 里，任何会走
`prepare_x8_environment` 的子命令都会触发它，包括只读查询命令。最小、无副作用的入口是：

```bash
scripts/x8-production-like.sh status
```

（`up` 也会触发，但会带来一次完整的环境准备/健康检查流程，不是这里需要的最小验证步骤。）

### ② 核验宿主 pgpass 恰有两条 backup_role 规则 —— 报告必须脱敏

```bash
awk -F: '{print $1":"$2":"$3":"$4":<redacted>"}' "$X8_BACKUP_PGPASS_FILE"
```

期望输出恰好两行：

```text
postgres:5432:cps_novel:backup_role:<redacted>
postgres:5432:replication:backup_role:<redacted>
```

**禁止**把密码原文贴进任何执行记录、日志或报告。

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

## 6. 参考

- 根因位置：`scripts/lib/x8-production-like-env.sh`（`x8_reconcile_backup_pgpass()`，
  `prepare_x8_environment()` 调用点）
- 消费者：`infra/production-like/docker-compose.yml`（backup-timer 服务的 volumes 段）、
  `infra/production-like/backup-timer.sh`
- 测试：`tests/backend/runtime/x8-backup-pgpass-reconcile.test.ts`
