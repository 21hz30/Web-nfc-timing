# Project Status Handoff

## Summary

This repo is a prototype timing system for a HYROX simulation race.

The current proof of concept supports:

- NFC tag scan from Android Chrome Web NFC.
- Automatic two-reader progression and a three-reader mode with a dedicated
  `FINISH` phone.
- Timing event upload to either the local Python API or the deployed Supabase Edge API.
- Local SQLite timing storage with a Supabase cloud mirror.
- Live same-origin `/api/*` routing through Vercel to Supabase, with PostgreSQL as
  the authoritative online race engine.
- Individual, doubles, and team registration with one NFC card per timed entry.
- Front-desk registration intentionally omits Bib for the current rehearsal flow;
  the database field remains optional for backward compatibility.
- Live leaderboard with two mock races, two official races, explicit mock/live labels,
  protected per-race cleanup, theme/language toggles, and F1-style row update flash.
- Full-screen accepted/error feedback, sound, vibration, and screen wake lock on timing devices.
- Configurable 3-60 second duplicate protection, defaulting to 10 seconds.
- Bundled `assets/check-in-success.wav` announcement after server-confirmed accepted events,
  with system TTS and the tone retained as fallbacks.
- Chinese TTS for rejected scans and local read/upload failures, including the reason
  and the next action for the timing operator.
- Supabase persistence for participants and timing events, protected by RLS and a
  server-only request token.
- Race profiles selected by race ID, supporting two-reader/three-reader automatic
  progression and fixed per-station checkpoints.
- Fixed same-origin `/api/*` routing on the timing phone page; operators cannot edit
  or accidentally replace the Supabase upload URL.
- Timing devices require explicit operator confirmation of Device ID plus role or
  checkpoint before scanning. The selected assignment is reserved per race, so
  another device cannot confirm an occupied assignment. The UI does not infer a
  physical location from a role, allowing venues with multiple checkpoints.
- Admin race selector and data overview for participants, check-ins, finishes,
  timing events, rejected events, empty data states, and race-specific leaderboard links.

