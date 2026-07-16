# Project Status Handoff

## Summary

This repo is a prototype timing system for a HYROX simulation race.

The current proof of concept supports:

- NFC tag scan from Android Chrome Web NFC.
- Automatic two-reader race progression using fixed `RUN_OUT` and `RUN_IN` roles.
- Timing event upload to a local Python API.
- Local SQLite timing storage with a Supabase cloud mirror.
- Participant/card binding through an admin page.
- Live leaderboard with theme toggle, Chinese/English toggle, and F1-style row update flash.
- Full-screen accepted/error feedback, sound, vibration, and screen wake lock on timing devices.
- Configurable 3-60 second duplicate protection, defaulting to 10 seconds.
- Bundled `assets/check-in-success.wav` announcement after server-confirmed accepted events,
  with system TTS and the tone retained as fallbacks.
- Supabase persistence for participants and timing events, protected by RLS and a
  server-only request token.
- Race profiles selected by race ID, supporting two-reader auto progression and
  fixed per-station checkpoints.

The current implementation is suitable for prototype testing, not production race-day deployment yet.

## Current Supabase Connection

The app is connected to the Supabase project:

```
Project: SRC-timing
Reference ID: lfzvkqwpekgtkcnpzbqj
URL: https://lfzvkqwpekgtkcnpzbqj.supabase.co
```

The tracked migrations are:

```
supabase/migrations/20260716030000_create_timing_cloud_mirror.sql
supabase/migrations/20260716040000_add_race_profiles.sql
```

It creates these RLS-protected tables:

```
public.participants
public.timing_events
public.race_profiles
```

Current verified cloud data:

```
5 race profiles
10 participants
22 timing events
0 orphaned timing events
```

The original local data was 8 participants and 14 events. One additional
`supabase-e2e-20260716` participant and `START` event were added as a live
connection test. A `Saturday Demo` participant and a complete 5-station test
sequence were also added. These development records are intentionally still
present for test verification.

### Storage Flow

```
Admin/NFC browser
  -> server.py HTTP API
  -> race_profiles selects the profile by raceId
  -> SQLite local database (race progression and immediate reads)
  -> Supabase REST API (cloud mirror on every profile/participant/event write)
```

At server startup, all local SQLite participants and timing events are upserted to
Supabase. Run the one-time/recovery sync without starting the HTTP server:

```bash
python3 server.py --sync-only
```

Each write response includes `storage.localSaved` and `storage.supabaseSaved`.
If Supabase is temporarily unavailable, the local write is retained and the next
startup sync retries the full local dataset.

### Supabase Security

- RLS is enabled on all three public tables.
- The `anon` role has no useful access without the server-only
  `X-Timing-API-Key` header.
- The private token is stored in the ignored root file `.timing-api-key`.
- The token is hashed inside the private database function; it is not stored in
  plaintext in the migration.
- Do not expose or commit `.timing-api-key`, a database password, or a service-role
  key.

### Environment Variables

No `.env` file is required for the current local setup. The checked-out project
already has the project URL and publishable key defaults in `server.py`, and the
ignored `.timing-api-key` file supplies the private server token.

For a deployment or another machine, configure these environment variables in the
process manager (the Python server does not automatically load a `.env` file):

```
SUPABASE_URL=https://lfzvkqwpekgtkcnpzbqj.supabase.co
SUPABASE_PUBLISHABLE_KEY=<Supabase publishable key>
TIMING_API_KEY=<the same private token as .timing-api-key>
```

Optional variables:

```
SUPABASE_SYNC_ENABLED=0       # disable cloud mirroring; default is enabled
TIMING_SERVER_PORT=8788       # default is 8787
```

Use the publishable/anon key only for the REST client. Never use a Supabase
service-role key in browser code or commit one to the repository.

## Current Repo

```text
/Users/peterzhang/Documents/src-counting
```

Main branch:

```text
main
```

GitHub repo:

```text
git@github.com:21hz30/Web-nfc-timing.git
https://github.com/21hz30/Web-nfc-timing.git
```

## Local Runtime

Run:

```bash
python3 server.py
```

Local entry:

```text
http://localhost:8787/
```

Main pages:

```text
http://localhost:8787/admin.html
http://localhost:8787/web-nfc-timing-test.html
http://localhost:8787/leaderboard.html
http://localhost:8787/local-dashboard.html
```

SQLite database:

```text
data/timing.sqlite3
```

`data/` is ignored by git.

## Current Features

### Admin

File:

```text
admin.html
```

Purpose:

