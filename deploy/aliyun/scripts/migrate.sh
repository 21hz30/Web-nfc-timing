#!/bin/sh
set -eu

: "${TARGET_DATABASE_URL:?TARGET_DATABASE_URL is required}"
: "${AUTHENTICATOR_PASSWORD:?AUTHENTICATOR_PASSWORD is required}"

psql "$TARGET_DATABASE_URL" \
  --set=authenticator_password="$AUTHENTICATOR_PASSWORD" \
  --file=/deploy/postgres/000-bootstrap.sql

for migration in /migrations/*.sql; do
  version="$(basename "$migration" .sql)"
  applied="$(psql "$TARGET_DATABASE_URL" --tuples-only --no-align \
    --command="select 1 from timing_migrations.schema_migrations where version = '$version'")"
  if [ "$applied" = "1" ]; then
    echo "Skipping applied migration $version"
    continue
  fi
  psql "$TARGET_DATABASE_URL" \
    --set=ON_ERROR_STOP=1 \
    --single-transaction \
    --file="$migration" \
    --command="insert into timing_migrations.schema_migrations(version) values ('$version')"
done

psql "$TARGET_DATABASE_URL" --file=/deploy/postgres/999-grants.sql
