insert into public.race_profiles (
  race_id,
  name,
  mode,
  station_count,
  checkpoints,
  created_at,
  updated_at
)
values
  (
    'fitmonster-hyrox-single',
    'Fitmonster Hyrox Single Simulation Race',
    'three_reader_auto',
    8,
    '["START","STATION_1_ENTER","STATION_1_EXIT","STATION_2_ENTER","STATION_2_EXIT","STATION_3_ENTER","STATION_3_EXIT","STATION_4_ENTER","STATION_4_EXIT","STATION_5_ENTER","STATION_5_EXIT","STATION_6_ENTER","STATION_6_EXIT","STATION_7_ENTER","STATION_7_EXIT","STATION_8_ENTER","END"]'::jsonb,
    clock_timestamp(),
    clock_timestamp()
  ),
  (
    'hoka-race',
    'Hoka Race',
    'station_checkpoints',
    5,
    '["START","STATION_1_START","STATION_2_START","STATION_3_START","STATION_4_START","STATION_5_START","END"]'::jsonb,
    clock_timestamp(),
    clock_timestamp()
  )
on conflict (race_id) do update
set name = excluded.name,
    mode = excluded.mode,
    station_count = excluded.station_count,
    checkpoints = excluded.checkpoints,
    updated_at = excluded.updated_at;
