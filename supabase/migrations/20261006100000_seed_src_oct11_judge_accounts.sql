-- Preload the October 11 SRC station console accounts.
-- Passwords intentionally follow the station number: station1 ... station8.
-- The salts are fixed only so a fresh cloud project receives the same
-- credentials as the local judge service; existing custom accounts are kept.
insert into public.judge_station_accounts (
  race_id, role, username, password_hash, password_salt, display_name,
  active, created_at, updated_at
)
values
  ('src-race-20261011', 'start', 'station_0',
   '63e87cdae0ddb9f561a23daa7107e8c436dbb4fd31bc0ee53e89996b141ab211',
   'src-oct11-start', '待发区 / 发枪', true, now(), now()),
  ('src-race-20261011', 'station_1', 'station_1',
   '11d5bf3d01e3b79b3aec7c8a75675304655e82d01e63ee2dd6d6152189464dfc',
   'src-oct11-station-1', '站点 1 · 滑雪机', true, now(), now()),
  ('src-race-20261011', 'station_2', 'station_2',
   'adea761dc9def7e697819da5ea5ad430fbf1dbb333fd95c1507509b8814a8ed7',
   'src-oct11-station-2', '站点 2 · 推雪橇', true, now(), now()),
  ('src-race-20261011', 'station_3', 'station_3',
   'a4177e50bd6e37056e4815849070d4452a3eff15a637b5ddfde9dff6ab8cb996',
   'src-oct11-station-3', '站点 3 · 拉雪橇', true, now(), now()),
  ('src-race-20261011', 'station_4', 'station_4',
   '9e9a9708dc88ab324069bd9d793e4240d9ea2085c48f1c7c470d11e5d043ca96',
   'src-oct11-station-4', '站点 4 · 波比跳', true, now(), now()),
  ('src-race-20261011', 'station_5', 'station_5',
   'afaa61ecc4b4a7a2de3bd80f0efcbbd52c629f97c462fae8ba0e6ce95fb3489d',
   'src-oct11-station-5', '站点 5 · 划船机', true, now(), now()),
  ('src-race-20261011', 'station_6', 'station_6',
   '122def3ff56fda1437bd9f126589332ceb8c5f1901a8619170f97d42c8056c64',
   'src-oct11-station-6', '站点 6 · 农夫行走', true, now(), now()),
  ('src-race-20261011', 'station_7', 'station_7',
   'c4bce35d777738d2bb6449cf911805d390efe3e1505fa13462b6d90ed8114704',
   'src-oct11-station-7', '站点 7 · 弓箭步', true, now(), now()),
  ('src-race-20261011', 'station_8', 'station_8',
   '27a10ad13fde53de48e4033beba1bbe93cf182e4bb3e9aae1a2f7f694b83f48e',
   'src-oct11-station-8', '站点 8 · 墙球 / 完赛', true, now(), now())
on conflict (race_id, role) do nothing;

notify pgrst, 'reload schema';
