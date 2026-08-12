# HYROX Web NFC Timing Test

This repo is a minimal timing prototype for a HYROX simulation race.

The operator workflow is split into four pages:

- `admin.html`: create/configure a race, register entries, and bind NFC cards.
- `judge.html`: start any set of ready entries together, manually confirm missed station times, adjust results, enter manual times, and confirm withdrawals.
- `web-nfc-timing-test.html`: bind an Android phone to a race checkpoint and scan NFC cards.
- `leaderboard.html`: branded live results for venue screens and mobile browsers.

`server.py` provides the local Python API with SQLite storage and a Supabase cloud mirror.

## Live Frontend

The custom HTTPS domain is:

```text
https://timing.hybridtraining.cn/
```

Android Chrome can load the Web NFC page from this domain. The current deployment
serves the static frontend from Vercel and rewrites `/api/*` to the Supabase
`timing-api` Edge Function. The live API uses Supabase as its primary store and the
`process_timing_event_v3` PostgreSQL function serializes timing writes per athlete.

The timing phone page no longer exposes an editable API URL. All scanner and admin
requests use the fixed `/api/*` routes, so operators only need to select the race and
device role. A `file://` page now falls back to the hosted HTTPS API for testing, but
Web NFC itself still requires the HTTPS site on Android.

Live health check:

```text
https://timing.hybridtraining.cn/api/health
```

## Run Timing API

```bash
python3 server.py
```

Open:

```text
http://localhost:8787/
```

Useful pages:

```text
http://localhost:8787/admin.html
http://localhost:8787/judge.html
http://localhost:8787/judge.html?demo=1
http://localhost:8787/web-nfc-timing-test.html
http://localhost:8787/leaderboard.html
```

The admin page owns race setup and NFC binding. The judge page owns race starts and
audited timing decisions. The first phone checkpoint (`START`) only confirms that a
participant is ready; the judge freely selects ready entries and starts them with the
shared confirmation-click time.
The leaderboard selector is intentionally limited to the Shanghai, Hangzhou, and Final
HOKA stages plus one browser-only test dataset.

API endpoint:

```text
http://localhost:8787/api/timing-events
```

Leaderboard endpoint:

```text
http://localhost:8787/api/leaderboard?raceId=hoka-race-sh
```

SQLite database path:

```text
data/timing.sqlite3
```

## Development And Production

Localhost is the development environment. `python3 server.py` uses SQLite and defaults
to `TIMING_ENVIRONMENT=development` with `SUPABASE_SYNC_ENABLED=0`, so local writes do
not reach production. The hosted `https://timing.hybridtraining.cn` API is production
and uses the Edge API with PostgreSQL/Supabase. `GET /api/health` reports the active
environment.

Cloud mirroring from the Python server is opt-in and must name production explicitly:

```bash
TIMING_ENVIRONMENT=production SUPABASE_SYNC_ENABLED=1 python3 server.py
```

Every API write response includes storage details such as:

```json
{
  "storage": {
    "localSaved": false,
    "supabaseSaved": true
  },
  "cloudError": null
}
```

When production mirroring is explicitly enabled, the server upserts existing SQLite
records to Supabase. To run only that recovery sync:

```bash
python3 server.py --sync-only
```

Set `TIMING_SERVER_PORT` when the default port is already in use, for example
`TIMING_SERVER_PORT=8788 python3 server.py`.

Set an 8-or-more-character `LEADERBOARD_CLEAR_CODE` when the local leaderboard
needs to clear a race. The code is read by the server and must not be committed.

Local-server Supabase access is protected by RLS and a server-only token stored in
`.timing-api-key`. That file is ignored by Git and must never be sent to a browser or
committed. For a deployed server, configure `SUPABASE_URL`,
`SUPABASE_PUBLISHABLE_KEY`, and `TIMING_API_KEY` as environment variables.

The live Edge Function validates the public application key from `timing-api.js` and
uses Supabase-managed server credentials internally. No private Supabase key is
stored in the repository or configured in Vercel.

No `.env` change is needed for the hosted frontend. The Supabase project route and
public application key are already fixed in the tracked deployment configuration.
Do not add a service-role key to `.env` files used by Vercel or to browser code.

