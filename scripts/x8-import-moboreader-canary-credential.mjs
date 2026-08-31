#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createCipheriv, createHmac, randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const EXPECTED_TOKEN_PATH = "/Users/chenweifeng/.codex-secrets/moboreader-canary.jwt";
const EXPECTED_BUSINESS_ID = "88fcfefdfac246d48408c72b749f5272";
const CHANNEL_ACCOUNT_ID = "45e89c67-b160-4ae6-95e3-c85f98b5a010";
const POSTGRES_CONTAINER = "cps-novel-x8-local-postgres-1";

function fail(code) {
  throw new Error(code);
}

function readCanonicalKey(file, label) {
  const value = fs.readFileSync(file, "utf8").trim();
  const decoded = Buffer.from(value, "base64");
  if (!value || decoded.length !== 32 || decoded.toString("base64") !== value) fail(`${label}_invalid`);
  return decoded;
}

function sqlLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function readAndValidateToken() {
  if (path.resolve(EXPECTED_TOKEN_PATH) !== EXPECTED_TOKEN_PATH) fail("credential_path_invalid");
  const metadata = fs.statSync(EXPECTED_TOKEN_PATH);
  if (!metadata.isFile() || (metadata.mode & 0o777) !== 0o600) fail("credential_mode_invalid");
  if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) fail("credential_owner_invalid");
  const token = fs.readFileSync(EXPECTED_TOKEN_PATH, "utf8").trim();
  const segments = token.split(".");
  if (segments.length !== 3) fail("credential_jwt_invalid");
  let claims;
  try {
    claims = JSON.parse(Buffer.from(segments[1], "base64url").toString("utf8"));
  } catch {
    fail("credential_jwt_invalid");
  }
  const userId = claims.UserId ?? claims.userId ?? claims.sub;
  if (userId !== EXPECTED_BUSINESS_ID) fail("credential_subject_mismatch");
  if (typeof claims.exp !== "number" || !Number.isFinite(claims.exp) || claims.exp * 1000 <= Date.now()) {
    fail("credential_expired");
  }
  return { token, expiresAt: new Date(claims.exp * 1000) };
}

