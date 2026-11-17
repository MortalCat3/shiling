#!/bin/sh
set -eu

# TCP 仅在官方入口完成首次引导后监听；再用运行角色确认专用库和最小授权已就绪。
export PGCONNECT_TIMEOUT=2
export PGPASSWORD="$(cat "$SHILING_APP_DB_PASSWORD_FILE")"
psql -X -h 127.0.0.1 -U shiling_app -d "$SHILING_DATABASE_NAME" -Atq -v ON_ERROR_STOP=1 \
  -c "SELECT current_user='shiling_app'
    AND NOT (SELECT rolsuper OR rolcreatedb OR rolcreaterole FROM pg_roles WHERE rolname=current_user)
    AND has_schema_privilege(current_user,'shiling','USAGE')
    AND has_schema_privilege(current_user,'pgboss','USAGE')
    AND NOT has_schema_privilege(current_user,'shiling','CREATE')
    AND EXISTS (SELECT 1 FROM pg_extension WHERE extname='pg_trgm');" | grep -qx t
