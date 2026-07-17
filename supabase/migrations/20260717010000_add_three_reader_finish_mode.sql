alter table public.race_profiles
  drop constraint race_profiles_mode_check;

alter table public.race_profiles
  add constraint race_profiles_mode_check
  check (mode in ('two_reader_auto', 'three_reader_auto', 'station_checkpoints'));

alter table public.timing_events
  drop constraint timing_events_gate_role_check;

alter table public.timing_events
  add constraint timing_events_gate_role_check
  check (gate_role is null or gate_role in ('RUN_OUT', 'RUN_IN', 'FINISH'));

create or replace function public.process_timing_event_v2(p_payload jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_race_id text := btrim(coalesce(p_payload ->> 'raceId', ''));
  v_card_code text := upper(btrim(coalesce(p_payload ->> 'cardCode', '')));
  v_original_role text := upper(btrim(coalesce(p_payload ->> 'gateRole', '')));
  v_forward_role text;
  v_forward_payload jsonb := p_payload;
  v_profile public.race_profiles%rowtype;
  v_participant public.participants%rowtype;
  v_event public.timing_events%rowtype;
  v_checkpoints text[];
  v_latest_checkpoint text;
  v_expected_checkpoint text;
  v_expected_role text;
  v_current_index integer;
  v_result jsonb;
  v_server_event_id bigint;
  v_station_id text;
  v_station_label text;
begin
  select *
  into v_profile
  from public.race_profiles
  where race_id = v_race_id;

  if v_profile.race_id is null or v_profile.mode <> 'three_reader_auto' then
    return public.process_timing_event(p_payload);
  end if;

  if v_race_id = '' or v_card_code = '' then
    return public.process_timing_event(p_payload);
  end if;
  if v_original_role not in ('RUN_OUT', 'RUN_IN', 'FINISH') then
    raise exception using
      errcode = '22023',
      message = 'gateRole must be RUN_OUT, RUN_IN, or FINISH in auto mode';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_race_id || ':' || v_card_code, 0)
  );

  select array_agg(checkpoint order by position)
  into v_checkpoints
  from jsonb_array_elements_text(v_profile.checkpoints)
    with ordinality as item(checkpoint, position);

  select *
  into v_participant
  from public.participants
  where race_id = v_race_id
    and card_code = v_card_code;

  if v_participant.id is not null then
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
  end if;

  if v_latest_checkpoint <> 'END' or v_latest_checkpoint is null then
    v_current_index := array_position(v_checkpoints, v_latest_checkpoint);
    v_expected_checkpoint := case
      when v_current_index is null then v_checkpoints[1]
      when v_current_index < array_length(v_checkpoints, 1)
        then v_checkpoints[v_current_index + 1]
      else null
    end;
  end if;

  v_expected_role := case
    when v_expected_checkpoint = 'START' then 'RUN_OUT'
    when v_expected_checkpoint = 'END' then 'FINISH'
    when v_expected_checkpoint like '%_ENTER' then 'RUN_IN'
    when v_expected_checkpoint like '%_EXIT' then 'RUN_OUT'
    else null
  end;

  v_forward_role := v_original_role;
  if v_original_role = 'FINISH' then
    v_forward_role := case
      when v_expected_role = 'FINISH' then 'RUN_OUT'
      when v_expected_role = 'RUN_OUT' then 'RUN_IN'
      else 'RUN_OUT'
    end;
  elsif v_expected_role = 'FINISH' and v_original_role = 'RUN_OUT' then
    v_forward_role := 'RUN_IN';
  end if;

  if v_forward_role <> v_original_role then
    v_forward_payload := jsonb_set(
      v_forward_payload,
      '{gateRole}',
      to_jsonb(v_forward_role),
      true
    );
  end if;

  v_result := public.process_timing_event(v_forward_payload);

  if v_result ->> 'status' = 'duplicate_event_id' then
    return v_result;
  end if;

  v_server_event_id := (v_result ->> 'serverEventId')::bigint;
  if v_forward_role <> v_original_role then
    if v_result ->> 'status' = 'accepted'
      and v_result ->> 'stationId' = 'END'
    then
      v_station_id := 'END';
      v_station_label := 'Race Finish';
    else
      v_station_id := 'AUTO_' || v_original_role;
      v_station_label := case v_original_role
        when 'RUN_OUT' then 'Run Out Gate'
        when 'RUN_IN' then 'Run In Gate'
        else 'Finish Gate'
      end;
    end if;

    update public.timing_events
    set gate_role = v_original_role,
        station_id = v_station_id,
        station_label = v_station_label,
        station_number = null,
        checkpoint_type = case when v_station_id = 'END' then 'end' else 'auto' end,
        raw_json = p_payload
    where id = v_server_event_id
    returning * into v_event;

    v_result := v_result || jsonb_build_object(
      'gateRole', v_original_role,
      'stationId', v_event.station_id,
      'stationLabel', v_event.station_label,
      'event', to_jsonb(v_event)
    );
  end if;

  if v_expected_role is not null then
    v_result := v_result || jsonb_build_object(
      'expectedRole', v_expected_role,
      'expectedCheckpoint', v_expected_checkpoint
    );
  end if;

  if v_result ->> 'nextCheckpoint' = 'END' then
    v_result := v_result || jsonb_build_object('nextExpectedRole', 'FINISH');
  end if;

  return v_result;
end;
$$;

revoke all on function public.process_timing_event_v2(jsonb) from public;
revoke all on function public.process_timing_event_v2(jsonb) from anon, authenticated;
grant execute on function public.process_timing_event_v2(jsonb) to service_role;
