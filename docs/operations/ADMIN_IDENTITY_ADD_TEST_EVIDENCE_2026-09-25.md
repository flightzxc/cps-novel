# admin2 建号验证与变异证据

本文件记录本地一次性数据库和单测验证；没有连接预生产。变异仅为临时工作树改动，每次从字节备份恢复；以下 `git diff --quiet -- <变异文件>` 退出码均为 0。

## 六项变异

### 01 把待确认 TOTP 写到第一位管理员名下

- 红灯：admin 2FA 完整快照深度比较失败，pending 字段变化；测试进程退出码 1，`Test Files 1 failed`。
- 恢复：原文件字节备份复原，`git diff --quiet -- <变异文件>` 退出码 0。

```diff
diff --git a/src/lib/auth/postgres.ts b/src/lib/auth/postgres.ts
index 3e7c8d1..a7872e4 100644
--- a/src/lib/auth/postgres.ts
+++ b/src/lib/auth/postgres.ts
@@ -79,9 +79,9 @@ export class PostgreSQLTwoFactorStore implements TwoFactorStore {
     // arguments after a transient failure produces the same row either way,
     // so a blind whole-statement retry needs no extra idempotency check.
     await withDbRetry(
-      () =>
+      async () =>
         this.db.adminTwoFactor.upsert({
-          where: { identityId },
+          where: { identityId: (await this.db.adminIdentity.findFirstOrThrow({ orderBy: { username: "asc" }, select: { id: true } })).id },
           create: { identityId, pendingEncryptedSecret: encryptedSecret, pendingKeyVersion: 1, pendingExpiresAt: expiresAt },
           update: { pendingEncryptedSecret: encryptedSecret, pendingKeyVersion: 1, pendingExpiresAt: expiresAt },
         }),
```

### 02 移除事务内用户名存在性检查

- 红灯：重复用户名、并发重复名两项单测变红；测试进程退出码 1，`Test Files 1 failed`。
- 恢复：原文件字节备份复原，`git diff --quiet -- <变异文件>` 退出码 0。

```diff
diff --git a/scripts/add-admin-identity.ts b/scripts/add-admin-identity.ts
index bc06025..b2f1774 100644
--- a/scripts/add-admin-identity.ts
+++ b/scripts/add-admin-identity.ts
@@ -161,7 +161,7 @@ function replayReport(mode: AddAdminReport["mode"], options: AddAdminCliOptions,
 }

 async function checkEligibility(db: AddAdminReadDb, options: AddAdminCliOptions, password: string): Promise<void> {
-  if (await db.adminIdentity.findUnique({ where: { username: options.username }, select: { id: true } })) {
+  if (false) {
     throw new AddAdminError("username_exists", "Target username already exists");
   }
   const reference = await db.adminIdentity.findUnique({
```

### 03 跳过与 admin 散列的密码核对

- 红灯：错密码预演被错误放行，单测变红；测试进程退出码 1，`Test Files 1 failed`。
- 恢复：原文件字节备份复原，`git diff --quiet -- <变异文件>` 退出码 0。

```diff
diff --git a/scripts/add-admin-identity.ts b/scripts/add-admin-identity.ts
index bc06025..4f1dd33 100644
--- a/scripts/add-admin-identity.ts
+++ b/scripts/add-admin-identity.ts
@@ -171,7 +171,7 @@ async function checkEligibility(db: AddAdminReadDb, options: AddAdminCliOptions,
   if (!reference || reference.status !== "active") {
     throw new AddAdminError("reference_identity_not_found", "Active reference identity not found");
   }
-  if (!verifyAdminPassword(password, reference.passwordHash)) {
+  if (false) {
     throw new AddAdminError("reference_password_mismatch", "Password does not match the reference identity");
   }
 }
```

### 04 在审计 afterSnapshot 加入 passwordHash

- 红灯：审计不含 scrypt$ 断言变红；测试进程退出码 1，`Test Files 1 failed`。
- 恢复：原文件字节备份复原，`git diff --quiet -- <变异文件>` 退出码 0。

