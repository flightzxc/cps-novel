# SEC-CREDENTIAL-KEY-ROTATION-2026-09-01 · V1→V2

基线：`e9ee680`。本 runbook 只覆盖 Security 线；Claim 线独立进行。执行记录中禁止出现
key、ciphertext、token、JWT；fingerprint 只允许 12 位 `fingerprint_prefix`。

## 不变量与停线条件

- Web 只加密新提交的 secret，不得读取或解密已存密文；Worker 是唯一持久化密文消费者。
- AAD 继续绑定 `(channelAccountId, credentialId)`；信封版本必须与 `key_version` 列一致。
- fingerprint key 与加密 key 分离，P0-1 只把原 fingerprint key 的同一份字节迁入 secret
  文件。不得生成替代材料；不得重算历史 fingerprint。
- `credential_change_log` 与所有凭证行原样保留。本轮不 tombstone superseded secret material。
- `scripts/x8-import-moboreader-canary-credential.mjs` 已永久禁用。重录必须走
  `/channel-accounts` 的 add/replace。
- 第 7 步未得到 Worker validation `success`，禁止执行第 8 步。
- 第 8 步后若 Web/Worker 正常流量出现任何 Credential 解密错误，立即停线并报告；这表示存在
  未登记的 superseded 密文消费者。

## 0. 执行前准备

1. 在受保护的部署目录准备两个 mode `0600` 的文件：V1 加密 key 文件与 fingerprint key
   文件。内容分别逐字节复制现有部署的 V1 和 fingerprint 材料，不生成新值，不在终端显示。
   若旧材料已有受保护的文件来源，用 `cmp -s old-file new-file` 只记录退出状态，不记录摘要。
2. 从 Web/Worker 的 Compose `environment` 删除旧的
   `CHANNEL_CREDENTIAL_ENCRYPTION_KEY_V1` 与 `CHANNEL_CREDENTIAL_FINGERPRINT_KEY`；应用启动预检
   会主动拒绝这些旧变量。
3. 设置主机侧路径变量：

   ```text
   CHANNEL_CREDENTIAL_ENCRYPTION_KEY_V1_FILE=/protected/path/credential-v1.key
   CHANNEL_CREDENTIAL_FINGERPRINT_KEY_FILE=/protected/path/credential-fingerprint.key
   CHANNEL_CREDENTIAL_ACTIVE_KEY_VERSION=1
   ```

   路径不是 secret；文件内容才是 secret。

## 1. 部署 P0-1，ACTIVE=1

用更新后的 `docker-compose.yml` 重建/部署镜像，并强制重建 Web 与 Worker 容器，使 secret 挂载
和 env 路径生效。不要用 `docker compose restart`，它不会应用新的容器配置。

```bash
docker compose config --quiet
docker compose up -d --force-recreate web worker
docker compose ps web worker
```

Web 启动前执行 `scripts/credential-secret-preflight.ts`；Worker 在连接数据库、开始领取任务之前
执行同一预检。两者都必须正常运行，且日志中可见 `CREDENTIAL_SECRET_PREFLIGHT=PASS`（Web）。
此时数据库行为不变，active 仍写 V1。

## 2. 生成 V2 secret 文件

在受保护的部署 secret 目录执行；保持 shell tracing 关闭，命令不会输出材料：

```bash
set +x
umask 077
v2_temporary=/protected/path/credential-v2.key.tmp
openssl rand 32 | openssl base64 -A >"$v2_temporary"
chmod 600 "$v2_temporary"
mv "$v2_temporary" /protected/path/credential-v2.key
```

不要读取或打印该文件。应用预检会验证它是 canonical 32-byte base64。

## 3. 同时注入 V1 与 V2，ACTIVE 仍为 1

在部署 Compose 中给 Web 和 Worker 各增加：

```yaml
environment:
  CHANNEL_CREDENTIAL_ENCRYPTION_KEY_V2_FILE: /run/secrets/channel_credential_encryption_key_v2
secrets:
  - channel_credential_encryption_key_v2
```

并在顶层 `secrets:` 增加：

```yaml
channel_credential_encryption_key_v2:
  file: ${CHANNEL_CREDENTIAL_ENCRYPTION_KEY_V2_FILE:?CHANNEL_CREDENTIAL_ENCRYPTION_KEY_V2_FILE is required}
```

主机设置 `CHANNEL_CREDENTIAL_ENCRYPTION_KEY_V2_FILE` 为第 2 步的受保护文件路径，保持
`CHANNEL_CREDENTIAL_ACTIVE_KEY_VERSION=1`，然后：

```bash
docker compose config --quiet
docker compose up -d --force-recreate web worker
docker compose exec -T worker tsx scripts/p0-1-verify-v1-superseded-readable.ts
```

最后一条是受限的一次性只读探针：只在 ACTIVE=1 且 V1/V2 都已声明时选择一条
`status='superseded' AND key_version=1` 行，用解密后的明文重算 full fingerprint 并与该行
`secret_fingerprint` 完整比对，然后立即丢弃明文。输出只包含
`encryptionKeyMaterial=PASS`、`fingerprintKeyMaterial=PASS`、版本号和最多 12 位
fingerprint prefix；不输出 full fingerprint、密文或明文。必须同时得到
`result=PASS` 与两项材料 `PASS`；任一比对失败都必须停在第 4 步之前。不得把该探针移到
第 4 步之后运行。

