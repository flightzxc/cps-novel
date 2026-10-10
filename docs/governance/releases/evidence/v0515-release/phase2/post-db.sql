BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SELECT json_build_object('read_at',clock_timestamp(),
'migrations',(SELECT json_agg(json_build_object('name',migration_name,'checksum',checksum,'finished',finished_at IS NOT NULL,'rolled_back',rolled_back_at IS NOT NULL) ORDER BY migration_name) FROM _prisma_migrations),
'new_migration_ms',(SELECT extract(epoch FROM finished_at-started_at)*1000 FROM _prisma_migrations WHERE migration_name='20261010160000_canonical_tag_homepage_visible'),
'business_tables',(SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' AND table_name<>'_prisma_migrations'),
'canonical_tags',(SELECT count(*) FROM canonical_tag), 'homepage_visible',(SELECT count(*) FROM canonical_tag WHERE is_homepage_visible IS TRUE),
'web_update',has_column_privilege('web_app','canonical_tag','is_homepage_visible','UPDATE'),
'search_values',(SELECT json_agg(site_search_enabled) FROM site_setting),
'outbox_urls_by_status',(SELECT json_object_agg(status,n) FROM (SELECT status,count(*) n FROM indexnow_outbox GROUP BY status) x),
'delivery_taskItems_by_status',(SELECT json_object_agg(status,n) FROM (SELECT i.status,count(*) n FROM generic_task_item i JOIN generic_task t ON t.id=i.task_id WHERE t.task_type='indexnow_delivery' GROUP BY i.status) x),
'legacy_items',(SELECT json_agg(json_build_object('id',i.id,'status',i.status,'reason',i.result->>'reason','outbox_id',i.result->>'outboxId','outbox_status',o.status)) FROM generic_task_item i JOIN generic_task t ON t.id=i.task_id LEFT JOIN indexnow_outbox o ON o.id::text=i.result->>'outboxId' WHERE t.task_type='indexnow_delivery' AND i.result->>'reason'='legacy_single_row_item'),
'legacy_format_items_by_status',(SELECT json_object_agg(status,n) FROM (SELECT i.status,count(*) n FROM generic_task_item i JOIN generic_task t ON t.id=i.task_id WHERE t.task_type='indexnow_delivery' AND i.payload ? 'outboxId' GROUP BY i.status) x),
'sweeps_last_10_minutes',(SELECT count(*) FROM schedule_run WHERE schedule_key='indexnow.sweep' AND scheduled_for>=now()-interval '10 minutes'),
'sweep_schedule_latest',(SELECT json_agg(json_build_object('scheduled_for',scheduled_for,'status',status) ORDER BY scheduled_for) FROM (SELECT scheduled_for,status FROM schedule_run WHERE schedule_key='indexnow.sweep' ORDER BY scheduled_for DESC LIMIT 10) x));
COMMIT;
