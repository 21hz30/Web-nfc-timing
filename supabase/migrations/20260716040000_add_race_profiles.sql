create table public.race_profiles (
  race_id text primary key,
  name text not null,
  mode text not null,
  station_count integer not null,
  checkpoints jsonb not null,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  constraint race_profiles_mode_check
    check (mode in ('two_reader_auto', 'station_checkpoints')),
  constraint race_profiles_station_count_check
    check (station_count between 1 and 20),
  constraint race_profiles_checkpoints_array_check
    check (jsonb_typeof(checkpoints) = 'array')
);

create index race_profiles_updated_idx
  on public.race_profiles (updated_at desc);

alter table public.timing_events
  drop constraint timing_events_status_check;

alter table public.timing_events
  add constraint timing_events_status_check
  check (
    status in (
      'accepted',
      'unbound_card',
      'duplicate_tap',
      'wrong_gate',
      'wrong_checkpoint',
      'already_finished',
      'invalid_progress'
    )
  );

alter table public.race_profiles enable row level security;

revoke all on public.race_profiles from anon, authenticated;
grant select, insert, update on public.race_profiles to anon;

create policy race_profiles_server_select
  on public.race_profiles
  for select
  to anon
  using ((select private.timing_api_authorized()));

create policy race_profiles_server_insert
  on public.race_profiles
  for insert
  to anon
  with check ((select private.timing_api_authorized()));

create policy race_profiles_server_update
  on public.race_profiles
  for update
  to anon
  using ((select private.timing_api_authorized()))
  with check ((select private.timing_api_authorized()));
