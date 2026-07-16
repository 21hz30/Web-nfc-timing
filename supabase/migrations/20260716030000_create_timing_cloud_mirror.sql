create extension if not exists pgcrypto with schema extensions;

create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to anon, authenticated;

create table public.participants (
  id bigint primary key,
  race_id text not null,
  card_code text not null,
  athlete_name text not null,
  bib_number text,
  phone text,
  gender text,
  division text,
  check_in_status text not null default 'not_checked_in',
  created_at timestamptz not null,
  updated_at timestamptz not null,
  constraint participants_race_card_key unique (race_id, card_code),
  constraint participants_check_in_status_check
    check (check_in_status in ('not_checked_in', 'checked_in'))
);

create table public.timing_events (
  id bigint primary key,
  event_id text not null unique,
  race_id text not null,
  device_id text not null,
  station_id text not null,
  station_label text,
  station_number integer,
  checkpoint_type text,
  card_code text not null,
  serial_number text,
  event_time timestamptz not null,
  received_at timestamptz not null,
  source text,
  timing_mode text not null default 'manual',
  gate_role text,
  duplicate_window_seconds integer not null default 10,
  status text not null,
  participant_id bigint references public.participants(id) on delete set null,
  raw_json jsonb not null,
  constraint timing_events_station_number_check
    check (station_number is null or station_number between 1 and 8),
  constraint timing_events_timing_mode_check
    check (timing_mode in ('auto', 'manual')),
  constraint timing_events_gate_role_check
    check (gate_role is null or gate_role in ('RUN_OUT', 'RUN_IN')),
  constraint timing_events_duplicate_window_check
    check (duplicate_window_seconds between 3 and 60),
  constraint timing_events_status_check
    check (
      status in (
        'accepted',
        'unbound_card',
        'duplicate_tap',
        'wrong_gate',
        'already_finished',
        'invalid_progress'
      )
    )
);

create index participants_race_bib_name_idx
  on public.participants (race_id, bib_number, athlete_name);

create index timing_events_race_received_idx
  on public.timing_events (race_id, received_at desc, id desc);

create index timing_events_card_station_idx
  on public.timing_events (race_id, card_code, station_id, event_time desc, id desc);

create index timing_events_participant_idx
  on public.timing_events (participant_id);

create index timing_events_accepted_progress_idx
  on public.timing_events (race_id, participant_id, event_time, id)
  where status = 'accepted' and participant_id is not null;

create index timing_events_auto_gate_idx
  on public.timing_events (race_id, card_code, gate_role, event_time desc, id desc)
  where timing_mode = 'auto';

create or replace function private.timing_api_authorized()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    encode(
      extensions.digest(
        coalesce(
          current_setting('request.headers', true)::jsonb ->> 'x-timing-api-key',
          ''
        ),
        'sha256'
      ),
      'hex'
    ) = '26574da69fefe66107d5c48a03beb4703bf412ea8de894bc9dc55a4372a82ea0',
    false
  );
$$;

revoke all on function private.timing_api_authorized() from public;
grant execute on function private.timing_api_authorized() to anon, authenticated;

alter table public.participants enable row level security;
alter table public.timing_events enable row level security;

revoke all on public.participants, public.timing_events from anon, authenticated;
grant select, insert, update on public.participants, public.timing_events to anon;

create policy participants_server_select
  on public.participants
  for select
  to anon
  using ((select private.timing_api_authorized()));

create policy participants_server_insert
  on public.participants
  for insert
  to anon
  with check ((select private.timing_api_authorized()));

create policy participants_server_update
  on public.participants
  for update
  to anon
  using ((select private.timing_api_authorized()))
  with check ((select private.timing_api_authorized()));

create policy timing_events_server_select
  on public.timing_events
  for select
  to anon
  using ((select private.timing_api_authorized()));

create policy timing_events_server_insert
  on public.timing_events
  for insert
  to anon
  with check ((select private.timing_api_authorized()));

create policy timing_events_server_update
  on public.timing_events
  for update
  to anon
  using ((select private.timing_api_authorized()))
  with check ((select private.timing_api_authorized()));
