# P1-08B Contract Handoff to Claude

本文件是后端已实现形状的精确交接；Codex 未修改 `src/contracts/**`，正式 DTO 由 Claude merge
custodian 落地。App Route Handler 与 UI 仍不在本轮范围。

## Registered Admin routes and actions

所有 mutation 必须通过 registry、Admin Session、`credential:manage`、当前 Session 2FA、
same-origin、UUID `x-request-id` 和 guard-issued service authorization；service 会异步重读
Session/identity 并核对 entryId/requestId。

Routes：

- `GET /api/admin/channel-accounts`
- `POST /api/admin/channel-accounts/create`
- `POST /api/admin/channel-accounts/disable`
- `POST /api/admin/channel-accounts/enable`
- `GET /api/admin/credentials/metadata`
- `POST /api/admin/credentials/validate`
- `POST /api/admin/credentials/supersede`
- `GET /api/admin/credential-tasks/status`

Actions：

- `admin.channel_account.create|disable|enable`
- `admin.credential.validate|supersede`

Replace Route/Action 未登记；secret ingress 获批前返回默认 404。create/validate 不要求人工
reason；disable/enable/supersede 必填，trim 后最大 1000 字符。未来 replace 必填 reason。

## Request fields

- Account create: `channelId`, `businessId`, `accountName`, `mutationRequestId`。
- Account status: `channelAccountId`, `reason`, `mutationRequestId`。
- Credential validate/supersede: `channelAccountId`, `credentialId`, `mutationRequestId`，supersede
  另含 `reason`。
- Task query: `taskId`；metadata query: `channelAccountId`。

禁止任何任务/审计 DTO 包含 secret、ciphertext、完整 fingerprint/JWT 或上游原始响应。

## Response shapes

```ts
type CredentialQueuedResult = {
  code: "credential_validation_queued";
  state: "queued";
  taskId: string;
  credentialId: string;
  channelAccountId: string;
  enqueuedAt: string;
  mutationRequestId: string;
};

type CredentialMetadata = {
  credentialId: string;
  channelAccountId: string;
  credentialType: string;
  status: "active" | "superseded" | "expired" | "invalid";
  expiresAt: string | null;
  lastValidatedAt: string | null;
  fingerprintPrefix: string;
};

type CredentialRedactedResult = {
  code: CredentialContractCode | null;
  credentialId: string;
  status: "active" | "superseded" | "expired" | "invalid";
  expiresAt: string | null;
  lastValidatedAt: string | null;
  fingerprintPrefix: string | null;
};
```

稳定错误码：`credential_validation_queued`、`credential_missing`、`credential_expired`、
`credential_validation_failed`、`credential_fingerprint_conflict`、
`credential_capability_denied`、`credential_ambiguous`、`account_inactive`。

结果禁止 `message`、stack、数据库错误、Worker 原 payload、secret/ciphertext、完整 fingerprint。
`code=null` 表示成功。Admin mutation rate-limit port 是
`OPTIONAL_DEFENSE_IN_DEPTH / NOT_A_P1_SECURITY_BOUNDARY`；本期强制 mutation request id 幂等和
active task deduplication。
