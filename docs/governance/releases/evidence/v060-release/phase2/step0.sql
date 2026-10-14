BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
-- 0) 迁移已应用：期望 27 个已完成迁移，最新一条是 20261014120000_code_mode_upstream_code_guard
SELECT count(*) AS applied, max(migration_name) AS latest
FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL;

-- 1) 列级授权（期望：f / f / f / t / f / f / t / t）——web_app 读不到口令码本身，只读派生布尔列
SELECT has_column_privilege('web_app',       'promo_link', 'upstream_code',         'SELECT') AS web_reads_code,
       has_column_privilege('scheduler_app', 'promo_link', 'upstream_code',         'SELECT') AS scheduler_reads_code,
       has_column_privilege('analyst_ro',    'promo_link', 'upstream_code',         'SELECT') AS analyst_reads_code,
       has_column_privilege('web_app',       'promo_link', 'upstream_code_present', 'SELECT') AS web_reads_present,
       has_column_privilege('scheduler_app', 'promo_link', 'upstream_code_present', 'SELECT') AS scheduler_reads_present,
       has_column_privilege('analyst_ro',    'promo_link', 'upstream_code_present', 'SELECT') AS analyst_reads_present,
       has_column_privilege('scheduler_app', 'channel_app', 'config',               'SELECT') AS scheduler_reads_theater_config,
       has_column_privilege('scheduler_app', 'promo_link',  'channel_app_id',       'SELECT') AS scheduler_reads_promo_app;

-- 2) 取码函数的形状与授权（期望：migration_owner / t / {"search_path=pg_catalog, public"} / t / f / f / f / f；acl 里没有空 grantee）
SELECT pg_get_userbyid(p.proowner) AS owner, p.prosecdef AS security_definer, p.proconfig AS config,
       has_function_privilege('web_app',       p.oid, 'EXECUTE') AS web_exec,
       has_function_privilege('worker_app',    p.oid, 'EXECUTE') AS worker_exec,
       has_function_privilege('scheduler_app', p.oid, 'EXECUTE') AS scheduler_exec,
       has_function_privilege('analyst_ro',    p.oid, 'EXECUTE') AS analyst_exec,
       has_function_privilege('backup_role',   p.oid, 'EXECUTE') AS backup_exec,
       p.proacl::text AS acl
FROM pg_proc p WHERE p.oid = 'public.code_mode_upstream_code(text)'::regprocedure;
-- 属主不是 migration_owner（例如用超级用户跑了迁移）→ 用超级用户执行 ALTER FUNCTION public.code_mode_upstream_code(text) OWNER TO migration_owner;
-- 并重放 grants.sql，再重读本条

-- 3) 触发器在位且启用（期望：O = 始终启用）
SELECT tgenabled FROM pg_trigger WHERE tgname = 'promo_link_upstream_code_present_sync' AND tgrelid = 'public.promo_link'::regclass;

-- 4) 回填一致（期望三个都是 0；只数数，不打印口令码）。空白口径必须和触发器一模一样：下面这串 U&'…' 就是迁移里触发器函数
--    btrim 用的 25 个字符（与 JS String.prototype.trim 同一套），不能写成 btrim(upstream_code)（那只去空格，会把只含制表符 / NBSP 的口令码误报）
SELECT count(*) FILTER (WHERE upstream_code IS NOT NULL AND coalesce(btrim(upstream_code, U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF'), '') <> '' AND NOT upstream_code_present) AS nonblank_but_flag_false,
       count(*) FILTER (WHERE upstream_code IS NOT NULL AND coalesce(btrim(upstream_code, U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF'), '') = '' AND upstream_code_present) AS blank_but_flag_true,
       count(*) FILTER (WHERE upstream_code IS NULL AND upstream_code_present) AS null_but_flag_true
FROM promo_link;
COMMIT;