The test Edge Function currently runs without JWT verification. The leaderboard's
destructive action is protected separately by the server-only
`LEADERBOARD_CLEAR_CODE` Supabase Function Secret and a two-step confirmation.
The clear code is never stored in the frontend, Vercel, or tracked files. Clearing a
race requires two separate UI confirmations and deletes its participants and timing
events while preserving its race profile.
Rotate the hosted code with:

```bash
npx supabase secrets set LEADERBOARD_CLEAR_CODE=<new-8+-character-code>
```

## Race Profiles

Race behavior is selected by `raceId`; no code change is needed between race days.
The timing page lists the featured live races first in its Race ID dropdown and keeps
older development profiles in a separate group. The admin page can create or update
a profile through the Race Profile section.

Registration supports three entry types. One NFC card represents one timed entry:

- `individual`: one athlete name plus optional phone, gender, and division.
- `doubles`: one pair name and exactly two member names; personal detail fields are cleared.
- `team`: one team name and 2-12 member names, defaulting to four in the admin UI;
  personal detail fields are cleared.

FitMonster defaults to `individual`. Hoka defaults to `team`. The leaderboard ranks
the entry once and displays the pair/team name with its member names.

Each participant row in the admin page has `编辑` and `删除绑定` actions. Editing
loads the existing record into the registration form and allows the Card Code, entry
name, and member names to be corrected. Saving an edit requires the server-side
administrator code and updates the same participant ID, so existing timing events and
result adjustments stay attached. A Card Code already used by another entry is rejected.
Normal registration can only create a new binding and cannot bypass the protected edit
flow. Deletion requires the same administrator code and removes the selected participant's
timing events while preserving other participants and the race profile.

FitMonster's detailed leaderboard shows 16 segments in order: an initial 500m run,
each named station, and a 500m run between stations. The named stations are SkiErg,
Sled Push, Sled Pull, Burpee Broad Jump, RowErg, Farmers Carry, Lunges, and Wall
Ball. Wall Ball is the final segment; there is no run after it.

Leaderboard race choices:

```text
hoka-race-demo              browser-only 20-team HOKA test data
hoka-race-sh                HOKA Shanghai live data
hoka-race-hz                HOKA Hangzhou live data
hoka-race-final             HOKA Final live data
```

Preview the Final's 20-team card layout without writing any race data:

```text
http://localhost:8787/leaderboard.html?raceId=hoka-race-final&preview=final-20
```

Other legacy profiles may remain in the operational database for audit or migration,
but `leaderboard.html` does not add them to the public screen selector.

Mock races cannot be cleared because they never write to the database. An official
race requires the administrator clear code and two confirmation clicks before
`POST /api/reset-race` deletes its participants and timing events. The selected
Race ID is sent by the page automatically; the user does not need to type it.
`POST /api/reset-timing` uses the same two-step administrator confirmation but only
deletes timing events, result adjustments, manual results, and participant timing
controls. Participants, team details, Card Codes, device bindings, and the race profile
remain available for another test run.

For every real event, create a dated race session from the FitMonster or Hoka template
in `admin.html` before registering participants. Session IDs use the event's local
date and time, for example `hoka-race-20260725-0900`. Registration, timing devices,
and the leaderboard all use that same session ID, so previous sessions remain
available as history. The fixed IDs `fitmonster-hyrox-single` and `hoka-race` are
read-only templates: the API rejects registration, device binding, timing, result
adjustments, clearing, deletion, finalization, reopening, and profile edits against
them. Existing QA records are preserved but cannot be changed. Dated sessions are
created with `is_template = false` and remain fully operational.

Finished results can be adjusted from `judge.html`. Each
penalty or time credit requires the administrator code and a written reason. The
system keeps the raw NFC elapsed time unchanged, stores every signed adjustment as
an audit record, and ranks finished participants by the adjusted final time.

