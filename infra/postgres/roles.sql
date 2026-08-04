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

ALTER ROLE analyst_ro SET statement_timeout = '30s';
ALTER ROLE analyst_ro SET default_transaction_read_only = 'on';
ALTER ROLE backup_role SET default_transaction_read_only = 'on';
