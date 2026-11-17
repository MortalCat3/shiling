\set ON_ERROR_STOP on
\getenv test_password SHILING_TEST_DB_PASSWORD
-- 仅用于新建的本地测试库。禁止在共享、生产或未知数据库上运行。
CREATE ROLE shiling_test LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD :'test_password';
CREATE DATABASE shiling_test OWNER shiling_test TEMPLATE template0 ENCODING 'UTF8';
REVOKE ALL ON DATABASE shiling_test FROM PUBLIC;
ALTER DATABASE shiling_test SET timezone TO 'UTC';
\connect shiling_test
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;
CREATE SCHEMA shiling AUTHORIZATION shiling_test;
CREATE SCHEMA pgboss AUTHORIZATION shiling_test;
ALTER ROLE shiling_test IN DATABASE shiling_test SET search_path TO shiling, public;