When an NFC station tap fails, `judge.html` can manually confirm only the team's next
station (including the finish) for a started participant. The selected timestamp is stored as
an accepted `timing_events` row with the judge reason and device ID, so it immediately
appears in checkpoint splits and leaderboard progress. Earlier and later checkpoints
remain locked. Administrators can configure six race-scoped judge accounts in
`admin.html`: `start`, `station_1` through `station_5`. For HOKA's full-station
layout these map to `START`, `STATION_1_START` through `STATION_5_START`, and `END`.
The station 5 account confirms both `STATION_5_START` and the following `END` checkpoint.
Station accounts receive a short-lived signed token after login and cannot call another
station's endpoint. The global account uses username `admin` with the configured
administrator password. In `judge.html`, station accounts are locked to their assigned
station, while the global administrator can switch the visible station scope, confirm any
team's next checkpoint, and roll back the latest accepted checkpoint. Rollback uses
`POST /api/rollback-checkpoint`; the original timing event remains stored with status
`reverted` and audit metadata. A paired station 5 / finish confirmation is rolled back as
one operation. The administrator code without a username remains supported for backward
compatibility.

For exceptional cases, `judge.html` can also record a complete final result using
either start and finish timestamps or an exact total elapsed time. These entries are
append-only audit records in `manual_results`; the latest record becomes the base
final time, result adjustments are then applied on top, and raw NFC events are never
rewritten.

The participant timing control action supports `pause`, `resume`, `dnf`, and
`restore`. Every action requires the administrator code and a reason and is appended
to `participant_timing_controls`. Pause/DNF intervals freeze both the total clock and
the active station clock, are excluded from elapsed time, and block NFC progression
until the participant is resumed or restored.

At the end of a real event, use **End race** on the leaderboard instead of clearing
the race. The action requires the same administrator code as race clearing, stores a
permanent `finalized_at` timestamp, freezes all running durations at that instant,
and rejects any later NFC taps. Finished entries rank by adjusted time, started but
unfinished entries become DNF and rank by progress then frozen elapsed time, and
entries without a START become DNS. The finalized leaderboard continues refreshing
every five seconds so post-race penalties and credits appear without advancing any
frozen clocks.

If a race was ended accidentally, the same leaderboard button changes to **Reopen
race**. Reopening requires the administrator code, a 2-500 character reason, and a
second confirmation. It restores registration and NFC timing, and both finalization
and reopening are appended to `race_admin_actions` for audit. Clearing remains a
destructive maintenance action.

Supported modes:

```text
two_reader_auto
  Two phones alternate RUN_IN and RUN_OUT. RUN_IN starts a run; RUN_OUT ends a run and enters the station.
  The server assigns START, station transitions, and END.

three_reader_auto
  RUN_IN and RUN_OUT advance the course; only FINISH can assign END.

station_checkpoints
  Each phone has one fixed checkpoint.
  The server accepts only START -> STATION_n_START -> ... -> END.
```

Official live profiles:

```text
fitmonster-hyrox-single three_reader_auto    individual 8 HYROX stations
hoka-race                station_checkpoints team       5 boundary-timed stations
hoka-race-sh             station_checkpoints team       5 boundary-timed stations (Shanghai)
hoka-race-hz             station_checkpoints team       5 boundary-timed stations (Hangzhou)
hoka-race-final          station_checkpoints team       5 boundary-timed stations (Final)
```

The three HOKA series profiles use the same six checkpoints and leaderboard theme.
Hangzhou and Final were created as empty profiles; no Shanghai participants, device
bindings, timing events, adjustments, or control records were copied.

On screens up to 820px wide, station-checkpoint leaderboards switch from the desktop
table to mobile cards. Each card shows team members, status, current checkpoint,
live total time, Station 1-5 completion/current states, and result/control notes
without document-level horizontal scrolling.

FitMonster phone URLs:

```text
https://timing.hybridtraining.cn/web-nfc-timing-test.html?raceId=fitmonster-hyrox-single&deviceId=fitmonster-run-out&role=RUN_OUT
https://timing.hybridtraining.cn/web-nfc-timing-test.html?raceId=fitmonster-hyrox-single&deviceId=fitmonster-run-in&role=RUN_IN
https://timing.hybridtraining.cn/web-nfc-timing-test.html?raceId=fitmonster-hyrox-single&deviceId=fitmonster-finish&role=FINISH
```

Hoka phone URLs:

