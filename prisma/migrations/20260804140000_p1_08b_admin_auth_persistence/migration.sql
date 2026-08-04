CREATE TABLE "admin_identity" (
  "id" UUID NOT NULL,
  "username" VARCHAR(160) NOT NULL,
  "password_hash" TEXT NOT NULL,
  "role" VARCHAR(64) NOT NULL,
  "status" VARCHAR(32) NOT NULL DEFAULT 'active',
  "session_version" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "admin_identity_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "admin_identity_username_normalized_check" CHECK ("username" = lower(btrim("username")) AND length("username") > 0),
  CONSTRAINT "admin_identity_password_hash_check" CHECK ("password_hash" LIKE 'scrypt$v1$%'),
  CONSTRAINT "admin_identity_status_check" CHECK ("status" IN ('active', 'disabled')),
  CONSTRAINT "admin_identity_session_version_check" CHECK ("session_version" >= 0)
);

CREATE UNIQUE INDEX "admin_identity_username_key" ON "admin_identity"("username");
CREATE INDEX "admin_identity_status_updated_idx" ON "admin_identity"("status", "updated_at");

CREATE TABLE "admin_session" (
  "id" UUID NOT NULL,
  "identity_id" UUID NOT NULL,
  "token_hash" CHAR(64) NOT NULL,
  "session_version" INTEGER NOT NULL,
  "issued_at" TIMESTAMPTZ(6) NOT NULL,
  "last_seen_at" TIMESTAMPTZ(6) NOT NULL,
  "absolute_expires_at" TIMESTAMPTZ(6) NOT NULL,
  "two_factor_completed_at" TIMESTAMPTZ(6),
  "revoked_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "admin_session_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "admin_session_identity_pair_key" UNIQUE ("id", "identity_id"),
  CONSTRAINT "admin_session_token_hash_check" CHECK ("token_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "admin_session_version_check" CHECK ("session_version" >= 0),
  CONSTRAINT "admin_session_time_check" CHECK (
    "last_seen_at" >= "issued_at" AND
    "absolute_expires_at" > "issued_at" AND
    "absolute_expires_at" <= "issued_at" + interval '24 hours' AND
    ("two_factor_completed_at" IS NULL OR "two_factor_completed_at" >= "issued_at") AND
    ("revoked_at" IS NULL OR "revoked_at" >= "issued_at")
  )
);

CREATE UNIQUE INDEX "admin_session_token_hash_key" ON "admin_session"("token_hash");
CREATE INDEX "admin_session_identity_active_idx" ON "admin_session"("identity_id", "last_seen_at") WHERE "revoked_at" IS NULL;
CREATE INDEX "admin_session_absolute_expiry_idx" ON "admin_session"("absolute_expires_at") WHERE "revoked_at" IS NULL;

CREATE TABLE "admin_two_factor" (
  "identity_id" UUID NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT false,
  "encrypted_secret" TEXT,
  "key_version" SMALLINT,
  "confirmed_at" TIMESTAMPTZ(6),
  "pending_encrypted_secret" TEXT,
  "pending_key_version" SMALLINT,
  "pending_expires_at" TIMESTAMPTZ(6),
  "recovery_codes_rotated_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "admin_two_factor_pkey" PRIMARY KEY ("identity_id"),
  CONSTRAINT "admin_two_factor_key_version_check" CHECK (("key_version" IS NULL OR "key_version" > 0) AND ("pending_key_version" IS NULL OR "pending_key_version" > 0)),
  CONSTRAINT "admin_two_factor_active_check" CHECK (NOT "enabled" OR ("encrypted_secret" IS NOT NULL AND "key_version" IS NOT NULL AND "confirmed_at" IS NOT NULL)),
  CONSTRAINT "admin_two_factor_pending_check" CHECK (("pending_encrypted_secret" IS NULL AND "pending_key_version" IS NULL AND "pending_expires_at" IS NULL) OR ("pending_encrypted_secret" IS NOT NULL AND "pending_key_version" IS NOT NULL AND "pending_expires_at" IS NOT NULL))
);

CREATE INDEX "admin_two_factor_pending_expiry_idx" ON "admin_two_factor"("pending_expires_at") WHERE "pending_expires_at" IS NOT NULL;

CREATE TABLE "admin_two_factor_challenge" (
  "id" UUID NOT NULL,
  "identity_id" UUID NOT NULL,
  "session_id" UUID NOT NULL,
  "token_hash" CHAR(64) NOT NULL,
  "expires_at" TIMESTAMPTZ(6) NOT NULL,
  "consumed_at" TIMESTAMPTZ(6),
  "attempt_count" INTEGER NOT NULL DEFAULT 0,
  "request_ip_hash" CHAR(64),
  "user_agent_hash" CHAR(64),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "admin_two_factor_challenge_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "admin_two_factor_challenge_token_hash_check" CHECK ("token_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "admin_two_factor_challenge_attempt_check" CHECK ("attempt_count" BETWEEN 0 AND 5),
  CONSTRAINT "admin_two_factor_challenge_expiry_check" CHECK ("expires_at" > "created_at" AND "expires_at" <= "created_at" + interval '5 minutes')
);

CREATE UNIQUE INDEX "admin_two_factor_challenge_token_hash_key" ON "admin_two_factor_challenge"("token_hash");
CREATE INDEX "admin_two_factor_challenge_session_active_idx" ON "admin_two_factor_challenge"("session_id", "expires_at") WHERE "consumed_at" IS NULL;
CREATE INDEX "admin_two_factor_challenge_identity_active_idx" ON "admin_two_factor_challenge"("identity_id", "expires_at") WHERE "consumed_at" IS NULL;

CREATE TABLE "admin_recovery_code" (
  "id" UUID NOT NULL,
  "identity_id" UUID NOT NULL,
  "code_hash" TEXT NOT NULL,
  "used_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "admin_recovery_code_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "admin_recovery_code_hash_check" CHECK ("code_hash" LIKE 'scrypt$v1$%')
);

CREATE UNIQUE INDEX "admin_recovery_code_code_hash_key" ON "admin_recovery_code"("code_hash");
CREATE INDEX "admin_recovery_code_identity_unused_idx" ON "admin_recovery_code"("identity_id", "used_at");

CREATE TABLE "admin_login_attempt" (
  "identifier_hash" CHAR(64) NOT NULL,
  "failure_count" INTEGER NOT NULL DEFAULT 0,
  "locked_until" TIMESTAMPTZ(6),
  "updated_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "admin_login_attempt_pkey" PRIMARY KEY ("identifier_hash"),
  CONSTRAINT "admin_login_attempt_hash_check" CHECK ("identifier_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "admin_login_attempt_failure_count_check" CHECK ("failure_count" >= 0)
);

CREATE INDEX "admin_login_attempt_locked_idx" ON "admin_login_attempt"("locked_until");
CREATE UNIQUE INDEX "operation_audit_admin_request_action_uidx" ON "operation_audit"("request_id", "action") WHERE "actor_type" = 'admin' AND "request_id" IS NOT NULL;

ALTER TABLE "admin_session" ADD CONSTRAINT "admin_session_identity_id_fkey" FOREIGN KEY ("identity_id") REFERENCES "admin_identity"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "admin_two_factor" ADD CONSTRAINT "admin_two_factor_identity_id_fkey" FOREIGN KEY ("identity_id") REFERENCES "admin_identity"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "admin_two_factor_challenge" ADD CONSTRAINT "admin_two_factor_challenge_identity_id_fkey" FOREIGN KEY ("identity_id") REFERENCES "admin_identity"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "admin_two_factor_challenge" ADD CONSTRAINT "admin_two_factor_challenge_session_id_identity_id_fkey" FOREIGN KEY ("session_id", "identity_id") REFERENCES "admin_session"("id", "identity_id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "admin_recovery_code" ADD CONSTRAINT "admin_recovery_code_identity_id_fkey" FOREIGN KEY ("identity_id") REFERENCES "admin_identity"("id") ON DELETE CASCADE ON UPDATE CASCADE;
