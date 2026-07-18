alter table public.participants
  add column if not exists entry_type text not null default 'individual',
  add column if not exists member_names jsonb not null default '[]'::jsonb;

update public.participants
set member_names = jsonb_build_array(athlete_name)
where member_names = '[]'::jsonb;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'participants_entry_type_check'
      and conrelid = 'public.participants'::regclass
  ) then
    alter table public.participants
      add constraint participants_entry_type_check
      check (entry_type in ('individual', 'doubles', 'team'));
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'participants_member_names_check'
      and conrelid = 'public.participants'::regclass
  ) then
    alter table public.participants
      add constraint participants_member_names_check
      check (
        jsonb_typeof(member_names) = 'array'
        and jsonb_array_length(member_names) <= 12
      );
  end if;
end $$;

alter table public.race_profiles
  add column if not exists entry_type text not null default 'individual';

update public.race_profiles
set entry_type = case
  when race_id = 'hoka-race' then 'team'
  else 'individual'
end
where race_id in ('fitmonster-hyrox-single', 'hoka-race');

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'race_profiles_entry_type_check'
      and conrelid = 'public.race_profiles'::regclass
  ) then
    alter table public.race_profiles
      add constraint race_profiles_entry_type_check
      check (entry_type in ('individual', 'doubles', 'team'));
  end if;
end $$;