```text
https://timing.hybridtraining.cn/web-nfc-timing-test.html?raceId=hoka-race&deviceId=hoka-station-1&checkpoint=START
https://timing.hybridtraining.cn/web-nfc-timing-test.html?raceId=hoka-race&deviceId=hoka-station-2&checkpoint=STATION_2_START
https://timing.hybridtraining.cn/web-nfc-timing-test.html?raceId=hoka-race&deviceId=hoka-station-3&checkpoint=STATION_3_START
https://timing.hybridtraining.cn/web-nfc-timing-test.html?raceId=hoka-race&deviceId=hoka-station-4&checkpoint=STATION_4_START
https://timing.hybridtraining.cn/web-nfc-timing-test.html?raceId=hoka-race&deviceId=hoka-station-5&checkpoint=STATION_5_START
https://timing.hybridtraining.cn/web-nfc-timing-test.html?raceId=hoka-race&deviceId=hoka-end&checkpoint=END
```

For Hoka, Station 1's phone also starts the race. Each following station tap ends
the previous station and starts the next; the END phone closes Station 5. This uses
six phones total and produces five adjacent station durations.

The scanner loads the profile from `GET /api/race-config?raceId=...` and
automatically selects auto/manual mode and the available checkpoints.

## API Payload

`POST /api/timing-events`

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

In automatic mode, the client sends its fixed physical role. The server assigns the
real checkpoint from that athlete's latest accepted event.

Judge station recovery uses `POST /api/manual-checkpoints`:

```json
{
  "raceId": "hoka-race-20260725-0900",
  "participantId": 123,
  "stationId": "STATION_2_START",
  "eventTime": "2026-07-25T08:20:30.000Z",
  "reason": "站点 NFC 打卡失败，现场人工核对",
  "deviceId": "judge-console",
  "adminCode": "..."
}
```

The endpoint rejects templates, finalized races, unstarted participants, invalid or
duplicate checkpoints, and timestamps earlier than the participant's start event.

```text
RUN OUT -> START
RUN IN  -> STATION_1_ENTER
RUN OUT -> STATION_1_EXIT
RUN IN  -> STATION_2_ENTER
...
RUN IN  -> STATION_8_ENTER
FINISH  -> END
```

In `three_reader_auto`, a RUN_OUT tap at the final checkpoint is stored as
`wrong_gate`; only the FINISH phone closes the race. Manual checkpoint mode remains
available as an operational fallback.

The API stores every raw event and returns one of:

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

Only `accepted` events advance leaderboard progress. Rejected scans are still stored
as raw timing events for later review.

## Reader Setup

- FitMonster uses `RUN_OUT`, `RUN_IN`, and a dedicated `FINISH` reader.
- Hoka uses Station 1 as START, boundary readers at Stations 2-5, and a final END reader.
- Every athlete must pass the configured readers in checkpoint order.
- A missed tap cannot be inferred safely. The next wrong-role tap is rejected for staff review.
- One generic reader cannot validate direction and is not recommended for race day.
- Individual NFC starts suit staggered starts. A mass or wave start needs a shared-start workflow.

The timing page provides full-screen success/error feedback, sound, vibration, and
screen wake lock. Green success and the bundled Chinese "打卡成功" recording happen
only after the API confirms storage. The fixed WAV asset avoids dependence on Android
or Google speech services; system TTS remains a fallback. Rejected scans and local
read/upload failures use Chinese system TTS to announce the reason and next action.
Duplicate protection defaults to 10 seconds and can be configured from 3 to 60 seconds
on each timing device.

Reader settings can be prefilled through the URL:

```text
/web-nfc-timing-test.html?raceId=fitmonster-hyrox-single&deviceId=fitmonster-run-out&role=RUN_OUT
/web-nfc-timing-test.html?raceId=fitmonster-hyrox-single&deviceId=fitmonster-run-in&role=RUN_IN
/web-nfc-timing-test.html?raceId=fitmonster-hyrox-single&deviceId=fitmonster-finish&role=FINISH
```

## Phone Testing Note

Web NFC requires HTTPS on Android Chrome. The custom domain provides HTTPS and its
same-origin `/api/*` routes write directly to Supabase through the Edge Function.
The test Edge Function has JWT verification disabled and the publishable key is
visible in browser source, so do not use real participant data until authentication
is added.

Do not mount a phone with its NFC antenna flat against a wall. Use an angled or offset
holder so the rear upper NFC area remains reachable, then mark the physical tap target.

For real phone testing, use:

```text
timing.hybridtraining.cn -> Supabase Edge Function -> PostgreSQL
```

The local fallback remains:

```text
Cloudflare Quick Tunnel -> local server.py -> SQLite -> Supabase mirror
```