- Register/check participant details.
- Bind NFC card code to participant.
- Store:
  - race ID
  - card code
  - bib number
  - athlete name
  - phone
  - gender
  - division
  - check-in status
- Show latest timing events.

### Station Timing

File:

```text
web-nfc-timing-test.html
```

Purpose:

- Android Chrome Web NFC timing gate.
- Select race ID, device ID, timing mode, and fixed reader role.
- Read NDEF text from tag.
- Normalize card code to uppercase.
- Upload timing event to `/api/timing-events`.
- Wait for server confirmation before showing green success feedback.
- In automatic mode, let the backend assign the athlete's next checkpoint.
- Uses generic station IDs:
  - `START`
  - `STATION_1_ENTER`
  - `STATION_1_EXIT`
  - ...
  - `STATION_8_ENTER`
  - `STATION_8_EXIT`
  - `END`

Recommended automatic setup:

```text
RUN_OUT -> START / station exit / final END
RUN_IN  -> run finish / next station enter
```

The sequence reaches `STATION_8_ENTER` and then uses the final `RUN_OUT` tap as `END`.
That `END` timestamp also closes the Station 8 split. Manual checkpoint mode remains
available for controlled fallback use.

### Leaderboard

File:

```text
leaderboard.html
```

Purpose:

- Live timing board.
- Shows:
  - rank
  - athlete
  - status
  - current checkpoint
  - elapsed time
  - station 1-8 splits
- Does not show card code.
- Does not show gap column.
- Supports:
  - dark/light theme
  - Chinese/English toggle
  - row flash when rank/status/checkpoint/split changes

### Local Debug Dashboard

File:

```text
local-dashboard.html
```

Purpose:

- Older quick debug page.
- Useful for checking raw bindings and timing events.
- Not the preferred long-term admin UI.

## API

Backend file:

```text
server.py
```

Current API endpoints:

```text
GET  /api/health
GET  /api/participants?raceId=hyrox-sim-001
POST /api/participants
GET  /api/timing-events?raceId=hyrox-sim-001&limit=100
POST /api/timing-events
GET  /api/leaderboard?raceId=hyrox-sim-001
GET  /api/race-config?raceId=...
POST /api/race-config
GET  /api/races
```

## Race Profiles

Race behavior is selected by `raceId` and persisted in `race_profiles`. The admin
page has a **比赛模式 / Race Profile** section for saving a profile.

Supported modes:

~~~text
two_reader_auto
  Two phones alternate RUN_OUT and RUN_IN.
  The server assigns START, station transitions, and END.

station_checkpoints
  Each phone is fixed to one checkpoint.
  The server accepts only START -> STATION_n_START -> ... -> END.
~~~

Profiles created for the current rehearsal:

~~~text
sunday-sim-20260719   two_reader_auto       8 stations
saturday-sim-20260725 station_checkpoints  5 stations
~~~

Use these URL parameters on scanner devices:

~~~text
?raceId=sunday-sim-20260719&deviceId=run-out-01&role=RUN_OUT
?raceId=sunday-sim-20260719&deviceId=run-in-01&role=RUN_IN
?raceId=saturday-sim-20260725&deviceId=station-1&checkpoint=STATION_1_START
?raceId=saturday-sim-20260725&deviceId=end&checkpoint=END
~~~

The scanner fetches `GET /api/race-config?raceId=...` on startup and automatically
selects auto/manual mode and the profile's checkpoint list. The Saturday setup needs
7 devices: START, five station devices, and END. The Sunday setup needs two devices:
RUN_OUT and RUN_IN.

Timing event payload example:

```json
{
  "eventId": "run-out-01-1720000000000-a8f3",
  "raceId": "hyrox-sim-001",
  "deviceId": "run-out-01",
  "timingMode": "auto",
  "gateRole": "RUN_OUT",
  "duplicateWindowSeconds": 10,
  "stationId": "AUTO",
  "cardCode": "SIM-001",
  "serialNumber": "",
  "eventTime": "2026-07-03T10:20:31.123Z",
  "source": "web-nfc-gate"
}
```

Timing event statuses:

```text
accepted
unbound_card
duplicate_tap
duplicate_event_id
wrong_gate
wrong_checkpoint
already_finished
invalid_progress
```

Only `accepted` events advance leaderboard progress. Rejected scans remain stored for review.

## Current Data Model

SQLite tables are created in `server.py`; the matching Supabase schema is tracked
in the migration listed above.

Current tables:

```text
participants
timing_events
race_profiles
```

Race profile fields include:

