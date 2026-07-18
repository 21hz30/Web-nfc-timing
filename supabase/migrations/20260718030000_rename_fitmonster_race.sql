update public.race_profiles
set name = 'FitMonster Hyrox Single Simulation Race',
    updated_at = timezone('utc', now())
where race_id = 'fitmonster-hyrox-single';
