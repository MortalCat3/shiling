\set ON_ERROR_STOP on
\getenv database_name SHILING_DATABASE_NAME
\getenv app_password SHILING_APP_DB_PASSWORD
\getenv migration_password SHILING_MIGRATION_DB_PASSWORD

-- 在创建任何对象前限制目标名称；除零会由 ON_ERROR_STOP 中止脚本。
SELECT 1 / (:'database_name' IN ('shiling', 'shiling_dev'))::int AS dedicated_database_guard;

-- 不提供 IF NOT EXISTS/覆盖式授权：遇到既有同名角色应停止，由操作者核对用途。
CREATE ROLE shiling_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
CREATE ROLE shiling_migrate LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD :'migration_password';
CREATE ROLE shiling_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD :'app_password';
GRANT shiling_owner TO shiling_migrate;
CREATE DATABASE :"database_name" OWNER shiling_owner TEMPLATE template0 ENCODING 'UTF8';
REVOKE ALL ON DATABASE :"database_name" FROM PUBLIC;
GRANT CONNECT ON DATABASE :"database_name" TO shiling_app, shiling_migrate;
ALTER DATABASE :"database_name" SET timezone TO 'UTC';
\connect :database_name
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;
CREATE SCHEMA shiling AUTHORIZATION shiling_owner;
CREATE SCHEMA pgboss AUTHORIZATION shiling_owner;
GRANT USAGE ON SCHEMA shiling, pgboss TO shiling_app;
ALTER DEFAULT PRIVILEGES FOR ROLE shiling_owner IN SCHEMA shiling, pgboss
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO shiling_app;
ALTER DEFAULT PRIVILEGES FOR ROLE shiling_owner IN SCHEMA shiling, pgboss
  GRANT USAGE, SELECT ON SEQUENCES TO shiling_app;
ALTER DEFAULT PRIVILEGES FOR ROLE shiling_owner IN SCHEMA shiling, pgboss
  GRANT EXECUTE ON FUNCTIONS TO shiling_app;
ALTER ROLE shiling_app IN DATABASE :"database_name" SET search_path TO shiling, public;
ALTER ROLE shiling_migrate IN DATABASE :"database_name" SET search_path TO shiling, public;
