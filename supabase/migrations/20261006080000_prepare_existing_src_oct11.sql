-- Earlier cloud APIs created October 11 as a generic race and omitted division
-- metadata. Repair compatible registrations before the eight-station migration
-- validates them. Keep participant IDs, wristbands, names and existing results.
lock table public.race_profiles, public.participants, public.timing_events,
  public.device_bindings, public.manual_results in share row exclusive mode;

do $$
begin
  if exists (
    select 1 from public.race_profiles
    where race_id = 'src-race-20261011'
      and (mode is distinct from 'station_checkpoints'
        or checkpoints is distinct from
          '["START","STATION_2_START","STATION_3_START","STATION_4_START","STATION_5_START","STATION_6_START","STATION_7_START","STATION_8_START","END"]'::jsonb)
  ) and (
    exists (select 1 from public.timing_events
      where race_id = 'src-race-20261011' and status = 'accepted')
    or exists (select 1 from public.manual_results where race_id = 'src-race-20261011')
  ) then
    raise exception 'October 11 has results on a different course; review before changing its checkpoints';
  end if;
  if exists (
    select 1 from public.device_bindings where race_id = 'src-race-20261011'
      and assignment not in ('START','STATION_2_START','STATION_3_START',
        'STATION_4_START','STATION_5_START','STATION_6_START','STATION_7_START','STATION_8_START','END')
  ) then
    raise exception 'October 11 has obsolete device assignments; review before migrating';
  end if;
end $$;

update public.race_profiles
set name = case when name = race_id then 'SRC 10·11 八站挑战赛' else name end,
  mode = 'station_checkpoints', station_count = 8,
  checkpoints = '["START","STATION_2_START","STATION_3_START","STATION_4_START","STATION_5_START","STATION_6_START","STATION_7_START","STATION_8_START","END"]'::jsonb,
  updated_at = now()
where race_id = 'src-race-20261011';

-- Only recover the legacy fixed-prefix format when the saved roster agrees.
-- Arbitrary bib numbers require an explicit division; never infer from a name.
update public.participants
set category_code = left(bib_number, 1), updated_at = now()
where race_id = 'src-race-20261011' and category_code is null
  and bib_number ~ '^[A-EG]-[0-9]{3}$'
  and ((left(bib_number, 1) in ('A','B') and entry_type = 'individual' and jsonb_array_length(member_names) = 1)
    or (left(bib_number, 1) in ('C','D','E') and entry_type = 'doubles' and jsonb_array_length(member_names) = 2)
    or (left(bib_number, 1) = 'G' and entry_type = 'team' and jsonb_array_length(member_names) = 4));

update public.participants
set female_count = case category_code
    when 'A' then 0 when 'B' then 1 when 'C' then 0 when 'D' then 2 when 'E' then 1 end,
  updated_at = now()
where race_id = 'src-race-20261011'
  and category_code in ('A','B','C','D','E') and female_count is null;

update public.participants
set member_bib_numbers = jsonb_build_array(bib_number), updated_at = now()
where race_id = 'src-race-20261011' and entry_type = 'individual'
  and category_code in ('A','B') and jsonb_array_length(member_names) = 1
  and member_bib_numbers = '[]'::jsonb;

do $$
begin
  if exists (
    select 1 from public.participants where race_id = 'src-race-20261011'
      and (category_code is null or female_count is null)
  ) then
    raise exception 'Confirm missing October 11 divisions or relay composition before migrating';
  end if;
end $$;
