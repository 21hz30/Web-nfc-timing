update public.race_profiles as race
set name = names.name,
    updated_at = timezone('utc', now())
from (
  values
    ('fitmonster-hyrox-single', 'SRC Hyrox Simulation'),
    ('hyrox-sim-001', 'SRC Hyrox Simulation · 001'),
    ('saturday-sim-20260725', 'SRC Hyrox Simulation · 2026-07-25'),
    ('nfc-test-001', 'Peoplearth Simulation · 001'),
    ('supabase-e2e-20260716', 'Peoplearth Simulation · 002'),
    ('result-adjustment-demo-20260721', 'Peoplearth Simulation · 003'),
    ('sunday-sim-20260719', 'Peoplearth Simulation · 2026-07-19'),
    ('cloud-auto-e2e-20260716', 'Peoplearth Simulation · 2026-07-16 · A'),
    ('cloud-api-e2e-20260716', 'Peoplearth Simulation · 2026-07-16 · B')
) as names(race_id, name)
where race.race_id = names.race_id
  and race.name is distinct from names.name;
