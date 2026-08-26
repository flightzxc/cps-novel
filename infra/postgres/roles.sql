\set ON_ERROR_STOP on

-- P1-06 cluster roles. Passwords are deliberately absent: provision them at
-- runtime through the deployment secret manager or the disposable test harness.
DO $roles$
DECLARE
  role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY[
    'migration_owner',
    'web_app',
    'worker_app',
    'scheduler_app',
    'analyst_ro',
    'backup_role'
  ]
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      EXECUTE format('CREATE ROLE %I LOGIN', role_name);
    END IF;
  END LOOP;
END
$roles$;

ALTER ROLE migration_owner WITH
  LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
ALTER ROLE web_app WITH
  LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
ALTER ROLE worker_app WITH
  LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
ALTER ROLE scheduler_app WITH
  LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
ALTER ROLE analyst_ro WITH
  LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
ALTER ROLE backup_role WITH
  LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT REPLICATION NOBYPASSRLS;

-- X2 runtime query budgets. ALTER ROLE settings apply to new sessions; deploys
-- must recycle the corresponding connection pools after replaying this file.
ALTER ROLE web_app SET statement_timeout = '30s';
ALTER ROLE web_app SET lock_timeout = '5s';
ALTER ROLE web_app SET idle_in_transaction_session_timeout = '60s';

ALTER ROLE worker_app SET statement_timeout = '5min';
ALTER ROLE worker_app SET lock_timeout = '15s';
ALTER ROLE worker_app SET idle_in_transaction_session_timeout = '5min';

ALTER ROLE scheduler_app SET statement_timeout = '1min';
ALTER ROLE scheduler_app SET lock_timeout = '5s';
ALTER ROLE scheduler_app SET idle_in_transaction_session_timeout = '60s';

ALTER ROLE analyst_ro SET statement_timeout = '30s';
ALTER ROLE analyst_ro SET default_transaction_read_only = 'on';
ALTER ROLE backup_role SET default_transaction_read_only = 'on';