首次执行还必须做一次 fingerprint 故障注入：在一次性探针进程中把
`CHANNEL_CREDENTIAL_FINGERPRINT_KEY_FILE` 临时指向另一份合法但不同的 32-byte 材料，
确认只得到 `P0_1_V1_SUPERSEDED_READBACK=FAIL`；随后恢复原路径并再次确认两项
`PASS`。故障注入全程不得打印材料、full fingerprint、密文或明文。

### P0-1 守卫反向自证（2026-09-02）

在 X8 本地 production-like 数据库的一次性 Worker 进程中完成；没有改变长驻
Web/Worker 容器的环境或数据：

1. 指向原 fingerprint 文件：`result=PASS`、`encryptionKeyMaterial=PASS`、
   `fingerprintKeyMaterial=PASS`。
2. 仅对一次性探针进程临时指向另一份已存在的不同 fingerprint 材料：
   退出码 `1`，唯一探针输出为 `P0_1_V1_SUPERSEDED_READBACK=FAIL`。
3. 恢复原 fingerprint 文件：两项材料检验再次 `PASS`，允许输出的
   12 位 prefix 与第 1 步相同。

自证输出未包含任何 key 材料、full fingerprint、密文或明文。

## 4. Web 写入切到 V2

把 `CHANNEL_CREDENTIAL_ACTIVE_KEY_VERSION` 改为 `2`，只强制重建 Web；Worker 保持第 3 步
已加载的 V1+V2 keyring，即可按每行 `key_version` 解密。

```bash
docker compose config --quiet
docker compose up -d --force-recreate web
docker compose ps web worker
```

回滚点仍开放：失败时把 ACTIVE 改回 `1`，保留 V1/V2，强制重建 Web。

## 5. Owner 在 UI 重录唯一 active

Owner 打开 `/channel-accounts`，对唯一 active 凭证执行“替换凭证”，在浏览器粘贴新 token。
确认调用正式 `replaceCredentialAction` → `addOrReplaceCredential` 路径。不得运行已禁用的裸 SQL
导入器。成功后页面只显示脱敏元数据。

## 6. 核对行版本与 latch

只执行下列元数据查询；将 `<account-uuid>` 替换为本次账户 UUID。查询不读取 secret、ciphertext
或完整 fingerprint：

```sql
SELECT status, key_version, count(*) AS row_count
FROM channel_account_credential
WHERE channel_account_id='<account-uuid>'::uuid
GROUP BY status, key_version
ORDER BY status, key_version;

SELECT c.status, c.key_version, left(c.fingerprint_prefix, 12) AS fingerprint_prefix
FROM channel_credential_active_fingerprint AS latch
JOIN channel_account_credential AS c ON c.id=latch.credential_id
WHERE latch.channel_account_id='<account-uuid>'::uuid;
```

必须精确满足：一行 active/V2；四行 superseded/V1；latch 仅指向该 active/V2 行。任何其他状态、
版本或基数都停线调查，不删除或修补历史行。

## 7. Worker 端到端 validation 必须转绿

在 `/channel-accounts` 对新的 active/V2 凭证点击“校验凭证”。确认生成
`credential.validate.v1` 任务，等待 Worker 完成。UI 必须显示 success；也可用以下只读元数据
查询交叉核对最近任务：

```sql
SELECT status, success_count, failed_count
FROM generic_task
WHERE task_type='credential.validate.v1'
  AND channel_account_id='<account-uuid>'::uuid
ORDER BY created_at DESC
LIMIT 1;
```

唯一通过条件是 `status='success' AND success_count=1 AND failed_count=0`。fingerprint 变化或
`updated_at` 刷新均不构成 Worker key 可用证据。

## 8. 不可回滚点：discard V1

只有第 7 步通过后才执行：从 Web/Worker 删除
`CHANNEL_CREDENTIAL_ENCRYPTION_KEY_V1_FILE`，从各自 `secrets:` 删除
`channel_credential_encryption_key_v1`，从顶层 `secrets:` 删除 V1 声明；保留 V2 与 fingerprint
secret。安全删除主机 V1 secret 文件后，强制重建 Web 与 Worker：

```bash
docker compose config --quiet
docker compose up -d --force-recreate web worker
docker compose ps web worker
```

确认服务健康并观察 Web/Worker 正常任务日志。不要再运行 V1 superseded 只读探针。正常业务若出现
任何 Credential 解密错误，立即停止后续操作并报告；不得临时恢复裸密钥 env。

## 回滚界线

- 第 5 步成功提交之前：ACTIVE 改回 `1`，保留 V1/V2 secret，强制重建 Web；旧 active/V1
  仍保持 active 且可解。
- 第 5 步成功提交之后、第 8 步之前：旧 V1 行已经是 superseded，禁止把它直接复活。V2 仍挂载，
  所以新的 active/V2 行仍可服务；若必须回到 V1 存储，先把 ACTIVE 改回 `1` 并强制重建 Web，
  再由 Owner 通过 add/replace 重录，生成一条新的 active/V1 行。
- 第 8 步之后：按本工单定义不可回滚。superseded 行、`credential_change_log` 和其他非秘密审计
  信息全部保留。

## 独立登记，不纳入本工单

`FIRST_FULL_CATALOG_APPLY_BLOCKER=YES` 仅阻断首次全量 apply 目录扫描，不升级为 production
release blocker；页间节流与只读限流窗口探测另立工单。
