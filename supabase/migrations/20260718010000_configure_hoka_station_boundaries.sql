insert into public.race_profiles (
  race_id,
  name,
  mode,
  station_count,
  checkpoints,
  created_at,
  updated_at
)
values (
  'hoka-race',
  'Hoka Race',
  'station_checkpoints',
  5,
  '["START","STATION_2_START","STATION_3_START","STATION_4_START","STATION_5_START","END"]'::jsonb,
  clock_timestamp(),
  clock_timestamp()
)
on conflict (race_id) do update
set name = excluded.name,
    mode = excluded.mode,
    station_count = excluded.station_count,
    checkpoints = excluded.checkpoints,
    updated_at = excluded.updated_at;
