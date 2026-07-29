alter table public.race_profiles
  add column if not exists start_group_size integer not null default 1;

alter table public.race_profiles
  drop constraint if exists race_profiles_start_group_size_check;

alter table public.race_profiles
  add constraint race_profiles_start_group_size_check
  check (start_group_size between 1 and 50);

alter table public.participants
  add column if not exists start_order integer;

with ordered as (
  select
    id,
    row_number() over (
      partition by race_id
      order by bib_number nulls last, created_at, id
    ) as resolved_start_order
  from public.participants
  where start_order is null
)
update public.participants participant
set start_order = ordered.resolved_start_order
from ordered
where participant.id = ordered.id;

alter table public.participants
  alter column start_order set default 1;

alter table public.participants
  alter column start_order set not null;

alter table public.participants
  drop constraint if exists participants_start_order_check;

alter table public.participants
  add constraint participants_start_order_check
  check (start_order between 1 and 100000);

create index if not exists participants_race_start_order_idx
  on public.participants (race_id, start_order, id);

create or replace function public.start_race_batch(
  p_race_id text,
  p_participant_ids bigint[],
  p_started_at timestamptz,
  p_device_id text
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_profile public.race_profiles%rowtype;
  v_participant_ids bigint[];
  v_requested_count integer;
  v_batch_id uuid := extensions.gen_random_uuid();
  v_started_at timestamptz := coalesce(p_started_at, clock_timestamp());
  v_device_id text := btrim(coalesce(p_device_id, ''));
  v_start_wave integer;
  v_started jsonb;
begin
  if btrim(coalesce(p_race_id, '')) = '' then
    raise exception using errcode = '22023', message = 'raceId is required';
  end if;
  if v_device_id = '' or char_length(v_device_id) > 100 then
    raise exception using errcode = '22023', message = 'deviceId must be between 1 and 100 characters';
  end if;

  select array_agg(participant_id order by participant_id)
  into v_participant_ids
  from (
    select distinct participant_id
    from unnest(coalesce(p_participant_ids, '{}'::bigint[])) as selected(participant_id)
    where participant_id is not null
  ) unique_participants;

  v_requested_count := coalesce(cardinality(v_participant_ids), 0);
  if v_requested_count < 1 or v_requested_count > 50 then
    raise exception using errcode = '22023', message = 'Select between 1 and 50 participants';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('race-start:' || p_race_id, 0)
  );

  select * into v_profile
  from public.race_profiles
  where race_id = p_race_id
  for update;

  if v_profile.race_id is null then
    raise exception using errcode = '22023', message = 'race profile not found';
  end if;
  if v_profile.is_template then
    raise exception using errcode = '23514', message = 'This Race ID is a read-only template; create a dated race session first';
  end if;
  if v_profile.status = 'finalized' then
    raise exception using errcode = '23514', message = 'This race has ended';
  end if;
  if v_requested_count > v_profile.start_group_size then
    raise exception using errcode = '22023',
      message = 'Selected participants exceed the configured start group size';
  end if;

  if (
    select count(*)
    from public.participants
    where race_id = p_race_id and id = any(v_participant_ids)
  ) <> v_requested_count then
    raise exception using errcode = '22023', message = 'One or more selected participants do not belong to this race';
  end if;

  select min(((start_order - 1) / v_profile.start_group_size) + 1)
  into v_start_wave
  from public.participants
  where race_id = p_race_id and id = any(v_participant_ids);

  if exists (
    select 1
    from public.participants
    where race_id = p_race_id
      and id = any(v_participant_ids)
      and (((start_order - 1) / v_profile.start_group_size) + 1) <> v_start_wave
  ) then
    raise exception using errcode = '22023', message = 'Selected participants must belong to the same start wave';
  end if;

  if exists (
    select 1 from public.timing_events
    where race_id = p_race_id
      and participant_id = any(v_participant_ids)
      and station_id = 'START'
      and status = 'accepted'
  ) then
    raise exception using errcode = '23505', message = 'One or more selected participants have already started';
  end if;

  if (
    select count(*) from public.start_checkins
    where race_id = p_race_id
      and participant_id = any(v_participant_ids)
      and status = 'ready'
  ) <> v_requested_count then
    raise exception using errcode = '23514', message = 'Every selected participant must pass the start check-in first';
  end if;

  insert into public.timing_events (
    event_id, race_id, device_id, station_id, station_label,
    station_number, checkpoint_type, card_code, serial_number,
    event_time, received_at, source, timing_mode, gate_role,
    duplicate_window_seconds, status, participant_id, raw_json
  )
  select
    'judge:' || v_batch_id::text || ':' || participant.id::text,
    p_race_id, v_device_id, 'START', 'Race Start', null, 'start',
    participant.card_code, null, v_started_at, v_started_at,
    'judge-batch-start',
    case when v_profile.mode = 'station_checkpoints' then 'manual' else 'auto' end,
    null, 10, 'accepted', participant.id,
    jsonb_build_object(
      'batchId', v_batch_id,
      'startWave', v_start_wave,
      'raceId', p_race_id,
      'participantId', participant.id,
      'eventTime', v_started_at,
      'deviceId', v_device_id,
      'source', 'judge-batch-start'
    )
  from public.participants participant
  where participant.race_id = p_race_id
    and participant.id = any(v_participant_ids);

  update public.start_checkins
  set status = 'started', started_at = v_started_at, updated_at = v_started_at
  where race_id = p_race_id and participant_id = any(v_participant_ids);

  select jsonb_agg(
    jsonb_build_object(
      'participantId', participant.id,
      'athleteName', participant.athlete_name,
      'entryType', coalesce(participant.entry_type, 'individual'),
      'memberNames', coalesce(participant.member_names, '[]'::jsonb),
      'startOrder', participant.start_order,
      'startWave', v_start_wave,
      'startedAt', v_started_at
    ) order by participant.start_order, participant.id
  )
  into v_started
  from public.participants participant
  where participant.race_id = p_race_id
    and participant.id = any(v_participant_ids);

  return jsonb_build_object(
    'ok', true,
    'raceId', p_race_id,
    'batchId', v_batch_id,
    'startWave', v_start_wave,
    'startedAt', v_started_at,
    'startedCount', v_requested_count,
    'participants', coalesce(v_started, '[]'::jsonb),
    'storage', jsonb_build_object(
      'localSaved', false,
      'supabaseSaved', true,
      'primary', 'supabase'
    ),
    'cloudError', null
  );
end;
$$;

revoke all on function public.start_race_batch(text, bigint[], timestamptz, text) from public;
revoke all on function public.start_race_batch(text, bigint[], timestamptz, text) from anon, authenticated;
grant execute on function public.start_race_batch(text, bigint[], timestamptz, text) to service_role;
