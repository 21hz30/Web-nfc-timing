create sequence if not exists public.participants_cloud_id_seq
  as bigint
  minvalue 1000000000
  start with 1000000000;

create sequence if not exists public.timing_events_cloud_id_seq
  as bigint
  minvalue 1000000000
  start with 1000000000;

alter sequence public.participants_cloud_id_seq
  owned by public.participants.id;

alter sequence public.timing_events_cloud_id_seq
  owned by public.timing_events.id;

select setval(
  'public.participants_cloud_id_seq',
  greatest(
    1000000000,
    coalesce((select max(id) + 1 from public.participants), 1000000000)
  ),
  false
);

select setval(
  'public.timing_events_cloud_id_seq',
  greatest(
    1000000000,
    coalesce((select max(id) + 1 from public.timing_events), 1000000000)
  ),
  false
);

alter table public.participants
  alter column id set default nextval('public.participants_cloud_id_seq');

alter table public.timing_events
  alter column id set default nextval('public.timing_events_cloud_id_seq');

alter table public.timing_events
  drop constraint timing_events_station_number_check;

alter table public.timing_events
  add constraint timing_events_station_number_check
  check (station_number is null or station_number between 1 and 20);

create or replace function public.process_timing_event(p_payload jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_race_id text := btrim(coalesce(p_payload ->> 'raceId', ''));
  v_device_id text := btrim(coalesce(p_payload ->> 'deviceId', ''));
  v_event_id text := btrim(coalesce(p_payload ->> 'eventId', ''));
  v_timing_mode text := lower(btrim(coalesce(p_payload ->> 'timingMode', 'manual')));
  v_gate_role text := upper(btrim(coalesce(p_payload ->> 'gateRole', '')));
  v_station_id text := upper(btrim(coalesce(p_payload ->> 'stationId', '')));
  v_card_code text := upper(btrim(coalesce(p_payload ->> 'cardCode', '')));
  v_serial_number text := btrim(coalesce(p_payload ->> 'serialNumber', ''));
  v_source text := btrim(coalesce(p_payload ->> 'source', 'unknown'));
  v_duplicate_window integer := 10;
  v_event_time timestamptz;
  v_received_at timestamptz := clock_timestamp();
  v_profile public.race_profiles%rowtype;
  v_participant public.participants%rowtype;
  v_existing public.timing_events%rowtype;
  v_previous public.timing_events%rowtype;
  v_event public.timing_events%rowtype;
  v_checkpoints text[];
  v_latest_checkpoint text;
  v_expected_checkpoint text;
  v_expected_role text;
  v_next_checkpoint text;
  v_next_role text;
  v_current_index integer;
  v_status text;
  v_station_label text;
  v_station_number integer;
  v_checkpoint_type text;
begin
  if v_race_id = '' then
    raise exception using errcode = '22023', message = 'raceId is required';
  end if;
  if v_device_id = '' then
    raise exception using errcode = '22023', message = 'deviceId is required';
  end if;
  if v_card_code = '' then
    raise exception using errcode = '22023', message = 'cardCode is required';
  end if;
  if v_timing_mode not in ('auto', 'manual') then
    raise exception using errcode = '22023', message = 'timingMode must be auto or manual';
  end if;

  if v_event_id = '' then
    v_event_id := extensions.gen_random_uuid()::text;
  end if;

  begin
    v_event_time := (p_payload ->> 'eventTime')::timestamptz;
  exception when others then
    raise exception using errcode = '22023', message = 'eventTime must be ISO-8601';
  end;
  if v_event_time is null then
    raise exception using errcode = '22023', message = 'eventTime is required';
  end if;

  begin
    v_duplicate_window := coalesce(
      nullif(p_payload ->> 'duplicateWindowSeconds', '')::integer,
      10
    );
  exception when others then
    raise exception using errcode = '22023', message = 'duplicateWindowSeconds must be an integer';
  end;
  if v_duplicate_window not between 3 and 60 then
    raise exception using errcode = '22023', message = 'duplicateWindowSeconds must be between 3 and 60';
  end if;

  select *
  into v_profile
  from public.race_profiles
  where race_id = v_race_id;

  if v_profile.race_id is null then
    raise exception using errcode = '22023', message = 'race profile not found';
  end if;

  select array_agg(checkpoint order by position)
  into v_checkpoints
  from jsonb_array_elements_text(v_profile.checkpoints)
    with ordinality as item(checkpoint, position);

  if coalesce(array_length(v_checkpoints, 1), 0) = 0 then
    raise exception using errcode = '22023', message = 'race profile has no checkpoints';
  end if;

  if v_profile.mode = 'station_checkpoints' and v_timing_mode = 'auto' then
    raise exception using errcode = '22023', message = 'This race uses fixed station checkpoints';
  end if;

  if v_timing_mode = 'auto' then
    if v_gate_role not in ('RUN_OUT', 'RUN_IN') then
      raise exception using errcode = '22023', message = 'gateRole must be RUN_OUT or RUN_IN in auto mode';
    end if;
    v_station_id := 'AUTO_' || v_gate_role;
    v_station_label := case v_gate_role
      when 'RUN_OUT' then 'Run Out Gate'
      else 'Run In Gate'
    end;
    v_checkpoint_type := 'auto';
  else
    if v_station_id = '' then
      raise exception using errcode = '22023', message = 'stationId is required in manual mode';
    end if;
    if not (v_station_id = any(v_checkpoints)) then
      raise exception using errcode = '22023', message = 'stationId is not part of this race profile';
    end if;
    v_station_label := coalesce(
      nullif(btrim(p_payload ->> 'stationLabel'), ''),
      v_station_id
    );
    v_checkpoint_type := nullif(btrim(p_payload ->> 'checkpointType'), '');
    begin
      v_station_number := nullif(p_payload ->> 'stationNumber', '')::integer;
    exception when others then
      raise exception using errcode = '22023', message = 'stationNumber must be an integer';
    end;
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_race_id || ':' || v_card_code, 0)
  );

  select *
  into v_existing
  from public.timing_events
  where event_id = v_event_id;

  if v_existing.id is not null then
    select *
    into v_participant
    from public.participants
    where id = v_existing.participant_id;

    return jsonb_build_object(
      'ok', true,
      'status', 'duplicate_event_id',
      'serverEventId', v_existing.id,
      'cardCode', v_existing.card_code,
      'stationId', v_existing.station_id,
      'stationLabel', v_existing.station_label,
      'timingMode', v_existing.timing_mode,
      'gateRole', v_existing.gate_role,
      'duplicateWindowSeconds', v_existing.duplicate_window_seconds,
      'athleteName', v_participant.athlete_name,
      'bibNumber', v_participant.bib_number,
      'receivedAt', v_existing.received_at,
      'event', to_jsonb(v_existing),
      'storage', jsonb_build_object(
        'localSaved', false,
        'supabaseSaved', true,
        'primary', 'supabase'
      ),
      'cloudError', null
    );
  end if;

  select *
  into v_participant
  from public.participants
  where race_id = v_race_id
    and card_code = v_card_code;

  if v_timing_mode = 'auto' then
    select *
    into v_previous
    from public.timing_events
    where race_id = v_race_id
      and card_code = v_card_code
      and timing_mode = 'auto'
      and gate_role = v_gate_role
    order by event_time desc, id desc
    limit 1;
  else
    select *
    into v_previous
    from public.timing_events
    where race_id = v_race_id
      and card_code = v_card_code
      and station_id = v_station_id
    order by event_time desc, id desc
    limit 1;
  end if;

  if v_participant.id is null then
    v_status := 'unbound_card';
  elsif v_previous.id is not null
    and v_previous.status <> 'unbound_card'
    and abs(extract(epoch from (v_event_time - v_previous.event_time))) <= v_duplicate_window
  then
    v_status := 'duplicate_tap';
    if v_previous.station_id = any(v_checkpoints) then
      v_station_id := v_previous.station_id;
    end if;
  else
    select checkpoint
    into v_latest_checkpoint
    from unnest(v_checkpoints) with ordinality as item(checkpoint, position)
    join public.timing_events event
      on event.race_id = v_race_id
      and event.participant_id = v_participant.id
      and event.status = 'accepted'
      and event.station_id = item.checkpoint
    order by item.position desc
    limit 1;

    if v_profile.mode = 'station_checkpoints' then
      if v_latest_checkpoint = 'END' then
        v_status := 'already_finished';
      else
        v_current_index := array_position(v_checkpoints, v_latest_checkpoint);
        v_expected_checkpoint := case
          when v_current_index is null then v_checkpoints[1]
          when v_current_index < array_length(v_checkpoints, 1) then v_checkpoints[v_current_index + 1]
          else null
        end;
        if v_expected_checkpoint is null then
          v_status := 'invalid_progress';
        elsif v_station_id <> v_expected_checkpoint then
          v_status := 'wrong_checkpoint';
        else
          v_status := 'accepted';
        end if;
      end if;
    elsif v_timing_mode = 'auto' then
      if v_latest_checkpoint = 'END' then
        v_status := 'already_finished';
      else
        v_current_index := array_position(v_checkpoints, v_latest_checkpoint);
        v_expected_checkpoint := case
          when v_current_index is null then v_checkpoints[1]
          when v_current_index < array_length(v_checkpoints, 1) then v_checkpoints[v_current_index + 1]
          else null
        end;
        v_expected_role := case
          when v_expected_checkpoint in ('START', 'END') then 'RUN_OUT'
          when v_expected_checkpoint like '%_ENTER' then 'RUN_IN'
          when v_expected_checkpoint like '%_EXIT' then 'RUN_OUT'
          else null
        end;
        if v_expected_checkpoint is null or v_expected_role is null then
          v_status := 'invalid_progress';
        elsif v_gate_role <> v_expected_role then
          v_status := 'wrong_gate';
        else
          v_status := 'accepted';
          v_station_id := v_expected_checkpoint;
        end if;
      end if;
    else
      v_status := 'accepted';
    end if;
  end if;

  if v_station_id = 'START' then
    v_station_label := 'Race Start';
    v_station_number := null;
    v_checkpoint_type := 'start';
  elsif v_station_id = 'END' then
    v_station_label := 'Race Finish';
    v_station_number := null;
    v_checkpoint_type := 'end';
  elsif v_station_id ~ '^STATION_[0-9]+_(ENTER|EXIT|START)$' then
    v_station_number := split_part(v_station_id, '_', 2)::integer;
    v_checkpoint_type := lower(split_part(v_station_id, '_', 3));
    v_station_label := format(
      'Station %s %s',
      v_station_number,
      initcap(v_checkpoint_type)
    );
  end if;

  insert into public.timing_events (
    event_id,
    race_id,
    device_id,
    station_id,
    station_label,
    station_number,
    checkpoint_type,
    card_code,
    serial_number,
    event_time,
    received_at,
    source,
    timing_mode,
    gate_role,
    duplicate_window_seconds,
    status,
    participant_id,
    raw_json
  )
  values (
    v_event_id,
    v_race_id,
    v_device_id,
    v_station_id,
    v_station_label,
    v_station_number,
    v_checkpoint_type,
    v_card_code,
    nullif(v_serial_number, ''),
    v_event_time,
    v_received_at,
    nullif(v_source, ''),
    v_timing_mode,
    nullif(v_gate_role, ''),
    v_duplicate_window,
    v_status,
    v_participant.id,
    p_payload
  )
  returning * into v_event;

  if v_status = 'wrong_checkpoint' then
    v_next_checkpoint := v_expected_checkpoint;
  elsif v_status = 'accepted' then
    v_current_index := array_position(v_checkpoints, v_station_id);
    if v_current_index is not null
      and v_current_index < array_length(v_checkpoints, 1)
    then
      v_next_checkpoint := v_checkpoints[v_current_index + 1];
      if v_profile.mode = 'two_reader_auto' then
        v_next_role := case
          when v_next_checkpoint in ('START', 'END') then 'RUN_OUT'
          when v_next_checkpoint like '%_ENTER' then 'RUN_IN'
          when v_next_checkpoint like '%_EXIT' then 'RUN_OUT'
          else null
        end;
      end if;
    end if;
  end if;

  return jsonb_build_object(
    'ok', true,
    'status', v_status,
    'serverEventId', v_event.id,
    'cardCode', v_card_code,
    'stationId', v_station_id,
    'stationLabel', v_station_label,
    'timingMode', v_timing_mode,
    'gateRole', nullif(v_gate_role, ''),
    'duplicateWindowSeconds', v_duplicate_window,
    'athleteName', v_participant.athlete_name,
    'bibNumber', v_participant.bib_number,
    'expectedRole', v_expected_role,
    'expectedCheckpoint', v_expected_checkpoint,
    'nextExpectedRole', v_next_role,
    'nextCheckpoint', v_next_checkpoint,
    'receivedAt', v_received_at,
    'event', to_jsonb(v_event),
    'storage', jsonb_build_object(
      'localSaved', false,
      'supabaseSaved', true,
      'primary', 'supabase'
    ),
    'cloudError', null
  );
end;
$$;

revoke all on function public.process_timing_event(jsonb) from public;
revoke all on function public.process_timing_event(jsonb) from anon, authenticated;
grant execute on function public.process_timing_event(jsonb) to service_role;
