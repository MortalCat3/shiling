#!/bin/sh
set -eu

# 只在 PostgreSQL 空数据卷初始化时由官方入口执行；不自动修改既有角色。
case "${SHILING_DATABASE_NAME:-}" in
  shiling|shiling_dev) ;;
  *) echo '拒绝初始化非拾灵专用数据库' >&2; exit 1 ;;
esac
export SHILING_APP_DB_PASSWORD="$(cat "$SHILING_APP_DB_PASSWORD_FILE")"
export SHILING_MIGRATION_DB_PASSWORD="$(cat "$SHILING_MIGRATION_DB_PASSWORD_FILE")"
test -n "$SHILING_APP_DB_PASSWORD"
test -n "$SHILING_MIGRATION_DB_PASSWORD"
psql -X --username "$POSTGRES_USER" --dbname postgres --file /opt/shiling/bootstrap.sql
unset SHILING_APP_DB_PASSWORD SHILING_MIGRATION_DB_PASSWORD
