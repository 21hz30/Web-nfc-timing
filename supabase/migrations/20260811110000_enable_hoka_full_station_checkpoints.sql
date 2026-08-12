update public.race_profiles
set mode = 'station_checkpoints',
    station_count = 5,
    checkpoints = '["START", "STATION_1_START", "STATION_2_START", "STATION_3_START", "STATION_4_START", "STATION_5_START", "END"]'::jsonb,
    entry_type = 'team',
    updated_at = timezone('utc', now())
where race_id in (
  'hoka-race',
  'hoka-race-sh',
  'hoka-race-hz',
  'hoka-race-final',
  'hoka-race-demo'
)
and checkpoints is distinct from
  '["START", "STATION_1_START", "STATION_2_START", "STATION_3_START", "STATION_4_START", "STATION_5_START", "END"]'::jsonb;
