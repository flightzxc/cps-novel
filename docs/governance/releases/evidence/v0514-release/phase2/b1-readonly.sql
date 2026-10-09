BEGIN READ ONLY;
SELECT id, last_validated_at >= created_at AS ok, last_validated_at = created_at AS same FROM channel_account_credential WHERE status='active';
SELECT DISTINCT b.id AS held_batch_id, s.channel_account_id, c.id AS credential_id, c.last_validated_at >= c.created_at AS credential_ok, b.result->'taskControl'->>'reasonCode' AS reason_code FROM generic_task b JOIN generic_task s ON s.parent_task_id=b.id JOIN channel_account_credential c ON c.channel_account_id=s.channel_account_id AND c.status='active' WHERE b.status='disabled' AND b.result->'taskControl'->>'reasonCode'='credential_not_ready' AND s.task_type='promo_link.claim.v1' AND s.params->>'lifecycleVersion'='1' AND s.params->>'lifecycleRole'='shard';
COMMIT;
