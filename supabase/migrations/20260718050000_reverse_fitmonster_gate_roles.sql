create or replace function public.process_timing_event_v3(p_payload jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_original_role text := upper(btrim(coalesce(p_payload ->> 'gateRole', '')));
  v_forward_role text;
  v_forward_payload jsonb := p_payload;
  v_result jsonb;
  v_server_event_id bigint;
  v_station_id text;
  v_station_label text;
  v_expected_role text;
  v_next_role text;
begin
  v_forward_role := case v_original_role
    when 'RUN_IN' then 'RUN_OUT'
    when 'RUN_OUT' then 'RUN_IN'
    else v_original_role
  end;

  if v_forward_role <> v_original_role then
    v_forward_payload := jsonb_set(
      v_forward_payload,
      '{gateRole}',
      to_jsonb(v_forward_role),
      true
    );
  end if;

  v_result := public.process_timing_event_v2(v_forward_payload);
  if v_result ->> 'status' = 'duplicate_event_id' then
    return v_result;
  end if;

  v_expected_role := case v_result ->> 'expectedRole'
    when 'RUN_OUT' then 'RUN_IN'
    when 'RUN_IN' then 'RUN_OUT'
    else v_result ->> 'expectedRole'
  end;
  v_next_role := case v_result ->> 'nextExpectedRole'
    when 'RUN_OUT' then 'RUN_IN'
    when 'RUN_IN' then 'RUN_OUT'
    else v_result ->> 'nextExpectedRole'
  end;
  if v_next_role is null then
    v_next_role := case
      when v_result ->> 'nextCheckpoint' = 'END' then 'FINISH'
      when v_result ->> 'nextCheckpoint' like '%_ENTER' then 'RUN_OUT'
      when v_result ->> 'nextCheckpoint' like '%_EXIT' then 'RUN_IN'
      else null
    end;
  end if;

  if v_forward_role <> v_original_role then
    v_server_event_id := (v_result ->> 'serverEventId')::bigint;
    v_station_id := case
      when v_result ->> 'stationId' like 'AUTO_%' then 'AUTO_' || v_original_role
      else v_result ->> 'stationId'
    end;
    v_station_label := case
      when v_result ->> 'stationId' not like 'AUTO_%' then v_result ->> 'stationLabel'
      when v_original_role = 'RUN_IN' then 'Run In Gate'
      when v_original_role = 'RUN_OUT' then 'Run Out Gate'
      else v_result ->> 'stationLabel'
    end;

    update public.timing_events
    set gate_role = v_original_role,
        station_id = v_station_id,
        station_label = v_station_label,
        raw_json = p_payload
    where id = v_server_event_id;

    v_result := v_result || jsonb_build_object(
      'gateRole', v_original_role,
      'stationId', v_station_id,
      'stationLabel', v_station_label,
      'event', coalesce(v_result -> 'event', '{}'::jsonb) || jsonb_build_object(
        'gate_role', v_original_role,
        'station_id', v_station_id,
        'station_label', v_station_label,
        'raw_json', p_payload
      )
    );
  end if;

  if v_expected_role is not null then
    v_result := v_result || jsonb_build_object('expectedRole', v_expected_role);
  end if;
  if v_next_role is not null then
    v_result := v_result || jsonb_build_object('nextExpectedRole', v_next_role);
  end if;
  return v_result;
end;
$$;

revoke all on function public.process_timing_event_v3(jsonb) from public;
revoke all on function public.process_timing_event_v3(jsonb) from anon, authenticated;
grant execute on function public.process_timing_event_v3(jsonb) to service_role;