```text
race_id
name
mode
station_count
checkpoints
created_at
updated_at
```

Participant fields include:

```text
race_id
card_code
athlete_name
bib_number
phone
gender
division
check_in_status
created_at
updated_at
```

Timing events include:

```text
event_id
race_id
device_id
station_id
station_label
station_number
checkpoint_type
card_code
serial_number
event_time
received_at
source
timing_mode
gate_role
duplicate_window_seconds
status
participant_id
raw_json
```

## Local Phone Testing

Web NFC requires HTTPS in Android Chrome. For local phone testing:

1. Run local API:

```bash
python3 server.py
```

2. Start Cloudflare tunnel:

```bash
cloudflared tunnel --url http://localhost:8787
```

3. Open the generated `https://...trycloudflare.com/` URL on the Android phone.

Quick Tunnel URLs change whenever the tunnel process restarts and must not be
documented as permanent.

## Physical Reader Layout

- Mount one Android reader at the shared run-course exit (`RUN_OUT`).
- Mount one Android reader at the shared run-course return (`RUN_IN`).
- The course must force every athlete through these points in order.
- Do not attach the phone back flat against a wall; keep the rear upper NFC antenna reachable.
- A single generic reader cannot validate direction and is not recommended for race day.
- The current first `RUN_OUT` tap starts each athlete individually. Mass/wave starts still need a shared-start feature.

Reader URLs can be preconfigured:

```text
/web-nfc-timing-test.html?raceId=demo-001&deviceId=run-out-01&role=RUN_OUT
/web-nfc-timing-test.html?raceId=demo-001&deviceId=run-in-01&role=RUN_IN
```

## Current Deployment Status

The custom HTTPS frontend domain is:

```text
https://timing.hybridtraining.cn/
```

The root and static pages are reachable. As of 2026-07-16,
`https://timing.hybridtraining.cn/api/races` returns a Vercel `404`, so the custom
domain does not yet expose the Python timing API. Loading the page alone is not a
complete end-to-end test: NFC writes and Supabase mirroring require `server.py` to be
deployed or reverse proxied under the same origin.

The earlier Vercel deployment is still documented for historical reference:

```text
https://web-nfc-timing-fjnm.vercel.app/web-nfc-timing-test.html
```

Vercel may be unreliable from the user's phone/network in China. For China
production deployment, prefer a domestic cloud setup.

## Proposed Production Direction

The likely production stack is:

```text
Frontend static files -> 火山云 TOS or equivalent static hosting
Backend API -> 火山函数服务 / veFaaS or ECS
Database -> 火山云 managed PostgreSQL or MySQL
Custom HTTPS domain -> same origin for frontend and API if possible
```

Important production correction:

- Do not use SQLite in production.
- Do not rely on serverless local disk for timing data.
- Store timing data in managed PostgreSQL/MySQL.
- If using Function Service, refactor `server.py` because the current file starts its own HTTP server and is not function-handler shaped.

## Known Gaps

- No authentication yet.
- No participant search/edit workflow beyond save/upsert.
- No card unbind/rebind flow.
- No reset/cleanup test data action.
- No central device registry or configuration lock yet.
- No CSV import for participant list.
- No admin correction workflow for missed/wrong taps.
- No wave-start workflow for mass or grouped starts.
- No persistent device retry queue for temporary network loss.
- Supabase REST cloud mirroring is implemented, but SQLite is still the primary
  race engine; there is not yet a fully remote transactional PostgreSQL adapter.
- No official deployment config for 火山云 yet.
- Leaderboard still has a visible race ID input; public board should probably use URL parameter/default config instead.
- Local database currently contains test records from development.

## Recommended Next Steps

1. Remove or hide the race ID input from `leaderboard.html`; read `raceId` from `?raceId=` or default to `hyrox-sim-001`.
2. Add reset/delete tools for local test data.
3. Add participant search and edit in `admin.html`.
4. Add NFC card unbind/rebind.
5. Add wave-start management and race exception review for missed/wrong taps.
6. Add a persistent device retry queue for temporary network loss.
7. Add a central device registry and configuration lock.
8. Refactor backend storage behind a small repository layer so SQLite can be replaced by
   a fully remote PostgreSQL implementation.
9. Prepare deployment variant for 火山云:
   - static frontend on TOS
   - API on Function Service or ECS
   - managed DB
   - HTTPS custom domain
10. Test a full race path:
   - START
   - STATION_1_ENTER
   - STATION_1_EXIT
   - several more stations
   - END
11. Run a 3-5 participant rehearsal before adding more UI.