function encryptCredential(secret, credentialId, encryptionKey) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey, iv);
  cipher.setAAD(Buffer.from(`cps-novel:credential:v1\0${CHANNEL_ACCOUNT_ID}\0${credentialId}`, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return Buffer.from([
    "v1",
    1,
    iv.toString("base64"),
    cipher.getAuthTag().toString("base64"),
    ciphertext.toString("base64"),
  ].join(":"), "utf8");
}

function fingerprintCredential(secret, fingerprintKey) {
  const digest = createHmac("sha256", fingerprintKey)
    .update("cps-novel:credential-fingerprint:v1\0")
    .update(secret)
    .digest("hex");
  return { full: `hmac-sha256:v1:${digest}`, prefix: digest.slice(0, 12) };
}

function main() {
  const projectRoot = path.resolve(import.meta.dirname, "..");
  const secretRoot = path.join(projectRoot, ".tmp/x8-production-like/secrets");
  const { token, expiresAt } = readAndValidateToken();
  const encryptionKey = readCanonicalKey(path.join(secretRoot, "credential-v1.key"), "encryption_key");
  const fingerprintKey = readCanonicalKey(path.join(secretRoot, "credential-fingerprint.key"), "fingerprint_key");
  const credentialId = randomUUID();
  const activeFingerprintId = randomUUID();
  const enableRequestId = randomUUID();
  const replaceRequestId = randomUUID();
  const encrypted = encryptCredential(token, credentialId, encryptionKey);
  const fingerprint = fingerprintCredential(token, fingerprintKey);
  const now = new Date().toISOString();

  const sql = String.raw`
BEGIN;
DO $operator$
DECLARE observed_business_id text;
BEGIN
  SELECT business_id INTO observed_business_id
  FROM channel_account
  WHERE id=${sqlLiteral(CHANNEL_ACCOUNT_ID)}::uuid AND deleted_at IS NULL
  FOR UPDATE;
  IF observed_business_id IS DISTINCT FROM ${sqlLiteral(EXPECTED_BUSINESS_ID)} THEN
    RAISE EXCEPTION 'channel_account_identity_mismatch';
  END IF;
END $operator$;

INSERT INTO operation_audit (
  actor_type, actor_id, action, entity_type, entity_id, request_id, reason,
  before_snapshot, after_snapshot, created_at
)
SELECT
  'system', 'codex-owner-approved', 'channel_account.enable', 'ChannelAccount', id::text,
  ${sqlLiteral(enableRequestId)}, 'Owner-approved Book B promo claim smoke',
  jsonb_build_object('status', status), jsonb_build_object('status', 'active'), transaction_timestamp()
FROM channel_account
WHERE id=${sqlLiteral(CHANNEL_ACCOUNT_ID)}::uuid AND status <> 'active';

UPDATE channel_account
SET status='active', last_validated_at=${sqlLiteral(now)}::timestamptz, updated_at=transaction_timestamp()
WHERE id=${sqlLiteral(CHANNEL_ACCOUNT_ID)}::uuid;

DELETE FROM channel_credential_active_fingerprint
WHERE credential_id IN (
  SELECT id FROM channel_account_credential
  WHERE channel_account_id=${sqlLiteral(CHANNEL_ACCOUNT_ID)}::uuid
    AND credential_type='bearer_jwt' AND status='active'
);

UPDATE channel_account_credential
SET status='superseded', updated_at=transaction_timestamp()
WHERE channel_account_id=${sqlLiteral(CHANNEL_ACCOUNT_ID)}::uuid
  AND credential_type='bearer_jwt' AND status='active';

INSERT INTO channel_account_credential (
  id, channel_account_id, credential_type, encrypted_secret, key_version,
  secret_fingerprint, fingerprint_prefix, expires_at, last_validated_at,
  status, created_at, updated_at
) VALUES (
  ${sqlLiteral(credentialId)}::uuid, ${sqlLiteral(CHANNEL_ACCOUNT_ID)}::uuid, 'bearer_jwt',
  decode(${sqlLiteral(encrypted.toString("hex"))}, 'hex'), 1,
  ${sqlLiteral(fingerprint.full)}, ${sqlLiteral(fingerprint.prefix)},
  ${sqlLiteral(expiresAt.toISOString())}::timestamptz, ${sqlLiteral(now)}::timestamptz,
  'active', transaction_timestamp(), transaction_timestamp()
);

INSERT INTO channel_credential_active_fingerprint (
  id, fingerprint, credential_id, channel_account_id, credential_type, created_at
) VALUES (
  ${sqlLiteral(activeFingerprintId)}::uuid, ${sqlLiteral(fingerprint.full)},
  ${sqlLiteral(credentialId)}::uuid, ${sqlLiteral(CHANNEL_ACCOUNT_ID)}::uuid,
  'bearer_jwt', transaction_timestamp()
);

INSERT INTO credential_change_log (
  channel_account_id, credential_id, actor_type, actor_id, action,
  new_fingerprint, reason, detail, created_at
) VALUES (
  ${sqlLiteral(CHANNEL_ACCOUNT_ID)}::uuid, ${sqlLiteral(credentialId)}::uuid,
  'system', 'codex-owner-approved', 'add', ${sqlLiteral(fingerprint.prefix)},
  'Owner-approved Book B promo claim smoke',
  jsonb_build_object('credentialType', 'bearer_jwt', 'status', 'active'), transaction_timestamp()
);

INSERT INTO operation_audit (
  actor_type, actor_id, action, entity_type, entity_id, request_id, reason,
  after_snapshot, created_at
) VALUES (
  'system', 'codex-owner-approved', 'credential.replace.completed',
  'ChannelAccountCredential', ${sqlLiteral(credentialId)}, ${sqlLiteral(replaceRequestId)},
  'Owner-approved Book B promo claim smoke',
  jsonb_build_object(
    'channelAccountId', ${sqlLiteral(CHANNEL_ACCOUNT_ID)},
    'credentialType', 'bearer_jwt', 'status', 'active',
    'fingerprintPrefix', ${sqlLiteral(fingerprint.prefix)}
  ), transaction_timestamp()
);
COMMIT;
`;

  const result = spawnSync(
    "docker",
    ["exec", "-i", POSTGRES_CONTAINER, "psql", "-X", "-q", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "cps_novel"],
    { input: sql, encoding: "utf8", maxBuffer: 1024 * 1024 },
  );
  if (result.status !== 0) fail("credential_import_transaction_failed");
  process.stdout.write(JSON.stringify({
    outcome: "imported",
    channelAccountId: CHANNEL_ACCOUNT_ID,
    businessId: EXPECTED_BUSINESS_ID,
    credentialId,
    credentialStatus: "active",
    fingerprintPrefix: fingerprint.prefix,
    expiresAt: expiresAt.toISOString(),
  }) + "\n");
}

try {
  main();
} catch (error) {
  process.stderr.write(JSON.stringify({
    outcome: "blocked",
    reason: error instanceof Error ? error.message : "credential_import_failed",
  }) + "\n");
  process.exitCode = 1;
}
