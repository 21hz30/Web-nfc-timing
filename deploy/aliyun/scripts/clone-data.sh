#!/bin/sh
set -eu

: "${SOURCE_DATABASE_URL:?SOURCE_DATABASE_URL is required}"
: "${TARGET_DATABASE_URL:?TARGET_DATABASE_URL is required}"
: "${ALLOW_EMPTY_TARGET_RESET:?Set ALLOW_EMPTY_TARGET_RESET=YES for the empty test target}"

if [ "$ALLOW_EMPTY_TARGET_RESET" != "YES" ]; then
  echo "Refusing to replace target data without ALLOW_EMPTY_TARGET_RESET=YES" >&2
  exit 1
fi

dump_file="$(mktemp /tmp/src-timing-data.XXXXXX.dump)"
trap 'rm -f "$dump_file"' EXIT

pg_dump "$SOURCE_DATABASE_URL" \
  --format=custom \
  --data-only \
  --schema=public \
  --no-owner \
  --no-privileges \
  --file="$dump_file"

psql "$TARGET_DATABASE_URL" --set=ON_ERROR_STOP=1 --command="
  truncate table
    public.participant_timing_controls,
    public.manual_results,
    public.result_adjustments,
    public.start_checkins,
    public.race_admin_actions,
    public.device_bindings,
    public.timing_events,
    public.participants,
    public.race_profiles
  restart identity cascade
"

pg_restore \
  --dbname="$TARGET_DATABASE_URL" \
  --data-only \
  --no-owner \
  --no-privileges \
  --exit-on-error \
  "$dump_file"