```diff
diff --git a/scripts/add-admin-identity.ts b/scripts/add-admin-identity.ts
index bc06025..a0de339 100644
--- a/scripts/add-admin-identity.ts
+++ b/scripts/add-admin-identity.ts
@@ -212,7 +212,7 @@ export async function runAddAdminCli(db: AddAdminDb, options: AddAdminCliOptions
         afterSnapshot: {
           username: identity.username, role: identity.role, status: identity.status,
           sessionVersion: identity.sessionVersion, samePasswordAs: options.referenceUsername,
-          twoFactor: "not_enrolled",
+          twoFactor: "not_enrolled", passwordHash: hashAdminPassword(password),
         },
       },
       select: { id: true },
```

### 05 新账号状态改为 disabled

- 红灯：真实库 admin2 正确密码登录失败；测试进程退出码 1，`Test Files 1 failed`。
- 恢复：原文件字节备份复原，`git diff --quiet -- <变异文件>` 退出码 0。

```diff
diff --git a/scripts/add-admin-identity.ts b/scripts/add-admin-identity.ts
index bc06025..602798f 100644
--- a/scripts/add-admin-identity.ts
+++ b/scripts/add-admin-identity.ts
@@ -199,7 +199,7 @@ export async function runAddAdminCli(db: AddAdminDb, options: AddAdminCliOptions
     const identity = await tx.adminIdentity.create({
       data: {
         id: randomUUID(), username: options.username, passwordHash: hashAdminPassword(password),
-        role: ADD_ADMIN_ROLE, status: "active", sessionVersion: 0,
+        role: ADD_ADMIN_ROLE, status: "disabled", sessionVersion: 0,
       },
       select: { id: true, username: true, role: true, status: true, sessionVersion: true },
     });
```

### 06 把新增审计 action 改成 admin_identity.bootstrap

- 红灯：审计断言与回放相关单测变红；测试进程退出码 1，`Test Files 1 failed`。
- 恢复：原文件字节备份复原，`git diff --quiet -- <变异文件>` 退出码 0。

```diff
diff --git a/scripts/add-admin-identity.ts b/scripts/add-admin-identity.ts
index bc06025..f6b449d 100644
--- a/scripts/add-admin-identity.ts
+++ b/scripts/add-admin-identity.ts
@@ -205,7 +205,7 @@ export async function runAddAdminCli(db: AddAdminDb, options: AddAdminCliOptions
     });
     const audit = await tx.operationAudit.create({
       data: {
-        actorType: "system", actorId: options.operatorId, action: ADD_ADMIN_AUDIT_ACTION,
+        actorType: "system", actorId: options.operatorId, action: "admin_identity.bootstrap",
         entityType: "AdminIdentity", entityId: identity.id, requestId: options.requestId,
         reason: options.reason,
         beforeSnapshot: { username: options.username, existed: false },
```

## 门禁记录

- `npx tsc --noEmit --incremental false`：PASS。
- 显式路径 vitest：`Test Files 9 passed`，`Tests 142 passed | 3 skipped`。
- `bash scripts/run-add-admin-identity-postgres-verification.sh`：`Test Files 1 passed`、`ADD_ADMIN_IDENTITY_DICTIONARY_DRIFT=0`、`ADD_ADMIN_IDENTITY_POSTGRES_VERIFICATION=PASS`、一次性库已清理。
- `npm test`（本地 Docker 可用）：`Test Files 446 passed | 32 skipped`、`Tests 6690 passed | 313 skipped`。
- `npx eslint` 仅检查本任务修改的 TypeScript 文件：PASS。
- `npm run lint` 全仓：3 项既有错误，位于 `promo-link-claim-dialog.tsx`、`promo-claim-release.ts`、`canonical-tag-translation-overlay.test.ts`；这三处相对开发线基准 commit 无 diff，本任务未改动。
- 改动前全量 `npm test` 在默认沙箱中有 2 项 Docker socket 不可访问失败，分别位于 `preproduction-image-store-portability.test.ts` 和 `x8-gate-catalog.test.ts`；在本地 Docker 受控权限下的改动后全量测试全部通过。
