-- P1-08 CPS parity decision: credential lifecycle is
-- active | superseded | expired | invalid. Account enable/disable remains on
-- channel_account.status and never writes credential.status.

DO $credential_status_guard$
DECLARE
    revoked_count BIGINT;
BEGIN
    SELECT count(*)
      INTO revoked_count
      FROM "channel_account_credential"
     WHERE "status" = 'revoked';

    IF revoked_count > 0 THEN
        RAISE EXCEPTION USING
            ERRCODE = '23514',
            MESSAGE = format(
                'P1-08 credential status migration blocked: found %s revoked row(s); manual disposition is required before retrying',
                revoked_count
            );
    END IF;
END;
$credential_status_guard$;

ALTER TABLE "channel_account_credential"
    DROP CONSTRAINT "channel_account_credential_status_check";

ALTER TABLE "channel_account_credential"
    ADD CONSTRAINT "channel_account_credential_status_check"
    CHECK ("status" IN ('active', 'superseded', 'expired', 'invalid'));