The current implementation is suitable for controlled rehearsal testing. Authentication,
offline device retry, and race-day correction tools are still required before handling
real participant data at a production race.

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
supabase/migrations/20260716060000_enable_cloud_timing_api.sql
supabase/migrations/20260717010000_add_three_reader_finish_mode.sql
supabase/migrations/20260717020000_seed_official_race_profiles.sql
supabase/migrations/20260718010000_configure_hoka_station_boundaries.sql
supabase/migrations/20260718020000_add_participant_entry_types.sql
supabase/migrations/20260721090000_add_result_adjustments.sql
supabase/migrations/20260722080000_add_race_reopen_and_templates.sql
```

It creates these RLS-protected tables:

```
public.participants
public.timing_events
public.race_profiles
public.device_bindings
public.result_adjustments
public.race_admin_actions
```

Current verified cloud data:

```
9 race profiles
15 participants
60 timing events
0 orphaned timing events
```

The original local data was 8 participants and 14 events. One additional
`supabase-e2e-20260716` participant and `START` event were added as a live
connection test. A `Saturday Demo` participant and a complete 5-station test
sequence were also added. These development records are intentionally still
present for test verification. `cloud-api-e2e-20260716` and
`cloud-auto-e2e-20260716` verify the live fixed-checkpoint and concurrent two-reader
paths respectively.

The official profiles are `fitmonster-hyrox-single` and `hoka-race`.
`CODEX-FIT-20260717-V2`, `CODEX-HOKA-20260717-V2`, and
`CODEX-HOKA-BOUNDARY-20260718` are complete live smoke-test records. The boundary
record verifies the corrected six-device Hoka sequence and 1/2/3/4/5-minute adjacent
splits. They intentionally remain in Supabase so both leaderboards can be verified
without scanning physical cards.

### Storage Flow

```
Online Admin/NFC browser
  -> timing.hybridtraining.cn/api/*
  -> Vercel external rewrite
  -> Supabase timing-api Edge Function
  -> process_timing_event_v2 PostgreSQL RPC (per-athlete transaction lock)
  -> Supabase PostgreSQL (authoritative online store)

Local Admin/NFC browser
  -> server.py HTTP API
  -> SQLite local database (authoritative local store)
  -> Supabase REST API (cloud mirror)
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

For another Python-server deployment or machine, configure these environment
variables in the process manager (the Python server does not automatically load a
`.env` file):

```
SUPABASE_URL=https://lfzvkqwpekgtkcnpzbqj.supabase.co
SUPABASE_PUBLISHABLE_KEY=<Supabase publishable key>
TIMING_API_KEY=<the same private token as .timing-api-key>
```

Optional variables:

```
SUPABASE_SYNC_ENABLED=0       # disable cloud mirroring; default is enabled
TIMING_SERVER_PORT=8788       # default is 8787
LEADERBOARD_CLEAR_CODE=...    # 8+ characters; required for local race cleanup
```

Use the publishable/anon key only for the REST client. Never use a Supabase
service-role key in browser code or commit one to the repository.

The current Vercel deployment needs no private environment variables. Static pages
send the public key from `timing-api.js`; the Supabase Edge Function validates it
against `SUPABASE_PUBLISHABLE_KEYS` and reads server credentials from Supabase-managed
function secrets.

The protected leaderboard cleanup uses the Supabase Function Secret
`LEADERBOARD_CLEAR_CODE`. It is not a Vercel variable and must never be placed in
browser code or committed. The user enters the clear code, then completes a second
explicit confirmation. The selected Race ID is sent automatically by the page. The
endpoint deletes only that race's participants and timing events and keeps the race
profile.

No `.env` change is needed for the current hosted frontend. Do not add a Supabase
service-role key to Vercel or any browser-visible environment variable.

The Edge Function is deployed with Supabase JWT verification disabled so the static
scanner can call it with the publishable key. Because that key is visible in browser
source, the current API is effectively public and must contain test data only until
admin/device authentication is added.

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
- Edit an existing participant's Card Code, entry/team name, and member names after
  administrator-code verification. The participant ID stays unchanged so timing history
  remains attached, and duplicate Card Codes are rejected.
- Delete one Card Code binding and its selected-race timing events with the administrator code.
- Load Supabase race profiles into a selector with the official races first.
- Show selected-race totals for participants, check-ins, finishes, timing events,
  and rejected/error events.
- Link directly to the selected race's live leaderboard.
- The leaderboard selector exposes two browser-only mock races plus the FitMonster
  and Hoka official Supabase races.
- Front-desk staff create a dated race session from an official template before each
  real event. The session Race ID includes local event date/time (for example,
  `hoka-race-20260725-0900`) and is shared by registration, timing phones, and the
  leaderboard. Starting a new session never clears previous participants or events.
- `fitmonster-hyrox-single` and `hoka-race` are read-only templates. All operational
  API writes are rejected for those exact IDs, while existing QA data remains intact.
  The NFC page hides templates and finalized races, and lists active dated sessions.
- Finished participants support audited result adjustments from `admin.html`. Add-time
  penalties and subtract-time credits are appended to `result_adjustments`, require
  the administrator code plus a reason, and never rewrite the raw NFC event timeline.
  The leaderboard displays the original time, each adjustment, and the adjusted final time.
- The leaderboard's `End race` action uses the same administrator code as clearing.
  It persists `race_profiles.status = finalized` plus `finalized_at`, freezes the
  scoreboard across reloads/devices, preserves all data, and blocks later timing taps.
- Finalization assigns finished, DNF (started but no END), and DNS (no START) states.
  DNF entries sort by completed progress then frozen elapsed time; DNS entries sort last.
- A finalized leaderboard still reloads API data every five seconds, allowing audited
  post-race penalties and credits to appear while all race clocks remain frozen.
- `Reopen race` requires the administrator code, a written reason, and a second
  confirmation. It returns the race to active status and re-enables registration and
  timing. Finalize/reopen actions are recorded in `race_admin_actions`.
- FitMonster rows expose alternating 500m run and named station segments; Wall Ball
  is the final segment and ends the race.
- Official race cleanup requires the administrator clear code and two confirmation clicks.
- Show explicit empty states when a race has no participants or timing events.
- Store:
  - race ID
  - card code
  - entry type (`individual`, `doubles`, or `team`)
  - athlete, pair, or team display name
  - member name list
  - phone, gender, and division for individuals only
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
- Use the fixed same-origin `/api/*` endpoint; the upload API URL is intentionally hidden.
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

FitMonster automatic setup:

```text
RUN_IN  -> START / station exit / begin the next 500m run
RUN_OUT -> finish the 500m run / station enter
FINISH  -> final END after Wall Ball
```

The first `RUN_IN` tap starts the first 500m run. Each `RUN_OUT` tap ends a run and
starts the next station; each subsequent `RUN_IN` tap ends a station and starts the
next 500m run. Wall Ball ends with the dedicated `FINISH` phone. Manual checkpoint
mode remains available for controlled fallback use.

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
POST /api/update-participant
POST /api/delete-participant
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

three_reader_auto
  RUN_OUT and RUN_IN advance the course; only FINISH can assign END.

station_checkpoints
  Each phone is fixed to one checkpoint.
  The server accepts only START -> STATION_n_START -> ... -> END.
  Hoka omits STATION_1_START because its START phone also starts Station 1.
~~~

Official live profiles:

~~~text
fitmonster-hyrox-single three_reader_auto    individual 8 HYROX stations
hoka-race                station_checkpoints team       5 boundary-timed stations
~~~

FitMonster scanner URLs:

~~~text
https://timing.hybridtraining.cn/web-nfc-timing-test.html?raceId=fitmonster-hyrox-single&deviceId=fitmonster-run-out&role=RUN_OUT
https://timing.hybridtraining.cn/web-nfc-timing-test.html?raceId=fitmonster-hyrox-single&deviceId=fitmonster-run-in&role=RUN_IN
https://timing.hybridtraining.cn/web-nfc-timing-test.html?raceId=fitmonster-hyrox-single&deviceId=fitmonster-finish&role=FINISH
~~~

Hoka scanner URLs:

~~~text
https://timing.hybridtraining.cn/web-nfc-timing-test.html?raceId=hoka-race&deviceId=hoka-station-1&checkpoint=START
https://timing.hybridtraining.cn/web-nfc-timing-test.html?raceId=hoka-race&deviceId=hoka-station-2&checkpoint=STATION_2_START
https://timing.hybridtraining.cn/web-nfc-timing-test.html?raceId=hoka-race&deviceId=hoka-station-3&checkpoint=STATION_3_START
https://timing.hybridtraining.cn/web-nfc-timing-test.html?raceId=hoka-race&deviceId=hoka-station-4&checkpoint=STATION_4_START
https://timing.hybridtraining.cn/web-nfc-timing-test.html?raceId=hoka-race&deviceId=hoka-station-5&checkpoint=STATION_5_START
https://timing.hybridtraining.cn/web-nfc-timing-test.html?raceId=hoka-race&deviceId=hoka-end&checkpoint=END
~~~

The scanner fetches `GET /api/race-config?raceId=...` on startup and automatically
selects auto/manual mode and the profile's checkpoint list. The operator must then
confirm the Device ID and selected role/checkpoint with **绑定本机角色** before
starting NFC. Hoka needs 6 devices:
Station 1 also records START, Stations 2-5 each end the previous segment and start
the next, and END closes Station 5. FitMonster needs 3 devices: RUN_OUT, RUN_IN, and
FINISH. The scanner Race ID dropdown lists these two official races first and groups
older development profiles under **其他 / 测试比赛**.

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
entry_type
created_at
updated_at
```

Participant fields include:

```text
race_id
card_code
athlete_name
bib_number
entry_type
member_names
phone
gender
division
check_in_status
created_at
updated_at
```

`athlete_name` remains the backward-compatible display-name column: it is the athlete
name for an individual and the pair/team name for grouped entries. `member_names` is
a JSON array. FitMonster defaults to `individual`; Hoka defaults to `team` with four
member inputs. Doubles require two member names, while teams allow 2-12. Phone, gender,
and division are forced to null for doubles and teams. The leaderboard ranks each NFC
entry once and renders the member list below its display name.

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

- For FitMonster, mount Android readers at the shared run-course entry (`RUN_IN`),
  shared run-course exit / station entry (`RUN_OUT`), and race finish (`FINISH`).
- For Hoka, Station 1 records START, Stations 2-5 mark adjacent boundaries, and
  the final reader records END.
- The course must force every athlete through these points in order.
- Do not attach the phone back flat against a wall; keep the rear upper NFC antenna reachable.
- A single generic reader cannot validate direction and is not recommended for race day.
- The current first `RUN_IN` tap starts each athlete individually. Mass/wave starts still need a shared-start feature.

Reader URLs can be preconfigured:

```text
/web-nfc-timing-test.html?raceId=fitmonster-hyrox-single&deviceId=fitmonster-run-out&role=RUN_OUT
/web-nfc-timing-test.html?raceId=fitmonster-hyrox-single&deviceId=fitmonster-run-in&role=RUN_IN
/web-nfc-timing-test.html?raceId=fitmonster-hyrox-single&deviceId=fitmonster-finish&role=FINISH
```

## Current Deployment Status

The custom HTTPS frontend domain is:

```text
https://timing.hybridtraining.cn/
```

The root, static pages, and same-origin cloud API are deployed. Vercel rewrites
`/api/*` to:

```text
https://lfzvkqwpekgtkcnpzbqj.supabase.co/functions/v1/timing-api/*
```

The Edge Function source is tracked in `supabase/functions/timing-api/`. Requests
must include the project's public publishable key; the browser helper
`timing-api.js` adds it automatically. Timing writes use the service-role-only
`process_timing_event_v2` RPC and a transaction-level advisory lock per race/card.

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
- The JWT-disabled Edge API is suitable only for test data until authentication is added.
- No participant search or bulk-edit workflow; individual rows can be edited.
- Password-protected participant edits preserve timing history, but there is not yet a
  per-field audit log recording the old and new Card Code, team name, or member names.
- Race cleanup has a dedicated server-side clear code and two-step UI confirmation, but full administrator
  authentication and rate limiting are still required before production use.
- No central device registry or configuration lock yet.
- No CSV import for participant list.
- No admin correction workflow for missed/wrong taps.
- No wave-start workflow for mass or grouped starts.
- No persistent device retry queue for temporary network loss.
- The local Python API still uses SQLite as its primary race engine; cloud-created
  participants are not pulled back into SQLite automatically.
- No official deployment config for 火山云 yet.
- Leaderboard selection includes SRC and Hoka browser-only demos plus the two official profiles.
- Local database currently contains test records from development.

## Recommended Next Steps

1. Add full administrator authentication and rate limiting around destructive actions.
   This remains intentionally deferred; items 2-5 from the 2026-07-22 audit are implemented.
2. Add participant search and bulk editing in `admin.html`.
3. Add a participant-edit audit log for Card Code, entry-name, and member changes.
4. Add wave-start management and race exception review for missed/wrong taps.
5. Add a persistent device retry queue for temporary network loss.
6. Add a central device registry and configuration lock.
7. Refactor backend storage behind a small repository layer so SQLite can be replaced by
   a fully remote PostgreSQL implementation.
8. Prepare deployment variant for 火山云:
   - static frontend on TOS
   - API on Function Service or ECS
   - managed DB
   - HTTPS custom domain
9. Test a full race path:
   - START
   - STATION_1_ENTER
   - STATION_1_EXIT
   - several more stations
   - END
11. Run a 3-5 participant rehearsal before adding more UI.
